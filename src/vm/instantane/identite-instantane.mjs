// LIAISON d'un instantané de reprise : ce que l'unique scellement lie (#65, ADR 0024).
//
// Ce module ne chiffre rien et ne touche à aucun support. Il définit les OCTETS que l'étiquette
// authentifie, et il est pur pour la même raison que `format-chiffre/identite-logique.mjs` : un
// relecteur doit pouvoir en juger sans rien exécuter.
//
// ## Ce que « en-tête scellé » veut dire, exactement
//
// L'en-tête n'est PAS chiffré — il est en clair sur le disque, parce qu'il faut pouvoir le lire pour
// décider s'il vaut la peine de traverser 250 Mio de corps. Il est **authentifié** : ces octets-ci
// sont les données associées de l'unique appel AES-256-GCM de la capture, si bien que le moindre
// champ modifié fait échouer l'étiquette et qu'aucun clair n'est rendu.
//
// ## Pourquoi les champs sont préfixés ou de largeur fixe
//
// Même règle et même raison que l'ADR 0015 : une concaténation non préfixée permettrait de déplacer
// un caractère d'un champ à l'autre sans changer les octets, donc de faire passer un instantané pour
// celui d'un autre volume. Les deux empreintes sont de largeur fixe (32 octets chacune) et n'ont
// donc pas besoin de préfixe ; l'identifiant de volume, qui est une CHAÎNE, en a un.
//
// ## Petit-boutiste sur le disque, gros-boutiste dans les données associées
//
// Ce n'est pas une incohérence, c'est la convention du dépôt : le témoin de l'ADR 0019 écrit ses
// entiers en petit-boutiste sur le support et l'ADR 0015 encode ses données associées en
// gros-boutiste. Le disque est lu par un `DataView`, les données associées par personne — elles
// n'ont qu'à être DÉTERMINISTES. La disposition sur le support vit dans `fichier-instantane.mjs` ;
// ici ne vit que l'encodage canonique.

import {
  ALGORITHME,
  EMPREINTE_OCTETS,
  GENERATION_MAX,
  RANG_MAX,
} from "../format-chiffre/identite-logique.mjs";
import { chainePrefixee, concatener, entierEnOctets } from "../format-chiffre/octets.mjs";
import { malforme } from "./instantane-errors.mjs";

/** Version du format d'INSTANTANÉ, distincte de celle du volume et de celle du modèle chiffré. */
export const INSTANTANE_FORMAT = 1;

/** Étiquette de domaine. Elle sépare l'instantané de tout autre objet scellé sous la même clé. */
export const ETIQUETTE_DOMAINE_INSTANTANE = "railsbox-vault/instantane-de-reprise/v1/liaison";

/** Largeur des deux empreintes portées par la liaison. La même que celle des entrées d'une racine. */
export { EMPREINTE_OCTETS };

/** Plus grande séquence représentable, alignée sur celle d'une racine (2^40 − 1). */
export const SEQUENCE_MAX = RANG_MAX;

function entierBorne(nom, valeur, maximum) {
  if (!Number.isSafeInteger(valeur) || valeur < 0 || valeur > maximum) {
    throw malforme(`« ${nom} » doit être un entier de 0 à ${maximum}, reçu ${valeur}.`, {
      champ: nom,
      maximum,
    });
  }
  return valeur;
}

function empreinte(nom, valeur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== EMPREINTE_OCTETS) {
    throw malforme(`« ${nom} » doit faire exactement ${EMPREINTE_OCTETS} octets.`, {
      champ: nom,
      attendu: EMPREINTE_OCTETS,
    });
  }
  return valeur;
}

function identifiantVolume(valeur) {
  if (typeof valeur !== "string" || !/^[0-9a-f]{2,64}$/.test(valeur)) {
    throw malforme(
      `« volume » doit être un identifiant hexadécimal minuscule, reçu ${JSON.stringify(valeur)}.`,
      { champ: "volume" },
    );
  }
  return valeur;
}

/**
 * EXIGE une liaison complète et bornée, et la rend NORMALISÉE et gelée.
 *
 * Aucun champ n'est facultatif et aucun n'a de valeur par défaut, `formatInstantane` excepté — qui
 * est celui de ce runtime, non une donnée de l'appelant. La règle est celle des attentes du modèle
 * de l'ADR 0015 : un champ oublié vaudrait un contrôle qui ne contrôle rien, c'est-à-dire une
 * défaillance ouverte et silencieuse.
 *
 * @param {{ volume: string, formatInstantane?: number, formatVolume: number, sequence: number,
 *           generation: number, empreinteRegion: Uint8Array, empreinteImage: Uint8Array,
 *           longueurEtat: number }} liaison
 */
export function exigerLiaison(liaison) {
  if (liaison === null || typeof liaison !== "object") {
    throw malforme("une liaison est un objet, et elle est obligatoire.");
  }
  return Object.freeze({
    volume: identifiantVolume(liaison.volume),
    formatInstantane: entierBorne(
      "formatInstantane",
      liaison.formatInstantane ?? INSTANTANE_FORMAT,
      0xffffffff,
    ),
    formatVolume: entierBorne("formatVolume", liaison.formatVolume, 0xffffffff),
    sequence: entierBorne("sequence", liaison.sequence, SEQUENCE_MAX),
    generation: entierBorne("generation", liaison.generation, GENERATION_MAX),
    empreinteRegion: empreinte("empreinteRegion", liaison.empreinteRegion),
    empreinteImage: empreinte("empreinteImage", liaison.empreinteImage),
    longueurEtat: entierBorne("longueurEtat", liaison.longueurEtat, Number.MAX_SAFE_INTEGER),
  });
}

/**
 * Encodage CANONIQUE de la liaison : les données associées de l'unique scellement d'une capture.
 *
 * @param {object} liaison telle que `exigerLiaison` l'accepte
 * @returns {Uint8Array}
 */
export function encoderLiaison(liaison) {
  const exigee = exigerLiaison(liaison);
  return concatener(
    chainePrefixee(ETIQUETTE_DOMAINE_INSTANTANE),
    chainePrefixee(ALGORITHME),
    entierEnOctets(exigee.formatInstantane, 4),
    entierEnOctets(exigee.formatVolume, 4),
    chainePrefixee(exigee.volume),
    entierEnOctets(exigee.sequence, 8),
    entierEnOctets(exigee.generation, 8),
    exigee.empreinteRegion,
    exigee.empreinteImage,
    entierEnOctets(exigee.longueurEtat, 8),
  );
}
