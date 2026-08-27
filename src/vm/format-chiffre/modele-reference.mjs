// Modèle de référence du format chiffré (#17, ADR 0015).
//
// Ce module est une SPÉCIFICATION EXÉCUTABLE, pas un chemin de production. Il ne touche ni au
// support, ni au manifeste, ni au journal de génération : il scelle et ouvre des structures EN
// MÉMOIRE, et les vecteurs qu'il produit (`tests/vectors/format-chiffre-v1.json`) sont ce que #18 et
// #19 devront reproduire octet pour octet. Le rapport est celui de l'oracle de #15 à
// l'implémentation de #16 : le juge est écrit avant, et séparément.
//
// Quatre gestes, et rien d'autre : `scellerBloc`, `ouvrirBloc`, `scellerRacine`, `ouvrirRacine`. La
// clé de volume est REÇUE, jamais dérivée ni conservée : l'enveloppe DEK/KEK, le déverrouillage et
// la récupération sont l'objet de #21 (jalon 5). Ce que cela suppose est écrit dans l'ADR 0015 : le
// modèle tient pour acquis que la clé qu'on lui remet est aléatoire, propre à ce volume, et que sa
// vie en mémoire est celle du Worker de confiance de l'ADR 0002.
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
// Deux menaces échappent à cette règle et le disent : modification et déplacement ne se distinguent
// pas. Voir `crypto-errors.mjs`.

import {
  identiteIncoherente,
  malforme,
  melange,
  rejeu,
  sceauRefuse,
  troncature,
} from "./crypto-errors.mjs";
import {
  ALGORITHME_WEBCRYPTO,
  CLE_OCTETS,
  DOMAINE_BLOC,
  DOMAINE_RACINE,
  EMPREINTE_OCTETS,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  construireNonce,
  encoderEnteteRacine,
  encoderEntrees,
  encoderIdentiteBloc,
  verifierAlgorithme,
  verifierBudgetDeCle,
  verifierRangsDistincts,
} from "./identite-logique.mjs";
import { egalesEnTempsConstant } from "./octets.mjs";

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

function separerEtiquette(brut) {
  const octets = new Uint8Array(brut);
  return Object.freeze({
    chiffre: octets.slice(0, octets.byteLength - ETIQUETTE_OCTETS),
    etiquette: octets.slice(octets.byteLength - ETIQUETTE_OCTETS),
  });
}

function assembler(chiffre, etiquette) {
  const brut = new Uint8Array(chiffre.byteLength + etiquette.byteLength);
  brut.set(chiffre, 0);
  brut.set(etiquette, chiffre.byteLength);
  return brut;
}

/** Empreinte SHA-256 de la suite canonique des entrées d'une génération. */
export async function empreinteDesEntrees(entrees) {
  const empreinte = await crypto.subtle.digest("SHA-256", encoderEntrees(entrees));
  return new Uint8Array(empreinte);
}

/**
 * Scelle un bloc sous son identité logique.
 *
 * @param {{ cle: CryptoKey, identite: object, contenu: Uint8Array,
 *           attentes?: { scellementsCumules?: number } }} appel
 * @returns {Promise<{ nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array }>}
 */
export async function scellerBloc({ cle, identite, contenu, attentes = {} }) {
  verifierAlgorithme(identite?.algorithme);
  if (attentes.scellementsCumules !== undefined) {
    verifierBudgetDeCle(attentes.scellementsCumules);
  }
  if (!(contenu instanceof Uint8Array)) {
    throw malforme("« contenu » doit être une suite d'octets.");
  }
  if (contenu.byteLength !== identite?.longueur) {
    throw malforme(
      `« contenu » fait ${contenu.byteLength} octets alors que l'identité en déclare ${identite?.longueur}. Une longueur devinée n'est pas une longueur.`,
      { recu: contenu.byteLength, declare: identite?.longueur },
    );
  }

  const nonce = construireNonce({
    domaine: DOMAINE_BLOC,
    generation: identite.generation,
    rang: identite.rang,
  });
  const donneesAssociees = encoderIdentiteBloc(identite);
  const brut = await crypto.subtle.encrypt(
    {
      name: ALGORITHME_WEBCRYPTO,
      iv: nonce,
      additionalData: donneesAssociees,
      tagLength: ETIQUETTE_BITS,
    },
    cle,
    contenu,
  );
  return Object.freeze({ nonce, ...separerEtiquette(brut) });
}

