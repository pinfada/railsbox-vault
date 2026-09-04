import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE, V86_BLOCK_SIZE } from "../../src/vm/block-geometry.mjs";
import { BlockJournal, JOURNAL_OPERATIONS } from "../../src/vm/block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { tailleSupportV3 } from "../../src/vm/volume-chiffre-format.mjs";

// Tests unitaires du backend de blocs OPFS (#6, `VAULT-PERSIST-001`). Ils utilisent un DOUBLE
// déterministe de `FileSystemSyncAccessHandle` — lui-même vérifié par
// `vm-sync-access-double.test.mjs` — pour rejouer sans navigateur les fautes que le vrai OPFS ne
// produit pas à la demande : quota, handle perdu, écriture partielle, lecture courte.
//
// Ce que ces tests NE prouvent pas : que le vrai OPFS se comporte ainsi. C'est le rôle de
// `tests/browser/opfs-block-backend.spec.mjs`, qui rejoue les mêmes observations sur le vrai
// support, dans un Worker dédié.

const TAILLE = 64 * SECTOR_SIZE;
/**
 * Taille du FICHIER pour cette taille logique : en-tête v3, région d'authentification, charge.
 *
 * Les deux ne se confondent jamais (ADR 0016) — `size()` rend la logique, le support porte la
 * seconde —, et l'écart de 6,64 % est ce que le sceau de chaque secteur coûte.
 */
const SUPPORT = tailleSupportV3(TAILLE);
let compteur = 0;

/**
 * Ouvre un volume adossé à un double neuf, sous un nom jamais réutilisé.
 * `options.store` configure le double (quota, plafond d'écriture), il ne le remplace pas.
 */
async function volume(options = {}) {
  compteur += 1;
  const { store: configuration, ...reste } = options;
  const store = createSyncAccessStore(configuration);
  const journal = reste.journal ?? new BlockJournal();
  const backend = await openOpfsVolume({
    name: `test-${compteur}`,
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
    ...reste,
    journal,
  });
  return { backend, journal, store, name: backend.name };
}

function motif(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 31 + graine) % 256);
}

test("la géométrie déclarée est stable, alignée secteur et multiple du bloc v86", async () => {
  const { backend, store } = await volume();

  assert.equal(backend.size(), TAILLE);
  assert.equal(backend.size() % SECTOR_SIZE, 0);
  assert.equal(backend.size() % V86_BLOCK_SIZE, 0, "le contrat de tampon v86 adresse par 256 o");
  assert.equal(backend.describe().kind, "opfs");
  assert.equal(backend.describe().durable, true, "OPFS est un support durable, contrairement à #4");
  assert.equal(backend.describe().sectorSize, SECTOR_SIZE);

  await assert.rejects(
    () =>
      openOpfsVolume({
        name: "biscornu",
        size: 700,
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
      }),
    RangeError,
  );
  await backend.close();
});

test("le fichier est créé à la géométrie déclarée, pas à la taille des écritures", async () => {
  const { backend, store, name } = await volume();

  assert.equal(store.sizeOf(name), SUPPORT, "le volume est alloué à l'ouverture, sceaux compris");
  await backend.write(0, motif(SECTOR_SIZE, 1));
  assert.equal(store.sizeOf(name), SUPPORT, "une écriture ne redimensionne pas le volume");
  await backend.close();
});

test("lecture à plusieurs offsets, aux limites de blocs et jusqu'à la fin du fichier", async () => {
  const { backend } = await volume();
  const donnees = motif(4 * SECTOR_SIZE, 7);
  await backend.write(TAILLE - 4 * SECTOR_SIZE, donnees);

  const plages = [
    [TAILLE - 4 * SECTOR_SIZE, SECTOR_SIZE],
    [TAILLE - 3 * SECTOR_SIZE - 1, 2],
    [TAILLE - V86_BLOCK_SIZE, V86_BLOCK_SIZE],
    [TAILLE - 1, 1],
    [TAILLE - 4 * SECTOR_SIZE, 4 * SECTOR_SIZE],
  ];

  for (const [offset, longueur] of plages) {
    const relue = await backend.read(offset, longueur);
    const debut = offset - (TAILLE - 4 * SECTOR_SIZE);
    assert.deepEqual(
      [...relue],
      [...donnees.subarray(debut, debut + longueur)],
      `plage ${offset}+${longueur}`,
    );
  }

  // Un octet de plus que la fin du volume est une erreur typée, jamais un tampon complété de zéros.
  await assert.rejects(
    () => backend.read(TAILLE - 1, 2),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.outOfRange),
  );
  await backend.close();
});

