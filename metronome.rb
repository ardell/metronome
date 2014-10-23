require 'rubygems'
require 'bundler/setup'
require 'sinatra'
require 'json'

module Metronome
  class App < Sinatra::Base
    set :public_folder, File.dirname(__FILE__) + '/public'

    get '/' do
      erb :index
    end

    get '/:slug' do
      puts params.inspect
      erb :show
    end
  end
end

