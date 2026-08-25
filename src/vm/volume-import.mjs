// RESTAURATION d'un volume depuis une archive (#12, `VAULT-PORT-001`).
//
// L'export de #11 produit une archive vérifiable ; ce module fait le chemin inverse : d'une archive
// v1 (ADR 0008) vers un volume complet, sur une origine qui n'a jamais vu la source. OPFS étant
// cloisonné par origine, la seule chose qui traverse est l'archive — d'où l'exigence de la vérifier
// AVANT de toucher quoi que ce soit.
//
// L'ordre des gestes est le cœur de la décision (ADR 0009) ; il n'est pas négociable :
//
//   1. VÉRIFIER l'archive entière (empreinte de contenu recalculée + manifeste de #10) sans écrire
//      un seul octet. Une archive tronquée, altérée ou d'une autre application est refusée ici, et
//      la cible n'est même pas ouverte ;
//   2. REFUSER ce qui doit l'être avant la mutation : cible déjà occupée sans consentement
//      explicite, espace estimé insuffisant (diagnostics de #9) ;
//   3. RÉVOQUER le manifeste de la cible. C'est la première mutation, et elle va dans le sens de la
//      sûreté : dès l'instant où la restauration commence, le volume cesse d'être présenté comme
//      valide. Une interruption à n'importe quel moment laisse donc un volume SANS manifeste, que
//      `assertVolumeWritable` (#10) refuse par `VAULT_MANIFEST_UNIDENTIFIED` ;
//   4. RESTAURER le contenu octet pour octet, EN FLUX (surmémoire ≤ 64 Mio), puis franchir une
//      barrière de durabilité ;
//   5. RE-VÉRIFIER le volume restauré en le RELISANT depuis le support : l'empreinte recalculée doit
//      égaler celle de l'archive. Écrire n'est pas persister ; relire, si ;
//   6. INSCRIRE le manifeste. Seule cette dernière étape rend le volume présentable comme valide.
//
// Il n'existe donc pas de restauration partielle silencieuse : soit le volume est complet, relu et
// identifié, soit l'échec est typé et le volume reste non identifié.
//
// Le module est PUR de tout support : il reçoit une `source` (l'archive) et une `target` (le volume)
// injectées. Sous Node, ce sont des doubles déterministes ; dans le Worker, l'adaptateur OPFS de
// `opfs-import-target.mjs`. Ce qu'il ne fait PAS : migrer un format antérieur (#13, un manifeste
// antérieur est refusé en écriture par #10), déchiffrer ou authentifier l'archive (jalon 4), et
// transporter l'archive d'une origine à l'autre — ce transport est un geste de l'utilisateur.

import { createSha256Stream } from "./sha256-stream.mjs";
import { IMPORT_ERROR_CODES, ImportError } from "./import-errors.mjs";
import { readArchive } from "./volume-export.mjs";
import { assertVolumeName } from "./opfs-sync-access.mjs";
import { serializeManifest } from "./volume-manifest.mjs";

/** Bloc de streaming par défaut : identique à celui de l'export, très en deçà du budget de 64 Mio. */
export const DEFAULT_IMPORT_BLOCK_BYTES = 4 * 1024 * 1024;

/** Suffixe du manifeste posé À CÔTÉ du volume. Un volume est un flux de blocs ; son manifeste, non. */
export const MANIFEST_SIDECAR_SUFFIX = ".manifest";

/** Longueur maximale d'un nom de volume, imposée par `opfs-sync-access.mjs`. */
const MAX_VOLUME_NAME = 64;

/**
 * Nom du manifeste d'un volume. Il doit rester lui-même un nom de volume admissible : c'est un
 * fichier du même répertoire OPFS, soumis à la même validation de frontière.
 * @param {string} volume
 */
export function manifestSidecarName(volume) {
  assertVolumeName(volume);
  const nom = `${volume}${MANIFEST_SIDECAR_SUFFIX}`;
  if (nom.length > MAX_VOLUME_NAME) {
    throw new RangeError(
      `Nom de volume trop long pour porter un manifeste : « ${volume} » (${nom.length} > ${MAX_VOLUME_NAME}).`,
    );
  }
  return nom;
}

/** Refus typé de la restauration. */
function refus(code, message, context) {
  return new ImportError(code, message, context);
}

/** Valide les collaborateurs injectés. Une faute de programmation n'est pas un état de format. */
function assertContract({ source, target, blockBytes }) {
  if (!source || typeof source.read !== "function" || !Number.isInteger(source.byteLength)) {
    throw new TypeError("importArchive attend une source { byteLength, read(offset, length) }.");
  }
  for (const membre of ["inspect", "open", "revokeManifest", "commitManifest"]) {
    if (typeof target?.[membre] !== "function") {
      throw new TypeError(`importArchive attend une cible exposant « ${membre} ».`);
    }
  }
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) {
    throw new RangeError(`Taille de bloc invalide : ${blockBytes}.`);
  }
}

