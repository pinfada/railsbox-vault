// Le CODE de récupération : cent vingt-huit bits tirés, une forme lisible, une somme de contrôle
// (#147, ADR 0025).
//
// Ce module est PUR. Il n'importe que ses refus — ni enveloppe, ni volume, ni WebCrypto —, et une
// épreuve d'inspection de source le tient (`tests/unit/vm-derivation-recuperation.test.mjs` ›
// « le module de la somme de contrôle est PUR »). C'est ce qui rend la somme de contrôle
// indiscutablement NON-ORACLE : elle ne peut pas dépendre de ce qu'on cherche à ouvrir, puisqu'elle
// ne le connaît pas.
//
// ## Ce que le code EST, et ce qu'il n'est pas
//
// Seize octets de `crypto.getRandomValues`. Le chiffre publié est celui des octets TIRÉS, pas une
// « force » qu'on affirmerait : ce que le produit sait, c'est combien d'octets il a demandés au
// générateur du moteur. Le code n'est dérivé de rien, ne dépend d'aucun volume, et ne se retrouve
// pas — c'est tout l'objet de l'ADR 0025.
//
// ## La forme, et pourquoi Crockford
//
// L'alphabet base32 de Douglas Crockford écarte `I`, `L`, `O` et `U` : les trois premières se
// confondent à l'œil avec `1` et `0` sur une feuille imprimée, la quatrième est écartée pour ne pas
// composer de mot malheureux. Vingt-six symboles de cinq bits portent cent trente bits ; les cent
// vingt-huit du code en laissent DEUX, et ils sont à zéro — RELUS comme tels, jamais rognés : un
// bourrage non nul décrit une suite d'octets qui n'est pas un code de ce produit.
//
// Deux symboles de somme de contrôle suivent, soit vingt-huit symboles rendus en sept groupes de
// quatre séparés par des tirets. Les groupes et les tirets ne sont pas dans le secret : ils sont
// retirés à la saisie, comme les espaces.
//
// ## La somme de contrôle : ISO 7064, système PUR, M = 1021 et r = 32
//
// C'est la construction du système pur de l'ISO 7064 — celle de MOD 97-10, dont les deux chiffres
// de contrôle d'un IBAN sont l'usage le plus connu — instanciée en base 32 avec le plus grand
// nombre premier sous 1024 :
//
//     V = Σ  symbole_i · 32^(25−i)   (mod 1021),  sur les VINGT-SIX symboles de données
//     C = (1021 + 1 − (V · 1024 mod 1021)) mod 1021,  écrit en DEUX symboles base 32
//     vérification : Σ symbole_i · 32^(27−i) ≡ 1  (mod 1021),  sur les VINGT-HUIT symboles
//
// **Ce que cette construction achète se démontre, et ne s'observe pas seulement.** 1021 est
// premier, donc les entiers modulo 1021 forment un corps, et un produit de facteurs non nuls y est
// non nul :
//
//  - **toute substitution d'un symbole est détectée.** Remplacer le symbole de rang `k` par un
//    autre change la somme de δ · 32^(27−k), avec δ ∈ [−31, 31] \ {0}. Ni δ ni 32^(27−k) n'est nul
//    modulo 1021, donc la somme change, donc la vérification échoue. Les DEUX symboles de contrôle
//    sont couverts au même titre que les vingt-six autres : ils ont le même poids dans la somme ;
//  - **toute transposition de deux symboles adjacents est détectée.** Échanger `a` et `b` de rangs
//    consécutifs change la somme de −(a − b) · 31 · 32^k. Aucun des trois facteurs n'est nul
//    modulo 1021 quand `a ≠ b`, donc la somme change. Deux symboles ÉGAUX échangés ne changent pas
//    la chaîne : ce n'est pas une erreur, et rien n'a à la détecter.
//
// Les deux propriétés sont mesurées EXHAUSTIVEMENT sur des vecteurs figés — toutes les
// substitutions des vingt-huit rangs vers les trente et un autres symboles, toutes les
// transpositions adjacentes — parce qu'une démonstration écrite dans un commentaire n'est pas une
// démonstration que le code tient.
//
// ## Elle n'est PAS un oracle, et il faut le dire précisément
//
// Elle ne dépend NI du volume NI de l'enveloppe : c'est une fonction du code seul, calculable hors
// ligne par n'importe qui, sans rien tenir du coffre. Un adversaire qui énumère des codes calcule
// donc lui-même ses sommes de contrôle et n'essaie que des codes bien formés — ce qu'il aurait fait
// de toute façon. L'espace de recherche reste celui des cent vingt-huit bits tirés : les deux
// symboles de contrôle sont une FONCTION de ces bits, ils n'en ajoutent aucun et n'en retirent
// aucun. Ce que la somme sépare est un accident de recopie d'un code étranger, et rien d'autre.

