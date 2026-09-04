// DISPOSITION du fichier `<volume>.instantane` (#65, ADR 0024, décision 2).
//
// Ce module ne chiffre rien et ne touche à aucun support : il dit OÙ les octets vivent, comme
// `volume-chiffre-format.mjs` le fait pour le volume et `enveloppe/fichier-enveloppe.mjs` pour
// l'enveloppe.
//
//     [ en-tête, 152 octets ][ corps chiffré, N octets ][ marque de complétude, 8 octets ]
//
// **L'en-tête est en clair et AUTHENTIFIÉ.** Ce n'est pas une contradiction : ses champs sont les
// DONNÉES ASSOCIÉES de l'unique scellement de la capture (`identite-instantane.mjs`), si bien qu'un
// octet modifié ici fait échouer l'étiquette là-bas. Il est lisible parce qu'il faut pouvoir décider
// si l'instantané vaut la peine d'être traversé avant d'en déchiffrer 250 Mio.
//
// **La marque de complétude est à la FIN, et elle n'est pas authentifiée.** Même rôle et même
// réserve que `VLTSEAL1` de l'ADR 0016 : elle ferme la fenêtre d'une COUPURE — un fichier tronqué
// n'a pas de marque —, pas celle d'un adversaire, qui la poserait sans peine et tomberait ensuite
// sur l'étiquette.

import {
  ETIQUETTE_OCTETS,
  IDENTIFIANT_VOLUME_OCTETS,
  NONCE_OCTETS,
  identifiantVolumeEnTexte,
} from "../format-chiffre/identite-logique.mjs";
import { identifiantVolumeEnOctets } from "../volume-chiffre-format.mjs";
import { EMPREINTE_OCTETS, INSTANTANE_FORMAT, exigerLiaison } from "./identite-instantane.mjs";
import { malforme } from "./instantane-errors.mjs";

/** Marqueur de début. Huit octets, jamais modifiés. */
export const MARQUEUR_INSTANTANE = Uint8Array.from([
  0x56, 0x4c, 0x54, 0x53, 0x4e, 0x50, 0x30, 0x31,
]); // "VLTSNP01"

/**
 * Marque de COMPLÉTUDE, posée après le corps et après une barrière.
 *
 * Huit octets d'un motif fixe, et non un bit, pour la raison exacte de l'ADR 0016 : un bit, ou un
 * octet non nul, serait posé par accident — une page jamais écrite que le support rend en `0xff`, un
 * octet retourné, un reliquat d'un autre fichier suffiraient à faire passer une capture interrompue
 * pour une capture complète, et c'est précisément l'état qu'on veut interdire.
 */
export const MARQUEUR_COMPLET = Uint8Array.from([0x56, 0x4c, 0x54, 0x53, 0x4e, 0x50, 0x46, 0x31]); // "VLTSNPF1"

/** Largeur de la marque de complétude. */
export const MARQUE_OCTETS = MARQUEUR_COMPLET.byteLength;

const OFFSET = Object.freeze({
  marqueur: 0,
  formatInstantane: 8,
  formatVolume: 12,
  identifiantVolume: 16,
  sequence: 32,
  generation: 40,
  longueurEtat: 48,
  empreinteRegion: 56,
  empreinteImage: 88,
  nonce: 120,
  etiquette: 132,
  reserve: 148,
});

/** Largeur de l'en-tête. Fixe : la table d'offsets ci-dessus est celle que l'ADR 0024 publie. */
export const EN_TETE_OCTETS = 152;

/** Où le corps chiffré commence. Constante, mais nommée : un offset en dur se recopie mal. */
export function offsetDuCorps() {
  return EN_TETE_OCTETS;
}

/** Où la marque de complétude est posée, pour un état de `longueurEtat` octets. */
export function offsetDeLaMarque(longueurEtat) {
  return EN_TETE_OCTETS + longueurEtat;
}

/** Taille TOTALE du fichier d'instantané, en-tête et marque comprises. */
export function tailleDeFichier(longueurEtat) {
  return EN_TETE_OCTETS + longueurEtat + MARQUE_OCTETS;
}

function exigerOctets(nom, valeur, longueur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== longueur) {
    throw malforme(`« ${nom} » doit faire ${longueur} octets.`, { champ: nom, attendu: longueur });
  }
  return valeur;
}

/**
 * ENCODE l'en-tête. Les entiers sont petit-boutistes, comme ceux du témoin de l'ADR 0019 et de
 * l'en-tête v3 de l'ADR 0016 ; les données associées, elles, sont gros-boutistes. Voir
 * `identite-instantane.mjs` : deux encodages de rôles différents, et c'est la convention du dépôt.
 *
 * @param {{ liaison: object, nonce: Uint8Array, etiquette: Uint8Array }} entete
 * @returns {Uint8Array} `EN_TETE_OCTETS` octets
 */
