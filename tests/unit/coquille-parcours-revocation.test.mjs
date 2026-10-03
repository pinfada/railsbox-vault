// La révocation FAITE est retenue par la progression (#223).
//
// Avant : `parcours.json` portait l'étape atteinte (9), pas le fait que la révocation avait eu lieu ;
// après un rechargement, l'écran redevenait « revoquer » au lieu de « Parcours terminé ».

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COFFRE,
  PROGRESSION_INITIALE,
  ecranCourant,
  ecrireProgression,
  lireProgression,
  progressionApres,
} from "../../src/coquille/parcours.mjs";
import { ECRANS } from "../../src/coquille/textes-du-parcours.mjs";

const aLEtape9 = progressionApres(
  progressionApres(PROGRESSION_INITIALE, "feuille", true),
  "etape",
  9,
);

test("la révocation faite survit à l'écriture puis à la relecture de parcours.json", () => {
  const apres = progressionApres(aLEtape9, "revocation-faite");
  assert.equal(apres.revocationFaite, true);
  assert.equal(lireProgression(ecrireProgression(apres)).revocationFaite, true);
});

test("après rechargement, un coffre révoqué rend « Parcours terminé », et non « revoquer »", () => {
  const relue = lireProgression(ecrireProgression(progressionApres(aLEtape9, "revocation-faite")));
  const ecran = ecranCourant({
    pointeur: 9,
    coffre: COFFRE.ouvert,
    moyens: ["phrase", "recuperation"],
    feuilleEprouvee: true,
    progression: relue,
  });
  assert.equal(ecran, "termine");
});

test("sans révocation, l'étape 9 reste « revoquer »", () => {
  const ecran = ecranCourant({
    pointeur: 9,
    coffre: COFFRE.ouvert,
    moyens: ["phrase", "recuperation"],
    feuilleEprouvee: true,
    progression: aLEtape9,
  });
  assert.equal(ecran, "revoquer");
});

test("un parcours.json du format 2 écrit avant #223 se relit encore, sans révocation", () => {
  const ancien = JSON.parse(ecrireProgression(aLEtape9));
  delete ancien.revocationFaite;
  const relue = lireProgression(JSON.stringify(ancien));
  assert.equal(relue.etapeAtteinte, 9);
  assert.equal(relue.revocationFaite, false);
});

test("un coffre neuf n'hérite pas de la révocation d'un coffre abandonné", () => {
  const revoque = progressionApres(aLEtape9, "revocation-faite");
  assert.equal(progressionApres(revoque, "coffre-cree").revocationFaite, false);
});

test("« Parcours terminé » dit comment recommencer, et que les cookies ne suffisent pas", () => {
  const texte = Object.values(ECRANS.termine).join(" ");
  assert.match(texte, /données du site/);
  assert.match(texte, /cookies ne suffit pas/);
});
