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

import {
  DIGEST_ALGORITHM,
  MIN_VOLUME_FORMAT_VERSION,
  createManifest,
  parseManifest,
  assertReadable,
} from "./volume-manifest.mjs";
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

/**
 * Rend un manifeste GELÉ identique à `base`, mais dont `identity.digest` porte l'empreinte donnée.
 *
 * Le bloc `volume` du format v3 est reporté TEL QUEL : l'identifiant d'un volume est immuable, et
 * l'archive doit décrire le volume qu'elle porte — pas un volume neuf. Il est absent des formats
 * antérieurs, et `createManifest` refuserait de l'y inscrire.
 */
function withContentDigest(base, digest) {
  return createManifest({
    formatVersion: base.formatVersion,
    runtime: base.runtime,
    app: base.app,
    volumeSize: base.geometry.volumeSize,
    identity: { algorithm: base.identity.algorithm, digest },
    ...(base.volume === undefined ? {} : { volume: base.volume }),
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

/** Valide les collaborateurs injectés. Une faute de programmation n'est pas un état de format. */
function assertContratDExport({ source, sink, blockBytes }) {
  if (!source || typeof source.read !== "function" || !Number.isInteger(source.size)) {
    throw new TypeError("writeArchive attend une source { size, read(offset, length) }.");
  }
  if (!sink || typeof sink.write !== "function") {
    throw new TypeError("writeArchive attend un puits { write(bytes) }.");
  }
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) {
    throw new RangeError(`Taille de bloc invalide : ${blockBytes}.`);
  }
}

/**
 * Analyse le manifeste fourni et l'accorde à la source. Séparé des contrôles ci-dessus parce que le
 * refus qu'il porte est d'une AUTRE NATURE : un manifeste qui décrit un autre volume que celui qu'on
 * s'apprête à lire est un état de format, refusé par un code typé, et non une faute d'appel.
 */
/**
 * Refuse d'exporter un volume CHIFFRÉ par ce chemin (#18, ADR 0016).
 *
 * L'ADR 0016 décide que l'archive porte le fichier v3 TEL QUEL. Ce chemin ne sait pas le faire : sa
 * source lit par le chemin AUTORISÉ, qui déchiffre. Le laisser passer produirait une archive **en
 * clair** d'un volume chiffré — le chiffrement au repos annulé dès que le fichier quitte l'appareil,
 * sans que rien ne le dise. Le refus tombe AVANT la première passe, donc avant qu'un seul octet
 * n'ait été lu.
 */
function refuserVolumeChiffre(base) {
  if (base.formatVersion < MIN_VOLUME_FORMAT_VERSION) return base;
  throw new ArchiveError(
    ARCHIVE_ERROR_CODES.encryptedUnsupported,
    `Export refusé : le volume est au format v${base.formatVersion}, donc CHIFFRÉ, et l'archive doit en porter le fichier TEL QUEL (ADR 0016). Ce chemin lit le volume par la lecture autorisée, qui déchiffre : il produirait une archive en clair, c'est-à-dire annulerait le chiffrement au repos. Une clé n'y changerait rien — c'est la lecture BRUTE qui manque, et elle est l'objet de #101.`,
    { formatVersion: base.formatVersion, issue: 101 },
  );
}

function accorderManifesteEtSource(manifest, source) {
  // Le manifeste est validé par #10 (objet, octets ou chaîne acceptés) avant tout usage.
  const base = refuserVolumeChiffre(parseManifest(manifest));
  if (base.geometry.volumeSize !== source.size) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.geometryMismatch,
      `Export refusé : le manifeste déclare ${base.geometry.volumeSize} octet(s) mais la source en porte ${source.size}.`,
      { manifestVolumeSize: base.geometry.volumeSize, sourceSize: source.size },
    );
  }
  return base;
}

/**
 * Écrit le préambule et l'en-tête vers le puits, et rend le manifeste inscrit avec ses octets.
 * Extrait parce que cette étape est la CHARNIÈRE des deux passes : elle ne peut exister qu'entre
 * elles, `identity.digest` n'étant renseignable qu'une fois la première passe achevée.
 */
async function ecrireEnTete({ sink, base, digest, contentLength, consistency }) {
  const manifestWithDigest = withContentDigest(base, digest);
  const header = buildHeader({ manifest: manifestWithDigest, digest, contentLength, consistency });
  const headerBytes = encoder.encode(JSON.stringify(header));
  await sink.write(encodePreamble(headerBytes.byteLength));
  await sink.write(headerBytes);
  return { manifestWithDigest, headerBytes };
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
  assertContratDExport({ source, sink, blockBytes });
  const guarantee = normalizeConsistency(consistency);
  const base = accorderManifesteEtSource(manifest, source);

  // Passe 1 : empreinte du contenu, en flux.
  const hash = createSha256Stream();
  await streamVolume(source, blockBytes, (bytes) => hash.update(bytes));
  const digest = hash.digestHex();

  // En-tête : manifeste avec digest renseigné, puis préambule + en-tête vers le puits.
  const { manifestWithDigest, headerBytes } = await ecrireEnTete({
    sink,
    base,
    digest,
    contentLength: source.size,
    consistency: guarantee,
  });

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

/**
 * Vrai si les huit octets de tête sont le marqueur d'archive. Exporté parce que le marqueur est le
 * SEUL moyen bon marché de distinguer une archive d'un volume : huit octets lus suffisent, là où
 * juger sur un nom de fichier reviendrait à croire une convention plutôt qu'un contenu.
 * @param {Uint8Array} bytes au moins les huit premiers octets du candidat
 */
export function hasArchiveMagic(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < ARCHIVE_MAGIC.byteLength) return false;
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
  // L'archive ne connaît qu'un algorithme, et c'est celui qu'elle calcule. Accepter une autre
  // étiquette rendrait persistante une affirmation que ce code ne tient pas : l'empreinte serait
  // recalculée en SHA-256 et confrontée à une valeur annoncée comme étant autre chose.
  if (content.algorithm !== DIGEST_ALGORITHM) {
    throw malformed(`algorithme d'empreinte non pris en charge : ${content.algorithm}.`, {
      algorithm: content.algorithm ?? null,
      expected: DIGEST_ALGORITHM,
    });
  }
}

