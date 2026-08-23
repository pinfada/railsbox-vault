# Stratégie de test

## Suites disponibles

| Commande               | Portée                                              |                     Coût attendu |
| ---------------------- | --------------------------------------------------- | -------------------------------: |
| `npm run test:unit`    | contrats et logique pure sous Node                  |                         secondes |
| `npm run test:browser` | vraie page et Worker dédié sous Chromium            |                         secondes |
| `npm run test:compat`  | sonde de capacités sous Chromium, Firefox et WebKit |  environ 20 s après installation |
| `npm test`             | suites unitaire et navigateur                       |                         secondes |
| `npm run check`        | lint, format et toutes les suites actuelles         | moins de 2 min hors installation |

Les suites `test:vm`, `test:e2e`, `test:resilience` et `test:security` seront ajoutées lorsqu'elles
posséderont un premier scénario réel. Un script vide qui réussit ne constitue pas une preuve.

## Suite de compatibilité

`npm run test:compat` exécute la sonde `src/compat/` dans une page servie par `tools/serve.mjs` puis
dans un Worker dédié de type module, sur les trois moteurs Playwright. Elle utilise une
configuration distincte, `playwright.compat.config.mjs`, pour trois raisons :

- elle vise trois moteurs alors que `test:browser` reste volontairement sur Chromium ;
- elle a besoin d'un serveur servi avec `--cross-origin-isolated`, condition nécessaire pour mesurer
  `SharedArrayBuffer` et `Atomics.wait` ; le harnais de base ne doit pas changer de conditions ;
- elle écrit ses artefacts ailleurs (`test-results/compat`) pour ne pas écraser ceux du harnais.

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

La suite est rattachée à `npm run check` : son coût mesuré est d'environ 20 s, et l'ensemble de
`npm run check` reste sous 30 s en local, donc bien sous la limite de 2 min. Elle exige que les
trois moteurs soient installés (voir `docs/development.md`).

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
