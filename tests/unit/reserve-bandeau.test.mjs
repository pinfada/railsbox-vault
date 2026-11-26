/**
 * Le BANDEAU de la copie hors connexion (#299, ADR 0048 §§ 8 et 11) et les NOMS STABLES de la réserve.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODES_REFUS_COQUILLE as C,
  messageDeRefus,
} from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DE_FRAICHEUR as E } from "../../src/coquille/reserve-fraicheur.mjs";
import {
  TEXTE_DU_GESTE_DE_RETRAIT,
  TEXTE_PREPARATION,
  monterLeBandeau,
} from "../../src/coquille/reserve-bandeau.mjs";
import {
  PREFIXE_DE_CACHE,
  PREFIXES_ANCIENS,
  URL_DU_SW,
} from "../../src/coquille/reserve-identite.mjs";

class Noeud {
  constructor(balise) {
    this.balise = balise;
    this.attributs = {};
    this.enfants = [];
    this.dataset = {};
    this.textContent = "";
    this.ecouteurs = {};
  }
  setAttribute(nom, valeur) {
    this.attributs[nom] = valeur;
  }
  append(...noeuds) {
    this.enfants.push(...noeuds);
  }
  addEventListener(type, fn) {
    this.ecouteurs[type] = fn;
  }
}
function faireUnDocument() {
  const corps = new Noeud("body");
  corps.prepend = (noeud) => corps.enfants.unshift(noeud);
  return { createElement: (balise) => new Noeud(balise), body: corps };
}

test("le bandeau est une région `role=alert` nommée, posée en tête du corps, avec le geste de retrait", () => {
  const document = faireUnDocument();
  let retire = 0;
  monterLeBandeau({ document, surRetrait: () => retire++ });
  const [section] = document.body.enfants;
  assert.equal(section.id, "reserve-bandeau");
  assert.equal(section.attributs["aria-label"], "Copie hors connexion");
  const [etat, refus, bouton] = section.enfants;
  assert.equal(etat.attributs.role, "alert");
  assert.equal(refus.attributs.role, "alert");
  assert.equal(bouton.textContent, TEXTE_DU_GESTE_DE_RETRAIT);
  assert.equal(bouton.type, "button");
  bouton.ecouteurs.click();
  assert.equal(retire, 1);
});

test("`afficher` dit l'état observé, avec son identifiant ; la préparation et le refus ont leur texte", () => {
  const document = faireUnDocument();
  const bandeau = monterLeBandeau({ document, surRetrait: () => {} });
  const [etat, refus] = document.body.enfants[0].enfants;
  bandeau.afficher(E.MISE_A_JOUR_PRETE);
  assert.equal(etat.textContent, E.MISE_A_JOUR_PRETE.texte);
  assert.equal(etat.dataset.etat, "mise-a-jour-prete");
  bandeau.afficher(E.REVOCATION_CONNUE);
  assert.equal(
    etat.dataset.etat,
    "revocation-connue",
    "une mise à jour du bandeau remplace le texte",
  );
  bandeau.afficherLaPreparation();
  assert.equal(etat.textContent, TEXTE_PREPARATION);
  bandeau.afficherLeRefus(C.reserveAbsente);
  assert.equal(refus.textContent, messageDeRefus(C.reserveAbsente));
  assert.equal(refus.dataset.code, C.reserveAbsente);
  assert.match(
    messageDeRefus(C.reserveAbsente),
    /Ouvrez le coffre dans une fenêtre normale d'un navigateur à jour/,
  );
});

test("les NOMS STABLES : le script du SW écrit le même préfixe que le produit ; l'URL est à la racine ; aucun ancien préfixe", () => {
  assert.equal(URL_DU_SW, "/sw-coquille.mjs");
  assert.equal(PREFIXE_DE_CACHE, "reserve-");
  assert.deepEqual([...PREFIXES_ANCIENS], []);
  const modele = readFileSync(
    new URL("../../tools/reserve/sw-coquille.js", import.meta.url),
    "utf8",
  );
  assert.ok(modele.includes(`const PREFIXE_DE_CACHE = "${PREFIXE_DE_CACHE}";`));
});
