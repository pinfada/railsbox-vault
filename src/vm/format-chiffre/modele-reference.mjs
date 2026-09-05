// Modèle de référence du format chiffré (#17, ADR 0015).
//
// Ce module est une SPÉCIFICATION EXÉCUTABLE, pas un chemin de production. Il ne touche ni au
// support, ni au manifeste, ni au journal de génération : il scelle et ouvre des structures EN
// MÉMOIRE, et les vecteurs qu'il produit (`tests/vectors/format-chiffre-v1.json`) sont ce que #18 et
// #19 devront reproduire octet pour octet. Le rapport est celui de l'oracle de #15 à
// l'implémentation de #16 : le juge est écrit avant, et séparément.
//
// Sept gestes, en trois paires et un solitaire : `scellerBloc` / `ouvrirBloc` pour un objet du
// VOLUME, `scellerEnregistrement` / `ouvrirEnregistrement` pour un objet du JOURNAL,
// `scellerRacine` / `ouvrirRacine`, et `rescellerEnSecteurs` — que le POINT DE CONTRÔLE de
// l'ADR 0014 exige et qu'une revue a relevé manquant. La clé de volume est REÇUE, jamais dérivée ni
// conservée : l'enveloppe DEK/KEK, le déverrouillage et la récupération sont l'objet de #21
// (jalon 5).
//
// ## Deux paires plutôt qu'une, et ce que la séparation achète (#143)
//
// Jusqu'au constat #143, un enregistrement du journal se scellait par `scellerBloc` : les deux
// magasins partageaient une étiquette de domaine, et le RANG devait les séparer. Il ne le faisait
// pas — voir `identite-logique.mjs`. La paire dédiée n'ajoute aucun champ et ne change aucune
// largeur : elle change l'étiquette de domaine, donc l'espace d'identités. `rescellerEnSecteurs`,
// lui, part du journal et arrive dans le VOLUME : il scelle donc des BLOCS, et c'est ce passage
// d'un magasin à l'autre qui est tout l'objet du point de contrôle.
//
// ## Le nonce est tiré, et rien ne le dérive
//
// Chaque scellement tire douze octets de `crypto.getRandomValues` et les conserve avec l'objet
// scellé. La justification — et la réfutation par exécution qui l'a imposée — est dans
// `identite-logique.mjs` et dans l'ADR 0015. Conséquence directe sur ce fichier : à l'ouverture, le
// nonce ne DÉCRIT plus rien. Un nonce altéré ne se distingue plus d'un chiffré altéré ; les deux
// tombent dans `sceauRefuse`, et le modèle ne prétend pas les séparer.
//
// ## Ordre des vérifications, et pourquoi il est ce qu'il est
//
// Le modèle ne classe une menace qu'une fois qu'il a le droit de le faire. Une racine est d'abord
// AUTHENTIFIÉE — étiquette vérifiée sur son en-tête — et seulement ensuite comparée à ce que
// l'appelant attend. Sans cet ordre, « troncature » et « rejeu » seraient des diagnostics posés sur
// un en-tête que rien ne garantit, c'est-à-dire des devinettes. C'est pourquoi l'empreinte des
// entrées est le CLAIR du scellement de la racine et l'en-tête ses données associées : vérifier
// d'abord, classer ensuite.
//
// ## Aucune attente n'est facultative
//
// `scellementsCumules`, `generationMinimale`, `sequenceMinimale`, `sequencePrecedente` et les trois
// champs d'identité de racine doivent être PRÉSENTS — une valeur, ou `null` pour dire « aucun
// contrôle, et je le sais ». `undefined` est refusé. La raison est celle d'une revue : une attente
// oubliée valait « aucun contrôle », c'est-à-dire une défaillance OUVERTE et silencieuse.

