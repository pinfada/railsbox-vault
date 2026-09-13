// SAUVEGARDER, RESTAURER, RÉVOQUER depuis la coquille : les DÉCISIONS (#207, ADR 0039).
//
// Le Worker de confiance ne fait qu'appeler ce module (`public/portabilite-du-worker.mjs`). Tout ce
// qui tranche — dans quel état se trouve l'emplacement, ce qu'un geste exige, ce qu'une révocation a
// retiré — est ici, en fonctions pures dont les primitives de support sont INJECTÉES : c'est ce qui
// les rend mutables par `tools/muter-gardes-coquille.mjs` sans navigateur, pour le motif exact des
// gardes de #161.
//
// ## Ce que ce module ne fait pas
//
// Il n'écrit, ne lit ni ne chiffre aucun octet de volume. L'archive est écrite par `writeArchive`,
// vérifiée et versée par `importArchive`, la révocation faite par `revoquerToutSauf` : `src/vm/` est
// APPELÉ, jamais réécrit. Ce module décide seulement quand ils sont appelés, et ce qui en est dit.

import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { TYPES_PRIVILEGIES } from "./contrat-de-messages.mjs";
import { IDENTIFIANT_DU_COFFRE, VOLUME_DE_LA_COQUILLE } from "./identites-du-coffre.mjs";
import { NOM_DU_VOLUME_APPLICATIF } from "./application-de-reference.mjs";
import { MOYENS_SERVIS } from "./moyens-de-deverrouillage.mjs";
import { OCTET_DOMAINE_RECUPERATION } from "../vm/enveloppe/cle-de-racine.mjs";
import { PAGE_OCTETS, decoderPage } from "../vm/enveloppe/fichier-enveloppe.mjs";
import {
  ARCHIVE_MAGIC,
  CONSISTENCY_KINDS,
  PREAMBLE_BYTES,
  hasArchiveMagic,
} from "../vm/volume-export.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_COURANT,
  decoderEnTeteDeVolume,
  identifiantVolumeEnTexte,
} from "../vm/volume-chiffre-format.mjs";
import { enveloppeSidecarName, manifestSidecarName } from "../vm/opfs-sync-access.mjs";
import { parseManifest } from "../vm/volume-manifest.mjs";

/** Le voisin qui porte l'enveloppe du coffre. Le Worker de confiance le lit, et nul autre. */
export const ENVELOPPE_DU_COFFRE = enveloppeSidecarName(VOLUME_DE_LA_COQUILLE);

/** Le nom du fichier OPFS où la sauvegarde s'écrit avant d'être rendue à la page. */
export const FICHIER_DE_SAUVEGARDE = "coquille-sauvegarde";

/**
 * Les ÉTATS d'un emplacement, tels que la coquille les constate AVANT tout geste de portabilité ou
 * de déverrouillage. Quatre, et rien entre eux.
 */
export const ETATS_DE_L_EMPLACEMENT = Object.freeze({
  /** Rien : ni enveloppe, ni volume `application`, ni volume `coquille`. On peut restaurer. */
  vide: "vide",
  /** Un coffre de cette version : il s'ouvre, il se sauvegarde, on ne restaure pas par-dessus. */
  coffre: "coffre",
  /** Un coffre créé avant l'ADR 0039, sous deux identités. Refusé, jamais migré. */
  anterieur: "anterieur",
  /** Une restauration COUPÉE : le disque est là, le coffre n'est pas né. Le même geste répare. */
  restaurationInterrompue: "restauration-interrompue",
});

/**
 * La COHÉRENCE que la sauvegarde déclare, et le point de contrôle qui la tient (ADR 0039, déc. 3).
 *
 * L'archive est lue sous le handle EXCLUSIF, APRÈS que l'application a été arrêtée — la machine
 * virtuelle éteinte, l'instantané capturé, le volume fermé par `close()` qui attend toute E/S déjà
 * acceptée — et après que `ouvrirPourExport` a rejoué la dernière génération validée. Aucune
 * écriture de Rails n'est en vol : c'est le point, et `handle-exclusif` est ce qu'il garantit.
 */
