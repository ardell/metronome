var app = angular.module('metronome', ['frapontillo.bootstrap-switch']);

function median(values) {
  values.sort(function(a,b) { return a - b; });
  var middle = Math.floor(values.length/2);
  if (values.length % 2) {
    return values[middle];
  } else {
    return (values[middle-1] + values[middle]) / 2.0;
  }
}

function variance(values){
  var mean = _.mean(values);
  var dev  = _.map(values, function(item){ return (item-mean)*(item-mean); });
  return dev.reduce(function(a, b){ return a+b; })/values.length;
};

app.factory('WebSocketFactory', function($q) {
  return {
    create: function(hash) {
      var uri      = hash.uri;
      var deferred = null;
      var ws       = null;

      // NOTE: We return this facade object to the user so that when we
      // reconnect they can continue using the same reference instead of having
      // to deal with refreshing their connection. Use like this...
      // WebSocketFactory
      //   .create({ uri: 'http://foo.com/bar' })
      //   .then(function(ws) { ws.connection.send('hello world'); });  // note use of "ws.connection" on this line
      var obj = { connection: null };

      var connect = function() {
        deferred   = $q.defer();
        ws         = new WebSocket(uri);
        ws.onopen  = function() {
          $(window).trigger('websocket:connected');
          deferred.resolve(obj);
        }
        ws.onerror = function() {
          $(window).trigger('websocket:error');
          deferred.reject(obj);
        }
        ws.onclose = function() {
          $(window).trigger('websocket:disconnected');
          if (!hash.autoReconnect) return;
          $(window).trigger('websocket:reconnecting');
          // TODO: Improve our method of re-connecting
          setTimeout(function() { connect(); }, 1000);
        }
        if ('onmessage' in hash) ws.onmessage = hash.onmessage;
        obj.connection = ws;
      }
      connect();

      return deferred.promise;
    }
  };
}, ['$q']);

app.factory('TimeSynchronizationFactory', function(WebSocketFactory, $q) {
  return {
    getOffset: function() {
      var uri = "ws://" + window.document.location.host + "/time";
      var ws  = WebSocketFactory.create({ uri: uri });

      var deferred = $q.defer();
      ws.then(
        function(obj) {  // success
          // Send N pings in a row and take the median offset
          var MEASUREMENTS     = 10;
          var results          = [];
          var requestStartTime = null;

          function sendPing() {
            requestStartTime = window.performance.now() / 1000.0;
            obj.connection.send(requestStartTime);
          };
          obj.connection.onmessage = function(message) {
            data = $.parseJSON(message.data);
            var serverReportedOffset   = data.offset;
            var requestEndTime         = window.performance.now() / 1000.0;
            var clientCalculatedOffset = data.time - requestEndTime;
            offset = (serverReportedOffset + clientCalculatedOffset) / 2;
            results.push(offset);

            if (results.length < MEASUREMENTS) {
              sendPing();
            } else {
              // Get the middle 4 results, make sure the variance is resonable
              var closeResults = results.slice(3, 7);
              var timeVariance = variance(closeResults);

              // Record variance in Google Analytics
              ga('send', 'timing', 'offset', 'variance', timeVariance, 'Offset Variance');

              if (timeVariance > .001) {
                // Report the retry to Google Analytics
                ga('send', 'exception', {
                  'exDescription': "Re-syncing, variance (" + timeVariance + ") was too high (> .001).",
                  'exFatal':       false
                });

                results = [];
                sendPing();
              } else {
                obj.connection.close();
                var offset = median(results);
                deferred.resolve(offset);
              }
            }
          };
          sendPing();
        },
        function() {  // error
          deferred.reject('Error: could not connect to sync service.');
          ws.close();
        }
      );
      return deferred.promise;
    }
  };
}, ['WebSocketFactory', '$q']);

