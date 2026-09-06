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
//   7. POSER L'ENVELOPPE DE RÉCUPÉRATION que l'archive emporte (#149, ADR 0027), ou RETIRER celle
//      que la cible portait. Elle vient APRÈS le contenu et AVANT le manifeste, et cet ordre est une
//      décision : le manifeste est ce qui DÉCLARE le volume complet, et un volume déclaré complet
//      sans son enveloppe serait un volume que personne n'ouvre — le sinistre même que la tranche
//      referme. Une coupure entre 6 et 7 laisse un volume non identifié, que le boot refuse ;
//   8. INSCRIRE le manifeste. Seule cette dernière étape rend le volume présentable comme valide.
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
import { consentementNomme } from "./migration-backup-proof.mjs";
import { exigerEnveloppeDeRecuperationSeule } from "./enveloppe-de-recuperation.mjs";
import { readArchive } from "./volume-export.mjs";
import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";
import {
  EN_TETE_OCTETS,
  decoderEnTeteV3,
  identifiantVolumeEnTexte,
} from "./volume-chiffre-format.mjs";
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
  for (const membre of [
    "inspect",
    "open",
    "revokeManifest",
    "commitRecoveryEnvelope",
    "commitManifest",
  ]) {
    if (typeof target?.[membre] !== "function") {
      throw new TypeError(`importArchive attend une cible exposant « ${membre} ».`);
    }
  }
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) {
    throw new RangeError(`Taille de bloc invalide : ${blockBytes}.`);
  }
}

/**
 * Instrumente les lectures d'archive d'un compteur de la plus grande taille demandée. Extrait pour
 * que la BORNE et son témoin naissent au même endroit : la lecture instrumentée et le compteur
 * qu'elle alimente ne peuvent plus être branchés l'un sans l'autre.
 */
function compteurDeLectures(source) {
  // Toutes les lectures d'archive passent par ce compteur : la plus grande d'entre elles est la
  // preuve DÉTERMINISTE que la restauration ne demande jamais l'archive entière d'un coup.
  const lectures = { max: 0 };
  const lire = (offset, length) => {
    lectures.max = Math.max(lectures.max, length);
    return source.read(offset, length);
  };
  return { lectures, lire };
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
 * Étape 2 de l'ADR 0009 : REFUSER tout ce qui doit l'être avant la moindre mutation. Extrait parce
 * que ces deux refus se tiennent : l'état observé de la cible décide du refus d'écrasement ET du
 * BESOIN NET soumis au budget. Les séparer inviterait à réclamer un espace brut que l'écrasement
 * d'un volume de même géométrie ne consomme pas.
 */
async function refuserAvantMutation({ target, volumeSize, overwrite, budget }) {
  const etat = await target.inspect();
  const occupee = refuserCible(etat, { overwrite, volumeSize });
  const budgetRapport = await reserverEspace(budget, volumeSize, occupee ? etat.size : 0);
  return { occupee, budgetRapport };
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
 *     commitRecoveryEnvelope: (bytes: Uint8Array|null) => Promise<void>,
 *     commitManifest: (bytes: Uint8Array) => Promise<void>,
 *   },
 *   expectations?: object,
 *   blockBytes?: number,
 *   overwrite?: boolean,
 *   versionMinimale?: number | null,
 *   consent?: { acknowledgedBy: string, reason?: string } | null,
 *   budget?: { reserve: (bytes: number) => Promise<object> } | null,
 *   enforceCompatibility?: boolean,
 * }} args
 *   `versionMinimale` est la version d'enveloppe que l'utilisateur tient sur sa FEUILLE de
 *   recuperation (#149, ADR 0027, decision 3). Une archive dont l'enveloppe est anterieure exige
 *   alors un `consent` NOMME ; sans feuille, rien n'est exige et rien n'est promis.
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
  versionMinimale = null,
  consent = null,
  budget = null,
  enforceCompatibility = true,
}) {
  assertContract({ source, target, blockBytes });
  const { lectures, lire } = compteurDeLectures(source);

  // 1 et 2. VÉRIFIER, puis REFUSER. Aucune mutation avant ce point.
  const { verdict, volumeSize, avantMutation, consentement } = await verifierPuisRefuser({
    source,
    target,
    read: lire,
    expectations,
    blockBytes,
    overwrite,
    versionMinimale,
    consent,
    budget,
    enforceCompatibility,
  });

  // 3/4/5/6. OUVRIR, RÉVOQUER, RESTAURER puis RE-VÉRIFIER, sous handle exclusif.
  const mesures = await restaurerEtRelire({ target, read: lire, verdict, volumeSize, blockBytes });

  // 7/8. POSER l'enveloppe, puis INSCRIRE le manifeste. Dans cet ordre, et pas l'autre.
  await poserLEnveloppePuisLeManifeste(target, verdict);

  return rapportDeRestauration({
    verdict,
    volumeSize,
    blockBytes,
    lectures,
    mesures,
    avantMutation,
    consentement,
  });
}

