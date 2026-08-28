// Les PARAMÈTRES PUBLICS d'un dérivateur : leur encodage canonique et sa relecture (#22, ADR 0021).
//
// L'ADR 0020 les a réservés sans les lire : elle les TRANSPORTE et les AUTHENTIFIE — ils entrent
// dans les données associées de la DEK enveloppée — en les tenant pour opaques, sous un plafond de
// 512 octets. #22 tranche leur contenu, un encodage par type, et il n'en fait rien de plus qu'y
// écrire ce que le dérivateur doit relire pour refaire la même clé.
//
// ## Trois exigences, et aucune n'est décorative
//
//  1. **injectif.** Chaque champ est de largeur fixe ou préfixé de sa longueur. Sans cela, un
//    `rpId` allongé d'un signe et un identifiant de créance raccourci d'autant rendraient les
//    mêmes octets : la signature de l'ADR 0020 ne distinguerait plus deux emplacements, et une
//    créance pourrait être substituée sans que l'étiquette bronche ;
//  2. **relu STRICTEMENT.** Le décodeur refuse ce qu'il ne comprend pas plutôt que de compléter :
//    ni octet de queue toléré, ni longueur devinée, ni valeur par défaut. Ces octets viennent d'un
//    fichier qu'un adversaire peut avoir touché — ils sont authentifiés, donc son altération sera
//    vue, mais le décodeur ne doit pas dépendre de cet ordre-là pour rester sûr ;
//  3. **borné.** 512 octets, comme l'ADR 0020 l'a fixé, et la borne est vérifiée à l'écriture pour
//    qu'un identifiant de créance démesuré soit refusé au moment où on peut encore en parler à
//    l'utilisateur, pas au moment de sceller la page.
//
// ## Ils sont PUBLICS, et le fichier les porte en clair
//
// C'est le canal auxiliaire que l'ADR 0020 a déjà assumé : le fichier révèle le nombre de clés
// d'un volume et leur nature. #22 y ajoute le `rpId` et l'identifiant de créance d'une passkey.
// Rien de tout cela ne permet de deviner une clé ; un dérivateur DOIT pouvoir lire ses paramètres
// avant de dériver quoi que ce soit, et un paramètre chiffré serait un paramètre qu'il faudrait
// déjà avoir déverrouillé pour lire.

import { PARAMETRES_MAX, TYPES_KEK, nomDuTypeKek } from "../enveloppe/identite-enveloppe.mjs";
import { chainePrefixee, concatenerListe, entierEnOctets } from "../format-chiffre/octets.mjs";
import { hexEnOctets, octetsEnHex } from "../format-chiffre/octets.mjs";
import { parametresRefuses, typeInconnu } from "./derivation-errors.mjs";

/** Étiquette de domaine des paramètres d'une phrase. Elle sépare les deux encodages. */
export const ETIQUETTE_PHRASE = "railsbox-vault/derivation/v1/phrase";

/** Étiquette de domaine des paramètres d'une passkey. */
export const ETIQUETTE_PRF = "railsbox-vault/derivation/v1/webauthn-prf";

/** Sel d'un emplacement `phrase` : seize octets, la largeur que la RFC 9106 recommande. */
export const SEL_PHRASE_OCTETS = 16;

/** Sel d'un emplacement `webauthn-prf` : trente-deux octets, l'entrée `first` de l'extension. */
export const SEL_PRF_OCTETS = 32;

/** Lit un hexadécimal minuscule de longueur libre mais paire, et refuse le reste. */
function octetsDeHex(nom, valeur, largeurAttendue = null) {
  if (typeof valeur !== "string" || !/^[0-9a-f]*$/.test(valeur) || valeur.length % 2 !== 0) {
    throw parametresRefuses(`« ${nom} » doit être un hexadécimal minuscule de longueur paire.`, {
      champ: nom,
    });
  }
  if (largeurAttendue !== null && valeur.length !== largeurAttendue * 2) {
    throw parametresRefuses(
      `« ${nom} » doit faire ${largeurAttendue} octets, reçu ${valeur.length / 2}.`,
      { champ: nom, attendu: largeurAttendue },
    );
  }
  return hexEnOctets(valeur);
}