export const COHERENCE_DE_LA_SAUVEGARDE = Object.freeze({
  kind: CONSISTENCY_KINDS.exclusiveHandle,
  detail:
    "application arrêtée (VM éteinte, volume fermé), dernière génération rejouée, lecture sous le handle OPFS exclusif du Worker de confiance",
});

/**
 * CONSTATE l'état de l'emplacement, sans rien créer ni rien écrire.
 *
 * @param {{ observer: (nom: string) => Promise<{ present: boolean }>,
 *           lireEnTete: (nom: string) => Promise<Uint8Array | null>,
 *           lireVoisin: (nom: string) => Promise<Uint8Array | null> }} primitives
 * @returns {Promise<string>} une valeur de `ETATS_DE_L_EMPLACEMENT`
 */
export async function constaterLEmplacement({ observer, lireEnTete, lireVoisin }) {
  const enveloppe = (await observer(ENVELOPPE_DU_COFFRE)).present;
  const disque = (await observer(NOM_DU_VOLUME_APPLICATIF)).present;
  const coquille = (await observer(VOLUME_DE_LA_COQUILLE)).present;
  const manifeste = await manifesteLisible(lireVoisin);

  if (coquille && (await volumeCoquilleAnterieur(lireEnTete)))
    return ETATS_DE_L_EMPLACEMENT.anterieur;
  if (manifeste !== null && manifeste.volume?.id !== IDENTIFIANT_DU_COFFRE) {
    return ETATS_DE_L_EMPLACEMENT.anterieur;
  }
  if (manifeste !== null) return ETATS_DE_L_EMPLACEMENT.coffre;
  if (!enveloppe) {
    return disque || coquille
      ? ETATS_DE_L_EMPLACEMENT.restaurationInterrompue
      : ETATS_DE_L_EMPLACEMENT.vide;
  }
  if (disque && (await enveloppeRestaureeIntacte(lireVoisin))) {
    return ETATS_DE_L_EMPLACEMENT.restaurationInterrompue;
  }
  return ETATS_DE_L_EMPLACEMENT.coffre;
}

/** Le manifeste du volume `application`, analysé, ou `null` s'il est absent ou illisible. */
async function manifesteLisible(lireVoisin) {
  const octets = await lireVoisin(manifestSidecarName(NOM_DU_VOLUME_APPLICATIF));
  if (octets === null) return null;
  try {
    return parseManifest(octets);
  } catch {
    return null;
  }
}

/**
 * Le volume `coquille` porte-t-il ENCORE l'identité du coffre dans son en-tête ?
 *
 * C'est la signature d'un coffre créé avant l'ADR 0039 : le petit volume y naissait sous la constante
 * qui est désormais celle du coffre. Un en-tête illisible ne conclut rien — l'ouverture le refusera
 * sous son propre code, et ce module ne devine pas.
 */
async function volumeCoquilleAnterieur(lireEnTete) {
  const octets = await lireEnTete(VOLUME_DE_LA_COQUILLE);
  if (octets === null || octets.byteLength < EN_TETE_OCTETS) return false;
  const lu = decoderEnTeteDeVolume(octets.subarray(0, EN_TETE_OCTETS), {
    formatVersion: FORMAT_VOLUME_COURANT,
  });
  return (
    lu.valide && identifiantVolumeEnTexte(lu.enTete.identifiantVolume) === IDENTIFIANT_DU_COFFRE
  );
}

/**
 * L'enveloppe du coffre est-elle ENCORE la page qu'une restauration a posée, jamais mutée ?
 *
 * La restauration écrit la page de l'archive — domaine `recuperation` — AVANT le manifeste. Toute
 * mutation ultérieure (créer un moyen, révoquer) réécrit une page du domaine `enveloppe`. Une page
 * `recuperation` à côté d'un disque sans manifeste ne peut donc venir que d'une restauration coupée.
 */
