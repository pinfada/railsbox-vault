import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { BlockJournal } from "../../src/vm/block-journal.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import {
  CHROMIUM_FILE_ERRORS,
  decodeSupportCount,
  readCountFailure,
  writeCountFailure,
} from "../../src/vm/opfs-error-mapping.mjs";
import { createOpfsArchiveSink } from "../../src/vm/opfs-archive-sink.mjs";
import { ecrireHandleEntier, lireTeteDeHandle } from "../../src/vm/opfs-volume-open.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";

// Ce que `FileSystemSyncAccessHandle.write()` rend quand il N'A PAS écrit (#73).
//
// Le job « Reprise MVP » a observé, sur les exécutants GitHub et jamais en local, un `write()` qui
// rend **4294967288** au lieu des 4194304 octets demandés. 4294967288 = 2^32 − 8 : c'est l'entier
// signé −8 lu comme non signé sur 32 bits. Le code du dépôt en faisait une « écriture courte » —
// une phrase FAUSSE, puisque le support n'a pas rendu un nombre d'octets mais un code d'échec, et
// une phrase MUETTE sur le remède.
//
// Ces tests fixent la lecture correcte de cette valeur de retour. Ils ne prouvent PAS que Chromium
// se comporte ainsi : ils prouvent que si un support rend une valeur de cette forme, le dépôt la
// nomme au lieu de la deviner. La mesure du support réel vit dans le job CI et dans
// `docs/testing.md`.

const DEMANDE = 4 * 1024 * 1024;
const RENDU_NO_SPACE = 4_294_967_288; // 2^32 − 8
const RENDU_ACCESS_DENIED = 4_294_967_291; // 2^32 − 5

test("une valeur de retour supérieure à la demande se décode en entier signé 32 bits", () => {
  assert.deepEqual(decodeSupportCount(DEMANDE, DEMANDE), {
    kind: "exact",
    errno: null,
    name: null,
  });
  assert.deepEqual(decodeSupportCount(2048, DEMANDE), { kind: "court", errno: null, name: null });

  const noSpace = decodeSupportCount(RENDU_NO_SPACE, DEMANDE);
  assert.equal(noSpace.kind, "errno");
  assert.equal(noSpace.errno, -8, "4294967288 = 2^32 − 8");
  assert.equal(noSpace.name, "FILE_ERROR_NO_SPACE");

  const refus = decodeSupportCount(RENDU_ACCESS_DENIED, DEMANDE);
  assert.equal(refus.errno, -5);
  assert.equal(refus.name, "FILE_ERROR_ACCESS_DENIED");

  // Un errno hors table reste un errno : il est rendu tel quel, sans nom inventé.
  const inconnu = decodeSupportCount(2 ** 32 - 9999, DEMANDE);
  assert.equal(inconnu.kind, "errno");
  assert.equal(inconnu.errno, -9999);
  assert.equal(inconnu.name, null);

  // La table est celle de `base::File::Error` : les deux valeurs qui nous concernent y figurent.
  assert.equal(CHROMIUM_FILE_ERRORS.get(-8), "FILE_ERROR_NO_SPACE");
  assert.equal(CHROMIUM_FILE_ERRORS.get(-5), "FILE_ERROR_ACCESS_DENIED");
});

test("une écriture complète ne produit aucune erreur", () => {
  assert.equal(writeCountFailure(DEMANDE, { requested: DEMANDE, volume: "v", offset: 0 }), null);
});

test("une écriture réellement courte reste une écriture partielle", () => {
  const erreur = writeCountFailure(2048, { requested: DEMANDE, volume: "v", offset: 512 });
  assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.partialWrite));
  assert.equal(erreur.context.accepted, 2048);
  assert.equal(erreur.context.requested, DEMANDE);
});