/**
 * GESTES 1 et 2 — VÉRIFIER l'archive entière, puis REFUSER tout ce qui doit l'être avant la moindre
 * mutation : cible occupée sans consentement, géométrie inconciliable, espace insuffisant, et —
 * depuis #149 — archive antérieure à la feuille de récupération sans consentement nommé.
 *
 * Les deux gestes vivent ensemble parce qu'ils partagent une seule règle, celle de l'ADR 0009 :
 * rien n'est écrit tant qu'ils n'ont pas rendu leur verdict. Après cette fonction, la restauration
 * mute ; avant elle, elle n'a rien fait.
 */
async function verifierPuisRefuser({
  source,
  target,
  read,
  expectations,
  blockBytes,
  overwrite,
  versionMinimale,
  consent,
  budget,
  enforceCompatibility,
}) {
  // Les refus de #10 et #11 remontent tels quels, et la compatibilité du manifeste est contrôlée
  // par défaut (`enforceCompatibility`).
  const verdict = await verifierArchiveEtIdentite({
    read,
    byteLength: source.byteLength,
    expectations,
    blockBytes,
    enforceCompatibility,
  });
  const volumeSize = verdict.contentLength;
  // La CIBLE d'abord : on ne piétine jamais un volume sans consentement explicite. L'ANCRE ensuite.
  const avantMutation = await refuserAvantMutation({ target, volumeSize, overwrite, budget });
  const consentement = exigerLAncre({ verdict, versionMinimale, consent });
  return { verdict, volumeSize, avantMutation, consentement };
}

/**
 * GESTES 7 et 8 — POSER l'enveloppe de récupération (ou retirer celle de la cible écrasée), PUIS
 * inscrire le manifeste.
 *
 * Les deux vivent dans la même fonction parce que c'est leur ORDRE qui est la décision, et qu'un
 * ordre ne se garde pas quand ses deux moitiés sont appelées de loin. Le manifeste est ce qui
 * DÉCLARE le volume complet ; l'enveloppe est ce qui le rend OUVRABLE. Les inverser laisserait,
 * pendant une coupure, un volume présenté comme valide que personne n'ouvre — le sinistre même que
 * l'ADR 0027 referme. Coupé entre les deux, le volume est non identifié, donc refusé au boot : le
 * seul état sûr des deux.
 */
async function poserLEnveloppePuisLeManifeste(target, verdict) {
  await target.commitRecoveryEnvelope(verdict.recovery === null ? null : verdict.recovery.octets);
  await target.commitManifest(serializeManifest(verdict.manifest));
}

