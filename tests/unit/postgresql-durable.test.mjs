/**
 * E1 (#343) : la configuration de PostgreSQL que le guest embarque ne peut pas AFFAIBLIR la
 * durabilité d'une écriture acquittée.
 *
 * Décision du mainteneur (27/11/2026, ADR 0056) : dans un coffre, PostgreSQL ne tourne qu'avec
 * `fsync = on`, `synchronous_commit = on`, `full_page_writes = on`, et un cluster initialisé avec
 * des sommes de contrôle (`initdb --data-checksums`), quel qu'en soit le coût. La configuration de
 * RailsBox (`postgresql-railsbox.conf`) met les trois réglages à `off` : elle est le premier contre-
 * exemple de cette épreuve.
 *
 * Ce que l'épreuve protège : une configuration affaiblie ne fait échouer AUCUNE requête. Elle ne se
 * voit qu'au verrouillage suivant, quand une écriture acquittée manque au boot à froid. Le refus
 * doit donc arriver avant la construction (`verify-pinning.mjs`), et pas chez la personne.
 *
 * La moitié des cas vérifient l'INVERSE : les graphies que PostgreSQL accepte pour « vrai » passent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyserConfigurationPostgresql,
  analyserLanceurPostgresql,
  analyserVersionPostgresql,
  lireLesReglages,
  REGLAGES_EXIGES,
} from "../../tools/build-reference-image/postgresql-durable.mjs";
import { verifierEpinglage } from "../../tools/build-reference-image/verify-pinning.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOSSIER_GUEST = join(RACINE, "tools", "build-reference-image", "guest");
const CONFIGURATION_REELLE = readFileSync(join(DOSSIER_GUEST, "postgresql-vault.conf"), "utf8");
const LANCEUR_REEL = readFileSync(join(DOSSIER_GUEST, "postgresql.sh"), "utf8");

/** Une configuration minimale CONFORME, que chaque cas affaiblit d'une seule façon. */
const CONFORME = [
  "fsync = on",
  "synchronous_commit = on",
  "full_page_writes = on",
  "wal_sync_method = fdatasync",
  "",
].join("\n");

/** Un lanceur minimal CONFORME : initdb avec sommes de contrôle. */
const LANCEUR_CONFORME = 'initdb --pgdata="$PGDATA" --data-checksums --encoding=UTF8\n';

const codes = (anomalies) => anomalies.map((anomalie) => anomalie.code).sort();

test("la configuration RÉELLE du guest et son lanceur sont acceptés", () => {
  const anomalies = [
    ...analyserConfigurationPostgresql(CONFIGURATION_REELLE),
    ...analyserLanceurPostgresql(LANCEUR_REEL),
  ];
  assert.deepEqual(anomalies, [], anomalies.map((anomalie) => anomalie.message).join("\n"));
});

test("les cinq réglages exigés sont ceux de la décision du mainteneur", () => {
  assert.deepEqual(Object.keys(REGLAGES_EXIGES).sort(), [
    "data_checksums",
    "fsync",
    "full_page_writes",
    "synchronous_commit",
    "wal_sync_method",
  ]);
});

test("la configuration de RailsBox est refusée sur ses trois réglages", () => {
  const railsbox = [
    "fsync = off",
    "synchronous_commit = off",
    "full_page_writes = off",
    "wal_level = minimal",
    "",
  ].join("\n");
  assert.deepEqual(codes(analyserConfigurationPostgresql(railsbox)), [
    "pg-fsync-affaibli",
    "pg-full-page-writes-affaibli",
    "pg-synchronous-commit-affaibli",
  ]);
});

