require 'rubygems'
require 'bundler/setup'
require 'sinatra'

set :public_folder, File.dirname(__FILE__) + '/public'

get '/' do
  erb :index
end

get '/time' do
  client = params[:client].to_f
  server = Time.now.to_f
  return (client - server).to_s
end

