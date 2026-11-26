/**
 * La GARDE de l'environnement `production` (#45) : `environment: production` seul ne protège rien — GitHub crée
 * un environnement ABSENT sans aucune règle. L'envoi refuse donc un environnement sans relecteur requis.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as garde from "../../tools/publier-garde-environnement.mjs";

const OUTIL = fileURLToPath(
  new URL("../../tools/publier-garde-environnement.mjs", import.meta.url),
);
const protege = {
  name: "production",
  protection_rules: [
    { id: 1, type: "wait_timer", wait_timer: 0 },
    {
      id: 2,
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { login: "mainteneur" } }],
    },
  ],
};
const lancer = (entree) =>
  spawnSync(process.execPath, [OUTIL], { input: entree, encoding: "utf8" });

test("des relecteurs requis : l'environnement est protégé", () => {
  assert.equal(garde.relecteursRequis(protege), 1);
  assert.equal(lancer(JSON.stringify(protege)).status, 0);
});

test("un environnement SANS règle, ou avec une règle sans relecteur, est refusé", () => {
  for (const environnement of [
    { name: "production", protection_rules: [] },
    { name: "production" },
    { name: "production", protection_rules: [{ type: "wait_timer" }] },
    { name: "production", protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
  ]) {
    assert.equal(garde.relecteursRequis(environnement), 0);
    const r = lancer(JSON.stringify(environnement));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Envoi REFUSÉ/);
  }
});

test("une réponse illisible ou absente est refusée (la garde échoue FERMÉE)", () => {
  assert.equal(lancer("").status, 1);
  assert.equal(lancer("pas du json").status, 1);
  assert.equal(lancer(JSON.stringify({ message: "Not Found" })).status, 1);
});
