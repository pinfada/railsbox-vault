/**
 * Mesures WebCrypto partagées entre la page et le Worker.
 * Chaque mesure rejoue un vecteur connu : un octet différent invalide la capacité.
 */

import { MissingCapabilityError } from "./probe-runner.mjs";
import { AES_GCM_VECTOR, HKDF_VECTOR, bytesToHex, hexToBytes } from "./probe-vectors.mjs";

function requireSubtleCrypto(where) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new MissingCapabilityError(`crypto.subtle n'est pas exposé (${where})`);
  }
  return subtle;
}

export async function probeAesGcm(where) {
  const subtle = requireSubtleCrypto(where);
  const key = await subtle.importKey("raw", hexToBytes(AES_GCM_VECTOR.keyHex), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const parameters = {
    name: "AES-GCM",
    iv: hexToBytes(AES_GCM_VECTOR.ivHex),
    additionalData: new TextEncoder().encode(AES_GCM_VECTOR.additionalData),
    tagLength: AES_GCM_VECTOR.tagLengthBits,
  };

  const sealed = await subtle.encrypt(parameters, key, hexToBytes(AES_GCM_VECTOR.plaintextHex));
  const sealedHex = bytesToHex(new Uint8Array(sealed));
  if (sealedHex !== AES_GCM_VECTOR.ciphertextHex) {
    throw new Error("le chiffré produit ne correspond pas au vecteur connu");
  }

  const opened = await subtle.decrypt(parameters, key, hexToBytes(AES_GCM_VECTOR.ciphertextHex));
  if (bytesToHex(new Uint8Array(opened)) !== AES_GCM_VECTOR.plaintextHex) {
    throw new Error("le déchiffré ne correspond pas au clair attendu");
  }

  return `AES-256-GCM conforme au vecteur connu (${sealedHex.length / 2} octets scellés)`;
}

export async function probeHkdf(where) {
  const subtle = requireSubtleCrypto(where);
  const base = await subtle.importKey("raw", hexToBytes(HKDF_VECTOR.ikmHex), "HKDF", false, [
    "deriveBits",
  ]);
  const derived = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: HKDF_VECTOR.hash,
      salt: hexToBytes(HKDF_VECTOR.saltHex),
      info: hexToBytes(HKDF_VECTOR.infoHex),
    },
    base,
    HKDF_VECTOR.lengthBits,
  );

  if (bytesToHex(new Uint8Array(derived)) !== HKDF_VECTOR.okmHex) {
    throw new Error("la clé dérivée ne correspond pas au vecteur RFC 5869");
  }

  return `HKDF-${HKDF_VECTOR.hash} conforme au cas de test 1 de la RFC 5869`;
}