/**
 * Ouvre un bloc sous l'identité logique que l'appelant présente. Tout écart est un refus typé.
 *
 * `attentes.generationMinimale` est le seul moyen de refuser un bloc AUTHENTIQUE mais ancien. D'où
 * ce minimum vient décide de ce que la propriété vaut : la racine de la génération en cours pour le
 * journal, et RIEN pour un secteur relu du volume — l'ADR 0015 nomme ce résidu et ne le masque pas.
 *
 * @param {{ cle: CryptoKey, identite: object,
 *           scelle: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           attentes?: { generationMinimale?: number } }} appel
 * @returns {Promise<Uint8Array>} le clair, ou un refus
 */
export async function ouvrirBloc({ cle, identite, scelle, attentes = {} }) {
  verifierAlgorithme(identite?.algorithme);
  exigerOctets("scelle.nonce", scelle?.nonce, NONCE_OCTETS);
  exigerOctets("scelle.etiquette", scelle?.etiquette, ETIQUETTE_OCTETS);
  if (!(scelle.chiffre instanceof Uint8Array)) {
    throw malforme("« scelle.chiffre » doit être une suite d'octets.");
  }

  const attendu = construireNonce({
    domaine: DOMAINE_BLOC,
    generation: identite.generation,
    rang: identite.rang,
  });
  if (!egalesEnTempsConstant(attendu, scelle.nonce)) {
    throw identiteIncoherente("le nonce conservé n'encode pas la génération et le rang annoncés.", {
      generation: identite.generation,
      rang: identite.rang,
    });
  }

  const donneesAssociees = encoderIdentiteBloc(identite);
  let clair;
  try {
    clair = await crypto.subtle.decrypt(
      {
        name: ALGORITHME_WEBCRYPTO,
        iv: scelle.nonce,
        additionalData: donneesAssociees,
        tagLength: ETIQUETTE_BITS,
      },
      cle,
      assembler(scelle.chiffre, scelle.etiquette),
    );
  } catch {
    throw sceauRefuse({
      volume: identite.volume,
      adresse: identite.adresse,
      formatVersion: identite.formatVersion,
      generation: identite.generation,
    });
  }

  // À partir d'ici SEULEMENT, la génération est authentique : la classer plus tôt serait deviner.
  if (
    attentes.generationMinimale !== undefined &&
    identite.generation < attentes.generationMinimale
  ) {
    throw rejeu({
      generation: identite.generation,
      minimale: attentes.generationMinimale,
      adresse: identite.adresse,
    });
  }
  return new Uint8Array(clair);
}

/**
 * Scelle la racine d'une génération : ce qu'elle contient, en quel nombre, et sous quelle séquence.
 *
 * Le compte et la longueur de charge sont DÉRIVÉS des entrées, jamais reçus de l'appelant : une
 * racine qui annoncerait un compte différent de ce qu'elle scelle serait une troncature signée par
 * le producteur lui-même.
 *
 * @param {{ cle: CryptoKey, racine: object, entrees: Array<object> }} appel
 */
export async function scellerRacine({ cle, racine, entrees }) {
  verifierAlgorithme(racine?.algorithme);
  verifierBudgetDeCle(racine?.scellementsCumules ?? 0);
  if (!Array.isArray(entrees)) {
    throw malforme("« entrees » doit être un tableau.");
  }
  verifierRangsDistincts(entrees);

  const entete = Object.freeze({
    volume: racine.volume,
    formatVersion: racine.formatVersion,
    sequence: racine.sequence,
    generation: racine.generation,
    tailleVolume: racine.tailleVolume,
    nombreEntrees: entrees.length,
    longueurCharge: entrees.reduce((somme, entree) => somme + (entree?.longueur ?? 0), 0),
    scellementsCumules: racine.scellementsCumules ?? 0,
  });

  const empreinteEntrees = await empreinteDesEntrees(entrees);
  const nonce = construireNonce({
    domaine: DOMAINE_RACINE,
    generation: entete.generation,
    rang: entete.sequence,
  });
  const brut = await crypto.subtle.encrypt(
    {
      name: ALGORITHME_WEBCRYPTO,
      iv: nonce,
      additionalData: encoderEnteteRacine(entete),
      tagLength: ETIQUETTE_BITS,
    },
    cle,
    empreinteEntrees,
  );
  return Object.freeze({ entete, nonce, empreinteEntrees, ...separerEtiquette(brut) });
}

