import assert from "node:assert/strict";
import test from "node:test";

import { solderLeJournal } from "../../src/vm/instantane/solde-du-journal.mjs";

// SOLDER LE JOURNAL D'UN GUEST ARRÊTÉ (#65, ADR 0024 décision 6, ADR 0014 amendé).
//
// C'est le geste le plus discuté de la tranche, et il vivait dans le Worker — donc hors de portée
// d'une épreuve sous Node, alors que c'est LUI qui décide si l'instantané est capturable. Il est
// sorti dans `src/` pour être éprouvé ici, geste par geste.
//
// Ce qu'il doit faire, dans cet ordre : VALIDER ce qui est déposé, RANGER par un point de contrôle,
// puis VÉRIFIER qu'il ne reste rien. Ce qui resterait serait rejoué dans le volume à la prochaine
// ouverture : la région d'authentification changerait, la génération non, et l'instantané serait
// écarté au motif ECART_REGION sur un volume que personne d'autre n'aurait touché.

/** Magasin réduit aux quatre membres que le solde interroge, avec sa trace de gestes. */
function magasin({ enAttente = false, rangeable = false, resteApres = false, octets = 0 } = {}) {
  const gestes = [];
  let pending = enAttente;
  return {
    gestes,
    get enAttente() {
      return pending;
    },
    get rangeable() {
      return rangeable;
    },
    get octetsDeCharge() {
      return octets;
    },
    async valider() {
      gestes.push("valider");
    },
    async pointDeControle() {
      gestes.push("point-de-controle");
      pending = resteApres;
    },
  };
}

test("un journal DÉPOSÉ est validé, rangé, puis vérifié vide", async () => {
  const store = magasin({ enAttente: true, rangeable: true });
  assert.equal(await solderLeJournal(store), null, "soldé : la capture peut avoir lieu");
  assert.deepEqual(store.gestes, ["valider", "point-de-controle"]);
});

test("un journal DÉJÀ vide ne provoque aucun geste", async () => {
  const store = magasin({ enAttente: false, rangeable: false });
  assert.equal(await solderLeJournal(store), null);
  assert.deepEqual(store.gestes, [], "on ne valide pas ce qui n'est pas déposé");
});

test("ce qui RESTE après le solde refuse la capture, et le refus porte le compte", async () => {
  // Un point de contrôle qui ne vide pas — parce qu'un dépôt est arrivé entre-temps, ou parce que
  // le rangement a laissé une charge — laisse un journal qui sera rejoué à la prochaine ouverture.
  const store = magasin({ enAttente: true, rangeable: true, resteApres: true, octets: 4096 });
  assert.deepEqual(await solderLeJournal(store), { octetsDeCharge: 4096 });
  assert.deepEqual(store.gestes, ["valider", "point-de-controle"]);
});

test("une charge NON validée n'est pas rangée de force : elle refuse la capture", async () => {
  // `rangeable` est faux quand des octets déposés ne sont validés par aucune barrière. Les ranger
  // publierait un état que personne n'a acquitté ; le solde ne le fait pas, il refuse.
  const store = magasin({ enAttente: true, rangeable: false, resteApres: true, octets: 512 });
  const reste = await solderLeJournal(store);
  assert.deepEqual(reste, { octetsDeCharge: 512 });
  assert.deepEqual(
    store.gestes,
    ["valider"],
    "aucun point de contrôle sur une charge non rangeable",
  );
});
