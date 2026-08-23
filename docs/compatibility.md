# Politique de compatibilité

## Statuts

- **candidat** — prévu, non encore démontré ;
- **mesuré** — capacités unitaires vérifiées ;
- **supporté** — scénario E2E publié et maintenu en CI ou recette périodique ;
- **refusé** — détection préalable et diagnostic stable ;
- **expérimental** — fonctionne sans engagement de migration ni de support.

## Matrice des cibles

| Cible                 | Statut                      | Condition de promotion                                    |
| --------------------- | --------------------------- | --------------------------------------------------------- |
| Chromium ordinateur   | mesuré                      | scénario bout en bout du jalon 1                          |
| Firefox ordinateur    | mesuré                      | scénario bout en bout du jalon 1                          |
| WebKit Playwright     | refusé (OPFS absent)        | build WebKit exposant `navigator.storage`                 |
| Safari ordinateur     | candidat                    | sonde exécutée sur un vrai Safari, puis jalon 1           |
| Navigateurs mobiles   | expérimental                | budgets mémoire, cycle Worker et récupération             |
| Node 22               | supporté pour développement | contrôle obligatoire `Qualité et tests`                   |
| PostgreSQL dans la VM | candidat                    | fixture #5 et persistance #7                              |
| SQLite dans la VM     | candidat                    | fixture dédiée après preuve PostgreSQL ou ADR de priorité |

La détection porte sur les capacités effectives, pas seulement sur un numéro de navigateur. Une
extension optionnelle comme WebAuthn PRF doit confirmer son résultat à l'enregistrement et au
déverrouillage.

## Primitive disponible n'est pas parcours supporté

La sonde `src/compat/` mesure des **primitives**. Elle ne conclut jamais qu'un parcours Vault
fonctionne. La règle appliquée, implémentée par `computeVaultVerdict` et couverte par
`tests/unit/compat-contract.test.mjs`, est la suivante :

- toutes les capacités **obligatoires** valent `supported` → statut **mesuré** ;
- une capacité obligatoire vaut `unsupported` ou `denied` → statut **refusé** ;
- une capacité obligatoire vaut `error` ou manque au rapport → statut **candidat**, la mesure n'est
  pas concluante ;
- le statut **supporté** n'est jamais produit par la sonde : il exige le scénario bout en bout du
  jalon 1.

Les capacités facultatives sont mesurées pour information et n'entrent pas dans ce calcul.

## Matrice de capacités mesurée

Mesures produites par `npm run test:compat` le **2026-08-23**.

| Élément    | Valeur                                                     |
| ---------- | ---------------------------------------------------------- |
| Système    | Windows 11 Home, `win32` 10.0.26200                        |
| Node       | v24.14.0 en local, version de `.node-version` en CI        |
| Playwright | 1.62.1                                                     |
| Moteurs    | Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5         |
| Serveur    | `node tools/serve.mjs --cross-origin-isolated` (COOP/COEP) |

| Capacité                                        | Contexte | Obligatoire | Chromium  | Firefox     | WebKit      |
| ----------------------------------------------- | -------- | ----------- | --------- | ----------- | ----------- |
| Worker dédié de type module                     | page     | oui         | supported | supported   | supported   |
| WebCrypto AES-GCM sur vecteur connu             | page     | oui         | supported | supported   | supported   |
| WebCrypto HKDF-SHA-256 sur vecteur RFC 5869     | page     | oui         | supported | supported   | supported   |
| OPFS : `navigator.storage.getDirectory()`       | page     | oui         | supported | supported   | unsupported |
| `navigator.storage.estimate()`                  | page     | oui         | supported | supported   | unsupported |
| `navigator.storage.persist()` / `persisted()`   | page     | non         | denied    | denied      | unsupported |
| WebAssembly : instanciation d'un module minimal | page     | oui         | supported | supported   | supported   |
| SharedArrayBuffer                               | page     | non         | supported | supported   | supported   |
| Contexte isolé multi-origine                    | page     | non         | supported | supported   | supported   |
| BroadcastChannel                                | page     | oui         | supported | supported   | supported   |
| Web Locks (`navigator.locks`)                   | page     | oui         | supported | supported   | supported   |
| `PublicKeyCredential` exposé                    | page     | non         | supported | supported   | unsupported |
| `isUserVerifyingPlatformAuthenticatorAvailable` | page     | non         | supported | supported   | unsupported |
| `performance.memory` (spécifique Chromium)      | page     | non         | supported | unsupported | unsupported |
| WebCrypto AES-GCM dans le Worker                | worker   | oui         | supported | supported   | supported   |
| `FileSystemSyncAccessHandle` dans le Worker     | worker   | oui         | supported | supported   | unsupported |
| `Atomics.wait` dans le Worker                   | worker   | non         | supported | supported   | supported   |

