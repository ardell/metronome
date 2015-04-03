require 'rollbar/middleware/sinatra'
require './metronome'
require './middleware/time_service'
require './middleware/info_service'

use Rollbar::Middleware::Sinatra
use Metronome::TimeService
use Metronome::InfoService
run Metronome::App

