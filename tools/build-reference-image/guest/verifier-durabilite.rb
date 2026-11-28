# frozen_string_literal: true

# CONSTAT de durabilité, joué à la FABRICATION du paquet par `bin/rails runner` (#351, ADR 0055).
#
# Pour chaque base SQLite de l'environnement, et pour le service ActiveStorage `Disk` s'il y en a un :
#
#  - le fichier vit sous `/app/var`, le disque de DONNÉES. Ailleurs dans `/app`, il serait perdu au
#    boot à froid, sans erreur (ADR 0041 § 2) ;
#  - la connexion pose `synchronous = 3` (EXTRA), la garantie de #209.
#
# Un écart REFUSE la fabrication, avec ce qui est en cause : un paquet qui perdrait ses données en
# silence ne doit pas être publié. Le constat n'écrit rien que la base n'écrive déjà à son ouverture.

DONNEES = "/app/var/"

def sous_les_donnees?(chemin)
  reel = File.realpath(chemin)
  "#{reel}/".start_with?(DONNEES)
rescue SystemCallError
  false
end

ecarts = []
ActiveRecord::Base.configurations.configs_for(env_name: Rails.env).each do |config|
  next unless config.adapter.to_s.start_with?("sqlite")

  fichier = File.expand_path(config.database.to_s, Rails.root)
  ActiveRecord::Base.establish_connection(config)
  synchronous = ActiveRecord::Base.with_connection { |c| c.select_value("PRAGMA synchronous") }.to_i
  ici = sous_les_donnees?(File.dirname(fichier))
  puts "[disque-app] base #{config.name} : #{fichier}, synchronous=#{synchronous}, " \
       "#{ici ? 'disque de donnees' : 'HORS du disque de donnees'}"
  ecarts << "la base #{config.name} (#{fichier}) n'est pas sous #{DONNEES}" unless ici
  ecarts << "la base #{config.name} pose synchronous=#{synchronous}, et non 3 (EXTRA)" unless synchronous == 3
end

if defined?(ActiveStorage::Blob) && ActiveStorage::Blob.respond_to?(:service)
  service = begin
    ActiveStorage::Blob.service
  rescue StandardError
    nil
  end
  if service.respond_to?(:root)
    FileUtils.mkdir_p(service.root)
    ici = sous_les_donnees?(service.root)
    puts "[disque-app] ActiveStorage : #{service.root}, #{ici ? 'disque de donnees' : 'HORS du disque de donnees'}"
    ecarts << "ActiveStorage écrit sous #{service.root}, hors de #{DONNEES}" unless ici
  end
end

unless ecarts.empty?
  warn "REFUS : des données de l'application ne seraient pas durables dans le coffre :"
  ecarts.each { |ecart| warn "  - #{ecart}" }
  exit 1
end
