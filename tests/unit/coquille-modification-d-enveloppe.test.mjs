// `modifierEtAttendre` (#265, C2-3) : l'issue du geste revient à l'appelant, le lanceur n'est jamais
// appelé que par `modifier`, et un refus du magasin ne laisse aucune promesse en suspens.

import assert from "node:assert/strict";
import { test } from "node:test";

import { modifierEtAttendre } from "../../src/coquille/modification-d-enveloppe.mjs";

test("le lanceur est appelé PAR `modifier`, et son issue revient", async () => {
  const appels = [];
  const modifier = (lanceur) => {
    appels.push("modifier");
    void lanceur();
    return { accepte: true, annonce: null };
  };
  const resultat = modifierEtAttendre(modifier, async () => {
    appels.push("geste");
    return { code: "X" };
  });
  assert.equal(resultat.accepte, true);
  assert.deepEqual(await resultat.issue, { rendu: { code: "X" }, erreur: null });
  assert.deepEqual(appels, ["modifier", "geste"]);
});

test("un refus du Worker est rendu comme erreur ET relancé au magasin (qui relit quand même)", async () => {
  let relance = null;
  const modifier = (lanceur) => {
    lanceur().catch((erreur) => {
      relance = erreur;
    });
    return { accepte: true, annonce: null };
  };
  const refus = Object.assign(new Error("non"), { code: "VAULT_X" });
  const resultat = modifierEtAttendre(modifier, async () => {
    throw refus;
  });
  const { rendu, erreur } = await resultat.issue;
  assert.equal(rendu, null);
  assert.equal(erreur, refus);
  await new Promise((r) => setImmediate(r));
  assert.equal(relance, refus);
});

test("refusé par la porte : le geste n'est jamais appelé, aucune issue n'est promise, l'annonce est rendue", () => {
  let appele = 0;
  const resultat = modifierEtAttendre(
    () => ({ accepte: false, annonce: "lancement-annule-affichage" }),
    async () => {
      appele += 1;
    },
  );
  assert.equal(resultat.accepte, false);
  assert.equal(resultat.issue, null);
  assert.equal(resultat.annonce, "lancement-annule-affichage");
  assert.equal(appele, 0);
});
