# La SURFACE HTML de l'application de référence (#192).
#
# Jusqu'ici l'application n'avait que deux routes JSON (`VaultController`), sans
# session, sans cookie, sans gabarit et sans une ligne de JavaScript. C'était
# suffisant pour porter un invariant durable ; ce ne l'est plus pour la tranche
# qui SERT l'application dans le cadre : un relais qui ne transporterait que du
# JSON ne prouverait ni les actifs, ni les formulaires, ni les redirections, ni
# les cookies de session — c'est-à-dire rien de ce qu'un vrai parcours emprunte.
#
# `ActionController::Base` et non `ActionController::API`, et c'est le point :
# il apporte la session, le cookie qui la porte et le jeton anti-CSRF. Le relais
# est donc mesuré sur ce qu'une application Rails ordinaire exige, pas sur un
# sous-ensemble choisi pour lui plaire.
#
# Ce que cette surface N'EST PAS : une interface. Elle ne prétend à aucune mise
# en forme ni à aucun parcours — ils appartiennent à P2 et P3 de l'épique #195.
# Elle est le plus petit terrain qui porte les quatre natures de requête que le
# relais doit franchir.
class PagesController < ActionController::Base
  # Le gabarit est cherché dans `app/views/pages/` : aucune autre convention.
  layout "application"

  # L'invariant durable N'APPARAÎT PAS dans la liste, et ce n'est pas cosmétique.
  # `Vault::Fixture.verify` le compare champ par champ ; une page qui inviterait
  # à le modifier ferait de la surface HTML une façon de casser l'invariant que
  # tout le dépôt vérifie. La liste ne porte donc que les notes SAISIES.
  def index
    @notes = notes_saisies
    @vues = compter_la_vue
    @disque = Vault::EtatDuDisque.lire
  end

  # CRÉE une note. Le POST rend une REDIRECTION (303) plutôt que du HTML : c'est
  # ce que le relais doit savoir franchir, et le mesurer exige de l'exiger.
  def create
    libelle = params[:libelle].to_s.strip
    if libelle.empty?
      @notes = notes_saisies
      @vues = compter_la_vue
      @refus = "une note vide ne s'enregistre pas"
      return render :index, status: :unprocessable_entity
    end

    note = Record.new(
      id: SecureRandom.uuid,
      label: libelle,
      payload: "railsbox-vault-reference/note",
      sequence: prochaine_sequence,
      recorded_at: Time.now.utc
    )
    # La PIÈCE JOINTE, facultative (#209) : une mutation ET son fichier, ce que le scénario de sortie
    # du MVP exige de retrouver après un boot à froid. Seul un fichier téléversé est joint ; un champ
    # textuel du même nom est ignoré plutôt que pris pour un chemin.
    piece = params[:piece]
    note.evidence.attach(piece) if piece.is_a?(ActionDispatch::Http::UploadedFile)
    note.save!
    redirect_to note_path(note), status: :see_other
  end

  def show
    @note = Record.find_by(id: params[:id])
    @vues = compter_la_vue
    return render :absente, status: :not_found if @note.nil?

    @piece = piece_relue(@note)
    render :show
  end

  # ÉCRIT le commentaire d'une note (version 1.1.0, recette QA de la PR #249, Q9) : la colonne que
  # la migration ajoute doit être UTILISABLE, pas seulement visible. Paramètres forts, longueur
  # bornée par le modèle, redirection 303 comme la création. L'enregistrement de l'invariant n'est
  # pas une note : il ne s'écrit pas ici.
  def update
    @note = Record.find_by(id: params[:id])
    @vues = compter_la_vue
    return render :absente, status: :not_found if @note.nil? || invariant?(@note)

    if @note.update(params.require(:note).permit(:commentaire))
      redirect_to note_path(@note), status: :see_other
    else
      @piece = piece_relue(@note)
      @refus = @note.errors.full_messages.to_sentence
      render :show, status: :unprocessable_entity
    end
  end

  private

  def invariant?(note)
    note.id == Vault::Contract.record.fetch("id")
  end

  # La pièce jointe RELUE depuis le stockage, son empreinte calculée sur les octets lus. Une ligne
  # qui a survécu sans son fichier se DIT (`fichier-introuvable`) au lieu de rendre une erreur 500 :
  # c'est exactement l'état qu'un scénario de coupure doit pouvoir constater.
  def piece_relue(note)
    return nil unless note.evidence.attached?

    nom = note.evidence.filename.to_s
    contenu = note.evidence.download
    { nom: nom, octets: contenu.bytesize, sha256: Digest::SHA256.hexdigest(contenu) }
  rescue ActiveStorage::FileNotFoundError
    { nom: nom }
  end

  # Les notes saisies : tout sauf l'enregistrement figé du contrat d'invariant.
  def notes_saisies
    Record.where.not(id: Vault::Contract.record.fetch("id")).order(sequence: :desc).to_a
  end

  # Le COMPTEUR DE VUES vit dans la SESSION, donc dans un cookie signé. Il est la
  # preuve la plus courte qu'un aller-retour de cookie a réellement eu lieu : un
  # relais qui perdrait le cookie rendrait 1 à chaque page, et la page l'affiche.
  def compter_la_vue
    session[:vues] = session.fetch(:vues, 0) + 1
  end

  # La séquence est contrainte à un entier strictement positif par le modèle.
  def prochaine_sequence
    (Record.maximum(:sequence) || 0) + 1
  end
end