app.factory('ToneFactory', function($timeout) {
  return {
    create: function() {
      if(!'webkitAudioContext' in window) {
        console.warn("Browser doesn't support the HTML5 Audio API.");
        return {
          play: function(frequencyInHz, durationInMs) {}
        };
      }

      return {
        context: new (window.AudioContext || window.webkitAudioContext),
        play:    function(frequencyInHz, durationInMs) {
          var now = this.context.currentTime;

          // Create gain node to control envelope
          var gainNode = this.context.createGain();
          gainNode.connect(this.context.destination);
          gainNode.gain.setValueAtTime(0, now);
          gainNode.gain.linearRampToValueAtTime(1.0, now + durationInMs/1000.0/100.0);
          gainNode.gain.linearRampToValueAtTime(0.0, now + durationInMs/1000.0);

          // Allow playing multiple pitches at the same time
          var frequencies = frequencyInHz;
          if (!_.isObject(frequencyInHz)) {
            frequencies = {};
            frequencies[frequencyInHz] = 1.0;
          }

          // Create oscillator to play sound
          var _context = this.context;
          _.each(frequencies, function(gain, frequency) {
            var individualGainNode = _context.createGain();
            individualGainNode.connect(gainNode);
            individualGainNode.gain.setValueAtTime(gain, now);

            var oscillator = _context.createOscillator();
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            oscillator.connect(individualGainNode);
            if (oscillator.noteOn) oscillator.start = oscillator.noteOn;
            if (oscillator.noteOff) oscillator.stop = oscillator.noteOff;
            oscillator.start(now);
            oscillator.stop(now + durationInMs/1000.0);
          });
        }
      };
    }
  };
}, ['$timeout']);

function getServerTime(offset) {
  return window.performance.now() / 1000.0 + offset;
};
function getBeatsSinceStart(offset, startTime, beatsPerMinute) {
  var currentTime       = getServerTime(offset);
  var timeDiffInSeconds = currentTime - startTime;
  // how many beats in timeDiffInSeconds:
  // ====================================
  // n seconds   1 minute     96 beats   m beats
  //           * --------   * -------- =
  //             60 seconds   1 minute
  var beats = timeDiffInSeconds / 60.0 * beatsPerMinute;
  return beats;
};
function getBeat(offset, startTime, beatsPerMinute, beatsPerMeasure) {
  if (beatsPerMeasure == 'no-emphasis') beatsPerMeasure = 2;
  return Math.floor(getBeatsSinceStart(offset, startTime, beatsPerMinute)) % beatsPerMeasure + 1;
};

app.factory('RunLoopFactory', function() {
  var runLoop = {
    MIN_RESOLUTION: 15,  // ms
    _tasks: [],
    _runs:  0,
    _skips: 0,
    _init: function() {
      var _this = this;
      setInterval(function() { _this._run(); }, this.MIN_RESOLUTION);
    },
    _run: function() {
      this._runs++;
      var _this = this;
      var currentTime = window.performance.now();
      _.each(this._tasks, function(obj, i) {
        // Skip this task if it's not time to run it yet
        if (currentTime < obj.nextRunAt) { return; }

        // Skip this run of the job if we're way behind
        var newNextRunAt = obj.nextRunAt + obj.intervalInMs;
        if (currentTime > newNextRunAt) {
          while (currentTime > newNextRunAt) {
            _this._skips++;
            newNextRunAt += obj.intervalInMs;
          }
          _this._tasks[i].nextRunAt = newNextRunAt;
          return;
        }

        // Run the task
        _this._tasks[i].nextRunAt = newNextRunAt;
        obj.fn();
      });

      // Sample every 10 seconds
      if ((this._runs * this.MIN_RESOLUTION) >= 10000) {
        // Log slow clients...
        if (1.0 * this._skips / this._runs > 0.2) {
          ga('send', 'event', 'client', 'delay', 'Client is Slow');
        }

        // Reset
        this._runs  = 0;
        this._skips = 0;
      }
    },
    add: function(fn, intervalInMs) {
      if (!fn)           throw "Please specify a function to run.";
      if (!intervalInMs) throw "Please specify an interval in milliseconds.";

      this._tasks.push({
        fn:           fn,
        nextRunAt:    (window.performance.now() + intervalInMs),
        intervalInMs: Math.max(this.MIN_RESOLUTION, intervalInMs)
      });
    },
  };
  runLoop._init();
  return runLoop;
});

app.directive('selectOnClick', function() {
  return {
    restrict: 'A',
    link: function(scope, element, attr) {
      jQuery(element).click(function() { jQuery(this).select(); });
    }
  };
});