import {
  identiteIncoherente,
  malforme,
  melange,
  ordreInvalide,
  rejeu,
  sceauRefuse,
  troncature,
} from "./crypto-errors.mjs";
import {
  ALGORITHME_WEBCRYPTO,
  CLE_OCTETS,
  EMPREINTE_OCTETS,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  encoderEnteteRacine,
  encoderEntrees,
  encoderIdentiteBloc,
  encoderIdentiteEnregistrement,
  tirerNonce,
  verifierAlgorithme,
  verifierBudgetDeCle,
  verifierRangsCroissants,
} from "./identite-logique.mjs";
import { egalesEnTempsConstant } from "./octets.mjs";

/** Taille d'un secteur du volume. Reprise du contrat de géométrie de #6, pas redéfinie ici. */
export const SECTEUR_OCTETS = 512;

/**
 * Rang que le format ÉPINGLE pour un secteur du VOLUME.
 *
 * Un secteur du volume ne porte qu'une version par génération : son identité est (volume, format,
 * génération, adresse), et le rang n'y ajoute rien. Le fixer à zéro évite d'avoir à le STOCKER dans
 * la région d'authentification — le lecteur le reconstruit — tout en gardant une seule forme de
 * données associées pour le journal et pour le volume.
 */
export const RANG_SECTEUR_DE_VOLUME = 0;

/**
 * Importe une clé de volume de 32 octets.
 *
 * Elle est importée NON EXTRACTIBLE : une fois entrée dans WebCrypto, aucun code de cette origine ne
 * peut la ressortir en octets. Ce n'est pas une protection contre du code hostile déjà présent dans
 * le Worker — celui-ci s'en sert sans la lire —, c'est une réduction de la surface d'exfiltration
 * accidentelle, et elle est gratuite.
 *
 * @param {Uint8Array} octets exactement `CLE_OCTETS` octets aléatoires
 * @returns {Promise<CryptoKey>}
 */
export async function importerCleDeVolume(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== CLE_OCTETS) {
    throw malforme(
      `une clé de volume fait exactement ${CLE_OCTETS} octets, reçu ${octets?.byteLength ?? "autre chose"}.`,
      { attendu: CLE_OCTETS },
    );
  }
  return crypto.subtle.importKey("raw", octets, { name: ALGORITHME_WEBCRYPTO }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function exigerOctets(nom, valeur, longueur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== longueur) {
    throw malforme(`« ${nom} » doit faire ${longueur} octets.`, { champ: nom, attendu: longueur });
  }
  return valeur;
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

/** Contrôles de forme d'un sceau. `longueurChiffre` à `null` laisse le chiffré de longueur libre. */
function exigerSceau(scelle, longueurChiffre = null) {
  exigerOctets("scelle.nonce", scelle?.nonce, NONCE_OCTETS);
  exigerOctets("scelle.etiquette", scelle?.etiquette, ETIQUETTE_OCTETS);
  if (longueurChiffre === null) {
    if (!(scelle.chiffre instanceof Uint8Array)) {
      throw malforme("« scelle.chiffre » doit être une suite d'octets.");
    }
  } else {
    exigerOctets("scelle.chiffre", scelle.chiffre, longueurChiffre);
  }
  return scelle;
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

/** Empreinte SHA-256 de la suite canonique des entrées d'une génération. */
export async function empreinteDesEntrees(entrees) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoderEntrees(entrees)));
}

function exigerContenu(contenu, identite) {
  if (!(contenu instanceof Uint8Array)) {
    throw malforme("« contenu » doit être une suite d'octets.");
  }
  if (contenu.byteLength !== identite?.longueur) {
    throw malforme(
      `« contenu » fait ${contenu.byteLength} octets alors que l'identité en déclare ${identite?.longueur}. Une longueur devinée n'est pas une longueur.`,
      { recu: contenu.byteLength, declare: identite?.longueur },
    );
  }
  return contenu;
}