/** Exige un entier dans une plage. Une valeur approchante n'est pas une valeur. */
function entierBorne(nom, valeur, minimum, maximum) {
  if (!Number.isSafeInteger(valeur) || valeur < minimum || valeur > maximum) {
    throw parametresRefuses(
      `« ${nom} » doit être un entier de ${minimum} à ${maximum}, reçu ${valeur}.`,
      { champ: nom, minimum, maximum },
    );
  }
  return valeur;
}

/** Vérifie le plafond de l'ADR 0020 sur les octets produits. */
function sousLePlafond(octets) {
  if (octets.byteLength > PARAMETRES_MAX) {
    throw parametresRefuses(
      `ils font ${octets.byteLength} octets, au-delà du plafond de ${PARAMETRES_MAX} que l'ADR 0020 a fixé.`,
      { longueur: octets.byteLength, plafond: PARAMETRES_MAX },
    );
  }
  return octets;
}

/** Encode les paramètres d'un emplacement `phrase`. Le PLANCHER de coût est vérifié ailleurs. */
function encoderPhrase({ version, variante, memoireKio, iterations, parallelisme, sel }) {
  const octetsDuSel = octetsDeHex("sel", sel, SEL_PHRASE_OCTETS);
  return sousLePlafond(
    concatenerListe([
      chainePrefixee(ETIQUETTE_PHRASE),
      entierEnOctets(entierBorne("version", version, 0, 0xff), 1),
      entierEnOctets(entierBorne("variante", variante, 0, 0xff), 1),
      entierEnOctets(entierBorne("memoireKio", memoireKio, 1, 0xffffffff), 4),
      entierEnOctets(entierBorne("iterations", iterations, 1, 0xffffffff), 4),
      entierEnOctets(entierBorne("parallelisme", parallelisme, 1, 0xffffffff), 4),
      entierEnOctets(octetsDuSel.byteLength, 2),
      octetsDuSel,
    ]),
  );
}

/** Encode les paramètres d'un emplacement `webauthn-prf`. */
function encoderPrf({ rpId, identifiantCredential, sel }) {
  if (typeof rpId !== "string" || rpId.length === 0) {
    throw parametresRefuses("« rpId » doit être une chaîne non vide.", { champ: "rpId" });
  }
  const credential = octetsDeHex("identifiantCredential", identifiantCredential);
  if (credential.byteLength === 0) {
    throw parametresRefuses("« identifiantCredential » ne peut pas être vide.");
  }
  return sousLePlafond(
    concatenerListe([
      chainePrefixee(ETIQUETTE_PRF),
      chainePrefixee(rpId),
      entierEnOctets(credential.byteLength, 2),
      credential,
      entierEnOctets(SEL_PRF_OCTETS, 2),
      octetsDeHex("sel", sel, SEL_PRF_OCTETS),
    ]),
  );
}

/**
 * ENCODE les paramètres publics d'un dérivateur. Un type non servi est refusé, jamais deviné.
 *
 * @param {number} typeKek une valeur de `TYPES_KEK`
 * @param {Record<string, unknown>} valeurs
 * @returns {Uint8Array}
 */
export function encoderParametresPublics(typeKek, valeurs) {
  if (typeKek === TYPES_KEK.phrase) return encoderPhrase(valeurs);
  if (typeKek === TYPES_KEK["webauthn-prf"]) return encoderPrf(valeurs);
  throw typeInconnu({ typeKek, nom: nomDuTypeKek(typeKek) });
}

