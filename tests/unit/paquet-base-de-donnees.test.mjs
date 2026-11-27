/**
 * La base de données que l'application DÉCLARE, lue dans `config/database.yml` (#343).
 *
 * L'outil s'adapte à l'application, pas l'inverse (#272) : une application Rails conventionnelle qui
 * déclare `adapter: postgresql` en production reçoit un cluster PostgreSQL, sans rien changer à son
 * code. C'est la production qui décide — la plupart des applications développent sur SQLite et
 * déploient sur PostgreSQL, ou l'inverse —, et la forme à bases NOMMÉES de Rails 6+ est lue comme
 * Rails la lit.
 *
 * Ce qui est refusé l'est avant le premier `docker build`, en clair : une base que le guest ne sait
 * pas faire tourner (MySQL…), un mélange de moteurs, ou une production qui ne dit pas son moteur.
 *
 * Provenance : le principe de lecture (ERB retiré avant tout) vient de RailsBox,
 * `tools/detect/detect.mjs` (`parseDatabaseAdapters`). RailsBox lit TOUS les adaptateurs du fichier ;
 * le coffre ne lit que ceux de la production, parce qu'un `sqlite3` de développement ne dit rien de
 * ce que le paquet exécutera.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  adaptateursDeProduction,
  baseDeDonneesDeLApplication,
} from "../../tools/paquet/base-de-donnees.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (relatif) => readFileSync(join(RACINE, relatif), "utf8");

const codes = (resultat) => resultat.anomalies.map((anomalie) => anomalie.code);

test("l'application générée par `rails new -d postgresql` est une application PostgreSQL", () => {
  const resultat = baseDeDonneesDeLApplication({
    databaseYml: lire("apps/rails-new-postgresql/config/database.yml"),
  });
  assert.deepEqual(resultat, { base: "postgresql", anomalies: [] });
});

test("l'application de référence reste une application SQLite", () => {
  const resultat = baseDeDonneesDeLApplication({
    databaseYml: lire("apps/reference/config/database.yml"),
  });
  assert.deepEqual(resultat, { base: "sqlite3", anomalies: [] });
});

test("c'est la PRODUCTION qui décide, pas le développement", () => {
  const yml = [
    "development:",
    "  adapter: sqlite3",
    "  database: storage/development.sqlite3",
    "production:",
    "  adapter: postgresql",
    "  database: app_production",
    "",
  ].join("\n");
  assert.deepEqual(adaptateursDeProduction(yml), ["postgresql"]);
  assert.equal(baseDeDonneesDeLApplication({ databaseYml: yml }).base, "postgresql");
});

test("un adaptateur hérité par ancre et fusion `<<: *default` est lu", () => {
  const yml = [
    "default: &default",
    "  adapter: postgresql",
    "  encoding: unicode",
    "production:",
    "  <<: *default",
    "  database: app_production",
    "",
  ].join("\n");
  assert.deepEqual(adaptateursDeProduction(yml), ["postgresql"]);
});

test("un adaptateur propre à la production l'emporte sur celui qu'elle fusionne", () => {
  const yml = [
    "default: &default",
    "  adapter: sqlite3",
    "production:",
    "  <<: *default",
    "  adapter: postgresql",
    "",
  ].join("\n");
  assert.deepEqual(adaptateursDeProduction(yml), ["postgresql"]);
});

test("la forme à bases NOMMÉES de Rails 8 est lue base par base", () => {
  const yml = [
    "default: &default",
    "  adapter: postgresql",
    "production:",
    "  primary: &primary_production",
    "    <<: *default",
    "    database: app_production",
    "  cache:",
    "    <<: *primary_production",
    "    database: app_production_cache",
    "    migrations_paths: db/cache_migrate",
    "",
  ].join("\n");
  assert.deepEqual(adaptateursDeProduction(yml), ["postgresql"]);
  assert.equal(baseDeDonneesDeLApplication({ databaseYml: yml }).base, "postgresql");
});

test("les balises ERB et les commentaires ne sont pas des adaptateurs", () => {
  const yml = [
    "# adapter: mysql2",
    "default: &default",
    "  adapter: postgresql # moteur de production",
    '  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>',
    "production:",
    "  <<: *default",
    "",
  ].join("\n");
  assert.deepEqual(adaptateursDeProduction(yml), ["postgresql"]);
});

test("un moteur que le guest ne sait pas faire tourner est refusé en clair", () => {
  const resultat = baseDeDonneesDeLApplication({
    databaseYml: "production:\n  adapter: mysql2\n  database: app\n",
  });
  assert.equal(resultat.base, null);
  assert.deepEqual(codes(resultat), ["base-de-donnees-non-prise-en-charge"]);
  assert.match(resultat.anomalies[0].quoi, /mysql2/);
  assert.equal(resultat.anomalies[0].fichier, "config/database.yml");
});

test("un mélange de moteurs en production est refusé", () => {
  const yml = [
    "production:",
    "  primary:",
    "    adapter: postgresql",
    "  cache:",
    "    adapter: sqlite3",
    "",
  ].join("\n");
  assert.deepEqual(codes(baseDeDonneesDeLApplication({ databaseYml: yml })), [
    "base-de-donnees-mixte",
  ]);
});

test("une production qui ne dit pas son moteur est refusée, pas devinée", () => {
  // `adapter: <%= ENV["DB_ADAPTER"] %>` ou une production réduite à `url:` : le moteur ne se lit pas.
  for (const yml of [
    'production:\n  url: <%= ENV["DATABASE_URL"] %>\n',
    'production:\n  adapter: <%= ENV["DB_ADAPTER"] %>\n',
    "development:\n  adapter: sqlite3\n",
  ]) {
    assert.deepEqual(
      codes(baseDeDonneesDeLApplication({ databaseYml: yml })),
      ["base-de-donnees-indeterminee"],
      yml,
    );
  }
});

test("une application sans config/database.yml est refusée", () => {
  assert.deepEqual(codes(baseDeDonneesDeLApplication({ databaseYml: null })), [
    "base-de-donnees-absente",
  ]);
});

test("chaque refus dit ce qui bloque, pourquoi et quoi changer", () => {
  for (const databaseYml of [null, "production:\n  adapter: mysql2\n", "production:\n  url: x\n"]) {
    for (const anomalie of baseDeDonneesDeLApplication({ databaseYml }).anomalies) {
      for (const champ of ["quoi", "pourquoi", "changer"]) {
        assert.ok(anomalie[champ].length > 20, `${anomalie.code}.${champ}`);
      }
    }
  }
});
