require "test_helper"

# `SECURITY.md` interdit tout secret dans le dépôt. L'application de référence
# doit donc démarrer sans qu'aucun secret ne lui soit transmis — et le prouver.
class NoSecretTest < ActiveSupport::TestCase
  test "aucun fichier de credentials ni de clé maîtresse n'est distribué" do
    %w[config/master.key config/credentials.yml.enc config/credentials].each do |relatif|
      refute Rails.root.join(relatif).exist?, "#{relatif} ne doit pas exister"
    end
  end

  test "la clé maîtresse n'est pas exigée au démarrage" do
    refute Rails.application.config.require_master_key
  end

  test "la clé de signature est la valeur synthétique documentée" do
    attendue = Digest::SHA512.hexdigest(VAULT_SYNTHETIC_SIGNING_SOURCE)

    assert_equal attendue, Rails.application.secret_key_base
    assert Vault::Contract.data.dig("secretKeyBase", "synthetic"),
           "le contrat doit annoncer explicitement une clé synthétique"
  end

  test "SECRET_KEY_BASE reste surchargeable par l'environnement" do
    assert_equal "SECRET_KEY_BASE", Rails.root.join("config/application.rb").read[/ENV\.fetch\("(SECRET_KEY_BASE)"\)/, 1]
  end
end
