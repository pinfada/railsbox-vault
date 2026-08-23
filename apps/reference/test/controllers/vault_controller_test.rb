require "test_helper"

class VaultControllerTest < ActionDispatch::IntegrationTest
  test "GET /vault/health rend l'identité de l'image en JSON" do
    get "/vault/health"

    assert_response :ok
    assert_equal "application/json", response.media_type
    charge = JSON.parse(response.body)
    assert_equal Vault::Contract.application_id, charge.dig("app", "id")
    assert_equal Vault::Contract.application_version, charge.dig("app", "version")
    assert_equal Rails.version, charge.fetch("rails")
    assert_equal RUBY_VERSION, charge.fetch("ruby")
    assert_equal "sqlite", charge.dig("database", "adapter")
    refute_empty charge.dig("database", "version")
    refute_empty charge.dig("schema", "version")
  end

  test "GET /vault/invariant rend 404 tant que l'invariant n'existe pas" do
    get "/vault/invariant"

    assert_response :not_found
    assert_equal "absent", JSON.parse(response.body).fetch("status")
  end

  test "GET /vault/invariant rend 200 et le verdict conforme" do
    Vault::Fixture.create

    get "/vault/invariant"

    assert_response :ok
    charge = JSON.parse(response.body)
    assert_equal "conforming", charge.fetch("status")
    assert_empty charge.fetch("differences")
    assert_equal Vault::Contract.attachment.fetch("sha256"), charge.dig("observed", "attachment", "sha256")
    assert_equal Vault::Contract.attachment.fetch("sha256"), charge.dig("expected", "attachment", "sha256")
  end

  test "GET /vault/invariant rend 409 et nomme les écarts en cas de divergence" do
    Vault::Fixture.create
    Record.find(Vault::Contract.record.fetch("id")).update_column(:payload, "altéré")

    get "/vault/invariant"

    assert_response :conflict
    charge = JSON.parse(response.body)
    assert_equal "divergent", charge.fetch("status")
    assert_equal ["record.payload"], charge.fetch("differences").map { |ecart| ecart.fetch("field") }
  end

  test "aucune route ActiveStorage n'est exposée" do
    chemins = Rails.application.routes.routes.map { |route| route.path.spec.to_s }

    assert_equal ["/vault/health(.:format)", "/vault/invariant(.:format)"], chemins
  end
end
