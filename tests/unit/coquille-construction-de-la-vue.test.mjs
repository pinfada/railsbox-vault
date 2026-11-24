// La CONSTRUCTION de la vue (#265, ADR 0049 § C2, C2-11, C2-2) : un fragment fait de la SEULE projection de
// l'état — jamais d'un miroir, d'une ligne de texte ou de ce que le DOM portait avant. L'ordre du DOM est
// l'ordre visuel et l'ordre de tabulation : « Terminer sans révoquer » d'abord, la révocation ensuite.

import assert from "node:assert/strict";
import { test } from "node:test";

import { construireLaVue } from "../../src/coquille/construction-de-la-vue.mjs";
import { etatInitial } from "../../src/coquille/phases-de-la-revocation.mjs";
import { projeter } from "../../src/coquille/projection-de-la-revocation.mjs";
import { etatDeLaPhase } from "./support-revocation.mjs";
import { documentFactice } from "./support-dom-factice.mjs";

const etat = (phase, extra = {}) => {
  const { codes, phrase, ...reste } = extra;
  return etatDeLaPhase(phase, {
    moyen: "recuperation",
    jeu: { codes: codes ?? 1, phrase: phrase ?? true },
    ...reste,
  });
};

function rendre(phase, extra) {
  const doc = documentFactice();
  const fragment = construireLaVue(doc, projeter(etat(phase, extra)));
  const hote = doc.createElement("div");
  doc.body.append(hote);
  hote.append(fragment);
  return { doc, hote };
}

const ids = (hote) => [...hote.descendants()].map((e) => e.id).filter(Boolean);
const boutons = (hote) => [...hote.querySelectorAll("button")].map((b) => b.id);

test("[ordre] « Terminer sans révoquer » précède « Révoquer… » dans le DOM : ordre visuel = tabulation", () => {
  const { hote } = rendre("P");
  const ordre = boutons(hote);
  assert.ok(ordre.indexOf("parcours-sans-revoquer") >= 0);
  assert.ok(ordre.indexOf("revoquer-en-urgence") > ordre.indexOf("parcours-sans-revoquer"));
});

test("[ordre] dans la confirmation, « Annuler » précède « Oui, révoquer… » ; le bouton de révocation n'est pas principal", () => {
  const { hote } = rendre("C");
  const ordre = boutons(hote);
  assert.ok(ordre.indexOf("revocation-annuler") < ordre.indexOf("revocation-oui"));
  const revoquer = hote.querySelector("#revoquer-en-urgence");
  assert.equal(revoquer.hasAttribute("data-principal-de-la-vue"), false);
  assert.equal(revoquer.hasAttribute("data-principal"), false);
  assert.equal(revoquer.hasAttribute("data-danger"), true);
  assert.equal(
    hote.querySelector("#parcours-sans-revoquer").hasAttribute("data-principal-de-la-vue"),
    true,
  );
});

test("[C2-2] `aria-disabled` est DÉRIVÉ de projeter().gestes, geste par geste, et `disabled` n'est jamais posé", () => {
  for (const phase of ["P", "C", "V", "K", "I", "FC"]) {
    const projection = projeter(etat(phase));
    const { hote } = rendre(phase);
    const attendu = {
      "revoquer-en-urgence": "demander-la-revocation",
      "parcours-sans-revoquer": "terminer-sans-revoquer",
      "revocation-annuler": "annuler",
      "revocation-oui": "oui",
    };
    for (const [id, geste] of Object.entries(attendu)) {
      const bouton = hote.querySelector(`#${id}`);
      if (bouton === null) continue;
      assert.equal(
        bouton.getAttribute("aria-disabled") === "true",
        !projection.gestes[geste].ouvert,
        `${phase} : ${id}`,
      );
      assert.equal(bouton.hasAttribute("disabled"), false, `${id} n'est jamais « disabled »`);
      assert.equal(bouton.getAttribute("data-geste"), geste);
    }
  }
});

test("[C2-11] la confirmation n'existe que dans C, et porte le texte final au compte exact des codes", () => {
  assert.equal(rendre("P").hote.querySelector("#revocation-confirmation"), null);
  const { hote } = rendre("C");
  const texte = hote.querySelector("#revocation-confirmation-texte").textContent;
  assert.match(texte, /irréversible/);
  assert.match(texte, /Aucun autre moyen|ne fonctionner/);
  assert.equal(hote.querySelector("#revocation-confirmation").getAttribute("role"), "group");
  assert.equal(
    hote.querySelector("#revocation-confirmation").getAttribute("aria-labelledby"),
    "revocation-confirmation-titre",
  );
});

test("[C2-11] le compte des feuilles vient de la vue : deux codes, l'avertissement le dit", () => {
  const doc = documentFactice();
  const fragment = construireLaVue(doc, projeter(etat("P", { codes: 2 })));
  const hote = doc.createElement("div");
  doc.body.append(hote);
  hote.append(fragment);
  assert.match(
    hote.querySelector("#parcours-avertissement-revocation").textContent,
    /autres codes/,
  );
  assert.match(hote.querySelector("#parcours-codes").textContent, /2 codes/);
});

test("[D4] hors des phases où le moyen de séance est connu, aucun avertissement de révocation n'est écrit", () => {
  for (const phase of ["F0", "FL", "FC", "SL", "RL", "V", "I", "RE"]) {
    const { hote } = rendre(phase);
    assert.equal(hote.querySelector("#parcours-avertissement-revocation"), null, phase);
  }
});

