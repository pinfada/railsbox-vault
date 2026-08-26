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
  trois moteurs. **Cela ne rend pas l'isolation obligatoire pour la distribution** : une version
  antérieure de cette page l'affirmait, sans mesure à l'appui. Le spike #41 a établi que personne
  n'utilise ces primitives — ni dans le dépôt, ni dans v86 épinglé, dont la mémoire WebAssembly
  n'est pas partagée — et l'[ADR 0010](decisions/0010-isolation-multi-origine.md) décide de ne pas
  poser l'isolation. La sonde continue de la poser parce qu'elle **mesure** ces primitives ; mesurer
  n'est pas dépendre.

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
  isolation. La question « la distribution doit-elle l'imposer ? » l'est par le spike #41 et
  l'[ADR 0010](decisions/0010-isolation-multi-origine.md) : **non plus**. L'écart d'héritage ne se
  réalise donc pas ; il reste à surveiller pour une capacité qui exigerait l'isolation.
- **portée de la politique d'intégration.** Sous `require-corp`, WebKit a refusé le module importé
  par le Worker runtime tant que ce module ne portait pas lui-même la politique. La sonde de
  capacités ne rencontre pas le problème parce que son serveur pose COOP/COEP sur **toutes** ses
  réponses. Les deux mesures disent la même chose : la politique doit être portée par chaque
  artefact du runtime, pas seulement par la page.

La ligne WebKit reste celle du moteur de test, jamais celle de Safari.

## Machine virtuelle v86

Mesures du spike #4, le **2026-08-23**, sur la même machine que les relevés précédents — sauf la
première ligne, remesurée le **2026-08-26** par #74 et repérée par ✱. Émulateur `v86@0.5.432`, guest
Linux 4 / Buildroot i386, runtime dans un Worker dédié de type module.

| Constat                                                              | Chromium 151 | Firefox 153 | WebKit 26.5 |
| -------------------------------------------------------------------- | :----------: | :---------: | :---------: |
| ✱ Guest démarre et écrit depuis un Worker, backend Vault             |     oui      |   **oui**   |   **oui**   |
| Fonctionne sans isolation multi-origine (`crossOriginIsolated` faux) |     oui      |      —      |      —      |
| `scheduler.postTask` disponible en page                              |     oui      |     oui     |   **non**   |
| Worker imbriqué `blob:` sous `worker-src 'self'`                     |    refusé    |   refusé    |   refusé    |
| `WebAssembly.instantiate` sous `script-src 'self'` seul              |    refusé    |   refusé    |   refusé    |
| `WebAssembly.instantiate` sous `'wasm-unsafe-eval'`                  |    admis     |    admis    |    admis    |

La première ligne a changé deux fois. Le spike #4 la laissait « non mesuré » pour Firefox et WebKit
; #52 l'a mesurée à **non** sur les deux, pour deux causes distinctes et étrangères l'une à l'autre
; **#74 la porte à oui sur les trois**, en fournissant la boucle d'ordonnancement de v86 au lieu de
la prendre du moteur. Le relevé est plus bas, § « Démarrage du runtime livré ». Les deux dernières
lignes viennent de `tests/browser/csp-frontiere.spec.mjs`, rattachée à `npm run check`.

**Cette ligne ne promeut aucun statut de la matrice des cibles.** Démarrer l'émulateur n'est pas
persister un volume : WebKit Playwright reste **refusé** parce qu'il n'expose pas OPFS, et Safari
reste **candidat** parce qu'il n'a jamais été mesuré.

Quatre conséquences pour la matrice produit :