test("une écriture non alignée puis une écriture sectorielle se relisent octet pour octet", async () => {
  const { backend } = await volume();
  const nonAlignee = motif(173, 3);
  const sectorielle = motif(SECTOR_SIZE, 11);
  const offsetNonAligne = 5 * SECTOR_SIZE + 37;

  await backend.write(offsetNonAligne, nonAlignee);
  await backend.write(20 * SECTOR_SIZE, sectorielle);

  assert.deepEqual([...(await backend.read(offsetNonAligne, 173))], [...nonAlignee]);
  assert.deepEqual([...(await backend.read(20 * SECTOR_SIZE, SECTOR_SIZE))], [...sectorielle]);

  // Le voisinage immédiat d'une écriture non alignée reste intact : pas de recopie de secteur.
  assert.equal((await backend.read(offsetNonAligne - 1, 1))[0], 0);
  assert.equal((await backend.read(offsetNonAligne + 173, 1))[0], 0);
  await backend.close();
});

test("la lecture rend une copie détachée : modifier le résultat ne touche pas le volume", async () => {
  const { backend } = await volume();
  await backend.write(0, new Uint8Array(SECTOR_SIZE).fill(7));

  const copie = await backend.read(0, SECTOR_SIZE);
  copie[0] = 42;

  assert.equal((await backend.read(0, SECTOR_SIZE))[0], 7);
  await backend.close();
});

test("fermeture puis réouverture : les octets et la géométrie sont identiques", async () => {
  const store = createSyncAccessStore();
  const donnees = motif(3 * SECTOR_SIZE, 5);

  const premier = await openOpfsVolume({
    name: "persistant",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  await premier.write(9 * SECTOR_SIZE + 11, donnees);
  await premier.flush();
  await premier.close();

  // Réouverture SANS taille déclarée : la géométrie est relue du fichier, pas supposée.
  const second = await openOpfsVolume({
    name: "persistant",
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  assert.equal(second.size(), TAILLE);
  assert.deepEqual([...(await second.read(9 * SECTOR_SIZE + 11, 3 * SECTOR_SIZE))], [...donnees]);
  await second.close();
});

test("réouvrir avec une autre géométrie est une erreur typée, jamais une troncature", async () => {
  const store = createSyncAccessStore();
  const premier = await openOpfsVolume({
    name: "geometrie",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  await premier.close();

  await assert.rejects(
    () =>
      openOpfsVolume({
        name: "geometrie",
        size: TAILLE * 2,
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
      }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch),
  );
  assert.equal(store.sizeOf("geometrie"), SUPPORT, "le volume existant n'a pas été redimensionné");
});

test("une géométrie qui change sous le volume ouvert est détectée, pas absorbée", async () => {
  const { backend, store, name } = await volume();
  await backend.write(0, motif(SECTOR_SIZE, 2));

  // Le support rétrécit à l'insu du backend : c'est exactement ce que `size()` ne doit pas suivre
  // en silence.
  store.resize(name, TAILLE - SECTOR_SIZE);

  assert.equal(backend.size(), TAILLE, "size() reste la géométrie de la session");
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch) &&
      erreur.context.observed === TAILLE - SECTOR_SIZE,
  );
  await assert.rejects(
    () => backend.write(0, motif(SECTOR_SIZE, 2)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.geometryMismatch),
  );
});

test("une lecture courte du support devient une erreur typée, jamais un tampon complété", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1, bytes: SECTOR_SIZE },
  ]);
  const { backend } = await volume({ faults });
  await backend.write(0, new Uint8Array(4 * SECTOR_SIZE).fill(0xcd));

  await assert.rejects(
    () => backend.read(0, 4 * SECTOR_SIZE),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.shortRead) &&
      erreur.context.requested === 4 * SECTOR_SIZE &&
      erreur.context.obtained === SECTOR_SIZE,
  );
  await backend.close();
});

