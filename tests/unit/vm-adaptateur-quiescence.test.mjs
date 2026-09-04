import assert from "node:assert/strict";
import test from "node:test";

import { BlockJournal } from "../../src/vm/block-journal.mjs";
import { createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { SECTOR_SIZE, openMemoryVolume } from "../../src/vm/memory-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createV86BufferAdapter } from "../../src/vm/v86-buffer-adapter.mjs";

// QUIESCENCE de l'adaptateur de blocs (#65, ADR 0024, décision 5 ; ADR 0003 amendé).
//
// L'ADR 0003 refusait explicitement les instantanés mémoire — « `get_state`, `set_state`,
// `get_buffer` lèvent `VAULT_STORAGE_UNSUPPORTED` » — et donnait sa raison : « hors périmètre tant
// qu'ils ne sont pas liés à une génération du volume ». La condition est remplie par l'ADR 0024,
// et l'amendement porte EXACTEMENT sur ces deux gestes : `get_buffer` reste refusé.
//
// Ce que la quiescence garantit, et ce que cette épreuve mesure :
//
//  - elle REFUSE de s'établir tant qu'une E/S est en vol : capturer au-dessus d'une écriture en vol
//    donnerait une mémoire qui a vu ce que le support n'a pas reçu ;
//  - pendant la quiescence, toute E/S est REFUSÉE, le backend n'est pas touché, et l'acquittement
//    de v86 n'est PAS appelé — un acquittement pendant une capture serait exactement le mensonge
//    que `SEC-DURABLE-001` interdit ;
//  - `reprendre()` publie le NOMBRE de violations, pour que la capture puisse échouer proprement.
//
// Ce qu'elle ne garantit PAS, et l'ADR 0024 l'écrit : que le guest soit logiquement au repos.
// L'adaptateur ne voit que les E/S qui lui arrivent. C'est un filet, pas une preuve d'arrêt.

const LIAISON = Object.freeze({
  volume: "0123456789abcdef0123456789abcdef",
  sequence: 42,
  generation: 17,
});

let compteur = 0;
const TAILLE = 8 * SECTOR_SIZE;

function adaptateur({ liaisonDeVolume } = {}) {
  compteur += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `quiescence-${compteur}`,
    size: TAILLE,
    journal,
    faults: createFaultPlan(),
    flushDelay: 0,
  });
  const fatales = [];
  const adapte = createV86BufferAdapter({
    backend,
    onFatal: (erreur) => fatales.push(erreur),
    liaisonDeVolume,
  });
  return { adapte, backend, journal, fatales };
}

/**
 * Attend que l'adaptateur n'ait plus d'E/S en vol, et rend le compte observé.
 *
 * L'attente est nécessaire, et elle dit quelque chose du contrat : `inFlight` est décrémenté APRÈS
 * l'acquittement rendu au guest. Entre les deux, la quiescence est refusée alors que l'E/S est
 * logiquement finie. C'est le sens conservateur — refuser une capture de trop plutôt qu'en accepter
 * une de trop — et l'épreuve le constate au lieu de le contourner par un `await` bien placé.
 */
async function auRepos(adapte) {
  for (let essai = 0; essai < 200 && adapte.status().inFlight > 0; essai += 1) {
    await new Promise((resoudre) => setTimeout(resoudre, 1));
  }
  return adapte.status().inFlight;
}

/** Un `set` du contrat de v86, rendu attendable : `fn` est le seul acquittement du chemin PIO. */
function ecrire(adapte, offset, octets) {
  return new Promise((resoudre) => adapte.set(offset, octets, () => resoudre("acquitté")));
}

test("hors quiescence, l'adaptateur sert le guest comme avant", async () => {
  const { adapte, backend } = adaptateur();
  const acquittement = await ecrire(
    adapte,
    0,
    Uint8Array.from({ length: 512 }, () => 7),
  );
  assert.equal(acquittement, "acquitté");
  assert.equal((await backend.read(0, 4))[0], 7);
  assert.equal(adapte.status().quiesce, false);
});

