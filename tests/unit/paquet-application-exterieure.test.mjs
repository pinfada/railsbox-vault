// Une application Rails EXTÉRIEURE, non modifiée, se fabrique (#351).
//
// L'essai réel du 28/11/2026 a buté sur des gardes qui obligeaient l'APPLICATION à s'adapter à
// l'outil. Chaque épreuve ci-dessous en tient une, et la dernière les joue toutes sur une vraie
// application `rails new`, versionnée en CRLF, dont le verrou ne connaît que `x86_64-linux`
// (`tests/fixtures/application-rails-new/`).

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  RACINE_DEPOT,
  examinerLaSource,
  preparerLArbreDuPaquet,
} from "../../tools/paquet/fabriquer-paquet.mjs";
import { finsDeLigneNormalisees } from "../../tools/paquet/fins-de-ligne.mjs";
import { identifiantsChiffresSansCle } from "../../tools/paquet/identifiants-chiffres.mjs";
import { secretsPresents } from "../../tools/paquet/identite-de-l-application.mjs";
import { schemaDeLApplication } from "../../tools/paquet/schema-de-l-application.mjs";

const FIXTURE = join(RACINE_DEPOT, "tests", "fixtures", "application-rails-new");
const DOCKERFILE = readFileSync(
  join(RACINE_DEPOT, "tools", "build-reference-image", "guest.Dockerfile"),
  "utf8",
);

// --- Le schéma ---------------------------------------------------------------------------------

test("un schema.rb à soulignés donne la version entière, sans ses soulignés", () => {
  const schemaRb = "ActiveRecord::Schema[8.0].define(version: 2026_08_18_213000) do\nend\n";
  assert.equal(schemaDeLApplication({ schemaRb, migrations: [] }), "20260818213000");
});

test("une application sans migration a le schéma 0, celui qu'ActiveRecord lui donne", () => {
  assert.equal(schemaDeLApplication({ migrations: [] }), "0");
  assert.equal(schemaDeLApplication({ schemaRb: "# rien ici", migrations: [] }), "0");
});

// --- Les identifiants chiffrés -------------------------------------------------------------------

test("credentials.yml.enc SANS master.key est exclu : il n'ouvre rien", () => {
  assert.deepEqual(identifiantsChiffresSansCle(["Gemfile", "config/credentials.yml.enc"]), [
    "config/credentials.yml.enc",
  ]);
  assert.deepEqual(
    identifiantsChiffresSansCle(["config/credentials/staging.yml.enc", "config/routes.rb"]),
    ["config/credentials/staging.yml.enc"],
  );
});

test("credentials.yml.enc AVEC sa clé n'est pas exclu : la paire reste refusée", () => {
  const paire = ["config/credentials.yml.enc", "config/master.key"];
  assert.deepEqual(identifiantsChiffresSansCle(paire), []);
  assert.deepEqual(secretsPresents(paire), paire);
  const parEnvironnement = ["config/credentials/staging.yml.enc", "config/credentials/staging.key"];
  assert.deepEqual(identifiantsChiffresSansCle(parEnvironnement), []);
});

// --- Les fins de ligne ---------------------------------------------------------------------------

test("un fichier texte en CRLF passe en LF", () => {
  const { octets, normalise } = finsDeLigneNormalisees(
    Buffer.from("#!/usr/bin/env ruby\r\nputs 1\r\n"),
  );
  assert.equal(octets.toString("utf8"), "#!/usr/bin/env ruby\nputs 1\n");
  assert.equal(normalise, true);
});

test("un fichier binaire n'est pas touché, même s'il porte des CRLF", () => {
  const binaire = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a]);
  const { octets, normalise } = finsDeLigneNormalisees(binaire);
  assert.deepEqual(octets, binaire);
  assert.equal(normalise, false);
});

test("un fichier déjà en LF, ou un CR isolé, ne change pas", () => {
  assert.equal(finsDeLigneNormalisees(Buffer.from("a\nb\n")).normalise, false);
  const isole = Buffer.from("a\rb\n");
  assert.deepEqual(finsDeLigneNormalisees(isole).octets, isole);
  // Dans un fichier qui porte AUSSI des CRLF, le CR isolé reste.
  assert.equal(finsDeLigneNormalisees(Buffer.from("a\rb\r\n")).octets.toString(), "a\rb\n");
});

