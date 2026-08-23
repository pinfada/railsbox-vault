Rails.application.configure do
  config.enable_reloading = false
  config.eager_load = true

  # Les erreurs sont rendues en JSON par le contrôleur ; aucune page d'erreur
  # détaillée n'est servie au client.
  config.consider_all_requests_local = false

  # Journal sur la sortie standard : dans la VM, Puma écrit dans
  # /var/log/puma.log, que le pont série relaie vers l'hôte. Un journal dans un
  # fichier de l'application serait invisible depuis le navigateur.
  config.logger = ActiveSupport::TaggedLogging.logger($stdout)
  config.log_level = ENV.fetch("LOG_LEVEL", "info").to_sym
  config.log_tags = [:request_id]

  config.active_support.report_deprecations = false

  # Aucun fichier statique : l'application n'a ni asset, ni page.
  config.public_file_server.enabled = false
end
