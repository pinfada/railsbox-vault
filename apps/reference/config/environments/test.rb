Rails.application.configure do
  config.enable_reloading = false
  config.eager_load = false

  config.consider_all_requests_local = true
  config.action_dispatch.show_exceptions = :none

  config.logger = ActiveSupport::TaggedLogging.logger(File::NULL)
  config.log_level = :fatal

  config.active_support.deprecation = :raise

  # Le dépôt ne contient pas de `schema.rb` : les migrations sont la seule
  # description du schéma. `test_helper.rb` les applique explicitement, et rien
  # ne doit tenter de charger un fichier de schéma inexistant.
  config.active_record.maintain_test_schema = false
end
