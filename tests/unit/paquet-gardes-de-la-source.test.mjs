/**
 * Les trois gardes de la source ajoutées par #342, sur des DÉPÔTS PIÉGÉS construits ici.
 *
 *  1. le Ruby que l'application demande est confronté au seul Ruby du guest (`sources.json`) ;
 *  2. les secrets sont cherchés dans le CONTENU des fichiers, et plus seulement dans leur nom ;
 *  3. un lien symbolique n'entre pas dans le paquet : la copie le suivrait.
 *
 * Toutes refusent AVANT le premier `docker build`, avec un rapport qui dit ce qui bloque, pourquoi,
 * et quoi changer. Le témoin — une application propre — passe, et la référence aussi.
 *
 * ## Les liens symboliques sous Windows
 *
 * Créer un lien symbolique sous Windows exige le privilège `SeCreateSymbolicLinkPrivilege` (ou le
 * mode développeur). Sans lui, `symlink` lève EPERM : le cas est alors SAUTÉ, et le saut le dit.
 * Le saut n'existe QUE sous `win32` : ailleurs, la même erreur fait échouer le test, et la CI
 * (Linux) le joue toujours.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import {
  examinerLaSource,
  fabriquerLePaquet,
  RACINE_DEPOT,
} from "../../tools/paquet/fabriquer-paquet.mjs";

const RUBY_DU_GUEST = JSON.parse(
  readFileSync(join(RACINE_DEPOT, "tools", "build-reference-image", "sources.json"), "utf8"),
).ruby.version;

const IDENTITE = { id: "application-piegee", version: "1.0.0" };

const crees = [];
after(() => {
  for (const dossier of crees) rmSync(dossier, { recursive: true, force: true });
});

/** Une application Rails PROPRE, minimale : ce que les pièges modifient. */
const APPLICATION_PROPRE = Object.freeze({
  Gemfile: 'source "https://rubygems.org"\n\ngem "rails", "~> 8.0"\ngem "sqlite3"\n',
  "Gemfile.lock": "GEM\n  specs:\n    railties (8.0.2)\n",
  "config/database.yml":
    "production:\n  adapter: sqlite3\n  database: <%= ENV.fetch('VAULT_DATABASE_PATH') %>\n",
  "config/application.rb": "module Piegee\n  class Application < Rails::Application\n  end\nend\n",
  "app/models/user.rb": "class User < ApplicationRecord\n  has_secure_password\nend\n",
  "db/migrate/20260101000001_create_users.rb":
    "class CreateUsers < ActiveRecord::Migration[8.0]\nend\n",
  "db/seeds.rb": 'User.create!(email: "demo@example.com")\n',
});

/** Pose une application dans un dossier temporaire, la propre modifiée par `pieges`. */
function application(pieges = {}) {
  const racine = mkdtempSync(join(tmpdir(), "vault-342-"));
  crees.push(racine);
  for (const [relatif, contenu] of Object.entries({ ...APPLICATION_PROPRE, ...pieges })) {
    if (contenu === null) continue;
    const chemin = join(racine, relatif);
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, contenu, "utf8");
  }
  return racine;
}

/** Le refus attendu : une erreur qui porte ses anomalies, dont une du code demandé. */
function refusePour(code) {
  return (erreur) => {
    assert.ok(Array.isArray(erreur.anomalies), `refus sans anomalies : ${erreur.message}`);
    assert.ok(
      erreur.anomalies.some((anomalie) => anomalie.code === code),
      `aucune anomalie « ${code} » dans :\n${erreur.message}`,
    );
    return true;
  };
}

/**
 * Pose un lien symbolique, ou SAUTE le test sous Windows sans le privilège requis (voir l'en-tête).
 * Rend `false` si le test a été sauté.
 */