/** Curseur de lecture. Il refuse de lire au-delà : une lecture courte n'est jamais complétée. */
function lecteur(octets) {
  let curseur = 0;
  const prendre = (largeur, quoi) => {
    if (curseur + largeur > octets.byteLength) {
      throw parametresRefuses(
        `ils s'arrêtent avant « ${quoi} » : ${octets.byteLength} octets lus, ${curseur + largeur} attendus.`,
        { champ: quoi },
      );
    }
    const tranche = octets.subarray(curseur, curseur + largeur);
    curseur += largeur;
    return tranche;
  };
  return {
    entier: (largeur, quoi) => prendre(largeur, quoi).reduce((total, o) => total * 256 + o, 0),
    octets: (largeur, quoi) => prendre(largeur, quoi),
    texte: (quoi) => {
      const largeur = prendre(2, `${quoi} (longueur)`).reduce((total, o) => total * 256 + o, 0);
      return new TextDecoder().decode(prendre(largeur, quoi));
    },
    fin: () => {
      if (curseur !== octets.byteLength) {
        throw parametresRefuses(
          `${octets.byteLength - curseur} octet(s) suivent la fin de l'encodage. Une queue n'est jamais ignorée : elle voudrait dire que ces octets ne sont pas ceux qu'on croit.`,
        );
      }
    },
  };
}

/** Exige l'étiquette de domaine attendue, en tête. Deux encodages ne se confondent pas. */
function exigerEtiquette(lu, attendue) {
  const trouvee = lu.texte("étiquette de domaine");
  if (trouvee !== attendue) {
    throw parametresRefuses(
      `l'étiquette de domaine est « ${trouvee} » au lieu de « ${attendue} ». Ces octets décrivent un AUTRE dérivateur.`,
      { attendue, trouvee },
    );
  }
}

/** Relit les paramètres d'un emplacement `phrase`. */
function decoderPhrase(octets) {
  const lu = lecteur(octets);
  exigerEtiquette(lu, ETIQUETTE_PHRASE);
  const valeurs = {
    version: lu.entier(1, "version"),
    variante: lu.entier(1, "variante"),
    memoireKio: lu.entier(4, "memoireKio"),
    iterations: lu.entier(4, "iterations"),
    parallelisme: lu.entier(4, "parallelisme"),
  };
  const largeur = lu.entier(2, "sel (longueur)");
  const sel = octetsEnHex(lu.octets(largeur, "sel"));
  lu.fin();
  if (largeur !== SEL_PHRASE_OCTETS) {
    throw parametresRefuses(`le sel fait ${largeur} octets au lieu de ${SEL_PHRASE_OCTETS}.`);
  }
  return { ...valeurs, sel };
}

/** Relit les paramètres d'un emplacement `webauthn-prf`. */
function decoderPrf(octets) {
  const lu = lecteur(octets);
  exigerEtiquette(lu, ETIQUETTE_PRF);
  const rpId = lu.texte("rpId");
  const identifiantCredential = octetsEnHex(
    lu.octets(lu.entier(2, "identifiantCredential (longueur)"), "identifiantCredential"),
  );
  const largeur = lu.entier(2, "sel (longueur)");
  const sel = octetsEnHex(lu.octets(largeur, "sel"));
  lu.fin();
  if (largeur !== SEL_PRF_OCTETS) {
    throw parametresRefuses(`le sel fait ${largeur} octets au lieu de ${SEL_PRF_OCTETS}.`);
  }
  return { rpId, identifiantCredential, sel };
}

/**
 * RELIT les paramètres publics d'un emplacement. Un type non servi est refusé, jamais deviné.
 *
 * @param {number} typeKek
 * @param {Uint8Array} octets
 */
export function decoderParametresPublics(typeKek, octets) {
  if (!(octets instanceof Uint8Array)) {
    throw parametresRefuses("ils ne sont pas une suite d'octets.");
  }
  if (typeKek === TYPES_KEK.phrase) return decoderPhrase(octets);
  if (typeKek === TYPES_KEK["webauthn-prf"]) return decoderPrf(octets);
  throw typeInconnu({ typeKek, nom: nomDuTypeKek(typeKek) });
}
