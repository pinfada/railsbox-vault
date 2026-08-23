import assert from "node:assert/strict";
import test from "node:test";

import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// Le double d'OPFS est l'instrument de mesure des tests unitaires de #6 : s'il ment, la preuve
// unitaire ne vaut rien. Ce fichier le traite donc comme du code de production et vérifie qu'il
// reproduit les sémantiques de `FileSystemSyncAccessHandle` sur lesquelles le backend s'appuie :
// valeur de retour de `read`/`write`, croissance par `truncate`, exclusivité, quota, fermeture.
//
// Les sémantiques de référence sont celles mesurées en navigateur par
// `tests/browser/opfs-block-backend.spec.mjs`, qui rejoue les mêmes observations sur le vrai OPFS.

function ouvrir(options = {}) {
  const store = createSyncAccessStore(options);
  return store;
}

test("read rend le nombre d'octets réellement lus et jamais de zéros inventés", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");
  handle.truncate(10);
  handle.write(Uint8Array.from([1, 2, 3, 4, 5]), { at: 0 });

  const cible = new Uint8Array(8);
  assert.equal(handle.read(cible, { at: 4 }), 6, "quatre octets avant la fin, six restants");
  assert.equal(
    handle.read(new Uint8Array(4), { at: 10 }),
    0,
    "lecture entièrement au-delà de la fin",
  );
  assert.deepEqual([...cible.subarray(0, 2)], [5, 0]);
});

test("write rend le nombre d'octets acceptés et fait croître le fichier", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");

  assert.equal(handle.write(new Uint8Array(4).fill(9), { at: 6 }), 4);
  assert.equal(handle.getSize(), 10, "l'écriture au-delà de la fin étend le fichier");

  const relu = new Uint8Array(10);
  handle.read(relu, { at: 0 });
  assert.deepEqual([...relu], [0, 0, 0, 0, 0, 0, 9, 9, 9, 9]);
});

test("truncate étend avec des zéros et tronque sans les rendre", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");
  handle.write(Uint8Array.from([7, 7, 7, 7]), { at: 0 });

  handle.truncate(2);
  assert.equal(handle.getSize(), 2);
  handle.truncate(4);

  const relu = new Uint8Array(4);
  handle.read(relu, { at: 0 });
  assert.deepEqual([...relu], [7, 7, 0, 0], "les octets tronqués ne reviennent pas");
});

test("un second handle sur le même nom est refusé tant que le premier vit", async () => {
  const store = ouvrir();
  const premier = await store.openHandle("volume");

  await assert.rejects(
    () => store.openHandle("volume"),
    (erreur) => erreur instanceof DOMException && erreur.name === "NoModificationAllowedError",
  );

  premier.close();
  const second = await store.openHandle("volume");
  assert.equal(second.getSize(), 0);
});

test("après close, toute opération lève InvalidStateError", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");
  handle.close();

  assert.throws(
    () => handle.getSize(),
    (erreur) => erreur instanceof DOMException && erreur.name === "InvalidStateError",
  );
  assert.throws(() => handle.write(new Uint8Array(1), { at: 0 }), DOMException);
  assert.throws(() => handle.flush(), DOMException);
});

test("le quota du store est global et lève QuotaExceededError", async () => {
  const store = ouvrir({ quotaBytes: 16 });
  const handle = await store.openHandle("volume");

  handle.truncate(16);
  assert.throws(
    () => handle.write(new Uint8Array(4), { at: 16 }),
    (erreur) => erreur instanceof DOMException && erreur.name === "QuotaExceededError",
  );
  assert.equal(handle.getSize(), 16, "un quota refusé ne modifie pas la géométrie");
});

test("un handle perdu se comporte comme un support disparu, sans fermeture propre", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");
  handle.truncate(8);
  store.lose("volume");

  assert.throws(
    () => handle.read(new Uint8Array(8), { at: 0 }),
    (erreur) => erreur instanceof DOMException && erreur.name === "InvalidStateError",
  );
});

test("le contenu survit à la fermeture du handle, comme un fichier OPFS", async () => {
  const store = ouvrir();
  const premier = await store.openHandle("volume");
  premier.truncate(4);
  premier.write(Uint8Array.from([1, 2, 3, 4]), { at: 0 });
  premier.close();

  const second = await store.openHandle("volume");
  const relu = new Uint8Array(4);
  assert.equal(second.read(relu, { at: 0 }), 4);
  assert.deepEqual([...relu], [1, 2, 3, 4]);
});

test("une écriture plafonnée rend moins d'octets qu'on ne lui en donne", async () => {
  const store = ouvrir({ maxWriteBytes: 3 });
  const handle = await store.openHandle("volume");

  assert.equal(handle.write(new Uint8Array(10).fill(5), { at: 0 }), 3);
  assert.equal(handle.getSize(), 3);
});

// L'instrument de latence de #14 (`blockFlush`/`releaseFlush`) est calibré ici : un instrument non
// calibré invaliderait la preuve de barrière durable qui s'appuie sur lui. La règle est double : par
// défaut, `flush()` reste SYNCHRONE et rend `undefined` — comme le vrai handle ; armé, il rend une
// barrière EN VOL qui ne se matérialise qu'à sa libération.

test("par défaut, flush est synchrone et rend undefined comme le vrai handle", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");

  assert.equal(handle.flush(), undefined, "un flush non retardé ne rend rien");
  assert.equal(store.flushCount("volume"), 1);
  assert.equal(store.isFlushPending("volume"), false);
});

test("une barrière retardée reste en vol et ne se matérialise qu'à sa libération", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");

  store.blockFlush("volume");
  const enVol = handle.flush();

  assert.ok(enVol instanceof Promise, "une barrière armée rend une promesse");
  assert.equal(store.isFlushPending("volume"), true);
  assert.equal(
    store.flushCount("volume"),
    0,
    "rien n'est matérialisé tant que la barrière est en vol",
  );

  store.releaseFlush("volume");
  await enVol;
  assert.equal(store.flushCount("volume"), 1, "la barrière n'est comptée qu'une fois libérée");
  assert.equal(store.isFlushPending("volume"), false);
});

test("une barrière retardée peut échouer à la libération, comme un support qui disparaît", async () => {
  const store = ouvrir();
  const handle = await store.openHandle("volume");

  store.blockFlush("volume");
  const enVol = handle.flush();
  store.releaseFlush("volume", { fail: "InvalidStateError" });

  await assert.rejects(
    () => enVol,
    (erreur) => erreur instanceof DOMException && erreur.name === "InvalidStateError",
  );
  assert.equal(store.flushCount("volume"), 0, "une barrière échouée n'est jamais matérialisée");
});

test("libérer une barrière absente est une erreur, pas un succès silencieux", async () => {
  const store = ouvrir();
  await store.openHandle("volume");

  assert.throws(() => store.releaseFlush("volume"), /Aucune barrière en attente/);
});