async function enveloppeRestaureeIntacte(lireVoisin) {
  const octets = await lireVoisin(ENVELOPPE_DU_COFFRE);
  if (octets === null || octets.byteLength < PAGE_OCTETS) return false;
  const lue = decoderPage(octets.subarray(0, PAGE_OCTETS));
  return lue.valide && lue.page.domaine === OCTET_DOMAINE_RECUPERATION;
}

/**
 * Le refus qu'un DÉVERROUILLAGE ou un INVENTAIRE doit rendre sur cet état, ou `null`.
 *
 * @param {string} etat
 * @returns {string | null}
 */
export function refusDOuverture(etat) {
  if (etat === ETATS_DE_L_EMPLACEMENT.anterieur) return CODES_REFUS_COQUILLE.coffreAnterieur;
  if (etat === ETATS_DE_L_EMPLACEMENT.restaurationInterrompue) {
    return CODES_REFUS_COQUILLE.restaurationInterrompue;
  }
  return null;
}

/**
 * Ce qu'une RESTAURATION fait de cet état : refuser, restaurer, ou réparer puis restaurer.
 *
 * @param {string} etat
 * @returns {{ code: string | null, reparer: boolean }}
 */
export function decisionDeRestauration(etat) {
  if (etat === ETATS_DE_L_EMPLACEMENT.vide) return { code: null, reparer: false };
  if (etat === ETATS_DE_L_EMPLACEMENT.restaurationInterrompue) return { code: null, reparer: true };
  if (etat === ETATS_DE_L_EMPLACEMENT.anterieur) {
    return { code: CODES_REFUS_COQUILLE.coffreAnterieur, reparer: false };
  }
  return { code: CODES_REFUS_COQUILLE.emplacementOccupe, reparer: false };
}

/** Les trois gestes de cette tranche. Aucun n'est admis ailleurs que sur le canal privilégié. */
export const GESTES_DE_PORTABILITE = Object.freeze(
  new Set([
    TYPES_PRIVILEGIES.sauvegarder,
    TYPES_PRIVILEGIES.restaurer,
    TYPES_PRIVILEGIES.revoquerEnUrgence,
  ]),
);

/**
 * Les gestes LONGS : ceux pendant lesquels un geste de portabilité est refusé, pas mis en attente.
 * Les deux gestes de portabilité qui battent en font partie — une sauvegarde pendant une
 * restauration n'a pas de sens, et une seconde sauvegarde écraserait le fichier de la première.
 */
export const GESTES_LONGS = Object.freeze(
  new Set([
    TYPES_PRIVILEGIES.application,
    TYPES_PRIVILEGIES.reprendreInstallation,
    TYPES_PRIVILEGIES.sauvegarder,
    TYPES_PRIVILEGIES.restaurer,
  ]),
);

/**
 * Le refus d'un geste de portabilité arrivé pendant un geste long, ou `null`.
 *
 * Il est jugé À L'ARRIVÉE du message, hors de la file du canal : le Worker sert ses gestes en série,
 * et une révocation mise en file derrière un boot attendrait deux minutes sans le dire.
 *
 * @param {string} type @param {number} gestesLongsEnCours
 */
export function refusPendantUnGesteLong(type, gestesLongsEnCours) {
  if (!GESTES_DE_PORTABILITE.has(type)) return null;
  return gestesLongsEnCours > 0 ? CODES_REFUS_COQUILLE.gesteEnCours : null;
}

/**
 * Lit l'EN-TÊTE d'une archive sans rien vérifier, pour une seule question : emporte-t-elle une
 * enveloppe de récupération ?
 *
 * Ce n'est PAS la vérification — `importArchive` la fait, entière, avant toute écriture. C'est un
 * refus anticipé : une archive qui DÉCLARE `recovery: null` donnerait un coffre que rien n'ouvre, et
 * le dire avant de copier des centaines de mébioctets vaut mieux que le dire après. Une archive dont
 * l'en-tête ne se lit pas rend `lisible: false`, et `importArchive` dira pourquoi sous son code.
 *
 * @param {Uint8Array} tete les premiers octets de l'archive (préambule et en-tête)
 * @returns {{ lisible: boolean, emporteUneRecuperation: boolean }}
 */
