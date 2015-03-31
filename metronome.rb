require 'rubygems'
require 'bundler/setup'
require 'sinatra'
require 'json'
require 'sinatra/form_helpers'

module Metronome
  class App < Sinatra::Base
    set :public_folder, File.dirname(__FILE__) + '/public'
    helpers Sinatra::FormHelpers

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
      redis.set(slug, metronome.to_json)

      # Redirect to it
      redirect to("/#{slug}")
    end

    get '/:slug' do
      # Make sure a metronome exists for this slug
      slug        = params['slug']
      redis       = _get_redis
      config_json = redis.get(slug)
      raise Sinatra::NotFound unless config_json

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

