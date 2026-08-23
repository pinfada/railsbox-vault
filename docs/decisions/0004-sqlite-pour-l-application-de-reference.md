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
