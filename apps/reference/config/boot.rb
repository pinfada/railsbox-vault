ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

require "bundler/setup"

# Bootsnap, activé AVANT que quoi que ce soit de Rails ne soit requis — c'est la
# seule position où il sert : il intercepte `require`, et ce qui est déjà chargé
# ne repasse pas par lui.
#
# Ce qu'il met en cache, et pourquoi cela compte ici :
#
#   · `load_path_cache`   la résolution d'un `require` parcourt tout le
#                         `$LOAD_PATH` à la recherche du fichier. Avec ~90
#                         gemmes chargées, c'est des dizaines de milliers
#                         d'appels `stat` — sur un disque émulé, chacun coûte ;
#   · `compile_cache_iseq` la compilation du source Ruby en `InstructionSequence`
#                         est refaite à chaque démarrage. C'est du CPU pur, et le
#                         CPU est précisément ce que l'i386 émulé rend rare
#                         (ADR 0005 : le boot Puma/Rails pèse ~79 % de la
#                         reprise, faute d'accélération matérielle) ;
#   · `compile_cache_yaml` `i18n`, `tzinfo` et ActiveSupport lisent des YAML au
#                         démarrage ; leur analyse est mise en cache de même.
#
# Le cache est écrit dans `tmp/cache` du volume applicatif et PRÉ-CHAUFFÉ à la
# construction de l'image : il est complet avant le premier boot chez
# l'utilisateur. `development_mode: false` est exact — l'image ne recharge
# jamais son code (`config.enable_reloading = false`) — et évite à Bootsnap de
# revalider les entrées à chaque `require`.
#
# Ce que Bootsnap NE fait PAS : il ne modifie aucun comportement observable. Un
# cache absent, périmé ou illisible fait simplement retomber sur le chemin
# normal — le boot est plus lent, jamais faux. C'est pourquoi il n'y a rien à
# vérifier ici : `apps/reference/test` et `npm run test:vm:reference` observent
# le même invariant avec ou sans cache.
require "bootsnap"
Bootsnap.setup(
  cache_dir: File.expand_path("../tmp/cache", __dir__),
  development_mode: false,
  load_path_cache: true,
  compile_cache_iseq: true,
  compile_cache_yaml: true,
)
