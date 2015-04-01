require 'redis'
require 'faye/websocket'
require 'json'
require 'observer'

class MetronomeConfig
  include Observable

  attr_accessor :slug
  attr_accessor :email
  attr_accessor :beatsPerMinute
  attr_accessor :beatsPerMeasure
  attr_accessor :key
  attr_accessor :muted
  attr_accessor :presets
  attr_accessor :clients
  attr_accessor :invitees
  attr_accessor :isPublic
  attr_accessor :startTime

  def initialize(slug, email)
    @slug            = slug
    @email           = email
    @beatsPerMinute  = 100
    @beatsPerMeasure = 4
    @key             = 'a'
    @muted           = false
    @presets         = []
    @clients         = []
    @invitees        = {}
    @isPublic        = true
    @startTime       = Time.now.to_f
  end

  def invite(email, role)
    # Generate a unique token
    token = SecureRandom.hex
    while @invitees.has_key?(token)
      token = SecureRandom.hex
    end

    @invitees[token] = { email: email, role: role }
    token
  end

  def to_h
    {
      slug:            @slug,
      email:           @email,
      beatsPerMinute:  @beatsPerMinute,
      beatsPerMeasure: @beatsPerMeasure,
      key:             @key,
      muted:           @muted,
      presets:         @presets,
      clients:         @clients,
      invitees:        @invitees,
      isPublic:        @isPublic,
      startTime:       @startTime,
    }
  end

  def to_json
    to_h.to_json
  end

  def logged_in_h
    {
      slug:            @slug,
      email:           @email,
      beatsPerMinute:  @beatsPerMinute,
      beatsPerMeasure: @beatsPerMeasure,
      key:             @key,
      muted:           @muted,
      presets:         @presets,
      connections:     _connections_for_logged_in_user,
      isPublic:        @isPublic,
      startTime:       @startTime,
    }
  end

  def logged_in_json
    logged_in_h.to_json
  end

  def public_h
    {
      slug:            @slug,
      email:           @email,
      beatsPerMinute:  @beatsPerMinute,
      beatsPerMeasure: @beatsPerMeasure,
      key:             @key,
      muted:           @muted,
      presets:         @presets,
      connections:     _connections_for_anonymous_user,
      isPublic:        @isPublic,
      startTime:       @startTime,
    }
  end

  def public_json
    public_h.to_json
  end

  def self.from_json(json)
    hash                      = JSON.parse(json)
    metronome                 = self.new(hash['slug'], hash['email'])
    metronome.beatsPerMinute  = hash['beatsPerMinute']
    metronome.beatsPerMeasure = hash['beatsPerMeasure']
    metronome.key             = hash['key']
    metronome.muted           = hash['muted']
    metronome.presets         = hash['presets'] || []
    metronome.clients         = hash['clients'] || []
    metronome.invitees        = hash['invitees'] || {}
    metronome.isPublic        = hash['isPublic']
    metronome.startTime       = hash['startTime']
    metronome
  end

  private

  def _connections_for_logged_in_user
    identified_users = clients.uniq.map {|token| invitees[token] }.compact
    anonymous_users  = clients.select {|o| o.nil?}
    {
      total:     identified_users.length + anonymous_users.length,
      owners:    identified_users.select {|hash| hash['role'] == 'owner' }.map {|hash| hash['email'] },
      maestros:  identified_users.select {|hash| hash['role'] == 'maestro' }.map {|hash| hash['email'] },
      musicians: identified_users.select {|hash| hash['role'] == 'musician' }.map {|hash| hash['email'] },
      anonymous: anonymous_users.length,
    }
  end

  def _connections_for_anonymous_user
    identified_users = clients.uniq.map {|token| invitees[token] }.compact
    anonymous_users  = clients.select {|o| o.nil?}
    {
      total:     identified_users.length + anonymous_users.length,
      owners:    identified_users.select {|hash| hash['role'] == 'owner' }.length,
      maestros:  identified_users.select {|hash| hash['role'] == 'maestro' }.length,
      musicians: identified_users.select {|hash| hash['role'] == 'musician' }.length,
      anonymous: anonymous_users.length,
    }
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

              # Load metronome
              config_json = @redis.get(slug)
              unless config_json
                next puts "Could not find an active metronome with that slug."
              end
              metronome = MetronomeConfig.from_json(config_json)

              # Send to connected clients
              @clients[slug].each do |ws|
                ws.send metronome.public_json
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
          next puts "Please specify the slug you wish to connect to."
        end
        slug = hash['slug']

        # Set up the MetronomeConfig if it doesn't already exist in Redis
        config_json = @redis.get(slug)
        unless config_json
          next puts "Could not find an active metronome with that slug."
        end
        metronome = MetronomeConfig.from_json(config_json)

        # Get the user's token if they have one
        token = _get_token(slug, event)

        # Add this user to the list of clients for this metronome
        metronome.clients << token
        @redis.set(slug, metronome.to_json)
        @redis.publish(CHANNEL, metronome.to_json)

        # Add the client to the list of clients for this slug on this server
        @clients[slug] ||= []
        puts "Connecting client ##{ws.object_id} to metronome: '#{slug}'."
        @clients[slug] << ws

        # Send the current info to the client
        if token and metronome.invitees.has_key?(token)
          ws.send metronome.logged_in_json
        else
          ws.send metronome.public_json
        end
      end

      ws.on :message do |event|
        querystring = env['QUERY_STRING']
        hash = Rack::Utils.parse_nested_query(querystring)

        unless hash.has_key?('slug')
          puts "No slug specified for message."
          next
        end
        slug = hash['slug']

        # Pull the existing metronome from Redis
        config_json = @redis.get(slug)
        unless config_json
          puts "Metronome not found for slug: #{slug}."
          next
        end
        metronome = MetronomeConfig.from_json(config_json)
        unless metronome
          puts "Could not parse metronome config for: #{slug}."
          next
        end

        # Make sure the user is an authorized :owner or :maestro
        # TODO: Implement CSRF protection, see: http://faye.jcoglan.com/security/csrf.html
        token = _get_token(slug, event)
        unless token
          puts "User doesn't have a token."
          next ws.send metronome.public_json
        end
        unless metronome.invitees.has_key?(token)
          puts "Token #{token} isn't authorized on metronome #{slug}."
          next ws.send metronome.public_json
        end
        invitee = metronome.invitees[token]
        unless invitee['role'] == 'owner' or invitee['role'] == 'maestro'
          puts "User #{invitee['email']} is #{invitee['role']}, not :owner/:maestro, so they can't make edits."
          next ws.send metronome.public_json
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

        if token and metronome.invitees.has_key?(token)
          ws.send metronome.logged_in_json
        else
          ws.send metronome.public_json
        end
      end

      ws.on :close do |event|
        @clients.each_pair do |slug, clients|
          if clients.include?(ws)
            puts "Removing disconnected client ##{ws.object_id} from metronome: '#{slug}'."
            @clients[slug].delete(ws)

            # Got the slug
            config_json = @redis.get(slug)
            unless config_json
              next puts "Metronome not found for slug: #{slug}."
            end
            metronome = MetronomeConfig.from_json(config_json)
            unless metronome
              next puts "Could not parse metronome config for: #{slug}."
            end
            token = _get_token(slug, event)
            metronome.clients.delete_at(metronome.clients.index(token) || metronome.clients.length)
            @redis.set(slug, metronome.to_json)
            @redis.publish(CHANNEL, metronome.to_json)
          end
        end
      end

      # Return async Rack response
      ws.rack_response
    end

    def _get_token(slug, event)
      return nil unless event.current_target.env.has_key?('HTTP_COOKIE')

      cookies    = CGI::Cookie::parse(event.current_target.env['HTTP_COOKIE'])
      cookie_key = "metronome_token_#{slug}"
      return nil unless cookies.has_key?(cookie_key)

      cookies[cookie_key].value.to_s.split(';').first.split('=').last
    end
  end
end

