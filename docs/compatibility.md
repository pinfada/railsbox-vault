# Politique de compatibilité

## Statuts

- **candidat** — prévu, non encore démontré ;
- **mesuré** — capacités unitaires vérifiées ;
- **supporté** — scénario E2E publié et maintenu en CI ou recette périodique ;
- **refusé** — détection préalable et diagnostic stable ;
- **expérimental** — fonctionne sans engagement de migration ni de support.

## Matrice des cibles

| Cible                 | Statut                      | Condition de promotion                          |
| --------------------- | --------------------------- | ----------------------------------------------- |
| Chromium ordinateur   | mesuré                      | scénario bout en bout du jalon 1                |
| Firefox ordinateur    | mesuré                      | scénario bout en bout du jalon 1                |
| WebKit Playwright     | refusé (OPFS absent)        | build WebKit exposant `navigator.storage`       |
| Safari ordinateur     | candidat                    | sonde exécutée sur un vrai Safari, puis jalon 1 |
| Navigateurs mobiles   | expérimental                | budgets mémoire, cycle Worker et récupération   |
| Node 22               | supporté pour développement | contrôle obligatoire `Qualité et tests`         |
| PostgreSQL dans la VM | candidat                    | persistance #7 et image de référence dédiée     |
| SQLite dans la VM     | mesuré                      | scénario bout en bout du jalon 1                |

La frontière d'origine décidée par l'ADR 0002 a été mesurée séparément sur les trois mêmes moteurs
et n'y change aucun statut : elle tient partout. Voir « Frontière d'origine » plus bas.

Le backend de blocs OPFS de #6 a été exécuté sur les trois moteurs le **2026-08-23** et confirme
cette matrice sans la modifier. `tests/browser/opfs-block-backend.spec.mjs` n'interroge pas
seulement `typeof` : il OUVRE réellement un handle exclusif depuis un Worker dédié.

| Moteur       | Handle exclusif dans le Worker | Sonde de persistance complète       |
| ------------ | ------------------------------ | ----------------------------------- |
| Chromium 151 | ouvert                         | exécutée, empreinte de volume juste |
| Firefox 153  | ouvert                         | exécutée, même empreinte            |
| WebKit 26.5  | refusé                         | `VAULT_STORAGE_UNSUPPORTED`         |

Le refus de WebKit est **asserté**, pas ignoré : la suite exige le code typé. Un plantage non typé,
ou un succès inattendu, la ferait échouer. Le statut « refusé (OPFS absent) » de WebKit Playwright
est donc désormais adossé à une tentative réelle d'ouverture, et non seulement à la sonde de
capacités.

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

| Élément    | Valeur                                                       |
| ---------- | ------------------------------------------------------------ |
| Système    | Windows 11 Home, `win32` 10.0.26200                          |
| Node       | v24.14.0 en local, version de `.node-version` en CI          |
| Playwright | 1.62.1                                                       |
| Moteurs    | Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5           |
| Serveur    | `node tools/serve.mjs --cross-origin-isolated` (COOP/COEP)   |
| Contexte   | `isSecureContext` vrai et `crossOriginIsolated` vrai partout |

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
| `PublicKeyCredential` exposé                    | page     | non         | supported | supported   | supported   |
| `isUserVerifyingPlatformAuthenticatorAvailable` | page     | non         | supported | supported   | supported   |
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
- **WebAuthn présent dans les trois moteurs, y compris WebKit.** Attention au piège de détection :
  WebKit expose `PublicKeyCredential` comme un **objet**, pas comme une fonction. Tester
  `typeof === "function"` publie un faux négatif. La sonde accepte donc une fonction ou un objet non
  nul pour un objet d'interface, et réserve `typeof === "function"` aux méthodes, qui doivent être
  appelables. Voir `src/compat/host-api.mjs`.
- **Toutes les mesures sont prises en contexte sécurisé et isolé.** `agent.isSecureContext` et
  `agent.crossOriginIsolated` figurent dans chaque rapport. C'est ce qui permet d'affirmer que
  l'absence de `navigator.storage` sous WebKit est bien une absence d'API, et non la conséquence
  d'un contexte non sécurisé.