/**
 * Réserve l'espace auprès de la couche budget (#9), AVANT toute mutation. Un espace estimé
 * insuffisant est un refus typé ; une estimation indisponible est un état INCONNU, jamais une
 * capacité nulle — la restauration se poursuit et le diagnostic est rendu à l'appelant.
 */
async function reserverEspace(budget, volumeSize) {
  if (!budget || typeof budget.reserve !== "function") return null;
  const reservation = await budget.reserve(volumeSize);
  const rapport = {
    state: reservation.state,
    requiredBytes: reservation.requiredBytes ?? volumeSize,
    available: reservation.available ?? null,
    sufficient: reservation.sufficient ?? null,
    diagnostic: reservation.diagnostic ? reservation.diagnostic.toJSON() : null,
  };
  if (reservation.sufficient === false) {
    throw refus(
      IMPORT_ERROR_CODES.spaceInsufficient,
      `Restauration refusée : ${volumeSize} octet(s) sont nécessaires et l'espace estimé disponible est de ${reservation.available}. Aucune écriture n'est tentée.`,
      {
        requiredBytes: volumeSize,
        available: reservation.available,
        diagnostic: rapport.diagnostic,
      },
    );
  }
  return rapport;
}

/**
 * Refuse ce qui doit l'être AVANT toute mutation, en examinant la cible telle qu'elle est. Rend
 * `true` si la cible était occupée et que l'appelant a consenti à l'écraser.
 */
function refuserCible(etat, { overwrite, volumeSize }) {
  const occupee = etat.present === true && etat.size > 0;
  if (occupee && !overwrite) {
    throw refus(
      IMPORT_ERROR_CODES.targetNotEmpty,
      `Restauration refusée : la cible porte déjà un volume de ${etat.size} octet(s). Un écrasement exige un consentement explicite (« overwrite »).`,
      { targetSize: etat.size, volumeSize, identified: Boolean(etat.manifestBytes) },
    );
  }
  // Un volume existant n'est jamais RETAILLÉ, même avec consentement : ce serait détruire une
  // géométrie que #6 tient pour immuable. La restauration refuse et laisse l'exploitant retirer
  // explicitement la cible — elle ne supprime jamais de données de sa propre initiative.
  if (occupee && etat.size !== volumeSize) {
    throw refus(
      IMPORT_ERROR_CODES.geometryMismatch,
      `Restauration refusée : la cible porte un volume de ${etat.size} octet(s) et l'archive en décrit ${volumeSize}. Un volume existant n'est jamais retaillé ; retirer la cible explicitement avant de restaurer.`,
      { targetSize: etat.size, volumeSize },
    );
  }
  return occupee;
}

/**
 * Recopie le contenu de l'archive dans le volume, PAR BLOCS. Le contenu n'est jamais tenu en entier :
 * ni côté archive, ni côté volume. Rend les plus grandes tailles réellement demandées — la preuve
 * déterministe de la borne, plus fiable qu'une mesure de tas.
 */
async function recopier({ read, backend, contentOffset, volumeSize, blockBytes }) {
  const mesures = { maxWrite: 0, blocs: 0 };
  let offset = 0;
  while (offset < volumeSize) {
    const length = Math.min(blockBytes, volumeSize - offset);
    const bytes = await read(contentOffset + offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new TypeError(
        `Source d'archive incohérente : ${bytes?.byteLength} octet(s) rendus sur ${length} à l'offset ${contentOffset + offset}.`,
      );
    }
    await backend.write(offset, bytes);
    mesures.maxWrite = Math.max(mesures.maxWrite, length);
    mesures.blocs += 1;
    offset += length;
  }
  return mesures;
}

/**
 * RELIT le volume restauré depuis le support et recalcule son empreinte, en flux. Écrire n'est pas
 * persister : seule la relecture atteste que le support porte réellement les octets attendus.
 */
async function empreinteDuVolume({ backend, volumeSize, blockBytes }) {
  const hash = createSha256Stream();
  let maxRead = 0;
  let offset = 0;
  while (offset < volumeSize) {
    const length = Math.min(blockBytes, volumeSize - offset);
    maxRead = Math.max(maxRead, length);
    const bytes = await backend.read(offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new TypeError(
        `Relecture de volume incohérente : ${bytes?.byteLength} octet(s) rendus sur ${length} à l'offset ${offset}.`,
      );
    }
    hash.update(bytes);
    offset += length;
  }
  return { digest: hash.digestHex(), maxRead };
}

/**
 * Ouvre la cible, y recopie le contenu, franchit la barrière, puis RELIT tout le volume et confronte
 * son empreinte à celle de l'archive. Le handle exclusif est rendu quoi qu'il arrive. Un écart de
 * géométrie ou d'empreinte laisse la cible sans manifeste — donc non identifiée.
 */