app.directive('onSwipeLeftAddClass', function() {
  return {
    restrict: 'A',
    scope: { 'onSwipeLeftAddClass': '@' },
    link: function(scope, element, attr) {
      var $el = jQuery(element);
      $el.on('swipeleft', function() {
        $el.addClass(scope.onSwipeLeftAddClass);
        jQuery('body').one('touchstart', function() {
          setTimeout(function() {
            $el.removeClass(scope.onSwipeLeftAddClass);
          }, 500);
        });
      });
    }
  };
});

app.directive('onTapHoldAddClass', function() {
  return {
    restrict: 'A',
    scope: { 'onTapHoldAddClass': '@' },
    link: function(scope, element, attr) {
      var $el = jQuery(element);
      $el.on('taphold', function() {
        $el.addClass(scope.onTapHoldAddClass);
        jQuery('body').one('touchstart', function() {
          setTimeout(function() {
            $el.removeClass(scope.onTapHoldAddClass);
          }, 500);
        });
        return false;
      });
    }
  };
});

app.directive('muteSwitch', function() {
  return {
    restrict: 'A',
    link: function(scope, element, attr) {
      setTimeout(jQuery.proxy(function() {
        var container = this.parents('.bootstrap-switch-container');
        container
          .find('.bootstrap-switch-handle-on')
          .html("<i class='glyphicon glyphicon-volume-off'></i>");
        container
          .find('.bootstrap-switch-handle-off')
          .html("<i class='glyphicon glyphicon-volume-up'></i>");
      }, element), 0);
    }
  };
});

app.directive('replaceInput', function(){
  return {
    restrict: 'A',
    require: 'ngModel',
    link: function(scope, element, attrs, modelCtrl) {
      if (!attrs['replaceInput']) throw new Exception("Please specify a regex as the content of replace-input, e.g. <input replace-input='/[a-zA-Z0-9]/g'>");
      var regex           = new RegExp(attrs['replaceInput'], 'g');
      var replacementChar = attrs['with'] || '-';
      modelCtrl.$parsers.push(jQuery.proxy(function(regex, replacementChar, inputValue) {
        if (!inputValue) return '';
        var transformedInput = inputValue.toLowerCase().replace(regex, replacementChar);

        if (transformedInput!=inputValue) {
          modelCtrl.$setViewValue(transformedInput);
          modelCtrl.$render();
        }

        return transformedInput;
      }, this, regex, replacementChar));
    }
  };
});

app.directive('tooltip', function(){
  return {
    restrict: 'A',
    link: function(scope, element, attrs, modelCtrl) {
      jQuery(element).tooltip();
    }
  };
});

app.directive('disableTouchmove', function(){
  return {
    restrict: 'A',
    link: function(scope, element, attrs, modelCtrl) {
      // Disable scrolling on touch devices
      $(element).bind('touchmove', function(e) { e.preventDefault(); });
    }
  };
});

app.controller('IndexController', function($scope) {
  $scope.slug = "";
  $scope.url = function() {
    if (!$scope.slug) return null;
    var sanitizedSlug = $scope.slug.trim().toLowerCase().replace(/[^a-z\-]+/, '-');
    return "http://" + window.location.host + "/" + sanitizedSlug;
  };
}, []);

app.controller('NewController', function($scope) {
  $scope.metronome = window.metronome || {};

  // Update slug when title changes
  $scope.$watch('metronome.title', function() {
    var title = $scope.metronome.title || '';
    $scope.metronome.slug = title.toLowerCase().trim().replace(/[^a-z0-9\-]+/g, '-');
  });
}, []);

app.controller('PresetListController', function($scope) {
  $scope.dismissModal = function() {
    $('.preset-list-dialog').modal('hide');
  };
});