import { codeMalRecopie } from "./derivation-errors.mjs";

/**
 * L'alphabet base32 de Crockford : les dix chiffres, puis les vingt-deux lettres qui restent une
 * fois `I`, `L`, `O` et `U` écartées.
 */
export const ALPHABET_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Largeur du code, en octets TIRÉS. Cent vingt-huit bits. */
export const CODE_OCTETS = 16;

/** Symboles portant les cent vingt-huit bits, bourrage compris : ⌈128 / 5⌉. */
export const SYMBOLES_DONNEES = 26;

/** Symboles de somme de contrôle. Deux, parce que 1021 ne tient pas sur un symbole. */
export const SYMBOLES_CONTROLE = 2;

/** Symboles rendus à l'utilisateur, séparateurs exclus. */
export const SYMBOLES_TOTAL = SYMBOLES_DONNEES + SYMBOLES_CONTROLE;

/** Taille d'un groupe à l'affichage. Sept groupes de quatre, séparés par des tirets. */
export const SYMBOLES_PAR_GROUPE = 4;

/** Le module PREMIER de la somme de contrôle. Le plus grand sous 32² = 1024. */
export const MODULE_CONTROLE = 1021;

/** Bits portés par un symbole. */
const BITS_PAR_SYMBOLE = 5;

/**
 * Le REPLI de Crockford : les trois signes que l'alphabet écarte parce qu'ils se confondent à
 * l'œil sont ramenés sur celui qu'ils imitent. C'est une tolérance de LECTURE, pas un élargissement
 * de l'alphabet : le code rendu ne porte jamais ces signes.
 */
const REPLIS = new Map([
  ["O", "0"],
  ["I", "1"],
  ["L", "1"],
]);

/**
 * Ce qui SÉPARE les groupes, par point de code, et que la saisie retire : le tiret du rendu, les
 * deux tirets longs qu'un traitement de texte substitue au premier, l'espace ordinaire, l'espace
 * insécable, l'espace fine insécable, la tabulation, et les deux fins de ligne.
 */
const SEPARATEURS = new Set([0x2d, 0x2013, 0x2014, 0x20, 0xa0, 0x202f, 0x09, 0x0a, 0x0d]);

/** TIRE un code : seize octets, et pas un de moins. C'est la seule source d'entropie de ce moyen. */
export function tirerCodeDeRecuperation() {
  return crypto.getRandomValues(new Uint8Array(CODE_OCTETS));
}

/** Exige les seize octets. Une largeur approchante n'est pas une largeur. */
function exigerLesOctets(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== CODE_OCTETS) {
    throw codeMalRecopie(
      `il porte ${octets?.byteLength ?? "une largeur inconnue"} octet(s) au lieu de ${CODE_OCTETS}.`,
      { attendu: CODE_OCTETS },
    );
  }
  return octets;
}

/**
 * Les VINGT-SIX symboles des seize octets, cinq bits à la fois, du poids fort au poids faible.
 *
 * Les deux derniers bits du dernier symbole sont le BOURRAGE, et ils valent zéro par construction.
 */
export function symbolesDesOctets(octets) {
  exigerLesOctets(octets);
  const symboles = [];
  let tampon = 0;
  let bits = 0;
  for (const octet of octets) {
    tampon = (tampon << 8) | octet;
    bits += 8;
    while (bits >= BITS_PAR_SYMBOLE) {
      bits -= BITS_PAR_SYMBOLE;
      symboles.push((tampon >>> bits) & 31);
    }
  }
  // 128 = 25 × 5 + 3 : trois bits restent, et le bourrage les complète par deux zéros.
  symboles.push((tampon << (BITS_PAR_SYMBOLE - bits)) & 31);
  return symboles;
}

