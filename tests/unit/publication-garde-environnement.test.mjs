/**
 * La GARDE de l'environnement `production` (#45) : `environment: production` seul ne protège rien — GitHub crée
 * un environnement ABSENT sans aucune règle. L'envoi refuse donc (1) un environnement sans relecteur requis ET
 * (2) un run qui n'a pas reçu d'approbation `approved` pour `production` : une règle ajoutée après le démarrage
 * du job laisserait sinon passer un run qui n'a jamais attendu personne. Elle échoue FERMÉE.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const approbation = (etat = "approved", ...noms) => ({
  state: etat,
  comment: "",
  environments: (noms.length === 0 ? ["production"] : noms).map((name) => ({ name })),
  user: { login: "mainteneur" },
});

/** Lance la garde sur deux FICHIERS (ce que fait le workflow) ; `null` = fichier absent. */
async function lancer(t, environnement, approbations) {
  const dossier = await mkdtemp(join(tmpdir(), "garde-"));
  t.after(() => rm(dossier, { recursive: true, force: true }));
  const chemin = async (nom, contenu) => {
    if (contenu === null) return join(dossier, `${nom}.absent`);
    await writeFile(
      join(dossier, nom),
      typeof contenu === "string" ? contenu : JSON.stringify(contenu),
    );
    return join(dossier, nom);
  };
  return spawnSync(
    process.execPath,
    [
      OUTIL,
      await chemin("env.json", environnement),
      await chemin("approbations.json", approbations),
    ],
    { encoding: "utf8" },
  );
}

test("des relecteurs requis ET une approbation de CE run : l'envoi passe", async (t) => {
  assert.equal(garde.relecteursRequis(protege), 1);
  assert.equal(garde.approbationDeCeRun([approbation()], "production"), true);
  const r = await lancer(t, protege, [approbation()]);
  assert.equal(r.status, 0, r.stderr);
});

test("un environnement SANS règle, ou avec une règle sans relecteur, est refusé", async (t) => {
  for (const environnement of [
    { name: "production", protection_rules: [] },
    { name: "production" },
    { name: "production", protection_rules: [{ type: "wait_timer" }] },
    { name: "production", protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
    // Une AUTRE règle qui porterait une liste `reviewers` n'est pas un relecteur requis.
    {
      name: "production",
      protection_rules: [{ type: "branch_policy", reviewers: [{ type: "User" }] }],
    },
  ]) {
    assert.equal(garde.relecteursRequis(environnement), 0);
    const r = await lancer(t, environnement, [approbation()]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Envoi REFUSÉ/);
  }
});

test("une règle AJOUTÉE APRÈS le démarrage : environnement protégé mais aucune approbation de CE run → refus", async (t) => {
  for (const approbations of [
    [],
    [approbation("rejected")],
    [approbation("pending")],
    [approbation("approved", "staging")],
    [{ state: "approved" }],
    [{ state: "approved", environments: [] }],
    {},
    "pas un tableau",
  ]) {
    assert.equal(garde.approbationDeCeRun(approbations, "production"), false);
    const r = await lancer(t, protege, approbations);
    assert.equal(r.status, 1, JSON.stringify(approbations));
    assert.match(r.stderr, /approbation/);
  }
});

test("une approbation parmi d'autres suffit s'il y en a une `approved` pour production", () => {
  assert.equal(
    garde.approbationDeCeRun(
      [approbation("rejected"), approbation("approved", "staging"), approbation("approved")],
      "production",
    ),
    true,
  );
});

test("une réponse illisible ou absente est refusée (la garde échoue FERMÉE)", async (t) => {
  assert.equal((await lancer(t, "", [approbation()])).status, 1);
  assert.equal((await lancer(t, "pas du json", [approbation()])).status, 1);
  assert.equal((await lancer(t, { message: "Not Found" }, [approbation()])).status, 1);
  assert.equal((await lancer(t, protege, "pas du json")).status, 1);
  assert.equal((await lancer(t, protege, null)).status, 1, "fichier d'approbations absent");
  assert.equal(
    (await lancer(t, null, [approbation()])).status,
    1,
    "fichier d'environnement absent",
  );
  assert.equal(
    spawnSync(process.execPath, [OUTIL], { encoding: "utf8" }).status,
    1,
    "sans argument",
  );
});
