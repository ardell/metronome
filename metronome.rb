require 'rubygems'
require 'bundler/setup'
require 'sinatra'
require 'json'

set :public_folder, File.dirname(__FILE__) + '/public'

get '/' do
  erb :index
end

get '/time' do
  client = params[:client].to_f
  server = Time.now.to_f
  offset = server - client

  content_type :json
  {
    offset: offset,
    time:   server,
  }.to_json
end