- **La CSP de la coquille doit nommer WebAssembly.** Sous `script-src 'self'` seul, les **trois**
  moteurs refusent `WebAssembly.instantiate` — le spike #4 ne l'avait mesuré que sous Chromium. Le
  jeton `'wasm-unsafe-eval'` est admis par les trois ; il n'autorise ni `eval` ni `new Function`
  (ADR 0003, confirmé par l'ADR 0013).
- **v86 a besoin d'un ordonnanceur qui ne soit pas un Worker `blob:`.** Il choisit
  `scheduler.postTask` lorsque l'URL de son contexte contient `use-scheduling-api`, sinon un Worker
  imbriqué créé depuis une URL `blob:` — que `worker-src 'self'` refuse sur les trois moteurs. Ce
  refus ne lève **aucune exception** : le constructeur rend un objet inerte, et l'émulateur ne bat
  jamais. Il reste observable — événement `securitypolicyviolation` sur le document, événement
  `error` sur le Worker —, mais aucun de ces deux canaux n'interrompt l'appelant. Depuis #52, le
  Worker runtime le **dit** : `VAULT_RUNTIME_WORKER_REFUSED` en quelques secondes, avec la raison
  exacte du repli.
- **WebKit n'expose pas `scheduler.postTask`, et démarre quand même depuis #74.** Sous la CSP
  servie, v86 n'y avait aucune boucle d'ordonnancement : ni `postTask`, ni Worker imbriqué `blob:`.
  La boucle fournie par Vault comble l'absence, et le guest atteint son invite en **6,2 s**. Le
  statut de WebKit Playwright reste **refusé** pour une raison indépendante et déjà mesurée : OPFS
  absent.
- **Firefox démarre depuis #74, et la cause de son blocage est nommée.** C'était son implémentation
  **native** de `scheduler.postTask` qui monopolisait le thread du Worker dès que v86 démarrait —
  mesuré par l'[ADR 0013](decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md), qui a aussi montré
  que la CSP n'y était pour rien. La boucle de Vault la remplace, et le guest atteint son invite en
  **22,4 s**.
- **Les 22 s de Firefox sont la vitesse du moteur sur ce guest, pas un défaut de la boucle.** Le
  fait qui le montre est indépendant de notre code : sous une politique qui admet `blob:`, le Worker
  imbriqué **de v86** met le même temps — 21,8 s, reproduit à 21,6 s (ADR 0013). Deux boucles
  différentes, le même ordre de grandeur, six fois Chromium. Ce qui n'est **pas** mesuré, et qu'il
  ne faut donc pas déduire : la cause interne de cet écart dans le moteur. Aucune conclusion du
  dépôt n'en dépend.
- **`SharedArrayBuffer` n'est pas requis** pour démarrer et écrire. L'écart d'héritage de
  `cross-origin-isolated` relevé plus haut ne bloque donc pas le runtime.

### CSP et boucle d'ordonnancement, mesuré sur les trois moteurs

Mesures du **2026-08-26** (`npm run test:csp`). Deux serveurs servent le même contenu, leur CSP ne
diffère que par `worker-src`. Tableau complet et décision :
[ADR 0013](decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md).

| Configuration                                        |  Chromium 151   |     Firefox 153      |     WebKit 26.5     |
| ---------------------------------------------------- | :-------------: | :------------------: | :-----------------: |
| `worker-src 'self'` + `?use-scheduling-api` (servie) | invite en 3,5 s |  thread monopolisé   |     ne bat pas      |
| `worker-src 'self'` + boucle fournie par Vault       | invite en 3,6 s | **invite en 21,5 s** | **invite en 4,8 s** |
| `worker-src 'self' blob:` sans marqueur d'URL        | invite en 3,6 s | **invite en 21,8 s** | **invite en 5,2 s** |

La ligne du milieu est celle que l'ADR 0013 a retenue comme direction. Elle appartenait à #74, pas à
#52, parce qu'elle change le rythme de l'émulateur et se revalide par `npm run test:vm` et
`npm run test:e2e` — ce que la section suivante mesure.

### Démarrage du runtime livré, sur les trois moteurs (#74)

Mesures du **2026-08-26** par `npm run test:vm` (`tests/vm/boot-trois-moteurs.spec.mjs`), sous la
CSP servie et avec le **Worker runtime du produit**, contrôle préalable compris — non plus avec un
banc de mesure. Guest Linux 4 / Buildroot i386, volume de 16 Mio en mémoire, pont de durabilité
posé. Rapports bruts : `reports/vm/boot-trois-moteurs-<moteur>.json`.

| Moteur       | Invite du guest | Tours de boucle | Tours/s | Boucle en place    | Barrière acquittée |
| ------------ | --------------: | --------------: | ------: | ------------------ | :----------------: |
| Chromium 151 |        3 716 ms |           1 368 |     368 | `vault-sur-native` |        oui         |
| Firefox 153  |       22 415 ms |           2 047 |      91 | `vault-sur-native` |        oui         |
| WebKit 26.5  |        6 186 ms |           1 425 |     230 | `vault`            |        oui         |

Trois lectures, et une mise en garde :

- **v86 emprunte bien la boucle posée, et cela est observé, pas supposé.** Le nombre de tâches
  reçues par la boucle est égal, sur les trois moteurs, au compteur de tours de v86 (1 368, 2 047,
  1 425) : chaque tour de l'émulateur est une tâche que Vault a ordonnancée. Une boucle posée mais
  jamais empruntée — l'URL du Worker perdant son marqueur `use-scheduling-api` — se lirait comme
  zéro tâche pour un compteur qui avance ;
- **`vault` contre `vault-sur-native`** dit ce que la boucle a remplacé : une absence sous WebKit,
  l'implémentation du moteur sous Chromium et Firefox. C'est la décision « toujours posée » de l'ADR
  0013 § « Mise en œuvre par #74 ». Conséquence à connaître : **dans un Worker runtime de Vault,
  WebKit expose désormais un `scheduler`** — partiel, `{ postTask }` — là où il n'en exposait aucun.
  Du code qui déduirait des capacités de sa seule présence se tromperait (suivi : #87) ;
- **la boucle affame les minuteries sur un moteur.** Pendant qu'elle enchaîne les tours, WebKit
  n'exécute aucun `setInterval` ni `setTimeout` du Worker — mesuré, table ci-dessous. Les gardes du
  runtime se cadencent donc aussi sur les battements de la boucle ;
- **la barrière durable traverse le backend sur les trois moteurs**, dans l'ordre écriture → flush →
  acquittement. C'est le scénario `barrier` du spike #4, rejoué ici moteur par moteur ;
- **les tours par seconde ne mesurent PAS la vitesse d'émulation.** Un tour ne représente pas la
  même quantité de travail d'une boucle à l'autre : v86 choisit le délai de son prochain tour selon
  ce qu'il lui reste à faire. Sous Chromium, la boucle du moteur produisait 2 144 tours en 3 943 ms
  (544 tours/s) là où celle de Vault en produit 1 368 en 3 716 ms (368 tours/s) — **moins de tours,
  un boot légèrement plus court**. La grandeur comparable reste la durée ; les tours servent à
  distinguer « bat » de « ne bat pas », ce pour quoi ils ont été introduits.

### Ce que la boucle de Vault affame, et ce qu'elle laisse passer (#74)

Mesures du **2026-08-26** par `tests/browser/ordonnancement-famine.spec.mjs`, rattachée à
`npm run check` sur les trois moteurs (six secondes, aucun artefact v86). Une boucle serrée
`postTask({ delay: 0 })` auto-réamorcée tourne pendant cinq secondes, et l'on compte ce qui
traverse.

| Moteur       | Tâches en 5 s | `setInterval` 250 ms | `setTimeout` 500 ms | Messages de la page | Échéance cadencée par la boucle |
| ------------ | ------------: | -------------------: | ------------------- | ------------------: | ------------------------------: |
| Chromium 151 |     1 120 303 |                19/20 | tiré                |                 5/5 |                        1 250 ms |
| Firefox 153  |       594 263 |                19/20 | tiré                |                 5/5 |                        1 000 ms |
| WebKit 26.5  |        61 650 |             **0/20** | **jamais tiré**     |                 5/5 |                        1 000 ms |

Trois conséquences :

- **le port traverse partout.** Une coquille peut parler à un Worker occupé, sur les trois moteurs ;
- **les minuteries, non.** Sous WebKit, la priorité stricte donnée aux messages de port prive le
  Worker de ses minuteries tant que la boucle dure. Une garde posée sur `setTimeout` n'expirerait
  donc pas pendant la plage qu'elle borne — celle où v86 tourne à plein ;
- **une échéance cadencée par la boucle expire partout.** C'est ce dont dépendent, depuis #74, le
  chien de garde du premier tour et les délais de garde des sessions de guest.

Le protocole et les mesures complètes sont dans
[`docs/spikes/0004-backend-de-blocs-v86.md`](spikes/0004-backend-de-blocs-v86.md).

## Isolation multi-origine

Mesures du spike #41, le **2026-08-25**, sur la même machine. La même page et le même Worker runtime
sont servis par deux serveurs dont le seul écart est COOP/COEP, les essais étant entrelacés.

| Constat                                                          | Chromium 151 |  Firefox 153  |  WebKit 26.5  |
| ---------------------------------------------------------------- | :----------: | :-----------: | :-----------: |
| Isolation obtenue en page sous COOP/COEP                         |     oui      |      oui      |      oui      |
| Isolation obtenue dans le Worker sous COOP/COEP                  |     oui      |      oui      |      oui      |
| `SharedArrayBuffer` alloué dans le Worker isolé                  |     oui      |      oui      |      oui      |
| Guest démarre, écrit et franchit sa barrière **sans** isolation  |   **oui**    | non mesurable | non mesurable |
| Guest démarre, écrit et franchit sa barrière **avec** isolation  |   **oui**    | non mesurable | non mesurable |
| `measureUserAgentSpecificMemory` utilisable dans le Worker isolé |   **non**    |  non mesurée  |  non mesurée  |

Coût mesuré sous Chromium, quatre essais entrelacés par condition : **+0,6 %** sur le premier boot
(3 600 ms contre 3 621 ms) et **−0,5 %** sur le temps processeur du rendu. Les écarts par étape du
guest sont sous la résolution de l'instrument, qui scrute la console série toutes les 20 ms.

Les deux moteurs non mesurables le sont pour des raisons **étrangères** à l'isolation, et identiques
dans les deux conditions :

- **WebKit** n'expose pas `scheduler.postTask` : sous `worker-src 'self'`, v86 n'a aucune boucle
  d'ordonnancement (voir plus haut). #52 a tranché la question de CSP qu'il posait — la politique
  n'est pas élargie — et mesuré qu'une boucle fournie par Vault suffirait (ADR 0013) ;
- **Firefox** charge le Worker, l'isole et alloue un `SharedArrayBuffer` — puis son thread cesse
  entièrement de rendre la main dès que v86 démarre. Le pouls émis toutes les 250 ms par le Worker
  n'a produit **aucun battement en 180 s**, avec comme sans isolation. La case « non mesuré » de la
  ligne v86 ci-dessus a donc désormais un diagnostic.

Ces deux cases restent « non mesurable » **après #74**, et c'est délibéré : elles décrivent le
harnais du spike #41 (`npm run test:isolation`), dont le Worker est un banc propre à ce spike et ne
pose pas la boucle de Vault. L'empêchement qu'elles nomment a disparu du **produit** — le § «
Démarrage du runtime livré » le mesure sur les trois moteurs —, mais tant que ce harnais-là n'a pas
été réexécuté, écrire autre chose ici serait une déduction et non une mesure. Rejouer le coût de
l'isolation sur Firefox et WebKit est désormais possible ; ce n'est pas fait.

Le protocole complet est dans
[`docs/spikes/0041-isolation-coop-coep.md`](spikes/0041-isolation-coop-coep.md), la décision dans
l'[ADR 0010](decisions/0010-isolation-multi-origine.md).

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