test("4294967288 est un manque de place NOMMÉ, pas une écriture courte", () => {
  const erreur = writeCountFailure(RENDU_NO_SPACE, {
    requested: DEMANDE,
    volume: "vault-archive-e2e",
    offset: 268_435_456,
    storage: { state: "known", quota: 1_000_000_000, usage: 999_000_000, available: 1_000_000 },
  });

  assert.ok(erreur !== null, "une valeur de retour supérieure à la demande est toujours un échec");
  assert.ok(
    isStorageError(erreur, STORAGE_ERROR_CODES.quotaExceeded),
    `attendu VAULT_STORAGE_QUOTA_EXCEEDED, obtenu ${erreur.code}`,
  );

  // Le message nomme la cause au lieu de la maquiller en « courte » ou en « partielle ».
  assert.match(erreur.message, /FILE_ERROR_NO_SPACE/);
  assert.match(erreur.message, /-8/);
  assert.doesNotMatch(erreur.message, /courte|partielle/i);

  // Le contexte porte de quoi trancher sans relire les journaux : demandé, rendu, errno, quota.
  assert.equal(erreur.context.requested, DEMANDE);
  assert.equal(erreur.context.returned, RENDU_NO_SPACE);
  assert.equal(erreur.context.errno, -8);
  assert.equal(erreur.context.errnoName, "FILE_ERROR_NO_SPACE");
  assert.equal(erreur.context.offset, 268_435_456);
  assert.equal(erreur.context.volume, "vault-archive-e2e");
  assert.equal(erreur.context.storage.quota, 1_000_000_000);
  assert.equal(erreur.context.storage.usage, 999_000_000);

  // Le contexte traverse `postMessage` : une erreur ne doit pas se perdre au passage du port.
  const transporte = JSON.parse(JSON.stringify(erreur.toJSON()));
  assert.equal(transporte.code, STORAGE_ERROR_CODES.quotaExceeded);
  assert.equal(transporte.context.errno, -8);
});

test("un errno qui n'est pas un manque de place n'est jamais rangé dans le quota", () => {
  const erreur = writeCountFailure(RENDU_ACCESS_DENIED, {
    requested: DEMANDE,
    volume: "v",
    offset: 0,
  });
  assert.ok(
    isStorageError(erreur, STORAGE_ERROR_CODES.supportFailure),
    `attendu VAULT_STORAGE_SUPPORT_FAILURE, obtenu ${erreur.code}`,
  );
  assert.equal(erreur.context.errno, -5);
  assert.match(erreur.message, /FILE_ERROR_ACCESS_DENIED/);
});

test("sans mesure de stockage, le contexte dit « inconnu » plutôt que de taire la question", () => {
  const erreur = writeCountFailure(RENDU_NO_SPACE, { requested: DEMANDE, volume: "v", offset: 0 });
  assert.equal(erreur.context.storage, null);
});

test("une lecture qui rend un errno n'est jamais prise pour une lecture courte", () => {
  const courte = readCountFailure(2048, { requested: DEMANDE, volume: "v", offset: 0 });
  assert.ok(isStorageError(courte, STORAGE_ERROR_CODES.shortRead));

  const errno = readCountFailure(RENDU_NO_SPACE, { requested: DEMANDE, volume: "v", offset: 0 });
  assert.ok(
    isStorageError(errno, STORAGE_ERROR_CODES.supportFailure),
    `attendu VAULT_STORAGE_SUPPORT_FAILURE, obtenu ${errno.code}`,
  );
  assert.equal(errno.context.errno, -8);
  assert.equal(readCountFailure(DEMANDE, { requested: DEMANDE, volume: "v", offset: 0 }), null);
});

// --- Le backend de blocs (#6) sur un support qui rend un errno ---------------------------------

/** Handle minimal dont `write` rend une valeur imposée : le vrai OPFS ne le fait pas à la demande. */
function handleQuiRend(valeurDeRetour, taille) {
  const octets = new Uint8Array(taille);
  return {
    getSize: () => taille,
    read(cible, { at }) {
      cible.set(octets.subarray(at, at + cible.byteLength));
      return cible.byteLength;
    },
    write: () => valeurDeRetour,
    flush() {},
    truncate() {},
    close() {},
  };
}

test("le backend OPFS refuse une écriture dont le support rend un errno, sans la dire partielle", async () => {
  const taille = 64 * SECTOR_SIZE;
  const backend = await openOpfsVolume({
    name: "errno-backend",
    size: taille,
    journal: new BlockJournal(),
    openHandle: async () => handleQuiRend(RENDU_NO_SPACE, taille),
  });

  const erreur = await backend.write(0, new Uint8Array(SECTOR_SIZE)).then(
    () => null,
    (cause) => cause,
  );
  await backend.close();

  assert.ok(erreur !== null, "une écriture non écrite ne doit jamais passer pour un succès");
  assert.ok(
    isStorageError(erreur, STORAGE_ERROR_CODES.quotaExceeded),
    `attendu VAULT_STORAGE_QUOTA_EXCEEDED, obtenu ${erreur.code} : ${erreur.message}`,
  );
  assert.equal(erreur.context.errno, -8);
  assert.equal(erreur.context.returned, RENDU_NO_SPACE);
});

// --- Le puits d'archive (#11) sur le même support ----------------------------------------------

