// L'AFFICHAGE (#265, ADR 0049 § C2, R-1 à R-9, C2-13) sur un DOM factice : le masquage VÉRIFIÉ, la
// publication d'un seul geste, l'estampille en dernier, la région d'erreur, le focus. Les mêmes
// scénarios sont rejoués sur le DOM réel, trois moteurs : `tests/browser/coquille-affichage-dom.spec.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { creerLAffichage } from "../../src/coquille/affichage-de-la-revocation.mjs";
import { documentFactice } from "./support-dom-factice.mjs";

function page({ surPublication } = {}) {
  const doc = documentFactice();
  doc.poser([
    ["h2", { id: "parcours-titre", tabindex: "-1" }, "Titre"],
    ["div", { id: "affichage", hidden: true }],
    ["p", { id: "affichage-attente" }, "Mise à jour de l'affichage…"],
    ["p", { id: "affichage-erreur", hidden: true }, "L'affichage n'a pas pu être mis à jour."],
  ]);
  const conteneur = doc.getElementById("affichage");
  const regionDErreur = doc.getElementById("affichage-erreur");
  const repereDeFocus = doc.getElementById("parcours-titre");
  const affichage = creerLAffichage({
    doc,
    conteneur,
    regionDErreur,
    repereDeFocus,
    surPublication,
  });
  return { doc, conteneur, regionDErreur, repereDeFocus, affichage };
}

function fragmentDe(doc, ...ids) {
  const fragment = doc.createDocumentFragment();
  for (const id of ids) {
    const bouton = doc.createElement("button");
    bouton.id = id;
    bouton.textContent = id;
    fragment.append(bouton);
  }
  return fragment;
}

function publier(p, occ, empreinte, ...ids) {
  const fragment = fragmentDe(p.doc, ...ids);
  p.affichage.effets.remplacerLeContenu(fragment);
  p.affichage.effets.retirerLaRegionDErreur();
  p.affichage.effets.demasquer();
  p.affichage.effets.estamper(occ, { empreinte });
}

test("nouveauFragment : un fragment neuf à chaque appel, jamais attaché au document", () => {
  const p = page();
  const a = p.affichage.nouveauFragment();
  const b = p.affichage.nouveauFragment();
  assert.notEqual(a, b);
  assert.equal(a.isConnected, false);
  assert.equal(a.estFragment, true);
});