export function enTeteDArchive(tete) {
  const illisible = { lisible: false, emporteUneRecuperation: false };
  if (!(tete instanceof Uint8Array) || tete.byteLength < PREAMBLE_BYTES) return illisible;
  if (!hasArchiveMagic(tete)) return illisible;
  const longueur = new DataView(tete.buffer, tete.byteOffset, tete.byteLength).getUint32(
    ARCHIVE_MAGIC.byteLength,
    false,
  );
  if (tete.byteLength < PREAMBLE_BYTES + longueur) return illisible;
  try {
    const entete = JSON.parse(
      new TextDecoder().decode(tete.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + longueur)),
    );
    if (entete === null || typeof entete !== "object" || !Object.hasOwn(entete, "recovery")) {
      return illisible;
    }
    return { lisible: true, emporteUneRecuperation: entete.recovery !== null };
  } catch {
    return illisible;
  }
}

/**
 * La CIBLE de restauration du coffre : celle de `createOpfsImportTarget` pour le volume
 * `application`, à UNE différence près — l'enveloppe emportée est posée là où le Worker de
 * confiance la lit, `coquille.cles`, et non à côté du disque.
 *
 * L'ordre de `importArchive` n'est pas touché : disque écrit, flushé et RELU, puis l'enveloppe, puis
 * l'engagement, puis le manifeste en dernier. Une archive sans enveloppe est refusée ici aussi, en
 * défense : `enTeteDArchive` l'a déjà refusée avant toute écriture.
 *
 * @param {object} base la cible de `createOpfsImportTarget(NOM_DU_VOLUME_APPLICATIF)`
 * @param {{ ecrireLEnveloppe: (octets: Uint8Array) => Promise<void> }} primitives
 */
export function cibleDuCoffre(base, { ecrireLEnveloppe }) {
  return Object.freeze({
    ...base,
    async commitRecoveryEnvelope(octets) {
      if (octets === null) {
        throw Object.assign(new Error(messageSansRecuperation()), {
          code: CODES_REFUS_COQUILLE.archiveSansRecuperation,
        });
      }
      await ecrireLEnveloppe(octets);
    },
  });
}

function messageSansRecuperation() {
  return "L'archive n'emporte aucune enveloppe de récupération : le coffre restauré ne s'ouvrirait pas.";
}

/**
 * Le BILAN d'une révocation d'urgence : ce qui reste, ce qui a été retiré — des NOMS et des
 * NOMBRES, jamais un identifiant d'emplacement, jamais un octet.
 *
 * @param {{ avant: { emplacements: { typeKek: number }[] },
 *           apres: { version: number, emplacements: { typeKek: number }[] } }} inventaires
 */
export function bilanDeRevocation({ avant, apres }) {
  const nom = (typeKek) => MOYENS_SERVIS[typeKek]?.nom ?? `type-${typeKek}`;
  const compter = (emplacements) => {
    const comptes = {};
    for (const { typeKek } of emplacements)
      comptes[nom(typeKek)] = (comptes[nom(typeKek)] ?? 0) + 1;
    return comptes;
  };
  const restants = compter(apres.emplacements);
  const retires = {};
  for (const [moyen, nombre] of Object.entries(compter(avant.emplacements))) {
    const ecart = nombre - (restants[moyen] ?? 0);
    if (ecart > 0) retires[moyen] = ecart;
  }
  return Object.freeze({
    versionEnveloppe: apres.version,
    restants: Object.freeze(restants),
    retires: Object.freeze(retires),
    nombreRetires: avant.emplacements.length - apres.emplacements.length,
    nombreRestants: apres.emplacements.length,
  });
}
