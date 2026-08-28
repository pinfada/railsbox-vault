// Modèle de référence de l'enveloppe de clé (#21, ADR 0020).
//
// Ce module est une SPÉCIFICATION EXÉCUTABLE, pas un chemin de production. Il ne touche ni au
// support, ni au fichier `.cles`, ni à l'ouvreur : il enveloppe et ouvre des structures EN MÉMOIRE,
// et les vecteurs qu'il produit (`tests/vectors/enveloppe-v1.json`) sont ce que le chemin de
// production doit reproduire octet pour octet. Le rapport est celui de l'oracle de #15 à
// l'implémentation de #16, et celui du modèle de #17 à l'implémentation de #18 : le juge est écrit
// avant, et séparément.
//
// ## Deux clés, et elles ne font pas le même travail
//
//  - la **KEK** (clé de déverrouillage) n'enveloppe QUE la DEK, dans UN emplacement. Elle ne touche
//    jamais un octet du volume, et c'est tout l'objet de cette tranche : ajouter, remplacer ou
//    révoquer une KEK ne rechiffre rien ;
//  - la **DEK** (clé de volume, 32 octets tirés) scelle la RACINE du fichier d'enveloppes, en plus
//    de tout le volume (ADR 0016). Elle est la seule autorité sur la liste des emplacements : sans
//    elle, on ne peut ni ajouter ni retirer un emplacement sans que la racine le dise.
//
// Cette dissymétrie a une conséquence qu'il faut énoncer plutôt que découvrir : **ajouter un
// emplacement exige d'avoir OUVERT l'enveloppe**, donc de détenir déjà une KEK valable. Une
// enveloppe n'est pas un trousseau ouvert en écriture par n'importe qui ; c'est un état signé par la
// clé qu'elle protège.
//
// ## L'ordre des vérifications, et pourquoi il est ce qu'il est
//
// Repris mot pour mot de l'ADR 0015. Une racine est d'abord AUTHENTIFIÉE — étiquette vérifiée sur
// son en-tête —, et seulement ensuite confrontée à ce que l'appelant attend. Sans cet ordre,
// « troncature », « mélange » et « autre volume » seraient des diagnostics posés sur un en-tête que
// rien ne garantit, c'est-à-dire des devinettes. C'est pourquoi l'en-tête est les données associées
// et l'empreinte des emplacements le CLAIR : vérifier d'abord, classer ensuite.
//
// ## Aucune attente n'est facultative
//
// `identifiantVolume` et `versionMinimale` doivent être PRÉSENTS — une valeur, ou `null` pour dire
// « aucun contrôle, et je le sais ». `undefined` est refusé, pour la raison qu'une revue de #17 a
// établie : une attente oubliée valait « aucun contrôle », c'est-à-dire une défaillance OUVERTE et
// silencieuse.

import { importerCleDeVolume } from "../format-chiffre/modele-reference.mjs";
import { egalesEnTempsConstant } from "../format-chiffre/octets.mjs";
import {
  identiteIncoherente,
  malforme,
  melange,
  racineRefusee,
  rejeu,
  troncature,
} from "./enveloppe-errors.mjs";
import {
  ALGORITHME_WEBCRYPTO,
  CLE_OCTETS,
  EMPREINTE_OCTETS,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  encoderAssociationEmplacement,
  encoderEmplacements,
  encoderEnteteEnveloppe,
  exigerOctets,
} from "./identite-enveloppe.mjs";

export { importerCleDeVolume };

/**
 * Importe une clé de DÉVERROUILLAGE de 32 octets.
 *
 * Elle est importée NON EXTRACTIBLE, comme la clé de volume : une fois entrée dans WebCrypto, aucun
 * code de cette origine ne peut la ressortir en octets. Ce n'est pas une protection contre du code
 * hostile déjà présent dans le Worker — celui-ci s'en sert sans la lire —, c'est une réduction de
 * la surface d'exfiltration accidentelle, et elle est gratuite.
 *
 * @param {Uint8Array} octets exactement `CLE_OCTETS` octets
 * @returns {Promise<CryptoKey>}
 */
