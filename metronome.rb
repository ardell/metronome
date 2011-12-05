require 'rubygems'
require 'bundler/setup'
require 'em-websocket'
require 'sinatra/base'
require 'thin'

EventMachine.run do

  class App < Sinatra::Base
    set :public_folder, File.dirname(__FILE__) + '/public'

    get '/' do
      erb :index
    end
  end

  EventMachine::WebSocket.start(:host => "localhost", :port => 8080, :debug => true) do |ws|
    ws.onopen    { ws.send "Hello Client!" }
    ws.onclose   { puts "WebSocket closed" }
    ws.onmessage { |msg| ws.send Time.now.to_f * 1000     }
    ws.onerror   { |e|   puts "Error: #{e.message}" }
  end

  App.run!({:port => 3000})

end