test("une écriture partielle du support est signalée et n'entame pas le volume", async () => {
  // Le plafond est posé APRÈS la création : depuis #18, créer un volume v3 SCELLE tous ses
  // secteurs, donc écrit — et un plafond posé dès l'ouverture mesurerait cette création plutôt que
  // l'écriture du guest.
  const { backend, store, name } = await volume();
  store.plafonnerEcriture(SECTOR_SIZE);
  assert.equal(store.sizeOf(name), SUPPORT);
  const donnees = new Uint8Array(4 * SECTOR_SIZE).fill(0xab);

  await assert.rejects(
    () => backend.write(0, donnees),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.partialWrite) &&
      erreur.context.accepted === SECTOR_SIZE &&
      erreur.context.requested === 4 * SECTOR_SIZE,
  );

  // C'est ici que #16 change le contrat de #6. Jusqu'à cette tranche, une écriture partielle
  // laissait dans le VOLUME les octets acceptés : « ni ancien état complet, ni nouvel état complet »,
  // un état intermédiaire réel et connu — mais un état que l'oracle de #15 classait DÉCHIRÉ. La
  // génération transactionnelle déplace ces octets dans le journal voisin : la déchirure y est aussi
  // réelle, mais elle n'atteint plus le volume, et la génération sera écartée à la réouverture.
  const relue = await backend.read(0, 2 * SECTOR_SIZE);
  assert.equal(relue[0], 0x00, "le volume porte encore l'état d'avant l'écriture");
  assert.equal(relue[SECTOR_SIZE], 0x00);
  await backend.close();
});

test("un dépassement de quota du support est un état distinct, jamais un succès", async () => {
  // Le quota laisse juste de quoi ouvrir le volume et son journal de génération, plus une poignée
  // d'octets : l'écriture qui déborde est celle du JOURNAL, puisque c'est là que va désormais une
  // génération en cours. Le code et le remède ne changent pas — libérer de la place.
  const { backend } = await volume({ store: { quotaBytes: SUPPORT + 2048 } });

  let refus = null;
  for (let essai = 0; essai < 8 && refus === null; essai += 1) {
    try {
      await backend.write(essai * SECTOR_SIZE, new Uint8Array(SECTOR_SIZE).fill(essai + 1));
    } catch (erreur) {
      refus = erreur;
    }
  }
  assert.ok(refus !== null, "le quota doit finir par être atteint");
  assert.ok(isStorageError(refus, STORAGE_ERROR_CODES.quotaExceeded), refus?.code);
  assert.equal(refus.context.operation, "write");
  // Le volume est refermé même après un refus : un handle laissé ouvert bloquerait le nom pour tout
  // le fichier de tests, et l'échec suivant nommerait `VAULT_STORAGE_BUSY` au lieu de sa vraie cause.
  await backend.close().catch(() => {});
});

test("un handle perdu contamine toutes les opérations suivantes", async () => {
  const { backend, store, name } = await volume();
  store.lose(name);

  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("un handle perdu reste un handle perdu, même découvert par la barrière", async () => {
  // La barrière est le seul chemin qui reconstruit son erreur : elle ne doit pas ranger une perte
  // de support dans « échec de barrière ». Les deux états se corrigent différemment — l'un exige
  // de rouvrir le volume, l'autre de réessayer — et les confondre effacerait cette différence.
  const { backend, store, name } = await volume();
  store.lose(name);

  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  // L'état est retenu : l'E/S suivante n'a pas besoin de redécouvrir la panne.
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("un quota atteint pendant la barrière reste un quota, pas un échec de barrière", async () => {
  const { backend, store, name } = await volume();
  // Depuis #16 la barrière scelle le JOURNAL DE GÉNÉRATION voisin : c'est lui que le manque de place
  // frappe désormais. Le remède est le même — libérer de la place —, et le code doit rester distinct
  // d'un échec de barrière.
  store.starve(`${name}.gen`);

  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.quotaExceeded),
  );
});

test("la faute programmée « handle perdu » produit le même état que la perte réelle", async () => {
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.lostHandle, operation: "write", occurrence: 1 },
  ]);
  const { backend } = await volume({ faults });

  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.handleLost),
  );
});

test("une barrière en échec n'est jamais acquittée et laisse une trace ordonnée", async () => {
  const journal = new BlockJournal();
  const faults = createFaultPlan([
    { kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 1 },
  ]);
  const { backend } = await volume({ journal, faults });

  await backend.write(0, new Uint8Array(SECTOR_SIZE));
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.flushFailed),
  );

  const operations = journal.entries().map((entree) => entree.operation);
  assert.deepEqual(operations, [
    JOURNAL_OPERATIONS.write,
    JOURNAL_OPERATIONS.flush,
    JOURNAL_OPERATIONS.fault,
  ]);
  await backend.close();
});