- **SharedArrayBuffer et `Atomics.wait` disponibles partout, mais seulement en contexte isolé.** La
  sonde sert la page avec `Cross-Origin-Opener-Policy: same-origin` et
  `Cross-Origin-Embedder-Policy: require-corp`. Sans ces en-têtes, `SharedArrayBuffer` disparaît des
  trois moteurs. La distribution de Vault devra donc imposer cette isolation.

## WebKit Playwright n'est pas une qualification Safari

**Le projet `webkit` de Playwright ne qualifie pas Safari.** C'est un build WebKit dédié aux tests,
compilé pour la plateforme hôte, dont la surface d'API diffère de celle du Safari livré par Apple.
La mesure du 2026-08-23 le montre directement : le build WebKit Playwright n'expose pas
`navigator.storage`, donc ni OPFS, ni `FileSystemSyncAccessHandle`, ni `estimate()`, alors que
Safari de bureau les fournit depuis plusieurs versions. L'absence est bien celle de l'API et non
celle d'un contexte sécurisé : `agent.isSecureContext` vaut `true` dans le rapport WebKit.

Ce n'est pas non plus un accident de plateforme : la CI Linux (`ubuntu-latest`, noyau 6.17, Node 22)
produit exactement les mêmes verdicts que la machine Windows de développement, pour les trois
moteurs.

`PublicKeyCredential`, en revanche, **est** exposé par WebKit Playwright — comme un objet et non
comme une fonction. Une première version de cette page l'annonçait absent : c'était un défaut de
détection de la sonde, corrigé depuis, et non une limite du moteur.

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
artefact de CI à chaque exécution, réussie ou non, sous le nom `rapports-compatibilite`. Les
verdicts ci-dessus ont été reproduits à l'identique par cet artefact sous `ubuntu-latest` et
Node 22. La fixture versionnée `tests/fixtures/compat/reference-report.json` sert uniquement de
rapport de référence pour valider le schéma ; elle n'engage aucun verdict, comme l'explique
`tests/fixtures/compat/README.md`.

## Frontière d'origine

Mesures produites par `npm run test:browser:moteurs -- chromium,firefox,webkit` le **2026-08-23**,
sur les mêmes moteurs et la même machine que la sonde de capacités. Le protocole complet est dans
`docs/spikes/0035-topologie-origine-de-confiance.md`.

| Constat                                                             | Chromium |       Firefox        |        WebKit         |
| ------------------------------------------------------------------- | :------: | :------------------: | :-------------------: |
| Origine distincte : les onze tentatives visant la coquille échouent |   oui    |         oui          |          oui          |
| Même origine sans sandbox : les mêmes tentatives aboutissent        |   oui    |         oui          | oui, hors sondes OPFS |
| CSP `frame-src` observable par `securitypolicyviolation`            |   oui    |         oui          |          oui          |
| Iframe inter-origine sans COEP refusée sous `require-corp`          |   oui    | oui, non instrumenté |          oui          |
| Iframe inter-origine avec COEP : hérite de l'isolation              | **non**  |   cadre non chargé   |        **oui**        |

Deux écarts méritent attention pour la suite :

- **héritage de `cross-origin-isolated` par l'iframe applicative.** Chromium le refuse — la
  fonctionnalité est pilotée par permission, liste par défaut `self` — ce qui prive utilement le
  code applicatif de `SharedArrayBuffer` ; WebKit l'accorde. La question « l'isolation est-elle
  obligatoire pour v86 ? » est tranchée par le spike #4 : **non**, le guest démarre et écrit sans
  isolation. L'écart reste à surveiller pour une capacité qui l'exigerait, pas pour le runtime.
- **portée de la politique d'intégration.** Sous `require-corp`, WebKit a refusé le module importé
  par le Worker runtime tant que ce module ne portait pas lui-même la politique. La sonde de
  capacités ne rencontre pas le problème parce que son serveur pose COOP/COEP sur **toutes** ses
  réponses. Les deux mesures disent la même chose : la politique doit être portée par chaque
  artefact du runtime, pas seulement par la page.

