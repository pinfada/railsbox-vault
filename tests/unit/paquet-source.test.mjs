/**
 * Ce qui ENTRE dans un paquet, et ce qui n'y entre JAMAIS (#236, revue de sécurité, constats 1 et 2).
 *
 * Deux défauts, reproduits par la revue sur un paquet réel relu au `debugfs` :
 *
 *  1. le balayage de secrets IGNORAIT `.git/`, `vendor/`, `log/` et `tmp/`, tandis que la copie du
 *    Dockerfile les PRENAIT : les deux listes étaient exactement complémentaires, si bien que
 *    l'historique Git entier d'une application tierce — anciennes clés comprises — partait dans une
 *    image servie à tout visiteur ;
 *  2. le refus de secrets était une LISTE FERMÉE de trois chemins : `config/credentials/staging.key`,
 *    clé Rails par environnement, la traversait.
 *
 * La correction tient en une règle : **une seule liste décide de ce qui entre**, et c'est elle que le
 * balayage de secrets parcourt. Ce qui n'entre pas ne peut pas fuir ; ce qui entre est examiné.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cheminExclu,
  fichiersRetenus,
  MOTIFS_EXCLUS,
} from "../../tools/paquet/exclusions-de-la-source.mjs";
import { SECRETS_REFUSES, secretsPresents } from "../../tools/paquet/identite-de-l-application.mjs";
import { annonceDeRemplacement } from "../../tools/paquet/fabriquer-paquet.mjs";

test("l'historique Git, les dépendances et les journaux n'entrent JAMAIS dans un paquet", () => {
  for (const chemin of [
    ".git/config",
    ".git/objects/ab/cdef",
    "node_modules/rails/lib/rails.rb",
    "vendor/bundle/ruby/3.3.0/gems/x.rb",
    "log/production.log",
    "tmp/cache/bootsnap/x",
    "var/db/vault.sqlite3",
    ".bundle/config",
    "coverage/index.html",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(cheminExclu(chemin), true, `${chemin} devrait être exclu`);
  }
});

test("le code de l'application, lui, entre", () => {
  for (const chemin of [
    "Gemfile",
    "Gemfile.lock",
    "config/application.rb",
    "app/models/note.rb",
    "db/migrate/20260101000001_create_records.rb",
    "public/favicon.ico",
    "bin/rails",
    "vault-app.json",
  ]) {
    assert.equal(cheminExclu(chemin), false, `${chemin} devrait entrer`);
  }
});

test("les séparateurs de Windows sont normalisés : un chemin n'échappe pas à la liste par sa barre", () => {
  assert.equal(cheminExclu(".git\\objects\\ab\\cdef"), true);
  assert.equal(cheminExclu("log\\production.log"), true);
});

test("`fichiersRetenus` rend EXACTEMENT ce qui entrera dans l'image", () => {
  const retenus = fichiersRetenus([
    "Gemfile",
    ".git/config",
    "app/models/note.rb",
    "log/production.log",
    "config/master.key",
  ]);

  assert.deepEqual(retenus, ["Gemfile", "app/models/note.rb", "config/master.key"]);
  // `config/master.key` est RETENU par la liste d'exclusion — c'est au refus de secrets de le voir,
  // et c'est justement pour cela que le balayage doit porter sur ce que la copie prend.
  assert.deepEqual(secretsPresents(retenus), ["config/master.key"]);
  assert.ok(MOTIFS_EXCLUS.length > 5);
});

test("une clé Rails par ENVIRONNEMENT est refusée comme la clé maîtresse", () => {
  assert.deepEqual(secretsPresents(["config/credentials/staging.key"]), [
    "config/credentials/staging.key",
  ]);
  assert.deepEqual(secretsPresents(["config/credentials/production.yml.enc"]), [
    "config/credentials/production.yml.enc",
  ]);
});

test("les autres porteurs de secret d'une application Rails sont refusés", () => {
  for (const chemin of [
    "config/master.key",
    "config/credentials.yml.enc",
    ".env",
    ".env.production",
    "config/certificats/serveur.pem",
    "config/cle.p12",
    "config/secret_token.rb",
    "config/api_key.txt",
  ]) {
    assert.deepEqual(secretsPresents([chemin]), [chemin], `${chemin} devrait être refusé`);
  }
});

test("ce qui n'est pas un secret n'est pas refusé : le refus reste utilisable", () => {
  assert.deepEqual(
    secretsPresents([
      "app/models/keyboard.rb",
      "app/controllers/secrets_controller.rb",
      "db/migrate/20260101000001_add_key_to_notes.rb",
      "config/routes.rb",
      "config/environments/production.rb",
      "lib/tasks/keys.rake",
    ]),
    [],
  );
  assert.ok(
    SECRETS_REFUSES.length >= 5,
    "la liste des motifs est publiée pour le message de refus",
  );
});

// Recette QA du 18/09 (#237, défaut 2) : `app:paquet --source <extérieur>` remplaçait le
// `paquet.json` de la référence sans un mot. L'outil DIT désormais ce qu'il remplace, ce qui reste à
// faire pour que le descripteur suive, et comment revenir à la référence.
test("remplacer le paquet servi par un autre le dit, avec l'étape suivante et le retour", () => {
  const ancien = { application: { id: "railsbox-vault-reference", version: "1.0.0" } };
  const nouveau = { application: { id: "mon-application", version: "2.1.0" } };
  const annonce = annonceDeRemplacement(ancien, nouveau);
  assert.match(
    annonce,
    /remplace le paquet servi : railsbox-vault-reference 1\.0\.0 → mon-application 2\.1\.0/,
  );
  assert.match(annonce, /`npm run image:manifest` pour le descripteur/);
  assert.match(annonce, /pour revenir à la référence : `npm run app:paquet` sans `--source`/);
});

test("revenir à la référence le dit, sans conseiller d'y revenir (contre-recette QA de #249, 7)", () => {
  const ancien = { application: { id: "qa-exemple", version: "1.0.0" } };
  const nouveau = { application: { id: "railsbox-vault-reference", version: "1.1.0" } };
  const annonce = annonceDeRemplacement(ancien, nouveau);
  assert.match(annonce, /qa-exemple 1.0.0 → railsbox-vault-reference 1.1.0/);
  assert.doesNotMatch(annonce, /pour revenir à la référence/);
});

test("refabriquer le même paquet, ou le fabriquer une première fois, ne remplace rien", () => {
  const paquet = { application: { id: "railsbox-vault-reference", version: "1.0.0" } };
  assert.equal(annonceDeRemplacement(paquet, structuredClone(paquet)), null);
  assert.equal(annonceDeRemplacement(null, paquet), null);
});