for (const [reglage, valeur, code] of [
  ["fsync", "off", "pg-fsync-affaibli"],
  ["fsync", "false", "pg-fsync-affaibli"],
  ["fsync", "0", "pg-fsync-affaibli"],
  ["fsync", "'no'", "pg-fsync-affaibli"],
  ["full_page_writes", "off", "pg-full-page-writes-affaibli"],
  ["synchronous_commit", "off", "pg-synchronous-commit-affaibli"],
  ["synchronous_commit", "local", "pg-synchronous-commit-affaibli"],
  ["synchronous_commit", "remote_write", "pg-synchronous-commit-affaibli"],
  ["wal_sync_method", "fsync_writethrough_inconnu", "pg-wal-sync-method-inconnue"],
]) {
  test(`${reglage} = ${valeur} est refusé`, () => {
    const texte = CONFORME.replace(new RegExp(`^${reglage} = .*$`, "m"), `${reglage} = ${valeur}`);
    assert.deepEqual(codes(analyserConfigurationPostgresql(texte)), [code]);
  });
}

test("la DERNIÈRE affectation fait foi, comme pour PostgreSQL", () => {
  // Un `fsync = off` ajouté en fin de fichier l'emporte sur le `on` du début.
  assert.deepEqual(codes(analyserConfigurationPostgresql(`${CONFORME}fsync = off\n`)), [
    "pg-fsync-affaibli",
  ]);
  // Et l'inverse : un `off` corrigé plus bas est accepté.
  assert.deepEqual(analyserConfigurationPostgresql(`fsync = off\n${CONFORME}`), []);
});

test("un réglage de durabilité ABSENT est refusé : la valeur par défaut ne décide pas", () => {
  const sansFsync = CONFORME.replace(/^fsync = .*\n/m, "");
  assert.deepEqual(codes(analyserConfigurationPostgresql(sansFsync)), ["pg-reglage-absent"]);
});

test("les graphies de « vrai » que PostgreSQL accepte passent", () => {
  for (const vrai of ["on", "ON", "true", "yes", "1", "'on'", '"on"']) {
    const texte = CONFORME.replace(/^fsync = .*$/m, `fsync = ${vrai}`);
    assert.deepEqual(analyserConfigurationPostgresql(texte), [], `fsync = ${vrai}`);
  }
  // `=` est facultatif, et un commentaire en fin de ligne n'est pas la valeur.
  const sansEgal = CONFORME.replace(/^fsync = .*$/m, "fsync on   # exigé, ADR 0056");
  assert.deepEqual(analyserConfigurationPostgresql(sansEgal), []);
});

test("une inclusion est refusée : ce qu'elle apporte n'est pas vérifiable ici", () => {
  for (const directive of [
    "include 'autre.conf'",
    "include_if_exists 'autre.conf'",
    "include_dir 'conf.d'",
  ]) {
    assert.deepEqual(codes(analyserConfigurationPostgresql(`${CONFORME}${directive}\n`)), [
      "pg-inclusion-refusee",
    ]);
  }
});

test("un contrôle d'intégrité désarmé est refusé", () => {
  for (const reglage of ["ignore_checksum_failure", "zero_damaged_pages", "data_sync_retry"]) {
    assert.deepEqual(codes(analyserConfigurationPostgresql(`${CONFORME}${reglage} = on\n`)), [
      "pg-controle-desarme",
    ]);
    assert.deepEqual(analyserConfigurationPostgresql(`${CONFORME}${reglage} = off\n`), []);
  }
});

test("un initdb SANS sommes de contrôle est refusé", () => {
  assert.deepEqual(analyserLanceurPostgresql(LANCEUR_CONFORME), []);
  assert.deepEqual(analyserLanceurPostgresql('initdb -k --pgdata="$PGDATA"\n'), []);
  assert.deepEqual(codes(analyserLanceurPostgresql('initdb --pgdata="$PGDATA"\n')), [
    "pg-sommes-de-controle-absentes",
  ]);
  // Un lanceur qui n'initialise rien ne prouve pas les sommes de contrôle.
  assert.deepEqual(codes(analyserLanceurPostgresql("pg_ctl start\n")), [
    "pg-sommes-de-controle-absentes",
  ]);
});

