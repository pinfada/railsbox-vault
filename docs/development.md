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

| Contexte           | Fichiers concernés                                                                                                          | Globals accordés    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Page               | `public/**`, `src/**/page-*.mjs`                                                                                            | navigateur          |
| Worker dédié       | `public/**/*worker*.mjs`, `src/**/*worker*.mjs`                                                                             | Worker              |
| Service Worker     | `public/**/*-sw.mjs`                                                                                                        | Service Worker      |
| Module partagé     | le reste de `src/**`                                                                                                        | navigateur ∩ Worker |
| Node               | `tools/**`, `tests/unit/**`, `tests/vm/**/*.test.mjs`, `*.config.mjs`                                                       | Node                |
| Spécification Node | `tests/browser/**`, `tests/compat/**`, `tests/vm/**/*.spec.mjs`, `tests/e2e/**/*.spec.mjs`, `tests/isolation/**/*.spec.mjs` | Node et navigateur  |

Trois conséquences pour un nouveau module :

- un module de `src/` est **partagé par défaut** : il ne reçoit que les globals communs à la page et
  au Worker. S'il est réservé à la page, son nom commence par `page-` ; s'il est chargé par un
  Worker, son nom contient `worker` ;
- les spécifications Playwright cumulent Node et navigateur parce que les rappels passés à
  `page.evaluate` sont analysés dans le même fichier que le corps du test. Cette exception est
  bornée à `tests/browser/`, `tests/compat/`, `tests/vm/` et `tests/e2e/` ; elle ne doit pas être
  élargie par des commentaires `/* global */`, qui reviendraient à désactiver la règle. Elle couvre
  aussi `tests/isolation/`, ajoutée par le spike #41 ;
- un module réellement partagé entre la page et le Worker doit **vivre sous `src/`** pour recevoir
  l'intersection, y compris s'il n'existe que pour un spike. Il est alors importé par son chemin
  absolu `/src/…`, que le serveur de test sert sous sa propre racine.
  `src/spike/isolation-probe.mjs`, chargé par la coquille du spike #35, par son Worker runtime et
  par le document applicatif, en est l'exemple ; `src/spike/mesure-memoire.mjs`, chargé par la page
  du banc #41 comme par son Worker, en est un second.

`tests/unit/eslint-config.test.mjs` vérifie cette répartition en lintant des chemins virtuels : une
régression de la configuration fait échouer `npm run test:unit`, pas seulement le lint du jour. Une
épreuve y vise en outre un module réel, `isolation-probe.mjs`, et échoue s'il est rangé sous une
racine qui lui accorderait plus que l'intersection.

## Taille des unités

Le dépôt borne ses fichiers à **800 lignes** et ses fonctions à **50 lignes**. Les deux plafonds
sont mesurés ; aucun ne repose plus sur la vigilance d'une revue.

### Fichiers

`tests/unit/taille-des-fichiers.test.mjs` mesure tout `src/` et `public/vm/`, en comptant les lignes
comme `wc -l` les compte. Il oppose **deux** seuils, et il en faut deux :

- **800 lignes — plafond**, sans exception ni liste : un fichier qui l'atteint se scinde ;
- **700 lignes — alerte** : un fichier au-delà est inscrit dans `SOUS_SURVEILLANCE` avec sa taille
  relevée et la raison pour laquelle il n'est pas encore scindé. L'inscription est un cliquet.

Un plafond seul se découvre trop tard — le jour où il refuse, c'est au milieu de la tranche qui
avait besoin de place. #93 a trouvé trois fichiers à 789, 791 et 798 lignes : la convention n'avait
pas été violée, elle avait été **atteinte**, ce qui revient au même à l'évolution suivante. Ils sont
scindés, et `SOUS_SURVEILLANCE` est vide.

### Fonctions

Le plafond des fonctions est mesuré par `tests/unit/taille-des-fonctions.test.mjs`, sur tout `src/`
et `public/vm/`. Il applique `max-lines-per-function` d'ESLint **en surcharge** de
`eslint.config.mjs`, sans l'y activer : une règle activée dans la configuration ne se tairait qu'au
prix d'un `eslint-disable` par dépassement, donc d'une justification éparpillée. La liste des
exceptions vit dans l'épreuve, où elle se lit d'un bloc.

Les lignes se comptent comme la règle les compte : commentaires et lignes vides compris, de
l'accolade ouvrante à l'accolade fermante.

Un dépassement se traite de trois façons, et d'aucune autre :

- **la convention des fabriques de contrat** l'admet, sans rien inscrire nulle part ;
- **le découper** en fonctions nommées, à comportement inchangé, la suite existante servant de
  preuve ;