export function encoderEnTete({ liaison, nonce, etiquette }) {
  const exigee = exigerLiaison(liaison);
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  exigerOctets("etiquette", etiquette, ETIQUETTE_OCTETS);

  const octets = new Uint8Array(EN_TETE_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MARQUEUR_INSTANTANE, OFFSET.marqueur);
  vue.setUint32(OFFSET.formatInstantane, exigee.formatInstantane, true);
  vue.setUint32(OFFSET.formatVolume, exigee.formatVolume, true);
  octets.set(identifiantVolumeEnOctets(exigee.volume), OFFSET.identifiantVolume);
  vue.setBigUint64(OFFSET.sequence, BigInt(exigee.sequence), true);
  vue.setBigUint64(OFFSET.generation, BigInt(exigee.generation), true);
  vue.setBigUint64(OFFSET.longueurEtat, BigInt(exigee.longueurEtat), true);
  octets.set(exigee.empreinteRegion, OFFSET.empreinteRegion);
  octets.set(exigee.empreinteImage, OFFSET.empreinteImage);
  octets.set(nonce, OFFSET.nonce);
  octets.set(etiquette, OFFSET.etiquette);
  // La réserve reste à zéro. Elle est déclarée pour qu'une version ultérieure ait où se loger sans
  // déplacer un champ — déplacer un champ casse le format, ajouter dans la réserve ne le casse pas.
  return octets;
}

function refus(raison) {
  return Object.freeze({ valide: false, raison, liaison: null, nonce: null, etiquette: null });
}

/**
 * Relit les champs de LIAISON depuis l'en-tête, et les fait passer par `exigerLiaison`.
 *
 * Le passage par `exigerLiaison` n'est pas décoratif : c'est lui qui borne les entiers relus, si
 * bien qu'un fichier étranger dont les huit octets de séquence dépassent 2^40 est refusé ici plutôt
 * que porté jusqu'aux données associées, où il aurait levé une `RangeError` nue.
 */
function lireLiaison(octets, vue, formatInstantane) {
  const tranche = (offset, longueur) => octets.slice(offset, offset + longueur);
  return exigerLiaison({
    volume: identifiantVolumeEnTexte(tranche(OFFSET.identifiantVolume, IDENTIFIANT_VOLUME_OCTETS)),
    formatInstantane,
    formatVolume: vue.getUint32(OFFSET.formatVolume, true),
    sequence: Number(vue.getBigUint64(OFFSET.sequence, true)),
    generation: Number(vue.getBigUint64(OFFSET.generation, true)),
    empreinteRegion: tranche(OFFSET.empreinteRegion, EMPREINTE_OCTETS),
    empreinteImage: tranche(OFFSET.empreinteImage, EMPREINTE_OCTETS),
    longueurEtat: Number(vue.getBigUint64(OFFSET.longueurEtat, true)),
  });
}

/**
 * DÉCODE un en-tête, ou dit pourquoi ce n'en est pas un.
 *
 * Il rend un CONSTAT plutôt que de lever : à ce point, « ce fichier n'est pas un instantané » et
 * « ce fichier est un instantané d'un autre état » se traitent de la même façon — écarter — et
 * l'appelant a besoin du MOTIF pour le publier, pas d'une exception à rattraper. Les refus typés
 * sont posés par le chemin de production, qui sait aussi quel fichier retirer.
 *
 * @param {Uint8Array} octets au moins `EN_TETE_OCTETS` octets
 */
export function decoderEnTete(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < EN_TETE_OCTETS) {
    return refus(
      `un en-tête d'instantané fait ${EN_TETE_OCTETS} octets, le fichier n'en rend que ${octets?.byteLength ?? 0}.`,
    );
  }
  if (!MARQUEUR_INSTANTANE.every((attendu, index) => octets[index] === attendu)) {
    return refus("le marqueur d'en-tête n'est pas celui d'un instantané de reprise.");
  }
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const formatInstantane = vue.getUint32(OFFSET.formatInstantane, true);
  if (formatInstantane !== INSTANTANE_FORMAT) {
    return refus(
      `version d'instantané ${formatInstantane} inconnue de ce runtime, qui écrit et lit la version ${INSTANTANE_FORMAT}.`,
    );
  }
  // La RÉSERVE doit être NULLE. Elle n'entre pas dans les données associées — elle n'est donc pas
  // authentifiée —, et l'accepter non nulle offrirait quatre octets de canal libre sous un en-tête
  // qui se présente comme scellé. Un fichier qui y porte quoi que ce soit vient d'un autre
  // producteur, ou a été retouché ; dans les deux cas il n'est pas de ce runtime.
  if (octets.subarray(OFFSET.reserve, EN_TETE_OCTETS).some((octet) => octet !== 0)) {
    return refus("la réserve de l'en-tête n'est pas nulle : ce fichier n'a pas été écrit ici.");
  }

  try {
    return Object.freeze({
      valide: true,
      raison: null,
      liaison: lireLiaison(octets, vue, formatInstantane),
      nonce: octets.slice(OFFSET.nonce, OFFSET.nonce + NONCE_OCTETS),
      etiquette: octets.slice(OFFSET.etiquette, OFFSET.etiquette + ETIQUETTE_OCTETS),
    });
  } catch (cause) {
    // Un champ hors bornes DANS le fichier n'est pas une faute de programmation : c'est un fichier
    // étranger ou abîmé, et le constat doit le dire au lieu de laisser passer une exception que
    // l'appelant devrait trier.
    return refus(`un champ de l'en-tête est hors bornes : ${cause.message}`);
  }
}

/** Vrai si `octets` est EXACTEMENT la marque de complétude. Une marque approchante n'est pas une marque. */
export function marqueCompleteEcrite(octets) {
  return (
    octets instanceof Uint8Array &&
    octets.byteLength === MARQUE_OCTETS &&
    MARQUEUR_COMPLET.every((attendu, index) => octets[index] === attendu)
  );
}