test("[R-3] la publication remplace le contenu d'UN geste, retire la région d'erreur, démasque, estampille en DERNIER", async () => {
  const p = page();
  const lots = [];
  new p.doc.MutationObserver((lot) => lots.push(lot)).observe(p.conteneur, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  p.regionDErreur.hidden = false;
  p.regionDErreur.setAttribute("data-erreur", "4");
  let remplacements = 0;
  const original = p.conteneur.replaceChildren.bind(p.conteneur);
  p.conteneur.replaceChildren = (...n) => ((remplacements += 1), original(...n));
  p.conteneur.append = () => assert.fail("aucune écriture incrémentale dans le conteneur visible");
  publier(p, 5, "vue-5", "oui");
  assert.equal(remplacements, 1, "un seul replaceChildren");
  assert.equal(p.conteneur.hidden, false);
  assert.equal(p.conteneur.getAttribute("data-vue"), "vue-5");
  assert.equal(p.conteneur.getAttribute("data-occurrence"), "5");
  assert.equal(p.regionDErreur.hidden, true, "la région d'erreur est retirée par la publication");
  assert.equal(p.regionDErreur.hasAttribute("data-erreur"), false);
  assert.equal(p.conteneur.querySelector("#oui") !== null, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(lots.length, 1, "la publication produit UN seul lot de mutations (atomicité)");
});

test("[R-3] l'estampille est posée APRÈS le contenu et le démasquage", () => {
  const p = page();
  const ordre = [];
  const original = p.conteneur.setAttribute.bind(p.conteneur);
  p.conteneur.setAttribute = (nom, valeur) => (ordre.push(`attr:${nom}`), original(nom, valeur));
  const remplacer = p.conteneur.replaceChildren.bind(p.conteneur);
  p.conteneur.replaceChildren = (...n) => (ordre.push("contenu"), remplacer(...n));
  publier(p, 2, "e");
  assert.equal(ordre[0], "contenu");
  assert.equal(
    ordre.at(-1),
    "attr:data-vue",
    "`data-vue` est l'unique acte qui rend visible : le dernier",
  );
});

test("[R-6] la région d'erreur est hors du conteneur, marquée de l'occurrence ; la publication suivante la retire", () => {
  const p = page();
  p.affichage.effets.montrerLaRegionDErreur(7);
  assert.equal(p.regionDErreur.hidden, false);
  assert.equal(p.regionDErreur.getAttribute("data-erreur"), "7");
  assert.equal(p.conteneur.contains(p.regionDErreur), false);
  publier(p, 8, "e8");
  assert.equal(p.regionDErreur.hidden, true);
  assert.equal(p.regionDErreur.hasAttribute("data-erreur"), false);
});

test("[R-9] le focus resté dans le contenu remplacé revient au même nœud, sinon au repère stable", () => {
  const p = page();
  publier(p, 1, "e1", "oui", "non");
  p.conteneur.querySelector("#non").focus();
  assert.equal(p.doc.activeElement.id, "non");
  publier(p, 2, "e2", "oui", "non");
  assert.equal(p.doc.activeElement.id, "non", "le même nœud, retrouvé par son identifiant");
  publier(p, 3, "e3", "oui");
  assert.equal(p.doc.activeElement, p.repereDeFocus, "sinon le repère stable");
});

test("[R-9] le focus hors du conteneur n'est pas déplacé", () => {
  const p = page();
  publier(p, 1, "e1", "oui");
  p.repereDeFocus.focus();
  publier(p, 2, "e2", "oui");
  assert.equal(p.doc.activeElement, p.repereDeFocus);
});

test("la publication appelle `surPublication` APRÈS l'estampille, dans le même bloc", () => {
  const vus = [];
  const p = page({ surPublication: () => vus.push(p2.conteneur.getAttribute("data-vue")) });
  const p2 = p;
  publier(p, 1, "estampillee");
  assert.deepEqual(vus, ["estampillee"]);
});

// --- [R-8] le masquage VÉRIFIÉ ----------------------------------------------------------------------

test("[R-8] masquer : retire l'estampille, pose `hidden`, RELIT, rend true", () => {
  const p = page();
  publier(p, 1, "e", "oui");
  assert.equal(p.affichage.masquer(), true);
  assert.equal(p.conteneur.hasAttribute("data-vue"), false);
  assert.equal(p.conteneur.hasAttribute("data-occurrence"), false);
  assert.equal(p.conteneur.hidden, true);
  assert.equal(p.affichage.masquer(), true, "idempotent");
});

const SABOTAGES = {
  "(a) removeAttribute lève": (c) => {
    c.removeAttribute = () => {
      throw new Error("retrait");
    };
  },
  "(b) hidden sans effet": (c) => {
    Object.defineProperty(c, "hidden", { get: () => false, set: () => {}, configurable: true });
    c.setAttribute = () => {};
  },
  "(c) détaché": (c) => c.remove(),
  "(d) les trois ensemble": (c) => {
    c.removeAttribute = () => {
      throw new Error("retrait");
    };
    Object.defineProperty(c, "hidden", { get: () => false, set: () => {}, configurable: true });
    c.remove();
  },
};

for (const [nom, saboter] of Object.entries(SABOTAGES)) {
  test(`[R-8] masquer ${nom} : rend false, et aucune affirmation ne reste visible (détaché en dernier recours)`, () => {
    const p = page();
    publier(p, 1, "e", "oui");
    saboter(p.conteneur);
    assert.equal(p.affichage.masquer(), false);
    const visible =
      p.conteneur.isConnected && p.conteneur.hasAttribute("data-vue") && !p.conteneur.hidden;
    assert.equal(visible, false, "aucune affirmation ne reste visible");
  });
}

test("[R-8] (e) référence absente : false, sans lever", () => {
  const doc = documentFactice();
  const affichage = creerLAffichage({ doc, conteneur: null, regionDErreur: null });
  assert.equal(affichage.masquer(), false);
});

test("[R-8] le repli : si `hidden` est sans effet mais le nœud reste attaché, une seconde écriture indépendante le cache", () => {
  const p = page();
  publier(p, 1, "e", "oui");
  let essais = 0;
  Object.defineProperty(p.conteneur, "hidden", {
    get: () => p.conteneur.hasAttribute("hidden"),
    set: () => {
      essais += 1;
    },
    configurable: true,
  });
  assert.equal(p.affichage.masquer(), true, "l'attribut posé directement établit le masquage");
  assert.ok(essais >= 1);
  assert.equal(p.conteneur.hasAttribute("hidden"), true);
});

test("[R-9] le focus perdu va au nœud marqué `data-focus-initial` du contenu neuf, avant le repère stable", () => {
  const p = page();
  publier(p, 1, "e1", "oui", "non");
  p.conteneur.querySelector("#non").focus();
  const fragment = fragmentDe(p.doc, "annuler", "valider");
  fragment.childNodes[0].setAttribute("data-focus-initial", "");
  p.affichage.effets.remplacerLeContenu(fragment);
  p.affichage.effets.estamper(2, { empreinte: "e2" });
  assert.equal(p.doc.activeElement.id, "annuler");
});

test("[R-9] un nouvel appel à `memoriserLeFocus` oublie le précédent : le focus n'est rendu qu'une fois", () => {
  const p = page();
  publier(p, 1, "e1", "oui");
  p.conteneur.querySelector("#oui").focus();
  publier(p, 2, "e2", "oui");
  p.repereDeFocus.focus();
  publier(p, 3, "e3", "oui");
  assert.equal(p.doc.activeElement, p.repereDeFocus, "le focus hors du conteneur n'est pas repris");
});

test("[R-9] une confirmation qui s'ouvre prend le focus ; le focus déjà dans son groupe n'est pas volé", () => {
  const p = page();
  publier(p, 1, "e1", "revoquer");
  p.conteneur.querySelector("#revoquer").focus();
  const confirmation = (occ) => {
    const fragment = p.doc.createDocumentFragment();
    const groupe = p.doc.createElement("div");
    groupe.setAttribute("role", "group");
    for (const id of ["annuler", "oui"]) {
      const b = p.doc.createElement("button");
      b.id = id;
      if (id === "annuler") b.setAttribute("data-focus-initial", "");
      groupe.append(b);
    }
    fragment.append(groupe);
    p.affichage.effets.remplacerLeContenu(fragment);
    p.affichage.effets.estamper(occ, { empreinte: `e${occ}` });
  };
  confirmation(2);
  assert.equal(p.doc.activeElement.id, "annuler", "la confirmation prend le focus sur « Annuler »");
  p.conteneur.querySelector("#oui").focus();
  confirmation(3);
  assert.equal(p.doc.activeElement.id, "oui", "le focus déjà dans le groupe reste où il est");
});

test("[R-9] après la fermeture d'une confirmation, le focus revient au geste qui l'avait ouverte, s'il est offert", () => {
  const p = page();
  const contenu = (occ, { ferme = false } = {}) => {
    const fragment = p.doc.createDocumentFragment();
    const retour = p.doc.createElement("button");
    retour.id = "revoquer";
    retour.setAttribute("data-focus-retour", "");
    if (ferme) retour.setAttribute("aria-disabled", "true");
    fragment.append(retour);
    p.affichage.effets.remplacerLeContenu(fragment);
    p.affichage.effets.estamper(occ, { empreinte: `e${occ}` });
  };
  publier(p, 1, "e1", "annuler");
  p.conteneur.querySelector("#annuler").focus();
  contenu(2);
  assert.equal(p.doc.activeElement.id, "revoquer");
  publier(p, 3, "e3", "oui");
  p.conteneur.querySelector("#oui").focus();
  contenu(4, { ferme: true });
  assert.equal(p.doc.activeElement, p.repereDeFocus, "un geste fermé ne reçoit pas le focus");
});