- **l'inscrire** dans `JUSTIFIEES`, avec un motif qui tienne devant une revue et l'issue qui l'a
  tranché, et répéter ce motif en tête du module concerné.

La liste `DETTE_ANTERIEURE` est d'une autre nature : elle date les dépassements que le relevé de #77
a découverts hors de son périmètre. Ils ne sont pas justifiés, seulement **bornés** — l'épreuve
échoue si l'un grandit, si un nouveau apparaît, ou si une inscription devient périmée. #93 les a
soldés, et cette liste est vide.

#### La convention des fabriques de contrat

L'idiome dominant du dépôt est la clôture qui rend un objet littéral de méthodes documentées.
`max-lines-per-function` compte ce littéral comme du corps de fonction, alors que c'est une
**déclaration** : elle n'enchaîne aucune décision. Le plafond vise l'enchaînement de décisions, pas
la déclaration d'un contrat — et #93 en fait une mesure plutôt qu'un jugement de revue.

Une fabrique est **admise** au-delà du plafond si les trois conditions tiennent :

1. elle rend un littéral qui déclare au moins une **méthode** — un littéral de données n'est pas un
   contrat, et la fonction qui l'assemble fait un travail qui se mesure comme tout autre ;
2. son **corps hors de ce littéral** tient sous le plafond — au-delà, ce n'est plus une déclaration
   entourée de quelques gestes, c'est un module qui se termine par un contrat ;
3. **aucune méthode** du littéral ne dépasse le plafond — sinon c'est la méthode qui se découpe, et
   l'exemption de la fabrique masquerait sa taille.

« Hors du littéral » se compte ainsi : les lignes de la fonction, moins les lignes **intérieures**
au ou aux littéraux qu'elle rend. Les accolades restent comptées ; un littéral rendu par une
fonction imbriquée appartient à cette fonction-là, qui porte sa propre mesure.

Le prédicat vit dans `tests/unit/mesure-taille-des-fonctions.mjs` (`estFabriqueDeContrat`), mesuré
par une règle ESLint écrite sur place — l'AST qu'ESLint vient de construire, sans dépendance
nouvelle ni second analyseur. `taille-des-fonctions.test.mjs` l'éprouve sur des fragments : chaque
condition y décide seule, et une épreuve refuse un prédicat qui admettrait tout ou rien.

Une fabrique admise n'est **pas** inscrite dans `JUSTIFIEES` : la règle la couvre, et le jour où
elle cesse de la couvrir l'épreuve la redemande sans qu'une revue ait à y penser.

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