test("le puits d'archive nomme le manque de place au lieu d'une « écriture d'archive courte »", async () => {
  const sink = createOpfsArchiveSink(handleQuiRend(RENDU_NO_SPACE, 0), {
    volume: "vault-archive-e2e",
    measureStorage: async () => ({
      state: "known",
      quota: 2_000_000_000,
      usage: 1_999_000_000,
      available: 1_000_000,
    }),
  });

  const erreur = await sink.write(new Uint8Array(DEMANDE)).then(
    () => null,
    (cause) => cause,
  );

  assert.ok(erreur !== null);
  assert.ok(
    isStorageError(erreur, STORAGE_ERROR_CODES.quotaExceeded),
    `attendu VAULT_STORAGE_QUOTA_EXCEEDED, obtenu ${erreur.code} : ${erreur.message}`,
  );
  assert.doesNotMatch(erreur.message, /courte/i);
  assert.equal(erreur.context.errno, -8);
  assert.equal(erreur.context.storage.quota, 2_000_000_000);
  assert.equal(sink.offset, 0, "aucun octet n'est compté comme écrit après un refus");
});

test("le puits d'archive ne mesure le budget QUE sur un échec", async () => {
  let mesures = 0;
  const accepte = {
    write: (bytes) => bytes.byteLength,
    flush() {},
    close() {},
  };
  const measureStorage = async () => {
    mesures += 1;
    return { state: "known", quota: 1, usage: 0, available: 1 };
  };

  const bon = createOpfsArchiveSink(accepte, { volume: "a", measureStorage });
  await bon.write(new Uint8Array(1024));
  await bon.write(new Uint8Array(1024));
  assert.equal(
    mesures,
    0,
    "cent vingt-huit blocs ne doivent pas coûter cent vingt-huit estimations",
  );

  const mauvais = createOpfsArchiveSink(handleQuiRend(RENDU_NO_SPACE, 0), {
    volume: "a",
    measureStorage,
  });
  await mauvais.write(new Uint8Array(1024)).catch(() => {});
  assert.equal(mesures, 1, "un échec, lui, est daté par rapport au quota");
});

test("le puits d'archive avance de ce qui a été écrit, et seulement de cela", async () => {
  const ecrit = [];
  const handle = {
    write(bytes, { at }) {
      ecrit.push({ at, length: bytes.byteLength });
      return bytes.byteLength;
    },
    flush() {},
    close() {},
  };
  const sink = createOpfsArchiveSink(handle, { volume: "a" });

  await sink.write(new Uint8Array(12));
  await sink.write(new Uint8Array(300));

  assert.equal(sink.offset, 312);
  assert.deepEqual(ecrit, [
    { at: 0, length: 12 },
    { at: 12, length: 300 },
  ]);
});

// --- Le voisin de volume (#10, #13) sur le même support -----------------------------------------

test("un manifeste voisin que le support refuse d'écrire n'est jamais tenu pour inscrit", () => {
  const erreur = (() => {
    try {
      ecrireHandleEntier(handleQuiRend(RENDU_NO_SPACE, 0), "v.manifest", new Uint8Array(400));
      return null;
    } catch (cause) {
      return cause;
    }
  })();

  assert.ok(erreur !== null, "un voisin non écrit ne doit jamais passer pour écrit");
  assert.ok(
    isStorageError(erreur, STORAGE_ERROR_CODES.quotaExceeded),
    `attendu VAULT_STORAGE_QUOTA_EXCEEDED, obtenu ${erreur.code} : ${erreur.message}`,
  );
  assert.doesNotMatch(erreur.message, /courte/i);
  assert.equal(erreur.context.errno, -8);
});

test("un voisin plus court que sa taille annoncée est rendu tel quel ; un errno est refusé", () => {
  const contenu = Uint8Array.from({ length: 400 }, (_, i) => i % 251);

  // Lecture courte LÉGITIME : c'est ce que laisse une écriture interrompue, et l'appelant doit
  // pouvoir le constater. Elle est rendue tronquée, pas complétée.
  const partiel = {
    read(cible) {
      cible.set(contenu.subarray(0, 120));
      return 120;
    },
  };
  const lu = lireTeteDeHandle(partiel, "v.manifest", 400);
  assert.equal(lu.byteLength, 120);
  assert.deepEqual(lu, contenu.subarray(0, 120));

  // Code d'échec : sans refus, `subarray(0, 4294967288)` bornerait à 400 et rendrait 400 zéros
  // comme s'ils avaient été lus — un manifeste fabriqué de toutes pièces.
  const errno = { read: () => RENDU_NO_SPACE };
  const erreur = (() => {
    try {
      lireTeteDeHandle(errno, "v.manifest", 400);
      return null;
    } catch (cause) {
      return cause;
    }
  })();
  assert.ok(erreur !== null, "un tampon de zéros ne doit jamais passer pour un voisin lu");
  assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.supportFailure));
  assert.equal(erreur.context.errno, -8);
});
