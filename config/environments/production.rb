Pony.options = {
  from: 'no-reply@shared-metronome.com',
  via:  :smtp,
  via_options: {
    address:              'smtp.mandrillapp.com',
    port:                 587,
    domain:               'www.shared-metronome.com',
    user_name:            ENV['MANDRILL_USERNAME'],
    password:             ENV['MANDRILL_APIKEY'],
    authentication:       :plain,
    enable_starttls_auto: true,
  },
}

Rollbar.configure do |config|
  config.access_token = ENV['ROLLBAR_ACCESS_TOKEN']
  config.exception_level_filters.merge!('Sinatra::NotFound' => 'ignore')
end