/**
 * Lit le préambule puis l'en-tête JSON, et rend l'en-tête VALIDÉ avec sa longueur. Extrait parce que
 * la reconnaissance du conteneur est une étape entière et close : marqueur binaire, longueur
 * plausible, JSON analysable, forme d'en-tête. Elle décide seule si ces octets sont une archive,
 * avant qu'aucune question de manifeste ou de contenu ne se pose.
 */
async function lireEnTete(read, byteLength) {
  const preamble = await readExact(read, 0, PREAMBLE_BYTES, byteLength);
  if (!hasArchiveMagic(preamble)) {
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
  return { header, headerLength };
}

/**
 * Accorde le manifeste porté par l'en-tête avec le descripteur de contenu qui l'accompagne, et rend
 * le manifeste validé. Extrait parce que ces contrôles répondent à UNE SEULE question — l'archive
 * dit-elle deux fois la même chose ? — et parce que leur ORDRE est significatif : #10 tranche
 * d'abord la validité du manifeste, la compatibilité ensuite, la concordance interne en dernier.
 */
function accorderManifesteEtContenu(header, { expectations, enforceCompatibility }) {
  // Manifeste validé par #10 : objet à moitié valide impossible, refus typé propagé.
  const manifest = parseManifest(header.manifest);
  // La compatibilité est vérifiée PAR DÉFAUT, avec ou sans attentes fournies : un contrôle qui ne
  // s'exécute que si l'appelant pense à le demander n'est pas un contrôle. Sans attentes, la plage
  // de formats de ce runtime (`DEFAULT_SUPPORTED_FORMAT`) s'applique déjà. La dérogation existe pour
  // un outil de DIAGNOSTIC — lire un conteneur qu'on ne saurait pas ouvrir en écriture —, mais elle
  // doit être demandée, nommément.
  if (enforceCompatibility) {
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
  return manifest;
}

/**
 * Refuse un contenu plus court que déclaré, puis RECALCULE son empreinte et la confronte à celle
 * inscrite. Extrait parce que c'est la vérification qui COÛTE : elle relit tout le contenu, et la
 * borne de surmémoire de la lecture tient dans cette boucle et nulle part ailleurs. La troncature se
 * mesure avant la première lecture de contenu : inutile d'empreinter ce qu'on sait déjà incomplet.
 */
async function verifierEmpreinteDuContenu({
  read,
  byteLength,
  contentOffset,
  contentLength,
  declaredLength,
  blockBytes,
  digestInscrit,
}) {
  if (byteLength < declaredLength) {
    throw truncated(
      `contenu incomplet : ${byteLength - contentOffset} octet(s) présents sur ${contentLength} déclarés.`,
      { present: Math.max(0, byteLength - contentOffset), declared: contentLength },
    );
  }

  // Recalcul de l'empreinte EN STREAMING : le contenu n'est jamais tenu entier en mémoire.
  const hash = createSha256Stream();
  let offset = contentOffset;
  while (offset < declaredLength) {
    const length = Math.min(blockBytes, declaredLength - offset);
    const bytes = await readExact(read, offset, length, byteLength);
    hash.update(bytes);
    offset += length;
  }
  const computed = hash.digestHex();
  if (computed !== digestInscrit) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.digestMismatch,
      `Empreinte non concordante : recalculée ${computed}, inscrite ${digestInscrit}.`,
      { computed, declared: digestInscrit },
    );
  }
  return computed;
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
  enforceCompatibility = true,
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

  const { header, headerLength } = await lireEnTete(read, byteLength);
  const manifest = accorderManifesteEtContenu(header, { expectations, enforceCompatibility });

  const contentLength = header.content.length;
  const contentOffset = PREAMBLE_BYTES + headerLength;
  const declaredLength = contentOffset + contentLength;

  const contentDigest = await verifierEmpreinteDuContenu({
    read,
    byteLength,
    contentOffset,
    contentLength,
    declaredLength,
    blockBytes,
    digestInscrit: header.content.digest,
  });

  return {
    manifest,
    contentDigest,
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
export async function verifyArchive(
  bytes,
  { expectations = {}, blockBytes, enforceCompatibility = true } = {},
) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("verifyArchive attend un Uint8Array.");
  }
  const read = (offset, length) => bytes.subarray(offset, offset + length);
  return readArchive({
    read,
    byteLength: bytes.byteLength,
    expectations,
    blockBytes,
    enforceCompatibility,
  });
}
