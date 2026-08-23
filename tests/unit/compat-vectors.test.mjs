import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  AES_GCM_VECTOR,
  HKDF_VECTOR,
  MINIMAL_WASM_EXPECTATION,
  MINIMAL_WASM_MODULE,
  bytesToHex,
  hexToBytes,
} from "../../src/compat/probe-vectors.mjs";

test("hexToBytes et bytesToHex sont réciproques", () => {
  const hex = "00ff10a5";
  assert.equal(bytesToHex(hexToBytes(hex)), hex);
});

test("hexToBytes refuse une chaîne hexadécimale invalide", () => {
  assert.throws(() => hexToBytes("abc"), /longueur/i);
  assert.throws(() => hexToBytes("zz"), /hexad/i);
});

test("le vecteur AES-GCM est un vrai vecteur vérifiable hors navigateur", async () => {
  const key = await webcrypto.subtle.importKey(
    "raw",
    hexToBytes(AES_GCM_VECTOR.keyHex),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const parameters = {
    name: "AES-GCM",
    iv: hexToBytes(AES_GCM_VECTOR.ivHex),
    additionalData: new TextEncoder().encode(AES_GCM_VECTOR.additionalData),
    tagLength: AES_GCM_VECTOR.tagLengthBits,
  };

  const ciphertext = await webcrypto.subtle.encrypt(
    parameters,
    key,
    hexToBytes(AES_GCM_VECTOR.plaintextHex),
  );
  assert.equal(bytesToHex(new Uint8Array(ciphertext)), AES_GCM_VECTOR.ciphertextHex);

  const plaintext = await webcrypto.subtle.decrypt(
    parameters,
    key,
    hexToBytes(AES_GCM_VECTOR.ciphertextHex),
  );
  assert.equal(bytesToHex(new Uint8Array(plaintext)), AES_GCM_VECTOR.plaintextHex);
});

test("le vecteur HKDF reproduit le cas de test 1 de la RFC 5869", async () => {
  const base = await webcrypto.subtle.importKey(
    "raw",
    hexToBytes(HKDF_VECTOR.ikmHex),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await webcrypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: HKDF_VECTOR.hash,
      salt: hexToBytes(HKDF_VECTOR.saltHex),
      info: hexToBytes(HKDF_VECTOR.infoHex),
    },
    base,
    HKDF_VECTOR.lengthBits,
  );

  assert.equal(bytesToHex(new Uint8Array(derived)), HKDF_VECTOR.okmHex);
});

test("le module WebAssembly minimal s'instancie et calcule la somme attendue", async () => {
  const { instance } = await WebAssembly.instantiate(MINIMAL_WASM_MODULE, {});
  const { operandA, operandB, sum, exportName } = MINIMAL_WASM_EXPECTATION;

  assert.equal(instance.exports[exportName](operandA, operandB), sum);
});