La ligne WebKit reste celle du moteur de test, jamais celle de Safari.

## Machine virtuelle v86

Mesures du spike #4, le **2026-08-23**, sur la même machine que les relevés précédents. Émulateur
`v86@0.5.432`, guest Linux 4 / Buildroot i386, runtime dans un Worker dédié de type module.

| Constat                                                              | Chromium 151 |   Firefox 153   | WebKit 26.5 |
| -------------------------------------------------------------------- | :----------: | :-------------: | :---------: |
| Guest démarre et écrit depuis un Worker, backend Vault               |     oui      | non mesuré (#4) | non mesuré  |
| Fonctionne sans isolation multi-origine (`crossOriginIsolated` faux) |     oui      |        —        |      —      |
| `scheduler.postTask` disponible en page                              |     oui      |       oui       |   **non**   |
| Worker imbriqué `blob:` sous `worker-src 'self'`                     |    refusé    |     refusé      |   refusé    |

Trois conséquences pour la matrice produit :

- **La CSP de la coquille doit nommer WebAssembly.** Sous `script-src 'self'` seul, Chromium refuse
  `WebAssembly.instantiate`. Le jeton `'wasm-unsafe-eval'` est ajouté ; il n'autorise ni `eval` ni
  `new Function` (ADR 0003).
- **v86 a besoin d'un ordonnanceur qui ne soit pas un Worker `blob:`.** Il choisit
  `scheduler.postTask` lorsque l'URL de son contexte contient `use-scheduling-api`, sinon un Worker
  imbriqué créé depuis une URL `blob:` — que `worker-src 'self'` refuse sur les trois moteurs.
  L'échec est silencieux côté page : l'émulateur ne bat simplement jamais. WebKit n'exposant pas
  `scheduler.postTask`, un support Safari exigerait soit `worker-src blob:` dans la CSP de la
  coquille, soit une boucle d'ordonnancement fournie par nous.
- **`SharedArrayBuffer` n'est pas requis** pour démarrer et écrire. L'écart d'héritage de
  `cross-origin-isolated` relevé plus haut ne bloque donc pas le runtime.

Le protocole et les mesures complètes sont dans
[`docs/spikes/0004-backend-de-blocs-v86.md`](spikes/0004-backend-de-blocs-v86.md).

## Base de données dans la VM

L'**ADR 0004** est la décision de priorité que la ligne « SQLite dans la VM » attendait : la fixture
de l'invariant durable (#5) utilise SQLite, avec `journal_mode = delete` et `synchronous = full`
déclarés et vérifiés sur la connexion. PostgreSQL n'est pas écarté ; il n'entre pas dans cette
fixture, et sa promotion dépend désormais de #7 et d'une image de référence qui lui soit propre.

Le passage de SQLite à **mesuré** repose sur un fait vérifiable et rien d'autre :
`npm run test:vm:reference` boote l'image de référence à froid, sans instantané, et obtient de
`/vault/invariant` un verdict `conforming` dont le digest de pièce jointe est celui du manifeste.
Comme partout dans ce document, **mesuré** ne veut pas dire supporté : le statut **supporté** exige
le scénario bout en bout du jalon 1, qui couvre fermeture, reprise, export et restauration — aucun
de ces quatre parcours n'est exercé ici.

Ce qui n'est **pas** mesuré, et qu'il ne faut pas déduire de cette ligne :

- la durabilité après coupure réelle. `synchronous = full` est vérifié, l'injection de coupures est
  l'objet de #7 ;
- le comportement de PostgreSQL sous i386, jamais exécuté dans ce dépôt ;
- la tenue de SQLite au-dessus du backend de blocs OPFS, qui n'existe pas encore (#4, #6) : le test
  VM utilise le disque en mémoire de v86.

## Applications Rails

Vault ne promet pas encore la compatibilité universelle de RailsBox Live. Une application devient
supportée lorsqu'elle fournit :

- un build reproductible et sans secret ;
- un identifiant et une version immuables ;
- une politique de migration de son volume ;
- une recette E2E de création, fermeture, reprise, export et restauration ;
- un diagnostic des dépendances réseau ou système incompatibles.
