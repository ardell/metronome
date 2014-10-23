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
            requestStartTime = (new Date).getTime() / 1000.0;
            connection.send(requestStartTime);
          };
          connection.onmessage = function(message) {
            data = $.parseJSON(message.data);
            var serverReportedOffset   = data.offset;
            var requestEndTime         = (new Date).getTime() / 1000.0;
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

function getServerTime(offset) {
  return (new Date).getTime() / 1000.0 + offset;
};
function getBeatsSinceStart(offset, startTime, beatsPerMinute) {
  var timeDiffInSeconds = getServerTime(offset) - startTime;
  // how many beats in timeDiffInSeconds:
  // ====================================
  // n seconds   1 minute     96 beats   m beats
  //           * --------   * -------- = 
  //             60 seconds   1 minute
  var beats = timeDiffInSeconds / 60.0 * beatsPerMinute;
  return beats;
};
function getBeat(offset, startTime, beatsPerMinute, beatsPerMeasure) {
  return Math.round(getBeatsSinceStart(offset, startTime, beatsPerMinute)) % beatsPerMeasure + 1;
};

app.controller('IndexController', function ($scope, $interval, TimeSynchronizationFactory, WebSocketFactory) {
  // Sync time via websocket service (and return a promise that will resolve to offset when time is sufficiently accurate)
  var syncResult = TimeSynchronizationFactory.getOffset();
  syncResult.then(function(val) { $scope.offset = val; });

  // Query server for tempo, time sig, and start time via websockets (and set up handlers for when new data comes through)
  $scope.beatsPerMinute  = null;
  $scope.beatsPerMeasure = null;
  $scope.startTime       = new Date().getTime() / 1000.0;
  syncResult.then(function(offset) {
    var slug = 'phoenix';
    var uri  = "ws://" + window.document.location.host + "/info";
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
  });

  // TODO: Set up a watch such that when tempo/time sig/start time change, they are sent to the server via websocket

  // Display beat to the user
  $scope.beat             = null;
  $scope.beatDisplayClass = null;
  $interval(function() {
    if (!$scope.offset || !$scope.startTime || !$scope.beatsPerMinute || !$scope.beatsPerMeasure) return;
    $scope.beat = getBeat(
      $scope.offset,
      $scope.startTime,
      $scope.beatsPerMinute,
      $scope.beatsPerMeasure
    );
    $scope.beatDisplayClass = "beat-" + $scope.beat;
  }, 30);

  // When beat changes, play a sound
  $scope.$watch('beat', function() {
    switch(beat) {
      case 1:
        $(window).trigger('tick:high');
        break;
      default:
        $(window).trigger('tick:low');
    };
  });

  function loadSounds() {
    if('webkitAudioContext' in window) {
      var context = new (window.AudioContext || window.webkitAudioContext);

      // 10 hz (mute/unmute)
      mutedTick = function() {
        var muted = context.createOscillator();
        muted.frequency.value = 10;
        muted.connect(context.destination);
        if (muted.noteOn) muted.start = muted.noteOn;
        if (muted.noteOff) muted.stop = muted.noteOff;
        muted.start(0);
        setTimeout(function() { muted.stop(0); }, 80);
      }
      $(document).on('click tap touchstart', mutedTick);

      // 440 hz
      highTick = function() {
        var high = context.createOscillator();
        high.frequency.value = 660;
        high.connect(context.destination);
        if (high.noteOn) high.start = high.noteOn;
        if (high.noteOff) high.stop = high.noteOff;
        high.start(0);
        setTimeout(function() { high.stop(0); }, 80);
      }
      $(window).on('tick:high', highTick);

      // 220 hz
      lowTick = function() {
        var low = context.createOscillator();
        low.frequency.value = 330;
        low.connect(context.destination);
        if (low.noteOn) low.start = low.noteOn;
        if (low.noteOff) low.stop = low.noteOff;
        low.start(0);
        setTimeout(function() { low.stop(0); }, 80);
      }
      $(window).on('tick:low', lowTick);
    }
  };
  loadSounds();
}, ['$interval', 'TimeSynchronizationFactory', 'WebSocketFactory']);

