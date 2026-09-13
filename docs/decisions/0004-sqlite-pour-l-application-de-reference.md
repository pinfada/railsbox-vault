# ADR 0004 — SQLite porte l'invariant de l'application de référence

- Statut : accepté
- Date : 2026-08-23
- Issue : #5 · Invariant : `VAULT-PERSIST-001` · Jalon 0

## Contexte

`docs/compatibility.md` classait « PostgreSQL dans la VM » **candidat**, condition de promotion «
fixture #5 et persistance #7 », et « SQLite dans la VM » **candidat** avec une condition plus sévère
: « fixture dédiée après preuve PostgreSQL **ou ADR de priorité** ». Cet ADR est cette décision de
priorité.

L'issue #5 ne demande pas une base de données : elle demande un **invariant durable vérifiable après
boot à froid**. La question posée au moteur est donc étroite — sait-il acquitter une écriture après
une barrière durable, et rendre exactement la même donnée au boot suivant ? — et elle n'exige ni
concurrence, ni réplication, ni extension.

RailsBox Live embarque PostgreSQL 15 dans son rootfs mutualisé. Le coût y est documenté : binaires
serveur et client, `libpq`, un `initdb` à la construction du disque applicatif, un `pg_ctl start`
dans le chemin chaud du visiteur, un fichier de configuration dédié, et un script `postgres.sh` de
132 lignes pour démarrer, attendre et diagnostiquer le cluster. Live paie ce prix parce qu'il promet
d'exécuter des applications Rails quelconques ; Vault, au jalon 0, ne promet qu'un invariant.

## Décision

**L'application Rails de référence utilise SQLite, avec `journal_mode = delete` et
`synchronous = full` déclarés explicitement.** PostgreSQL reste la cible pour les applications
réelles et n'est pas abandonné ; il n'entre pas dans la fixture de l'invariant.

Conséquences immédiates :

1. le rootfs de référence n'embarque ni serveur PostgreSQL, ni `initdb`, ni cluster à démarrer : au
   repos, l'état persistant de l'application est **un fichier** sur le volume applicatif, plus les
   fichiers de la pièce jointe ActiveStorage ;
2. la ligne « SQLite dans la VM » de `docs/compatibility.md` passe de **candidat** à **mesuré** dès
   que `npm run test:vm` publie un boot réussi ; sa promotion en **supporté** reste conditionnée au
   scénario bout en bout du jalon 1 ;
3. la ligne « PostgreSQL dans la VM » reste **candidat**, condition de promotion inchangée,
   désormais rattachée à #7 seule et non plus à #5 ;
