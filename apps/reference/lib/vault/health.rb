module Vault
  # Carte d'identité de l'image qui tourne. Tout y est lu à l'exécution : rien
  # n'est recopié à la construction, donc rien ne peut mentir sur ce qui a
  # réellement démarré.
  module Health
    module_function

    def payload
      ActiveRecord::Base.with_connection do |connexion|
        {
          "app" => {
            "id" => Contract.application_id,
            "version" => Contract.application_version
          },
          "rails" => Rails.version,
          "ruby" => RUBY_VERSION,
          "database" => {
            "adapter" => connexion.adapter_name.downcase,
            "version" => connexion.database_version.to_s
          },
          "schema" => {
            "version" => schema_version.to_s
          }
        }
      end
    end

    def schema_version
      ActiveRecord::Base.connection_pool.migration_context.current_version
    end
  end
end