/** Scelle sous l'encodeur d'identité du magasin dont l'objet vient. Aucun défaut : il est reçu. */
async function scellerSousNonce(encoderIdentite, { cle, identite, contenu, nonce, attentes }) {
  verifierAlgorithme(identite?.algorithme);
  verifierBudgetDeCle(exigerAttente("scellementsCumules", attentes.scellementsCumules));
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  exigerContenu(contenu, identite);
  const chiffre = await chiffrer(cle, nonce, encoderIdentite(identite), contenu);
  return Object.freeze({ nonce, ...chiffre });
}

/** Ouvre sous l'encodeur d'identité du magasin dont l'objet vient, ou refuse. Voir `ouvrirBloc`. */
async function ouvrir(encoderIdentite, { cle, identite, scelle, attentes }) {
  verifierAlgorithme(identite?.algorithme);
  const generationMinimale = exigerAttente("generationMinimale", attentes.generationMinimale);
  exigerSceau(scelle);

  const clair = await dechiffrer(
    cle,
    scelle.nonce,
    encoderIdentite(identite),
    assembler(scelle.chiffre, scelle.etiquette),
  );
  if (clair === null) {
    throw sceauRefuse({
      volume: identite.volume,
      adresse: identite.adresse,
      formatVersion: identite.formatVersion,
      generation: identite.generation,
    });
  }

  // À partir d'ici SEULEMENT, la génération est authentique : la classer plus tôt serait deviner.
  if (generationMinimale !== null && identite.generation < generationMinimale) {
    throw rejeu({
      generation: identite.generation,
      minimale: generationMinimale,
      adresse: identite.adresse,
    });
  }
  return clair;
}

/**
 * Scelle un BLOC DU VOLUME SOUS UN NONCE DONNÉ.
 *
 * **Le chemin normal est `scellerBloc`, qui tire son nonce.** Cette variante existe pour deux usages
 * et deux seulement : figer des vecteurs reproductibles, et permettre à une implémentation (#18) de
 * REPRODUIRE ces vecteurs. Un appelant de production qui fournirait deux fois le même nonce sous la
 * même clé perdrait tout : c'est exactement la faute que le tirage supprime.
 */
export async function scellerBlocSousNonce({ cle, identite, contenu, nonce, attentes = {} }) {
  return scellerSousNonce(encoderIdentiteBloc, { cle, identite, contenu, nonce, attentes });
}

/**
 * Scelle un bloc du volume sous son identité logique, avec un nonce TIRÉ.
 *
 * @param {{ cle: CryptoKey, identite: object, contenu: Uint8Array,
 *           attentes: { scellementsCumules: number } }} appel
 * @returns {Promise<{ nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array }>}
 */
export async function scellerBloc({ cle, identite, contenu, attentes = {} }) {
  return scellerBlocSousNonce({ cle, identite, contenu, nonce: tirerNonce(), attentes });
}

/**
 * Ouvre un bloc du volume sous l'identité logique que l'appelant présente. Tout écart est un refus
 * typé.
 *
 * `attentes.generationMinimale` est le seul moyen de refuser un bloc AUTHENTIQUE mais ancien. D'où
 * ce minimum vient décide de ce que la propriété vaut : la racine de la génération en cours pour le
 * journal, et RIEN pour un secteur relu du volume — l'ADR 0015 nomme ce résidu et ne le masque pas.
 * `null` dit « je n'en présente pas », et c'est alors écrit à l'appel plutôt que déduit d'un oubli.
 *
 * @param {{ cle: CryptoKey, identite: object,
 *           scelle: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           attentes: { generationMinimale: number | null } }} appel
 * @returns {Promise<Uint8Array>} le clair, ou un refus
 */
export async function ouvrirBloc({ cle, identite, scelle, attentes = {} }) {
  return ouvrir(encoderIdentiteBloc, { cle, identite, scelle, attentes });
}

/**
 * Scelle un ENREGISTREMENT DU JOURNAL sous un nonce donné (#143). Même avertissement que
 * `scellerBlocSousNonce` : le chemin normal est `scellerEnregistrement`, qui tire son nonce.
 */