export async function importerCleDeDeverrouillage(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== CLE_OCTETS) {
    throw malforme(
      `une clé de déverrouillage fait exactement ${CLE_OCTETS} octets, reçu ${octets?.byteLength ?? "autre chose"}.`,
      { attendu: CLE_OCTETS },
    );
  }
  return crypto.subtle.importKey("raw", octets, { name: ALGORITHME_WEBCRYPTO }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** `undefined` est refusé ; `null` dit « aucun contrôle », et le dit explicitement. */
function exigerAttente(nom, valeur) {
  if (valeur === undefined) {
    throw malforme(
      `« attentes.${nom} » est obligatoire. Une valeur pour contrôler, ou « null » pour déclarer qu'aucun contrôle n'est demandé — mais jamais un oubli, qui vaudrait une défaillance ouverte et silencieuse.`,
      { champ: nom },
    );
  }
  return valeur;
}

function separerEtiquette(brut) {
  const octets = new Uint8Array(brut);
  return {
    chiffre: octets.slice(0, octets.byteLength - ETIQUETTE_OCTETS),
    etiquette: octets.slice(octets.byteLength - ETIQUETTE_OCTETS),
  };
}

function assembler(chiffre, etiquette) {
  const brut = new Uint8Array(chiffre.byteLength + etiquette.byteLength);
  brut.set(chiffre, 0);
  brut.set(etiquette, chiffre.byteLength);
  return brut;
}

async function chiffrer(cle, nonce, donneesAssociees, clair) {
  const brut = await crypto.subtle.encrypt(
    {
      name: ALGORITHME_WEBCRYPTO,
      iv: nonce,
      additionalData: donneesAssociees,
      tagLength: ETIQUETTE_BITS,
    },
    cle,
    clair,
  );
  return separerEtiquette(brut);
}

/**
 * Déchiffre, ou rend `null` si l'étiquette ne vérifie pas.
 *
 * Seule une `OperationError` signifie « l'étiquette ne vérifie pas » ; tout le reste — clé du
 * mauvais type, nonce de mauvaise longueur, moteur en panne — est une faute de programmation ou une
 * panne, et la traiter comme un refus de sécurité effacerait un bogue derrière un message rassurant.
 */
async function dechiffrer(cle, nonce, donneesAssociees, brut) {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ALGORITHME_WEBCRYPTO,
          iv: nonce,
          additionalData: donneesAssociees,
          tagLength: ETIQUETTE_BITS,
        },
        cle,
        brut,
      ),
    );
  } catch (erreur) {
    if (erreur?.name === "OperationError") return null;
    throw erreur;
  }
}

/**
 * Enveloppe une DEK SOUS UN NONCE DONNÉ.
 *
 * **Le chemin normal est `envelopper`, qui tire son nonce.** Cette variante existe pour deux usages
 * et deux seulement : figer des vecteurs reproductibles, et permettre au chemin de production de
 * REPRODUIRE ces vecteurs. Un appelant qui fournirait deux fois le même nonce sous la même KEK
 * perdrait tout — et ici « tout » veut dire la clé du volume entier.
 *
 * @param {{ kek: CryptoKey, emplacement: object, dek: Uint8Array, nonce: Uint8Array }} appel
 * @returns {Promise<{ nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array }>}
 */
export async function envelopperSousNonce({ kek, emplacement, dek, nonce }) {
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  exigerOctets("dek", dek, CLE_OCTETS);
  const chiffre = await chiffrer(kek, nonce, encoderAssociationEmplacement(emplacement), dek);
  return Object.freeze({ nonce, ...chiffre });
}

/** Enveloppe une DEK sous un nonce TIRÉ. Le chemin normal. */
export async function envelopper({ kek, emplacement, dek, tirerNonce: nonces }) {
  return envelopperSousNonce({ kek, emplacement, dek, nonce: nonces() });
}

/**
 * DÉVELOPPE une DEK, ou rend `null` si cette KEK n'ouvre pas cet emplacement.
 *
 * Elle rend `null` et ne lève PAS, contrairement à `ouvrirBloc` du format chiffré, et l'écart est
 * délibéré : l'appelant essaie TOUS les emplacements, et un échec par emplacement est la situation
 * NORMALE — sept fois sur huit dans une enveloppe pleine. Lever ferait du cas ordinaire une
 * exception, et pousserait l'appelant à l'avaler. C'est lui qui décide, une fois la liste épuisée,
 * si l'absence de correspondance est un refus.
 *
 * @param {{ kek: CryptoKey, emplacement: object,
 *           scelle: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array } }} appel
 * @returns {Promise<Uint8Array|null>} les 32 octets de la DEK, ou `null`
 */
export async function developper({ kek, emplacement, scelle }) {
  exigerOctets("scelle.nonce", scelle?.nonce, NONCE_OCTETS);
  exigerOctets("scelle.chiffre", scelle?.chiffre, CLE_OCTETS);
  exigerOctets("scelle.etiquette", scelle?.etiquette, ETIQUETTE_OCTETS);
  return dechiffrer(
    kek,
    scelle.nonce,
    encoderAssociationEmplacement(emplacement),
    assembler(scelle.chiffre, scelle.etiquette),
  );
}

/** Empreinte SHA-256 de la suite canonique ordonnée des emplacements. */
export async function empreinteDesEmplacements(emplacements) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoderEmplacements(emplacements)));
}

