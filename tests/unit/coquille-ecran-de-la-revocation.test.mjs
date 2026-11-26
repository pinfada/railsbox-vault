// Ce que l'ÉTAT de la révocation décide de l'écran (#265, ADR 0049 § C2, C2-1′, S3) : le coffre, les
// données de décision lues par les DEUX portes, l'écran imposé par l'état et la fin offerte. La page ne
// lit rien d'autre — ni miroir, ni texte, ni drapeau parallèle.

import assert from "node:assert/strict";
import { test } from "node:test";

import { COFFRE } from "../../src/coquille/parcours.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import {
  ecranImposeDeLEtat,
  observationDeLEtat,
} from "../../src/coquille/ecran-de-la-revocation.mjs";
import { projeter } from "../../src/coquille/projection-de-la-revocation.mjs";
import { LISTE_DES_PHASES } from "../../src/coquille/phases-de-la-revocation.mjs";
import { etatDeLaPhase, reponseDInventaire } from "./support-revocation.mjs";
import { creerEtat } from "../../src/coquille/phases-de-la-revocation.mjs";
import { normaliserLInventaire } from "../../src/coquille/reponse-de-la-revocation.mjs";

const observer = (phase, options = {}, pointeur = 9) =>
  observationDeLEtat({ etat: etatDeLaPhase(phase, options), pointeur });

test("[coffre] ouvert dans toute phase d'après l'ouverture ; inconnu avant la première lecture et après un échec", () => {
  for (const phase of ["SL", "SE", "SM", "RL", "RE", "RM", "P", "C", "V", "K", "I"]) {
    assert.equal(observer(phase).coffre, COFFRE.ouvert, phase);
  }
  for (const phase of ["F0", "FL", "FE", "FM"]) {
    assert.equal(observer(phase).coffre, COFFRE.inconnu, phase);
  }
});

test("[coffre] fermé et lu (FC) : verrouillé s'il porte des moyens, absent sinon, refusé pour un refus d'inventaire", () => {
  assert.equal(observer("FC").coffre, COFFRE.verrouille);
  const vide = (surcharge) => {
    const normalise = normaliserLInventaire(
      { ...reponseDInventaire({ phrase: false, codes: 0 }), ...surcharge },
      { ouvert: false },
    );
    assert.equal(normalise.ok, true);
    return creerEtat({
      phase: "FC",
      sequence: 1,
      donnees: Object.freeze({ ...normalise.donnees, lecture: 1 }),
      indice: false,
    });
  };
  assert.equal(
    observationDeLEtat({ etat: vide({ present: false }), pointeur: null }).coffre,
    COFFRE.absent,
  );
  const refus = observationDeLEtat({
    etat: vide({ refus: { code: CODES_REFUS_COQUILLE.coffreAnterieur }, present: true }),
    pointeur: null,
  });
  assert.equal(refus.refus, CODES_REFUS_COQUILLE.coffreAnterieur);
  assert.equal(refus.coffre, COFFRE.refuse);
  // Un refus de GESTE n'est pas un refus d'inventaire : sans moyen proposé, le coffre est « absent ».
  const geste = observationDeLEtat({
    etat: vide({ refus: { code: "VAULT_ENVELOPPE_CLE_REFUSEE" }, present: true }),
    pointeur: null,
  });
  assert.equal(geste.coffre, COFFRE.absent);
  // #231 : un stockage INACCESSIBLE n'est ni un coffre absent ni un coffre refusé ; la reconnaissance tient au
  // refus TYPÉ (le même texte sans le code n'est pas reconnu), et la reprise redonne un coffre verrouillé.
  const inconnu = observationDeLEtat({
    etat: vide({ refus: { code: "VAULT_STORAGE_INDETERMINE" }, present: false }),
    pointeur: null,
  });
  assert.equal(inconnu.coffre, COFFRE.inaccessible);
  assert.notEqual(inconnu.coffre, COFFRE.absent);
  assert.notEqual(inconnu.coffre, COFFRE.refuse);
  assert.equal(
    observer("FC").coffre,
    COFFRE.verrouille,
    "à la reprise : l'écran d'un coffre existant",
  );
});