export async function scellerEnregistrementSousNonce({
  cle,
  identite,
  contenu,
  nonce,
  attentes = {},
}) {
  return scellerSousNonce(encoderIdentiteEnregistrement, {
    cle,
    identite,
    contenu,
    nonce,
    attentes,
  });
}

/**
 * Scelle un enregistrement du journal de génération, avec un nonce TIRÉ (#143).
 *
 * Ce geste est le JUMEAU de `scellerBloc`, et il est séparé pour une seule raison : l'étiquette de
 * domaine de son identité. Les fusionner sous un paramètre « magasin » aurait rendu la séparation
 * facultative à l'appel, c'est-à-dire oubliable — et c'est exactement l'oubli que le constat #143 a
 * exploité.
 */
export async function scellerEnregistrement({ cle, identite, contenu, attentes = {} }) {
  return scellerEnregistrementSousNonce({ cle, identite, contenu, nonce: tirerNonce(), attentes });
}

/**
 * Ouvre un enregistrement du journal de génération (#143).
 *
 * Un sceau de SECTEUR DU VOLUME présenté ici ne s'ouvre pas, et réciproquement : les deux étiquettes
 * de domaine mettent les deux magasins dans deux espaces d'identités disjoints, à tout rang.
 */
export async function ouvrirEnregistrement({ cle, identite, scelle, attentes = {} }) {
  return ouvrir(encoderIdentiteEnregistrement, { cle, identite, scelle, attentes });
}

/**
 * Rescelle un enregistrement du journal en SECTEURS du volume — ce que fait le POINT DE CONTRÔLE.
 *
 * Le journal scelle des ENREGISTREMENTS, dont la longueur est celle de l'écriture du guest et peut
 * couvrir plusieurs secteurs. Le volume, lui, est adressé au secteur et doit pouvoir être relu
 * secteur par secteur : une étiquette par enregistrement obligerait à relire tout l'enregistrement
 * pour vérifier un seul secteur, et à le retrouver — ce que le volume ne sait pas faire. Le point de
 * contrôle rescelle donc, un secteur à la fois, avec un nonce NEUF par secteur.
 *
 * Un enregistrement qui ne couvre pas des secteurs entiers est REFUSÉ plutôt que complété : le
 * compléter exigerait de LIRE le volume — donc d'ouvrir les secteurs voisins —, ce qui n'est pas le
 * travail d'un module pur. L'appelant (#18) fait cette lecture-modification-réécriture avant
 * d'appeler ici, comme `deposer` le fait déjà côté journal.
 *
 * **`nonces` est la porte d'injection de ce geste, et elle manquait.** `scellerBlocSousNonce` et
 * `scellerRacineSousNonce` existent pour que #18 puisse REPRODUIRE les vecteurs figés ; ce
 * troisième geste n'avait pas son équivalent, si bien que le chemin du POINT DE CONTRÔLE ne pouvait
 * être confronté à aucun vecteur — c'est-à-dire que la partie du produit qui écrit réellement dans
 * le volume échappait au contrat. Le manque est signalé par l'ADR 0016 ; il est comblé ICI, sans
 * qu'un seul octet produit change : par défaut le nonce est TIRÉ, exactement comme avant.
 *
 * @param {{ cle: CryptoKey, adresse: number, contenu: Uint8Array,
 *           identite: { volume: string, formatVersion: number, generation: number },
 *           attentes: { scellementsCumules: number },
 *           nonces?: () => Uint8Array }} appel
 * @returns {Promise<{ secteurs: Array<object>, scellementsCumules: number }>}
 */