/** L'en-tête que la racine authentifie. Le compte est DÉRIVÉ de la liste, jamais reçu. */
function enteteDeRacine(racine, emplacements) {
  return Object.freeze({
    identifiantVolume: racine.identifiantVolume,
    formatVersion: racine.formatVersion,
    version: racine.version,
    nombreEmplacements: emplacements.length,
  });
}

/**
 * Scelle la racine d'un fichier d'enveloppes SOUS UN NONCE DONNÉ. Même avertissement que
 * `envelopperSousNonce`.
 *
 * Le compte des emplacements est DÉRIVÉ de la liste, jamais reçu de l'appelant : une racine qui
 * annoncerait un compte différent de ce qu'elle scelle serait une troncature signée par le
 * producteur lui-même.
 *
 * @param {{ dek: CryptoKey, racine: object, emplacements: Array<object>, nonce: Uint8Array }} appel
 */
export async function scellerRacineSousNonce({ dek, racine, emplacements, nonce }) {
  if (!Array.isArray(emplacements) || emplacements.length === 0) {
    throw malforme("une racine d'enveloppe scelle au moins UN emplacement.");
  }
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  const entete = enteteDeRacine(racine, emplacements);
  const empreinte = await empreinteDesEmplacements(emplacements);
  const chiffre = await chiffrer(dek, nonce, encoderEnteteEnveloppe(entete), empreinte);
  return Object.freeze({ entete, nonce, empreinte, ...chiffre });
}

/** Scelle la racine sous un nonce TIRÉ. Le chemin normal. */
export async function scellerRacine({ dek, racine, emplacements, tirerNonce: nonces }) {
  return scellerRacineSousNonce({ dek, racine, emplacements, nonce: nonces() });
}

/** Vérifie que l'en-tête AUTHENTIFIÉ décrit bien le volume que l'appelant croit déverrouiller. */
function verifierIdentite(entete, attentes) {
  const attendu = exigerAttente("identifiantVolume", attentes.identifiantVolume);
  if (attendu !== null && entete.identifiantVolume !== attendu) {
    throw identiteIncoherente({
      attendu,
      trouve: entete.identifiantVolume,
      version: entete.version,
    });
  }
}

/**
 * Classe l'enveloppe trouvée face à un en-tête DÉJÀ authentifié. Chaque verdict est donc établi,
 * jamais deviné — c'est toute la raison de l'ordre choisi entre données associées et clair.
 */
async function classer(entete, emplacements, empreinteAuthentique, attentes) {
  verifierIdentite(entete, attentes);

  const versionMinimale = exigerAttente("versionMinimale", attentes.versionMinimale);
  if (versionMinimale !== null && entete.version < versionMinimale) {
    throw rejeu({ version: entete.version, minimale: versionMinimale });
  }

  if (emplacements.length !== entete.nombreEmplacements) {
    throw troncature({ trouves: emplacements.length, authentifies: entete.nombreEmplacements });
  }

  const empreinte = await empreinteDesEmplacements(emplacements);
  if (!egalesEnTempsConstant(empreinte, empreinteAuthentique)) {
    throw melange({ version: entete.version, nombreEmplacements: entete.nombreEmplacements });
  }
}

/**
 * Ouvre la racine et confronte la liste trouvée à ce que la racine authentifie.
 *
 * @param {{ dek: CryptoKey, entete: object,
 *           scelle: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           emplacements: Array<object>,
 *           attentes: { identifiantVolume: string | null, versionMinimale: number | null } }} appel
 * @returns {Promise<{ entete: object, empreinte: Uint8Array }>}
 */
export async function ouvrirRacine({ dek, entete, scelle, emplacements, attentes = {} }) {
  exigerOctets("scelle.nonce", scelle?.nonce, NONCE_OCTETS);
  exigerOctets("scelle.chiffre", scelle?.chiffre, EMPREINTE_OCTETS);
  exigerOctets("scelle.etiquette", scelle?.etiquette, ETIQUETTE_OCTETS);
  if (!Array.isArray(emplacements)) {
    throw malforme("« emplacements » doit être un tableau.");
  }

  const empreinteAuthentique = await dechiffrer(
    dek,
    scelle.nonce,
    encoderEnteteEnveloppe(entete),
    assembler(scelle.chiffre, scelle.etiquette),
  );
  if (empreinteAuthentique === null) {
    throw racineRefusee({ version: entete.version, nombreEmplacements: entete.nombreEmplacements });
  }

  // L'en-tête est AUTHENTIQUE à partir d'ici. Les quatre classements qui suivent sont donc établis.
  await classer(entete, emplacements, empreinteAuthentique, attentes);
  return Object.freeze({ entete: Object.freeze({ ...entete }), empreinte: empreinteAuthentique });
}
