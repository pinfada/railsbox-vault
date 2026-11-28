# frozen_string_literal: true

# La DURABILITÉ de #209 imposée par l'outil à toute application Rails, sans la modifier (#351).
#
# Chargé par `RUBYOPT=-r/opt/vault/durabilite-rails.rb` (`env.sh` du guest, et la construction du
# paquet). Il ne charge rien lui-même : il attend que Rails ouvre les deux classes qu'il complète, et
# ne fait rien dans un processus qui ne les ouvre pas (Bundler, `gem`, un script Ruby quelconque).
#
#  - `ActiveRecord::ConnectionAdapters::SQLite3Adapter` : après les pragmas de Rails, chaque
#    connexion pose `PRAGMA synchronous = EXTRA`. Rails pose `NORMAL` par défaut (`DEFAULT_PRAGMAS`),
#    qui ne synchronise rien au commit en mode WAL : une coupure perd les dernières transactions
#    acquittées. La référence pose `synchronous: 3` dans SON `database.yml` (ADR 0004, note du
#    13/09/2026) ; une application conventionnelle ne le fait pas, et c'est l'outil qui le fait.
#  - `ActiveStorage::Service::DiskService` : après `upload`, le fichier, son répertoire et le parent
#    de chaque répertoire créé sont synchronisés — le geste de `DurableDiskService` de la référence,
#    appliqué au service `Disk` que toute application emploie.
#
# Pourquoi un `TracePoint(:class)` : c'est le seul point d'accroche qui ne dépende ni de Bundler ni
# d'ActiveSupport, absents quand ce fichier est chargé. Il se déclenche à l'ouverture d'une classe,
# avant son corps : le module PRÉPOSÉ appelle `super`, qui atteint la méthode définie ensuite. Il ne
# coûte qu'un appel par mot-clé `class`, et rien d'autre.
module VaultDurabilite
  # Les connexions SQLite : `synchronous = EXTRA` après les pragmas de Rails.
  module SQLiteDurable
    private

    def configure_connection
      super
      @raw_connection.execute("PRAGMA synchronous = EXTRA")
    end
  end

  # Le service `Disk` : ce qui est téléversé est synchronisé avant de rendre la main.
  module DisqueDurable
    def upload(key, io, checksum: nil, **options)
      chemin = path_for(key)
      crees = VaultDurabilite.repertoires_absents(File.dirname(chemin))
      super
      VaultDurabilite.synchroniser(chemin)
      [File.dirname(chemin), *crees.map { |repertoire| File.dirname(repertoire) }].uniq
        .each { |repertoire| VaultDurabilite.synchroniser(repertoire) }
    end
  end

  CIBLES = {
    "ActiveRecord::ConnectionAdapters::SQLite3Adapter" => SQLiteDurable,
    "ActiveStorage::Service::DiskService" => DisqueDurable
  }.freeze

  NOM = Module.instance_method(:name)

  # Les répertoires que `mkdir_p` va créer, du plus profond au plus proche de la racine.
  def self.repertoires_absents(repertoire)
    absents = []
    until File.directory?(repertoire)
      absents << repertoire
      parent = File.dirname(repertoire)
      break if parent == repertoire

      repertoire = parent
    end
    absents
  end

  def self.synchroniser(chemin)
    File.open(chemin, File::RDONLY, &:fsync)
  end

  TracePoint.new(:class) do |point|
    cible = CIBLES[NOM.bind_call(point.self)]
    point.self.prepend(cible) if cible && !point.self.ancestors.include?(cible)
  end.enable
end
