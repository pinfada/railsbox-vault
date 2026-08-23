require "test_helper"
require "open3"

# `bin/vault-fixture` est exécutée dans la VM, où seuls son code de sortie et sa
# sortie d'erreur sont observables. Elle est donc testée comme un processus, pas
# comme une méthode : sur un volume neuf, avec ses vrais codes de sortie.
class FixtureCommandTest < ActiveSupport::TestCase
  test "create puis create : idempotence prouvée par deux exécutions réelles" do
    dans_un_volume_neuf do |environnement|
      sortie, erreur, statut = executer(environnement, "create")
      assert_equal 0, statut.exitstatus, erreur
      assert_match(/invariant créé/, sortie)

      sortie, erreur, statut = executer(environnement, "create")
      assert_equal 0, statut.exitstatus, erreur
      assert_match(/invariant retrouvé/, sortie)
      assert_match(/déjà présente/, sortie)

      _, _, statut = executer(environnement, "verify")
      assert_equal 0, statut.exitstatus
    end
  end

  test "verify sort en 2 avec diagnostic quand l'invariant est absent" do
    dans_un_volume_neuf do |environnement|
      sortie, erreur, statut = executer(environnement, "verify")

      assert_equal 2, statut.exitstatus
      assert_match(/invariant absent/, sortie)
      assert_match(/record\.id/, erreur)
    end
  end

  test "verify --json rend le verdict complet sur la sortie standard" do
    dans_un_volume_neuf do |environnement|
      executer(environnement, "create")
      sortie, _, statut = executer(environnement, "verify", "--json")

      assert_equal 0, statut.exitstatus
      charge = JSON.parse(sortie)
      assert_equal "conforming", charge.fetch("status")
      assert_equal Vault::Contract.attachment.fetch("sha256"), charge.dig("observed", "attachment", "sha256")
    end
  end

  test "une commande inconnue sort en 64 et affiche l'usage" do
    dans_un_volume_neuf do |environnement|
      _, erreur, statut = executer(environnement, "detruire")

      assert_equal 64, statut.exitstatus
      assert_match(/Usage : bin\/vault-fixture/, erreur)
    end
  end

  private

  def dans_un_volume_neuf
    Dir.mktmpdir do |repertoire|
      environnement = {
        "RAILS_ENV" => "test",
        "VAULT_DATABASE_PATH" => File.join(repertoire, "vault.sqlite3"),
        "VAULT_STORAGE_ROOT" => File.join(repertoire, "storage"),
        # La commande est appelée SANS `bundle exec` dans la construction du
        # disque applicatif. Hériter du `RUBYOPT=-rbundler/setup` du processus
        # de test masquerait cette différence — et c'est précisément elle qui a
        # fait échouer la première construction, sur une activation prématurée
        # de la gemme par défaut `json`.
        "RUBYOPT" => nil,
        "RUBYLIB" => nil
      }
      _, erreur, statut = Open3.capture3(environnement, RbConfig.ruby, "bin/rails", "db:migrate",
                                         chdir: Rails.root.to_s)
      assert_equal 0, statut.exitstatus, "migration du volume de test impossible : #{erreur}"
      yield environnement
    end
  end

  def executer(environnement, *arguments)
    Open3.capture3(environnement, RbConfig.ruby, "bin/vault-fixture", *arguments, chdir: Rails.root.to_s)
  end
end
