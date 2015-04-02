Pony.options = {
  from: 'no-reply@shared-metronome.com',
  via:  :smtp,
  via_options: {
    address:              'smtp.mandrillapp.net',
    port:                 '587',
    domain:               'heroku.com',
    user_name:            ENV['MANDRILL_USERNAME'],
    password:             ENV['MANDRILL_APIKEY'],
    authentication:       :plain,
    enable_starttls_auto: true,
  },
}

