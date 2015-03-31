require 'rubygems'
require 'bundler/setup'
require 'sinatra'
require 'json'
require 'sinatra/form_helpers'
require 'sinatra/cookies'

module Metronome
  class App < Sinatra::Base
    helpers Sinatra::FormHelpers
    helpers Sinatra::Cookies

    set :public_folder, File.dirname(__FILE__) + '/public'
    set :cookie_options, expires: Time.now+(60*60*24*365*10)  # 10 years from now

    get '/' do
      erb :index, layout: :layout
    end

    get '/new' do
      @metronome = {
        title: '',
        slug:  '',
        email: '',
      }
      erb :new, layout: :layout
    end

    post '/create' do
      # Initialize redis
      redis = _get_redis

      # Make sure the slug isn't taken
      slug        = params['slug']
      config_json = redis.get(slug)
      if config_json
        @metronome = {
          title: params['title'],
          slug:  params['slug'],
          email: params['email'],
        }
        @slug_error = "There is an existing metronome at /#{slug}. Please choose a different URL."
        return erb :new, layout: :layout
      end

      # Create the metronome in Redis
      metronome = MetronomeConfig.new(slug, params['email'])
      token     = metronome.invite(params['email'], :owner)
      redis.set(slug, metronome.to_json)

      # TODO: send user an email including the token

      # Redirect to it
      redirect to("/#{slug}/#{token}")
    end

    get '/:slug/:token' do
      # Check slug/token against redis, 404 unless match
      slug        = params['slug']
      redis       = _get_redis
      config_json = redis.get(slug)
      raise Sinatra::NotFound unless config_json

      # Set cookie
      cookies["metronome_token_#{slug}"] = params['token']

      redirect to("/#{params['slug']}")
    end

    get '/:slug' do
      # Make sure a metronome exists for this slug
      slug        = params['slug']
      redis       = _get_redis
      config_json = redis.get(slug)
      raise Sinatra::NotFound unless config_json

      # Check cookie to make sure user can view this slug
      token = cookies["metronome_token_#{slug}"]
      metronome = MetronomeConfig.from_json(config_json)
      unless metronome.isPublic or metronome.invitees.has_key?(token)
        raise Sinatra::NotFound
      end

      erb :show, layout: :layout
    end

    not_found do
      status 404
      erb :not_found
    end

    private

    def _get_redis
      Redis.new(url: ENV['REDISTOGO_URL'])
    end
  end
end

