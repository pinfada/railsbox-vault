# Stratégie de test

## Suites disponibles

| Commande                       | Portée                                                        |                     Coût attendu |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------: |
| `npm run test:unit`            | contrats, logique pure et configuration du lint sous Node     |                         secondes |
| `npm run test:browser`         | vraie page, Worker dédié et frontière d'origine sous Chromium |                    environ 1 min |
| `npm run test:spike:origin`    | les deux suites de frontière d'origine seules                 |                    environ 1 min |
| `npm run test:browser:moteurs` | la suite navigateur sur plusieurs moteurs                     |                    environ 2 min |
| `npm run test:compat`          | sonde de capacités sous Chromium, Firefox et WebKit           |  environ 20 s après installation |
| `npm run test:vm`              | guest Linux réel écrivant sur le backend de blocs (Chromium)  |    environ 1 min, **périodique** |
| `npm test`                     | suites unitaire et navigateur                                 |                         secondes |
| `npm run check`                | lint, format et toutes les suites actuelles                   | moins de 2 min hors installation |

Les suites `test:e2e` et `test:resilience` seront ajoutées lorsqu'elles posséderont un premier
scénario réel. Un script vide qui réussit ne constitue pas une preuve.

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
manuellement et chaque nuit. Elle deviendra bloquante lorsque le backend OPFS de production (#6) en
fera une preuve de durabilité du produit et que les artefacts seront servis depuis une source que le
projet maîtrise.

```sh
npm run vm:fetch     # récupère et vérifie les artefacts v86 (empreintes SHA-256)
npm run test:vm
npm run vm:protocol  # protocole de mesure complet sous Node, écrit reports/vm/protocole.json
```

`npm run vm:check` vérifie les empreintes sans réseau et échoue si un artefact manque ou diffère.
Les mesures de référence du spike sont figées dans
[`docs/spikes/0004-backend-de-blocs-v86.md`](spikes/0004-backend-de-blocs-v86.md).

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

## Navigateurs

Chromium reste le moteur du harnais `test:browser`. La matrice de support du produit est établie par
`test:compat` sur Chromium, Firefox et WebKit, et publiée dans
[`docs/compatibility.md`](compatibility.md) avec sa date, son système et ses versions. Le projet
`webkit` de Playwright ne constitue pas à lui seul une qualification Safari : cette limite est
expliquée dans la même page.
