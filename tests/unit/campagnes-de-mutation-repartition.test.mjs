// CLIQUET de la répartition des campagnes de mutation en lots parallèles (#328).
//
// Le job requis « Campagnes de mutation » a été annulé à son plafond de 15 min sur `main` : la
// séquence complète (16 campagnes, 859 s mesurées sur la PR #323) ne laisse plus de marge. La
// campagne est donc découpée en LOTS joués en parallèle. Ce cliquet garde ce qui rend le découpage
// honnête : chaque mutant est rejoué EXACTEMENT UNE FOIS par l'ensemble des lots, rien n'est oublié,
// et `npm run check:mutations` sans argument joue encore tout.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { CAMPAGNES, LOTS, selectionner } from "../../tools/rejouer-les-campagnes.mjs";
import { filtrerParTranche } from "../../tools/moteur-de-mutation.mjs";

const analyser = (entree) => {
  const [nom, tranche] = entree.split("@");
  if (!tranche) return { nom, i: 1, n: 1 };
  const [i, n] = tranche.split("/").map(Number);
  return { nom, i, n };
};

test("chaque campagne et chaque tranche de campagne est jouée exactement une fois par les lots", () => {
  const vues = new Map();
  for (const lot of LOTS) {
    for (const entree of lot) {
      const { nom, i, n } = analyser(entree);
      const tranches = vues.get(nom) ?? { n, i: [] };
      assert.equal(tranches.n, n, `${nom} : tous les morceaux doivent annoncer le même n`);
      tranches.i.push(i);
      vues.set(nom, tranches);
    }
  }
  assert.deepEqual(
    [...vues.keys()].sort(),
    CAMPAGNES.map(({ nom }) => nom).sort(),
    "chaque campagne de CAMPAGNES figure dans un lot, et aucun lot ne nomme une campagne inconnue",
  );
  for (const [nom, { n, i }] of vues) {
    assert.deepEqual(
      i.sort((a, b) => a - b),
      Array.from({ length: n }, (_, k) => k + 1),
      `${nom} : les tranches 1..${n} doivent apparaître chacune une fois, sans trou ni doublon`,
    );
  }
});

test("aucun script de campagne du dépôt n'est oublié par CAMPAGNES", () => {
  const scripts = readdirSync(new URL("../../tools/", import.meta.url))
    .filter((f) => /^muter-gardes-.*\.mjs$/u.test(f))
    .map((f) => `tools/${f}`)
    .sort();
  assert.deepEqual(CAMPAGNES.map(({ script }) => script).sort(), scripts);
});

test("la tranche i/n garde les mutants d'indice ≡ i-1 mod n, et les n tranches partitionnent la table", () => {
  const table = Array.from({ length: 23 }, (_, k) => ({ nom: `m${k}` }));
  for (const n of [1, 2, 3, 4, 7]) {
    const morceaux = Array.from({ length: n }, (_, k) => filtrerParTranche(table, `${k + 1}/${n}`));
    assert.deepEqual(
      morceaux
        .flat()
        .map(({ nom }) => nom)
        .sort(),
      table.map(({ nom }) => nom).sort(),
    );
    assert.equal(new Set(morceaux.flat()).size, table.length);
  }
  assert.deepEqual(filtrerParTranche(table, undefined), table);
});

test("une tranche mal formée est refusée au lieu de jouer une table vide", () => {
  for (const mauvaise of ["0/3", "4/3", "1/0", "a/b", "2", "1/2/3", "-1/2", "1.5/2"]) {
    assert.throws(() => filtrerParTranche([{ nom: "x" }], mauvaise), /tranche/u, mauvaise);
  }
});

test("sans argument, tout est joué ; un lot ou une liste ne joue que sa sélection ; l'inconnu est refusé", () => {
  assert.deepEqual(
    selectionner({}).map(({ nom }) => nom),
    CAMPAGNES.map(({ nom }) => nom),
  );
  assert.ok(selectionner({}).every(({ tranche }) => tranche === undefined));
  const lot1 = selectionner({ lot: 1 });
  assert.deepEqual(
    lot1.map(({ nom, tranche }) => (tranche ? `${nom}@${tranche}` : nom)),
    LOTS[0],
  );
  assert.deepEqual(
    selectionner({ campagnes: "magasin,reserve" }).map(({ nom }) => nom),
    ["magasin", "reserve"],
  );
  assert.throws(() => selectionner({ lot: LOTS.length + 1 }), /lot/u);
  assert.throws(() => selectionner({ lot: 0 }), /lot/u);
  assert.throws(() => selectionner({ campagnes: "inconnue" }), /inconnue/u);
  assert.throws(
    () => selectionner({ lot: 1, campagnes: "magasin" }),
    /lot.*campagnes|campagnes.*lot/u,
  );
});
