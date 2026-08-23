# Les deux seules routes de l'application de référence.
#
# `ActionController::API` plutôt qu'`ActionController::Base` : ni session, ni
# cookie, ni jeton CSRF, ni gabarit. La surface exposée dans la VM se réduit à
# deux réponses JSON.
class VaultController < ActionController::API
  # Un verdict d'invariant se lit au code HTTP autant qu'au corps : un client
  # qui n'inspecte pas le JSON ne doit jamais confondre « conforme » et
  # « divergent ».
  STATUS_HTTP = {
    Vault::Fixture::CONFORMING => :ok,
    Vault::Fixture::DIVERGENT => :conflict,
    Vault::Fixture::ABSENT => :not_found
  }.freeze

  def health
    render json: Vault::Health.payload
  end

  def invariant
    verification = Vault::Fixture.verify
    render json: verification.as_json, status: STATUS_HTTP.fetch(verification.status)
  end
end
