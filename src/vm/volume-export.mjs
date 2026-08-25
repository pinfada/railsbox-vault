// Export d'un volume complet et VÉRIFIABLE (#11, `VAULT-PORT-001`).
//
// Une archive lie, en un conteneur portable, le MANIFESTE versionné de #10 (avec son
// `identity.digest` enfin RENSEIGNÉ) et le CONTENU intégral du volume, plus l'empreinte SHA-256 de
// ce contenu. Elle est le socle de la restauration inter-origine (#12).
//
// Trois exigences gouvernent ce module (`docs/quality-attributes.md`, `docs/architecture.md`) :
//
//  - **Streaming à surmémoire bornée.** Le volume est lu et empreinté PAR BLOCS ; jamais tenu entier
//    en mémoire. L'empreinte est calculée par le hachage incrémental portable de
//    `sha256-stream.mjs`, faute d'un hachage incrémental dans WebCrypto. Surmémoire ≤ 64 Mio,
//    archive ≤ 2× la taille logique (l'en-tête ne coûte que quelques centaines d'octets).
//  - **Point cohérent.** L'export lit sous GARANTIE de non-écriture concurrente. Il ne prend pas
//    lui-même le bail : il EXIGE que l'appelant déclare la garantie sous laquelle le point est tenu
//    (bail d'écrivain unique #8, barrière acquittée #14, ou handle exclusif #6), et il l'inscrit dans
//    l'archive. Refuser une garantie non déclarée évite un export silencieusement non protégé.
//    L'atomicité complète d'une génération est réservée à #16.
//  - **Vérifiabilité.** `verifyArchive` recalcule l'empreinte du contenu et valide le manifeste par
//    #10. Une archive tronquée, une empreinte non concordante ou un manifeste incompatible produit un
//    ÉCHEC TYPÉ (`archive-errors.mjs` ou `ManifestError` de #10), jamais un succès silencieux.
//
// Disposition binaire de l'archive v1 (append-only, donc streamable) :
//
//   [ marqueur 8 o ][ longueur d'en-tête uint32 BE 4 o ][ en-tête JSON H o ][ contenu N o ]
//
// Le marqueur distingue une archive de bruit ; la longueur délimite l'en-tête sans le scanner ;
// l'en-tête JSON porte le manifeste (digest renseigné) et le descripteur de contenu ; le contenu est
// le volume octet pour octet. `offset du contenu = 12 + H` ; `taille de l'archive = 12 + H + N`.

import { createManifest, parseManifest, assertReadable } from "./volume-manifest.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";
import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";

/** Marqueur binaire de tête : 8 octets ASCII, jamais modifiés. Reconnaît une archive avant tout. */
export const ARCHIVE_MAGIC = new Uint8Array([0x52, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x31]); // "RBVAULT1"

/** Marqueur textuel porté par l'en-tête JSON : distingue l'en-tête d'un objet JSON quelconque. */
export const ARCHIVE_HEADER_MAGIC = "railsbox-vault/volume-archive";

/** Version entière du format d'archive. Comme le format de volume, jamais dérivée de la version npm. */
export const ARCHIVE_FORMAT_VERSION = 1;

/** Taille du préambule binaire : marqueur (8) + longueur d'en-tête (4). */
export const PREAMBLE_BYTES = ARCHIVE_MAGIC.byteLength + 4;

/** Plafond de longueur d'en-tête : un en-tête plausible tient en quelques kio ; au-delà, c'est du bruit. */
const MAX_HEADER_BYTES = 1024 * 1024;

/** Bloc de streaming par défaut : assez grand pour l'efficacité, très en deçà du budget de 64 Mio. */
export const DEFAULT_BLOCK_BYTES = 4 * 1024 * 1024;

/**
 * Garanties de cohérence admises. L'export EXIGE que l'appelant en déclare une : elle atteste sous
 * quelle protection le point cohérent a été tenu pendant la lecture. Elle est inscrite dans l'archive.
 */
export const CONSISTENCY_KINDS = Object.freeze({
  /** L'appelant tient le bail d'écrivain unique (#8) : seul écrivain, il n'écrit pas pendant l'export. */
  lease: "bail-ecrivain-unique",
  /** Une barrière de durabilité (#14) a été acquittée avant la lecture : aucune écriture en vol. */
  barrier: "barriere-acquittee",
  /** Le volume est lu via le handle OPFS exclusif (#6) : aucun autre contexte n'écrit dans l'origine. */
  exclusiveHandle: "handle-exclusif",
});

