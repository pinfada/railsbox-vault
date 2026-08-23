# Stratégie de test

## Suites disponibles

| Commande                       | Portée                                                                     |                                 Coût attendu |
| ------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------: |
| `npm run test:unit`            | contrats, logique pure et configuration du lint sous Node                  |                                     secondes |
| `npm run test:browser`         | page, Worker dédié, backend OPFS réel et frontière d'origine sous Chromium |                                environ 1 min |
| `npm run test:spike:origin`    | les deux suites de frontière d'origine seules                              |                                environ 1 min |
| `npm run test:browser:moteurs` | la suite navigateur sur plusieurs moteurs                                  |                                environ 2 min |
| `npm run test:compat`          | sonde de capacités sous Chromium, Firefox et WebKit                        |              environ 20 s après installation |
| `npm run test:vm`              | guest Linux réel écrivant sur les backends mémoire et OPFS (Chromium)      |                environ 1 min, **périodique** |
| `npm run app:test`             | suite Minitest de l'application Rails de référence, en Docker              | environ 1 min après la première construction |
| `npm run test:vm:reference`    | boot à froid réel de l'image de référence sous v86                         |   plus de 10 min, Docker et artefacts requis |
| `npm test`                     | suites unitaire et navigateur                                              |                                     secondes |
| `npm run check`                | lint, format et toutes les suites actuelles                                |             moins de 2 min hors installation |

Les suites `test:e2e` et `test:resilience` seront ajoutées lorsqu'elles posséderont un premier
scénario réel. Un script vide qui réussit ne constitue pas une preuve.

### Backend de blocs OPFS

Le backend de production de `VAULT-PERSIST-001` est prouvé sur **trois** niveaux, et chacun affirme
ce que les autres ne peuvent pas.

| Niveau         | Fichier                                     | Support                     | Rattachement      |
| -------------- | ------------------------------------------- | --------------------------- | ----------------- |
| unitaire       | `tests/unit/vm-opfs-backend.test.mjs`       | double déterministe         | `npm run check`   |
| unitaire       | `tests/unit/vm-sync-access-double.test.mjs` | le double lui-même          | `npm run check`   |
| unitaire       | `tests/unit/vm-opfs-scenarios.test.mjs`     | double déterministe         | `npm run check`   |
| unitaire       | `tests/unit/vm-block-fixture.test.mjs`      | aucun (règle de la fixture) | `npm run check`   |
| navigateur     | `tests/browser/opfs-block-backend.spec.mjs` | **vrai OPFS**, Worker dédié | `npm run check`   |
| intégration VM | `tests/vm/opfs-persistence.spec.mjs`        | vrai OPFS + guest Linux     | `npm run test:vm` |

**Le niveau unitaire mesure ce que le vrai support refuse de produire.** Aucun navigateur ne rend un
quota, un handle perdu ou une écriture partielle sur demande. Le double
`src/vm/sync-access-double.mjs` le fait, de façon déterministe. Il est lui-même testé, parce qu'un
instrument non calibré invaliderait tout ce qu'il mesure.

**Le niveau navigateur mesure le vrai OPFS.** Il exécute la MÊME sonde de persistance que le niveau
unitaire — `src/vm/opfs-scenarios.mjs` — dans un Worker Chromium : écrire quatre régions dont une
non alignée sur le secteur et une jusqu'au dernier octet du volume, franchir la barrière, **fermer
le handle**, rouvrir sans redéclarer de géométrie, tout relire. Les deux niveaux doivent produire la
même empreinte SHA-256 de volume, `PROBE_VOLUME_DIGEST`. Un écart entre eux serait un résultat.

Cette empreinte n'est pas un binaire versionné : l'image attendue est **reconstruite depuis sa
règle** par `buildProbeImage()`, et `tests/unit/vm-opfs-scenarios.test.mjs` vérifie que la constante
publiée en est bien l'empreinte. La fixture principale suit la convention de la pièce jointe
d'invariant d'`apps/reference/` : bloc `i` de 32 octets valant `SHA-256(label + i)`.

La suite navigateur est rattachée à `npm run check` : **3,1 s mesurées** sous Chromium, aucun
artefact tiers, aucun réseau. Une régression du backend de persistance doit bloquer une PR.

Elle n'accorde aucune indulgence à un moteur sans OPFS synchrone : si `createSyncAccessHandle`
manque, le Worker remonte `VAULT_STORAGE_UNSUPPORTED` et la suite échoue. Un moteur sans cette API
ne peut pas porter le produit ; la mesure de sa disponibilité par moteur reste le rôle de
`test:compat` et de [`docs/compatibility.md`](compatibility.md).

