require './metronome'
require './middleware/time_service'
require './middleware/info_service'

use Metronome::TimeService
use Metronome::InfoService
run Metronome::App

