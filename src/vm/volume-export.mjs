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
// Disposition binaire de l'archive (append-only, donc streamable) :
//
//   v1  [ marqueur 8 o ][ longueur d'en-tête uint32 BE 4 o ][ en-tête JSON H o ][ contenu N o ]
//   v2  … la même, suivie de [ enveloppe de récupération R o ]
//
// Le marqueur distingue une archive de bruit ; la longueur délimite l'en-tête sans le scanner ;
// l'en-tête JSON porte le manifeste (digest renseigné) et le descripteur de contenu ; le contenu est
// le volume octet pour octet. `offset du contenu = 12 + H` ; `taille de l'archive = 12 + H + N + R`,
// avec `R = 0` pour une archive v1 ou une archive v2 sans moyen de récupération.
//
// ## La version 2 (#149, ADR 0027)
//
// Une archive v2 peut emporter une ENVELOPPE DE RÉCUPÉRATION : la capacité d'ouvrir le volume
// restauré ailleurs, par le code que l'utilisateur détient. Ce module l'écrit en queue et déclare
// son empreinte ; sa FORME est jugée par `archive-recuperation.mjs`, à l'écriture comme à la
// lecture (ADR 0027). Une archive v1 reste LUE telle quelle ; elle n'est plus écrite.

import { DIGEST_ALGORITHM } from "./volume-manifest.mjs";
import {
  accorderManifesteEtContenu,
  accorderManifesteEtSource,
  withContentDigest,
} from "./archive-manifeste.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";
import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";
import {
  assertChampDeRecuperation,
  assertRienEnQueue,
  normaliserRecuperation,
  verifierLaRecuperation,
} from "./archive-recuperation.mjs";
import {
  engagementEnJson,
  exigerEngagementAdmis,
  lireLEngagementDeLArchive,
  scellerLEngagementDeLArchive,
} from "./archive-engagement.mjs";

/** Marqueur binaire de tête : 8 octets ASCII, jamais modifiés. Reconnaît une archive avant tout. */
export const ARCHIVE_MAGIC = new Uint8Array([0x52, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x31]); // "RBVAULT1"

/** Marqueur textuel porté par l'en-tête JSON : distingue l'en-tête d'un objet JSON quelconque. */
export const ARCHIVE_HEADER_MAGIC = "railsbox-vault/volume-archive";

/** Version entière du format d'archive ÉCRITE. Comme le format de volume, jamais dérivée de npm. */
export const ARCHIVE_FORMAT_VERSION = 3;

/**
 * Versions d'archive que ce runtime sait LIRE : la 3, et elle seule (#181).
 *
 * **Les archives v1 et v2 sont REFUSÉES**, et c'est la correction, pas un dommage collatéral :
 * elles ne portent aucun engagement, et une archive sans engagement est exactement le défaut que la
 * revue externe a relevé. Il n'y a aucune compatibilité à préserver — rien n'est publié, le gate
 * « données sensibles » est fermé, et le dépôt n'a produit d'archive que sous données synthétiques.
 *
 * Le MARQUEUR binaire `RBVAULT1` ne bouge pas. Le changer ferait dire à un runtime ancien « ce
 * n'est pas une archive » au lieu de « cette archive est trop récente », et l'ADR 0011 veut un
 * refus explicite d'un format futur, pas une méconnaissance.
 */
export const ARCHIVE_FORMAT_VERSIONS_LUES = Object.freeze([3]);

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

/** Encode le préambule binaire (marqueur + longueur d'en-tête). */
function encodePreamble(headerLength) {
  const preamble = new Uint8Array(PREAMBLE_BYTES);
  preamble.set(ARCHIVE_MAGIC, 0);
  new DataView(preamble.buffer).setUint32(ARCHIVE_MAGIC.byteLength, headerLength, false);
  return preamble;
}