test("quiescer REFUSE tant qu'une E/S est en vol", async () => {
  const { adapte } = adaptateur();
  let acquitte;
  const enVol = new Promise((resoudre) => {
    acquitte = resoudre;
  });
  adapte.set(0, new Uint8Array(512), () => acquitte());
  assert.equal(adapte.status().inFlight, 1, "l'écriture est bien en vol");
  assert.throws(
    () => adapte.quiescer(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.quiesce),
    "capturer au-dessus d'une E/S en vol donnerait une mémoire qui a vu ce que le support n'a pas reçu",
  );
  await enVol;
  assert.equal(await auRepos(adapte), 0, "l'E/S est rendue");
  assert.equal(
    adapte.quiescer().quiesce,
    true,
    "TÉMOIN : une fois l'E/S rendue, la quiescence s'établit",
  );
});

test("pendant la quiescence, une écriture est REFUSÉE et n'est jamais acquittée", async () => {
  const { adapte, backend, fatales } = adaptateur();
  adapte.quiescer();
  let acquitte = false;
  adapte.set(
    0,
    Uint8Array.from({ length: 512 }, () => 9),
    () => {
      acquitte = true;
    },
  );
  await Promise.resolve();
  assert.equal(acquitte, false, "aucun acquittement pendant une capture : SEC-DURABLE-001");
  assert.equal((await backend.read(0, 1))[0], 0, "le backend n'a pas été touché");
  assert.equal(fatales.length, 1);
  assert.equal(fatales[0].code, STORAGE_ERROR_CODES.quiesce);
});

test("pendant la quiescence, une lecture et une barrière sont REFUSÉES elles aussi", async () => {
  const { adapte, fatales } = adaptateur();
  adapte.quiescer();
  let rendu = false;
  adapte.get(0, 512, () => {
    rendu = true;
  });
  let barriere = false;
  adapte.flush(() => {
    barriere = true;
  });
  await Promise.resolve();
  assert.equal(rendu, false, "aucun clair rendu pendant une capture");
  assert.equal(barriere, false, "aucune barrière acquittée pendant une capture");
  assert.equal(fatales.length, 2);
});

test("reprendre PUBLIE le nombre de violations, et remet l'adaptateur en service", async () => {
  const { adapte, backend } = adaptateur();
  adapte.quiescer();
  adapte.set(0, new Uint8Array(512), () => {});
  adapte.set(512, new Uint8Array(512), () => {});
  await Promise.resolve();

  const reprise = adapte.reprendre();
  assert.equal(reprise.violations, 2, "une capture qui a vu deux E/S doit échouer proprement");
  assert.equal(adapte.status().quiesce, false);

  // TÉMOIN POSITIF : le guest est de nouveau servi.
  assert.equal(
    await ecrire(
      adapte,
      0,
      Uint8Array.from({ length: 512 }, () => 3),
    ),
    "acquitté",
  );
  assert.equal((await backend.read(0, 1))[0], 3);
});

test("une quiescence SANS violation le dit, et c'est le cas nominal", async () => {
  const { adapte } = adaptateur();
  adapte.quiescer();
  assert.equal(adapte.reprendre().violations, 0);
});

test("get_state ne rend QUE la liaison, et seulement pendant la quiescence", () => {
  const { adapte } = adaptateur({ liaisonDeVolume: () => LIAISON });
  assert.throws(
    () => adapte.get_state(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.quiesce),
    "un instantané ne se prend pas sur un adaptateur qui sert encore le guest",
  );
  adapte.quiescer();
  assert.deepEqual(adapte.get_state(), [LIAISON.volume, LIAISON.sequence, LIAISON.generation]);
  assert.equal(
    adapte.get_state().length,
    3,
    "la liaison, et RIEN du disque : le volume est la seule source de vérité",
  );
});

test("un adaptateur SANS liaison refuse l'instantané, comme avant l'ADR 0024", () => {
  const { adapte } = adaptateur();
  adapte.quiescer();
  assert.throws(
    () => adapte.get_state(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.unsupported),
  );
});