/**
 * L'ANCRE : confronte la version de l'enveloppe embarquée à celle que porte la FEUILLE de
 * récupération, et exige un CONSENTEMENT NOMMÉ quand l'archive est antérieure (ADR 0027, décision 3).
 *
 * ## Pourquoi un consentement, et pas un refus
 *
 * Une archive est ANTÉRIEURE par nature — c'est ce qu'on attend d'une sauvegarde. La refuser rendrait
 * inutilisable toute sauvegarde prise avant la dernière révocation, c'est-à-dire à peu près toutes.
 * L'accepter en silence rétablirait une enveloppe où une clé révoquée depuis peut être encore
 * valable, sans que personne ne l'ait dit. Le consentement nommé de l'ADR 0011 est exactement
 * l'instrument de ce choix-là : il n'interdit rien, il exige qu'un exploitant identifié assume, et
 * le rapport le porte.
 *
 * ## Sans feuille, rien n'est exigé — et rien n'est promis
 *
 * `versionMinimale: null` est le cas de qui n'a pas noté la version. La restauration passe, et
 * l'aveu est écrit ici comme dans l'ADR : sans ancre tenue hors du fichier, un retour arrière n'est
 * pas détecté. Une archive SANS enveloppe échappe elle aussi à la règle — elle ne rétablit aucune
 * clé, donc elle ne ressuscite rien.
 */
function exigerLAncre({ verdict, versionMinimale, consent }) {
  const consentement = consentementNomme(consent);
  if (versionMinimale === null || verdict.recovery === null) return consentement;
  if (!Number.isInteger(versionMinimale) || versionMinimale < 1) {
    throw new TypeError(
      `« versionMinimale » est la version notée sur la feuille de récupération : un entier ≥ 1, reçu ${JSON.stringify(versionMinimale)}.`,
    );
  }
  const embarquee = verdict.recovery.envelopeVersion;
  if (embarquee >= versionMinimale || consentement !== null) return consentement;
  throw refus(
    IMPORT_ERROR_CODES.consentementRequis,
    `Restauration refusée : cette sauvegarde porte l'enveloppe en version ${embarquee}, et votre feuille de récupération en note ${versionMinimale}. Elle date donc d'AVANT votre dernière révocation : une clé révoquée depuis pourrait y être encore valable. Restaurer reste possible, et demande un consentement nommé ; après quoi la version ${embarquee} devient la nouvelle référence, et la feuille est à re-noter.`,
    { envelopeVersion: embarquee, versionMinimale },
  );
}

/**
 * GESTE 1 — VÉRIFIER l'archive, puis confronter l'identité qu'elle déclare à celle qu'elle porte.
 *
 * Les deux contrôles vont ensemble parce qu'ils ont la même règle : rien n'est écrit tant qu'ils
 * n'ont pas rendu leur verdict (ADR 0009, « vérifier avant d'écrire »).
 */
async function verifierArchiveEtIdentite(options) {
  const verdict = await readArchive(options);
  await assertIdentiteDeLArchive({
    verdict,
    read: options.read,
    volumeSize: verdict.contentLength,
  });
  assertEnveloppeEmbarquee(verdict);
  return verdict;
}

/**
 * EXIGE que la section de récupération soit une enveloppe de RÉCUPÉRATION SEULE, et que l'en-tête
 * dise d'elle la vérité (#149, ADR 0027).
 *
 * Le contrôle vit ICI, dans le geste de vérification, et non au moment d'écrire le voisin : l'ADR
 * 0009 pose « vérifier avant d'écrire », et une archive dont la page embarquée porterait une phrase
 * secrète doit être refusée alors que la cible n'a pas même été ouverte.
 *
 * L'en-tête est CONFRONTÉ à la page, pas cru : une archive qui déclarerait une version d'enveloppe
 * plus récente que celle qu'elle porte tromperait l'ancre de la décision 3, c'est-à-dire ferait
 * accepter sans consentement une sauvegarde antérieure à la feuille.
 */
function assertEnveloppeEmbarquee(verdict) {
  if (verdict.recovery === null) return;
  const page = exigerEnveloppeDeRecuperationSeule(verdict.recovery.octets);
  const declare = {
    envelopeVersion: verdict.recovery.envelopeVersion,
    slots: verdict.recovery.slots,
  };
  const porte = { envelopeVersion: page.version, slots: page.emplacements };
  if (declare.envelopeVersion === porte.envelopeVersion && declare.slots === porte.slots) return;
  throw new ArchiveError(
    ARCHIVE_ERROR_CODES.recuperationRefusee,
    `Restauration refusée : l'en-tête déclare une enveloppe en version ${declare.envelopeVersion} portant ${declare.slots} emplacement(s), et la page embarquée en porte ${porte.slots} en version ${porte.envelopeVersion}. Aucun octet n'est écrit sur la cible.`,
    { declare, porte },
  );
}

