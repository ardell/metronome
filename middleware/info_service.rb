require 'faye/websocket'
# require 'redis'
require 'json'

module Metronome
  class InfoService
    KEEPALIVE_TIME = 15 # in seconds

    def initialize(app)
      @app     = app
      @clients = []

      Thread.new do
        # Whenever the info changes in the db, update all clients
        while true do
          obj = {
            beatsPerMinute:  Random.rand(50..200),
            beatsPerMeasure: 4,
            startTime:       Time.now.to_f,
          }
          @clients.each {|ws| ws.send obj.to_json }

          sleep 5
        end
      end
    end

    def call(env)
      if !Faye::WebSocket.websocket?(env) or env['PATH_INFO'] != '/info'
        return @app.call(env) 
      end

      _info(env)
    end

    private

    def _info(env)
      ws = Faye::WebSocket.new(env, nil, {ping: KEEPALIVE_TIME })

      ws.on :open do |event|
        # Add the client to the list of clients
        @clients << ws

        # Send the current info to the client
        obj = {
          beatsPerMinute:  Random.rand(50..200),
          beatsPerMeasure: 4,
          startTime:       Time.now.to_f,
        }
        ws.send obj.to_json
      end

      ws.on :message do |event|
      end

      ws.on :close do |event|
      end

      # Return async Rack response
      ws.rack_response
    end
  end
end