const CONSISTENCY_VALUES = new Set(Object.values(CONSISTENCY_KINDS));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Vérifie la garantie de cohérence, ou refuse un export non protégé. */
function normalizeConsistency(consistency) {
  if (!consistency || typeof consistency !== "object") {
    throw new TypeError(
      "Export refusé : une garantie de cohérence est requise (voir CONSISTENCY_KINDS).",
    );
  }
  if (!CONSISTENCY_VALUES.has(consistency.kind)) {
    throw new TypeError(
      `Garantie de cohérence inconnue : ${JSON.stringify(consistency.kind)}. Attendu l'une de ${[...CONSISTENCY_VALUES].join(", ")}.`,
    );
  }
  const detail = typeof consistency.detail === "string" ? consistency.detail : null;
  return { kind: consistency.kind, detail };
}

/** Rend un manifeste v1 GELÉ identique à `base`, mais dont `identity.digest` porte l'empreinte donnée. */
function withContentDigest(base, digest) {
  return createManifest({
    formatVersion: base.formatVersion,
    runtime: base.runtime,
    app: base.app,
    volumeSize: base.geometry.volumeSize,
    identity: { algorithm: base.identity.algorithm, digest },
  });
}

/** Encode le préambule binaire (marqueur + longueur d'en-tête). */
function encodePreamble(headerLength) {
  const preamble = new Uint8Array(PREAMBLE_BYTES);
  preamble.set(ARCHIVE_MAGIC, 0);
  new DataView(preamble.buffer).setUint32(ARCHIVE_MAGIC.byteLength, headerLength, false);
  return preamble;
}

/** Construit l'objet d'en-tête : manifeste (digest renseigné) + descripteur de contenu. */
function buildHeader({ manifest, digest, contentLength, consistency }) {
  return {
    magic: ARCHIVE_HEADER_MAGIC,
    archiveFormatVersion: ARCHIVE_FORMAT_VERSION,
    content: {
      algorithm: manifest.identity.algorithm,
      digest,
      length: contentLength,
      consistency,
    },
    manifest,
  };
}

/**
 * Lit le volume par blocs et applique `onBlock` à chacun. Coût mémoire O(taille du bloc) : le volume
 * n'est jamais matérialisé en entier. `onBlock` peut être asynchrone (écriture vers un puits).
 */
async function streamVolume(source, blockBytes, onBlock) {
  const size = source.size;
  let offset = 0;
  while (offset < size) {
    const length = Math.min(blockBytes, size - offset);
    const bytes = await source.read(offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new TypeError(
        `Source de volume incohérente : ${bytes?.byteLength} octet(s) rendus sur ${length} à l'offset ${offset}.`,
      );
    }
    await onBlock(bytes);
    offset += length;
  }
}

/**
 * Écrit une archive vers un puits séquentiel, en STREAMING et à surmémoire bornée. Deux passes sur la
 * source : la première empreinte le contenu (pour renseigner `identity.digest` AVANT d'écrire
 * l'en-tête) ; la seconde recopie le contenu. La source doit donc être relisible — c'est le cas d'un
 * volume OPFS (#6). Le puits n'a besoin que d'un `write(bytes)` séquentiel.
 *
 * @param {{ source: { size: number, read: (offset: number, length: number) => Promise<Uint8Array> },
 *           sink: { write: (bytes: Uint8Array) => (void | Promise<void>) },
 *           manifest: object | Uint8Array | string,
 *           consistency: { kind: string, detail?: string },
 *           blockBytes?: number }} args
 * @returns {Promise<{ digest: string, contentLength: number, headerLength: number,
 *                     archiveLength: number, manifest: object, consistency: object }>}
 */
export async function writeArchive({
  source,
  sink,
  manifest,
  consistency,
  blockBytes = DEFAULT_BLOCK_BYTES,
}) {
  if (!source || typeof source.read !== "function" || !Number.isInteger(source.size)) {
    throw new TypeError("writeArchive attend une source { size, read(offset, length) }.");
  }
  if (!sink || typeof sink.write !== "function") {
    throw new TypeError("writeArchive attend un puits { write(bytes) }.");
  }
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) {
    throw new RangeError(`Taille de bloc invalide : ${blockBytes}.`);
  }
  const guarantee = normalizeConsistency(consistency);
  // Le manifeste est validé par #10 (objet, octets ou chaîne acceptés) avant tout usage.
  const base = parseManifest(manifest);
  if (base.geometry.volumeSize !== source.size) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.geometryMismatch,
      `Export refusé : le manifeste déclare ${base.geometry.volumeSize} octet(s) mais la source en porte ${source.size}.`,
      { manifestVolumeSize: base.geometry.volumeSize, sourceSize: source.size },
    );
  }

  // Passe 1 : empreinte du contenu, en flux.
  const hash = createSha256Stream();
  await streamVolume(source, blockBytes, (bytes) => hash.update(bytes));
  const digest = hash.digestHex();

  // En-tête : manifeste avec digest renseigné, puis préambule + en-tête vers le puits.
  const manifestWithDigest = withContentDigest(base, digest);
  const header = buildHeader({
    manifest: manifestWithDigest,
    digest,
    contentLength: source.size,
    consistency: guarantee,
  });
  const headerBytes = encoder.encode(JSON.stringify(header));
  await sink.write(encodePreamble(headerBytes.byteLength));
  await sink.write(headerBytes);

  // Passe 2 : recopie du contenu, en flux.
  await streamVolume(source, blockBytes, (bytes) => sink.write(bytes));

  const archiveLength = PREAMBLE_BYTES + headerBytes.byteLength + source.size;
  return {
    digest,
    contentLength: source.size,
    headerLength: headerBytes.byteLength,
    archiveLength,
    manifest: manifestWithDigest,
    consistency: guarantee,
  };
}