**Le niveau intégration VM mesure ce que le guest en obtient.** `tests/vm/opfs-persistence.spec.mjs`
démarre un vrai guest Linux i386 sur un disque IDE adossé au backend OPFS et vérifie les **deux**
directions du support :

- l'hôte dépose une marque dans le fichier OPFS **avant** le boot, et le guest la relit sur
  `/dev/sda` par un `dd bs=1` — donc à l'octet, sur un offset non aligné du point de vue du guest ;
- le guest écrit sa propre marque avec `conv=fsync`, l'hôte ferme le handle exclusif, rouvre le
  volume et la retrouve.

Une seule direction ne prouverait qu'une moitié : qu'un guest voie le support n'implique pas que ses
écritures y atterrissent. La barrière est comptée **sur l'étape du guest** et non sur le total du
journal, qui inclurait le flush émis par l'hôte avant le boot.

Ce que ces trois niveaux n'affirment pas : que la barrière du guest garantisse la durabilité avant
son acquittement — c'est #14 —, la reprise d'une application Rails après fermeture complète (#7),
l'accès concurrent multi-onglets (#8), ni la politique de quota côté produit (#9). Le quota n'est
ici qu'un état détecté et nommé.

### Intégration VM

`tests/vm/durability-barrier.spec.mjs` est la preuve de niveau **intégration VM** du spike #4 : un
guest Linux i386 réel démarre dans un Worker dédié, écrit sur un disque IDE dont le tampon est le
backend de blocs de Vault, puis franchit une barrière de durabilité. La suite affirme deux choses
complémentaires :

- **témoin négatif** — sans le pont de durabilité, le guest classe le disque en `write through` et
  n'émet aucune barrière ; le backend n'en voit aucune ;
- **résultat** — avec le pont, l'ordre écriture → `flush` → acquittement est vérifiable dans le
  journal du backend, barrière par barrière.

Sans le témoin négatif, un test qui ne mesurerait que le cas corrigé ne prouverait pas que la
correction sert à quelque chose.

Elle **n'est pas rattachée à `npm run check`**, et la raison n'est pas sa durée : les trois épreuves
de barrière tiennent en une vingtaine de secondes et la mesure de premier boot en ajoute une
trentaine, soit **56 s mesurées** pour l'ensemble. La raison est sa dépendance.

`test:vm` exige 9,9 Mio d'artefacts tiers — émulateur, BIOS, image de guest — que `npm run vm:fetch`
télécharge depuis `registry.npmjs.org`, `raw.githubusercontent.com` et `i.copy.sh`. Rattacher la
suite au contrôle obligatoire rendrait toute PR dépendante de la disponibilité de trois hôtes
extérieurs, dont un qui ne publie pas d'empreinte de son côté. Un contrôle bloquant qui rougit parce
qu'un CDN tiers est indisponible n'apprend rien sur la PR.

Elle tourne donc dans un job CI dédié et **non bloquant** (`.github/workflows/vm.yml`), déclenché
manuellement et chaque nuit.

Depuis #6 elle porte aussi `tests/vm/opfs-persistence.spec.mjs`, donc une preuve de persistance
réelle du produit. La condition restante pour la rendre bloquante n'est plus la nature de la preuve
mais sa dépendance : tant que les artefacts viennent de trois hôtes tiers, un contrôle obligatoire
rougirait pour des raisons étrangères à la PR. La preuve de niveau navigateur du même backend, elle,
**est** bloquante — elle n'a besoin d'aucun artefact.

```sh
npm run vm:fetch     # récupère et vérifie les artefacts v86 (empreintes SHA-256)
npm run test:vm
npm run vm:protocol  # protocole de mesure complet sous Node, écrit reports/vm/protocole.json
```

`npm run vm:check` vérifie les empreintes sans réseau et échoue si un artefact manque ou diffère.
Les mesures de référence du spike sont figées dans
[`docs/spikes/0004-backend-de-blocs-v86.md`](spikes/0004-backend-de-blocs-v86.md).

### Application Rails de référence

`npm run app:test` exécute la suite Minitest d'`apps/reference/` dans une image Docker épinglée par
digest (`ruby:3.3.12-slim-bookworm`). Elle couvre le contrat d'invariant, le modèle porteur de
l'UUID, la commande `bin/vault-fixture` — exécutée comme un **processus**, avec ses vrais codes de
sortie —, les deux routes JSON, l'absence de secret et les pragmas de durabilité SQLite.

Deux précautions la rendent opposable :

- **les pragmas sont interrogés sur la connexion réelle**, pas relus dans `database.yml`. Une ligne
  de configuration non appliquée est indiscernable d'une ligne absente ;
- **la commande de fixture est lancée sans `bundle exec`** et sans hériter du `RUBYOPT` du processus
  de test, parce que c'est ainsi que la construction du disque l'appelle. La première construction a
  précisément échoué sur cette différence.

Ce que la suite **n'affirme pas** : le comportement sous i386. Son image est amd64, choisie pour que
la boucle de développement reste en minutes. La preuve i386 est le rôle de `test:vm:reference`, et
d'elle seule.

Elle n'est pas rattachée à `npm run check` : elle exige Docker, que `docs/development.md` ne pose
pas en prérequis du contrôle obligatoire. Elle est exécutée à chaque exécution du contrôle
`Image de référence`, déclenché par toute modification d'`apps/**` ou de la chaîne de construction.

### Boot réel de la VM : `test:vm:reference`

`npm run test:vm:reference` boote **réellement** l'image de référence sous v86, dans Node, sans
instantané, et interroge Rails par le port série. Elle vérifie que la route de santé annonce les
versions du manifeste et que `/vault/invariant` rend le verdict `conforming` avec le digest de pièce
jointe attendu.

Trois règles la gouvernent :

- **elle ne réussit jamais sans avoir booté.** Si le manifeste ou les artefacts sont absents, elle
  se déclare `skipped` avec la raison exacte et la commande à lancer ; elle ne rend jamais un succès
  qui n'a rien mesuré ;
- **un artefact présent mais différent du manifeste est un échec**, pas une indisponibilité : le
  manifeste est la référence versionnée, et booter autre chose que ce qu'il décrit ne prouverait
  rien ;
- **la mesure est publiée**, dans `reports/vm/reference-boot.json` (dossier ignoré par git, archivé
  en artefact de CI).

Elle **n'est pas** rattachée à `npm run check`, et ce n'est pas un compromis de confort : un boot à
froid dépasse les dix minutes, la suite exige Docker et environ un gigaoctet d'artefacts construits,
et `docs/quality-attributes.md` lui accorde explicitement un budget de 15 minutes au p95. La
rattacher ferait passer `npm run check` de deux minutes à plus d'un quart d'heure sur chaque PR, y
compris celles qui ne touchent ni l'application ni l'image.

Sa périodicité est donc la suivante : elle s'exécute à chaque modification de `apps/`, de
`tools/build-reference-image/`, de `tools/vm/` ou de `tests/vm/`, par le contrôle GitHub
`Image de référence`, qui construit l'image puis la boote. Ce contrôle n'est pas obligatoire pour la
protection de branche — sa durée le rendrait bloquant pour des PR qui ne le concernent pas — mais un
échec y est traité comme un échec de `npm run check`.

### Configuration du lint

`tests/unit/eslint-config.test.mjs` traite `eslint.config.mjs` comme un contrat testable. Il charge
la configuration réelle du dépôt via l'API `ESLint` et lint des sources témoins présentées sous des
chemins **virtuels** — aucun fichier n'est déposé dans l'arborescence — pour vérifier qu'un global
Node est refusé sous `public/` et `src/`, qu'un global DOM est refusé sous `tools/`, `tests/unit/`
et dans un module Worker, et que chaque contexte conserve les siens. La répartition attendue est
décrite dans [`docs/development.md`](development.md).

Cette suite est rattachée à `npm run test:unit`, donc à `npm run check` : son coût est de quelques
centaines de millisecondes et une régression de configuration doit bloquer une PR. `npm run lint`
seul ne le ferait pas, puisqu'un jeu de globals trop large ne produit aucun avertissement.

### Frontière d'origine

`tests/browser/origin-topology.spec.mjs` et `tests/browser/origin-isolation.spec.mjs` sont la preuve
de sécurité de `SEC-ORIGIN-001` (ADR 0002). Elles sont rattachées à `npm run check` plutôt que
périodiques : elles durent moins d'une minute, ne demandent aucune image VM, et une régression de
frontière doit bloquer une PR, pas être découverte à la recette suivante.

Elles exigent **deux serveurs**, donc deux origines réelles ; `playwright.config.mjs` les démarre
tous les deux. Trois précautions les rendent opposables :

- un **témoin positif** en même origine, qui exige que les mêmes tentatives aboutissent ;
- l'**arbitrage depuis la coquille** pour tout ce qui concerne la persistance et l'interception, car
  une sonde applicative ne sait pas dans quelle partition elle a écrit ;
- un troisième résultat `indisponible`, distinct de `bloque`, pour une capacité absente du moteur.

Leurs mesures sont **jointes** au rapport Playwright (`releve-…`, `navigation-…`, `isolation-…`,
`coep-…`), jamais imprimées sur la sortie standard : un relevé brut recopié à chaque `npm run check`
polluerait le journal de toutes les PR. Pour les consulter :

```sh
npx playwright test tests/browser/origin-topology.spec.mjs --reporter=html
npx playwright show-report
```

La CI n'archive le rapport qu'en cas d'échec, ce qui suffit à diagnostiquer une régression : les
mesures de référence du spike sont figées dans `docs/spikes/0035-topologie-origine-de-confiance.md`.

### Plusieurs moteurs

```sh
npx playwright install firefox webkit
npm run test:browser:moteurs -- chromium,firefox,webkit
```

Le script pose `VAULT_MOTEURS` sans dépendre de la syntaxe du shell. Les épreuves COOP/COEP mesurent
sur tout moteur mais n'assertent que sous Chromium : les écarts constatés sont consignés dans
`docs/spikes/0035-topologie-origine-de-confiance.md`, et la matrice de support reste l'objet de
l'issue #2. La commande reste manuelle : `npm run check` exécute la frontière d'origine sous
Chromium seulement, et la couverture multi-moteurs de la CI passe par `test:compat`.

## Suite de compatibilité

`npm run test:compat` exécute la sonde `src/compat/` dans une page servie par `tools/serve.mjs` puis
dans un Worker dédié de type module, sur les trois moteurs Playwright. Elle utilise une
configuration distincte, `playwright.compat.config.mjs`, pour trois raisons :

- elle vise trois moteurs alors que `test:browser` reste volontairement sur Chromium ;
- elle a besoin d'un serveur servi avec `--cross-origin-isolated`, condition nécessaire pour mesurer
  `SharedArrayBuffer` et `Atomics.wait` ; le harnais de base ne doit pas changer de conditions ;
- elle écrit ses artefacts ailleurs (`test-results/compat`) pour ne pas écraser ceux du harnais.

Son serveur écoute sur le port 4180 et n'est **jamais** réutilisé : un rapport de compatibilité doit
provenir de la page du dépôt, servie avec les en-têtes d'isolation attendus. Si le port est déjà
occupé, la suite échoue immédiatement au lieu de mesurer un serveur étranger.

Ce que la suite affirme :

- le rapport respecte le schéma de `src/compat/capability-contract.mjs`, validé par une fonction
  pure elle-même couverte par `tests/unit/compat-contract.test.mjs` ;
- chaque capacité déclarée reçoit un verdict et un détail non vide ;
- le verdict Vault du rapport est cohérent avec les verdicts de capacités.

Ce que la suite n'affirme pas : **la présence d'une capacité**. Une capacité absente, refusée ou en
erreur ne fait jamais échouer la suite ; elle est enregistrée telle quelle. Seuls un rapport
malformé, une sonde qui plante ou une erreur de page non capturée provoquent un échec.

Chaque exécution écrit `reports/compat/<moteur>.json` (dossier ignoré par git) et attache le même
contenu au rapport Playwright. La CI archive `reports/compat/` en artefact à chaque exécution.

La suite est rattachée à `npm run check` : son coût mesuré est d'environ 20 s. Depuis l'ajout de la
frontière d'origine, l'ensemble de `npm run check` tient en un peu plus d'une minute en local, sous
la limite de 2 min (86 s mesurées en CI le 2026-08-23). Elle exige que les trois moteurs soient
installés (voir `docs/development.md`).

## Preuve rouge

Pour une implémentation TDD, la PR indique :

- le commit contenant le test avant l'implémentation ;
- la commande exécutée ;
- l'échec attendu et sa cause ;
- le commit qui rend la même commande verte.

Il n'est pas demandé de pousser un état rouge sur `main`. Les PR de documentation, spikes et audits
utilisent leurs preuves propres.

## Données de test

Les tests emploient uniquement des données synthétiques, déterministes et versionnées. Les scénarios
de corruption conservent une graine de reproduction.

La pièce jointe de l'invariant, `apps/reference/invariant/invariant.bin`, est le seul binaire
versionné du dépôt. Elle n'est pas arbitraire : ses 4096 octets sont la concaténation de 128 blocs
de 32 octets, le bloc `i` valant `SHA-256("railsbox-vault-reference/invariant/" + i)`. La règle est
publiée dans `apps/reference/vault-invariant.json` et **réappliquée** par
`apps/reference/test/lib/contract_test.rb`, qui compare le résultat au fichier commité : un octet
modifié dans le dépôt fait échouer la suite, sans qu'il faille faire confiance à une empreinte
recopiée à la main.

## Navigateurs

Chromium reste le moteur du harnais `test:browser`. La matrice de support du produit est établie par
`test:compat` sur Chromium, Firefox et WebKit, et publiée dans
[`docs/compatibility.md`](compatibility.md) avec sa date, son système et ses versions. Le projet
`webkit` de Playwright ne constitue pas à lui seul une qualification Safari : cette limite est
expliquée dans la même page.
