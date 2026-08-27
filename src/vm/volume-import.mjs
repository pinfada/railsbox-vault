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
//      explicite, géométrie inconciliable, espace estimé insuffisant (diagnostics de #9) ;
//   3. OUVRIR la cible en exclusivité. Ouvrir un volume de géométrie inchangée ne mute rien, mais
//      l'ouverture peut échouer pour des raisons étrangères à la restauration — un autre onglet
//      détient l'exclusivité (#8), le support a perdu le handle, le quota refuse l'allocation. Elle
//      précède donc la révocation : sinon un volume PARFAITEMENT INTACT deviendrait inutilisable par
//      la seule faute du produit ;
//   4. RÉVOQUER le manifeste de la cible. C'est la première mutation, et elle va dans le sens de la
//      sûreté : avant le premier octet écrit, le volume cesse d'être présenté comme valide. Une
//      interruption au-delà de ce point laisse donc un volume SANS manifeste, que
//      `assertVolumeWritable` (#10) refuse par `VAULT_MANIFEST_UNIDENTIFIED` ;
//   5. RESTAURER le contenu octet pour octet, EN FLUX (surmémoire ≤ 64 Mio), puis franchir une
//      barrière de durabilité ;
//   6. RE-VÉRIFIER le volume restauré en le RELISANT depuis le support : l'empreinte recalculée doit
//      égaler celle de l'archive. Écrire n'est pas persister ; relire, si ;
//   7. INSCRIRE le manifeste. Seule cette dernière étape rend le volume présentable comme valide.
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
import { MANIFEST_SIDECAR_SUFFIX, manifestSidecarName } from "./opfs-sync-access.mjs";
import { parseManifest, serializeManifest } from "./volume-manifest.mjs";

/** Bloc de streaming par défaut : identique à celui de l'export, très en deçà du budget de 64 Mio. */
export const DEFAULT_IMPORT_BLOCK_BYTES = 4 * 1024 * 1024;

