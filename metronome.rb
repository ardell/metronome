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
      redis   = Redis.new(url: ENV['REDISTOGO_URL'])
      channel = 'metronome-updates'

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
      redis.publish(channel, metronome.to_json)

      # Redirect to it
      redirect to("/#{slug}")
    end

    get '/:slug' do
      erb :show, layout: :layout
    end
  end
end