test("une surcharge en ligne de commande qui affaiblit est refusée", () => {
  for (const surcharge of [
    "-c fsync=off",
    "-c synchronous_commit=local",
    "-c full_page_writes=false",
    "--fsync=off",
  ]) {
    const lanceur = `${LANCEUR_CONFORME}postgres -D "$PGDATA" ${surcharge}\n`;
    assert.deepEqual(codes(analyserLanceurPostgresql(lanceur)), ["pg-surcharge-affaiblie"]);
  }
  // `postgres -F` désactive fsync : c'est l'option courte historique.
  assert.deepEqual(codes(analyserLanceurPostgresql(`${LANCEUR_CONFORME}postgres -F -D x\n`)), [
    "pg-surcharge-affaiblie",
  ]);
});

test("ALTER SYSTEM est refusé dans le lanceur : il écrirait dans le volume, hors de l'outil", () => {
  const lanceur = `${LANCEUR_CONFORME}psql -c "ALTER SYSTEM SET fsync = off"\n`;
  assert.deepEqual(codes(analyserLanceurPostgresql(lanceur)), ["pg-surcharge-affaiblie"]);
});

test("le lecteur de réglages ignore commentaires et lignes vides", () => {
  const reglages = lireLesReglages("# fsync = off\n\n  shared_buffers = '16MB' # mémoire\n");
  assert.equal(reglages.valeurs.get("shared_buffers")?.valeur, "16MB");
  assert.equal(reglages.valeurs.has("fsync"), false);
});

test("verify-pinning refuse une configuration affaiblie du guest", () => {
  // La garde est branchée sur la vérification qui précède TOUTE construction : sans ce
  // branchement, l'épreuve ci-dessus ne protégerait que ce module, pas l'image.
  const { anomalies } = verifierEpinglage({
    configurationPostgresql: CONFIGURATION_REELLE.replace(/^fsync = on$/m, "fsync = off"),
  });
  assert.ok(
    anomalies.some((anomalie) => anomalie.code === "pg-fsync-affaibli"),
    anomalies.map((anomalie) => anomalie.message).join("\n"),
  );
  assert.deepEqual(verifierEpinglage().anomalies, []);
});

test("la version MAJEURE de PostgreSQL est celle de sources.json, partout", () => {
  const sources = { postgresql: { version: "15" } };
  const dockerfile = "RUN apt-get install -y postgresql-15 postgresql-client-15\n";
  const lanceur = "PG_VERSION=15\n";
  assert.deepEqual(analyserVersionPostgresql({ sources, dockerfile, lanceur }), []);
  // Une autre majeure installée, un lanceur qui en nomme une autre, aucun paquet, aucune version.
  for (const cas of [
    { sources, dockerfile: `${dockerfile}RUN apt-get install postgresql-16\n`, lanceur },
    { sources, dockerfile, lanceur: "PG_VERSION=16\n" },
    { sources, dockerfile, lanceur: "" },
    { sources, dockerfile: "RUN true\n", lanceur },
    { sources: {}, dockerfile, lanceur },
    { sources: { postgresql: { version: "15.4" } }, dockerfile, lanceur },
  ]) {
    assert.deepEqual(
      [...new Set(codes(analyserVersionPostgresql(cas)))],
      ["pg-version-non-epinglee"],
      JSON.stringify(cas),
    );
  }
});

test("la chaîne réelle épingle la même majeure dans le Dockerfile, le lanceur et sources.json", () => {
  const dossier = join(RACINE, "tools", "build-reference-image");
  const sources = JSON.parse(readFileSync(join(dossier, "sources.json"), "utf8"));
  const dockerfile = readFileSync(join(dossier, "guest.Dockerfile"), "utf8");
  assert.deepEqual(analyserVersionPostgresql({ sources, dockerfile, lanceur: LANCEUR_REEL }), []);
  assert.equal(sources.postgresql.version, LANCEUR_REEL.match(/^PG_VERSION=(\d+)$/m)[1]);
});