/**
 * CONFRONTE l'identifiant que le manifeste de l'archive DÉCLARE à celui que son fichier PORTE.
 *
 * L'ADR 0009 pose la règle : « vérifier avant d'écrire ». Une archive dont le manifeste annonce un
 * identifiant et dont l'en-tête v3 en porte un autre passait toute la restauration — vérification
 * d'empreinte comprise, puisque l'empreinte porte sur les octets, pas sur leur cohérence avec le
 * manifeste. Le volume restauré était alors refusé À L'OUVERTURE par
 * `VAULT_STORAGE_IDENTITE_VOLUME`, c'est-à-dire après que la cible eut été écrasée. Le refus est
 * juste ; son MOMENT ne l'était pas.
 *
 * Le contrôle ne porte que sur les formats qui ont un en-tête : avant v3 il n'y a rien à confronter.
 */
async function assertIdentiteDeLArchive({ verdict, read, volumeSize }) {
  const declare = verdict.manifest.volume?.id;
  if (declare === undefined || declare === null) return;
  if (volumeSize < EN_TETE_OCTETS) return;

  const enTete = await read(verdict.contentOffset, EN_TETE_OCTETS);
  const lu = decoderEnTeteV3(enTete);
  if (!lu.valide) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.malformed,
      `Restauration refusée : le manifeste de l'archive déclare un volume chiffré (${declare}) et son contenu ne porte pas d'en-tête v3 lisible (${lu.raison}). Aucun octet n'est écrit sur la cible.`,
      { declare, raison: lu.raison },
    );
  }
  const porte = identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
  if (porte === declare) return;
  throw new ArchiveError(
    ARCHIVE_ERROR_CODES.malformed,
    `Restauration refusée : le manifeste de l'archive déclare le volume ${declare} et le fichier qu'elle porte en déclare un autre (${porte}). Restaurer produirait un volume que son propre manifeste ferait refuser à l'ouverture. Aucun octet n'est écrit sur la cible.`,
    { declare, porte },
  );
}

/** Compte rendu d'une restauration réussie. Extrait pour que l'orchestration reste lisible d'un œil. */
function rapportDeRestauration({
  verdict,
  volumeSize,
  blockBytes,
  lectures,
  mesures,
  avantMutation,
  consentement,
}) {
  const { recopie, relecture } = mesures;
  return {
    restored: true,
    overwritten: avantMutation.occupee,
    volumeSize,
    contentDigest: verdict.contentDigest,
    // L'enveloppe posée, SANS ses octets : le rapport franchit `postMessage` et va dans un journal.
    recovery:
      verdict.recovery === null
        ? null
        : {
            length: verdict.recovery.length,
            digest: verdict.recovery.digest,
            envelopeVersion: verdict.recovery.envelopeVersion,
            slots: verdict.recovery.slots,
          },
    // La version que la feuille de récupération doit désormais porter. `null` quand l'archive
    // n'emporte aucune enveloppe : il n'y a alors rien à noter, et rien à ouvrir ailleurs.
    nouvelleReference: verdict.recovery === null ? null : verdict.recovery.envelopeVersion,
    consentement,
    verifiedDigest: relecture.digest,
    manifest: verdict.manifest,
    archiveConsistency: verdict.consistency,
    archiveLength: verdict.archiveLength,
    blockBytes,
    maxSourceReadBytes: lectures.max,
    maxTargetWriteBytes: recopie.maxWrite,
    maxTargetReadBytes: relecture.maxRead,
    blocks: recopie.blocs,
    budget: avantMutation.budgetRapport,
  };
}
