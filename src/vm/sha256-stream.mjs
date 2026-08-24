// SHA-256 INCRÉMENTAL, pur et sans dépendance (#11, `VAULT-PORT-001`).
//
// L'export d'un volume doit empreinter son contenu SANS jamais le tenir entier en mémoire
// (`docs/quality-attributes.md` : surmémoire de streaming ≤ 64 Mio). Or `crypto.subtle.digest` est
// une opération À UN SEUL COUP : elle exige tous les octets d'un bloc, donc tout le volume en RAM.
// WebCrypto n'expose aucun hachage incrémental, et `node:crypto` n'existe pas dans le Worker
// navigateur qui porte OPFS et v86 (ADR 0002). Un hachage incrémental portable est donc nécessaire.
//
// Ce module l'implémente en JavaScript pur : le MÊME code s'exécute sous Node 22 et dans un Worker.
// Il n'est PAS une reimplémentation gratuite d'une primitive du moteur : c'est la seule façon de
// hacher un flux borné en mémoire des deux côtés. Il est CALIBRÉ contre `crypto.subtle.digest`
// (présent partout) par `tests/unit/vm-sha256-stream.test.mjs` : pour toute entrée, découpée en
// morceaux arbitraires, `update`/`digest` doit rendre exactement l'empreinte à un seul coup. Un
// instrument non calibré invaliderait tout ce qu'il mesure.

/** Constantes de ronde de SHA-256 (racines cubiques des 64 premiers premiers). Figées à jamais. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_BYTES = 64;
const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * État d'un hachage SHA-256 en cours. IMMUABLE de l'extérieur (aucun champ public) ; à l'intérieur,
 * il accumule un bloc partiel de 64 octets et met à jour les huit mots d'état à chaque bloc complet.
 * `update` peut être appelé autant de fois qu'on veut, avec des morceaux de taille quelconque ;
 * `digest` finalise (padding + longueur en bits) et rend l'empreinte. Après `digest`, l'état ne doit
 * plus être alimenté : `digest` est terminal.
 */
class Sha256Stream {
  #h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  #block = new Uint8Array(BLOCK_BYTES);
  #blockLength = 0;
  #totalBytes = 0;
  #w = new Uint32Array(64);
  #finalized = false;

  /**
   * Absorbe des octets. Le coût mémoire est O(1) au-delà du morceau reçu : seuls un bloc de 64
   * octets et huit mots d'état sont retenus, jamais l'historique du flux.
   * @param {Uint8Array} bytes
   */
  update(bytes) {
    if (this.#finalized) {
      throw new Error("SHA-256 déjà finalisé : `update` après `digest` est interdit.");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("SHA-256 `update` attend un Uint8Array.");
    }
    this.#totalBytes += bytes.byteLength;
    let offset = 0;

    // Compléter d'abord un bloc partiel resté d'un `update` précédent.
    if (this.#blockLength > 0) {
      const need = BLOCK_BYTES - this.#blockLength;
      const take = Math.min(need, bytes.byteLength);
      this.#block.set(bytes.subarray(0, take), this.#blockLength);
      this.#blockLength += take;
      offset = take;
      if (this.#blockLength === BLOCK_BYTES) {
        this.#compress(this.#block, 0);
        this.#blockLength = 0;
      }
    }

    // Traiter les blocs complets directement depuis l'entrée, sans copie intermédiaire.
    while (bytes.byteLength - offset >= BLOCK_BYTES) {
      this.#compress(bytes, offset);
      offset += BLOCK_BYTES;
    }

    // Conserver le reliquat (< 64 octets) pour le prochain `update` ou la finalisation.
    const rest = bytes.byteLength - offset;
    if (rest > 0) {
      this.#block.set(bytes.subarray(offset), this.#blockLength);
      this.#blockLength += rest;
    }
    return this;
  }

  /** Finalise et rend l'empreinte (32 octets). Terminal : aucun `update` n'est plus accepté. */
  digest() {
    if (this.#finalized) {
      throw new Error("SHA-256 déjà finalisé : `digest` ne peut être appelé qu'une fois.");
    }
    this.#finalized = true;

    const bitLength = BigInt(this.#totalBytes) * 8n;
    // Padding : un octet 0x80, des zéros, puis la longueur en bits sur 64 bits big-endian, de sorte
    // que la longueur totale soit un multiple de 64.
    const padLength = this.#blockLength < 56 ? 56 - this.#blockLength : 120 - this.#blockLength;
    const tail = new Uint8Array(padLength + 8);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setBigUint64(padLength, bitLength, false);
    this.#absorbFinal(tail);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.#h[i], false);
    return out;
  }

  /** Empreinte en hexadécimal minuscule. */
  digestHex() {
    const bytes = this.digest();
    let hex = "";
    for (const value of bytes) hex += HEX[value];
    return hex;
  }

  /** Absorbe les octets de padding/longueur pendant la finalisation. Usage interne à `digest`. */
  #absorbFinal(bytes) {
    let offset = 0;
    if (this.#blockLength > 0) {
      const take = BLOCK_BYTES - this.#blockLength;
      this.#block.set(bytes.subarray(0, take), this.#blockLength);
      this.#compress(this.#block, 0);
      this.#blockLength = 0;
      offset = take;
    }
    while (bytes.byteLength - offset >= BLOCK_BYTES) {
      this.#compress(bytes, offset);
      offset += BLOCK_BYTES;
    }
  }

  /** Comprime un bloc de 64 octets situé à `at` dans `source`. Cœur arithmétique de SHA-256. */
  #compress(source, at) {
    const w = this.#w;
    for (let i = 0; i < 16; i += 1) {
      const j = at + i * 4;
      w[i] = (source[j] << 24) | (source[j + 1] << 16) | (source[j + 2] << 8) | source[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = this.#h[0];
    let b = this.#h[1];
    let c = this.#h[2];
    let d = this.#h[3];
    let e = this.#h[4];
    let f = this.#h[5];
    let g = this.#h[6];
    let h = this.#h[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    this.#h[0] = (this.#h[0] + a) | 0;
    this.#h[1] = (this.#h[1] + b) | 0;
    this.#h[2] = (this.#h[2] + c) | 0;
    this.#h[3] = (this.#h[3] + d) | 0;
    this.#h[4] = (this.#h[4] + e) | 0;
    this.#h[5] = (this.#h[5] + f) | 0;
    this.#h[6] = (this.#h[6] + g) | 0;
    this.#h[7] = (this.#h[7] + h) | 0;
  }
}

/** Ouvre un hachage SHA-256 incrémental. Alimenter par `update(bytes)`, clore par `digest()`/`digestHex()`. */
export function createSha256Stream() {
  return new Sha256Stream();
}
