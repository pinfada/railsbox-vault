# Développement

## Prérequis

- Git ;
- Node 22, version déclarée dans `.node-version` et `.nvmrc` ;
- les trois moteurs Playwright — Chromium, Firefox et WebKit — requis par `npm run check` ;
- Docker, **uniquement** pour l'application Rails de référence et son image VM (`npm run app:test`,
  `npm run image:build`, `npm run test:vm:reference`). `npm run check` n'en a pas besoin.

Aucun secret et aucune donnée personnelle ne sont nécessaires. Les artefacts VM sont récupérables
par un script versionné (`npm run vm:fetch`) et vérifiés par empreinte ; un fichier transmis
manuellement n'est jamais un prérequis accepté.

## Installation

```sh
git clone https://github.com/pinfada/railsbox-vault.git
cd railsbox-vault
npm ci
npx playwright install chromium firefox webkit
```

Sous Linux CI ou sur une machine vierge, Playwright peut installer les dépendances système avec :

```sh
npx playwright install --with-deps chromium firefox webkit
```

Chromium seul suffit pour `npm run test:browser`. Les trois moteurs sont nécessaires à
`npm run test:compat`, et donc à `npm run check`.

## Boucle rapide

```sh
npm run test:unit
npm run lint
npm run format:check
```

## Contextes d'exécution et lint

Le dépôt exécute son code dans cinq contextes qui n'offrent pas les mêmes API globales.
`eslint.config.mjs` n'accorde à chaque fichier que les globals de son contexte, afin qu'un appel
Node dans du code servi au navigateur, ou une API DOM dans un Worker, soit refusé à la première
exécution de `npm run lint` plutôt qu'à la première exécution dans le navigateur.

| Contexte           | Fichiers concernés                                                                         | Globals accordés    |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------- |
| Page               | `public/**`, `src/**/page-*.mjs`                                                           | navigateur          |
| Worker dédié       | `public/**/*worker*.mjs`, `src/**/*worker*.mjs`                                            | Worker              |
| Service Worker     | `public/**/*-sw.mjs`                                                                       | Service Worker      |
| Module partagé     | le reste de `src/**`                                                                       | navigateur ∩ Worker |
| Node               | `tools/**`, `tests/unit/**`, `tests/vm/**/*.test.mjs`, `*.config.mjs`                      | Node                |
| Spécification Node | `tests/browser/**`, `tests/compat/**`, `tests/vm/**/*.spec.mjs`, `tests/e2e/**/*.spec.mjs` | Node et navigateur  |

Trois conséquences pour un nouveau module :

- un module de `src/` est **partagé par défaut** : il ne reçoit que les globals communs à la page et
  au Worker. S'il est réservé à la page, son nom commence par `page-` ; s'il est chargé par un
  Worker, son nom contient `worker` ;
- les spécifications Playwright cumulent Node et navigateur parce que les rappels passés à
  `page.evaluate` sont analysés dans le même fichier que le corps du test. Cette exception est
  bornée à `tests/browser/`, `tests/compat/`, `tests/vm/` et `tests/e2e/` ; elle ne doit pas être
  élargie par des commentaires `/* global */`, qui reviendraient à désactiver la règle ;
- un module réellement partagé entre la page et le Worker doit **vivre sous `src/`** pour recevoir
  l'intersection, y compris s'il n'existe que pour un spike. Il est alors importé par son chemin
  absolu `/src/…`, que le serveur de test sert sous sa propre racine.
  `src/spike/isolation-probe.mjs`, chargé par la coquille du spike #35, par son Worker runtime et
  par le document applicatif, en est l'exemple.

`tests/unit/eslint-config.test.mjs` vérifie cette répartition en lintant des chemins virtuels : une
régression de la configuration fait échouer `npm run test:unit`, pas seulement le lint du jour. Une
épreuve y vise en outre un module réel, `isolation-probe.mjs`, et échoue s'il est rangé sous une
racine qui lui accorderait plus que l'intersection.

## Navigateur

```sh
npm start
```

La page est servie sur `http://127.0.0.1:4173`. Le serveur ne sert que trois racines — `public/`,
les modules de contrat sous `src/`, et les artefacts vérifiés sous `vendor/` — et il refuse toute
traversée hors de celles-ci.

Pour observer la sonde de capacités à la main, il faut un contexte isolé multi-origine, sans quoi
`SharedArrayBuffer` disparaît :

```sh
node tools/serve.mjs --port 4180 --cross-origin-isolated
```

La sonde est alors visible sur `http://127.0.0.1:4180/compat.html`, avec un tableau des verdicts.
Elle est exemptée de la CSP de la coquille : une politique qui lui refuserait WebAssembly lui ferait
rendre « capacité absente » sur un moteur qui la possède.

