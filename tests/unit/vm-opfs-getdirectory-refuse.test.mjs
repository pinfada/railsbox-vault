import assert from "node:assert/strict";
import test from "node:test";

import { openOpfsSyncAccess, opfsAtteignable } from "../../src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "../../src/vm/storage-errors.mjs";

// WebKit 26.6 et suivants (mesuré sous Playwright 1.65.0, WebKit 27.2, le 18/11/2026) EXPOSE
// `navigator.storage.getDirectory` mais le REJETTE (`UnknownError`) dans un contexte éphémère. Sous
// 26.5 la fonction était absente. Le `typeof` ne suffit donc plus à dire « ce moteur offre l'OPFS » :
// c'est l'appel qui le dit. Ces épreuves tiennent la conduite — un rejet de `getDirectory()` est une
// ABSENCE de capacité (`VAULT_STORAGE_UNSUPPORTED`, état `indisponible`), jamais une panne de support
// non classée qui mettrait la coquille en erreur.

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

test("opfsAtteignable : vrai quand getDirectory aboutit", async () => {
  const retirer = installer({ getDirectory: async () => ({}) });
  try {
    assert.equal(await opfsAtteignable(), true);
  } finally {
    retirer();
  }
});

test("opfsAtteignable : faux quand getDirectory REJETTE, quel que soit le nom de l'erreur", async () => {
  for (const nom of ["UnknownError", "SecurityError", "NotAllowedError", "Error"]) {
    const retirer = installer({
      getDirectory: async () => {
        throw rejet(nom);
      },
    });
    try {
      assert.equal(await opfsAtteignable(), false, nom);
    } finally {
      retirer();
    }
  }
});

test("opfsAtteignable : faux quand getDirectory est absent, et quand navigator.storage l'est", async () => {
  for (const storage of [{}, undefined]) {
    const retirer = installer(storage);
    try {
      assert.equal(await opfsAtteignable(), false);
    } finally {
      retirer();
    }
  }
});

test("un getDirectory qui REJETTE rend VAULT_STORAGE_UNSUPPORTED, pas un échec de support non classé", async () => {
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
        assert.equal(erreur.code, STORAGE_ERROR_CODES.unsupported);
        assert.equal(erreur.context.capability, "navigator.storage.getDirectory");
        // Le nom du rejet est CONSERVÉ : le dire est ce qui distingue ce refus d'une absence d'API.
        assert.match(erreur.message, /UnknownError/);
        return true;
      },
    );
  } finally {
    retirer();
  }
});

test("la traduction ne couvre QUE getDirectory : un autre refus du support reste non classé", async () => {
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
