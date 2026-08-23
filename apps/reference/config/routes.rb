Rails.application.routes.draw do
  # Deux routes, pas une de plus. `health` décrit l'image qui tourne ;
  # `invariant` rend le même verdict que `bin/vault-fixture verify`.
  get "/vault/health", to: "vault#health"
  get "/vault/invariant", to: "vault#invariant"
end