// --- Les plateformes du verrou ---------------------------------------------------------------------

test("le verrou gagne la plateforme `ruby` avant `bundle install`, et la garde après la copie", () => {
  const ajout = DOCKERFILE.indexOf("bundle lock --add-platform ruby");
  const installation = DOCKERFILE.indexOf("linux32 bundle install");
  const copie = DOCKERFILE.indexOf("COPY --from=application . ./");
  const retour = DOCKERFILE.indexOf("cp /opt/vault-verrou/Gemfile.lock Gemfile.lock");
  assert.ok(ajout > 0, "la plateforme est ajoutée");
  assert.ok(ajout < installation, "avant l'installation");
  assert.ok(retour > copie, "le verrou augmenté revient après la copie de l'application");
});

// --- L'application `rails new`, toutes gardes jouées ---------------------------------------------

test("la fixture est bien une application `rails new` en CRLF, verrou x86_64-linux seul", () => {
  const binRails = readFileSync(join(FIXTURE, "bin", "rails"), "utf8");
  assert.match(binRails, /^#!\/usr\/bin\/env ruby\r\n/);
  const verrou = readFileSync(join(FIXTURE, "Gemfile.lock"), "utf8");
  assert.match(verrou, /\r\nPLATFORMS\r\n {2}x86_64-linux\r\n\r\n/);
});

test("une application Rails ordinaire, non modifiée, passe l'examen de la source", () => {
  const examen = examinerLaSource(FIXTURE, { id: "rails-new", version: "1.0.0" });
  // `db/schema.rb` écrit `define(version: 2026_11_28_085132)` : la version entière, sans soulignés.
  assert.equal(examen.schema, "20261128085132");
  assert.deepEqual(examen.exclus, ["config/credentials.yml.enc"]);
  assert.ok(!examen.fichiers.includes("config/credentials.yml.enc"));
  assert.ok(!examen.fichiers.includes("config/master.key"));
});

test("l'arbre du paquet normalise les textes de la source sans toucher ses binaires", () => {
  const examen = examinerLaSource(FIXTURE, { id: "rails-new", version: "1.0.0" });
  const { arbre, normalises } = preparerLArbreDuPaquet(FIXTURE, examen.fichiers);
  try {
    assert.equal(
      readFileSync(join(arbre, "bin", "rails"), "utf8").split("\n")[0],
      "#!/usr/bin/env ruby",
    );
    assert.ok(normalises.includes("bin/rails"));
    assert.ok(normalises.includes("Gemfile.lock"));
    assert.deepEqual(
      readFileSync(join(arbre, "public", "icon.png")),
      readFileSync(join(FIXTURE, "public", "icon.png")),
    );
    assert.ok(!normalises.includes("public/icon.png"));
    // La SOURCE, elle, n'a pas bougé.
    assert.match(readFileSync(join(FIXTURE, "bin", "rails"), "utf8"), /\r\n/);
  } finally {
    rmSync(arbre, { recursive: true, force: true });
  }
});

// --- La durabilité des données d'une application ordinaire -----------------------------------------

test("`storage/` du paquet est un lien vers le disque de données, posé avant `db:migrate`", () => {
  const lien = DOCKERFILE.indexOf("ln -sfn var/storage storage");
  const migration = DOCKERFILE.indexOf("linux32 ruby bin/rails db:migrate");
  assert.ok(lien > 0, "le lien est posé");
  assert.ok(lien < migration, "avant que les bases naissent");
});

test("la durabilité est chargée dans le guest et constatée à la fabrication", () => {
  assert.match(DOCKERFILE, /echo 'export RUBYOPT=-r\/opt\/vault\/durabilite-rails\.rb'/);
  assert.match(DOCKERFILE, /bin\/rails runner \/opt\/vault\/verifier-durabilite\.rb/);
});
