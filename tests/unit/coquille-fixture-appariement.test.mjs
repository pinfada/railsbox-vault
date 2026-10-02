// L'appariement des réponses du port restreint par la fixture malveillante (#179).
//
// Ces épreuves tiennent la cause de l'intermittence : une réponse TARDIVE ne doit jamais être servie
// à la sonde suivante, sans quoi la frontière paraît franchie alors que la fixture mesure sa propre
// file d'attente.

import assert from "node:assert/strict";
import test from "node:test";

import { appariementDuPort } from "../../public/coquille-epreuve/appariement.mjs";
import { TYPES_APPLICATIFS } from "../../src/coquille/contrat-de-messages.mjs";

const AUCUNE_REPONSE = { type: "vault.coquille.aucune-reponse" };

function nouvelAppariement() {
  return appariementDuPort({ typeDeRefus: TYPES_APPLICATIFS.refus });
}

/** Une attente et ce qu'elle a reçu. */
function attendre(appariement, correlation) {
  const recu = [];
  const attente = appariement.attendre(correlation, (valeur) => recu.push(valeur));
  return { attente, recu };
}

test("une réponse tardive n'est pas servie à la sonde suivante", () => {
  const appariement = nouvelAppariement();
  const premiere = attendre(appariement, "hostile-7");
  appariement.expirer(premiere.attente, AUCUNE_REPONSE);
  // La sonde suivante poste un contrat étranger : sa réponse ne portera aucune corrélation.
  const suivante = attendre(appariement, null);

  const tardive = { type: TYPES_APPLICATIFS.etatReponse, correlation: "hostile-7" };
  assert.equal(appariement.servir(tardive), false, "la réponse tardive est ignorée");

  const refus = { type: TYPES_APPLICATIFS.refus, code: "VAULT_COQUILLE_CONTRAT_REFUSE" };
  assert.equal(appariement.servir(refus), true);
  assert.deepEqual(premiere.recu, [AUCUNE_REPONSE]);
  assert.deepEqual(suivante.recu, [refus]);
});

test("les réponses sont servies par corrélation, quel que soit leur ordre d'arrivée", () => {
  const appariement = nouvelAppariement();
  const a = attendre(appariement, "hostile-1");
  const b = attendre(appariement, "hostile-2");
  const reponseB = { type: TYPES_APPLICATIFS.etatReponse, correlation: "hostile-2" };
  const reponseA = { type: TYPES_APPLICATIFS.etatReponse, correlation: "hostile-1" };

  appariement.servir(reponseB);
  appariement.servir(reponseA);

  assert.deepEqual(a.recu, [reponseA]);
  assert.deepEqual(b.recu, [reponseB]);
  assert.equal(appariement.vivantes, 0);
});

test("« aucune-reponse » ne vaut que pour l'attente dont la corrélation n'est jamais revenue", () => {
  const appariement = nouvelAppariement();
  const servie = attendre(appariement, "hostile-1");
  const muette = attendre(appariement, "hostile-2");
  appariement.servir({ type: TYPES_APPLICATIFS.etatReponse, correlation: "hostile-1" });

  assert.equal(appariement.expirer(servie.attente, AUCUNE_REPONSE), false);
  assert.equal(appariement.expirer(muette.attente, AUCUNE_REPONSE), true);
  assert.equal(servie.recu.length, 1);
  assert.deepEqual(muette.recu, [AUCUNE_REPONSE]);
});

test("un refus SANS corrélation n'est jamais servi à une attente qui en espère une", () => {
  const appariement = nouvelAppariement();
  const correlee = attendre(appariement, "hostile-3");
  assert.equal(appariement.servir({ type: TYPES_APPLICATIFS.refus, code: "X" }), false);
  assert.deepEqual(correlee.recu, []);
});

test("les refus sans corrélation sont appariés par ordre parmi les attentes sans corrélation", () => {
  const appariement = nouvelAppariement();
  const premiere = attendre(appariement, null);
  const correlee = attendre(appariement, "hostile-4");
  const seconde = attendre(appariement, null);
  const refus1 = { type: TYPES_APPLICATIFS.refus, code: "A" };
  const refus2 = { type: TYPES_APPLICATIFS.refus, code: "B" };

  appariement.servir(refus1);
  appariement.servir(refus2);

  assert.deepEqual(premiere.recu, [refus1]);
  assert.deepEqual(seconde.recu, [refus2]);
  assert.deepEqual(correlee.recu, []);
});

test("une annonce poussée par la coquille n'est servie à aucune sonde", () => {
  const appariement = nouvelAppariement();
  const sansCorrelation = attendre(appariement, null);
  assert.equal(appariement.servir({ type: TYPES_APPLICATIFS.barriere }), false);
  assert.deepEqual(sansCorrelation.recu, []);
});

test("deux attentes de la MÊME corrélation sont servies dans l'ordre d'émission", () => {
  // `correlation-dupliquee` poste deux fois le même identifiant : refus et réponse portent le même.
  const appariement = nouvelAppariement();
  const a = attendre(appariement, "hostile-5");
  const b = attendre(appariement, "hostile-5");
  const refus = { type: TYPES_APPLICATIFS.refus, code: "D", correlation: "hostile-5" };
  const etat = { type: TYPES_APPLICATIFS.etatReponse, correlation: "hostile-5" };

  appariement.servir(refus);
  appariement.servir(etat);

  assert.deepEqual(a.recu, [refus]);
  assert.deepEqual(b.recu, [etat]);
});
