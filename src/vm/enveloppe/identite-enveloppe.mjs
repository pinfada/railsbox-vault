// Identité, bornes et encodages canoniques de l'enveloppe de clé (#21, ADR 0020).
//
// Ce module ne chiffre rien et ne touche à aucun support. Il définit les OCTETS que le scellement
// lie — les données associées d'une DEK enveloppée, celles de la racine, et l'encodage canonique de
// la suite ordonnée des emplacements. Il est pur, pour qu'un relecteur externe (#20) puisse en juger
// sans exécuter quoi que ce soit.
//
// ## Il ne redécide RIEN de l'ADR 0015
//
// Primitive, longueur d'étiquette, longueur de nonce, largeur de clé, budget par clé et règle
// d'injectivité des encodages viennent de `../format-chiffre/identite-logique.mjs` et n'y sont pas
// dupliqués : deux définitions du même paramètre finissent toujours par diverger. En particulier
// **AES-KW n'est pas employé**, alors que c'est l'algorithme d'enveloppement de clé de WebCrypto :
// il n'authentifie AUCUNE donnée associée, si bien qu'une DEK enveloppée sous AES-KW pourrait être
// déplacée d'un emplacement à l'autre, ou d'un volume à l'autre, sans que rien ne bronche. C'est
// exactement la propriété que cette tranche doit tenir. L'ADR 0015 l'écarte déjà en une ligne ;
// l'ADR 0020 dit pourquoi cette ligne compte ici plus qu'ailleurs.
//
// ## Ce que les données associées lient, et pourquoi ces champs-là
//
// Une DEK enveloppée porte en données associées l'identifiant de VOLUME, l'identifiant
// d'EMPLACEMENT, la version de FORMAT, le TYPE de clé de déverrouillage et les PARAMÈTRES PUBLICS
// du dérivateur. Les trois premiers sont exigés par le contrat de #21. Les deux derniers sont un
// ajout de cette tranche, et il a une raison qui vaut d'être écrite : #22 dérivera une KEK d'une
// phrase secrète, et les paramètres de cette dérivation — sel, coût mémoire, coût temps — vivront
// en clair dans l'emplacement. S'ils n'étaient pas authentifiés, un adversaire ayant accès au
// fichier pourrait les ramener à un coût dérisoire ; l'utilisateur taperait la même phrase, la
// dérivation produirait une AUTRE clé, et l'ouverture échouerait — mais l'adversaire, lui, aurait
// obtenu que le fichier VOLÉ soit cassable à bas coût s'il en garde une copie antérieure. Les lier
// ici coûte zéro octet et ferme la question avant qu'elle ne se pose.

import {
  ALGORITHME,
  ALGORITHME_WEBCRYPTO,
  CLE_OCTETS,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  tirerNonce,
} from "../format-chiffre/identite-logique.mjs";
import { chainePrefixee, concatenerListe, entierEnOctets } from "../format-chiffre/octets.mjs";
import { malforme } from "./enveloppe-errors.mjs";

export {
  ALGORITHME,
  ALGORITHME_WEBCRYPTO,
  CLE_OCTETS,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  tirerNonce,
};

/** Version du FORMAT D'ENVELOPPE. Distincte de la version du volume et de celle du modèle chiffré. */
export const ENVELOPPE_FORMAT_V1 = 1;

/** Empreinte de la suite ordonnée des emplacements : SHA-256, comme celle des entrées d'#17. */
export const EMPREINTE_OCTETS = 32;

/** Identifiant d'emplacement : huit octets tirés, rendus en seize hexadécimaux minuscules. */
export const IDENTIFIANT_EMPLACEMENT_OCTETS = 8;

/**
 * Nombre maximal d'emplacements dans une enveloppe, et pourquoi HUIT.
 *
 * Le plafond n'est pas une prudence vague : il borne à la fois la taille de la page — donc l'écriture
 * atomique — et le COÛT du refus. `ouvrir` essaie TOUS les emplacements, sans court-circuit, parce
 * que c'est ce qui rend une clé révoquée et une clé inconnue indiscernables ; ce travail est donc
 * payé à chaque tentative, réussie ou non. Huit tentatives AES-GCM sur 48 octets sont négligeables
 * (mesure publiée dans l'ADR 0020), là où un plafond de plusieurs centaines aurait fait du refus un
 * levier d'épuisement.
 *
 * Huit couvre l'usage visé sans marge inutile : une phrase secrète (#22), deux à trois passkeys sur
 * autant d'appareils (#22), un ou deux moyens de récupération (#23), et de la place pour une
 * rotation — remplacer sans révoquer d'abord. Le franchir demandera une version de format.
 */