### Deux origines

L'ADR 0002 sépare la coquille de confiance et le document applicatif par une frontière d'origine. Le
serveur de test prend donc un rôle :

```sh
node tools/serve.mjs --role shell --host 127.0.0.1 --port 4173   # coquille, CSP stricte
node tools/serve.mjs --role app   --host localhost  --port 4174   # territoire applicatif
```

`127.0.0.1` et `localhost` sont deux origines distinctes au sens du navigateur et deux contextes
sécurisés : la frontière est réelle sans DNS ni certificat. Le rôle `shell` sert une CSP stricte à
ses propres documents et n'en impose aucune sous `/spike/origin/app*`, territoire applicatif. Le
paramètre `?isolation=require-corp` ajoute COOP/COEP à une réponse, pour mesurer l'isolation
cross-origin. `playwright.config.mjs` démarre les deux serveurs.

La coquille du spike s'ouvre à l'adresse
`http://127.0.0.1:4173/spike/origin/shell.html?topologie=T2-origine-distincte-sandbox` ; les
topologies disponibles sont listées dans `src/spike/origin-topology.mjs`.

## Machine virtuelle et backend de blocs

Les artefacts v86 et l'image de guest ne sont pas versionnés. Ils sont décrits par
`vendor/v86/MANIFEST.json` — nom, taille, empreinte SHA-256, licence, URL source — et récupérés dans
`vendor/v86/artefacts/`, dossier ignoré par git :

```sh
npm run vm:fetch      # télécharge ce qui manque, vérifie toutes les empreintes
npm run vm:check      # vérifie seulement, sans réseau
```

`vm:check` échoue si un artefact manque ou si son empreinte diffère : une mesure de VM ne provient
jamais d'un binaire non identifié. Environ 9,9 Mio sont transférés au premier appel.

```sh
npm run test:vm       # preuve « intégration VM » sous Chromium (périodique, hors `npm run check`)
npm run vm:protocol   # protocole de mesure complet sous Node → reports/vm/protocole.json
```

Le banc s'observe aussi à la main : `npm start`, puis `http://127.0.0.1:4173/vm/`. La page ne fait
rien elle-même ; elle démarre le Worker runtime et affiche son compte rendu. La console offre
`await bancVault.executer({ scenario: "filesystem", mode: "full" })`. `scenario` vaut `barrier`,
`filesystem` ou `opfs-persistence` — ce dernier adosse le disque du guest au backend OPFS et ne
prend pas de `mode` autre que `full` en pratique. `mode` vaut :

| Mode       | Comportement de v86                                                     |
| ---------- | ----------------------------------------------------------------------- |
| `observe`  | amont exact ; seules les commandes ATA sont journalisées                |
| `identify` | le disque annonce un cache d'écriture, mais la barrière reste chez v86  |
| `full`     | la barrière du guest atteint le backend et n'est acquittée qu'après lui |

Les trois modes existent parce que les deux ruptures mesurées par le spike #4 sont en série : sans
le mode intermédiaire, on ne saurait pas laquelle des deux corrections produit quel effet.

## Backend de blocs OPFS

Le banc du backend de persistance vit à `http://127.0.0.1:4173/vm/opfs.html` et n'exige **aucun**
artefact v86. La page n'ouvre aucun volume : elle démarre `public/vm/opfs-runtime-worker.mjs`, seul
contexte autorisé à détenir un handle exclusif (ADR 0002). La console offre :

```js
await bancOpfs.executer({ scenario: "persistance" }); // écrire, fermer, rouvrir, tout relire
await bancOpfs.executer({ scenario: "exclusivite" }); // second détenteur refusé, puis rendu
await bancOpfs.executer({ scenario: "adaptateur" }); // contrat de tampon v86 sur support durable
await bancOpfs.sondePage(); // ce que la PAGE obtient d'OPFS : rien
```

Les volumes vivent sous `vault-volumes/` dans l'OPFS de l'origine. Chaque scénario supprime le sien
avant de commencer : une mesure de persistance ne doit rien devoir à l'exécution précédente. Pour
repartir de zéro à la main, vider les données de site de `127.0.0.1:4173` dans le navigateur.

La suite automatisée correspondante, `tests/browser/opfs-block-backend.spec.mjs`, est rattachée à
`npm run check`.

## Application Rails de référence

`apps/reference/` est l'application Rails minimale qui porte l'invariant durable de
`VAULT-PERSIST-001` : un enregistrement d'UUID figé et une pièce jointe d'empreinte connue. Elle
n'est pas un exemple d'usage ni un gabarit d'application ; c'est un instrument de mesure.

