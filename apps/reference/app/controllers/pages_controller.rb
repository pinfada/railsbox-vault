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
    note.save!
    redirect_to note_path(note), status: :see_other
  end

  def show
    @note = Record.find_by(id: params[:id])
    @vues = compter_la_vue
    return render :absente, status: :not_found if @note.nil?

    render :show
  end

  private

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