/**
 * Les seize octets de VINGT-SIX symboles, et le refus d'un bourrage non nul.
 *
 * Le bourrage est RELU. Le rogner accepterait quatre suites de symboles distinctes pour le même
 * code, c'est-à-dire quatre écritures d'un secret qui n'en a qu'une — et la somme de contrôle,
 * calculée sur les symboles, ne serait plus une fonction des octets.
 */
export function octetsDesSymboles(symboles) {
  exigerLesSymboles(symboles, SYMBOLES_DONNEES);
  const octets = new Uint8Array(CODE_OCTETS);
  let tampon = 0;
  let bits = 0;
  let rang = 0;
  for (const symbole of symboles) {
    tampon = (tampon << BITS_PAR_SYMBOLE) | symbole;
    bits += BITS_PAR_SYMBOLE;
    while (bits >= 8) {
      bits -= 8;
      octets[rang] = (tampon >>> bits) & 0xff;
      rang += 1;
    }
  }
  if ((tampon & 0b11) !== 0) {
    throw codeMalRecopie(
      "ses deux derniers bits ne sont pas nuls. Un code de ce produit porte cent vingt-huit bits dans vingt-six symboles, et le bourrage y vaut zéro : ces symboles décrivent autre chose.",
      { bourrage: tampon & 0b11 },
    );
  }
  return octets;
}

/** Exige une liste de valeurs de symbole, de longueur exacte. */
function exigerLesSymboles(symboles, longueur) {
  if (!Array.isArray(symboles) || symboles.length !== longueur) {
    throw codeMalRecopie(
      `il porte ${Array.isArray(symboles) ? symboles.length : "autre chose que"} symbole(s) au lieu de ${longueur}.`,
      { attendu: longueur },
    );
  }
  for (const symbole of symboles) {
    if (!Number.isInteger(symbole) || symbole < 0 || symbole >= ALPHABET_CROCKFORD.length) {
      throw codeMalRecopie(`« ${symbole} » n'est pas une valeur de symbole base 32.`);
    }
  }
  return symboles;
}

/** Le résidu modulo 1021 d'une suite de symboles lue comme un entier en base 32. */
function residu(symboles) {
  let reste = 0;
  for (const symbole of symboles) {
    reste = (reste * ALPHABET_CROCKFORD.length + symbole) % MODULE_CONTROLE;
  }
  return reste;
}

/**
 * Les DEUX symboles de somme de contrôle des vingt-six symboles de données.
 *
 * @param {number[]} donnees vingt-six valeurs de symbole
 * @returns {number[]} deux valeurs de symbole
 */
export function sommeDeControle(donnees) {
  exigerLesSymboles(donnees, SYMBOLES_DONNEES);
  const decale =
    (residu(donnees) * ALPHABET_CROCKFORD.length ** SYMBOLES_CONTROLE) % MODULE_CONTROLE;
  const controle = (MODULE_CONTROLE + 1 - decale) % MODULE_CONTROLE;
  return [Math.floor(controle / ALPHABET_CROCKFORD.length), controle % ALPHABET_CROCKFORD.length];
}

/** Vrai si les VINGT-HUIT symboles vérifient : la somme vaut 1 modulo 1021. */
export function sommeDeControleValide(symboles) {
  if (!Array.isArray(symboles) || symboles.length !== SYMBOLES_TOTAL) return false;
  for (const symbole of symboles) {
    if (!Number.isInteger(symbole) || symbole < 0 || symbole >= ALPHABET_CROCKFORD.length) {
      return false;
    }
  }
  return residu(symboles) === 1;
}