/** Vérifie que l'en-tête AUTHENTIFIÉ décrit bien le volume que l'appelant croit ouvrir. */
function verifierIdentiteRacine(entete, attentes) {
  const ecarts = [
    ["volume", attentes.volume],
    ["formatVersion", attentes.formatVersion],
    ["tailleVolume", attentes.tailleVolume],
  ].filter(([champ, attendu]) => attendu !== undefined && entete[champ] !== attendu);

  if (ecarts.length > 0) {
    throw identiteIncoherente(
      `la racine est authentique mais décrit ${ecarts.map(([champ]) => `un autre « ${champ} »`).join(", ")}.`,
      {
        ecarts: Object.fromEntries(
          ecarts.map(([champ, attendu]) => [champ, { attendu, trouve: entete[champ] }]),
        ),
      },
    );
  }
}

/**
 * Ouvre une racine et confronte la génération trouvée à ce que la racine authentifie.
 *
 * @param {{ cle: CryptoKey, entete: object,
 *           scelle: { nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array },
 *           entrees: Array<object>,
 *           attentes?: { volume?: string, formatVersion?: number, tailleVolume?: number,
 *                        sequenceMinimale?: number } }} appel
 * @returns {Promise<{ entete: object, empreinteEntrees: Uint8Array }>}
 */
export async function ouvrirRacine({ cle, entete, scelle, entrees, attentes = {} }) {
  verifierAlgorithme(entete?.algorithme);
  exigerOctets("scelle.nonce", scelle?.nonce, NONCE_OCTETS);
  exigerOctets("scelle.chiffre", scelle?.chiffre, EMPREINTE_OCTETS);
  exigerOctets("scelle.etiquette", scelle?.etiquette, ETIQUETTE_OCTETS);
  if (!Array.isArray(entrees)) {
    throw malforme("« entrees » doit être un tableau.");
  }

  const attendu = construireNonce({
    domaine: DOMAINE_RACINE,
    generation: entete.generation,
    rang: entete.sequence,
  });
  if (!egalesEnTempsConstant(attendu, scelle.nonce)) {
    throw identiteIncoherente("le nonce de la racine n'encode pas sa génération et sa séquence.", {
      generation: entete.generation,
      sequence: entete.sequence,
    });
  }

  let empreinteAuthentique;
  try {
    empreinteAuthentique = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ALGORITHME_WEBCRYPTO,
          iv: scelle.nonce,
          additionalData: encoderEnteteRacine(entete),
          tagLength: ETIQUETTE_BITS,
        },
        cle,
        assembler(scelle.chiffre, scelle.etiquette),
      ),
    );
  } catch {
    throw sceauRefuse({
      volume: entete.volume,
      sequence: entete.sequence,
      generation: entete.generation,
    });
  }

  // L'en-tête est AUTHENTIQUE à partir d'ici. Les trois classements qui suivent sont donc établis.
  verifierIdentiteRacine(entete, attentes);

  if (attentes.sequenceMinimale !== undefined && entete.sequence < attentes.sequenceMinimale) {
    throw rejeu({
      sequence: entete.sequence,
      minimale: attentes.sequenceMinimale,
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

  const empreinteTrouvee = await empreinteDesEntrees(entrees);
  if (!egalesEnTempsConstant(empreinteTrouvee, empreinteAuthentique)) {
    throw melange({
      generation: entete.generation,
      sequence: entete.sequence,
      nombreEntrees: entete.nombreEntrees,
    });
  }

  return Object.freeze({
    entete: Object.freeze({ ...entete }),
    empreinteEntrees: empreinteAuthentique,
  });
}