test("set_state confronte la liaison au volume RÉELLEMENT ouvert, et refuse tout écart", () => {
  const { adapte } = adaptateur({ liaisonDeVolume: () => LIAISON });
  // TÉMOIN POSITIF d'abord : la liaison du volume ouvert est acceptée.
  adapte.set_state([LIAISON.volume, LIAISON.sequence, LIAISON.generation]);

  // Et une SÉQUENCE plus ancienne que celle du volume ouvert passe elle aussi : toute ouverture en
  // écrit une racine vide, donc la séquence avance sans que le volume ait changé (ADR 0024, § 4).
  adapte.set_state([LIAISON.volume, LIAISON.sequence - 2, LIAISON.generation]);

  for (const ecart of [
    ["fedcba9876543210fedcba9876543210", LIAISON.sequence, LIAISON.generation],
    // Une séquence PLUS RÉCENTE que celle du volume ouvert décrit un journal ramené en arrière.
    [LIAISON.volume, LIAISON.sequence + 1, LIAISON.generation],
    [LIAISON.volume, LIAISON.sequence, LIAISON.generation + 1],
    [LIAISON.volume, LIAISON.sequence, LIAISON.generation - 1],
  ]) {
    assert.throws(
      () => adapte.set_state(ecart),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.identiteVolume),
      `l'écart ${JSON.stringify(ecart)} doit être refusé avant que le guest n'ait battu`,
    );
  }
  assert.throws(
    () => adapte.set_state([LIAISON.volume, LIAISON.sequence]),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.unsupported),
    "une liaison qui n'a pas la forme attendue n'est pas une liaison",
  );
});

test("get_buffer reste refusé : l'ADR 0003 n'est amendé que sur deux gestes", () => {
  const { adapte } = adaptateur({ liaisonDeVolume: () => LIAISON });
  adapte.quiescer();
  assert.throws(
    () => adapte.get_buffer(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.unsupported),
  );
});

test("un adaptateur DÉJÀ en panne refuse de quiescer : on ne capture pas au-dessus d'une faute", async () => {
  const { adapte, fatales } = adaptateur();
  // Une lecture hors bornes est un état contractuel du backend, pas une exception nue : elle passe
  // par `onFatal` sans jamais rendre de zéros au guest.
  adapte.get(TAILLE + SECTOR_SIZE, 512, () => {});
  await new Promise((resoudre) => setTimeout(resoudre, 10));
  assert.equal(fatales.length, 1);
  assert.equal(fatales[0].code, STORAGE_ERROR_CODES.outOfRange);
  assert.throws(
    () => adapte.quiescer(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.quiesce),
    "capturer au-dessus d'une faute donnerait un instantané d'un état que personne ne tient",
  );
});

test("après une E/S refusée, la session n'a plus DROIT à une seconde capture", async () => {
  // Le refus d'une E/S passe par le même chemin qu'une panne de support : il pose la faute FATALE
  // de l'adaptateur, et celle-ci ne se lève jamais. La conséquence est écrite dans le module, et
  // elle est ici EXÉCUTÉE — sans quoi elle serait une intention que le premier remaniement
  // effacerait sans que rien ne rougisse.
  //
  // C'est voulu : une E/S refusée pendant une capture veut dire que le guest attend une réponse que
  // personne ne lui donnera. Lui proposer une seconde capture reviendrait à capturer une mémoire en
  // attente d'un acquittement qui n'arrivera pas.
  const { adapte } = adaptateur();
  adapte.quiescer();
  adapte.set(0, new Uint8Array(512), () => {});
  await Promise.resolve();
  const rendu = adapte.reprendre();
  assert.equal(rendu.violations, 1, "la première capture a bien vu une violation");

  assert.throws(
    () => adapte.quiescer(),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.quiesce));
      assert.match(erreur.message, /porte déjà la faute/);
      return true;
    },
    "une seconde capture est refusée : l'adaptateur porte la faute du refus précédent",
  );
});
