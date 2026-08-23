ENV["RAILS_ENV"] = "test"

require "fileutils"

# Chaque exécution repart d'un volume applicatif neuf : base SQLite et racine
# ActiveStorage sont créées sous `tmp/test/`, jamais dans `var/`, pour qu'un test
# ne puisse pas valider l'invariant d'une image construite.
RACINE_APPLICATION = File.expand_path("..", __dir__)
RACINE_EXECUTION = File.join(RACINE_APPLICATION, "tmp", "test")
FileUtils.rm_rf(RACINE_EXECUTION)
FileUtils.mkdir_p(File.join(RACINE_EXECUTION, "db"))
ENV["VAULT_DATABASE_PATH"] = File.join(RACINE_EXECUTION, "db", "test.sqlite3")
ENV["VAULT_STORAGE_ROOT"] = File.join(RACINE_EXECUTION, "storage")

require_relative "../config/environment"

# Le dépôt ne contient pas de `schema.rb` : les migrations sont la seule
# description du schéma, et le schéma de test est celui qu'elles produisent.
ActiveRecord::Migration.suppress_messages do
  ActiveRecord::Base.connection_pool.migration_context.migrate
end

require "rails/test_help"
require "tmpdir"

module ActiveSupport
  class TestCase
    # Les fichiers ActiveStorage vivent hors transaction : une transaction
    # annulée laisserait des blobs orphelins sur le disque et le test suivant
    # les retrouverait.
    setup do
      FileUtils.rm_rf(ENV.fetch("VAULT_STORAGE_ROOT"))
    end
  end
end