// Le nom du manifeste voisin appartient à la frontière de nommage du support : il est défini une
// fois, dans `opfs-sync-access.mjs`, et réexporté ici pour les appelants de la restauration.
export { MANIFEST_SIDECAR_SUFFIX, manifestSidecarName };

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
async function reserverEspace(budget, volumeSize, dejaOccupes = 0) {
  if (!budget || typeof budget.reserve !== "function") return null;
  // Le besoin est NET, pas brut : écraser sur place un volume de même géométrie ne consomme pas un
  // octet de plus. Réclamer la taille totale ferait refuser, pour espace insuffisant, une
  // restauration qui n'en demande aucun — un refus faux est aussi grave qu'une acceptation fausse.
  const besoin = Math.max(0, volumeSize - dejaOccupes);
  const reservation = await budget.reserve(besoin);
  const rapport = {
    state: reservation.state,
    requiredBytes: reservation.requiredBytes ?? besoin,
    available: reservation.available ?? null,
    sufficient: reservation.sufficient ?? null,
    diagnostic: reservation.diagnostic ? reservation.diagnostic.toJSON() : null,
  };
  if (reservation.sufficient === false) {
    throw refus(
      IMPORT_ERROR_CODES.spaceInsufficient,
      `Restauration refusée : ${besoin} octet(s) supplémentaires sont nécessaires pour un volume de ${volumeSize}, et l'espace estimé disponible est de ${reservation.available}. Aucune écriture n'est tentée.`,
      {
        requiredBytes: besoin,
        volumeSize,
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

  // Défense en profondeur sur le VOISIN. La frontière de nommage réserve déjà le suffixe
  // `.manifest`, mais un fichier antérieur à cette réserve — ou d'un autre outil — pourrait le
  // porter. La restauration ne le supprime pas pour se faire de la place : elle refuse. Détruire
  // sans consentement des octets qu'on ne comprend pas est exactement ce que l'ADR 0009 interdit.
  if (etat.manifestBytes) {
    try {
      parseManifest(etat.manifestBytes);
    } catch {
      throw refus(
        IMPORT_ERROR_CODES.targetNotEmpty,
        `Restauration refusée : la cible porte un voisin « ${MANIFEST_SIDECAR_SUFFIX} » qui n'est pas un manifeste Vault analysable. Il n'est pas supprimé ; l'écarter est un geste explicite.`,
        { targetSize: etat.size, volumeSize, identified: false, neighbourReadable: false },
      );
    }
  }

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
  // L'OUVERTURE PRÉCÈDE LA RÉVOCATION. Ouvrir un volume de géométrie inchangée ne mute rien ; en
  // revanche l'ouverture peut échouer pour des raisons qui n'ont rien à voir avec la restauration —
  // un second onglet détient le handle (#8), le support l'a perdu, le quota refuse l'allocation. Si
  // le manifeste avait déjà été retiré, un volume PARFAITEMENT INTACT deviendrait inutilisable par
  // la seule faute du produit. Après cette ligne, en revanche, la révocation doit précéder le
  // premier octet écrit.
  const backend = await target.open({ size: volumeSize });
  try {
    if (backend.size() !== volumeSize) {
      throw refus(
        IMPORT_ERROR_CODES.geometryMismatch,
        `Restauration refusée : la cible ouverte porte ${backend.size()} octet(s) alors que l'archive en décrit ${volumeSize}. Un volume n'est jamais retaillé en silence.`,
        { targetSize: backend.size(), volumeSize },
      );
    }
    // Première mutation : la cible cesse d'être présentée comme valide AVANT d'être touchée.
    await target.revokeManifest();
    // Puis, et SEULEMENT ensuite, le journal de génération du volume écrasé est écarté (#16). Il
    // décrit un volume qui n'existera plus dans un instant ; le laisser ferait rejouer, au premier
    // boot suivant, des octets qui n'appartiennent pas au volume restauré. L'ordre compte : entre
    // les deux gestes, le volume est déjà non identifié, donc refusé au boot.
    await target.discardGeneration();
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
 *   enforceCompatibility?: boolean,
 * }} args
 *   `enforceCompatibility` vaut `true` par défaut : la compatibilité du manifeste est contrôlée même
 *   sans `expectations`. Le passer à `false` est une DÉROGATION explicite, réservée au diagnostic —
 *   lire un conteneur qu'on ne saurait pas ouvrir en écriture.
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
  enforceCompatibility = true,
}) {
  assertContract({ source, target, blockBytes });

  // Toutes les lectures d'archive passent par ce compteur : la plus grande d'entre elles est la
  // preuve DÉTERMINISTE que la restauration ne demande jamais l'archive entière d'un coup.
  const lectures = { max: 0 };
  const lire = (offset, length) => {
    lectures.max = Math.max(lectures.max, length);
    return source.read(offset, length);
  };

  // 1. VÉRIFIER — aucune mutation avant ce point. Les refus de #10 et #11 remontent tels quels, et
  //    la compatibilité du manifeste est contrôlée par défaut (`enforceCompatibility`).
  const verdict = await readArchive({
    read: lire,
    byteLength: source.byteLength,
    expectations,
    blockBytes,
    enforceCompatibility,
  });
  const volumeSize = verdict.contentLength;

  // 2. REFUSER — la cible d'abord : on ne piétine jamais un volume sans consentement explicite.
  const etat = await target.inspect();
  const occupee = refuserCible(etat, { overwrite, volumeSize });
  const budgetRapport = await reserverEspace(budget, volumeSize, occupee ? etat.size : 0);

  // 3/4/5/6. OUVRIR, RÉVOQUER, RESTAURER puis RE-VÉRIFIER, sous handle exclusif.
  const { recopie, relecture } = await restaurerEtRelire({
    target,
    read: lire,
    verdict,
    volumeSize,
    blockBytes,
  });

  // 7. INSCRIRE — dernier geste, et seul à rendre le volume présentable comme valide.
  await target.commitManifest(serializeManifest(verdict.manifest));

  return rapportDeRestauration({
    verdict,
    volumeSize,
    occupee,
    blockBytes,
    lectures,
    recopie,
    relecture,
    budgetRapport,
  });
}

/** Compte rendu d'une restauration réussie. Extrait pour que l'orchestration reste lisible d'un œil. */
function rapportDeRestauration({
  verdict,
  volumeSize,
  occupee,
  blockBytes,
  lectures,
  recopie,
  relecture,
  budgetRapport,
}) {
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