app.controller('SharingController', function($scope) {
  $scope.form       = {};
  $scope.newInvitee = { email: '', role: 'maestro' };

  $scope.addNewInvitee = function() {
    $scope.inviteesEditAfter.push($scope.newInvitee);
    $scope.newInvitee = { email: '', role: 'maestro' };

    // track in google analytics
    ga('send', 'event', 'user', 'add', 'Add a User');
  };

  $scope.deleteInvitee = function(invitee) {
    var match = _.find(
      $scope.inviteesEditAfter,
      function(obj) { return obj.email == invitee.email && obj.role == invitee.role; }
    );
    var index = _.indexOf($scope.inviteesEditAfter, match);
    $scope.inviteesEditAfter.splice(index, 1);

    // track in google analytics
    ga('send', 'event', 'user', 'delete', 'Delete a User');
  };

  $scope.handlePublicSharingChange = _.debounce(function(newValue) {
    // track in google analytics
    ga('send', 'event', 'public', newValue, 'Change Public Sharing');
  }, 250);

  $scope.save = function() {
    // Add new invitee if there's a valid email
    if ($scope.newInvitee.email && $scope.form.new.$valid) {
      $scope.addNewInvitee();
    }

    // Persist changes
    $scope.$parent.isPublic = $scope.isPublicEditAfter;
    $scope.$parent.invitees = $scope.inviteesEditAfter;
    $(window).trigger('settings:change');

    $scope.dismissModal();

    // Track in Google Analytics
    ga('send', 'event', 'sharing', 'update', 'Save Sharing Settings');
  };

  $scope.dismissModal = function() {
    $('.sharing-dialog').modal('hide');
  };
});

app.controller('PresetFormController', function($scope) {
  $scope.form       = {};
  $scope.savePreset = function() {
    if ($scope.presetFormType == 'new') {
      $scope.$parent.presets = $scope.$parent.presets || [];
      $scope.$parent.presets.push($scope.presetEditAfter);

      // Track in Google Analytics
      ga('send', 'event', 'preset', 'add', 'Add a Preset');
    } else {
      // Delete old preset
      var index = $scope.$parent.presets.indexOf($scope.presetEditBefore);
      $scope.$parent.presets.splice(index, 1, $scope.presetEditAfter);

      // Track in Google Analytics
      ga('send', 'event', 'preset', 'update', 'Update an Existing Preset');
    }
    $(window).trigger('settings:change');

    $('.preset-form-dialog').modal('hide');
  };
});

