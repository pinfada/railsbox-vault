/**
 * DATER UNE CRÉATION qui a écrit son fichier HORS TRANSACTION (#181, ADR 0034).
 *
 * ## Pourquoi ce geste existe, et pourquoi il a sa propre suite
 *
 * `openOpfsVolume` écrit la racine initiale À LA NAISSANCE, sur le fichier de zéros que la création
 * vient de sceller. Deux appelants écrivent ENSUITE le fichier entier hors transaction — la coquille
 * de produit, qui verse le disque applicatif (ADR 0030), et le banc de référence —, et cette écriture
 * change la RÉGION D'AUTHENTIFICATION, donc périme l'empreinte que la racine initiale scelle.
 *
 * **Sans `daterLaCreation`, le volume est REFUSÉ à sa première ouverture** par la garde de fraîcheur
 * de l'ADR 0019. C'est la direction sûre — un oubli coûte un refus, jamais un silence — mais c'est
 * aussi un chemin que seul un banc navigateur emprunterait, et qui resterait donc sans preuve sous
 * Node. Cette suite le mesure là où il se mesure : sur le double déterministe de #6.
 *
 * Quatre propriétés, et aucune ne se déduit des autres :
 *
 *  1. **le refus SANS datation** — c'est ce qui rend le geste nécessaire, et sans cette moitié la
 *     suivante ne prouverait pas grand-chose ;
 *  2. **la datation rouvre le volume**, et l'ouverture qui suit est NORMALE : une racine fait
 *     autorité, aucun engagement n'est consulté ;
 *  3. **elle refuse un volume EN SERVICE** : dater un journal qui porte autre chose que la racine
 *     initiale d'une création écarterait une écriture acquittée, ce que `SEC-DURABLE-001` interdit ;
 *  4. **elle refuse un fichier sans en-tête v3 lisible** : une création ne se date pas sans savoir
 *     de quel volume elle parle.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { GENERATION_ETATS } from "../../src/vm/generation-recuperation.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { DEK, TAILLE, VOLUME_A } from "./support-archive-recuperation.mjs";

const NOM = "verse";

/** Un secteur entier rempli d'un motif reconnaissable. */
function secteurDe(motif) {
  return new Uint8Array(SECTOR_SIZE).fill(motif);
}

/**
 * Rejoue le VERSEMENT de la coquille : naissance hors transaction, puis écriture du fichier entier
 * par le backend, puis fermeture. C'est exactement `verserLeDisque` de
 * `src/coquille/application-de-reference.mjs`, sans le flux HTTP.
 */
async function verser(store) {
  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  try {
    for (let rang = 0; rang < TAILLE / SECTOR_SIZE; rang += 1) {
      await backend.write(rang * SECTOR_SIZE, secteurDe(0x40 + rang));
    }
    await backend.flush();
  } finally {
    await backend.close();
  }
}

/** Ouvre TRANSACTIONNELLEMENT, comme le boot le fait, et rend ce que l'ouverture a trouvé. */
async function ouvrir(store) {
  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
  });
  try {
    return {
      rapport: backend.generation.rapport,
      secteur0: await backend.read(0, SECTOR_SIZE),
    };
  } finally {
    await backend.close();
  }
}

test("SANS datation, un volume versé hors transaction est REFUSÉ à la première ouverture", async () => {
  // La moitié qui rend le geste nécessaire. Le refus vient de la garde de FRAÎCHEUR : la racine
  // initiale de la naissance date une région que le versement a remplacée.
  const store = createSyncAccessStore();
  await verser(store);

  await assert.rejects(
    () => ouvrir(store),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.generationCorrupt),
    "un oubli de datation doit coûter un refus, jamais un silence",
  );
});

test("DATÉE, la création s'ouvre normalement : une racine fait autorité", async () => {
  const store = createSyncAccessStore();
  await verser(store);

  const rapport = await daterLaCreation({
    name: NOM,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
  });
  assert.equal(rapport.etat, GENERATION_ETATS.initialisee);
  assert.equal(rapport.racineInitiale, true, "la datation ÉCRIT, et elle le publie");
  assert.equal(rapport.motifDeLaRacine, "creation");

  const ouvert = await ouvrir(store);
  assert.equal(ouvert.rapport.etat, GENERATION_ETATS.aucune, "chemin normal : une racine décide");
  assert.equal(ouvert.rapport.racineInitiale, false);
  assert.ok(
    ouvert.secteur0.every((octet) => octet === 0x40),
    "le volume rend ce que le versement y a écrit",
  );
});

test("dater un volume EN SERVICE est REFUSÉ : ce serait écarter une écriture acquittée", async () => {
  // Le volume est versé, daté, puis il SERT : une génération est validée par une barrière. Dater de
  // nouveau viderait le journal, c'est-à-dire perdrait ce que cette barrière a acquitté.
  const store = createSyncAccessStore();
  await verser(store);
  await daterLaCreation({
    name: NOM,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
  });

  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
  });
  try {
    await backend.write(0, secteurDe(0x99));
    await backend.flush();
  } finally {
    await backend.close();
  }

  await assert.rejects(
    () =>
      daterLaCreation({
        name: NOM,
        cle: DEK,
        identifiantVolume: VOLUME_A,
        openHandle: store.openHandle,
      }),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.generationPending),
  );
});

test("dater un fichier sans en-tête v3 lisible est REFUSÉ, jamais deviné", async () => {
  // Une création ne se date pas sans savoir de quel volume elle parle : la taille LOGIQUE vient de
  // l'en-tête, et sans elle le constat du journal ferait passer toute racine pour abîmée.
  const store = createSyncAccessStore();
  const handle = await store.openHandle(NOM);
  handle.truncate(4096);
  handle.write(new Uint8Array(4096).fill(0x2a), { at: 0 });
  handle.flush();
  handle.close();

  await assert.rejects(
    () =>
      daterLaCreation({
        name: NOM,
        cle: DEK,
        identifiantVolume: VOLUME_A,
        openHandle: store.openHandle,
      }),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.geometryMismatch),
  );
});
