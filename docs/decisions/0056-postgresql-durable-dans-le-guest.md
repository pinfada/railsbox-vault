# ADR 0056 — PostgreSQL dans le guest : une configuration durable, posée par l'outil

- Statut : proposé
- Date : 2026-11-28
- Issue : [#343](https://github.com/pinfada/railsbox-vault/issues/343) (première tranche : E1, E2,
  E6) · lot `lot:applications-tierces` · liée à #272, #210, #351
- **Complète** l'[ADR 0004](0004-sqlite-pour-l-application-de-reference.md) : SQLite reste la base
  de la référence ; PostgreSQL devient la base des applications qui le déclarent. **S'appuie** sur
  la chaîne de durabilité de l'ADR 0004 (note du 13/09/2026) et sur le paquet de l'
  [ADR 0041](0041-le-paquet-applicatif-partition-2-d-un-hda-compose.md).
- Reprend : `pinfada/railsbox`, `tools/build-v86-image/base/Dockerfile` (PostgreSQL 15 de Debian
  bookworm i386, retrait du cluster `main`), `base/rib/postgres.sh` (cycle de vie),
  `base/app.Dockerfile` (initdb, migrations, arrêt `fast` à la construction),
  `base/rib/start-app.sh` (démarrage après le montage), `tools/detect/detect.mjs` (lecture de
  `database.yml` sans ERB). **Ne reprend pas** `base/rib/postgresql-railsbox.conf` : il met `fsync`,
  `synchronous_commit` et `full_page_writes` à `off`.

## Contexte

Le coffre s'adapte à l'application, pas l'inverse (#272). Une application Rails conventionnelle qui
déclare `adapter: postgresql` ne pouvait pas entrer dans un coffre : le guest n'avait que SQLite.

Décision du mainteneur (27/11/2026) : PostgreSQL ne tourne dans un coffre qu'avec `fsync = on`,
`synchronous_commit = on`, `full_page_writes = on` et des sommes de contrôle
(`initdb --data-checksums`), quel qu'en soit le coût.