export const EMPLACEMENTS_MAX = 8;

/**
 * Longueur maximale des paramètres publics d'un dérivateur, en octets.
 *
 * Ils sont OPAQUES ici : #21 ne les lit pas, ne les interprète pas et n'en dépend pas — il les
 * transporte et les AUTHENTIFIE. La borne existe pour que la page reste de taille fixe. 512 octets
 * accueillent largement un sel Argon2id et ses trois coûts, ou un sel de PRF WebAuthn avec
 * l'identifiant d'une créance ; #22 tranchera leur contenu exact et pourra la relever sous une
 * version de format s'il démontre qu'elle ne suffit pas.
 */
export const PARAMETRES_MAX = 512;

/**
 * Types de clé de déverrouillage. Les valeurs sont RÉSERVÉES ici et servies par #22 ; `harnais` est
 * le seul que cette tranche produise, et il est nommé pour ce qu'il est.
 */
export const TYPES_KEK = Object.freeze({
  phrase: 1,
  "webauthn-prf": 2,
  harnais: 3,
});

const TYPES_PAR_VALEUR = Object.freeze(
  Object.fromEntries(Object.entries(TYPES_KEK).map(([nom, valeur]) => [valeur, nom])),
);

/** Nom d'un type de clé de déverrouillage, ou `null` si la valeur n'en désigne aucun. */
export function nomDuTypeKek(valeur) {
  return TYPES_PAR_VALEUR[valeur] ?? null;
}

/** Étiquette de domaine d'une DEK enveloppée. Elle entre dans les données associées. */
export const ETIQUETTE_DOMAINE_EMPLACEMENT = "railsbox-vault/enveloppe/v1/emplacement";

/** Étiquette de domaine de la racine authentifiée d'un fichier d'enveloppes. */
export const ETIQUETTE_DOMAINE_RACINE = "railsbox-vault/enveloppe/v1/racine";

/** Étiquette de domaine de l'empreinte de la suite ordonnée des emplacements. */
export const ETIQUETTE_DOMAINE_EMPLACEMENTS = "railsbox-vault/enveloppe/v1/emplacements";

/** Plus grand compteur de version représentable (2^48 − 1), sur les huit octets encodés. */
export const VERSION_MAX = 2 ** 48 - 1;

function entierBorne(nom, valeur, maximum) {
  if (!Number.isSafeInteger(valeur) || valeur < 0 || valeur > maximum) {
    throw malforme(`« ${nom} » doit être un entier de 0 à ${maximum}, reçu ${valeur}.`, {
      champ: nom,
      valeur,
      maximum,
    });
  }
  return valeur;
}

/** Exige une chaîne hexadécimale minuscule de longueur exacte. Une forme approchante est un refus. */
function hexadecimal(nom, valeur, octets) {
  const attendu = new RegExp(`^[0-9a-f]{${octets * 2}}$`);
  if (typeof valeur !== "string" || !attendu.test(valeur)) {
    throw malforme(
      `« ${nom} » doit être ${octets * 2} hexadécimaux minuscules, reçu ${JSON.stringify(valeur)}.`,
      { champ: nom, attendu: octets * 2 },
    );
  }
  return valeur;
}

/** Exige des paramètres publics : une suite d'octets, éventuellement vide, sous le plafond. */
export function exigerParametres(parametres) {
  if (!(parametres instanceof Uint8Array)) {
    throw malforme("« parametres » doit être une suite d'octets, fût-elle vide.");
  }
  if (parametres.byteLength > PARAMETRES_MAX) {
    throw malforme(
      `« parametres » fait ${parametres.byteLength} octets, au-delà du plafond de ${PARAMETRES_MAX}.`,
      { longueur: parametres.byteLength, plafond: PARAMETRES_MAX },
    );
  }
  return parametres;
}

