// OUVERTURE EN ÉCRITURE d'un volume OPFS (#12, `SEC-UPDATE-001`).
//
// `assertVolumeWritable` existe depuis le manifeste (#10) et `SECURITY.md` en fait un invariant :
// « jamais d'écriture sur un support non identifié ». Jusqu'ici, pourtant, AUCUN chemin de
// production ne l'appelait — la règle vivait dans les documents et pas dans le code. Ce module la
// rend vraie. La règle EXACTE, telle que le code la tient, est la suivante :
//
//  - un volume IDENTIFIÉ ne s'ouvre en écriture que par `openVolumeForWrite`. Le boot y passe, et un
//    volume sans manifeste y est refusé par `VAULT_MANIFEST_UNIDENTIFIED` AVANT que v86 ne soit
//    construit ;
//  - un volume ANONYME n'est ouvrable que par le chemin qui va précisément l'identifier — la
//    préparation depuis l'image de référence, la restauration — et il reste refusé au boot tant que
//    son manifeste n'est pas inscrit ;
//  - les bancs #4/#14/#6 et les phases de mesure (export, empreinte) n'ouvrent aucun volume
//    applicatif : ils éprouvent ou lisent la couche blocs, et ne sont pas concernés.
//
// Ce qu'il ne faut PAS lire ici : « plus personne n'appelle `openOpfsVolume` ». C'est faux, et
// treize appels directs subsistent en production, énumérés et justifiés dans l'ADR 0009. Rien dans
// l'outillage n'empêche un nouveau chemin d'en ajouter un sans passer par cet ouvreur : c'est une
// DISCIPLINE DE REVUE, pas une contrainte du code. Une contrainte réelle supposerait de fermer
// `openOpfsVolume` derrière un module privé — c'est du travail découvert, pas ce que fait #12.
//
// La conséquence est celle que #12 promet : une restauration interrompue laisse un volume SANS
// manifeste voisin, et le boot suivant est refusé par `VAULT_MANIFEST_UNIDENTIFIED` — avant que v86
// ne démarre, avant que Rails ne monte un système de fichiers tronqué. Sans cet ouvreur, « jamais de
// restauration partielle silencieuse » n'aurait été qu'une phrase.
//
// Politique de TRANSITION, explicite : il n'y en a pas. Un volume sans manifeste est refusé en
// écriture, sans période de tolérance ni manifeste fabriqué à la volée — inventer une identité pour
// un volume qu'on ne connaît pas serait exactement l'écriture non identifiée que l'invariant refuse.
// Aucun format n'ayant été publié (série 0.x, `docs/release-policy.md`), aucun volume d'utilisateur
// n'est concerné ; les volumes que le dépôt fabrique lui-même reçoivent leur manifeste à la création.
//
// Les primitives de support sont injectables pour que la règle soit éprouvable sous Node, où il n'y
// a ni OPFS ni Worker dédié.

import { BlockJournal } from "./block-journal.mjs";
import { openOpfsVolume } from "./opfs-block-backend.mjs";
import {
  manifestSidecarName,
  openOpfsSyncAccess,
  removeOpfsVolume,
  statOpfsVolume,
} from "./opfs-sync-access.mjs";
import { MANIFEST_ERROR_CODES, ManifestError } from "./manifest-errors.mjs";
import { assertVolumeWritable, serializeManifest } from "./volume-manifest.mjs";

/**
 * Plafond de lecture du manifeste voisin. Un manifeste v1 tient en quelques centaines d'octets ; le
 * même plafond que l'en-tête d'archive (#11) laisse une marge confortable. Au-delà, ce n'est pas un
 * manifeste : le lire allouerait autant d'octets que le support en annonce, ce que le budget de
 * surmémoire interdit — poser une question ne doit pas coûter un gigaoctet.
 */
export const MAX_SIDECAR_BYTES = 1024 * 1024;

