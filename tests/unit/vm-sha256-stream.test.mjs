import assert from "node:assert/strict";
import test from "node:test";

import { createSha256Stream } from "../../src/vm/sha256-stream.mjs";

// CALIBRATION du hachage SHA-256 incrémental de #11 (`VAULT-PORT-001`).
//
// Ce module existe parce que WebCrypto n'offre aucun hachage incrémental et que `node:crypto` est
// absent du Worker navigateur : l'export doit pourtant empreinter un volume SANS le tenir entier en
// mémoire. Un instrument de mesure se calibre : ces épreuves confrontent `update`/`digest` à
// `crypto.subtle.digest` (présent des deux côtés) pour TOUTE entrée, découpée en morceaux
// arbitraires. Un écart, à n'importe quelle frontière de bloc, serait un résultat — pas un détail.

const encoder = new TextEncoder();

/** Empreinte de référence à un seul coup, par le moteur (WebCrypto). */
async function referenceHex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Empreinte incrémentale, `bytes` découpé en morceaux de `chunk` octets. */
function streamHex(bytes, chunk) {
  const hash = createSha256Stream();
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    hash.update(bytes.subarray(offset, Math.min(offset + chunk, bytes.byteLength)));
  }
  return hash.digestHex();
}

/** Suite déterministe (générateur congruentiel), pour des entrées reproductibles sans binaire versionné. */
function pseudoBytes(length, seed) {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

test("vecteur connu : SHA-256(\"abc\")", () => {
  const hash = createSha256Stream();
  hash.update(encoder.encode("abc"));
  assert.equal(
    hash.digestHex(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("entrée vide : empreinte de la chaîne vide", () => {
  const hash = createSha256Stream();
  assert.equal(
    hash.digestHex(),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("concorde avec WebCrypto sur les tailles frontières du padding (55, 56, 63, 64, 65)", async () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 191, 200]) {
    const bytes = pseudoBytes(length, length + 1);
    const attendu = await referenceHex(bytes);
    assert.equal(streamHex(bytes, bytes.byteLength || 1), attendu, `un seul morceau, longueur ${length}`);
  }
});

test("concorde avec WebCrypto quel que soit le DÉCOUPAGE en morceaux", async () => {
  const bytes = pseudoBytes(4096 + 123, 7);
  const attendu = await referenceHex(bytes);
  for (const chunk of [1, 2, 3, 7, 31, 32, 63, 64, 65, 127, 128, 500, 1024, 4096]) {
    assert.equal(streamHex(bytes, chunk), attendu, `morceaux de ${chunk} octets`);
  }
});

test("concorde avec WebCrypto sur une entrée multi-mégaoctets découpée irrégulièrement", async () => {
  const bytes = pseudoBytes(5 * 1024 * 1024 + 777, 99);
  const attendu = await referenceHex(bytes);
  // Morceaux de tailles variées, jamais alignés sur 64 : c'est le cas réel d'un flux OPFS.
  const hash = createSha256Stream();
  let offset = 0;
  let taille = 1000;
  while (offset < bytes.byteLength) {
    const fin = Math.min(offset + taille, bytes.byteLength);
    hash.update(bytes.subarray(offset, fin));
    offset = fin;
    taille = ((taille * 7 + 13) % 100000) + 1;
  }
  assert.equal(hash.digestHex(), attendu);
});

test("digest est terminal : un second digest ou un update après digest est refusé", () => {
  const hash = createSha256Stream();
  hash.update(encoder.encode("x"));
  hash.digestHex();
  assert.throws(() => hash.digest(), /déjà finalisé/);
  assert.throws(() => hash.update(encoder.encode("y")), /déjà finalisé/);
});

test("update refuse une entrée qui n'est pas un Uint8Array", () => {
  const hash = createSha256Stream();
  assert.throws(() => hash.update("pas des octets"), TypeError);
});