export async function rescellerEnSecteurs({
  cle,
  adresse,
  contenu,
  identite,
  attentes = {},
  nonces = tirerNonce,
}) {
  let scellementsCumules = exigerAttente("scellementsCumules", attentes.scellementsCumules);
  if (!(contenu instanceof Uint8Array)) {
    throw malforme("« contenu » doit être une suite d'octets.");
  }
  if (adresse % SECTEUR_OCTETS !== 0 || contenu.byteLength % SECTEUR_OCTETS !== 0) {
    throw malforme(
      `un rescellement porte sur des secteurs ENTIERS : adresse ${adresse} et longueur ${contenu.byteLength} doivent être des multiples de ${SECTEUR_OCTETS}. Compléter exigerait de LIRE le volume, ce que l'appelant doit faire avant d'appeler ici.`,
      { adresse, longueur: contenu.byteLength, secteur: SECTEUR_OCTETS },
    );
  }

  const secteurs = [];
  for (let position = 0; position < contenu.byteLength; position += SECTEUR_OCTETS) {
    const identiteSecteur = {
      volume: identite.volume,
      formatVersion: identite.formatVersion,
      generation: identite.generation,
      rang: RANG_SECTEUR_DE_VOLUME,
      adresse: adresse + position,
      longueur: SECTEUR_OCTETS,
    };
    const scelle = await scellerBlocSousNonce({
      cle,
      identite: identiteSecteur,
      contenu: contenu.subarray(position, position + SECTEUR_OCTETS),
      nonce: nonces(),
      attentes: { scellementsCumules },
    });
    scellementsCumules += 1;
    secteurs.push(Object.freeze({ identite: Object.freeze(identiteSecteur), scelle }));
  }
  return Object.freeze({ secteurs: Object.freeze(secteurs), scellementsCumules });
}

/** Les deux obligations que l'appelant seul peut tenir, rendues falsifiables ici. */
function verifierObligationsDeRacine(racine, entrees, attentes) {
  verifierBudgetDeCle(exigerAttente("scellementsCumules", racine?.scellementsCumules));
  verifierRangsCroissants(entrees);

  const sequencePrecedente = exigerAttente("sequencePrecedente", attentes.sequencePrecedente);
  if (sequencePrecedente !== null && racine.sequence <= sequencePrecedente) {
    throw ordreInvalide(
      `la séquence ${racine.sequence} ne dépasse pas la séquence précédente ${sequencePrecedente}. Elle doit croître STRICTEMENT à chaque écriture de racine, reprise après échec comprise.`,
      { sequence: racine.sequence, sequencePrecedente },
    );
  }
}

function enteteDeRacine(racine, entrees) {
  return Object.freeze({
    volume: racine.volume,
    formatVersion: racine.formatVersion,
    sequence: racine.sequence,
    generation: racine.generation,
    tailleVolume: racine.tailleVolume,
    nombreEntrees: entrees.length,
    longueurCharge: entrees.reduce((somme, entree) => somme + (entree?.longueur ?? 0), 0),
    scellementsCumules: racine.scellementsCumules,
  });
}

/** Scelle une racine SOUS UN NONCE DONNÉ. Même avertissement que `scellerBlocSousNonce`. */
export async function scellerRacineSousNonce({ cle, racine, entrees, nonce, attentes = {} }) {
  verifierAlgorithme(racine?.algorithme);
  if (!Array.isArray(entrees)) {
    throw malforme("« entrees » doit être un tableau.");
  }
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  verifierObligationsDeRacine(racine, entrees, attentes);

  const entete = enteteDeRacine(racine, entrees);
  const empreinteEntrees = await empreinteDesEntrees(entrees);
  const chiffre = await chiffrer(cle, nonce, encoderEnteteRacine(entete), empreinteEntrees);
  return Object.freeze({ entete, nonce, empreinteEntrees, ...chiffre });
}

/**
 * Scelle la racine d'une génération : ce qu'elle contient, en quel nombre, et sous quelle séquence.
 *
 * Le compte et la longueur de charge sont DÉRIVÉS des entrées, jamais reçus de l'appelant : une
 * racine qui annoncerait un compte différent de ce qu'elle scelle serait une troncature signée par
 * le producteur lui-même.
 *
 * @param {{ cle: CryptoKey, racine: object, entrees: Array<object>,
 *           attentes: { sequencePrecedente: number | null } }} appel
 */
