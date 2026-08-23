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

require "digest"

# Chaîne source de la clé de signature synthétique. Elle est publique, figée, et
# documentée dans `vault-invariant.json` (`secretKeyBase.derivation`) : la
# fixture doit démarrer sur n'importe quelle machine sans qu'aucun secret ne lui
# soit transmis. Le calcul est fait ici, hors de `lib/`, parce que la
# configuration s'exécute avant que l'autochargement ne soit disponible.
#
# `guardrails-disable-line` ci-dessous : le nom de la constante contient
# « SECRET », ce qui déclenche la règle « Secret Keyword » de l'analyse de
# secrets. La valeur n'en est pas un — elle est publiée dans le contrat, dans
# `SECURITY.md` (section « Analyse de secrets ») et vérifiée par
# `test/lib/no_secret_test.rb`. La suppression est limitée à CETTE ligne :
# toute autre affectation ressemblant à un secret reste détectée.
VAULT_SYNTHETIC_SECRET_SOURCE = "railsbox-vault-reference/synthetic-secret-key-base/v1".freeze # guardrails-disable-line

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
    config.autoload_lib(ignore: %w[])

    # Aucun secret n'est distribué avec cette application. `master.key` et
    # `credentials.yml.enc` n'existent pas, et leur absence ne doit pas être
    # rattrapée silencieusement : `require_master_key` reste à faux et la clé de
    # signature est une valeur SYNTHÈTIQUE, publique, dérivée d'une chaîne
    # documentée dans `vault-invariant.json`. Elle ne protège rien : la fixture
    # ne porte ni session, ni donnée réelle, et `SECURITY.md` interdit d'en
    # placer avant la fermeture des gates de sécurité.
    config.require_master_key = false
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE") do
      Digest::SHA512.hexdigest(VAULT_SYNTHETIC_SECRET_SOURCE)
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