/**
 * Construit l'objet d'en-tête : manifeste (digest renseigné), descripteur de contenu, descripteur de
 * récupération.
 *
 * `recovery` est TOUJOURS présent dans une v2, à `null` quand le volume n'a pas de moyen de
 * récupération. Un champ absent et un champ nul ne disent pas la même chose : le premier laisserait
 * croire à un lecteur qu'il a affaire à un en-tête d'une autre version, le second dit « ce volume
 * n'en a pas », ce qui est précisément ce que l'exploitant doit apprendre.
 */
function buildHeader({ manifest, digest, contentLength, consistency, recovery, engagement }) {
  return {
    magic: ARCHIVE_HEADER_MAGIC,
    archiveFormatVersion: ARCHIVE_FORMAT_VERSION,
    content: {
      algorithm: manifest.identity.algorithm,
      digest,
      length: contentLength,
      consistency,
    },
    recovery: recovery === null ? null : recovery.descripteur,
    // L'ENGAGEMENT (#181) : l'empreinte du fichier chiffré entier, scellée sous la clé du domaine
    // `archive`. Il est TOUJOURS déclaré — un objet, ou `null` EXPLICITE quand l'archive décrit un
    // volume antérieur à v3, qui n'est pas chiffré et n'a donc ni clé ni identité à engager. C'est
    // la règle de `recovery`, mot pour mot : un champ absent et un champ nul ne disent pas la même
    // chose.
    engagement: engagement === null ? null : engagementEnJson(engagement),
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
 * Écrit le préambule et l'en-tête vers le puits, et rend le manifeste inscrit avec ses octets.
 * Extrait parce que cette étape est la CHARNIÈRE des deux passes : elle ne peut exister qu'entre
 * elles, `identity.digest` n'étant renseignable qu'une fois la première passe achevée.
 */
async function ecrireEnTete({
  sink,
  base,
  digest,
  contentLength,
  consistency,
  recovery,
  engagement,
}) {
  const manifestWithDigest = withContentDigest(base, digest);
  const header = buildHeader({
    manifest: manifestWithDigest,
    digest,
    contentLength,
    consistency,
    recovery,
    engagement,
  });
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
 * `recovery` est l'ENVELOPPE DE RÉCUPÉRATION à emporter, ou `null` (#149, ADR 0027). Elle est écrite
 * EN QUEUE, après le contenu : la queue laisse l'offset du contenu inchangé, donc l'export en un
 * seul passage et la lecture d'une v1 exactement où elles étaient.
 *
 * @param {{ source: { size: number, read: (offset: number, length: number) => Promise<Uint8Array> },
 *           sink: { write: (bytes: Uint8Array) => (void | Promise<void>) },
 *           manifest: object | Uint8Array | string,
 *           consistency: { kind: string, detail?: string },
 *           recovery?: { octets: Uint8Array, digest?: string, version: number,
 *                        emplacements: number } | null,
 *           blockBytes?: number }} args
 * @returns {Promise<{ digest: string, contentLength: number, headerLength: number,
 *                     archiveLength: number, manifest: object, consistency: object,
 *                     recovery: object | null }>}
 */
export async function writeArchive({
  source,
  sink,
  manifest,
  consistency,
  cle,
  recovery = null,
  engagementFige,
  blockBytes = DEFAULT_BLOCK_BYTES,
}) {
  assertContratDExport({ source, sink, blockBytes });
  const guarantee = normalizeConsistency(consistency);
  const base = accorderManifesteEtSource(manifest, source);
  // L'empreinte de la section est calculée AVANT d'écrire l'en-tête : elle y est déclarée, et une
  // archive dont l'en-tête annoncerait une empreinte qu'on n'a pas encore vue ne serait vérifiable
  // par personne.
  const section = normaliserRecuperation(recovery);
  const passe1 = { source, blockBytes, base, cle, section, engagementFige };
  const { digest, engagement } = await empreinterEtEngager(passe1);

  // En-tête : manifeste avec digest renseigné, puis préambule + en-tête vers le puits.
  const { manifestWithDigest, headerBytes } = await ecrireEnTete({
    sink,
    base,
    digest,
    contentLength: source.size,
    consistency: guarantee,
    recovery: section,
    engagement,
  });

  // Passe 2 : recopie du contenu, en flux.
  await streamVolume(source, blockBytes, (bytes) => sink.write(bytes));
  // Passe 3 : la section de récupération, en queue. Quelques kio, écrits d'un bloc.
  if (section !== null) await sink.write(section.octets);

  return rapportDExport({
    digest,
    source,
    headerBytes,
    guarantee,
    section,
    engagement,
    manifest: manifestWithDigest,
  });
}

/** Compte rendu d'un export réussi. Extrait pour que l'orchestration reste lisible d'un œil. */
function rapportDExport({ digest, source, headerBytes, guarantee, section, engagement, manifest }) {
  const recoveryLength = section === null ? 0 : section.octets.byteLength;
  return {
    digest,
    contentLength: source.size,
    headerLength: headerBytes.byteLength,
    archiveLength: PREAMBLE_BYTES + headerBytes.byteLength + source.size + recoveryLength,
    manifest,
    consistency: guarantee,
    recovery: section === null ? null : section.descripteur,
    // Le DESCRIPTEUR de l'engagement, sans ses octets : le compte rendu franchit `postMessage` et
    // va dans un journal. Ce qu'un exploitant doit y lire est que l'archive est engagée, et sur
    // quelle géométrie. `null` quand elle décrit un volume antérieur à v3.
    engagement: engagement === null ? null : engagement.descripteur,
  };
}

/**
 * PASSE 1 de l'export : l'empreinte du contenu, en flux, puis l'ENGAGEMENT qui la scelle.
 *
 * Les deux vivent ensemble parce que l'ORDRE est le sujet : l'engagement scelle l'empreinte que
 * cette passe vient de calculer, et il doit être dans l'en-tête que la passe suivante écrit. Entre
 * les deux, rien n'a touché au puits — une archive dont l'en-tête annoncerait une empreinte qu'on
 * n'a pas encore vue ne serait vérifiable par personne.
 */
async function empreinterEtEngager({ source, blockBytes, base, cle, section, engagementFige }) {
  const hash = createSha256Stream();
  await streamVolume(source, blockBytes, (bytes) => hash.update(bytes));
  const digest = hash.digestHex();
  const engagement = await scellerLEngagementDeLArchive({
    base,
    cle,
    digest,
    contentLength: source.size,
    recovery: section,
    versionDArchive: ARCHIVE_FORMAT_VERSION,
    fige: exigerEngagementAdmis(engagementFige),
  });
  return { digest, engagement };
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
  if (!ARCHIVE_FORMAT_VERSIONS_LUES.includes(header.archiveFormatVersion)) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.versionNonLue,
      `Restauration refusée : cette archive est en version ${header.archiveFormatVersion ?? "non déclarée"}, et ce runtime ne lit que la version ${ARCHIVE_FORMAT_VERSIONS_LUES.join(", ")}. Une archive antérieure à la v3 ne porte AUCUN engagement : rien n'y atteste que son contenu est un état que le volume a réellement produit, et c'est le défaut que la v3 referme (#181). Aucun octet n'est écrit sur la cible.`,
      {
        archiveFormatVersion: header.archiveFormatVersion ?? null,
        supported: [...ARCHIVE_FORMAT_VERSIONS_LUES],
      },
    );
  }
  assertChampDeRecuperation(header);
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
 *  - section de récupération altérée → `VAULT_ARCHIVE_RECUPERATION_ALTEREE` ;
 *  - descripteur de récupération inadmissible → `VAULT_ARCHIVE_RECUPERATION_REFUSEE` ;
 *  - manifeste malformé/incompatible → `ManifestError` de #10 (propagée telle quelle).
 *
 * @returns {Promise<{ manifest: object, contentDigest: string, contentLength: number,
 *                     consistency: object|null, archiveLength: number,
 *                     recovery: object|null }>}
 */
export async function readArchive({
  read,
  byteLength,
  blockBytes = DEFAULT_BLOCK_BYTES,
  expectations = {},
  enforceCompatibility = true,
}) {
  assertContratDeLecture(read, byteLength);

  const { header, headerLength } = await lireEnTete(read, byteLength);
  const manifest = accorderManifesteEtContenu(header, { expectations, enforceCompatibility });

  const { contentLength, contentOffset, declaredLength } = disposition(header, headerLength);
  const { contentDigest, recovery, archiveLength } = await verifierLesSections({
    header,
    read,
    byteLength,
    blockBytes,
    contentOffset,
    contentLength,
    declaredLength,
  });
  const engagement = lireLEngagementDeLArchive({ header, manifest, contentLength, recovery });

  return {
    manifest,
    contentDigest,
    contentLength,
    // L'ENGAGEMENT, décodé et accompagné du descripteur que l'ARCHIVE déclare (#181). Il n'est pas
    // OUVERT ici : la restauration n'a pas la clé, et c'est une propriété qu'on garde (§ 7.5).
    // C'est l'OUVERTURE du volume restauré qui le confronte, avant de rendre le moindre octet.
    engagement,
    // Offset du premier octet de contenu. Il est déductible (`archiveLength - contentLength`), mais
    // la restauration (#12) le relit bloc par bloc : le rendre explicite évite qu'un appelant
    // refasse l'arithmétique de la disposition d'archive à sa façon.
    contentOffset,
    consistency: header.content.consistency ?? null,
    // Les octets de la section accompagnent son descripteur : ils sont bornés à quelques kio, ils
    // viennent d'être lus et vérifiés, et les relire au moment de les écrire rouvrirait entre la
    // vérification et l'écriture une fenêtre que rien ne surveille.
    recovery,
    archiveLength,
  };
}

/**
 * VÉRIFIE les deux sections que l'archive porte — le contenu, puis la récupération — et refuse ce
 * qui les suit.
 *
 * Elles vivent dans la même fonction parce qu'elles vivent dans la même PHASE : rien n'est rendu
 * tant que les deux empreintes ne concordent pas, et la longueur totale ne se juge qu'une fois la
 * seconde lue. Extraite de `readArchive` pour la garder lisible d'un œil.
 */
async function verifierLesSections({
  header,
  read,
  byteLength,
  blockBytes,
  contentOffset,
  contentLength,
  declaredLength,
}) {
  const contentDigest = await verifierEmpreinteDuContenu({
    read,
    byteLength,
    contentOffset,
    contentLength,
    declaredLength,
    blockBytes,
    digestInscrit: header.content.digest,
  });
  const recovery = await verifierLaRecuperation({
    header,
    read,
    byteLength,
    offset: declaredLength,
  });
  const archiveLength = declaredLength + (recovery === null ? 0 : recovery.length);
  assertRienEnQueue(byteLength, archiveLength);
  return { contentDigest, recovery, archiveLength };
}

/**
 * L'ARITHMÉTIQUE de la disposition, en un endroit : `offset du contenu = 12 + H`, et la fin du
 * contenu, qui sert d'offset à la section de récupération. Les recalculer à la main est ce qu'un
 * lecteur d'archive ne doit jamais avoir à faire deux fois.
 */
function disposition(header, headerLength) {
  const contentLength = header.content.length;
  const contentOffset = PREAMBLE_BYTES + headerLength;
  return { contentLength, contentOffset, declaredLength: contentOffset + contentLength };
}

/**
 * Valide les arguments de lecture, et refuse une entrée trop courte pour porter un préambule. Une
 * faute d'appel est un `TypeError` ; une entrée trop courte est un état de format, donc une
 * troncature typée — les deux se distinguent, et c'est ce que cette fonction tient.
 */
function assertContratDeLecture(read, byteLength) {
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
}
