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

  # Les fichiers statiques sont SERVIS (#192). La surface HTML porte une feuille
  # de style, un script et une image : trois requêtes réelles que le relais doit
  # franchir. Sans ce serveur, Rails rendrait 404 sur les trois, et la page
  # mesurée ne serait pas une page.
  #
  # Aucune empreinte n'entre dans les noms et il n'y a pas de pipeline d'actifs :
  # le cache est donc laissé à la REVALIDATION plutôt qu'à une durée, faute de
  # quoi un actif modifié par une version suivante serait servi depuis la
  # mémoire du navigateur sans être redemandé.
  config.public_file_server.enabled = true
  config.public_file_server.headers = { "cache-control" => "no-cache" }
end
