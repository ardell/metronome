 // Retrieve these from the server
 var tempo           = 66.0; // beats per minute
 var beatsPerMeasure = 4;
 var startTime       = <%= Time.parse('2014-01-01 12:00:00 UTC').to_f.to_s %> // in UTC with milliseconds

 // Orchestrate all this stuff on page load
 var offset = null;
 function setUp() {
   // Set up the offset
   var requestStartTime = (new Date).getTime() / 1000.0;
   var uri = "ws://" + window.document.location.host + "/time";
   window.ws = new WebSocket(uri);
   window.ws.onopen = function() {
     var requestStartTime = (new Date).getTime() / 1000.0;
     ws.send(requestStartTime);
   };
   window.ws.onmessage = function(message) {
     data = $.parseJSON(message.data);
     var serverReportedOffset   = data.offset;
     var requestEndTime         = (new Date).getTime() / 1000.0;
     var clientCalculatedOffset = data.time - requestEndTime;
     offset = (serverReportedOffset + clientCalculatedOffset) / 2;
     $('#server-reported-offset').text(serverReportedOffset);
     $('#client-calculated-offset').text(clientCalculatedOffset);
     $('#offset').text(offset);
   };
 }

 // Display changing serverTime to the user
 function getServerTime() {
   return (new Date).getTime() / 1000.0 + offset;
 };
 setInterval(function() {
   if (!offset) return;
   $('#client-time').text((new Date).getTime() / 1000.0);
   $('#server-time').text(getServerTime(offset));
 }, 30);

 // Display beat to the user
 function getBeatsSinceStart() {
   var timeDiffInSeconds = getServerTime() - startTime;
   // how many beats in timeDiffInSeconds:
   // ====================================
   // n seconds   1 minute     96 beats   m beats
   //           * --------   * -------- = 
   //             60 seconds   1 minute
   var beats = timeDiffInSeconds / 60.0 * tempo;
   return beats;
 };
 function getBeat() {
   return Math.round(getBeatsSinceStart()) % beatsPerMeasure + 1;
 };
 var lastBeat = 0;
 setInterval(function() {
   if (!offset) return;

   var beat = getBeat();

   // Make appropriate tick sound
   if (beat != lastBeat) {
     switch(beat) {
       case 1:
         $(window).trigger('tick:high');
         break;
       default:
         $(window).trigger('tick:low');
     };
     lastBeat = beat;
   }

   // Show beat indicator
   $('#beat').text(beat);

   // Change background
   switch(beat) {
     case 1:
       $('body').css({ backgroundColor: 'red' });
       break;
     case 2:
       $('body').css({ backgroundColor: 'orange' });
       break;
     case 3:
       $('body').css({ backgroundColor: 'yellow' });
       break;
     case 4:
       $('body').css({ backgroundColor: 'white' });
       break;
   }
 }, 30);

 $(document).ready(setUp);
 $(document).ready(function() {
   // Set up sync button
   $('#sync').on('click tap', setUp);
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
 $(document).ready(loadSounds);
  
