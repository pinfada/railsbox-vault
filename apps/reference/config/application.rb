require_relative "boot"

# Composants chargés un par un : l'application ne rend que du JSON. Ni
# ActionMailer, ni ActionCable, ni ActionMailbox, ni ActionText ne sont requis,
# et `require "rails/all"` les chargerait tous. ActionView est chargé parce
# qu'ActiveStorage définit des contrôleurs qui héritent d'ActionController::Base
# et que l'application charge tout son code à l'avance en production.
require "rails"
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
require "active_storage/engine"
require "action_controller/railtie"
require "action_view/railtie"

Bundler.require(*Rails.groups)

# Le service de stockage durable (#209) est cherché par ActiveStorage sous
# `active_storage/service/durable_disk_service` : `lib/` doit être sur le chemin
# de chargement, ce que Rails 8.1 ne fait plus par défaut.
$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))

require "digest"

# Chaîne source servant à DÉRIVER la clé de signature synthétique de la fixture.
# Elle est publique, figée, et documentée dans `vault-invariant.json`
# (`secretKeyBase.derivation`) : la fixture doit démarrer sur n'importe quelle
# machine sans qu'aucun secret ne lui soit transmis. Le calcul est fait ici,
# hors de `lib/`, parce que la configuration s'exécute avant que l'autochargement
# ne soit disponible.
#
# La constante s'appelle `…_SIGNING_SOURCE`, pas `…_SECRET_…` : ce n'est pas un
# secret ni la source d'un secret, mais l'entrée publique d'une dérivation. Le
# nom évite le mot « secret » à dessein — il serait faux, et il induirait en
# erreur autant un lecteur qu'un analyseur. Un vrai secret resterait détecté :
# `config.secret_key_base` ci-dessous est toujours analysé, et
# `test/lib/no_secret_test.rb` échoue si un fichier de credentials apparaît.
VAULT_SYNTHETIC_SIGNING_SOURCE = "railsbox-vault-reference/synthetic-secret-key-base/v1".freeze

module VaultReference
  # Application Rails de référence de RailsBox Vault.
  #
  # Elle n'a qu'un rôle : porter un invariant durable vérifiable — un
  # enregistrement d'identifiant figé et une pièce jointe d'empreinte connue —
  # afin qu'un boot à froid puisse prouver que la persistance a tenu.
  class Application < Rails::Application
    config.load_defaults 8.1

    # `lib/` porte la logique de l'invariant, partagée par les contrôleurs, la
    # commande de fixture et les tests.
    #
    # `lib/active_storage/` n'est PAS autochargé : ActiveStorage résout le service
    # nommé dans `storage.yml` par un `require` sur le chemin de chargement, et un
    # fichier requis ne doit pas être aussi géré par l'autochargeur.
    config.autoload_lib(ignore: %w[active_storage])

    # Aucun secret n'est distribué avec cette application. `master.key` et
    # `credentials.yml.enc` n'existent pas, et leur absence ne doit pas être
    # rattrapée silencieusement : `require_master_key` reste à faux et la clé de
    # signature est une valeur SYNTHÈTIQUE, publique, dérivée d'une chaîne
    # documentée dans `vault-invariant.json`. Elle ne protège rien : la fixture
    # ne porte ni session, ni donnée réelle, et `SECURITY.md` interdit d'en
    # placer avant la fermeture des gates de sécurité.
    config.require_master_key = false
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE") do
      Digest::SHA512.hexdigest(VAULT_SYNTHETIC_SIGNING_SOURCE)
    end

    # Déterminisme : l'invariant compare des horodatages à la seconde près.
    config.time_zone = "UTC"
    config.active_record.default_timezone = :utc

    # Les migrations sont la seule description du schéma : pas de `schema.rb`
    # généré, donc pas de fichier qui puisse diverger du disque construit.
    config.active_record.dump_schema_after_migration = false

    # ActiveStorage sur disque local, dans le volume applicatif. Aucune variante,
    # aucun analyseur, aucune route exposée : la pièce jointe est un contenu
    # binaire dont seul le digest compte.
    config.active_storage.service = :local
    config.active_storage.analyzers = []
    config.active_storage.previewers = []
    config.active_storage.draw_routes = false
    # Aucune variante n'est produite : le déclarer évite qu'ActiveStorage
    # avertisse à chaque démarrage qu'`image_processing` est absent, alors que
    # son absence est délibérée.
    config.active_storage.variant_processor = :disabled

    # Les traitements ActiveStorage s'exécutent dans la requête : une file
    # asynchrone rendrait l'invariant non déterministe juste après sa création.
    config.active_job.queue_adapter = :inline

    # Aucune génération de code n'est attendue ici.
    config.generators.system_tests = nil
  end
end
