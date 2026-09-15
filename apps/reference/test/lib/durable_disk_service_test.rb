require "test_helper"
require "digest"
require "stringio"
# `lib/active_storage/` n'est pas autochargé (application.rb) : Rails ne requiert ce fichier qu'en
# résolvant le service, à la première pièce jointe. Une graine qui joue cette suite avant toute
# pièce (CI du 15/09/2026, graine 8358 : NameError ×5) doit le requérir elle-même.
require "active_storage/service/durable_disk_service"

# Le service de stockage de la pièce jointe rend DURABLE ce qu'il écrit, avant de rendre la main
# (#209).
#
# ActiveStorage téléverse dans un `after_commit` : APRÈS la dernière barrière SQLite. Le service
# `Disk` de Rails n'appelle jamais `fsync` — ni sur le fichier, ni sur les répertoires qu'il crée —,
# et une coupure juste après la réponse perd la pièce que la page vient d'afficher (mesure du défi
# C-K sur ext2 en boucle : 0/3 relues). Synchroniser le fichier PUIS chaque répertoire dont une
# entrée vient de naître la rend relisible (3/3), et chaque `fsync` du guest est une barrière que le
# pont FLUSH n'acquitte qu'après validation de la génération dans l'OPFS.
#
# Ces épreuves tournent sous Linux (image Docker de `npm run app:test`) : ce qu'elles observent est
# l'ORDRE et la LISTE des `fsync`, pas la durabilité elle-même, qui se prouve sous v86.
class DurableDiskServiceTest < ActiveSupport::TestCase
  # Enregistre chaque `File#fsync` de la section surveillée, par chemin, dans l'ordre.
  module JournalDesFsync
    def fsync
      Thread.current[:journal_des_fsync]&.push(File.expand_path(path))
      super
    end
  end
  File.prepend(JournalDesFsync)

  setup do
    @racine = Dir.mktmpdir("stockage-durable")
    @service = ActiveStorage::Service::DurableDiskService.new(root: File.join(@racine, "storage"))
  end

  teardown do
    Thread.current[:journal_des_fsync] = nil
    FileUtils.rm_rf(@racine)
  end

  test "le service configuré de l'application est le service durable, pas le Disk de Rails" do
    assert_instance_of ActiveStorage::Service::DurableDiskService, ActiveStorage::Blob.service
  end

  test "un téléversement synchronise le fichier, puis chaque répertoire dont une entrée est née" do
    cle = "abcdefghijklmnop"
    chemin = @service.path_for(cle)

    appels = surveiller { @service.upload(cle, StringIO.new("contenu"), checksum: checksum("contenu")) }

    racine = File.join(@racine, "storage")
    assert_equal [
      chemin,                          # le contenu du fichier
      File.join(racine, "ab", "cd"),   # l'entrée du fichier
      File.join(racine, "ab"),         # l'entrée « cd », créée
      racine,                          # l'entrée « ab », créée
      @racine                          # l'entrée « storage », créée
    ], appels
    assert_equal "contenu", File.binread(chemin)
  end

  test "dans des répertoires qui existent déjà, seuls le fichier et son répertoire sont synchronisés" do
    @service.upload("abcd0001", StringIO.new("un"), checksum: checksum("un"))
    chemin = @service.path_for("abcd0002")

    appels = surveiller { @service.upload("abcd0002", StringIO.new("deux"), checksum: checksum("deux")) }

    assert_equal [chemin, File.dirname(chemin)], appels
  end

  test "une empreinte fausse est refusée et ne laisse aucun fichier, comme le Disk de Rails" do
    cle = "efgh0001"

    assert_raises(ActiveStorage::IntegrityError) do
      @service.upload(cle, StringIO.new("contenu"), checksum: checksum("autre chose"))
    end
    refute File.exist?(@service.path_for(cle))
  end

  test "une pièce jointe de l'application passe par le service durable et se relit à l'octet" do
    contenu = Random.new(209).bytes(64 * 1024)
    note = Record.create!(id: SecureRandom.uuid, label: "note et piece", payload: "p", sequence: 1,
                          recorded_at: Time.now.utc)
    racine = ActiveStorage::Blob.service.root

    appels = surveiller do
      note.evidence.attach(io: StringIO.new(contenu), filename: "piece.bin",
                           content_type: "application/octet-stream", identify: false)
    end

    chemin = ActiveStorage::Blob.service.path_for(note.evidence.blob.key)
    assert_equal chemin, appels.first, "le fichier est synchronisé avant tout répertoire"
    assert_includes appels, File.dirname(chemin)
    assert(appels.all? { |appel| appel.start_with?(File.dirname(racine)) })
    assert_equal Digest::SHA256.hexdigest(contenu), Digest::SHA256.hexdigest(note.reload.evidence.download)
  end

  private

  def surveiller
    appels = []
    Thread.current[:journal_des_fsync] = appels
    yield
    appels
  ensure
    Thread.current[:journal_des_fsync] = nil
  end

  def checksum(contenu) = OpenSSL::Digest::MD5.base64digest(contenu)
end