test("[D4] les phases après succès disent « révoqué » ; les autres jamais", () => {
  const motif = /La révocation a été faite|révoqu[ée]/i;
  const dit = (phase) => motif.test(rendre(phase).hote.textContent);
  for (const phase of ["RL", "RE", "RM", "K"])
    assert.equal(dit(phase), true, `${phase} dit la révocation`);
  for (const phase of ["F0", "FL", "FC", "FE", "FM", "SL", "SE", "SM", "P", "C"]) {
    const texte = rendre(phase)
      .hote.textContent.replace(/Révoquer (tous )?les autres/gi, "")
      .replace(/Révoquer est irréversible/g, "")
      .replace(/Terminer sans révoquer/g, "")
      .replace(/Oui, révoquer les autres moyens/g, "")
      .replace(/« Oui, révoquer les autres moyens »/g, "");
    assert.doesNotMatch(
      texte,
      /La révocation a été faite|révoqué\b|révoquée\b/i,
      `${phase} ne dit pas « révoqué »`,
    );
  }
});

test("[C2-6] la région d'annonce de V et I est écrite par la vue, et seulement par elle", () => {
  assert.match(rendre("V").hote.querySelector("#affichage-region").textContent, /peut-être/);
  assert.match(rendre("I").hote.querySelector("#affichage-region").textContent, /peut-être/);
  for (const phase of ["P", "C", "K", "FC", "SL"]) {
    assert.equal(rendre(phase).hote.querySelector("#affichage-region"), null, phase);
  }
});

test("[C2-11] l'écran imposé de l'état est écrit, avec son titre, sous `data-impose`", () => {
  const cas = {
    SL: "chargement",
    RL: "chargement-apres-revocation",
    SE: "relire",
    RE: "relire-apres-revocation",
    V: "revoquer-en-cours",
    I: "revocation-incertaine",
    K: "termine",
    SM: "modification-en-cours",
    RM: "modification-en-cours-apres-revocation",
  };
  for (const [phase, cle] of Object.entries(cas)) {
    const { hote } = rendre(phase);
    const impose = hote.querySelector("#affichage-impose");
    assert.equal(impose.getAttribute("data-impose"), cle, phase);
    assert.ok(hote.querySelector("#affichage-titre").textContent.length > 3);
  }
  assert.equal(rendre("P").hote.querySelector("#affichage-impose"), null);
});

test("[S3] la fin atteinte par l'indice seul n'existe que dans P avec indice, et ne dit que « aucun geste dans cette séance »", () => {
  assert.equal(rendre("P").hote.querySelector("#affichage-fin"), null);
  const { hote } = rendre("P", { indice: true });
  assert.match(
    hote.querySelector("#affichage-fin").textContent,
    /Aucun geste de révocation n'a été fait dans cette séance/,
  );
  assert.doesNotMatch(hote.querySelector("#affichage-fin").textContent, /révoqué\b/i);
  assert.equal(rendre("C", { indice: true }).hote.querySelector("#affichage-fin"), null);
});

test("[C2-11h] la construction ne lit que la projection : ni `document`, ni le DOM déjà présent", () => {
  const doc = documentFactice();
  doc.poser([["p", { id: "parcours-codes" }, "99 codes (ancien miroir)"]]);
  const fragment = construireLaVue(doc, projeter(etat("P")));
  const hote = doc.createElement("div");
  doc.body.append(hote);
  hote.append(fragment);
  assert.doesNotMatch(hote.textContent, /99 codes|ancien miroir/);
});

test("une projection non gelée ou incomplète est une erreur de programmation", () => {
  const doc = documentFactice();
  assert.throws(() => construireLaVue(doc, null), TypeError);
  assert.throws(() => construireLaVue(doc, { vue: {} }), TypeError);
});

test("l'état initial n'affirme rien : l'écran imposé est le chargement, aucun geste de révocation n'est ouvert", () => {
  const doc = documentFactice();
  const fragment = construireLaVue(doc, projeter(etatInitial(false)));
  const hote = doc.createElement("div");
  doc.body.append(hote);
  hote.append(fragment);
  assert.equal(hote.querySelector("#affichage-impose").getAttribute("data-impose"), "chargement");
  assert.equal(ids(hote).includes("parcours-avertissement-revocation"), false);
});

test("[#214] aucun compte de codes n'est écrit pour zéro code, et le compte exact pour N", () => {
  assert.equal(rendre("P", { codes: 0 }).hote.querySelector("#parcours-codes"), null);
  assert.match(
    rendre("P", { codes: 3 }).hote.querySelector("#parcours-codes").textContent,
    /3 codes/,
  );
});

test("[focus] « Annuler » est le focus initial de la confirmation : la sortie sûre", () => {
  const { hote } = rendre("C");
  assert.equal(hote.querySelector("#revocation-annuler").hasAttribute("data-focus-initial"), true);
  assert.equal(hote.querySelector("#revocation-oui").hasAttribute("data-focus-initial"), false);
});

test("chaque bloc de la vue est un `data-bloc` que le parcours connaît", () => {
  const connus = new Set(["impose", "fin", "vue-codes", "sans-revoquer", "revocation"]);
  for (const phase of ["P", "C", "V", "K", "I", "SL"]) {
    for (const element of rendre(phase, { indice: true }).hote.querySelectorAll("[data-bloc]")) {
      assert.ok(
        connus.has(element.getAttribute("data-bloc")),
        `${phase} : ${element.getAttribute("data-bloc")}`,
      );
    }
  }
});