async function restaurerEtRelire({ target, read, verdict, volumeSize, blockBytes }) {
  const backend = await target.open({ size: volumeSize });
  try {
    if (backend.size() !== volumeSize) {
      throw refus(
        IMPORT_ERROR_CODES.geometryMismatch,
        `Restauration refusée : la cible ouverte porte ${backend.size()} octet(s) alors que l'archive en décrit ${volumeSize}. Un volume n'est jamais retaillé en silence.`,
        { targetSize: backend.size(), volumeSize },
      );
    }
    const recopie = await recopier({
      read,
      backend,
      contentOffset: verdict.contentOffset,
      volumeSize,
      blockBytes,
    });
    await backend.flush();
    const relecture = await empreinteDuVolume({ backend, volumeSize, blockBytes });
    if (relecture.digest !== verdict.contentDigest) {
      throw refus(
        IMPORT_ERROR_CODES.verificationFailed,
        `Restauration refusée : le volume relu porte l'empreinte ${relecture.digest} au lieu de ${verdict.contentDigest}. Le volume n'est pas identifié et ne doit pas être présenté comme valide.`,
        { expected: verdict.contentDigest, observed: relecture.digest, volumeSize },
      );
    }
    return { recopie, relecture };
  } finally {
    await backend.close();
  }
}

/**
 * Restaure un volume depuis une archive v1. Vérifie avant toute mutation, refuse de façon typée, et
 * ne présente le volume comme valide qu'après l'avoir relu.
 *
 * @param {{
 *   source: { byteLength: number, read: (offset: number, length: number) => Promise<Uint8Array>|Uint8Array },
 *   target: {
 *     inspect: () => Promise<{ present: boolean, size: number, manifestBytes?: Uint8Array|null }>,
 *     open: (geometry: { size: number }) => Promise<object>,
 *     revokeManifest: () => Promise<void>,
 *     commitManifest: (bytes: Uint8Array) => Promise<void>,
 *   },
 *   expectations?: object,
 *   blockBytes?: number,
 *   overwrite?: boolean,
 *   budget?: { reserve: (bytes: number) => Promise<object> } | null,
 * }} args
 * @returns {Promise<object>} compte rendu de la restauration
 * @throws {import("./archive-errors.mjs").ArchiveError} archive malformée, tronquée, altérée
 * @throws {import("./manifest-errors.mjs").ManifestError} manifeste incompatible (propagée de #10)
 * @throws {ImportError} cible occupée, espace insuffisant, géométrie, re-vérification
 */
export async function importArchive({
  source,
  target,
  expectations = {},
  blockBytes = DEFAULT_IMPORT_BLOCK_BYTES,
  overwrite = false,
  budget = null,
}) {
  assertContract({ source, target, blockBytes });

  // Toutes les lectures d'archive passent par ce compteur : la plus grande d'entre elles est la
  // preuve DÉTERMINISTE que la restauration ne demande jamais l'archive entière d'un coup.
  const lectures = { max: 0 };
  const lire = (offset, length) => {
    lectures.max = Math.max(lectures.max, length);
    return source.read(offset, length);
  };

  // 1. VÉRIFIER — aucune mutation avant ce point. Les refus de #10 et #11 remontent tels quels.
  const verdict = await readArchive({
    read: lire,
    byteLength: source.byteLength,
    expectations,
    blockBytes,
  });
  const volumeSize = verdict.contentLength;

  // 2. REFUSER — la cible d'abord : on ne piétine jamais un volume sans consentement explicite.
  const occupee = refuserCible(await target.inspect(), { overwrite, volumeSize });
  const budgetRapport = await reserverEspace(budget, volumeSize);

  // 3. RÉVOQUER — première mutation : la cible cesse d'être présentée comme valide.
  await target.revokeManifest();

  // 4/5. RESTAURER puis RE-VÉRIFIER, sous handle exclusif.
  const { recopie, relecture } = await restaurerEtRelire({
    target,
    read: lire,
    verdict,
    volumeSize,
    blockBytes,
  });

  // 6. INSCRIRE — dernier geste, et seul à rendre le volume présentable comme valide.
  await target.commitManifest(serializeManifest(verdict.manifest));

  return {
    restored: true,
    overwritten: occupee,
    volumeSize,
    contentDigest: verdict.contentDigest,
    verifiedDigest: relecture.digest,
    manifest: verdict.manifest,
    archiveConsistency: verdict.consistency,
    archiveLength: verdict.archiveLength,
    blockBytes,
    maxSourceReadBytes: lectures.max,
    maxTargetWriteBytes: recopie.maxWrite,
    maxTargetReadBytes: relecture.maxRead,
    blocks: recopie.blocs,
    budget: budgetRapport,
  };
}