Verdicts Vault correspondants :

| Moteur   | Verdict | Capacités obligatoires bloquantes                             |
| -------- | ------- | ------------------------------------------------------------- |
| Chromium | mesuré  | aucune                                                        |
| Firefox  | mesuré  | aucune                                                        |
| WebKit   | refusé  | `opfsGetDirectory`, `storageEstimate`, `opfsSyncAccessHandle` |

### Lecture des verdicts notables

- **`storagePersist` refusé sous Chromium et Firefox.** Chromium renvoie `false` sans interaction ;
  Firefox laisse la promesse en attente derrière une invite. Les deux sont des refus documentés, pas
  des erreurs de sonde. La capacité reste facultative : Vault doit fonctionner sans persistance
  accordée et savoir la demander plus tard.
- **`performance.memory` absent hors Chromium.** Verdict `unsupported`, sans erreur : l'API est une
  extension propriétaire et ne peut pas servir de base à un budget mémoire portable.
- **SharedArrayBuffer et `Atomics.wait` disponibles partout, mais seulement en contexte isolé.** La
  sonde sert la page avec `Cross-Origin-Opener-Policy: same-origin` et
  `Cross-Origin-Embedder-Policy: require-corp`. Sans ces en-têtes, `SharedArrayBuffer` disparaît des
  trois moteurs. La distribution de Vault devra donc imposer cette isolation.

## WebKit Playwright n'est pas une qualification Safari

**Le projet `webkit` de Playwright ne qualifie pas Safari.** C'est un build WebKit dédié aux tests,
compilé pour la plateforme hôte, dont la surface d'API diffère de celle du Safari livré par Apple.
La mesure du 2026-08-23 le montre directement : le build WebKit Playwright sous Windows n'expose ni
`navigator.storage` ni `PublicKeyCredential`, alors que Safari de bureau fournit OPFS,
`FileSystemSyncAccessHandle` et WebAuthn depuis plusieurs versions.

Conséquences retenues :

- la ligne « WebKit Playwright » de la matrice décrit **le moteur de test**, pas le produit Safari ;
- Safari reste **candidat** tant que la sonde n'a pas été exécutée sur un vrai Safari macOS ou iOS ;
- un verdict `refusé` sous WebKit Playwright n'autorise aucune annonce publique sur Safari, dans un
  sens comme dans l'autre.

## Reproduire les mesures

```sh
npm ci
npx playwright install chromium firefox webkit
npm run test:compat
```

Chaque exécution écrit `reports/compat/<moteur>.json`. Ce dossier est ignoré par git et archivé en
artefact de CI à chaque exécution, réussie ou non. La fixture versionnée
`tests/fixtures/compat/reference-report.json` sert uniquement de rapport de référence pour valider
le schéma ; elle n'engage aucun verdict, comme l'explique `tests/fixtures/compat/README.md`.

## Applications Rails

Vault ne promet pas encore la compatibilité universelle de RailsBox Live. Une application devient
supportée lorsqu'elle fournit :

- un build reproductible et sans secret ;
- un identifiant et une version immuables ;
- une politique de migration de son volume ;
- une recette E2E de création, fermeture, reprise, export et restauration ;
- un diagnostic des dépendances réseau ou système incompatibles.