4. tout budget mesuré sur la fixture (taille d'artefact, temps de boot, mémoire) est un budget
   **SQLite** et ne préjuge pas de ceux d'une image PostgreSQL.

## Les deux pragmas ne sont pas des détails

Ils sont la moitié de la décision, parce que l'invariant sert précisément à prouver la persistance
après coupure.

| Réglage               | Valeur retenue | Ce qu'elle achète                                                                                                                                                                                                                                |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PRAGMA journal_mode` | `delete`       | Au repos, la base est **un** fichier. En WAL, les transactions acquittées vivent dans un `-wal` séparé ; une capture de volume qui l'omettrait perdrait des écritures déjà acquittées, silencieusement. Le journal d'annulation supprime ce cas. |
| `PRAGMA synchronous`  | `full` (2)     | `fsync` avant l'acquittement du commit. C'est la condition littérale de « RPO 0 après la barrière durable du guest » (`docs/quality-attributes.md`).                                                                                             |
| `PRAGMA foreign_keys` | `on`           | ActiveStorage relie l'attachement au blob par clé étrangère ; sans vérification, un invariant amputé de son blob resterait « valide » côté base.                                                                                                 |

Ils sont écrits dans `apps/reference/config/database.yml` **et** interrogés sur la connexion réelle
par `apps/reference/test/lib/durability_pragmas_test.rb`. Une ligne de configuration non appliquée
est indiscernable d'une ligne absente : la vérifier est ce qui la rend opposable.

`synchronous = full` ralentit les écritures. C'est voulu, et sans conséquence ici : la fixture écrit
une fois, à la construction du disque, jamais dans le chemin chaud du visiteur.

## Note datée du 13/09/2026 — `synchronous = extra`, la pièce jointe synchronisée, le disque en ext4 journalisé (#209)

**La ligne « `full` = condition littérale de RPO 0 » du tableau ci-dessus est fausse**, et elle est
corrigée ici plutôt que réécrite en place. En `journal_mode = delete`, le point de validation d'une
transaction est l'**effacement** du `-journal` ; `synchronous = full` synchronise le journal et la
base, mais **pas le répertoire** après cet effacement. Une coupure juste après l'acquittement laisse
sur le support un journal « chaud », que SQLite rejoue au boot suivant : la transaction acquittée
est **annulée**. Mesuré par la revue de la PR #208 (coquille réelle, Chromium) : une note acquittée,
le coffre verrouillé après _d_ secondes puis rouvert à froid — perdue 4 fois sur 4 à _d_ = 0 s, 1
fois sur 3 à 5 s, 0 fois sur 3 à 30 s. Reproduit hors v86 par le défi C-K du 13/09 (ext2 en boucle,
noyau 5.15, copie brute du support dès le retour du commit, ×3) : `delete`/`full` 0/3 relues,
journal chaud 3/3.

**Décision : `synchronous = extra` (3).** C'est `full` plus un `fsync` du répertoire après
l'effacement du journal (documentation SQLite) : 3/3 relues dans la même mesure, commit en 7 à 19 ms
comme en `full`. Sous v86, ce `fsync` émet un FLUSH CACHE que le pont n'acquitte qu'après
`generation.valider()` (`src/vm/v86-flush-bridge.mjs`, `opfs-block-backend.mjs`) : un commit ne rend
donc la main à Rails qu'une fois la génération validée dans l'OPFS. La durabilité d'un acquittement
est une propriété du **commit**, pas du point de contrôle — aucun verbe du pont série, aucune étape
de l'ADR 0024 n'est ajoutée. `database.yml` écrit l'entier `3` : la gemme `sqlite3` 2.9.6 ne connaît
que les noms `off`, `normal` et `full`. Le prix mesuré est publié dans `docs/quality-attributes.md`
(§ Écriture acquittée).

**`journal_mode = delete` est conservé** : sa raison — au repos la base est UN fichier — tient.
**`journal_mode = truncate` avec `full` est écarté** : même preuve (3/3, pas d'effacement), mais il
laisse un `-journal` vide au repos, ce qui contredit cette raison. Il ne se reprend que sur une
raison de débit mesurée.

**La pièce jointe.** ActiveStorage téléverse dans un `after_commit`, donc APRÈS la dernière barrière
SQLite, et le service `Disk` de Rails n'appelle jamais `fsync` : mesure du défi (256 Kio par blocs
de 16 Kio, ×3), `Disk` tel quel 0/3 relues. L'application déclare donc `DurableDisk`
(`apps/reference/lib/active_storage/service/durable_disk_service.rb`), une sous-classe de `Disk` qui
synchronise le fichier puis chaque répertoire dont une entrée vient de naître : 3/3 relues, 12 à 18
ms. Écartés : `chattr +S` (couvre, mais une barrière par bloc écrit, ≈ 90 ms pour 256 Kio,
proportionnel à la taille) ; montage `dirsync` (écrit les répertoires SANS FLUSH, donc rien de
validé au sens de l'ADR 0014) ; montage `sync` (une barrière par écriture sur tout `/app`) ; pièces
dans SQLite (service maison, blob recopié dans le journal).

**Le système de fichiers : ext4 AVEC journal, à la place de l'ext2 (décision du 13/09/2026, 17 h).**
Les deux mesures précédentes ne suffisaient pas, et la preuve sous v86 l'a montré. Avec `extra` et
`DurableDisk`, une note et sa pièce verrouillées 1 ms après l'acquittement sont bien **relues**
après un boot à froid (2 fois sur 2), mais l'écriture SUIVANTE rend 500 :
`EXT4-fs error (device sdb): __ext4_new_inode: failed to insert inode 8193: doubly allocated?`, puis
`Errno::EIO @ dir_s_mkdir /app/var/storage/gk`. Sur un ext2, qui n'a pas de journal, `fsync` rend
durables les données, l'inode et l'entrée de répertoire — **pas** les bitmaps d'allocation ni les
descripteurs de groupe, que le noyau n'écrit qu'à sa réécriture périodique (≈ 30 s). Verrouiller
dans cette fenêtre laisse un système de fichiers incohérent : l'allocation suivante reprend un inode
(EIO) ou un bloc (corruption silencieuse d'un fichier existant, la base comprise dès qu'elle
grandit) déjà utilisé. Le défi C-K relisait une copie une fois ; il ne réécrivait pas après.

Le choix de l'ext2 **n'était appuyé par aucune décision** : cet ADR laissait expressément le système
de fichiers du volume applicatif paramétrable (« Ce que cette décision ne dit pas », ci-dessous), et
`sources.json` écrivait `ext2` sans motif. Il est remplacé ainsi :

- `reference-app` est fabriqué en **ext4 avec journal** (`has_journal`, tables d'inodes et journal
  initialisés à la fabrication pour qu'aucun fil `ext4lazyinit` n'écrive dans le guest) ; l'artefact
  est **renommé `reference-app.ext4`** — un nom ne ment pas sur son contenu ;
- il est monté `-t ext4 -o barrier=1,data=ordered` (`guest-init.sh`) : chaque `fsync` valide une
  transaction jbd2 qui porte ces métadonnées et se termine par un FLUSH CACHE, donc un disque
  **cohérent à chaque barrière** ; le journal est rejoué au montage. `nobarrier`, `data=writeback`
  et `noload` sont interdits, et un test unitaire le vérifie ;
- `synchronous = extra` et `DurableDisk` sont **conservés** : le journal du système de fichiers rend
  les métadonnées cohérentes, il ne synchronise pas à la place de l'application.

Écartés :

- **`syncfs` après chaque commit et chaque téléversement** (un rappel Rails qui appelle
  `sync -f /app`) : il vide TOUT le système de fichiers à chaque écriture, soit un coût par requête
  qui croît avec l'activité du guest et non avec l'écriture elle-même, et il ne couvre aucune
  écriture faite hors des deux rappels (journaux, fichiers temporaires, applications tierces). Il
  resterait de plus une fenêtre entre le 303 et le rappel. Non mesuré : l'ext4 rend la mesure sans
  objet.
- **`e2fsck -p` avant le montage** (rootfs) : il **répare après coup** au lieu de garder le disque
  cohérent — une réparation peut détacher un fichier dans `lost+found`, c'est-à-dire perdre une
  pièce acquittée — et il relit toutes les tables d'un disque de 512 Mio à chaque boot à froid, là
  où le rejeu d'un journal ne lit que les transactions en attente.

Prix de l'ext4, mesuré (coquille réelle, Chromium, local) : le scénario
`tests/e2e/durabilite-du-commit.spec.mjs` rend **9 relectures sur 9** — note et pièce verrouillées à
0, 5 et 30 s, trois fois chacun, boot à froid, et le disque rouvert accepte chaque fois l'écriture
suivante, relue au boot suivant ; le **boot à froid**, rejeu du journal compris, dure 81,6 à 88,1 s
(neuf essais), contre 100,9 s pour le seul boot à froid mesuré sur ext2 le même jour — pas plus
lent, donc, et l'écart tient à la machine plus qu'au système de fichiers ; l'**artefact** garde ses
512 Mio (53,4 Mio compressés, +6,6 Kio : le journal de 16 Mio est fait de zéros) ; une soumission de
note émet **8 barrières** au lieu de 3, une note avec pièce de 64 Kio **18** au lieu de 7, pour une
durée inchangée dans la dispersion (153–203 ms et 563–813 ms, `docs/quality-attributes.md`).

**Résidu nommé** : une coupure ENTRE le commit et le téléversement laisse une ligne sans fichier. Le
303 n'est pas parti, ce n'est donc pas une écriture acquittée perdue, mais l'état est incohérent ;
la page d'une note le dit (`fichier-introuvable`) au lieu de rendre une erreur. Il n'est pas corrigé
ici.

**Limite** : cette garantie est une discipline de l'APPLICATION de référence. Une application tierce
(P3) qui écrit hors de SQLite et hors d'ActiveStorage sans `fsync` n'est pas couverte (#210).

## Options comparées

| Critère                            | **SQLite (retenue)**                                        | PostgreSQL dans la VM                                                                       | Aucune base (fichier brut)                           |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| État au repos                      | un fichier, plus les blobs                                  | un datadir de plusieurs dizaines de Mio, WAL compris                                        | un fichier                                           |
| Ajout au rootfs                    | `libsqlite3-0` (~1 Mio)                                     | serveur + client + `libpq` (~40 Mio installés) et un cluster à créer au build               | rien                                                 |
| Chemin de boot                     | aucun service à démarrer                                    | `pg_ctl start`, attente de disponibilité, diagnostic d'échec                                | aucun                                                |
| Barrière durable exprimable        | `synchronous = full`, vérifiable par `PRAGMA`               | `fsync = on`, `synchronous_commit = on`, vérifiables aussi                                  | à écrire à la main, donc à prouver à la main         |
| Représentativité des vraies applis | partielle : beaucoup d'applications Rails visent PostgreSQL | **meilleure**                                                                               | nulle : aucune application Rails ne fonctionne ainsi |
| Ce que l'invariant exerce          | ActiveRecord, une transaction, un `fsync`, un fichier joint | la même chose, plus un serveur                                                              | ni ActiveRecord, ni transaction                      |
| Risque de la fixture               | faible                                                      | un cluster qui refuse de démarrer transforme l'épreuve de persistance en épreuve d'`initdb` | faible, mais ne prouve rien d'utile                  |

Motif factuel de choix : l'invariant doit isoler **la persistance**. Un cluster PostgreSQL ajoute un
service dont la panne se manifesterait exactement comme une perte de données — l'invariant
introuvable — sans le diagnostic qui distingue les deux. À budget de preuve égal, SQLite mesure ce
qu'on veut mesurer et rien d'autre.

## Ce que cette décision ne dit pas

- Elle **ne dit pas** que Vault ne prendra pas PostgreSQL en charge. `docs/compatibility.md` le
  garde candidat, et l'énoncé de compatibilité des applications Rails (« une application devient
  supportée lorsqu'elle fournit… ») reste inchangé.
- Elle **ne dit pas** que les mesures de la fixture valent pour une application PostgreSQL. Une
  image PostgreSQL aura son propre rootfs, ses propres artefacts et ses propres budgets.
- Elle **ne fige pas** la géométrie du disque. Le spike #4 décide du backend de blocs ; la taille et
  le système de fichiers du volume applicatif sont paramétrés dans
  `tools/build-reference-image/sources.json` (`disk`) et surchargeables par
  `npm run image:build -- --taille-app=<Mio>`.

## Épinglage des sources : ce qui est figé et ce qui ne l'est pas

L'issue exige que la construction échoue si un artefact n'est pas épinglé.
`tools/build-reference-image/verify-pinning.mjs` refuse un `FROM` sans empreinte, une empreinte
absente de `sources.json`, un téléchargement sans `sha256sum -c`, un `ARG`/`ENV` de secret, un
montage de secret BuildKit et la copie d'une clé maîtresse Rails.

Une limite reste, et elle est assumée ici plutôt que passée sous silence : **l'index apt n'est pas
épinglé**. Le digest de `i386/debian:bookworm-slim` fige le socle, mais `apt-get install` lit le
miroir Debian au moment de la construction. Deux constructions à six mois d'écart peuvent donc
obtenir des versions de paquets différentes. Trois faits bornent le risque :

- les versions réellement obtenues sont **enregistrées** dans le manifeste par l'empreinte des
  artefacts produits : une dérive est détectable, même si elle n'est pas empêchée ;
- le manifeste est commité, les artefacts ne le sont pas : la référence versionnée est l'empreinte,
  et le test VM refuse de booter autre chose ;
- le remède connu — `snapshot.debian.org` — est un travail découvert, à ouvrir en issue distincte :
  il change la source apt de toute la chaîne et mérite sa propre tranche.

## Conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- la preuve de persistance de #7 exige une propriété que SQLite ne sait pas exprimer (par exemple
  une barrière durable inter-processus qu'un fichier unique ne rend pas observable) ;
- le backend de blocs décidé par #4 rend le journal d'annulation plus coûteux ou moins sûr que le
  WAL — le choix `journal_mode` serait alors rouvert seul, sans changer de moteur ;
- une application de référence PostgreSQL devient nécessaire avant le jalon 1, auquel cas elle
  s'ajoute à celle-ci au lieu de la remplacer.

## Alternatives rejetées

- **PostgreSQL dans la fixture de #5** : rejetée pour le motif ci-dessus, non pour un doute sur le
  moteur. Elle reste la cible de #7 et des applications réelles.
- **Un `BLOB` en base plutôt qu'ActiveStorage** : rejetée parce qu'elle n'exercerait qu'un seul
  chemin de persistance. La pièce jointe sur disque local fait porter l'invariant par **deux**
  supports — des lignes en base et un fichier dans le volume — et rend visible le mode de panne où
  l'un survit sans l'autre : `Vault::Fixture#verify` rend alors `fichier introuvable`, avec l'écart
  nommé, plutôt qu'une exception.
- **WAL avec `synchronous = normal`** : le défaut de Rails 8 sur SQLite. Rejetée : `normal` en WAL
  n'appelle `fsync` qu'au point de contrôle, ce qui autorise la perte de transactions acquittées
  lors d'une coupure — exactement ce que l'invariant doit interdire.
