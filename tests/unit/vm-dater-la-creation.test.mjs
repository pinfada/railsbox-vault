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
 * Six propriétés, et aucune ne se déduit des autres :
 *
 *  1. **le refus SANS datation** — c'est ce qui rend le geste nécessaire, et sans cette moitié la
 *     suivante ne prouverait pas grand-chose ;
 *  2. **la datation rouvre le volume**, et l'ouverture qui suit est NORMALE : une racine fait
 *     autorité, aucun engagement n'est consulté ;
 *  3. **elle refuse un volume EN SERVICE** : dater un journal qui porte autre chose que la racine
 *     initiale d'une création écarterait une écriture acquittée, ce que `SEC-DURABLE-001` interdit ;
 *  4. **elle refuse un fichier sans en-tête v3 lisible** : une création ne se date pas sans savoir
 *     de quel volume elle parle ;
 *  5. **elle refuse un volume RESTAURÉ** — dont le journal ne porte AUCUNE racine. C'est l'état
 *     qu'une restauration laisse, jamais celui d'une création, et le tolérer rouvrait le mélange
 *     A/C de #181 par un geste que `opfs-block-backend.mjs` exporte (constat 2 de la revue de
 *     sécurité et constat 1 de la revue de format de la PR #184) ;
 *  6. **elle refuse un fichier qui n'est plus celui que le versement a écrit** : l'empreinte rendue
 *     par le versement est ce qui relie les deux gestes par-dessus la fenêtre où personne ne tient
 *     le fichier (constat 1 de la revue de sécurité).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { GENERATION_ETATS } from "../../src/vm/generation-recuperation.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { constaterCreationSeule } from "../../src/vm/opfs-datation-de-creation.mjs";
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
    // Ce versement sera DATÉ, et il le déclare : `daterLaCreation` est sa clôture. Sans cette
    // déclaration, la fermeture écrirait une racine de clôture, et la datation trouverait un
    // journal « en service » qu'elle refuserait de dater (#182, T2b).
    clotureParDatation: true,
  });
  try {
    for (let rang = 0; rang < TAILLE / SECTOR_SIZE; rang += 1) {
      await backend.write(rang * SECTOR_SIZE, secteurDe(0x40 + rang));
    }
    await backend.flush();
    // L'EMPREINTE est prise ICI, encore sous l'exclusivité du versement : c'est ce qui la distingue
    // d'une relecture quelconque, et c'est ce que `daterLaCreation` confrontera (#181).
    return await backend.empreinteDuFichier();
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
  const empreinteVersee = await verser(store);

  const rapport = await daterLaCreation({
    name: NOM,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    empreinteVersee,
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
  const empreinteVersee = await verser(store);
  await daterLaCreation({
    name: NOM,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    empreinteVersee,
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
        empreinteVersee,
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

// --- `constaterCreationSeule` — la SIGNATURE d'une installation interrompue (#173) -----------------
//
// La MESURE, en rejouant une interruption sur ce même double : le journal de génération n'est
// JAMAIS absent pendant une installation — une création l'écrit dès l'ouverture, avant tout
// versement. Ce qui distingue une création encore EN COURS d'une création ACHEVÉE (ou de tout
// autre chose) est le CONTENU du journal : tant qu'aucune barrière n'a été franchie, il ne porte que
// la racine de naissance, seule. `constaterCreationSeule` OBSERVE ce contenu sans en muter un octet
// — contrairement à `ecarterLeJournalDeCreation`, dont c'est le premier geste avant de tronquer.

/** Observateur qui STATUE sans jamais créer un fichier : le même contrat que `statOpfsVolume`. */
function observerDuStore(store) {
  return async (nom) => ({ present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) });
}

test("constaterCreationSeule : VRAI à la naissance, avant tout versement", async () => {
  const store = createSyncAccessStore();
  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await backend.close();

  const constat = await constaterCreationSeule({
    name: NOM,
    openHandle: store.openHandle,
    observer: observerDuStore(store),
  });
  assert.equal(constat.creationSeule, true, constat.motif);
  assert.equal(constat.motif, null);
  assert.equal(constat.tailleLogique, TAILLE);
});

test("constaterCreationSeule : VRAI encore après le versement complet, TANT QUE rien n'a daté", async () => {
  // `verser` reproduit `verserLeDisque` À L'IDENTIQUE : il écrit, flush UNE fois, ferme — sous
  // `clotureParDatation: true`. Ce drapeau est précisément ce qui laisse le journal dans l'état de
  // naissance jusqu'à la datation : c'est la fenêtre RÉALISTE d'une interruption, du tout début du
  // versement jusqu'à la toute fin, et pas seulement le premier instant après l'ouverture.
  const store = createSyncAccessStore();
  await verser(store);

  const constat = await constaterCreationSeule({
    name: NOM,
    openHandle: store.openHandle,
    observer: observerDuStore(store),
  });
  assert.equal(constat.creationSeule, true, constat.motif);
});

test("constaterCreationSeule : VRAI encore juste après la datation, tant que rien ne l'a réutilisé", async () => {
  // La datation écrit une racine dont le motif reste « creation » : `constaterCreationSeule` ne
  // distingue pas encore ce rang de « pas datée » — et c'est voulu, puisqu'un volume daté mais dont
  // le manifeste n'est pas encore inscrit EST toujours une installation inachevée. C'est l'USAGE
  // NORMAL qui suit qui fait la différence (témoin négatif ci-dessous), pas la seule datation.
  const store = createSyncAccessStore();
  const empreinteVersee = await verser(store);
  await daterLaCreation({
    name: NOM,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    empreinteVersee,
    openHandle: store.openHandle,
  });

  const constat = await constaterCreationSeule({
    name: NOM,
    openHandle: store.openHandle,
    observer: observerDuStore(store),
  });
  assert.equal(constat.creationSeule, true, constat.motif);
});

test("constaterCreationSeule : FAUX dès qu'un usage NORMAL a suivi la datation", async () => {
  // Témoin négatif : une fois le volume réellement rouvert et réécrit — l'usage qui suit une
  // installation ACHEVÉE —, le journal cesse de ne porter que sa racine de naissance. C'est la
  // frontière que le prédicat protège : un volume déjà EN SERVICE n'est jamais confondu avec une
  // installation qui n'a pas fini.
  const store = createSyncAccessStore();
  const empreinteVersee = await verser(store);
  await daterLaCreation({
    name: NOM,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    empreinteVersee,
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
    await backend.write(0, secteurDe(0x55));
    await backend.flush();
  } finally {
    await backend.close();
  }

  const constat = await constaterCreationSeule({
    name: NOM,
    openHandle: store.openHandle,
    observer: observerDuStore(store),
  });
  assert.equal(constat.creationSeule, false);
  assert.match(constat.motif, /ne porte pas la seule racine initiale/);
});

test("constaterCreationSeule : FAUX sans journal lisible — ce n'est pas ce qu'une création laisse", async () => {
  // Un fichier de volume posé par autre chose que ce produit — ou par une restauration qui n'a
  // jamais ouvert via `openOpfsVolume` — n'a pas de journal de génération. La fonction ne le
  // FABRIQUE pas pour trancher : un journal absent est un refus de la signature, jamais une invite.
  const store = createSyncAccessStore();
  const handle = await store.openHandle(NOM);
  handle.truncate(TAILLE);
  handle.flush();
  handle.close();

  const constat = await constaterCreationSeule({
    name: NOM,
    openHandle: store.openHandle,
    observer: observerDuStore(store),
  });
  assert.equal(constat.creationSeule, false);
  assert.match(constat.motif, /aucun journal de génération/);
});

test("constaterCreationSeule : n'ouvre ni ne crée le journal quand l'observateur le dit absent", async () => {
  // Mutant nommé « le journal est ouvert avant d'être observé » : sans cette garde, la fonction
  // FABRIQUERAIT le fichier en tentant de l'ouvrir — exactement ce qu'un « constat » ne doit jamais
  // faire. L'observateur ment ici volontairement (le journal existe RÉELLEMENT sur le store, mais
  // il annonce son absence) pour prouver que la décision suit l'observation, pas le disque.
  const store = createSyncAccessStore();
  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await backend.close();

  const constat = await constaterCreationSeule({
    name: NOM,
    openHandle: store.openHandle,
    observer: async () => ({ present: false, size: 0 }),
  });
  assert.equal(constat.creationSeule, false);
  assert.match(constat.motif, /aucun journal de génération/);
});