test("la barrière franchie journalise écriture, barrière puis acquittement, dans cet ordre", async () => {
  const journal = new BlockJournal();
  const { backend, store, name } = await volume({ journal });
  // La CRÉATION d'un volume v3 franchit déjà des barrières : l'en-tête, puis le scellement de tous
  // les secteurs (ADR 0016). Ce qui est mesuré ici est ce que la BARRIÈRE DU GUEST ajoute, donc le
  // compte de départ est relevé plutôt que supposé nul.
  const barrieresALaCreation = store.flushCount(name);

  await backend.write(0, new Uint8Array(SECTOR_SIZE).fill(3));
  await backend.flush();

  assert.deepEqual(
    journal.entries().map((entree) => entree.operation),
    [JOURNAL_OPERATIONS.write, JOURNAL_OPERATIONS.flush, JOURNAL_OPERATIONS.flushAck],
  );
  // DEUX barrières RÉELLES du support par validation (#16, ADR 0014) : la charge d'abord, la racine
  // ensuite. L'ordre est ce qui distingue « validé » de « probablement écrit », et le compte est
  // épinglé pour qu'un raccourci qui n'en franchirait qu'une soit visible. L'ouverture d'un journal
  // vierge, elle, n'écrit ni ne franchit rien.
  assert.equal(store.flushCount(`${name}.gen`), 2, "deux flush pour la validation");
  assert.equal(
    store.flushCount(name),
    barrieresALaCreation,
    "le volume lui-même n'est franchi qu'au point de contrôle",
  );
  await backend.close();
  assert.equal(
    store.flushCount(name),
    barrieresALaCreation + 1,
    "la fermeture propre range la génération dans le volume",
  );
});

