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

## Ce qui est prouvé, et ce qui ne l'est pas

Voir la section « Mesures » plus bas, et la PR de la tranche.

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
