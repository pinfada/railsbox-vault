/**
 * Le Ruby que l'application DEMANDE, confronté au seul Ruby du guest (#342).
 *
 * Provenance : ces cas sont repris de `pinfada/railsbox`, `tests/ruby-requirement.test.mjs` (même
 * propriétaire, licence MIT des deux côtés). Les noms sont passés en français ; les cas et leurs
 * verdicts sont ceux de RailsBox. Les cas propres à RailsBox (table des bases, clé `ruby:` de
 * `railsbox.yml`) ne sont pas repris : le coffre n'a ni bases ni `railsbox.yml`.
 *
 * Ce que ces tests protègent : un Gemfile qui épingle `ruby "3.3.10"` face au guest qui fournit
 * 3.3.12 échouerait au `bundle install` du Dockerfile, plusieurs minutes après le début de la
 * construction, sous la forme d'un `Bundler::RubyVersionMismatch`. La moitié des cas vérifient
 * l'INVERSE : les formes qui doivent passer. Refuser une application qui marche serait pire.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  lireLaDirectiveRuby,
  resoudreLaContrainteRuby,
  satisfaitLaContrainteRuby,
} from "../../tools/paquet/ruby-demande.mjs";

test("la directive est lue sous ses formes littérales et en intervalle", () => {
  assert.deepEqual(lireLaDirectiveRuby('ruby "3.3.10"\n').contraintes, ["3.3.10"]);
  assert.deepEqual(lireLaDirectiveRuby("ruby '~> 3.3.10'\n").contraintes, ["~> 3.3.10"]);
  assert.deepEqual(lireLaDirectiveRuby('ruby ">= 3.1", "< 3.5"\n').contraintes, [
    ">= 3.1",
    "< 3.5",
  ]);
});

test("une directive commentée est ignorée", () => {
  // Un exemple laissé en commentaire ne doit pas devenir la contrainte réelle.
  assert.equal(lireLaDirectiveRuby('# ruby "3.4.0"\ngem "rails"\n'), null);
});

test("la directive n'est pas confondue avec une gemme homonyme", () => {
  assert.equal(lireLaDirectiveRuby('gem "ruby-vips"\ngem "rails"\n'), null);
});

test("la lecture d'un fichier est reconnue, sous ses deux écritures", () => {
  const parFile = lireLaDirectiveRuby('ruby file: ".ruby-version"\n');
  assert.deepEqual(
    { forme: parFile.forme, chemin: parFile.chemin },
    { forme: "fichier", chemin: ".ruby-version" },
  );
  assert.equal(lireLaDirectiveRuby('ruby File.read(".ruby-version").strip\n').forme, "fichier");
});

test("le fichier désigné devient une égalité stricte", () => {
  // Bundler lit le fichier et en fait un `= 3.3.10` : `ruby file:` n'est pas plus permissif que
  // l'écriture littérale, seulement moins visible. Le préfixe `ruby-` de rbenv est retiré.
  const directive = lireLaDirectiveRuby('ruby file: ".ruby-version"\n');
  const resolue = resoudreLaContrainteRuby(directive, "ruby-3.3.10\n");
  assert.deepEqual([...resolue.contraintes], ["3.3.10"]);
  assert.equal(resolue.provenance, "Gemfile (file: .ruby-version)");
});

test("la sémantique est celle de Gem::Requirement", () => {
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["3.3.10"]), false);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["= 3.3.12"]), true);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["~> 3.3.10"]), true);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["~> 3.3"]), true);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["~> 3.4"]), false);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", [">= 3.1", "< 3.5"]), true);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", [">= 3.1", "< 3.3"]), false);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["!= 3.3.12"]), false);
});

test("la contrainte pessimiste a une borne haute : `~>` ne laisse pas passer la série suivante", () => {
  // Ajout du coffre aux cas de RailsBox : sans lui, retirer la borne de `~>` ne rougissait rien.
  assert.equal(satisfaitLaContrainteRuby("3.4.1", ["~> 3.3.10"]), false);
  assert.equal(satisfaitLaContrainteRuby("4.0.0", ["~> 3.3"]), false);
});

test("rien de vérifiable : le verdict s'abstient plutôt que de refuser à tort", () => {
  assert.equal(satisfaitLaContrainteRuby(null, ["3.3.10"]), null);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", []), null);
  assert.equal(satisfaitLaContrainteRuby("3.3.12", ["jruby"]), null);
});
