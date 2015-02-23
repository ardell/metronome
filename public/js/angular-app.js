var app = angular.module('metronome', []);

function median(values) {
  values.sort(function(a,b) { return a - b; });
  var middle = Math.floor(values.length/2);
  if (values.length % 2) {
    return values[middle];
  } else {
    return (values[middle-1] + values[middle]) / 2.0;
  }
}

app.factory('WebSocketFactory', function($q) {
  return {
    create: function(hash) {
      var uri      = hash.uri;
      var deferred = $q.defer();
      var ws       = null;

      ws         = new WebSocket(uri);
      ws.onopen  = function() { deferred.resolve(ws); }
      ws.onerror = function() { deferred.reject(ws);  }
      if ('onmessage' in hash) ws.onmessage = hash.onmessage;

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
        function(connection) {  // success
          // Send N pings in a row and take the median offset
          var MEASUREMENTS     = 10;
          var results          = [];
          var requestStartTime = null;

          function sendPing() {
            requestStartTime = window.performance.now() / 1000.0;
            connection.send(requestStartTime);
          };
          connection.onmessage = function(message) {
            data = $.parseJSON(message.data);
            var serverReportedOffset   = data.offset;
            var requestEndTime         = window.performance.now() / 1000.0;
            var clientCalculatedOffset = data.time - requestEndTime;
            offset = (serverReportedOffset + clientCalculatedOffset) / 2;
            results.push(offset);

            if (results.length < MEASUREMENTS) {
              sendPing();
            } else {
              connection.close();
              var offset = median(results);
              deferred.resolve(offset);
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
          var oscillator = this.context.createOscillator();
          oscillator.frequency.value = frequencyInHz;
          oscillator.connect(this.context.destination);
          if (oscillator.noteOn) oscillator.start = oscillator.noteOn;
          if (oscillator.noteOff) oscillator.stop = oscillator.noteOff;
          oscillator.start(this.context.currentTime);
          oscillator.stop(this.context.currentTime + durationInMs/1000.0);
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
  return Math.floor(getBeatsSinceStart(offset, startTime, beatsPerMinute)) % beatsPerMeasure + 1;
};

app.factory('RunLoopFactory', function() {
  var runLoop = {
    MIN_RESOLUTION: 10,  // ms
    _tasks: [],
    _init: function() {
      var _this = this;
      setInterval(function() { _this._run(); }, this.MIN_RESOLUTION);
    },
    _run: function() {
      var _this = this;
      var currentTime = window.performance.now();
      _.each(this._tasks, function(obj, i) {
        // Skip this task if it's not time to run it yet
        if (currentTime < obj.nextRunAt) { return; }

        // Run the task
        var newNextRunAt         = obj.nextRunAt + obj.intervalInMs;
        _this._tasks[i].nextRunAt = newNextRunAt;
        obj.fn();
      });
    },
    add: function(fn, intervalInMs) {
      if (!fn)           throw "Please specify a function to run.";
      if (!intervalInMs) throw "Please specify an interval in milliseconds.";

      this._tasks.push({
        fn:           fn,
        nextRunAt:    (window.performance.now() + intervalInMs),
        intervalInMs: intervalInMs
      });
    },
  };
  runLoop._init();
  return runLoop;
});

app.controller('IndexController', function($scope) {
  $scope.slug = "";
  $scope.url = function() {
    if (!$scope.slug) return null;
    var sanitizedSlug = $scope.slug.trim().toLowerCase().replace(/[^a-z\-]+/, '-');
    return "http://" + window.location.host + "/" + sanitizedSlug;
  };
}, []);

app.controller('ShowController', function($scope, $q, TimeSynchronizationFactory, WebSocketFactory, ToneFactory, RunLoopFactory) {
  // Sync time via websocket service (and return a promise that will resolve to offset when time is sufficiently accurate)
  var syncResult = TimeSynchronizationFactory.getOffset();
  syncResult.then(function(val) { $scope.offset = val; });

  // Query server for tempo, time sig, and start time via websockets (and set up handlers for when new data comes through)
  $scope.beatsPerMinute  = null;
  $scope.beatsPerMeasure = null;
  $scope.startTime       = getServerTime($scope.offset);
  var deferred           = $q.defer();
  var infoWebSocket      = deferred.promise;
  syncResult.then(function(offset) {
    var slug = window.location.pathname.substring(1);
    var uri  = "ws://" + window.document.location.host + "/info?slug=" + slug;
    var ws   = WebSocketFactory.create({
      uri:       uri,
      onmessage: function(message) {
        data = $.parseJSON(message.data);
        $scope.$apply(function() {
          $scope.beatsPerMinute  = data.beatsPerMinute;
          $scope.beatsPerMeasure = data.beatsPerMeasure;
          $scope.startTime       = data.startTime;
        });
      }
    });
    ws.then(function() { deferred.resolve(ws); });
  });

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
      $scope.beatsPerMinute    = beatsPerMinute;
      $(window).trigger('tempo:change');
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

  // Set up a watch such that when tempo/time sig/start time change, they are sent to the server via websocket
  infoWebSocket.then(function(ws) {
    $(window).on('tempo:change', function() {
      ws.send(JSON.stringify({
        beatsPerMinute:  $scope.beatsPerMinute,
        beatsPerMeasure: 4,
        startTime:       $scope.startTime
      }));
    });
  });

  // Display beat to the user
  $scope.beat             = null;
  $scope.beatDisplayClass = null;
  RunLoopFactory.add(function() {
    $scope.$apply(function() {
      if (!$scope.offset || !$scope.startTime || !$scope.beatsPerMinute || !$scope.beatsPerMeasure) return;
      $scope.beat = getBeat(
        $scope.offset,
        $scope.startTime,
        $scope.beatsPerMinute,
        $scope.beatsPerMeasure
      );
      $scope.beatDisplayClass = "beat-" + $scope.beat;
    });
  }, 10);

  // When beat changes, play a sound
  $scope.$watch('beat', function() {
    switch($scope.beat) {
      case 1:
        $(window).trigger('tick:high');
        break;
      default:
        $(window).trigger('tick:low');
    };
  });

  function loadSounds() {
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
      if (window.MUTED) return;
      if (!document.hasFocus()) return;
      if (document.hidden) return;
      toneFactory.play(660, 80);
    }
    $(window).on('tick:high', highTick);

    // Low tick
    lowTick = function() {
      if (window.MUTED) return;
      if (!document.hasFocus()) return;
      if (document.hidden) return;
      toneFactory.play(330, 80);
    }
    $(window).on('tick:low', lowTick);
  };
  loadSounds();
}, ['$q', 'TimeSynchronizationFactory', 'WebSocketFactory', 'ToneFactory']);

