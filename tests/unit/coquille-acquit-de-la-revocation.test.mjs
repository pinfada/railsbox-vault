// L'ACQUIT de la révocation (#265 ; revue de #321, point 2) : ce que la page fait quand le Worker a
// acquitté — relevé, lien d'archive fermé, ligne d'état — construit dans `src/` pour que la campagne le mute.
// La fermeture du lien est OBLIGATOIRE : l'archive que la page tient encore porte l'ancienne page de
// récupération (revue de la PR #208, constat 4).

import assert from "node:assert/strict";
import { test } from "node:test";

import { creerLAcquit } from "../../src/coquille/acquit-de-la-revocation.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { SUCCES } from "./support-cablage.mjs";

function monter(options = {}) {
  const journal = [];
  const rapport = { portabilite: { sauvegarde: null, restauration: null, revocation: null } };
  const ligne = { textContent: "portabilite:au-repos" };
  const acquit = creerLAcquit({
    rapport,
    publier: () =>
      journal.push(`publie:${JSON.stringify(rapport.portabilite.revocation !== null)}`),
    retirerLeLien: () => journal.push("lien-ferme"),
    noeudDeLigne: ligne,
    ...options,
  });
  return { acquit, journal, rapport, ligne };
}

test("l'acquit écrit le relevé, ferme le lien, PUBLIE, puis dit la ligne — dans cet ordre", () => {
  const { acquit, journal, rapport, ligne } = monter();
  acquit(SUCCES);
  assert.deepEqual(rapport.portabilite.revocation, {
    versionEnveloppe: SUCCES.versionEnveloppe,
    restants: SUCCES.restants,
    retires: SUCCES.retires,
    nombreRetires: SUCCES.nombreRetires,
    nombreRestants: SUCCES.nombreRestants,
    copieDeSauvegardeRetiree: SUCCES.copieDeSauvegardeRetiree,
  });
  assert.deepEqual(journal, ["lien-ferme", "publie:true"]);
  assert.equal(ligne.textContent, "portabilite:revoque:1-retires:1-restant");
});

test("[obligatoire] sans fonction de fermeture du lien, l'acquit ne se construit pas", () => {
  assert.throws(() => creerLAcquit({ rapport: {}, publier() {}, noeudDeLigne: {} }), TypeError);
  assert.throws(
    () => creerLAcquit({ rapport: {}, publier() {}, noeudDeLigne: {}, retirerLeLien: "oui" }),
    TypeError,
  );
});

test("la ligne ne dit « revoque » qu'APRÈS la publication du relevé (revue de la PR #208, constat 7)", () => {
  const journal = [];
  const ligne = {
    set textContent(valeur) {
      journal.push(`ligne:${valeur}`);
    },
  };
  const { acquit } = monter({
    noeudDeLigne: ligne,
    publier: () => journal.push("publie"),
  });
  acquit(SUCCES);
  assert.deepEqual(journal, ["publie", "ligne:portabilite:revoque:1-retires:1-restant"]);
});

test("[lien réel] avec les gestes de portabilité, l'acquit ferme le lien de sauvegarde offert", () => {
  const lien = {
    href: "blob:x",
    hidden: false,
    attributs: new Set(["href"]),
    removeAttribute(nom) {
      this.attributs.delete(nom);
      if (nom === "href") this.href = "";
    },
  };
  const racine = {
    querySelector: (selecteur) => (selecteur === "#sauvegarde-lien" ? lien : null),
  };
  const rapport = {};
  const gestes = brancherLesGestesDePortabilite({
    racine,
    demander: async () => ({}),
    modifier: () => ({ accepte: false }),
    lirePublic: () => null,
    rapport,
    publier() {},
  });
  const { acquit } = monter({ retirerLeLien: gestes.retirerLeLien });
  const url = globalThis.URL.revokeObjectURL;
  globalThis.URL.revokeObjectURL = () => {};
  try {
    acquit(SUCCES);
  } finally {
    globalThis.URL.revokeObjectURL = url;
  }
  assert.equal(lien.hidden, true, "le lien est caché");
  assert.equal(lien.attributs.has("href"), false, "et il ne pointe plus sur l'archive");
});
