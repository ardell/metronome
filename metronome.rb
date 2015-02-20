require 'rubygems'
require 'bundler/setup'
require 'sinatra'
require 'json'

module Metronome
  class App < Sinatra::Base
    set :public_folder, File.dirname(__FILE__) + '/public'

    get '/' do
      erb :index, layout: :layout
    end

    get '/:slug' do
      erb :show, layout: :layout
    end
  end
end

