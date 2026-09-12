require "test_helper"

# La surface HTML (#192) : ce que le relais doit savoir franchir.
#
# Ces épreuves mesurent l'APPLICATION, jamais le relais — elles tournent hors de
# toute VM et hors de tout navigateur. Ce qu'elles closent est l'autre moitié de
# la question : si la page servie dans le cadre est fausse, il faut pouvoir dire
# lequel des deux côtés l'a rendue fausse.
#
# La protection anti-CSRF reste ARMÉE ici, contrairement à l'habitude d'un
# environnement de test : c'est elle qui exige un cookie de session cohérent
# avec le jeton du formulaire, et c'est donc elle qui mesure l'aller-retour que
# le relais devra franchir. La désarmer aurait rendu ces épreuves vertes sur un
# chemin que la VM n'emprunte pas.
class PagesControllerTest < ActionDispatch::IntegrationTest
  test "GET / rend un document HTML, ses trois sous-ressources et un formulaire" do
    get "/"

    assert_response :ok
    assert_equal "text/html", response.media_type
    assert_match %r{<link rel="stylesheet" href="/vault.css">}, response.body
    assert_match %r{<script src="/vault.js" defer></script>}, response.body
    assert_match %r{<img src="/vault.png"}, response.body
    assert_match %r{<form [^>]*action="/notes"[^>]*method="post"}, response.body
    assert_match %r{name="authenticity_token"}, response.body
  end

  test "GET / pose un cookie de session et compte les vues" do
    get "/"
    assert_match %r{vues dans cette session : 1}, response.body
    refute_nil response.headers["Set-Cookie"]

    get "/"
    assert_match %r{vues dans cette session : 2}, response.body
  end

  test "POST /notes crée une note et REDIRIGE en 303 vers elle" do
    jeton = jeton_du_formulaire

    assert_difference -> { Record.count }, 1 do
      post "/notes", params: { libelle: "premiere note", authenticity_token: jeton }
    end

    assert_response :see_other
    note = Record.order(:created_at).last
    # Rails rend une Location ABSOLUE (RFC 7231 § 7.1.2 l'autorise dans les deux
    # formes). C'est un fait de l'application, et c'est au relais de le traiter :
    # dans le guest, l'hôte est `127.0.0.1:3000`, que le cadre ne doit jamais voir.
    assert_equal "http://www.example.com/notes/#{note.id}", response.headers["Location"]
    assert_equal "premiere note", note.label

    follow_redirect!
    assert_response :ok
    assert_match %r{premiere note}, response.body
    assert_match note.id, response.body
  end

  test "POST /notes sans jeton anti-CSRF est refusé, et rien n'est créé" do
    assert_no_difference -> { Record.count } do
      assert_raises(ActionController::InvalidAuthenticityToken) do
        post "/notes", params: { libelle: "note sans jeton" }
      end
    end
  end

  test "POST /notes refuse un libellé vide sans rien créer" do
    jeton = jeton_du_formulaire

    assert_no_difference -> { Record.count } do
      post "/notes", params: { libelle: "   ", authenticity_token: jeton }
    end

    assert_response :unprocessable_entity
    assert_match %r{une note vide ne s&#39;enregistre pas}, response.body
  end

  test "la liste ne porte PAS l'enregistrement figé du contrat d'invariant" do
    Vault::Fixture.create
    post "/notes", params: { libelle: "note visible", authenticity_token: jeton_du_formulaire }

    get "/"

    assert_response :ok
    assert_match %r{note visible}, response.body
    refute_match(/#{Regexp.escape(Vault::Contract.record.fetch("id"))}/, response.body)
    assert_match %r{<p id="compte-notes">1</p>}, response.body
  end

  test "GET /notes/<inconnu> rend 404 plutôt qu'une exception" do
    get "/notes/f2b2a4e0-6a5f-4a3c-9c1a-000000000000"

    assert_response :not_found
    assert_match %r{note absente}, response.body
  end

  test "les trois sous-ressources sont servies par l'application elle-même" do
    { "/vault.css" => "text/css", "/vault.js" => "text/javascript", "/vault.png" => "image/png" }
      .each do |chemin, type|
      get chemin
      assert_response :ok, "#{chemin} n'est pas servi"
      assert_equal type, response.media_type, "#{chemin} n'est pas servi sous son type"
      refute_empty response.body
    end
  end

  test "les deux routes JSON n'ont pas bougé" do
    get "/vault/health"
    assert_response :ok
    assert_equal "application/json", response.media_type
  end

  private

  # Le jeton tel que le FORMULAIRE le porte, lu dans la page rendue : c'est le
  # seul qui s'apparie à la session que la même requête vient d'ouvrir.
  def jeton_du_formulaire
    get "/"
    response.body[/name="authenticity_token" value="([^"]+)"/, 1]
  end
end