function lier(t, cible, lien, type = "file") {
  mkdirSync(dirname(lien), { recursive: true });
  try {
    symlinkSync(cible, lien, type);
    return true;
  } catch (erreur) {
    if (process.platform === "win32" && erreur.code === "EPERM") {
      t.skip(
        "Windows sans SeCreateSymbolicLinkPrivilege ni mode développeur : lien impossible à poser ici ; la CI Linux joue ce cas.",
      );
      return false;
    }
    throw erreur;
  }
}

test("témoin : une application propre passe les trois gardes", () => {
  const examen = examinerLaSource(application(), IDENTITE);
  assert.equal(examen.id, "application-piegee");
  assert.ok(examen.fichiers.includes("config/database.yml"));
});

test("témoin : l'application de RÉFÉRENCE passe aussi, sans aucune anomalie", () => {
  const examen = examinerLaSource(join(RACINE_DEPOT, "apps", "reference"), {});
  assert.equal(examen.id, "railsbox-vault-reference");
  assert.ok(examen.fichiers.includes("Gemfile"));
});

// --- 1. Le Ruby demandé --------------------------------------------------------------------------

test("une directive `ruby` que le Ruby du guest ne satisfait pas est refusée", () => {
  const source = application({
    Gemfile: `ruby "3.4.1"\n${APPLICATION_PROPRE.Gemfile}`,
  });
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("ruby-incompatible"));
  try {
    examinerLaSource(source, IDENTITE);
  } catch (erreur) {
    // Le rapport nomme les deux versions, et dit quoi changer.
    assert.match(erreur.message, /3\.4\.1/);
    assert.match(erreur.message, new RegExp(RUBY_DU_GUEST.replaceAll(".", "\\.")));
    assert.match(erreur.message, /Quoi changer/);
  }
});

test('`ruby file: ".ruby-version"` est une égalité stricte, refusée si elle n\'est pas le guest', () => {
  const source = application({
    Gemfile: `ruby file: ".ruby-version"\n${APPLICATION_PROPRE.Gemfile}`,
    ".ruby-version": "ruby-3.3.10\n",
  });
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("ruby-incompatible"));
});

test('`ruby file: ".ruby-version"` égal au Ruby du guest passe', () => {
  const source = application({
    Gemfile: `ruby file: ".ruby-version"\n${APPLICATION_PROPRE.Gemfile}`,
    ".ruby-version": `${RUBY_DU_GUEST}\n`,
  });
  assert.equal(examinerLaSource(source, IDENTITE).id, "application-piegee");
});

test("`ruby file:` qui désigne un fichier absent du paquet est refusé : Bundler ne le lirait pas", () => {
  const source = application({
    Gemfile: `ruby file: ".ruby-version"\n${APPLICATION_PROPRE.Gemfile}`,
  });
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("ruby-fichier-absent"));
});

test("aucune directive `ruby` : Bundler n'exige rien, la source est acceptée", () => {
  // Un `.ruby-version` SEUL n'engage pas Bundler : il parle à rbenv, pas au `bundle install`.
  const source = application({ ".ruby-version": "3.2.9\n" });
  assert.equal(examinerLaSource(source, IDENTITE).id, "application-piegee");
});

test("une contrainte pessimiste compatible passe", () => {
  const source = application({ Gemfile: `ruby "~> 3.3.10"\n${APPLICATION_PROPRE.Gemfile}` });
  assert.equal(examinerLaSource(source, IDENTITE).id, "application-piegee");
});

// --- 2. Les secrets par contenu ------------------------------------------------------------------

test("un mot de passe dans config/database.yml, nom de fichier anodin, est refusé", () => {
  const source = application({
    "config/database.yml": "production:\n  adapter: postgresql\n  password: s3cr3t-de-prod\n",
  });
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("secret-dans-le-contenu"));
  try {
    examinerLaSource(source, IDENTITE);
  } catch (erreur) {
    assert.match(erreur.message, /config\/database\.yml/);
    assert.equal(erreur.message.includes("s3cr3t-de-prod"), false, "la valeur n'est jamais citée");
  }
});

