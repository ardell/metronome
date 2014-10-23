require 'faye/websocket'
require 'json'
require 'observer'

class MetronomeConfig
  include Observable

  attr_accessor :beatsPerMinute
  attr_accessor :beatsPerMeasure
  attr_accessor :startTime
  attr_accessor :clients

  def initialize
    @beatsPerMinute  = 100
    @beatsPerMeasure = 4
    @startTime       = Time.now.to_f
    @clients         = []
  end

  def to_json
    {
      beatsPerMinute:  @beatsPerMinute,
      beatsPerMeasure: @beatsPerMeasure,
      startTime:       @startTime,
    }.to_json
  end
end

module Metronome
  class InfoService
    KEEPALIVE_TIME = 15 # in seconds
    # CHANNEL        = "metronome"

    def initialize(app)
      @app        = app
      @metronomes = {}  # Indexed by slug
    end

    def call(env)
      if !Faye::WebSocket.websocket?(env) or !env['PATH_INFO'].start_with?('/info')
        return @app.call(env) 
      end

      _info(env)
    end

    private

    def _info(env)
      ws = Faye::WebSocket.new(env, nil, { ping: KEEPALIVE_TIME })

      ws.on :open do |event|
        querystring = env['QUERY_STRING']
        hash = Rack::Utils.parse_nested_query(querystring)

        # Make sure the client passed us a slug
        unless hash.has_key?('slug')
          return puts "Please specify the slug you wish to connect to."
        end
        slug = hash['slug']

        # Set up the MetronomeConfig if it doesn't already exist
        unless @metronomes.has_key?(slug)
          @metronomes[slug] = MetronomeConfig.new
          puts "Created new metronome with slug: '#{slug}'."
        end
        metronome = @metronomes[slug]

        # Add the client to the list of clients for this slug
        puts "Connecting new client ##{ws.object_id} to metronome: '#{slug}'."
        metronome.clients << ws

        # Send the current info to the client
        ws.send @metronomes[slug].to_json
      end

      ws.on :message do |event|
        querystring = env['QUERY_STRING']
        hash = Rack::Utils.parse_nested_query(querystring)

        unless hash.has_key?('slug')
          return puts "No slug specified for message."
        end
        slug = hash['slug']

        unless @metronomes.has_key?(slug)
          return puts "Metronome not found for slug: #{slug}."
        end
        metronome = @metronomes[slug]

        # Make the change
        hash = JSON.parse(event.data)
        metronome.beatsPerMinute  = hash['beatsPerMinute']
        metronome.beatsPerMeasure = hash['beatsPerMeasure']
        metronome.startTime       = hash['startTime']

        # Notify clients
        metronome.clients.each do |ws|
          ws.send metronome.to_json
        end
        puts "Updated metronome '#{slug}' to: #{metronome.to_json}"
      end

      ws.on :close do |event|
        @metronomes.each do |metronome|
          metronome.clients.delete(ws) if metronome.clients.include?(ws)
        end
      end

      # Return async Rack response
      ws.rack_response
    end
  end
end


