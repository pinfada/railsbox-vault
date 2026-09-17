/**
 * Le CONTRAT du paquet applicatif (#236, ADR 0041).
 *
 * `paquet.json` est ce qu'un paquet DÉCLARE : son identité, son schéma, l'empreinte de ses deux
 * images, ce qu'il exige du runtime, d'où vient sa clé de signature. Il est écrit par la
 * fabrication et relu par la publication ; entre les deux, personne ne le devine.
 *
 * Ce que cette suite exige : un paquet conforme passe, et chaque manque est NOMMÉ — un champ
 * absent, une empreinte mal formée, une taille nulle, une version de contrat inconnue. Un
 * validateur qu'on n'a jamais vu dire « non » ne prouve rien.
 *
 * L'IDENTITÉ, elle, vient de trois sources dans un ordre fixe, et une source qui porte un secret
 * Rails fait refuser la fabrication entière : ce sont les deux dernières épreuves.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  VERSION_CONTRAT_PAQUET,
  construirePaquet,
  validerPaquet,
} from "../../tools/paquet/contrat-du-paquet.mjs";
import {
  SECRETS_REFUSES,
  identiteDeLApplication,
  secretsPresents,
} from "../../tools/paquet/identite-de-l-application.mjs";
import { schemaDeLApplication } from "../../tools/paquet/schema-de-l-application.mjs";

const ENTREES = Object.freeze({
  application: { id: "railsbox-vault-reference", version: "1.0.0", schema: "20260815120000" },
  image: { name: "railsbox-vault-reference-1.0.0-0123abcd.ext4", byteSize: 147 * 1024 * 1024 },
  graine: {
    name: "railsbox-vault-reference-1.0.0-graine-89abcdef.ext4",
    byteSize: 536870912,
    disqueOctets: 536870912,
  },
  exigences: { ruby: "3.3.12", rails: "8.1.3.1", debianSuite: "bookworm" },
  secretKeyBase: { derivation: "sha256 d'une chaîne publique documentée" },
  licence: "MIT (RailsBox Vault)",
  genereLe: "2026-09-17T19:00:00.000Z",
});

const EMPREINTE = "a".repeat(64);
const AUTRE_EMPREINTE = "b".repeat(64);

function paquetConforme(remplacements = {}) {
  return construirePaquet({
    ...ENTREES,
    image: { ...ENTREES.image, sha256: EMPREINTE },
    graine: { ...ENTREES.graine, sha256: AUTRE_EMPREINTE },
    ...remplacements,
  });
}

test("un paquet conforme est accepté et porte sa version de contrat", () => {
  const paquet = paquetConforme();

  assert.equal(paquet.contractVersion, VERSION_CONTRAT_PAQUET);
  assert.equal(paquet.application.id, "railsbox-vault-reference");
  assert.equal(paquet.application.schema, "20260815120000");
  assert.equal(paquet.image.sha256, EMPREINTE);
  assert.equal(paquet.graine.disqueOctets, 536870912);
  assert.equal(paquet.exigences.ruby, "3.3.12");
  assert.deepEqual(validerPaquet(paquet), []);
});

test("un champ absent est nommé, jamais deviné", () => {
  for (const [chemin, code] of [
    ["application.id", "application-incomplete"],
    ["application.version", "application-incomplete"],
    ["application.schema", "application-incomplete"],
    ["image.name", "image-invalide"],
    ["graine.name", "graine-invalide"],
    ["exigences.ruby", "exigences-incompletes"],
    ["secretKeyBase.derivation", "derivation-absente"],
  ]) {
    const paquet = paquetConforme();
    const [objet, champ] = chemin.split(".");
    delete paquet[objet][champ];
    const anomalies = validerPaquet(paquet);
    assert.ok(
      anomalies.some((anomalie) => anomalie.code === code),
      `${chemin} absent devrait rendre ${code} : ${JSON.stringify(anomalies)}`,
    );
  }
});

test("une empreinte mal formée est refusée, pour l'image comme pour la graine", () => {
  for (const partie of ["image", "graine"]) {
    const paquet = paquetConforme();
    paquet[partie].sha256 = "pas-une-empreinte";
    assert.ok(
      validerPaquet(paquet).some((anomalie) => anomalie.code.startsWith(partie)),
      `${partie} : une empreinte mal formée doit être refusée`,
    );
  }
});

test("une taille nulle ou non entière est refusée", () => {
  for (const [partie, champ, valeur] of [
    ["image", "byteSize", 0],
    ["graine", "byteSize", -1],
    ["graine", "disqueOctets", 1.5],
  ]) {
    const paquet = paquetConforme();
    paquet[partie][champ] = valeur;
    assert.ok(validerPaquet(paquet).length > 0, `${partie}.${champ} = ${valeur} doit être refusé`);
  }
});

test("une version de contrat inconnue est refusée plutôt que devinée", () => {
  const paquet = paquetConforme();
  paquet.contractVersion = 2;

  assert.ok(validerPaquet(paquet).some((anomalie) => anomalie.code === "contrat-inconnu"));
  assert.ok(validerPaquet(null).some((anomalie) => anomalie.code === "paquet-invalide"));
});

test("le nom des images porte l'identité, la version et le début de l'empreinte", () => {
  const paquet = paquetConforme();

  assert.match(paquet.image.name, /^railsbox-vault-reference-1\.0\.0-[0-9a-f]{8}\.ext4$/);
  assert.ok(paquet.graine.name.includes("graine"));
});

test("l'identité vient des options, puis de vault-app.json, puis de l'invariant", () => {
  const vaultApp = {
    application: { id: "depuis-vault-app", version: "2.0.0" },
    secretKeyBase: { derivation: "chaîne publique de l'application" },
  };
  const invariant = { application: { id: "depuis-invariant", version: "1.0.0" } };

  assert.equal(
    identiteDeLApplication({ options: { id: "choisi", version: "3.1.4" } }).id,
    "choisi",
  );
  assert.equal(identiteDeLApplication({ options: {}, vaultApp }).id, "depuis-vault-app");
  assert.equal(identiteDeLApplication({ options: {}, vaultApp }).version, "2.0.0");
  assert.equal(
    identiteDeLApplication({ options: {}, vaultApp }).secretKeyBase.derivation,
    "chaîne publique de l'application",
  );
  assert.equal(identiteDeLApplication({ options: {}, invariant }).id, "depuis-invariant");
  assert.equal(
    identiteDeLApplication({ options: { version: "9.9.9" }, vaultApp }).version,
    "9.9.9",
    "une option l'emporte champ par champ",
  );
});

test("une identité introuvable, mal formée ou vide est refusée", () => {
  assert.throws(() => identiteDeLApplication({ options: {} }), /identité/i);
  assert.throws(
    () => identiteDeLApplication({ options: { id: "MAJUSCULES", version: "1.0.0" } }),
    /identifiant/i,
  );
  assert.throws(
    () => identiteDeLApplication({ options: { id: "bon", version: "pas-semver" } }),
    /version/i,
  );
});

test("un secret Rails dans la source fait refuser la fabrication", () => {
  const presents = secretsPresents(["Gemfile", "config/master.key", "app/models/note.rb"]);

  assert.deepEqual(presents, ["config/master.key"]);
  assert.deepEqual(secretsPresents(["Gemfile", "config/credentials.yml.enc"]), [
    "config/credentials.yml.enc",
  ]);
  assert.deepEqual(secretsPresents(["Gemfile", "app/models/note.rb"]), []);
  assert.ok(SECRETS_REFUSES.length >= 2);
});

test("le schéma vient du dump quand il existe, de la dernière migration sinon", () => {
  assert.equal(
    schemaDeLApplication({
      schemaRb: 'ActiveRecord::Schema[8.0].define(version: "20260815120000") do\nend\n',
      migrations: ["20260101000001_create_records.rb"],
    }),
    "20260815120000",
  );
  assert.equal(
    schemaDeLApplication({
      migrations: [
        "20260101000002_create_active_storage_tables.rb",
        "20260101000001_create_records.rb",
      ],
    }),
    "20260101000002",
  );
  assert.equal(
    schemaDeLApplication({ migrations: ["9_ancienne.rb", "20260101000001_x.rb"] }),
    "20260101000001",
  );
});

test("une application sans migration n'est pas empaquetable", () => {
  assert.throws(() => schemaDeLApplication({ migrations: [] }), /schéma/i);
  assert.throws(() => schemaDeLApplication({ schemaRb: "# rien ici", migrations: [] }), /schéma/i);
});