test("un jeton dans db/seeds.rb est refusé", () => {
  const source = application({
    "db/seeds.rb": 'Forge.create!(jeton: "ghp_0123456789abcdefghijklmnopqrstuvwxyz")\n',
  });
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("secret-dans-le-contenu"));
});

test("un mot de passe de démonstration DÉCLARÉ public dans vault-app.json passe", () => {
  const source = application({
    "db/seeds.rb": 'User.create!(email: "demo@example.com", password: "demo1234")\n',
    "vault-app.json": JSON.stringify({
      application: IDENTITE,
      secretsAssumesPublics: [{ fichier: "db/seeds.rb", cle: "password" }],
    }),
  });
  assert.throws(
    () =>
      examinerLaSource(
        application({
          "db/seeds.rb": 'User.create!(email: "demo@example.com", password: "demo1234")\n',
        }),
        IDENTITE,
      ),
    refusePour("secret-dans-le-contenu"),
  );
  assert.equal(examinerLaSource(source, {}).id, "application-piegee");
});

// --- 3. Les liens symboliques --------------------------------------------------------------------

test("un lien au nom anodin vers un fichier EXCLU est refusé", (t) => {
  const source = application({ "log/production.log": "jeton=xyz\n" });
  if (!lier(t, join(source, "log", "production.log"), join(source, "config", "notes.txt"))) return;
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("lien-symbolique"));
});

test("un lien vers l'EXTÉRIEUR de la source est refusé", (t) => {
  const dehors = mkdtempSync(join(tmpdir(), "vault-342-dehors-"));
  crees.push(dehors);
  writeFileSync(join(dehors, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n", "utf8");
  const source = application();
  if (!lier(t, join(dehors, "id_ed25519"), join(source, "config", "deploiement.txt"))) return;
  assert.throws(
    () => examinerLaSource(source, IDENTITE),
    (erreur) => {
      refusePour("lien-symbolique")(erreur);
      assert.match(erreur.message, /hors de la source/);
      return true;
    },
  );
});

test("un lien vers un DOSSIER est refusé par un rapport, sans être lu", (t) => {
  // Le parcours du disque le prend pour un fichier ; le lire lèverait EISDIR au lieu d'un rapport.
  const source = application();
  if (!lier(t, join(source, "app"), join(source, "config", "alias-de-app"), "dir")) return;
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("lien-symbolique"));
});

test("un lien est refusé aussi quand la source est un dépôt git (liste de `git ls-files`)", (t) => {
  const source = application();
  if (!lier(t, join(source, "Gemfile"), join(source, "config", "copie-du-gemfile"))) return;
  const init = spawnSync("git", ["-C", source, "init", "-q"], { encoding: "utf8" });
  if (init.status !== 0) assert.fail(`git init a échoué : ${init.stderr}`);
  assert.throws(() => examinerLaSource(source, IDENTITE), refusePour("lien-symbolique"));
});

// --- Avant le premier `docker build` -------------------------------------------------------------

test("la fabrication refuse AVANT toute étape Docker, et rapporte tout ce qui bloque", async () => {
  const source = application({
    Gemfile: `ruby "3.4.1"\n${APPLICATION_PROPRE.Gemfile}`,
    "config/database.yml": "production:\n  password: s3cr3t-de-prod\n",
  });
  // Sans Docker dans le PATH : si la fabrication allait jusqu'à Docker, le message le dirait.
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      fabriquerLePaquet(["--source", source, "--id", IDENTITE.id, "--version", IDENTITE.version]),
      (erreur) => {
        assert.doesNotMatch(erreur.message, /Docker est indisponible/);
        refusePour("ruby-incompatible")(erreur);
        refusePour("secret-dans-le-contenu")(erreur);
        assert.match(erreur.message, /Rien n'a été construit/);
        return true;
      },
    );
  } finally {
    process.env.PATH = path;
  }
});