/** Exige un type de clé de déverrouillage RÉSERVÉ. Un type inconnu n'est jamais deviné. */
export function exigerTypeKek(typeKek) {
  if (nomDuTypeKek(typeKek) === null) {
    throw malforme(
      `« typeKek » vaut ${typeKek}, qui ne désigne aucun type réservé (${Object.keys(TYPES_KEK).join(", ")}).`,
      { typeKek },
    );
  }
  return typeKek;
}

/**
 * Données associées d'une DEK enveloppée : l'identité COMPLÈTE de l'emplacement.
 *
 * Chaque champ est de largeur fixe ou préfixé de sa longueur : deux identités distinctes ne peuvent
 * pas rendre la même chaîne d'octets. C'est la condition pour que « lier l'emplacement » veuille
 * dire quelque chose — sans préfixe, un caractère glissé d'un champ à l'autre laisserait les octets
 * inchangés, donc l'étiquette muette, donc la DEK déplaçable.
 *
 * @param {{ identifiantVolume: string, identifiantEmplacement: string, formatVersion: number,
 *           typeKek: number, parametres: Uint8Array }} emplacement
 */
export function encoderAssociationEmplacement({
  identifiantVolume,
  identifiantEmplacement,
  formatVersion,
  typeKek,
  parametres,
}) {
  hexadecimal("identifiantVolume", identifiantVolume, 16);
  hexadecimal("identifiantEmplacement", identifiantEmplacement, IDENTIFIANT_EMPLACEMENT_OCTETS);
  entierBorne("formatVersion", formatVersion, 0xffffffff);
  exigerTypeKek(typeKek);
  exigerParametres(parametres);

  return concatenerListe([
    chainePrefixee(ETIQUETTE_DOMAINE_EMPLACEMENT),
    chainePrefixee(ALGORITHME),
    entierEnOctets(formatVersion, 4),
    chainePrefixee(identifiantVolume),
    chainePrefixee(identifiantEmplacement),
    entierEnOctets(typeKek, 1),
    entierEnOctets(parametres.byteLength, 2),
    parametres,
  ]);
}

/**
 * Données associées de la RACINE : ce que l'enveloppe affirme d'elle-même.
 *
 * Le compte des emplacements y est, la LONGUEUR de la liste n'y est pas — et cet écart est le
 * mécanisme même du refus de troncature. La longueur vit dans l'en-tête sur disque, hors des données
 * associées : un adversaire qui retire un emplacement et rectifie la longueur laisse les données
 * associées intactes, l'étiquette vérifie donc, et c'est APRÈS cette vérification que le compte
 * trouvé est confronté au compte authentifié. Le verdict « troncature » est alors ÉTABLI, jamais
 * deviné — c'est l'ordre de l'ADR 0015, transposé.
 *
 * @param {{ identifiantVolume: string, formatVersion: number, version: number,
 *           nombreEmplacements: number }} entete
 */
export function encoderEnteteEnveloppe({
  identifiantVolume,
  formatVersion,
  version,
  nombreEmplacements,
}) {
  hexadecimal("identifiantVolume", identifiantVolume, 16);
  entierBorne("formatVersion", formatVersion, 0xffffffff);
  entierBorne("version", version, VERSION_MAX);
  entierBorne("nombreEmplacements", nombreEmplacements, EMPLACEMENTS_MAX);

  return concatenerListe([
    chainePrefixee(ETIQUETTE_DOMAINE_RACINE),
    chainePrefixee(ALGORITHME),
    entierEnOctets(formatVersion, 4),
    chainePrefixee(identifiantVolume),
    entierEnOctets(version, 8),
    entierEnOctets(nombreEmplacements, 2),
  ]);
}

