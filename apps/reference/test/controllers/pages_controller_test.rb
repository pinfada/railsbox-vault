require "test_helper"
require "tempfile"

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

  test "POST /notes avec une pièce jointe la joint à la note, et la page la relit à l'octet (#209)" do
    jeton = jeton_du_formulaire
    contenu = Random.new(209).bytes(64 * 1024)
    piece = Rack::Test::UploadedFile.new(StringIO.new(contenu), "application/octet-stream",
                                         true, original_filename: "piece.bin")

    post "/notes", params: { libelle: "note et piece", piece: piece, authenticity_token: jeton }

    assert_response :see_other
    note = Record.order(:created_at).last
    assert note.evidence.attached?, "la pièce n'est pas jointe"
    follow_redirect!
    assert_match %r{data-piece-octets="#{contenu.bytesize}"}, response.body
    assert_match %r{data-piece-sha256="#{Digest::SHA256.hexdigest(contenu)}"}, response.body
  end

  test "une note dont le fichier a disparu le DIT au lieu de rendre une erreur" do
    jeton = jeton_du_formulaire
    piece = Rack::Test::UploadedFile.new(StringIO.new("octets"), "application/octet-stream",
                                         true, original_filename: "piece.bin")
    post "/notes", params: { libelle: "note amputee", piece: piece, authenticity_token: jeton }
    note = Record.order(:created_at).last
    File.delete(ActiveStorage::Blob.service.path_for(note.evidence.blob.key))

    get "/notes/#{note.id}"

    assert_response :ok
    assert_match %r{data-piece-etat="fichier-introuvable"}, response.body
    refute_match %r{data-piece-sha256}, response.body
  end

  test "une note sans pièce ne porte aucune pièce, et un champ « piece » textuel est ignoré" do
    jeton = jeton_du_formulaire

    post "/notes", params: { libelle: "note sans piece", piece: "pas un fichier", authenticity_token: jeton }

    assert_response :see_other
    refute Record.order(:created_at).last.evidence.attached?
    follow_redirect!
    refute_match %r{data-piece-octets}, response.body
  end

  test "la page d'accueil publie l'état du disque applicatif relevé au montage (revue #211, 5)" do
    releve = Tempfile.new("disque-applicatif")
    releve.write("options=rw,relatime,errors=remount-ro,data=ordered\nerreurs=0\nalertes=0\nrejeu=1\n")
    releve.close
    precedent = ENV["VAULT_ETAT_DU_DISQUE"]
    ENV["VAULT_ETAT_DU_DISQUE"] = releve.path

    get "/"

    assert_response :ok
    assert_match %r{<p id="etat-du-disque" data-disque-releve="oui"}, response.body
    assert_match %r{data-disque-options="rw,relatime,errors=remount-ro,data=ordered"}, response.body
    assert_match %r{data-disque-erreurs="0"}, response.body
    assert_match %r{data-disque-alertes="0"}, response.body
    assert_match %r{data-disque-rejeu="1"}, response.body
  ensure
    ENV["VAULT_ETAT_DU_DISQUE"] = precedent
    releve&.unlink
  end

  test "hors du guest, la page dit que l'état du disque n'est pas relevé" do
    precedent = ENV["VAULT_ETAT_DU_DISQUE"]
    ENV["VAULT_ETAT_DU_DISQUE"] = File.join(Dir.tmpdir, "aucun-releve-#{SecureRandom.hex(8)}")

    get "/"

    assert_match %r{<p id="etat-du-disque" data-disque-releve="non"}, response.body
    refute_match %r{data-disque-erreurs}, response.body
  ensure
    ENV["VAULT_ETAT_DU_DISQUE"] = precedent
  end

  test "le formulaire se soumet en multipart et porte un champ de pièce jointe" do
    get "/"

    assert_match %r{<form [^>]*enctype="multipart/form-data"}, response.body
    assert_match %r{<input [^>]*type="file"[^>]*id="piece"|<input [^>]*id="piece"[^>]*type="file"}, response.body
  end

  test "POST /notes sans jeton anti-CSRF est refusé, et rien n'est créé" do
    # `InvalidAuthenticityToken` n'est défini qu'au chargement d'`ActionController::Base`. Quand ce
    # test tire le premier de la graine, aucune requête ne l'a encore chargé, et la constante est
    # évaluée AVANT le `post` : il faut la charger ici, sans quoi l'épreuve dépend de l'ordre.
    assert_operator PagesController, :<, ActionController::Base
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