test("l'ouverture est exclusive et la fermeture transfère la propriété du volume", async () => {
  const store = createSyncAccessStore();
  const premier = await openOpfsVolume({
    name: "exclusif",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });

  await assert.rejects(
    () =>
      openOpfsVolume({
        name: "exclusif",
        size: TAILLE,
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
      }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );

  await premier.close();
  const second = await openOpfsVolume({
    name: "exclusif",
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  assert.equal(second.size(), TAILLE);
  await second.close();
});

test("l'exclusivité refusée par le support lui-même reste une erreur typée", async () => {
  const store = createSyncAccessStore();
  const brut = await store.openHandle("prisonnier");
  brut.truncate(TAILLE);

  await assert.rejects(
    () =>
      openOpfsVolume({
        name: "prisonnier",
        size: TAILLE,
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
      }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );
  brut.close();
});

test("après fermeture, toute E/S échoue explicitement et le support est relâché", async () => {
  const { backend, store, name } = await volume();
  await backend.close();

  assert.equal(store.isOpen(name), false, "le handle exclusif est rendu au support");
  await assert.rejects(
    () => backend.read(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
  await assert.rejects(
    () => backend.write(0, new Uint8Array(SECTOR_SIZE)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
  await assert.rejects(
    () => backend.flush(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.closed),
  );
});

test("une plage invalide est refusée avant d'atteindre le support", async () => {
  const { backend, store, name } = await volume();
  const avant = store.readCount(name);

  await assert.rejects(() => backend.read(-1, 8), RangeError);
  await assert.rejects(() => backend.read(0, 1.5), RangeError);
  await assert.rejects(() => backend.write(0, "pas un tampon"), TypeError);

  assert.equal(store.readCount(name), avant, "aucun appel au support pour une plage invalide");
  await backend.close();
});

// ------------------------------------------------ ce que l'ouvreur répond quand la clé manque

/** Écrit un fichier NON VIDE qui n'est pas un volume v3 : un volume d'un format antérieur. */
async function poserUnFichierAncien(store, nom, octets) {
  const handle = await store.openHandle(nom);
  handle.truncate(octets);
  handle.write(new Uint8Array(octets).fill(0xa5), { at: 0 });
  handle.flush();
  handle.close();
}

test("un volume d'un format ANTÉRIEUR est diagnostiqué comme tel, même sans clé", async () => {
  // Le refus de clé tombait avant que l'en-tête ne soit lu, si bien qu'un fichier v2 s'entendait
  // répondre « le format v3 est chiffré et aucune clé n'a été remise » : un remède qui n'est pas le
  // sien. Ce qui manque à ce fichier n'est pas une clé, c'est une région d'authentification.
  const store = createSyncAccessStore();
  await poserUnFichierAncien(store, "ancien", TAILLE);

  await assert.rejects(
    () => openOpfsVolume({ name: "ancien", openHandle: store.openHandle }),
    (erreur) => {
      assert.equal(erreur.code, STORAGE_ERROR_CODES.geometryMismatch);
      assert.doesNotMatch(erreur.message, /clé/i, "la clé n'est pas ce qui manque à ce fichier");
      assert.match(
        erreur.message,
        /#101/,
        "le chemin vers v3 est nommé, et il n'existe pas encore",
      );
      return true;
    },
  );
  assert.equal(store.isOpen("ancien"), false, "le handle est rendu, même sur ce chemin-là");
});

test("un volume v3 SANS clé est refusé par le code de la clé, et n'écrit rien", async () => {
  const store = createSyncAccessStore();
  await assert.rejects(
    () => openOpfsVolume({ name: "neuf-sans-cle", size: TAILLE, openHandle: store.openHandle }),
    (erreur) => {
      assert.equal(erreur.code, STORAGE_ERROR_CODES.cleRequise);
      return true;
    },
  );
  assert.equal(
    store.sizeOf("neuf-sans-cle"),
    0,
    "un volume qu'on ne saura pas sceller ne laisse derrière lui ni fichier alloué ni en-tête",
  );
  assert.equal(store.isOpen("neuf-sans-cle"), false, "le handle est rendu");
});

// --- FERMETURE SOUS UNE E/S EN VOL (#132) --------------------------------------------------------
//
// Le job « Reprise MVP » a vu un boot à froid absorber un `VAULT_STORAGE_HANDLE_LOST` — « the access
// handle was already closed » — sur une écriture du guest de 4 096 o. Le compte rendu de ce boot
// porte `close: 1` et AUCUNE entrée `failure` au journal, alors que toute traduction d'un échec du
// support en inscrit une : la panne est donc survenue APRÈS le relevé du journal, c'est-à-dire après
// la fermeture. Ce n'est pas le support qui a lâché, c'est la session qui a retiré le handle sous une
// écriture qu'elle avait déjà acceptée.

/** Rend la main quelques tours, le temps qu'une E/S entre dans son scellement (asynchrone). */
async function rendreLaMain(tours = 8) {
  for (let index = 0; index < tours; index += 1) await Promise.resolve();
}

/** Récupère le refus d'une E/S sans laisser passer un rejet non traité pendant l'attente. */
function issue(promesse) {
  return promesse.then(
    () => null,
    (erreur) => erreur,
  );
}

test("la fermeture attend l'écriture qu'elle a déjà acceptée au lieu de la refuser", async () => {
  const { backend } = await volume();

  const enVol = issue(backend.write(4 * SECTOR_SIZE, motif(8 * SECTOR_SIZE, 11)));
  await backend.close();

  assert.equal(
    await enVol,
    null,
    "une écriture acceptée avant la fermeture doit aboutir : la refuser ferait passer pour une panne du support un handle que la session a elle-même retiré",
  );
});

test("hors transaction non plus, le handle n'est pas retiré sous une écriture en vol", async () => {
  // Sans magasin, l'écriture est scellée puis posée DIRECTEMENT dans le volume. Le scellement est
  // asynchrone : `rendreLaMain` laisse l'écriture y entrer, si bien que la fermeture retire le handle
  // pendant qu'elle attend — exactement la fenêtre observée en CI, et le même refus,
  // `VAULT_STORAGE_HANDLE_LOST` sur « write ».
  const { backend } = await volume({ transactionnel: false });

  const enVol = issue(backend.write(0, motif(SECTOR_SIZE, 3)));
  await rendreLaMain();
  await backend.close();

  assert.equal(await enVol, null, "l'écriture entrée dans son scellement doit aboutir");
});

test("la fermeture attend aussi une LECTURE en vol", async () => {
  const { backend } = await volume();
  await backend.write(0, motif(SECTOR_SIZE, 5));

  const enVol = issue(backend.read(0, SECTOR_SIZE));
  await backend.close();

  assert.equal(await enVol, null, "une lecture acceptée avant la fermeture doit aboutir");
});
