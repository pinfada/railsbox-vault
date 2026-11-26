// C2-17 (#265, ADR 0049, L13′) : `parcours.json` n'est JAMAIS une preuve. Deux documents de même origine, les
// fermetures inversées, une valeur DIFFÉRENTE pour chaque champ : le fichier final peut être celui de
// l'ancien document, et aucune de ses valeurs ne ferme ni n'ouvre un geste de récupération.
//
// Le pendant navigateur — l'ordre réel d'écriture dans l'OPFS — est dans
// `tests/browser/coquille-revocation-page.spec.mjs` ([C2-17]).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COFFRE,
  PROGRESSION_INITIALE,
  ecranCourant,
  ecrireProgression,
  etapeAdmise,
  lireProgression,
} from "../../src/coquille/parcours.mjs";

/** Le document X (ancien) et le document Y (neuf, après remise à zéro) : tous les champs diffèrent. */
const X = Object.freeze({
  version: 2,
  etapeAtteinte: 9,
  origine: "creation",
  code: { rendu: true, version: 7 },
  feuilleEprouvee: true,
  visiteTerminee: true,
  revocationFaite: true,
});
const Y = Object.freeze({
  version: 2,
  etapeAtteinte: 3,
  origine: "restauration",
  code: { rendu: false, version: null },
  feuilleEprouvee: false,
  visiteTerminee: false,
  revocationFaite: false,
});

const relue = (document) => lireProgression(JSON.stringify(document));

/** Les écrans de TRAVAIL : ceux que seul le constat du Worker ouvre (#239). */
const ECRANS_DE_TRAVAIL = Object.freeze([
  "travailler",
  "travailler-sans-application",
  "accueil",
  "verrouiller",
  "sauvegarder",
  "restaurer-ailleurs",
  "recuperer-preparer",
  "revoquer",
  "termine",
  "termine-sans-revoquer",
  "termine-sans-attestation",
]);

test("[C2-17 1] relu, le fichier de X rend ses valeurs, SAUF `code`, remis à l'état initial (VULN-04)", () => {
  const lue = relue(X);
  assert.equal(lue.etapeAtteinte, 9);
  assert.equal(lue.feuilleEprouvee, true);
  assert.equal(lue.revocationFaite, true);
  assert.deepEqual(lue.code, PROGRESSION_INITIALE.code);
  assert.deepEqual(relue(Y).code, PROGRESSION_INITIALE.code);
});

test("[C2-17 2] sur un coffre verrouillé dont la feuille n'est pas constatée : un détour d'un écran, JAMAIS 4 à 9", () => {
  for (const progression of [relue(X), relue(Y)]) {
    const premier = ecranCourant({
      pointeur: null,
      coffre: COFFRE.verrouille,
      moyens: ["phrase", "recuperation"],
      progression,
    });
    assert.ok(["rouvrir", "code-verifier"].includes(premier), `le premier formulaire : ${premier}`);
  }
});

test("[C2-17 3] `?etape=9` avec une étape atteinte périmée et la feuille NON constatée : l'écran est celui de l'étape 3", () => {
  const progression = relue(X);
  const pointeur = etapeAdmise(9, progression);
  assert.equal(pointeur, 9, "l'URL est admise par le fichier périmé");
  const ecran = ecranCourant({
    pointeur,
    coffre: COFFRE.ouvert,
    moyens: ["phrase", "recuperation"],
    nombreDeCodes: 1,
    feuilleEprouvee: false,
    progression,
  });
  assert.equal(ecran, "code-a-verifier");
  assert.ok(!ECRANS_DE_TRAVAIL.includes(ecran));
});

test("[C2-17 4] `revocationFaite` périmé : l'étape 9 offre `revoquer`, et la fin n'est offerte que par l'ÉTAT — jamais « termine »", () => {
  const progression = relue(X);
  const ouvert = {
    pointeur: 9,
    coffre: COFFRE.ouvert,
    moyens: ["phrase", "recuperation"],
    nombreDeCodes: 1,
    feuilleEprouvee: true,
    progression,
  };
  assert.equal(ecranCourant(ouvert), "revoquer");
  assert.equal(
    ecranCourant({ ...ouvert, fin: "termine-sans-attestation" }),
    "termine-sans-attestation",
  );
});

test("[C2-17 5] le cas inverse (ancien faux sur nouveau vrai) coûte des détours, et ne saute aucune étape", () => {
  const progression = relue(Y);
  for (const pointeur of [null, 4, 5, 6, 7, 8, 9]) {
    const ecran = ecranCourant({
      pointeur: etapeAdmise(pointeur, progression),
      coffre: COFFRE.ouvert,
      moyens: ["phrase", "recuperation"],
      nombreDeCodes: 1,
      feuilleEprouvee: true,
      progression,
    });
    assert.ok(typeof ecran === "string" && ecran.length > 0);
  }
  assert.equal(etapeAdmise(9, progression), 3, "l'URL est ramenée à l'étape atteinte");
});

test("[C2-17 6] AUCUN champ de la progression n'ouvre un écran de travail sans le constat du Worker", () => {
  const booleens = [false, true];
  let essais = 0;
  for (const etapeAtteinte of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const origine of ["creation", "restauration"]) {
      for (const feuilleEprouvee of booleens) {
        for (const visiteTerminee of booleens) {
          for (const revocationFaite of booleens) {
            const progression = relue({
              ...X,
              etapeAtteinte,
              origine,
              feuilleEprouvee,
              visiteTerminee,
              revocationFaite,
            });
            for (const pointeur of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
              for (const nombreDeCodes of [0, 1]) {
                const ecran = ecranCourant({
                  pointeur,
                  coffre: COFFRE.ouvert,
                  moyens: ["phrase", "recuperation"],
                  nombreDeCodes,
                  feuilleEprouvee: false,
                  progression,
                });
                essais += 1;
                assert.ok(
                  !ECRANS_DE_TRAVAIL.includes(ecran),
                  `constat absent, mais ${ecran} (étape ${etapeAtteinte}, pointeur ${pointeur})`,
                );
              }
            }
          }
        }
      }
    }
  }
  assert.equal(
    essais,
    9 * 2 * 2 * 2 * 2 * 10 * 2,
    "l'espace des champs est énuméré, pas échantillonné",
  );
});

test("[C2-17 7] ce qu'un fichier écrit par un document relit identique : l'écriture est complète, jamais partielle", () => {
  assert.deepEqual(lireProgression(ecrireProgression(relue(X))), relue(X));
  assert.deepEqual(lireProgression(ecrireProgression(relue(Y))), relue(Y));
});
