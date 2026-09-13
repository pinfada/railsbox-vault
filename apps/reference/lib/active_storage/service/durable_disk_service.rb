require "active_storage/service/disk_service"

module ActiveStorage
  # Le service `Disk` de Rails, qui rend DURABLE ce qu'il téléverse avant de rendre la main (#209).
  #
  # ActiveStorage téléverse dans un `after_commit`, donc APRÈS la dernière barrière SQLite, et `Disk`
  # n'appelle `fsync` ni sur le fichier ni sur les répertoires qu'il crée : une coupure juste après
  # la réponse perd la pièce que la page vient d'afficher. Ce service synchronise le fichier, puis
  # chaque répertoire dont une entrée vient de naître — celui du fichier, et le parent de chaque
  # répertoire créé. Dans le guest, chaque `fsync` émet une barrière que le pont FLUSH n'acquitte
  # qu'après validation de la génération dans l'OPFS : quatre au plus par pièce, quelle que soit sa
  # taille.
  #
  # Ce qu'il ne couvre pas : une coupure entre le commit et le téléversement laisse une ligne sans
  # fichier. Le 303 n'est pas encore parti, ce n'est donc pas une écriture acquittée perdue, mais
  # l'état est incohérent (ADR 0004, note du 13/09/2026).
  class Service::DurableDiskService < Service::DiskService
    def upload(key, io, checksum: nil, **)
      instrument :upload, key: key, checksum: checksum do
        chemin = path_for(key)
        crees = repertoires_absents(File.dirname(chemin))
        FileUtils.mkdir_p(File.dirname(chemin))
        File.open(chemin, "wb") do |fichier|
          IO.copy_stream(io, fichier)
          fichier.fsync
        end
        [File.dirname(chemin), *crees.map { |repertoire| File.dirname(repertoire) }].uniq
          .each { |repertoire| synchroniser_le_repertoire(repertoire) }
        ensure_integrity_of(key, checksum) if checksum
      end
    end

    private

    # Les répertoires que `mkdir_p` va créer, du plus profond au plus proche de la racine.
    def repertoires_absents(repertoire)
      absents = []
      until File.directory?(repertoire)
        absents << repertoire
        parent = File.dirname(repertoire)
        break if parent == repertoire

        repertoire = parent
      end
      absents
    end

    def synchroniser_le_repertoire(repertoire)
      File.open(repertoire, File::RDONLY) { |descripteur| descripteur.fsync }
    end
  end
end