Le choix d'`apps/` plutôt que de `fixtures/` est délibéré : `tests/fixtures/` désigne déjà, dans ce
dépôt, des données de test versionnées. Une application Rails complète, avec son `Gemfile.lock`, ses
migrations et sa suite Minitest, n'est pas une donnée de test — et `apps/` laisse la place à une
seconde application de référence (PostgreSQL, cf. ADR 0004) sans réorganisation.

Aucun secret n'y figure : ni `config/master.key`, ni `credentials.yml.enc`. La clé de signature est
dérivée d'une chaîne publique documentée dans `apps/reference/vault-invariant.json`, et
`verify-pinning.mjs` refuse la construction si l'un de ces fichiers réapparaît.

### Suite Minitest

```sh
npm run app:test
```

La suite tourne dans une image Docker `ruby:3.3.12-slim-bookworm` épinglée par digest, pas avec le
Ruby de la machine : la fixture promet Ruby 3.3.12 et un `Gemfile.lock` résolu pour la plateforme
`ruby`, et un Ruby local d'une autre version ferait passer des tests qui échoueraient dans la VM.
L'image de test est **amd64** pour rester en minutes ; elle ne prouve donc rien sur i386, ce que
seul `npm run test:vm:reference` peut faire.

Pour une commande arbitraire dans le même environnement :

```sh
node tools/run-app-tests.mjs bundle exec ruby bin/rails test test/lib/fixture_test.rb
node tools/run-app-tests.mjs bundle exec ruby bin/vault-fixture verify --json
```

### Construction de l'image VM

```sh
npm run image:build                       # tout
npm run image:build -- --seulement=app    # le disque applicatif seul
npm run image:build -- --taille-app=768   # géométrie du disque applicatif, en Mio
npm run image:build -- --sans-cache
npm run image:manifest                    # réécrit le manifeste depuis les artefacts présents
```

La construction refuse de commencer si un artefact n'est pas épinglé ou si un secret est requis :

```sh
node tools/build-reference-image/verify-pinning.mjs
```

Ce que la commande produit, dans `artifacts/reference-image/` (dossier ignoré par git) :

| Artefact                   | Rôle                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `reference-rootfs.ext4`    | `hda` : Debian i386, Ruby, scripts du guest, pont série         |
| `reference-rootfs-vmlinuz` | noyau démarré directement par v86, sans amorceur                |
| `reference-rootfs-initrd`  | initrd (pilotes ext2/ext4 avant montage de la racine)           |
| `reference-app.ext2`       | `hdb` : application, bundle, base SQLite migrée et invariant    |
| `seabios.bin`              | micrologiciel exigé par v86 pour exécuter l'option ROM du noyau |
| `vgabios.bin`              | micrologiciel VGA                                               |

Les artefacts binaires ne sont **jamais** commités. Le manifeste
`tools/build-reference-image/manifest.json` l'est : il porte nom, taille, empreinte SHA-256, licence
et origine de chaque artefact, ainsi que les versions de la chaîne. Il est la référence à laquelle
`npm run test:vm:reference` se compare.

Coût mesuré le 2026-08-23 (Windows 11, Docker Desktop 29.4.3, 28 threads logiques, 32 Gio) :

| Étape                                                 |           Temps | Résultat                                      |
| ----------------------------------------------------- | --------------: | --------------------------------------------- |
| `outils` : Debian i386 + Ruby 3.3.12 compilé          |      env. 4 min | image intermédiaire, jamais publiée           |
| `rootfs` : noyau, bibliothèques, scripts du guest     |      env. 2 min | 367 Mio en ext4                               |
| `disque-app` : bundle i386, migration, invariant créé |      env. 4 min | 512 Mio en ext2, dimensionnement paramétrable |
| Fabrication des deux systèmes de fichiers             |    env. 1,5 min | —                                             |
| **Construction complète, cache vide**                 | **env. 12 min** | 927 Mio d'artefacts, ≈ 200 Mio compressés     |
| Cache Docker conservé sur l'hôte                      |               — | environ 3 Gio                                 |

Une reconstruction sans changement de `Gemfile.lock` ni de paquets réutilise le cache Docker : elle
se limite aux étapes modifiées et retombe sous les deux minutes.

### Boot réel

```sh
npm run test:vm:reference
VAULT_VM_VERBEUX=1 npm run test:vm:reference     # relaie la console du guest
```

Voir [`testing.md`](testing.md) pour ce que cette suite affirme, ce qu'elle ne peut pas affirmer, et
pourquoi elle n'est pas rattachée à `npm run check`.

## Vérification avant une PR

```sh
npm run check
```

Cette commande est la référence locale et CI. Une nouvelle suite stable doit y être rattachée ou
documenter explicitement pourquoi elle reste périodique.
