Rails.application.routes.draw do
  # Deux routes JSON : `health` décrit l'image qui tourne ; `invariant` rend le
  # même verdict que `bin/vault-fixture verify`. Elles n'ont pas bougé.
  get "/vault/health", to: "vault#health"
  get "/vault/invariant", to: "vault#invariant"

  # La SURFACE HTML (#192) : la plus petite qui porte un document, ses actifs,
  # un formulaire, une redirection et un cookie de session. Elle ne touche ni
  # aux deux routes ci-dessus ni à l'invariant qu'elles décrivent.
  root to: "pages#index"
  post "/notes", to: "pages#create", as: :notes
  get "/notes/:id", to: "pages#show", as: :note
end