/**
 * Encodage canonique de la SUITE ORDONNÉE des emplacements, dont la racine scelle l'empreinte.
 *
 * Chaque emplacement y porte son identifiant, son type, ses paramètres, son nonce et son ÉTIQUETTE —
 * pas la DEK enveloppée. La raison est celle de l'encodage des entrées de l'ADR 0015, et elle se
 * dit : sous une même clé, un même nonce et une même identité, deux chiffrés distincts partageant
 * une étiquette constituent une forgerie GCM, bornée par 2^-127 pour un clair de 32 octets. La
 * racine dit donc QUELS emplacements composent l'enveloppe et dans quel ordre ; chaque emplacement
 * dit qu'il est intact. Aucune des deux vérifications ne remplace l'autre.
 *
 * Le NONCE y figure, contrairement à l'encodage des entrées de #17 : là-bas il est conservé avec
 * l'enregistrement dont l'étiquette le couvre déjà ; ici il vit dans le même champ que l'étiquette
 * et rien d'autre ne le lie à sa place dans la liste. L'y mettre coûte douze octets par emplacement
 * et ferme l'échange de deux nonces entre deux emplacements.
 *
 * @param {Array<{ identifiantEmplacement: string, typeKek: number, parametres: Uint8Array,
 *                 nonce: Uint8Array, etiquette: Uint8Array }>} emplacements
 */
export function encoderEmplacements(emplacements) {
  if (!Array.isArray(emplacements)) {
    throw malforme("« emplacements » doit être un tableau.");
  }
  const morceaux = [
    chainePrefixee(ETIQUETTE_DOMAINE_EMPLACEMENTS),
    entierEnOctets(emplacements.length, 2),
  ];
  for (const [index, emplacement] of emplacements.entries()) {
    morceaux.push(...morceauxDUnEmplacement(index, emplacement ?? {}));
  }
  return concatenerListe(morceaux);
}

/** Les octets canoniques d'UN emplacement. Séparé pour garder `encoderEmplacements` lisible. */
function morceauxDUnEmplacement(
  index,
  { identifiantEmplacement, typeKek, parametres, nonce, etiquette },
) {
  hexadecimal(
    `emplacements[${index}].identifiantEmplacement`,
    identifiantEmplacement,
    IDENTIFIANT_EMPLACEMENT_OCTETS,
  );
  exigerTypeKek(typeKek);
  exigerParametres(parametres);
  exigerOctets(`emplacements[${index}].nonce`, nonce, NONCE_OCTETS);
  exigerOctets(`emplacements[${index}].etiquette`, etiquette, ETIQUETTE_OCTETS);

  return [
    chainePrefixee(identifiantEmplacement),
    entierEnOctets(typeKek, 1),
    entierEnOctets(parametres.byteLength, 2),
    parametres,
    nonce,
    etiquette,
  ];
}

/** Exige exactement `longueur` octets. Une largeur approchante n'est pas une largeur. */
export function exigerOctets(nom, valeur, longueur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== longueur) {
    throw malforme(
      `« ${nom} » doit faire ${longueur} octets, reçu ${valeur?.byteLength ?? "autre chose"}.`,
      { champ: nom, attendu: longueur },
    );
  }
  return valeur;
}

/** Rend la forme TEXTUELLE d'un identifiant d'emplacement : hexadécimal minuscule, seize signes. */
export function identifiantEmplacementEnTexte(octets) {
  exigerOctets("identifiantEmplacement", octets, IDENTIFIANT_EMPLACEMENT_OCTETS);
  let texte = "";
  for (const octet of octets) texte += octet.toString(16).padStart(2, "0");
  return texte;
}

/** Relit un identifiant d'emplacement textuel en ses huit octets. */
export function identifiantEmplacementEnOctets(texte) {
  hexadecimal("identifiantEmplacement", texte, IDENTIFIANT_EMPLACEMENT_OCTETS);
  const octets = new Uint8Array(IDENTIFIANT_EMPLACEMENT_OCTETS);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(texte.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}

/** Tire un identifiant d'emplacement. Aucun état, aucun compteur : l'unicité vient du tirage. */
export function tirerIdentifiantEmplacement() {
  return identifiantEmplacementEnTexte(
    crypto.getRandomValues(new Uint8Array(IDENTIFIANT_EMPLACEMENT_OCTETS)),
  );
}

/** Tire une clé de volume : trente-deux octets, la DEK que l'enveloppe protège. */
export function tirerCleDeVolume() {
  return crypto.getRandomValues(new Uint8Array(CLE_OCTETS));
}