app.controller('ShowController', function($scope, $q, TimeSynchronizationFactory, WebSocketFactory, ToneFactory, RunLoopFactory) {
  // Sync time via websocket service (and return a promise that will resolve to offset when time is sufficiently accurate)
  var syncResult = TimeSynchronizationFactory.getOffset();
  syncResult.then(function(val) { $scope.offset = val; });

  // Check modernizr to see whether the browser meets our requirements
  $scope.requirementMet = function(requirement) {
    if (requirement == 'js') return true;
    return Modernizr[requirement];
  };
  $scope.allRequirementsMet = function() {
    return $scope.requirementMet('js')
      && $scope.requirementMet('websockets')
      && $scope.requirementMet('svg')
      && $scope.requirementMet('audio');
  };

  // We won't record any changes until settings are loaded from the server
  var sendChangesToServer = false;

  // Query server for tempo, time sig, and start time via websockets (and set up handlers for when new data comes through)
  $scope.beatsPerMinute         = null;
  $scope.editableBeatsPerMinute = null;
  $scope.beatsPerMeasure        = null;
  $scope.key                    = null;
  $scope.muted                  = null;
  $scope.presets                = [];
  $scope.isPublic               = null;
  $scope.role                   = null;
  $scope.connections            = null;
  $scope.invitees               = null;
  $scope.startTime              = getServerTime($scope.offset);
  $scope.isNumber               = angular.isNumber;
  var deferred                  = $q.defer();
  var infoWebSocket             = deferred.promise;
  syncResult.then(function(offset) {
    // Set up listeners for reconnecting
    var connectedListener = null;
    $(window).on('websocket:reconnecting', function() {
      // Show reconnecting alert
      $('#real-time-alert').html('Connection lost, reconnecting...');
      $('.real-time-alert').show();

      // Listen (.one) for websocket:connected
      if (!connectedListener) {
        connectedListener = $(window).one('websocket:connected', function() {
          connectedListener = null;
          $('#real-time-alert').html('Connection lost, reconnecting... Success.');
          $('.real-time-alert').delay(600).fadeOut();
        });
      }
    });

    var slug = window.location.pathname.substring(1);
    var uri  = "ws://" + window.document.location.host + "/info?slug=" + slug;
    var ws   = WebSocketFactory.create({
      uri: uri,
      autoReconnect: true,
      onmessage: function(message) {
        data = $.parseJSON(message.data);

        // Redirect user if they don't have a role and the metronome is not public
        if (!data.role && !data.isPublic) {
          window.location.reload();
        }

        $scope.$apply(function() {
          sendChangesToServer    = false;
          $scope.beatsPerMinute  = data.beatsPerMinute;
          $scope.beatsPerMeasure = data.beatsPerMeasure;
          $scope.key             = data.key;
          $scope.muted           = data.muted;
          $scope.presets         = [];
          $scope.isPublic        = data.isPublic;
          $scope.role            = data.role;
          $scope.connections     = data.connections;
          $scope.invitees        = data.invitees;
          $scope.startTime       = data.startTime;
          _.each(data.presets, function(preset) {
            $scope.presets.push({
              title:           preset.title,
              key:             preset.key,
              beatsPerMinute:  preset.beatsPerMinute,
              beatsPerMeasure: preset.beatsPerMeasure
            });
          });
          setTimeout(function() { sendChangesToServer = true; }, 0);
        });
      }
    });
    ws.then(function() { deferred.resolve(ws); });
  });

  // Handle binding between editableBeatsPerMinute
  $el = jQuery('.tempo-edit');
  var handleTempoEdit = function() {
    $scope.$apply(function() {
      $scope.beatsPerMinute = Math.round($scope.editableBeatsPerMinute * 10.0) / 10.0;
      $scope.startTime      = getServerTime($scope.offset);
      $el.val($scope.beatsPerMinute.toFixed(1));
      $(window).trigger('settings:change');

      // Track in Google Analytics
      ga('send', 'event', 'tempo', 'edit', 'Hand-edit Tempo');
    });
  }
  $el.on('blur', handleTempoEdit);
  $el.on('keydown', function(e) {
    if (e.keyCode == 13) {
      handleTempoEdit();
      $el.blur();
    }
  });
  $scope.$watch('beatsPerMinute', function() {
    $scope.editableBeatsPerMinute = (Math.round($scope.beatsPerMinute * 10.0) / 10.0).toFixed(1);
  });

  $scope.loadPreset = function(preset) {
    var serverTime = getServerTime($scope.offset);

    // Don't do anything unless something's different
    var oldHash = {
      key:             $scope.key,
      beatsPerMinute:  $scope.beatsPerMinute,
      beatsPerMeasure: $scope.beatsPerMeasure,
      startTime:       $scope.startTime
    }
    var newHash = {
      key:             preset.key,
      beatsPerMinute:  preset.beatsPerMinute,
      beatsPerMeasure: preset.beatsPerMeasure,
      startTime:       preset.startTime
    }
    if (angular.equals(oldHash, newHash)) return;

    // Otherwise, make the changes
    $scope.key             = preset.key;
    $scope.beatsPerMinute  = preset.beatsPerMinute;
    $scope.beatsPerMeasure = preset.beatsPerMeasure;
    $scope.startTime       = serverTime;
    $(window).trigger('settings:change');

    // Track in Google Analytics
    ga('send', 'event', 'preset', 'load', 'Load a Preset');
  }

  $scope.deletePreset = function(preset) {
    var index = $scope.presets.indexOf(preset);
    if (index < 0) return;
    $scope.presets.splice(index, 1);
    $(window).trigger('settings:change');

    // Track in Google Analytics
    ga('send', 'event', 'preset', 'delete', 'Delete a Preset');
  }

  $scope.presetEditBefore = {};
  $scope.presetEditAfter  = {};
  $scope.editPreset       = function(preset) {
    if (preset) {
      $scope.presetFormType   = 'edit';
      $scope.presetEditBefore = preset;
      $scope.presetEditAfter  = angular.copy(preset);
    } else {
      $scope.presetFormType  = 'new';
      $scope.presetEditAfter = {
        title:           $scope.title,
        key:             $scope.key,
        beatsPerMinute:  $scope.beatsPerMinute,
        beatsPerMeasure: $scope.beatsPerMeasure
      };
    }

    // Open dialog
    $('.preset-form-dialog').modal('show');

    // Focus on the new title input field
    setTimeout(function() { $('#newTitle').focus().select(); }, 500);
  }

  $scope.inviteesEditAfter = [];
  $scope.editSharing       = function() {
    $scope.isPublicEditAfter = angular.copy($scope.isPublic);
    $scope.inviteesEditAfter = angular.copy($scope.invitees);

    // Open dialog
    $('.sharing-dialog').modal('show');

    // Dismiss tooltip
    $scope.showConnectedUserList = false;
  }

  $scope.frequencies = [ 880.000, 440.000 ];  // hz
  $scope.$watch('key', function(newValue, oldValue) {
    if (angular.equals(newValue, oldValue)) return;
    if (angular.isUndefined(newValue)) return;
    switch($scope.key) {
      case 'c':    $scope.frequencies = [ 523.251, 261.626 ]; break;
      case 'c#':   $scope.frequencies = [ 554.365, 277.183 ]; break;
      case 'd':    $scope.frequencies = [ 587.33,  293.665 ]; break;
      case 'eb':   $scope.frequencies = [ 622.254, 311.127 ]; break;
      case 'e':    $scope.frequencies = [ 659.255, 329.628 ]; break;
      case 'f':    $scope.frequencies = [ 698.456, 349.228 ]; break;
      case 'f#':   $scope.frequencies = [ 739.989, 369.994 ]; break;
      case 'g':    $scope.frequencies = [ 783.991, 391.995 ]; break;
      case 'ab':   $scope.frequencies = [ 830.61,  415.305 ]; break;
      case 'a':    $scope.frequencies = [ 880.000, 440.000 ]; break;
      case 'bb':   $scope.frequencies = [ 932.328, 466.164 ]; break;
      case 'b':    $scope.frequencies = [ 987.767, 493.883 ]; break;
      // case 'tock': $scope.frequencies = [
      //     { 261:  0.25, 580:  0.25, 822:  0.5, 1080: 1.0, 1266: 0.75, 1360: 0.5, 1545: 0.25, 1658: 0.25, },
      //     { 261:  0.25, 580:  0.25, 822:  0.5, 1080: 1.0, 1266: 0.75, 1360: 0.5, 1545: 0.25, 1658: 0.25, }
      //   ];
      //   break;
      default:     $scope.frequencies = [ 880.000, 440.000 ]; break;
    };

    if (!sendChangesToServer) return;
    if (oldValue == null) return;
    $(window).trigger('settings:change');

    // Track in Google Analytics
    ga('send', 'event', 'key', 'change', 'Change Key');
  });

  $scope.$watch('beatsPerMeasure', function(newValue, oldValue) {
    if (!sendChangesToServer) return;
    if (angular.equals(newValue, oldValue)) return;
    if (angular.isUndefined(newValue)) return;
    if (oldValue == null) return;
    $(window).trigger('settings:change');

    // Track in Google Analytics
    ga('send', 'event', 'beatsPerMeasure', 'change', 'Change Time Signature');
  });

  $scope.$watch('muted', function(newValue, oldValue) {
    if (!sendChangesToServer) return;
    if (angular.equals(newValue, oldValue)) return;
    if (angular.isUndefined(newValue)) return;
    if (oldValue == null) return;
    $(window).trigger('settings:change');

    // Track in Google Analytics
    ga('send', 'event', 'mute', newValue, 'Change Mute');
  });

  $scope.$watch('presets', function(newValue, oldValue) {
    if (!sendChangesToServer) return;
    if (angular.equals(newValue, oldValue)) return;
    if (angular.isUndefined(newValue)) return;
    if (oldValue == null) return;
    $(window).trigger('settings:change');
  });

  $scope.sync = function() {
    $scope.offset = null;  // Shows loading screen
    var syncResult = TimeSynchronizationFactory.getOffset();
    syncResult.then(function(val) { $scope.offset = val; });
  };

  var recentTaps = [];
  var setTempo = function() {
    $scope.$apply(function() {
      if (recentTaps.length < 2) return;

      // Set tempo
      var calculateDiff = function(arr) {
        // If there's <= 1 element in the array, throw
        if (arr.length <= 1) throw new Exception("Can't compute differences.");

        // If there are only 2 elements left, return array with diff
        if (arr.length == 2) return [ arr[1]-arr[0] ];

        // Otherwise return first result concatted with recursion
        return [ arr[1]-arr[0] ].concat(calculateDiff(arr.slice(1, arr.length)));
      };
      var differences          = calculateDiff(recentTaps);
      var medianSecondsPerBeat = median(differences);
      var beatsPerMinute       = Math.round(60.0 / medianSecondsPerBeat * 10.0) / 10.0;

      // Return unless something is different
      if ($scope.beatsPerMinute == beatsPerMinute) return;

      // Make the change and save to server
      $scope.beatsPerMinute = beatsPerMinute;
      $(window).trigger('settings:change');

      // Track in Google Analytics
      ga('send', 'event', 'tempo', 'tap', 'Tap Tempo');
    });
  };
  var clearTaps = _.debounce(function() {
    recentTaps.splice(0, recentTaps.length);
  }, 3000);
  var queueUnMute = _.debounce(function() {
    window.MUTED = false;
  }, 1000);
  var eventType = 'click';
  if (Modernizr.touch) eventType = 'touchstart';
  var button = $('#tap-button');
  button.on(eventType, function() {
    var serverTime = getServerTime($scope.offset);
    recentTaps.push(serverTime);

    // If this is the first tap of the measure, recent start time
    if (recentTaps.length % $scope.beatsPerMeasure == 1) {
      $scope.$apply(function() { $scope.startTime = serverTime; });
    }

    setTempo();
    clearTaps();
    queueUnMute();

    // Manage active class (using only :active makes the button flicker on mobile)
    button.addClass('active');
    setTimeout(function() { button.removeClass('active'); }, 100);

    // Mute while we're tapping
    window.MUTED = true;
  });

  // Set up a watch such that when tempo/time sig/start time change, they are
  // sent to the server via websocket
  infoWebSocket.then(function(ws) {
    $(window).on('settings:change', function() {
      ws.connection.send(JSON.stringify({
        beatsPerMinute:  $scope.beatsPerMinute,
        beatsPerMeasure: $scope.beatsPerMeasure,
        key:             $scope.key,
        muted:           $scope.muted,
        presets:         $scope.presets,
        isPublic:        $scope.isPublic,
        invitees:        $scope.invitees,
        startTime:       $scope.startTime
      }));
    });
  });

  // Display beat to the user
  $scope.beat             = null;
  $scope.beatDisplayClass = null;
  RunLoopFactory.add(function() {
    if (!$scope.offset || !$scope.startTime || !$scope.beatsPerMinute || !$scope.beatsPerMeasure) return;
    var newBeat = getBeat(
      $scope.offset,
      $scope.startTime,
      $scope.beatsPerMinute,
      $scope.beatsPerMeasure
    );

    // When beat changes, play a sound
    if (newBeat != $scope.beat) {
      if (newBeat == 1 && $scope.beatsPerMeasure != 'no-emphasis') {
        $(window).trigger('tick:high');
      } else {
        $(window).trigger('tick:low');
      }
    }

    // Update visual interface
    var newBeatDisplayClass = "beat-" + $scope.beat;
    $scope.beat             = newBeat;
    $scope.beatDisplayClass = newBeatDisplayClass;
  }, 10);

  // Only re-render every 50 ms (visuals are less important than sounds
  RunLoopFactory.add(function() {
    $scope.$digest();
  }, 50);

  $scope.beatsPerMeasureDisplayClass = null;
  $scope.$watch('beatsPerMeasure', function() {
    $scope.beatsPerMeasureDisplayClass =  'beats-per-measure-' + $scope.beatsPerMeasure;
  });

  function loadSounds($scope) {
    var toneFactory = ToneFactory.create();

    // Dummy sound: 10hz for 1ms (basically imperceptible)
    mutedTick = function() {
      if (window.MUTED) return;
      if (!document.hasFocus()) return;
      if (document.hidden) return;
      toneFactory.play(10, 1);
    }
    $(document).on('click tap touchstart', mutedTick);

    // High tick
    highTick = function() {
      if (!$scope.beatsPerMeasure) return;  // a proxy for whether we've received any info from the server yet
      if (window.MUTED) return;
      if ($scope.muted) return;
      if (!document.hasFocus()) return;
      if (document.hidden) return;
      toneFactory.play(_.first($scope.frequencies), 80);
    }
    $(window).on('tick:high', highTick);

    // Low tick
    lowTick = function() {
      if (!$scope.beatsPerMeasure) return;  // a proxy for whether we've received any info from the server yet
      if (window.MUTED) return;
      if ($scope.muted) return;
      if (!document.hasFocus()) return;
      if (document.hidden) return;
      toneFactory.play(_.last($scope.frequencies), 80);
    }
    $(window).on('tick:low', lowTick);
  };
  loadSounds($scope);
}, ['$q', 'TimeSynchronizationFactory', 'WebSocketFactory', 'ToneFactory']);