/** Lit intégralement un petit fichier OPFS. */
async function lireFichierOpfs(nom, taille) {
  const handle = await openOpfsSyncAccess(nom);
  try {
    const bytes = new Uint8Array(taille);
    const lus = handle.read(bytes, { at: 0 });
    return lus === taille ? bytes : bytes.subarray(0, lus);
  } finally {
    handle.close();
  }
}

/** Écrit intégralement un petit fichier OPFS, en le remplaçant, et franchit sa barrière. */
export async function writeSidecarBytes(nom, bytes) {
  const handle = await openOpfsSyncAccess(nom);
  try {
    handle.truncate(0);
    const ecrits = handle.write(bytes, { at: 0 });
    if (ecrits !== bytes.byteLength) {
      throw new Error(`Écriture de manifeste courte : ${ecrits}/${bytes.byteLength} octet(s).`);
    }
    handle.flush();
  } finally {
    handle.close();
  }
}

/**
 * Rend les OCTETS du manifeste voisin d'un volume, ou `null` s'il n'y en a pas. Un voisin démesuré
 * n'est pas lu : il est traité comme absent d'un manifeste plausible, et l'appelant refusera.
 *
 * @param {string} volume
 * @param {{ stat?: Function, readFile?: Function }} [primitives]
 * @returns {Promise<Uint8Array|null>}
 */
export async function readVolumeManifest(
  volume,
  { stat = statOpfsVolume, readFile = lireFichierOpfs } = {},
) {
  const sidecar = manifestSidecarName(volume);
  const etat = await stat(sidecar);
  if (!etat.present || etat.size === 0) return null;
  if (etat.size > MAX_SIDECAR_BYTES) {
    throw new ManifestError(
      MANIFEST_ERROR_CODES.malformed,
      `Manifeste malformé : le voisin du volume « ${volume} » annonce ${etat.size} octet(s), au-delà du plafond de ${MAX_SIDECAR_BYTES}. Il n'est pas lu.`,
      { volume, size: etat.size, maxBytes: MAX_SIDECAR_BYTES },
    );
  }
  return readFile(sidecar, etat.size);
}

/** Inscrit le manifeste voisin d'un volume. Dernier geste d'une création ou d'une restauration. */
export async function writeVolumeManifest(
  volume,
  manifest,
  { writeFile = writeSidecarBytes } = {},
) {
  await writeFile(manifestSidecarName(volume), serializeManifest(manifest));
}

/** Retire le manifeste voisin : le volume cesse d'être identifié, donc d'être inscriptible. */
export async function revokeVolumeManifest(volume, { removeFile = removeOpfsVolume } = {}) {
  return removeFile(manifestSidecarName(volume));
}

/**
 * Ouvre un volume EN ÉCRITURE, et seulement s'il est identifié et compatible.
 *
 * L'ordre compte : le manifeste est lu et jugé AVANT toute ouverture. Un refus ne doit pas laisser
 * derrière lui un fichier créé, un handle pris ou une géométrie allouée.
 *
 * @param {{ name: string, size?: number, journal?: BlockJournal, expectations?: object,
 *           stat?: Function, readFile?: Function, openVolume?: Function }} args
 * @returns {Promise<import("./opfs-block-backend.mjs").OpfsBlockBackend>}
 * @throws {ManifestError} `VAULT_MANIFEST_UNIDENTIFIED` sans manifeste voisin, ou tout refus de
 *   compatibilité de #10, propagé tel quel.
 */
export async function openVolumeForWrite({
  name,
  size,
  journal = new BlockJournal(),
  expectations = {},
  stat = statOpfsVolume,
  readFile = lireFichierOpfs,
  openVolume = openOpfsVolume,
}) {
  const manifestBytes = await readVolumeManifest(name, { stat, readFile });
  // `assertVolumeWritable` refuse un volume sans manifeste, malformé, d'un format futur, d'une autre
  // application ou écrit par un runtime majeur plus récent. Il lève AVANT l'ouverture.
  assertVolumeWritable({ manifestBytes, expectations });
  return openVolume({ name, size, journal });
}
