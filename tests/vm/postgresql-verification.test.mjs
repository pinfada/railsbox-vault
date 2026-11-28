// La SECONDE barrière de l'ADR 0056 (#343) : `guest/postgresql.sh`, joué sous `dash` dans le rootfs
// RÉEL du guest (image Docker de l'étage `rootfs`, PostgreSQL 15 i386), sans v86.
//
// L'épreuve unitaire refuse des FICHIERS affaiblis. Celle-ci affaiblit le SERVEUR par les voies que
// les fichiers ne montrent pas, et exige que le guest le voie et refuse de lancer Rails :
//
//   A. le cluster préparé comme à la fabrication : réglages relus par SHOW, conformes ;
//   B. `ALTER ROLE vault SET synchronous_commit = off` : la connexion de l'application est
//      affaiblie — REFUS reglages-affaiblis ;
//   C. `ALTER SYSTEM SET fsync = off` écrit dans `postgresql.auto.conf`, donc dans le VOLUME : la
//      ligne de commande du lanceur l'emporte, et le serveur redémarré reste conforme ;
//   D. un verrou `postmaster.pid` laissé par une session coupée, qui désigne un processus VIVANT :
//      le serveur démarre quand même, et le dit ;
//   E. un cluster initialisé SANS sommes de contrôle : REFUS reglages-affaiblis ;
//   F. aucun cluster sur le disque de données : REFUS cluster-absent.
//
// L'image `railsbox-vault-reference-rootfs:local` est celle que `npm run image:build` construit ; le
// script et la configuration sont ceux de l'ARBRE, montés par-dessus.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RACINE_DEPOT } from "../../tools/vm/boot-reference.mjs";

const IMAGE = "railsbox-vault-reference-rootfs:local";
const GUEST = join(RACINE_DEPOT, "tools", "build-reference-image", "guest");

/** Le scénario, joué dans UN conteneur. Chaque cas se termine par `@@<cas>|<code>`. */
const CONDUITE = String.raw`
set -u
cp /guest/postgresql.sh /opt/vault/postgresql.sh
cp /guest/postgresql-vault.conf /opt/vault/postgresql.conf
cp /guest/postgresql-hba.conf /opt/vault/postgresql-hba.conf
mkdir -p /app/var
PG=/usr/lib/postgresql/15/bin
cas() { echo "@@$1|$2"; }
en_postgres() { su -s /bin/sh postgres -c "$1"; }

sh /opt/vault/postgresql.sh preparer; sh /opt/vault/postgresql.sh verifier; cas A $?

en_postgres "$PG/psql -X -q -h /run/postgresql -U postgres -d postgres -c 'ALTER ROLE vault SET synchronous_commit = off'"
sh /opt/vault/postgresql.sh verifier; cas B $?
en_postgres "$PG/psql -X -q -h /run/postgresql -U postgres -d postgres -c 'ALTER ROLE vault RESET synchronous_commit'"

en_postgres "$PG/psql -X -q -h /run/postgresql -U postgres -d postgres -c 'ALTER SYSTEM SET fsync = off'"
sh /opt/vault/postgresql.sh arreter
sh /opt/vault/postgresql.sh demarrer && sh /opt/vault/postgresql.sh verifier; cas C $?
grep -c "fsync = 'off'" /app/var/pg/postgresql.auto.conf | sed 's/^/## auto.conf /'

sh /opt/vault/postgresql.sh arreter
printf '1\n/app/var/pg\n' > /app/var/pg/postmaster.pid
sh /opt/vault/postgresql.sh demarrer && sh /opt/vault/postgresql.sh verifier; cas D $?
sh /opt/vault/postgresql.sh arreter

rm -rf /app/var/pg; mkdir -p /app/var/pg; chown postgres:postgres /app/var/pg; chmod 700 /app/var/pg
en_postgres "$PG/initdb --pgdata=/app/var/pg --username=postgres --auth-local=trust" > /dev/null
sh /opt/vault/postgresql.sh demarrer
en_postgres "$PG/psql -X -q -h /run/postgresql -U postgres -d postgres -c 'CREATE ROLE vault LOGIN' -c 'CREATE DATABASE vault OWNER vault'"
sh /opt/vault/postgresql.sh verifier; cas E $?
sh /opt/vault/postgresql.sh arreter

rm -rf /app/var/pg
sh /opt/vault/postgresql.sh demarrer; cas F $?
`;

function imageDisponible() {
  const sonde = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
  return sonde.status === 0;
}

test(
  "postgresql.sh relit le serveur réel et refuse ce qu'un fichier ne montre pas",
  {
    skip: imageDisponible() ? false : `image ${IMAGE} absente : « npm run image:build »`,
    timeout: 600_000,
  },
  () => {
    const dossier = mkdtempSync(join(tmpdir(), "vault-postgresql-"));
    try {
      writeFileSync(join(dossier, "conduite.sh"), CONDUITE);
      const jeu = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/386",
          "-v",
          `${dossier}:/script:ro`,
          "-v",
          `${GUEST}:/guest:ro`,
          IMAGE,
          "linux32",
          "dash",
          "/script/conduite.sh",
        ],
        { encoding: "utf8", maxBuffer: 1 << 24 },
      );
      const sortie = `${jeu.stdout}\n${jeu.stderr}`;
      const codes = Object.fromEntries(
        jeu.stdout
          .split("\n")
          .filter((ligne) => ligne.startsWith("@@"))
          .map((ligne) => ligne.slice(2).split("|")),
      );
      assert.deepEqual(codes, { A: "0", B: "3", C: "0", D: "0", E: "3", F: "3" }, sortie);
      const lignes = jeu.stdout.split("\n");
      assert.ok(
        lignes.includes(
          "[postgresql] reglages fsync=on synchronous_commit=on full_page_writes=on wal_sync_method=fdatasync data_checksums=on ignore_checksum_failure=off zero_damaged_pages=off",
        ),
        sortie,
      );
      assert.match(jeu.stdout, /REFUS reglages-affaiblis attendus : synchronous_commit=on\n/);
      assert.match(jeu.stdout, /## auto\.conf 1\n/, "ALTER SYSTEM a bien écrit dans le volume");
      assert.match(jeu.stdout, /session precedente coupee : reprise sur crash/);
      assert.match(jeu.stdout, /REFUS reglages-affaiblis attendus : data_checksums=on\n/);
      assert.match(jeu.stdout, /REFUS cluster-absent/);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  },
);