export async function scellerRacine({ cle, racine, entrees, attentes = {} }) {
  return scellerRacineSousNonce({ cle, racine, entrees, nonce: tirerNonce(), attentes });
}

/** Vérifie que l'en-tête AUTHENTIFIÉ décrit bien le volume que l'appelant croit ouvrir. */
function verifierIdentiteRacine(entete, attentes) {
  const ecarts = [
    ["volume", exigerAttente("volume", attentes.volume)],
    ["formatVersion", exigerAttente("formatVersion", attentes.formatVersion)],
    ["tailleVolume", exigerAttente("tailleVolume", attentes.tailleVolume)],
  ].filter(([champ, attendu]) => attendu !== null && entete[champ] !== attendu);

  if (ecarts.length === 0) return;
  throw identiteIncoherente(
    `elle décrit ${ecarts.map(([champ]) => `un autre « ${champ} »`).join(", ")}.`,
    {
      ecarts: Object.fromEntries(
        ecarts.map(([champ, attendu]) => [champ, { attendu, trouve: entete[champ] }]),
      ),
    },
  );
}

/**
 * Classe la génération trouvée face à un en-tête DÉJÀ authentifié. Chaque verdict est donc établi,
 * jamais deviné — c'est toute la raison de l'ordre choisi entre données associées et clair.
 */
async function classerGeneration(entete, entrees, empreinteAuthentique, attentes) {
  verifierIdentiteRacine(entete, attentes);

  const sequenceMinimale = exigerAttente("sequenceMinimale", attentes.sequenceMinimale);
  if (sequenceMinimale !== null && entete.sequence < sequenceMinimale) {
    throw rejeu({
      sequence: entete.sequence,
      minimale: sequenceMinimale,
      generation: entete.generation,
    });
  }

  const longueurTrouvee = entrees.reduce((somme, entree) => somme + (entree?.longueur ?? 0), 0);
  if (entrees.length !== entete.nombreEntrees || longueurTrouvee !== entete.longueurCharge) {
    throw troncature({
      trouvees: entrees.length,
      authentifiees: entete.nombreEntrees,
      longueurTrouvee,
      longueurAuthentifiee: entete.longueurCharge,
    });
  }

  if (!egalesEnTempsConstant(await empreinteDesEntrees(entrees), empreinteAuthentique)) {
    throw melange({
      generation: entete.generation,
      sequence: entete.sequence,
      nombreEntrees: entete.nombreEntrees,
    });
  }
}

/**
 * Ouvre une racine et confronte la génération trouvée à ce que la racine authentifie.
 *
 * @param {{ cle: CryptoKey, entete: object,
 *           scelle: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           entrees: Array<object>,
 *           attentes: { volume: string | null, formatVersion: number | null,
 *                       tailleVolume: number | null, sequenceMinimale: number | null } }} appel
 * @returns {Promise<{ entete: object, empreinteEntrees: Uint8Array }>}
 */
export async function ouvrirRacine({ cle, entete, scelle, entrees, attentes = {} }) {
  verifierAlgorithme(entete?.algorithme);
  exigerSceau(scelle, EMPREINTE_OCTETS);
  if (!Array.isArray(entrees)) {
    throw malforme("« entrees » doit être un tableau.");
  }

  const empreinteAuthentique = await dechiffrer(
    cle,
    scelle.nonce,
    encoderEnteteRacine(entete),
    assembler(scelle.chiffre, scelle.etiquette),
  );
  if (empreinteAuthentique === null) {
    throw sceauRefuse({
      volume: entete.volume,
      sequence: entete.sequence,
      generation: entete.generation,
    });
  }

  // L'en-tête est AUTHENTIQUE à partir d'ici. Les trois classements qui suivent sont donc établis.
  await classerGeneration(entete, entrees, empreinteAuthentique, attentes);
  return Object.freeze({
    entete: Object.freeze({ ...entete }),
    empreinteEntrees: empreinteAuthentique,
  });
}