/** Adapte un backend de blocs (#6) en source d'export : `size` figé et `read` délégué. */
export function backendSource(backend) {
  return { size: backend.size(), read: (offset, length) => backend.read(offset, length) };
}

/** Erreur typée de troncature : l'archive est plus courte que ce que son en-tête déclare. */
function truncated(message, context) {
  return new ArchiveError(ARCHIVE_ERROR_CODES.truncated, `Archive tronquée : ${message}`, context);
}

/** Erreur typée de conteneur méconnaissable. */
function malformed(message, context) {
  return new ArchiveError(ARCHIVE_ERROR_CODES.malformed, `Archive malformée : ${message}`, context);
}

/** Lit exactement `length` octets à `offset`, ou lève une troncature typée. */
async function readExact(read, offset, length, byteLength) {
  if (offset + length > byteLength) {
    throw truncated(
      `${length} octet(s) demandés à ${offset}, mais l'archive n'en compte que ${byteLength}.`,
      {
        offset,
        length,
        byteLength,
      },
    );
  }
  const bytes = await read(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw truncated(
      `lecture courte : ${bytes?.byteLength} octet(s) rendus sur ${length} à ${offset}.`,
      {
        offset,
        length,
        obtained: bytes?.byteLength ?? null,
      },
    );
  }
  return bytes;
}

/** Vrai si les huit octets de tête sont le marqueur d'archive. */
function hasMagic(bytes) {
  for (let i = 0; i < ARCHIVE_MAGIC.byteLength; i += 1) {
    if (bytes[i] !== ARCHIVE_MAGIC[i]) return false;
  }
  return true;
}

/** Valide la structure de l'en-tête JSON décodé, ou lève `VAULT_ARCHIVE_MALFORMED`. */
function validateHeaderShape(header) {
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw malformed("en-tête JSON non objet.", {});
  }
  if (header.magic !== ARCHIVE_HEADER_MAGIC) {
    throw malformed("marqueur d'en-tête absent ou inconnu.", { magic: header.magic ?? null });
  }
  if (header.archiveFormatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw malformed("version de format d'archive non prise en charge.", {
      archiveFormatVersion: header.archiveFormatVersion ?? null,
    });
  }
  const content = header.content;
  if (!content || typeof content !== "object") {
    throw malformed("descripteur de contenu absent.", {});
  }
  if (typeof content.digest !== "string" || content.digest === "") {
    throw malformed("empreinte de contenu absente.", {});
  }
  if (!Number.isInteger(content.length) || content.length < 0) {
    throw malformed("longueur de contenu absente ou invalide.", { length: content.length ?? null });
  }
  if (typeof content.algorithm !== "string" || content.algorithm === "") {
    throw malformed("algorithme d'empreinte absent.", {});
  }
}

/**
 * Lit et VÉRIFIE une archive en streaming. `read(offset, length)` lit l'archive ; `byteLength` est sa
 * taille totale. La vérification recalcule l'empreinte du contenu et valide le manifeste par #10.
 *
 * Échecs typés, jamais un succès silencieux :
 *  - marqueur/en-tête méconnaissable → `VAULT_ARCHIVE_MALFORMED` ;
 *  - archive plus courte que déclarée → `VAULT_ARCHIVE_TRUNCATED` ;
 *  - longueur de contenu contredisant la géométrie du manifeste → `VAULT_ARCHIVE_GEOMETRY_MISMATCH` ;
 *  - empreinte recalculée ≠ empreinte inscrite → `VAULT_ARCHIVE_DIGEST_MISMATCH` ;
 *  - manifeste malformé/incompatible → `ManifestError` de #10 (propagée telle quelle).
 *
 * @returns {Promise<{ manifest: object, contentDigest: string, contentLength: number,
 *                     consistency: object|null, archiveLength: number }>}
 */