test("[C2-1′] les données de décision viennent des deux portes : fermées là où la page ne sait pas", () => {
  for (const phase of LISTE_DES_PHASES) {
    const o = observer(phase);
    const connue = ["FC", "SL", "SE"].includes(phase) ? null : null;
    void connue;
    if (["F0", "FL", "FE", "FM", "SL", "SE", "SM", "RL", "RE", "RM", "V", "I"].includes(phase)) {
      assert.deepEqual(o.moyens, [], `${phase} : aucun moyen connu`);
      assert.equal(o.nombreDeCodes, undefined, `${phase} : aucun compte connu`);
      assert.equal(o.feuilleEprouvee, false, `${phase} : aucun constat`);
    }
  }
  const p = observer("P");
  assert.deepEqual(p.moyens, ["phrase", "recuperation"]);
  assert.equal(p.nombreDeCodes, 1);
  assert.equal(p.feuilleEprouvee, true);
  assert.equal(observer("FC").feuilleEprouvee, false, "coffre fermé : aucun constat");
});

test("[C2-1′] un constat « non éprouvé » est lu tel quel", () => {
  assert.equal(observer("P", { jeu: { feuille: false } }).feuilleEprouvee, false);
});

test("[S3] la fin offerte : `termine-sans-attestation` dans P avec indice seulement", () => {
  assert.equal(observer("K").fin, null, "K est imposé par l'état, pas offert");
  assert.equal(observer("P", { indice: true }).fin, "termine-sans-attestation");
  for (const phase of LISTE_DES_PHASES) {
    if (phase === "P") continue;
    assert.equal(observer(phase, { indice: true }).fin, null, `${phase} × indice`);
  }
  assert.equal(observer("P").fin, null);
});

test("[D4] l'indice seul n'ouvre jamais `termine` (l'écran qui dit « révoqué »)", () => {
  for (const phase of LISTE_DES_PHASES) {
    assert.notEqual(observer(phase, { indice: true }).fin, "termine", phase);
    assert.notEqual(observer(phase, { indice: false }).fin, "termine", phase);
  }
});

const imposé = (phase, pointeur, options = {}) =>
  ecranImposeDeLEtat(projeter(etatDeLaPhase(phase, options)).vue, pointeur);

test("[S3] l'écran IMPOSÉ par l'état l'emporte, indice vrai ou faux, sur 13 phases", () => {
  const attendu = {
    F0: "chargement",
    FL: "chargement",
    FE: "etat-du-coffre",
    FM: "etat-du-coffre",
    SL: "chargement",
    SE: "etat-du-coffre",
    SM: "etat-du-coffre",
    RL: "chargement",
    RE: "etat-du-coffre",
    RM: "etat-du-coffre",
    V: "etat-du-coffre",
  };
  for (const [phase, ecran] of Object.entries(attendu)) {
    for (const indice of [false, true]) {
      for (const pointeur of [null, 4, 9]) {
        assert.equal(
          imposé(phase, pointeur, { indice }),
          ecran,
          `${phase} / ${pointeur} / ${indice}`,
        );
      }
    }
  }
  for (const phase of ["FC", "P", "C"]) assert.equal(imposé(phase, 9), null, phase);
});

test("[S3] K et I n'imposent leur écran qu'à l'étape 9 (ou sans étape) ; ailleurs, l'application reste", () => {
  for (const [phase, ecran] of [
    ["K", "termine"],
    ["I", "etat-du-coffre"],
  ]) {
    assert.equal(imposé(phase, 9), ecran);
    assert.equal(imposé(phase, null), ecran);
    for (const pointeur of [1, 4, 5, 8])
      assert.equal(imposé(phase, pointeur), null, `${phase} / ${pointeur}`);
  }
});
