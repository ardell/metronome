require 'faye/websocket'
# require 'redis'
require 'json'

module Metronome
  class TimeService
    KEEPALIVE_TIME = 15 # in seconds

    def initialize(app)
      @app = app
    end

    def call(env)
      if !Faye::WebSocket.websocket?(env) or env['PATH_INFO'] != '/time'
        return @app.call(env) 
      end

      _time(env)
    end

    private

    def _time(env)
      ws = Faye::WebSocket.new(env, nil, {ping: KEEPALIVE_TIME })

      ws.on :open do |event|
      end

      ws.on :message do |event|
        client = event.data.to_f
        server = Time.now.to_f
        offset = server - client

        obj = {
          offset: offset,
          time:   server,
        }
        ws.send obj.to_json
      end

      ws.on :close do |event|
      end

      # Return async Rack response
      ws.rack_response
    end
  end
end


