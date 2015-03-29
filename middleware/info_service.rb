require 'redis'
require 'faye/websocket'
require 'json'
require 'observer'

class MetronomeConfig
  include Observable

  attr_accessor :slug
  attr_accessor :beatsPerMinute
  attr_accessor :beatsPerMeasure
  attr_accessor :key
  attr_accessor :muted
  attr_accessor :presets
  attr_accessor :startTime

  def initialize(slug)
    @slug            = slug
    @beatsPerMinute  = 100
    @beatsPerMeasure = 4
    @key             = 'a'
    @muted           = false
    @presets         = []
    @startTime       = Time.now.to_f
  end

  def to_h
    {
      slug:            @slug,
      beatsPerMinute:  @beatsPerMinute,
      beatsPerMeasure: @beatsPerMeasure,
      key:             @key,
      muted:           @muted,
      presets:         @presets,
      startTime:       @startTime,
    }
  end

  def to_json
    to_h.to_json
  end

  def self.from_json(json)
    hash                      = JSON.parse(json)
    metronome                 = self.new(hash['slug'])
    metronome.beatsPerMinute  = hash['beatsPerMinute']
    metronome.beatsPerMeasure = hash['beatsPerMeasure']
    metronome.key             = hash['key']
    metronome.muted           = hash['muted']
    metronome.presets         = hash['presets'] || []
    metronome.startTime       = hash['startTime']
    metronome
  end
end

module Metronome
  class InfoService
    KEEPALIVE_TIME = 15 # in seconds
    CHANNEL        = 'metronome-updates'

    def initialize(app)
      @app     = app
      @clients = {}  # Indexed by slug
      @redis   = Redis.new(url: ENV['REDISTOGO_URL'])

      # When there's a new message in redis, publish to any clients that are
      # listening to that metronome
      Thread.new do
        redis_sub = Redis.new(url: ENV['REDISTOGO_URL'])
        redis_sub.subscribe(CHANNEL) do |on|
          on.message do |channel, msg|
            begin
              obj  = JSON.parse(msg)
              slug = obj['slug']
              next unless @clients.has_key?(slug)
              @clients[slug].each do |ws|
                ws.send msg
              end
            rescue => e
              puts "error: #{e.inspect}"
            end
          end
        end
      end
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

        # Set up the MetronomeConfig if it doesn't already exist in Redis
        config_json = @redis.get(slug)
        if config_json
          metronome = MetronomeConfig.from_json(config_json)
        else
          metronome = MetronomeConfig.new(slug)
          @redis.set(slug, metronome.to_json)
          @redis.publish(CHANNEL, metronome.to_json)
          puts "Created new metronome with slug: '#{slug}'."
        end

        # Add the client to the list of clients for this slug
        @clients[slug] ||= []
        puts "Connecting client ##{ws.object_id} to metronome: '#{slug}'."
        @clients[slug] << ws

        # Send the current info to the client
        ws.send metronome.to_json
      end

      ws.on :message do |event|
        querystring = env['QUERY_STRING']
        hash = Rack::Utils.parse_nested_query(querystring)

        unless hash.has_key?('slug')
          return puts "No slug specified for message."
        end
        slug = hash['slug']

        # Pull the existing metronome from Redis
        config_json = @redis.get(slug)
        unless config_json
          return puts "Metronome not found for slug: #{slug}."
        end
        metronome = MetronomeConfig.from_json(config_json)
        unless metronome
          return puts "Could not parse metronome config for: #{slug}."
        end

        # Make the change
        hash = JSON.parse(event.data)
        metronome.beatsPerMinute  = hash['beatsPerMinute']  if hash.has_key?('beatsPerMinute')
        metronome.beatsPerMeasure = hash['beatsPerMeasure'] if hash.has_key?('beatsPerMeasure')
        metronome.key             = hash['key']             if hash.has_key?('key')
        metronome.muted           = hash['muted']           if hash.has_key?('muted')
        metronome.presets         = hash['presets']         if hash.has_key?('presets')
        metronome.startTime       = hash['startTime']       if hash.has_key?('startTime')

        # Update redis (which will tell all the other clients)
        @redis.set(slug, metronome.to_json)
        @redis.publish(CHANNEL, metronome.to_json)

        puts "Updated metronome '#{slug}' to: #{metronome.to_json}"

        ws.send metronome.to_json
      end

      ws.on :close do |event|
        @clients.each_pair do |slug, metronome|
          if metronome.clients.include?(ws)
            metronome.clients.delete(ws)
            puts "Removing disconnected client ##{ws.object_id} from metronome: '#{slug}'."
          end
        end
      end

      # Return async Rack response
      ws.rack_response
    end
  end
end