/** ÉCRIT le code : vingt-huit symboles, en sept groupes de quatre séparés par des tirets. */
export function encoderCode(octets) {
  const donnees = symbolesDesOctets(octets);
  const symboles = [...donnees, ...sommeDeControle(donnees)];
  const lettres = symboles.map((symbole) => ALPHABET_CROCKFORD[symbole]).join("");
  const groupes = [];
  for (let debut = 0; debut < lettres.length; debut += SYMBOLES_PAR_GROUPE) {
    groupes.push(lettres.slice(debut, debut + SYMBOLES_PAR_GROUPE));
  }
  return groupes.join("-");
}

/**
 * NORMALISE une saisie humaine et rend ses vingt-huit valeurs de symbole.
 *
 * Dans cet ordre, et l'ordre compte : NFC (ADR 0021, même discipline que la phrase), majuscule,
 * retrait des séparateurs, repli de Crockford. Tout autre signe est REFUSÉ — pas ignoré : un
 * signe ignoré ferait accepter deux saisies différentes pour un même code, et le produit
 * accepterait alors quelque chose qu'il n'a jamais écrit.
 *
 * Un chiffre PLEINE CHASSE (`０`, U+FF10) est le cas qui distingue les quatre formes de
 * normalisation : NFC et NFD le LAISSENT — il est donc refusé —, là où NFKC et NFKD le ramèneraient
 * à `0`. Choisir une forme de compatibilité ferait accepter un code que celui-ci refuse, et le
 * vecteur figé dit laquelle est appliquée.
 */
export function normaliserSaisie(texte) {
  if (typeof texte !== "string") {
    throw codeMalRecopie(`ce n'est pas une chaîne de caractères (${typeof texte}).`);
  }
  const symboles = [];
  for (const signe of texte.normalize("NFC")) {
    if (SEPARATEURS.has(signe.codePointAt(0))) continue;
    const majuscule = signe.toUpperCase();
    const replie = REPLIS.get(majuscule) ?? majuscule;
    const valeur = replie.length === 1 ? ALPHABET_CROCKFORD.indexOf(replie) : -1;
    if (valeur === -1) {
      // Le signe est NOMMÉ dans le message, et rien d'autre de la saisie ne l'est. C'est le même
      // arbitrage que celui de l'ADR 0021 sur le contexte d'un refus PRF — « la forme, jamais le
      // résultat » —, tranché ici dans l'autre sens pour une raison qui tient : ce signe est par
      // construction ABSENT de l'alphabet et de ses replis, il ne porte donc aucun bit d'un code
      // valide, et le montrer est exactement ce qui dit à l'utilisateur quoi corriger. Le contexte,
      // lui, ne le reprend pas : un message se lit une fois, un contexte voyage.
      throw codeMalRecopie(
        `le signe « ${signe} » n'appartient pas à l'alphabet base 32 de Crockford, et aucun repli ne l'y ramène.`,
      );
    }
    symboles.push(valeur);
  }
  if (symboles.length !== SYMBOLES_TOTAL) {
    throw codeMalRecopie(
      `il porte ${symboles.length} symbole(s) au lieu de ${SYMBOLES_TOTAL}, séparateurs retirés.`,
      { attendu: SYMBOLES_TOTAL, recu: symboles.length },
    );
  }
  return symboles;
}

/**
 * RELIT un code saisi et rend ses seize octets.
 *
 * La somme de contrôle est vérifiée ICI, c'est-à-dire AVANT que quoi que ce soit ne soit dérivé.
 * C'est ce qui sépare « mal recopié » — un refus de ce module, qui ne dépend que du code — de
 * « mauvais code », qui n'existe pas ici : un code bien formé mais étranger rend une AUTRE clé, et
 * c'est l'enveloppe qui tranche, par `VAULT_ENVELOPPE_CLE_REFUSEE`.
 */
export function decoderCode(saisie) {
  const symboles = normaliserSaisie(saisie);
  if (!sommeDeControleValide(symboles)) {
    throw codeMalRecopie(
      "sa somme de contrôle ne vérifie pas. Un symbole a été mal lu, ou deux voisins ont été échangés — les deux sont détectés. Relisez le code que le produit vous a rendu ; ce n'est PAS le refus d'un code étranger, qui serait celui de l'enveloppe.",
    );
  }
  return octetsDesSymboles(symboles.slice(0, SYMBOLES_DONNEES));
}
