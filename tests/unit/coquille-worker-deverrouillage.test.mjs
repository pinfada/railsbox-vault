import assert from "node:assert/strict";
import test from "node:test";

import {
  ETATS_DU_VOLUME,
  fermerLesBancs,
  KEK,
  messageDeCode,
  messageDePhrase,
  poserUneEnveloppeV1,
  workerDeverrouillage,
} from "./support-worker-deverrouillage.mjs";
import { poserLeVolumeCoquille } from "./support-coffre-de-la-coquille.mjs";
import { IDENTIFIANT_DU_VOLUME_COQUILLE } from "../../src/coquille/identites-du-coffre.mjs";
import { revoquerToutSauf } from "../../src/vm/enveloppe-de-cle.mjs";
import { IDENTIFIANT_DU_COFFRE } from "../../src/coquille/identites-du-coffre.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { supportDe } from "./support-archive-recuperation.mjs";

// LE DÉVERROUILLAGE DU WORKER DE PRODUIT, EXÉCUTÉ (#311, C5).
//
// `public/runtime-worker-deverrouillage.mjs` est chargé tel qu'il est servi, sur le magasin en mémoire
// et les modules réels de `src/vm/`. Ces épreuves REMPLACENT les relectures de source qui tenaient
// lieu de preuve pour la lecture seule de la passe 1 et pour la revalidation de la passe 2 : ce
// qu'elles mesurent est ce que le chemin de production FAIT — quels octets d'enveloppe changent, et à
// quel moment par rapport à la prise du handle du volume.

test.afterEach(fermerLesBancs);

const ENVELOPPE = "coquille.cles";
const VOLUME = "coquille";
const octets = (banc, nom) => Buffer.from(banc.store.snapshot(nom));

/** Un coffre dont l'enveloppe est en page v1, et dont le petit volume existe déjà. */
async function coffreEnV1(options = {}) {
  const w = workerDeverrouillage();
  const pose = await poserUneEnveloppeV1(w.banc, options);
  await poserLeVolumeCoquille(w.banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  return { w, ...pose };
}

/**
 * Déverrouille en RETENANT la prise du handle du volume, et rend ce que l'enveloppe valait à cet
 * instant précis : « avant le handle ».
 */
async function deverrouillerEnRetenant(w, message) {
  const retenue = w.retenir(VOLUME);
  const issue = w.deverrouiller(message).then(
    (valeur) => ({ valeur }),
    (erreur) => ({ erreur }),
  );
  await Promise.race([retenue.atteint, issue.then(() => assert.fail("terminé avant le handle"))]);
  const avantLeHandle = octets(w.banc, ENVELOPPE);
  retenue.relacher();
  return { avantLeHandle, issue: await issue };
}

test("PHRASE sur une page v1 : l'enveloppe n'est PAS écrite avant le handle, la migration vient après", async () => {
  const { w } = await coffreEnV1();
  const initial = octets(w.banc, ENVELOPPE);

  const { avantLeHandle, issue } = await deverrouillerEnRetenant(w, await messageDePhrase());

  assert.deepEqual(
    avantLeHandle,
    initial,
    "aucun octet d'enveloppe écrit avant la prise du handle",
  );
  assert.equal(issue.erreur, undefined, String(issue.erreur?.code ?? issue.erreur));
  const reponse = w.reponses.at(-1).corps;
  assert.equal(reponse.enveloppeMigree, true, "la migration a eu lieu, sous le handle");
  assert.equal(reponse.versionEnveloppe, 8, "la version publiée est celle de la passe 2");
  assert.notDeepEqual(octets(w.banc, ENVELOPPE), initial, "la page v2 est publiée");
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("CODE sur une page v1 : l'enveloppe n'est PAS écrite avant le handle, la migration vient après", async () => {
  const { w, code } = await coffreEnV1({ avecCode: true });
  const initial = octets(w.banc, ENVELOPPE);

  const { avantLeHandle, issue } = await deverrouillerEnRetenant(w, messageDeCode(code));

  assert.deepEqual(
    avantLeHandle,
    initial,
    "aucun octet d'enveloppe écrit avant la prise du handle",
  );
  assert.equal(issue.erreur, undefined, String(issue.erreur?.code ?? issue.erreur));
  const reponse = w.reponses.at(-1).corps;
  assert.equal(reponse.enveloppeMigree, true);
  assert.equal(reponse.versionEnveloppe, 8);
  assert.notDeepEqual(octets(w.banc, ENVELOPPE), initial);
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("une enveloppe en page v2 s'ouvre sans migration, sous la même version", async () => {
  const w = workerDeverrouillage();
  // Création du coffre par le chemin de production : enveloppe v2 version 1, volume né.
  await w.deverrouiller(await messageDePhrase());
  await w.interne.backend.close();
  w.interne.backend = null;
  w.interne.etat = ETATS_DU_VOLUME.verrouille;
  const avant = octets(w.banc, ENVELOPPE);

  await w.deverrouiller(await messageDePhrase());

  const reponse = w.reponses.at(-1).corps;
  assert.equal(reponse.enveloppeMigree, false);
  assert.equal(reponse.versionEnveloppe, 1);
  assert.deepEqual(octets(w.banc, ENVELOPPE), avant, "ouvrir n'écrit pas une enveloppe v2");
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("un emplacement RÉVOQUÉ entre l'enveloppe et le handle est refusé : rien d'ouvert, handle rendu", async () => {
  const w = workerDeverrouillage();
  // Un coffre ouvert par A (phrase), qui imprime un code ; A garde son volume jusqu'à sa fermeture.
  await w.deverrouiller(await messageDePhrase());
  const { creerMoyenDeRecuperation } = await import("../../src/vm/moyen-de-recuperation.mjs");
  const support = supportDe(w.banc, VOLUME);
  const moyen = await creerMoyenDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  const code = moyen.rendre();
  await w.interne.backend.close(); // A ferme : le volume est libre pour B
  w.interne.backend = null;
  w.interne.etat = ETATS_DU_VOLUME.verrouille;

  // B présente le code, retenu avant le handle ; A révoque pendant ce temps.
  const barrieresAvant = w.interne.barrieres;
  const retenue = w.retenir(VOLUME);
  const issue = w.deverrouiller(messageDeCode(code)).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  await revoquerToutSauf({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: KEK });
  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(erreur?.code, ENVELOPPE_ERROR_CODES.cleRefusee);
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.verrouille, "jamais ouvert sous une clé révoquée");
  assert.equal(w.interne.backend, null);
  assert.equal(w.interne.barrieres, barrieresAvant, "le secteur de serrure n'a pas été écrit");
  assert.equal(w.banc.store.isOpen(VOLUME), false, "le handle du volume est rendu");
});

test("un second déverrouillage referme d'abord le volume précédent : un seul handle tenu", async () => {
  const w = workerDeverrouillage();
  await w.deverrouiller(await messageDePhrase());
  const premier = w.interne.backend;
  // Un second geste sur le même Worker referme d'abord le volume précédent (constat 6 de #167), puis
  // rouvre : le volume reste ouvert une seule fois.
  await w.deverrouiller(await messageDePhrase());
  assert.notEqual(w.interne.backend, premier);
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});
