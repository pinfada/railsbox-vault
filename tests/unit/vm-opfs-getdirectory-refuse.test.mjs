import assert from "node:assert/strict";
import test from "node:test";

import { openOpfsSyncAccess } from "../../src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "../../src/vm/storage-errors.mjs";

// WebKit 27.2 (mesuré sous Playwright 1.64.0 et 1.65.0, le 18/11/2026 ; WebKit 26.6 sous 1.63.0) EXPOSE
// `navigator.storage.getDirectory` mais le REJETTE, dans un contexte éphémère, par un `UnknownError`
// dont le message est « The operation failed for an unknown transient reason (e.g. out of memory). ».
// Sous 26.5 la fonction était absente. Le `typeof` ne suffit donc plus à dire « ce moteur offre
// l'OPFS » : c'est l'appel qui le dit.
//
// Ce que ces épreuves tiennent : le rejet MESURÉ (`UnknownError` de `getDirectory()`) est rangé
// `VAULT_STORAGE_INDETERMINE` — « inaccessible pour l'instant, cause non établie », réessayable —, et
// NON `unsupported`, qui affirmerait une absence que le message du moteur (« transient reason ») ne
// permet pas d'affirmer. Seuls les deux noms que la table de `opfs-error-mapping.mjs` range déjà
// `unsupported` (`SecurityError`, `TypeMismatchError`) restent des absences. Tout autre rejet garde son
// classement précis (quota, handle perdu, échec de support non classé) : un échec est SIGNALÉ.

/** Installe `navigator.storage` et un Worker dédié factices, et rend la fonction qui les retire. */
function installer(storage) {
  const navigateur = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const portee = Object.getOwnPropertyDescriptor(globalThis, "WorkerGlobalScope");
  Object.defineProperty(globalThis, "navigator", {
    value: { storage },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "WorkerGlobalScope", {
    value: class {
      static [Symbol.hasInstance]() {
        return true;
      }
    },
    configurable: true,
    writable: true,
  });
  return () => {
    for (const [nom, descripteur] of [
      ["navigator", navigateur],
      ["WorkerGlobalScope", portee],
    ]) {
      if (descripteur) Object.defineProperty(globalThis, nom, descripteur);
      else delete globalThis[nom];
    }
  };
}

function rejet(nom, message = "The operation failed for an unknown transient reason.") {
  const erreur = new Error(message);
  erreur.name = nom;
  return erreur;
}

test("un getDirectory() qui rejette UnknownError rend INDETERMINE — inaccessible pour l'instant, cause non établie, jamais UNSUPPORTED", async () => {
  const retirer = installer({
    getDirectory: async () => {
      throw rejet("UnknownError");
    },
  });
  try {
    await assert.rejects(
      () => openOpfsSyncAccess("volume"),
      (erreur) => {
        assert.ok(erreur instanceof StorageError);
        assert.equal(erreur.code, STORAGE_ERROR_CODES.indeterminate);
        assert.notEqual(erreur.code, STORAGE_ERROR_CODES.unsupported);
        assert.equal(erreur.context.capability, "navigator.storage.getDirectory");
        assert.equal(erreur.context.cause, "UnknownError");
        // Le nom du rejet est CONSERVÉ, l'incertitude est DITE, et aucune absence n'est affirmée.
        assert.match(erreur.message, /UnknownError/);
        assert.match(erreur.message, /inaccessible pour l'instant/);
        assert.match(erreur.message, /cause non établie/);
        assert.doesNotMatch(
          erreur.message,
          /n'offre pas|absent de ce moteur|changer de navigateur/,
        );
        return true;
      },
    );
  } finally {
    retirer();
  }
});

test("tout AUTRE rejet de getDirectory() garde son classement précis, jamais `unsupported`", async () => {
  const attendus = new Map([
    ["QuotaExceededError", STORAGE_ERROR_CODES.quotaExceeded],
    ["InvalidStateError", STORAGE_ERROR_CODES.handleLost],
    ["NotFoundError", STORAGE_ERROR_CODES.handleLost],
    ["NotReadableError", STORAGE_ERROR_CODES.handleLost],
    ["NoModificationAllowedError", STORAGE_ERROR_CODES.busy],
    ["NotAllowedError", STORAGE_ERROR_CODES.supportFailure],
    ["Error", STORAGE_ERROR_CODES.supportFailure],
    // Déjà rangés `unsupported` par la table, et ils le restent : ce sont des refus de capacité.
    ["SecurityError", STORAGE_ERROR_CODES.unsupported],
    ["TypeMismatchError", STORAGE_ERROR_CODES.unsupported],
  ]);
  for (const [nom, code] of attendus) {
    const retirer = installer({
      getDirectory: async () => {
        throw rejet(nom);
      },
    });
    try {
      await assert.rejects(
        () => openOpfsSyncAccess("volume"),
        (erreur) => {
          assert.ok(erreur instanceof StorageError, nom);
          assert.equal(erreur.code, code, nom);
          return true;
        },
      );
    } finally {
      retirer();
    }
  }
});

test("la traduction ne couvre QUE getDirectory : un UnknownError sur un handle déjà obtenu reste non classé", async () => {
  const retirer = installer({
    getDirectory: async () => ({
      getDirectoryHandle: async () => {
        throw rejet("UnknownError");
      },
    }),
  });
  try {
    await assert.rejects(
      () => openOpfsSyncAccess("volume"),
      (erreur) => {
        assert.equal(erreur.code, STORAGE_ERROR_CODES.supportFailure);
        return true;
      },
    );
  } finally {
    retirer();
  }
});