export async function readArchive({
  read,
  byteLength,
  blockBytes = DEFAULT_BLOCK_BYTES,
  expectations = {},
}) {
  if (typeof read !== "function" || !Number.isInteger(byteLength) || byteLength < 0) {
    throw new TypeError("readArchive attend { read(offset, length), byteLength }.");
  }
  if (byteLength < PREAMBLE_BYTES) {
    throw truncated(
      `${byteLength} octet(s) : trop court même pour le préambule (${PREAMBLE_BYTES}).`,
      {
        byteLength,
      },
    );
  }

  const preamble = await readExact(read, 0, PREAMBLE_BYTES, byteLength);
  if (!hasMagic(preamble)) {
    throw malformed("marqueur binaire absent : ce n'est pas une archive Vault.", {});
  }
  const headerLength = new DataView(
    preamble.buffer,
    preamble.byteOffset,
    preamble.byteLength,
  ).getUint32(ARCHIVE_MAGIC.byteLength, false);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw malformed(`longueur d'en-tête implausible : ${headerLength}.`, { headerLength });
  }

  const headerBytes = await readExact(read, PREAMBLE_BYTES, headerLength, byteLength);
  let header;
  try {
    header = JSON.parse(decoder.decode(headerBytes));
  } catch {
    throw malformed("en-tête JSON illisible.", {});
  }
  validateHeaderShape(header);

  // Manifeste validé par #10 : objet à moitié valide impossible, refus typé propagé.
  const manifest = parseManifest(header.manifest);
  if (expectations && (expectations.app || expectations.runtime || expectations.supportedFormat)) {
    assertReadable(manifest, expectations);
  }

  const contentLength = header.content.length;
  if (contentLength !== manifest.geometry.volumeSize) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.geometryMismatch,
      `Longueur de contenu (${contentLength}) incohérente avec la géométrie du manifeste (${manifest.geometry.volumeSize}).`,
      { contentLength, volumeSize: manifest.geometry.volumeSize },
    );
  }
  if (manifest.identity.digest !== header.content.digest) {
    throw malformed("le digest du manifeste et celui de l'en-tête divergent.", {
      manifestDigest: manifest.identity.digest,
      headerDigest: header.content.digest,
    });
  }

  const contentOffset = PREAMBLE_BYTES + headerLength;
  const declaredLength = contentOffset + contentLength;
  if (byteLength < declaredLength) {
    throw truncated(
      `contenu incomplet : ${byteLength - contentOffset} octet(s) présents sur ${contentLength} déclarés.`,
      { present: Math.max(0, byteLength - contentOffset), declared: contentLength },
    );
  }

  // Recalcul de l'empreinte EN STREAMING : le contenu n'est jamais tenu entier en mémoire.
  const hash = createSha256Stream();
  let offset = contentOffset;
  const end = contentOffset + contentLength;
  while (offset < end) {
    const length = Math.min(blockBytes, end - offset);
    const bytes = await readExact(read, offset, length, byteLength);
    hash.update(bytes);
    offset += length;
  }
  const computed = hash.digestHex();
  if (computed !== header.content.digest) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.digestMismatch,
      `Empreinte non concordante : recalculée ${computed}, inscrite ${header.content.digest}.`,
      { computed, declared: header.content.digest },
    );
  }

  return {
    manifest,
    contentDigest: computed,
    contentLength,
    // Offset du premier octet de contenu. Il est déductible (`archiveLength - contentLength`), mais
    // la restauration (#12) le relit bloc par bloc : le rendre explicite évite qu'un appelant
    // refasse l'arithmétique de la disposition d'archive à sa façon.
    contentOffset,
    consistency: header.content.consistency ?? null,
    archiveLength: declaredLength,
  };
}

/**
 * Exporte un volume vers une archive EN MÉMOIRE. Commodité pour les petits volumes (tests, doubles
 * déterministes) : pour un vrai volume, préférer `writeArchive` vers un puits qui n'accumule pas tout
 * en RAM. Le contenu source, lui, reste toujours lu en streaming.
 */
export async function exportVolumeToBytes({ source, manifest, consistency, blockBytes }) {
  const chunks = [];
  let total = 0;
  const sink = {
    write(bytes) {
      const copy = bytes.slice();
      chunks.push(copy);
      total += copy.byteLength;
    },
  };
  const result = await writeArchive({ source, sink, manifest, consistency, blockBytes });
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { archive, ...result };
}

/**
 * Vérifie une archive tenue EN MÉMOIRE. Recalcule l'empreinte et valide le manifeste ; rend le
 * verdict ou lève un échec typé. Pour une grande archive, préférer `readArchive` sur un lecteur qui
 * ne la tient pas entière en RAM.
 *
 * @param {Uint8Array} bytes
 * @param {{ expectations?: object, blockBytes?: number }} [options]
 */
export async function verifyArchive(bytes, { expectations = {}, blockBytes } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("verifyArchive attend un Uint8Array.");
  }
  const read = (offset, length) => bytes.subarray(offset, offset + length);
  return readArchive({ read, byteLength: bytes.byteLength, expectations, blockBytes });
}