Le **contrôle de mémoire partagée fait partie de `vm:check`** (#75). C'est une vérification
distincte de l'empreinte : elle lit la section « memory » de `v86.wasm` et refuse un module qui
déclare ou importe une mémoire `shared` — code de sortie **2**, message nommant l'ADR 0010, dont la
décision de ne pas imposer l'isolation multi-origine repose précisément sur ce fait. Un artefact
absent, illisible ou disparu du manifeste rend **3** ; une empreinte fautive rend **1** comme
auparavant. Les deux verdicts sont imprimés à chaque exécution : un échec d'empreinte n'en masque
pas un de mémoire, ni l'inverse.

### Monter v86 de version

1. mettre à jour `vendor/v86/MANIFEST.json` : version npm, empreinte de l'archive, commit amont,
   puis taille et SHA-256 de chaque artefact ;
2. vider `vendor/v86/artefacts/` et exécuter `npm run vm:fetch`, qui refuse tout octet étranger au
   manifeste **et** tout `v86.wasm` réclamant une mémoire partagée ;
3. si le contrôle de mémoire partagée échoue, ne pas le contourner : l'ADR 0010 doit être rouvert
   par un nouvel ADR (#76) avant que la montée de version soit prise ;
4. rejouer `npm run test:vm` puis `npm run vm:protocol` — une empreinte dit la provenance, pas le
   comportement ;
5. inscrire dans la pull request la version amont, le commit épinglé et la date de mesure des
   empreintes.

Le coût d'adaptation à une montée de version — les quatre noms conservés par la compilation Closure
dont le dépôt dépend — est décrit par [l'ADR 0003](decisions/0003-backend-de-blocs-v86.md). Trois
portent le pont de durabilité et cassent bruyamment. Le quatrième, `tick_counter`, porte le chien de
garde du premier tour (#52) et **ne casse rien** : son renommage rend seulement la garde aveugle.
Après une montée, vérifier donc aussi que `observationsRuntime` reste vide dans les comptes rendus —
un `VAULT_RUNTIME_TICKS_UNREADABLE` y annonce un instrument perdu.

**Une cinquième dépendance est apparue avec #74**, et elle ne casse pas bruyamment non plus : v86
choisit `scheduler.postTask` en cherchant la sous-chaîne `use-scheduling-api` dans `location.href`.
C'est cette condition qui fait emprunter à l'émulateur la boucle d'ordonnancement fournie par Vault
(`src/vm/scheduling-loop.mjs`). Une montée de version qui la supprimerait ou la renommerait ferait
retomber v86 sur son Worker imbriqué `blob:`, que la CSP refuse. Le fait à vérifier après une montée
est publié dans chaque compte rendu : **`boucleOrdonnancement.appels` doit être positif**, et
`npm run test:vm` l'exige déjà sur les trois moteurs. Zéro tâche pour un émulateur qui bat signifie
que v86 emprunte une autre boucle que la nôtre.

```sh
npm run test:vm       # preuve « intégration VM » : Chromium complet, plus le démarrage du runtime
                      # sur Firefox et WebKit (périodique, hors `npm run check`)
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

### Coût de l'isolation multi-origine

Le banc du spike #41 se lance à la main comme les autres — `npm start`, puis
`http://127.0.0.1:4173/spike/isolation/`. La page ne fait rien d'elle-même ; la console offre :

```js
await bancIsolation.capacites(); // isolation du Worker, et raison typée s'il ne peut pas porter v86
await bancIsolation.mesurer({}); // un boot de guest et les étapes chronométrées
bancIsolation.isolationDocument(); // ce que voit le DOCUMENT ; il ne le déduit pas du Worker
```

Servi par `npm start`, le banc est en condition **nue**. Pour la condition isolée :

```sh
node tools/serve.mjs --role shell --host 127.0.0.1 --port 4185 --cross-origin-isolated
```

La campagne complète, deux serveurs et trois moteurs, est `npm run test:isolation` ; elle est hors
de `npm run check`. `VAULT_ISOLATION_ESSAIS` règle le nombre d'essais, `VAULT_MOTEURS` les moteurs,
et `VAULT_ISOLATION_ENTRELACEMENT=non` rejoue le protocole en blocs dont le spike publie le faux
résultat. L'inventaire des dépendances à l'isolation, lui, n'a besoin d'aucun navigateur :

```sh
npm run isolation:inventaire   # → reports/isolation/inventaire.json
```

## Publier les deux origines

La chaîne de publication (#45, [ADR 0017](decisions/0017-chaine-de-publication.md)) construit les
deux arborescences de l'ADR 0002 dans `artifacts/publication/`, dossier ignoré par git :

```sh
npm run publier                   # depuis l'arbre de travail
node tools/publier.mjs --commit HEAD           # depuis les OCTETS de ce commit (git show)
node tools/publier.mjs --verifier artifacts/publication/coquille
```

La construction produit, par arbre, un `_headers` **dérivé** de `tools/serve-headers.mjs` — jamais
recopié — et un `inventaire.json` portant l'empreinte de chaque fichier plus une empreinte de racine
liée au commit. Ce qui est publié et ce qui est retiré vit dans `tools/publier-arborescences.mjs`,
chaque ligne avec sa raison ; `tests/unit/publication-arborescences.test.mjs` échoue si un fichier
de `public/` ou de `src/` n'est ni publié ni exclu. Ajouter un banc demain oblige donc à décider.

Sans `npm run vm:fetch`, la publication est **constructible mais incomplète**, et son inventaire le
déclare (`complet: false`). Avec, l'épinglage v86 de l'ADR 0003 est vérifié dans l'arbre publié.

### Témoin d'en-têtes

`npm run publier:check` — rattaché à `npm run check`, 4 s environ — construit, vérifie, puis sert
les arbres par un serveur qui **applique leur `_headers`** et confronte les en-têtes reçus à ceux
déclarés. Il relève aussi `window.opener` sur une fenêtre ouverte depuis l'autre origine, avec son
témoin négatif : le même arbre servi sans COOP, où `opener` doit survivre.

```sh
npm run publier:temoin                                    # Chromium
VAULT_MOTEURS=chromium,firefox,webkit npm run publier:temoin
npm run publier:sonde:meta                                # ce qu'un <meta http-equiv> CSP applique
npm run publier:sonde:hebergement                         # en-têtes servis, Public Suffix List (réseau)
node tools/publier-sonde-hebergement.mjs --hors-ligne     # rejoue le dernier relevé
```

Les rapports partent dans `reports/publication/`. La chaîne complète — artefacts v86 réels, trois
moteurs, épreuve de retour arrière, dépôt des arborescences en artefacts GitHub — est
`.github/workflows/publication.yml`, en `workflow_dispatch` **seulement** : elle ne déploie rien, et
aucune fusion ne la déclenche.

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
