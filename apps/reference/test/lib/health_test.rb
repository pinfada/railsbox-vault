require "test_helper"

class HealthTest < ActiveSupport::TestCase
  test "la carte de santé décrit l'image qui tourne réellement" do
    charge = Vault::Health.payload

    assert_equal Vault::Contract.application_id, charge.dig("app", "id")
    assert_equal Vault::Contract.application_version, charge.dig("app", "version")
    assert_equal Rails.version, charge.fetch("rails")
    assert_equal RUBY_VERSION, charge.fetch("ruby")
    assert_equal "sqlite", charge.dig("database", "adapter")
    assert_match(/\A\d+\.\d+/, charge.dig("database", "version"))
  end

  test "la version de schéma est celle de la dernière migration appliquée" do
    derniere = Dir[Rails.root.join("db/migrate/*.rb")].map { |chemin| File.basename(chemin)[/\A\d+/] }.max

    assert_equal derniere, Vault::Health.payload.dig("schema", "version")
  end
end
