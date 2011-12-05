require 'rubygems'
require 'bundler/setup'
require 'sinatra'

set :public_folder, File.dirname(__FILE__) + '/public'

get '/' do
  erb :index
end

get '/time' do
  return (Time.now.to_f * 1000).to_s
end
