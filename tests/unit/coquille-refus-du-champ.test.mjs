// Le refus JUGE la valeur saisie, ou il ne juge rien (#266 B2-1, B2-2, B2-3).
//
// Deux familles : le refus qui porte sur la VALEUR du champ (phrase refusée, code mal recopié) marque
// le champ — `aria-invalid`, `aria-describedby`, message placé SOUS lui ; le refus d'ÉTAT (coffre déjà
// ouvert ailleurs, installation inachevée…) reste où il est et n'accuse aucun champ.

import assert from "node:assert/strict";
import test from "node:test";
import { relierLeRefusAuChamp } from "../../public/coquille/refus-du-champ.mjs";
import { refusJugeLaValeur } from "../../src/coquille/refus-qui-jugent-une-valeur.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { conduiteHumaine } from "../../src/coquille/conduites-du-parcours.mjs";
import { DERIVATION_ERROR_CODES as D } from "../../src/vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES as E } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { CODE_PHRASE_FAIBLE } from "../../src/coquille/politique-de-phrase.mjs";

class Noeud {
  constructor(id) {
    this.id = id;
    this.attributs = new Map();
    this.enfants = [];
    this.parentNode = null;
    this.textContent = "";
    this.ecouteurs = new Map();
  }
  getAttribute(nom) {
    return this.attributs.has(nom) ? this.attributs.get(nom) : null;
  }
  setAttribute(nom, valeur) {
    this.attributs.set(nom, String(valeur));
  }
  removeAttribute(nom) {
    this.attributs.delete(nom);
  }
  get nextSibling() {
    const frere = this.parentNode?.enfants ?? [];
    return frere[frere.indexOf(this) + 1] ?? null;
  }
  insertBefore(enfant, avant) {
    enfant.parentNode?.enfants.splice(enfant.parentNode.enfants.indexOf(enfant), 1);
    const place = avant === null ? this.enfants.length : this.enfants.indexOf(avant);
    this.enfants.splice(place, 0, enfant);
    enfant.parentNode = this;
  }
  append(enfant) {
    this.insertBefore(enfant, null);
  }
  addEventListener(type, ecouteur) {
    this.ecouteurs.set(type, ecouteur);
  }
}

function page() {
  const racine = new Noeud("racine");
  const noeuds = new Map();
  for (const id of [
    "parcours-refus",
    "saisie-phrase",
    "saisie-code",
    "refus-saisie-phrase",
    "refus-saisie-code",
  ]) {
    noeuds.set(id, new Noeud(id));
  }
  racine.append(noeuds.get("parcours-refus"));
  racine.append(noeuds.get("saisie-phrase"));
  noeuds.get("saisie-phrase").setAttribute("aria-describedby", "phrase-conseil");
  noeuds.get("saisie-code").setAttribute("aria-describedby", "parcours-code-lu");
  noeuds.get("saisie-code").dataset = {};
  racine.append(noeuds.get("refus-saisie-phrase"));
  racine.append(noeuds.get("refus-saisie-code"));
  let geste = null;
  let relier = () => {};
  const doc = {
    defaultView: {
      MutationObserver: class {
        constructor(reaction) {
          relier = reaction;
        }
        observe() {}
      },
    },
  };
  const noeud = (id) => noeuds.get(id) ?? null;
  const dire = (id, texte) => {
    noeud(id).textContent = texte;
    relier();
  };
  relierLeRefusAuChamp({
    doc,
    noeud,
    gesteCourant: () => geste,
    dire,
    jugeLaValeur: refusJugeLaValeur,
  });
  return {
    noeud,
    dire,
    refuser: (gesteDuClic, code) => {
      geste = gesteDuClic;
      dire("parcours-refus", conduiteHumaine(code));
    },
  };
}

test("une phrase refusée marque le champ phrase et place le refus sous lui", () => {
  const { noeud, refuser } = page();
  refuser("ouvrir-par-phrase", D.phraseRefusee);
  const champ = noeud("saisie-phrase");
  assert.equal(champ.getAttribute("aria-invalid"), "true");
  assert.equal(champ.getAttribute("aria-describedby"), "phrase-conseil parcours-refus");
  assert.equal(noeud("parcours-refus").parentNode, noeud("refus-saisie-phrase"));
});

test("une phrase trop courte et une clé refusée marquent aussi le champ de leur geste", () => {
  for (const [geste, code, champ] of [
    ["ouvrir-par-phrase", CODE_PHRASE_FAIBLE, "saisie-phrase"],
    ["ouvrir-par-phrase", E.cleRefusee, "saisie-phrase"],
    ["ouvrir-par-code", D.codeMalRecopie, "saisie-code"],
    ["ouvrir-par-code", E.cleRefusee, "saisie-code"],
  ]) {
    const { noeud, refuser } = page();
    refuser(geste, code);
    assert.equal(noeud(champ).getAttribute("aria-invalid"), "true", `${geste} ${code}`);
  }
});

test("un refus d'état n'accuse aucun champ et ne quitte pas sa place", () => {
  for (const code of [C.volumeVerrouille, C.disqueDUnAutreCoffre, C.workerMort, C.gesteRompu]) {
    const { noeud, refuser } = page();
    refuser("ouvrir-par-phrase", code);
    assert.equal(noeud("saisie-phrase").getAttribute("aria-invalid"), null, code);
    assert.equal(noeud("saisie-phrase").getAttribute("aria-describedby"), "phrase-conseil");
    assert.notEqual(noeud("parcours-refus").parentNode, noeud("refus-saisie-phrase"));
  }
});

test("le refus revient à sa place et le champ se démarque quand le message s'efface", () => {
  const { noeud, dire, refuser } = page();
  refuser("ouvrir-par-phrase", D.phraseRefusee);
  dire("parcours-refus", "");
  assert.equal(noeud("saisie-phrase").getAttribute("aria-invalid"), null);
  assert.equal(noeud("parcours-refus").parentNode.id, "racine");
  assert.equal(noeud("parcours-refus").nextSibling, noeud("saisie-phrase"));
});

test("un code fausse en direct marque le champ code sans refus", () => {
  const { noeud, dire } = page();
  noeud("saisie-code").dataset.saisieFausse = "true";
  dire("parcours-refus", "");
  assert.equal(noeud("saisie-code").getAttribute("aria-invalid"), "true");
  assert.equal(noeud("saisie-code").getAttribute("aria-describedby"), "parcours-code-lu");
});

test("la table dit quels refus jugent une valeur", () => {
  assert.equal(refusJugeLaValeur(conduiteHumaine(D.phraseRefusee)), true);
  assert.equal(refusJugeLaValeur(conduiteHumaine(D.codeMalRecopie)), true);
  assert.equal(refusJugeLaValeur(conduiteHumaine(C.volumeVerrouille)), false);
  assert.equal(refusJugeLaValeur(""), false);
});
