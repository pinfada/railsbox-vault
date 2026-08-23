/**
 * Vecteurs de référence de la sonde de capacités.
 *
 * Ils sont volontairement fixes et publics : aucune donnée personnelle, aucun secret. Les suites
 * unitaires les rejouent sous Node afin de garantir qu'ils décrivent bien un résultat vérifiable
 * et non une valeur inventée. Une capacité n'est déclarée « supported » que si le navigateur
 * reproduit exactement ces octets.
 */

const HEXADECIMAL = /^[0-9a-f]*$/;

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new TypeError("longueur hexadécimale invalide : un nombre pair de caractères est requis");
  }
  if (!HEXADECIMAL.test(hex)) {
    throw new TypeError("chaîne hexadécimale invalide : caractères hors de [0-9a-f]");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** AES-256-GCM, clé et nonce déterministes, données additionnelles authentifiées. */
export const AES_GCM_VECTOR = Object.freeze({
  keyHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ivHex: "000102030405060708090a0b",
  additionalData: "railsbox-vault-compat",
  tagLengthBits: 128,
  plaintextHex: "5261696c73426f78205661756c74206361706162696c6974792070726f6265",
  ciphertextHex:
    "1563bf77b6a7ad63ad17f6fedd9d580ee2a6e65699173608414795f7720b65a16547afa68b9284ccc96166f15c8575",
});

/** HKDF-SHA-256, cas de test 1 de la RFC 5869. */
export const HKDF_VECTOR = Object.freeze({
  hash: "SHA-256",
  ikmHex: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
  saltHex: "000102030405060708090a0b0c",
  infoHex: "f0f1f2f3f4f5f6f7f8f9",
  lengthBits: 336,
  okmHex: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
});

/**
 * Module WebAssembly minimal valide exportant `add(i32, i32) -> i32`.
 * Les octets sont écrits à la main afin de ne dépendre d'aucun outil de compilation.
 */
const MINIMAL_WASM_MODULE_HEX = [
  "0061736d01000000", // en-tête « \0asm », version 1
  "0107016002" + "7f7f017f", // section type : (func (param i32 i32) (result i32))
  "03020100", // section function : une fonction du type 0
  "070701036164640000", // section export : « add » → fonction 0
  "0a09010700200020016a0b", // section code : local.get 0, local.get 1, i32.add, end
].join("");

/** Une vue typée ne peut pas être gelée : ne jamais écrire dans ce tampon partagé. */
export const MINIMAL_WASM_MODULE = hexToBytes(MINIMAL_WASM_MODULE_HEX);

export const MINIMAL_WASM_EXPECTATION = Object.freeze({
  exportName: "add",
  operandA: 2,
  operandB: 3,
  sum: 5,
});
