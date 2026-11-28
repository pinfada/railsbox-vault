/**
 * QUAND la page lance le téléchargement anticipé (#348), ce qu'elle en publie, et ce que l'attente dit.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TYPE_DU_BILAN,
  bilanPublie,
  telechargementAnticipeVoulu,
} from "../../src/coquille/telechargement-anticipe.mjs";
import { MESSAGES, progressionDuDemarrage } from "../../src/coquille/parcours.mjs";
import { texteDeLaPhase } from "../../src/coquille/accueil-de-la-mise-a-jour.mjs";

const voulu = (contexte) =>
  telechargementAnticipeVoulu({
    etapeAtteinte: 1,
    moteur: "chromium",
    vueComplete: false,
    ...contexte,
  });

test("voulu pendant les étapes 1 à 3 de la visite, et seulement là", () => {
  for (const etapeAtteinte of [1, 2, 3])
    assert.deepEqual(voulu({ etapeAtteinte }), { voulu: true });
  for (const etapeAtteinte of [4, 5, 9]) {
    assert.deepEqual(voulu({ etapeAtteinte }), { voulu: false, motif: "visite-avancee" });
  }
  assert.equal(
    voulu({ etapeAtteinte: Number.NaN }).voulu,
    false,
    "une étape illisible n'en lance pas",
  );
});

test("jamais sous Firefox, où l'application ne démarre pas, ni en vue complète", () => {
  assert.deepEqual(voulu({ moteur: "firefox" }), { voulu: false, motif: "firefox" });
  assert.deepEqual(voulu({ moteur: "webkit" }), { voulu: true });
  assert.deepEqual(voulu({ vueComplete: true }), { voulu: false, motif: "vue-complete" });
});

test("le bilan publié ne recopie que des mots connus", () => {
  const recu = {
    type: TYPE_DU_BILAN,
    bilan: {
      issue: "fait",
      artefacts: {
        rootfs: "admis",
        paquet: "VAULT-ARTEFACTS-ADMISSION-REFUSEE",
        kernel: "echec",
        inconnu: "admis",
        initrd: "<img src=x>",
        wasm: 42,
      },
      octets: new Uint8Array(4),
    },
  };
  assert.deepEqual(bilanPublie(recu), {
    issue: "fait",
    artefacts: { rootfs: "admis", paquet: "VAULT-ARTEFACTS-ADMISSION-REFUSEE", kernel: "echec" },
  });
  assert.deepEqual(bilanPublie({ type: TYPE_DU_BILAN, bilan: { issue: "occupe" } }), {
    issue: "occupe",
  });
  for (const autre of [null, {}, { type: "autre", bilan: { issue: "fait" } }]) {
    assert.deepEqual(bilanPublie(autre), { issue: "illisible" });
  }
  assert.deepEqual(bilanPublie({ type: TYPE_DU_BILAN, bilan: { issue: "fait ; rm" } }), {
    issue: "illisible",
  });
});

test("l'attente DISTINGUE la préparation, le téléchargement et le démarrage", () => {
  const dite = (phase) => progressionDuDemarrage({ ecouleMs: 40_000, signesDeVie: 3, phase });
  assert.match(dite("preparation"), /Étape en cours : préparation de l'application\./);
  assert.match(dite("telechargement"), /Étape en cours : téléchargement de l'application\./);
  assert.match(dite("demarrage"), /Étape en cours : démarrage de l'application\./);
  assert.equal(new Set(["preparation", "telechargement", "demarrage"].map(dite)).size, 3);
  // Les mêmes trois phases sous une mise à jour.
  assert.equal(texteDeLaPhase("preparation"), MESSAGES.phasePreparation);
  assert.equal(texteDeLaPhase("telechargement"), MESSAGES.phaseTelechargement);
});

test("le démarrage dit POURQUOI c'est long, en une phrase et sans jargon", () => {
  const [, explication] = MESSAGES.phaseDemarrage.split("de l'application. ");
  assert.equal(
    explication,
    "Cela prend du temps, car un ordinateur complet démarre dans votre navigateur.",
  );
  assert.doesNotMatch(explication, /machine virtuelle|VM|v86|émulat|Linux|Rails|noyau/i);
});
