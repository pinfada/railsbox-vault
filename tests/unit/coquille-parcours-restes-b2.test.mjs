// Les restes du parcours (#266 m1, m3, m11 ; #242 point 4) : lot B2. Chaque épreuve est née rouge.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ORIGINES_DU_COFFRE,
  attenteDeLaPhrase,
  ouSuisJe,
  progressionDuDemarrage,
} from "../../src/coquille/parcours.mjs";
import { ancreSaisie } from "../../src/coquille/interface-de-deverrouillage.mjs";
import { ECRANS, STATUTS } from "../../src/coquille/textes-du-parcours.mjs";

test("m1 : l'attente d'une CRÉATION ne promet ni « une minute et demie » ni une durée de réouverture", () => {
  const creation = attenteDeLaPhrase(446);
  assert.match(creation, /environ 2 secondes/);
  assert.match(creation, /figé/);
  assert.doesNotMatch(creation, /minute et demie/);
});

test("m1 : l'attente d'une RÉOUVERTURE annonce l'ordre de grandeur mesuré (6 à 20 s), pas « 2 secondes »", () => {
  const reouverture = attenteDeLaPhrase(446, { reouverture: true });
  assert.match(reouverture, /de 2 à 20 secondes/);
  assert.doesNotMatch(reouverture, /environ 2 secondes|minute et demie/);
  assert.match(reouverture, /figé/);
  // Firefox : la borne basse suit la table mesurée, la borne haute reste celle de la recette.
  assert.match(attenteDeLaPhrase(2207, { reouverture: true }), /de 4 à 20 secondes/);
});

test("m3 : avant la restauration, aucune étape ne dit que le coffre est restauré, ni de quelque façon que ce soit", () => {
  const avant = ouSuisJe("restaurer", ORIGINES_DU_COFFRE.creation, { etapeAtteinte: 7 });
  assert.deepEqual(
    avant.map((ligne) => ligne.statut),
    [...Array(6).fill("non-jouee-ici"), "en-cours", "a-venir", "a-venir"],
  );
  for (const { statut } of avant) {
    assert.doesNotMatch(
      STATUTS[statut],
      /restaur/i,
      `« ${STATUTS[statut]} » promet une restauration`,
    );
  }
  assert.match(STATUTS["non-jouee-ici"], /^non jouée sur cet appareil$/);
});

test("m3 : après la restauration, les étapes 1 à 6 disent d'où vient le coffre", () => {
  const apres = ouSuisJe("revoquer", ORIGINES_DU_COFFRE.restauration, { etapeAtteinte: 9 });
  assert.deepEqual(
    apres.slice(0, 6).map((ligne) => ligne.statut),
    Array(6).fill("non-jouee"),
  );
  assert.match(STATUTS["non-jouee"], /a été restauré/);
});

test("#242 (4) : un démarrage ordinaire dit l'étape en cours quand le coffre la connaît", () => {
  // Depuis #348, la phase `telechargement` n'est posée que si des octets viennent du réseau : la page
  // la dit telle quelle, et la préparation a sa propre phase.
  const telechargement = progressionDuDemarrage({
    ecouleMs: 40_000,
    signesDeVie: 3,
    phase: "preparation",
  });
  assert.match(telechargement, /Étape en cours : préparation de l'application/);
  const demarrage = progressionDuDemarrage({
    ecouleMs: 70_000,
    signesDeVie: 8,
    phase: "demarrage",
  });
  assert.match(demarrage, /Étape en cours : démarrage de l'application/);
  assert.notEqual(telechargement.split("Étape en cours")[1], demarrage.split("Étape en cours")[1]);
  // Sans phase connue, la phrase d'avant reste celle qui est servie.
  assert.doesNotMatch(
    progressionDuDemarrage({ ecouleMs: 40_000, signesDeVie: 3 }),
    /Étape en cours/,
  );
  assert.doesNotMatch(
    progressionDuDemarrage({ ecouleMs: 40_000, signesDeVie: 3, phase: "inconnue" }),
    /Étape en cours/,
  );
});

test("M3 : chaque « Ce que vous avez à faire » tient en une phrase d'action, les cas rares sont repliés", () => {
  for (const [id, ecran] of Object.entries(ECRANS)) {
    const mots = ecran.attendu.split(/\s+/).length;
    assert.ok(mots <= 50, `${id} : « attendu » fait ${mots} mots, les cas rares se replient`);
  }
  assert.match(ECRANS["code-a-verifier"].casRares, /afficher un nouveau code/);
  assert.match(ECRANS["code-a-verifier"].casRares, /Révoquer tous les autres moyens/);
});

test("B2-7 : le message d'un numéro de feuille faux emploie les mots de la page", () => {
  const { valide, aveu } = ancreSaisie("une phrase");
  assert.equal(valide, false);
  assert.match(aveu, /numéro de feuille/);
  assert.doesNotMatch(aveu, /version/);
});
