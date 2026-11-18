/**
 * Le GESTE « Retirer la copie hors connexion » (#299, ADR 0048 § 11) : borné à l'inscription et aux
 * caches de la COQUILLE.
 *
 * Garde éprouvée : 29 (geste qui vide tout ; geste qui désinscrit toute inscription de l'origine).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { retirerLaCopie } from "../../src/coquille/reserve-retrait.mjs";
import { FauxConteneur, FauxSW, FausseInscription } from "./support-reserve-page.mjs";

const cachesDe = (noms) => {
  const presents = new Set(noms);
  return {
    supprimes: [],
    keys: async () => [...presents],
    delete: async function (nom) {
      this.supprimes.push(nom);
      return presents.delete(nom);
    },
  };
};

const coquille = (surcharges = {}) =>
  new FausseInscription({
    active: new FauxSW({ scriptURL: "https://coquille.test/sw-coquille.mjs" }),
    scope: "https://coquille.test/",
    ...surcharges,
  });
const autre = new FausseInscription({
  active: new FauxSW({ scriptURL: "https://coquille.test/autre/sw.js" }),
  scope: "https://coquille.test/autre/",
});

test("le geste désinscrit l'inscription de la COQUILLE et supprime les caches `reserve-*` — rien d'autre", async () => {
  const inscription = coquille();
  const conteneur = new FauxConteneur({ inscription, registrations: [inscription, autre] });
  const caches = cachesDe(["reserve-abc", "reserve-def", "autre-cache", "reserve"]);
  const issue = await retirerLaCopie({ conteneur, caches });
  assert.equal(inscription.desinscrite, true);
  assert.equal(autre.desinscrite, false, "une inscription distincte survit");
  assert.deepEqual(caches.supprimes.sort(), ["reserve-abc", "reserve-def"]);
  assert.deepEqual(
    await caches.keys(),
    ["autre-cache", "reserve"],
    "un cache d'un autre nom survit",
  );
  assert.equal(issue.desinscrite, true);
});

test('jamais `getRegistrations()` puis tout désinscrire : l\'inscription est retrouvée par `getRegistration("/")`, VÉRIFIÉE sur son script, puis seule désinscrite', async () => {
  const conteneur = new FauxConteneur({
    inscription: coquille(),
    registrations: [coquille(), autre],
  });
  conteneur.getRegistrations = async () => {
    throw new Error("getRegistrations ne doit pas être appelé");
  };
  await retirerLaCopie({ conteneur, caches: cachesDe([]) });
});

test("une inscription à la racine dont le script N'EST PAS celui de la coquille n'est pas désinscrite", async () => {
  const etrangere = new FausseInscription({
    active: new FauxSW({ scriptURL: "https://coquille.test/un-autre-sw.js" }),
    scope: "https://coquille.test/",
  });
  const caches = cachesDe(["reserve-abc"]);
  const issue = await retirerLaCopie({
    conteneur: new FauxConteneur({ inscription: etrangere }),
    caches,
  });
  assert.equal(etrangere.desinscrite, false);
  assert.equal(issue.desinscrite, false);
  assert.deepEqual(
    caches.supprimes,
    ["reserve-abc"],
    "les caches du produit sont tout de même retirés (idempotent)",
  );
});

test("le script est reconnu sur l'un des trois Workers : actif, en attente, installant ; une autre portée n'est pas la racine", async () => {
  for (const emplacement of ["active", "waiting", "installing"]) {
    const sw = new FauxSW({ scriptURL: "https://coquille.test/sw-coquille.mjs" });
    const inscription = new FausseInscription({ [emplacement]: sw });
    await retirerLaCopie({ conteneur: new FauxConteneur({ inscription }), caches: cachesDe([]) });
    assert.equal(inscription.desinscrite, true, emplacement);
  }
  const sousPortee = new FausseInscription({
    active: new FauxSW({ scriptURL: "https://coquille.test/sw-coquille.mjs" }),
    scope: "https://coquille.test/sous/",
  });
  await retirerLaCopie({
    conteneur: new FauxConteneur({ inscription: sousPortee }),
    caches: cachesDe([]),
  });
  assert.equal(sousPortee.desinscrite, false, "la portée n'est pas la racine de l'origine");
});

test("le geste est IDEMPOTENT : sans inscription, il supprime les caches et rend sans erreur", async () => {
  const caches = cachesDe(["reserve-x"]);
  const issue = await retirerLaCopie({
    conteneur: new FauxConteneur({ inscription: null }),
    caches,
  });
  assert.equal(issue.desinscrite, false);
  assert.deepEqual(caches.supprimes, ["reserve-x"]);
});