La chaîne de durabilité du coffre est générique (ADR 0004, #209) : un `fsync` du guest sur le disque
de données devient une commande FLUSH CACHE, que le pont (`src/vm/v86-flush-bridge.mjs`) n'acquitte
qu'après validation de la génération dans l'OPFS. Un PostgreSQL qui synchronise son WAL avant de
rendre le COMMIT devrait donc obtenir la garantie de SQLite. Cet ADR dit comment l'outil pose cette
configuration, et ce qui est prouvé.

## Décisions

1. **La base se lit dans la production de `config/database.yml`.**
   `tools/paquet/base-de-donnees.mjs` retire l'ERB, suit les ancres et les fusions `<<: *nom`, lit
   une connexion unique ou des bases nommées. `sqlite3` garde le chemin de l'ADR 0004 ; `postgresql`
   reçoit un cluster. Un autre moteur, un mélange de moteurs, une production sans adaptateur lisible
   ou un fichier absent sont refusés avant le premier `docker build`, avec ce qui bloque, pourquoi
   et quoi changer. Rien n'est deviné.

2. **Le cluster naît dans la graine, par le script que le guest utilise au boot.**
   `guest/postgresql.sh preparer` (étage `disque-app`) : `initdb --data-checksums`, un rôle `vault`
   `LOGIN CREATEDB` **non superutilisateur**, une base `vault` qui lui appartient ; puis `verifier`,
   `bin/rails db:migrate` par le `DATABASE_URL` de l'outil, et `arreter` en mode `fast`. La graine
   porte un cluster arrêté proprement : le premier boot n'a rien à rejouer. Le paquet porte un
   marqueur `/app/db/.vault-base-de-donnees`.

3. **La configuration est celle de l'OUTIL, pas celle du volume.** Le serveur démarre avec
   `config_file=/opt/vault/postgresql.conf` (dans le rootfs) et `hba_file` à côté : le
   `postgresql.conf` qu'initdb a écrit dans le datadir n'est jamais lu, et une version suivante de
   l'outil peut changer la mémoire ou les checkpoints des coffres existants. Les trois réglages de
   durabilité sont **redits en ligne de commande** : ils l'emportent ainsi sur un
   `postgresql.auto.conf` que le volume porterait. Aucune écoute TCP ; le socket local seul, en
   `trust`.

4. **Deux barrières contre une configuration affaiblie.**
   - À la construction : `tools/build-reference-image/postgresql-durable.mjs`, appelé par
     `verify-pinning.mjs`, refuse `fsync`, `synchronous_commit` (seul `on` est admis, ni `local` ni
     `remote_write`) ou `full_page_writes` faux ou absents, une inclusion, un contrôle d'intégrité
     désarmé (`ignore_checksum_failure`, `zero_damaged_pages`, `data_sync_retry`), un initdb sans
     sommes de contrôle, une surcharge `-c …=off` ou `-F`, un `ALTER SYSTEM`. La majeure (15) est
     épinglée dans `sources.json` et vérifiée dans le Dockerfile et le lanceur.
   - À chaque boot : `postgresql.sh verifier` relit par `SHOW` `fsync`, `synchronous_commit`,
     `full_page_writes`, `wal_sync_method`, `data_checksums` (et les deux contrôles d'intégrité) sur
     la connexion de l'application — même rôle, même base, donc mêmes `ALTER ROLE … SET`. Un écart,
     un cluster absent, une autre majeure, un datadir qui n'appartient pas à `postgres` : Rails
     n'est pas lancé, et la cause est dite sur la série (`[postgresql] REFUS …`).

5. **Le guest démarre PostgreSQL après le montage de `hdb`, avant le schéma.** `guest-init.sh`, pour
   un paquet marqué `postgresql` : `demarrer` puis `verifier`, puis `schema-du-volume.sh` (dont les
   migrations passent par le serveur), puis Rails. `env.sh` fournit `DATABASE_URL`
   (`postgresql://vault@localhost/vault?host=/run/postgresql` ; `host`, un répertoire, désigne le
   socket), qui l'emporte sur `database.yml`. Un verrou `postmaster.pid` laissé par une session
   coupée — le cas normal d'un coffre verrouillé — est retiré avant le démarrage : aucun serveur ne
   peut tourner à cet instant, et sous un guest qui redémarre à l'identique le PID inscrit peut
   désigner un autre processus vivant. Le serveur fait alors sa reprise sur crash.

6. **Un seul rootfs, PostgreSQL compris.** Les applications SQLite paient son poids. `postgres` est
   pris sans son JIT : `jit = off`, `llvmjit.so`, son bitcode et libLLVM sont retirés du rootfs
   (seul `llvmjit.so` liait libLLVM). L'utilisateur `postgres` a un uid et un gid fixes (990) dans
   les deux étages : le datadir naît dans l'un et s'ouvre dans l'autre.

7. **Le relais suit une redirection en `https` vers le guest.** `rails new` écrit
   `config.assume_ssl = true` en production : Rails rend `Location: https://127.0.0.1/notes/1`, et
   `emplacementRendu` (`src/coquille/relais-http.mjs`) jetait cette redirection comme une autre
   origine. Après chaque formulaire, le cadre restait blanc. Ce défaut n'est pas propre à PostgreSQL
   : E2 l'a trouvé. Seul le schéma est réécrit ; l'hôte, le port et le chemin restent jugés.

## Ce qui est prouvé (28/11/2026)

- **E1, fichiers** : `tests/unit/postgresql-durable.test.mjs` refuse la configuration de RailsBox et
  chaque affaiblissement, un par un ; campagne de mutation `postgresql`.
- **E1, serveur réel** : `tests/vm/postgresql-verification.test.mjs` joue `postgresql.sh` dans le
  rootfs réel (Docker). Un `ALTER ROLE … SET synchronous_commit = off` et un cluster sans sommes de
  contrôle sont refusés. Un `ALTER SYSTEM SET fsync = off` est bien écrit dans le volume, et la
  ligne de commande l'emporte. Un `postmaster.pid` qui désigne un PID vivant n'empêche pas le
  démarrage.
- **E1, dans le guest** : `tests/vm/postgresql-configuration.test.mjs` relit
  `fsync=on synchronous_commit=on full_page_writes=on wal_sync_method=fdatasync data_checksums=on`
  sur la connexion de l'application.
- **E2, moitié guest** : `tests/vm/postgresql-coupure.test.mjs`. Trois notes sont acquittées, et
  l'émulateur est arrêté net sur la première trame de chaque réponse. Après trois boots à froid avec
  reprise sur crash, les trois notes sont relues, et chaque disque rouvert accepte l'écriture
  suivante.
- **E2, chaîne entière** : `tests/e2e/durabilite-postgresql.spec.mjs`, dans la coquille, sous
  Chromium, sur l'application générée NON modifiée. La mesure a été faite sur une fusion locale avec
  la branche de #351, sans laquelle l'application ne démarre pas. Six notes ont été verrouillées à 0
  s (×3) et à 5 s (×3). Chaque instantané a été retiré, et chaque boot était à froid
  (`instantaneUtilise: false`). Les six notes sont relues, et chacune est suivie d'une écriture.

## Mesures E6 (28/11/2026, Windows 11, Docker Desktop, 28 fils, 32 Gio)

Ce sont des MESURES, chacune sur un seul essai sauf mention contraire. Aucune n'est une estimation.

| Grandeur                                                             |                     Valeur | Comment                                                     |
| -------------------------------------------------------------------- | -------------------------: | ----------------------------------------------------------- |
| PostgreSQL au repos, PSS (part réelle)                               |                   19,4 Mio | `guest/mesure-memoire.sh`, 30 s après la 1re réponse        |
| PostgreSQL au repos, RSS additionnée                                 |                   62,5 Mio | compte `shared_buffers` une fois par processus              |
| PostgreSQL sous les premières requêtes, PSS (pic)                    |                   20,4 Mio | 5 écritures et leurs relectures                             |
| Rails (Puma), PSS au pic                                             |                   63,7 Mio | même relevé                                                 |
| Mémoire utilisée du guest, pic                                       |           93,0 Mio sur 512 | `MemTotal - MemAvailable`                                   |
| Serveur prêt (`pg_ctl start`, avec reprise sur crash)                |                2,1 à 3,2 s | 8 boots sous Node, ligne `[postgresql] pret`                |
| Démarrage à froid dans la coquille, jusqu'à « application démarrée » |            106,7 à 115,6 s | 6 boots, `bootMs`                                           |
| Démarrage à froid sous Node, jusqu'au premier 200                    |               127 et 153 s | 2 essais                                                    |
| Démarrage à froid de la référence SQLite, même rootfs, sous Node     |                     90,7 s | `reference-boot.test.mjs`, 1 essai (*)                      |
| Taille du datadir dans la graine                                     |                     46 Mio | `du -sh`, après l'arrêt `fast`                              |
| Graine compressée (gzip)                                             |                    7,0 Mio | 0,5 Mio pour la graine SQLite de la référence               |
| Rootfs                                                               | 510 Mio, 165 Mio compressé | 385 et 128 Mio avant PostgreSQL                             |
| Barrières par écriture acquittée                                     |                      **1** | 5 écritures sur 5 ; FLUSH CACHE vers `hdb`, mode `identify` |
| Pic mémoire de l'onglet                                              |                  2 448 Mio | voir la remarque ci-dessous                                 |

Remarques :

- (\*) **Avec et sans PostgreSQL.** Ce sont deux applications différentes : la référence a moins de
  gemmes, et sa sonde est `/vault/health`, alors que celle du témoin est `/notes`, interrogée toutes
  les 5 s. L'écart de 36 à 62 s n'est donc pas le coût de PostgreSQL. Ce coût direct se lit sur la
  ligne « Serveur prêt » : 2,1 à 3,2 s, plus la relecture des réglages. Le témoin SQLite généré par
  `rails new` n'a pas été mesuré.

- **Barrières.** Le pont est posé en mode `identify` : le disque annonce un cache d'écriture, donc
  le noyau émet ses FLUSH comme dans le navigateur, où chacun devient une génération OPFS validée.
  Un COMMIT coûte UN `fdatasync` du WAL. Le segment de WAL est préalloué, donc aucune métadonnée
  ext4 n'est à journaliser, et ce `fdatasync` coûte UN FLUSH CACHE.
- **Onglet.** C'est le plus gros processus Chromium échantillonné (ensemble de travail, toutes les 5
  s) pendant l'épreuve E2 dans la coquille. D'autres Chromium de Playwright pouvaient tourner sur le
  poste au même moment, mais aucun ne porte un guest de cette taille. Aucune mesure SQLite n'a été
  faite dans les mêmes conditions : ce chiffre ne sépare pas ce qui revient à PostgreSQL (rootfs
  plus gros, graine plus grosse) de ce qui revient au reste.
- **512 Mio suffisent** pour cette application : le guest utilise moins de 100 Mio au pic. Une
  application plus lourde n'est pas mesurée.

## Ce qui reste hors de portée

- **Une session qui s'affaiblit elle-même.** `SET synchronous_commit = off`, ou `variables:` dans
  `database.yml`, est un choix de l'application dans SA session ; `verifier` ne le voit pas, et
  l'outil ne peut pas l'interdire sans modifier l'application. Il est documenté, pas empêché.
- **Les bases nommées autres que `primary`** (`cache:`, `queue:`, `cable:` de Rails 8 avec Solid) :
  `DATABASE_URL` ne raccorde que `primary`. Les tâches de fond (Solid Queue, Sidekiq, Redis) sont
  hors de cette tranche.
- **Une montée de majeure** (15 vers 16) : refusée en clair au boot, sans `pg_upgrade`.
- E3 (coupure pendant un checkpoint, `amcheck`, `pg_checksums`) et E4 (instantané puis écriture)
  restent à écrire.

## Conséquences

- Une application PostgreSQL conventionnelle s'empaquette sans modification — sous réserve de #351
  pour ce qui n'est pas la base (verrou, `credentials.yml.enc`, `secret_key_base`, sonde).
- Le rootfs grandit, pour toutes les applications.
- Chaque boot d'un coffre PostgreSQL verrouillé fait une reprise sur crash.
