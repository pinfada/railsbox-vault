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

/**
 * Version 2 de la PAGE d'enveloppe (#182, T2b ; ADR 0033, décisions 2 et 3).
 *
 * Ce qui change tient en deux champs d'en-tête : un **sel** de trente-deux octets tirés, écrit en
 * clair, et l'**octet de domaine** qui dit sous quelle clé la racine est scellée. Ce qui reste est
 * tout le reste — le marqueur, la taille de page, la liste des emplacements, la somme de contrôle,
 * l'alternance des deux pages.
 *
 * La racine d'une page v2 n'est plus scellée sous la DEK : elle l'est sous une clé À USAGE UNIQUE
 * dérivée de la DEK par HKDF pour le domaine `enveloppe` — ou `recuperation` pour la page qu'une
 * archive emporte (ADR 0027). Une page, une clé, un scellement, aucun compteur.
 */
export const ENVELOPPE_FORMAT_V2 = 2;

/** Les versions de page que ce runtime sait RELIRE. La v1 reste lisible : voir la migration de page. */
export const ENVELOPPE_FORMATS_LUS = Object.freeze([ENVELOPPE_FORMAT_V1, ENVELOPPE_FORMAT_V2]);

/** La version que ce runtime ÉCRIT. Une page v1 relue est rescellée en v2 à la première ouverture. */
export const ENVELOPPE_FORMAT_ECRIT = ENVELOPPE_FORMAT_V2;

/**
 * Version du format d'un EMPLACEMENT, et pourquoi elle ne suit PAS celle de la page.
 *
 * Les données associées d'une DEK enveloppée portent une version de format. Elle vaut 1 depuis #21,
 * et elle vaut **toujours 1** : les octets d'un emplacement n'ont pas changé en v2, et surtout —
 * c'est la raison qui décide — **rescelle qui peut**. Faire suivre à ce champ la version de la PAGE
 * obligerait une migration v1 → v2 à réenvelopper la DEK sous CHAQUE clé de déverrouillage, alors
 * qu'on n'en détient qu'une : la migration de page deviendrait impossible, ou ne conserverait qu'un
 * emplacement sur huit. C'est-à-dire qu'elle perdrait des clés, ce qui est la seule chose qu'elle
 * n'a pas le droit de faire.
 *
 * Ce champ ne perd rien à rester constant : il l'était déjà — `ENVELOPPE_FORMAT_V1` était écrit en
 * dur des deux côtés du scellement —, et ce qui lie un emplacement à sa place est l'identifiant de
 * volume, l'identifiant d'emplacement, le type et les paramètres, qui sont tous là.
 */
export const EMPLACEMENT_FORMAT_V1 = ENVELOPPE_FORMAT_V1;

/**
 * Le DOMAINE de dérivation sous lequel la racine d'une page v2 est scellée, tel que l'octet 14 de
 * l'en-tête le porte.
 *
 * Deux valeurs, parce que l'ADR 0033, décision 2, sépare deux domaines qui produisent tous deux une
 * page d'enveloppe : `enveloppe` pour la page de `<volume>.cles`, `recuperation` pour celle qu'une
 * archive emporte (ADR 0027). Sans ce champ, une page de récupération RESTAURÉE — que la
 * restauration pose en page 0 de `<volume>.cles` — ne serait relisible par personne : le lecteur
 * dériverait la clé du domaine `enveloppe` et l'étiquette ne vérifierait pas.
 *
 * **Il n'est pas authentifié, et il n'a pas à l'être**, exactement comme le sel (ADR 0033,
 * décision 3) : un adversaire qui le change fait dériver une autre clé, donc échouer l'ouverture de
 * la racine, donc refuser la page. Il se protège par sa conséquence.
 *
 * L'octet 14 était un octet de remplissage, à zéro dans toute page v1 — ce qui laisse la v1
 * inchangée à l'octet près, vecteurs figés compris.
 */
export const DOMAINES_DE_RACINE = Object.freeze({ enveloppe: 1, recuperation: 2 });

const DOMAINES_DE_RACINE_PAR_VALEUR = Object.freeze(
  Object.fromEntries(Object.entries(DOMAINES_DE_RACINE).map(([nom, valeur]) => [valeur, nom])),
);

/** Nom du domaine de racine, ou `null` si l'octet n'en désigne aucun. */
export function nomDuDomaineDeRacine(valeur) {
  return DOMAINES_DE_RACINE_PAR_VALEUR[valeur] ?? null;
}

/** Largeur du sel d'une page v2 : trente-deux octets tirés, écrits en clair dans l'en-tête. */
export const SEL_DE_PAGE_OCTETS = 32;

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
 * Types de clé de déverrouillage. Les trois premiers sont RÉSERVÉS par #21 et servis par #22 ;
 * `harnais` est le seul que #21 produisait, et il est nommé pour ce qu'il est.
 *
 * **`recuperation` est ajouté par #147 (ADR 0025).** Le champ existe depuis #21, sur un octet, et
 * l'ADR 0020 a réservé avec lui le plafond de 512 octets des paramètres publics : la DISPOSITION
 * des octets ne change pas.
 *
 * **Ce qui change, en revanche, et la revue de format de #155 l'a mesuré plutôt que supposé : un
 * lecteur ANTÉRIEUR à #147 ne lit pas cette enveloppe.** Sa version d'`exigerTypeKek` gardait aussi
 * la LECTURE, si bien qu'un type qu'il ne réserve pas lui faisait rendre `VAULT_ENVELOPPE_MALFORME`
 * depuis l'encodage canonique de la liste — pas « je ne sais pas servir ce moyen », mais « ce
 * fichier est malformé » —, et l'y faisait replier sur la page antérieure, qu'une écriture
 * ultérieure écrasait sans faire avancer le compteur. `exigerOctetDeTypeKek` ferme cela POUR LA
 * SUITE : un type inconnu est désormais une entrée valide à la lecture, et le refus tombe au choix
 * du dérivateur, par `VAULT_DERIVATION_TYPE_INCONNU`, comme l'ADR 0021 le promet.
 *
 * Le relâchement ne rattrape évidemment pas les lecteurs déjà écrits : il rend seulement le type 5
 * inoffensif pour ceux d'aujourd'hui. Aucune version n'ayant jamais été publiée
 * (`docs/release-policy.md`), aucun lecteur antérieur n'est en service, et l'ADR 0025 l'inscrit
 * comme une limite DATÉE plutôt que comme une propriété du format.
 *
 * Pourquoi un type distinct plutôt qu'une `phrase` : un code de récupération doit être
 * DISCERNABLE — l'archive qui ne portera que lui (tranche 3 de #23), la révocation de tout sauf
 * celui qu'on tient (#148) et l'annonce du moyen (#24) le demandent chacun —, et il n'a rien à
 * compenser qui justifierait l'étirement d'Argon2id. L'ADR 0025 écrit les deux motifs.
 */
export const TYPES_KEK = Object.freeze({
  phrase: 1,
  "webauthn-prf": 2,
  harnais: 3,
  recuperation: 4,
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

/**
 * Exige un type de clé de déverrouillage RÉSERVÉ. C'est la garde de l'ÉCRITURE, et d'elle seule.
 *
 * On n'écrit jamais un emplacement d'un type qu'on ne sert pas : le produit ne sait pas quels
 * paramètres publics il faudrait y mettre, ni quelle KEK y enveloppera la DEK.
 */
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
 * Exige un OCTET de type de clé de déverrouillage. C'est la garde de la LECTURE, et elle est
 * délibérément plus large que celle de l'écriture (#147, amendement à l'ADR 0020).
 *
 * ## Le défaut que cette distinction corrige, mesuré plutôt que supposé
 *
 * Jusqu'à #147, `exigerTypeKek` gardait les DEUX chemins. Un lecteur rencontrant un type qu'il ne
 * réserve pas — exactement ce qui arrive à un lecteur d'avant #147 devant un emplacement
 * `recuperation` — levait donc `VAULT_ENVELOPPE_MALFORME` depuis l'encodage canonique de la liste,
 * c'est-à-dire AVANT d'avoir pu ouvrir quoi que ce soit. Deux conséquences, et la seconde est la
 * grave :
 *
 *  - **plus aucun moyen n'ouvrait**, la phrase comprise, dès que les deux pages portaient le type
 *    inconnu. Le refus ne disait pas « je ne sais pas servir ce moyen », il disait « ce fichier est
 *    malformé » ;
 *  - **le repli sur l'autre page devenait silencieux.** `lireEtat` traite un `MALFORME` comme un
 *    refus de page et essaie la suivante ; le lecteur rendait donc l'état d'AVANT, et une écriture
 *    ultérieure écrasait la page qui portait le type inconnu — sans erreur, et sans faire avancer
 *    le compteur de version.
 *
 * L'ADR 0021 promet le contraire, en toutes lettres : « une enveloppe qui porte un emplacement d'un
 * type inconnu ET un emplacement servable s'ouvre par le second ». C'est cette promesse que la
 * lecture relâchée rend vraie. Un type inconnu est désormais une ENTRÉE VALIDE, portée opaque et
 * inventoriée avec son numéro ; le refus tombe au CHOIX du dérivateur, par
 * `VAULT_DERIVATION_TYPE_INCONNU`, où il nomme le bon remède — mettre à jour, jamais essayer une clé.
 *
 * La borne qui reste est celle du CHAMP : un octet. Elle n'est pas une politique, c'est la largeur
 * que l'ADR 0020 a fixée.
 */
export function exigerOctetDeTypeKek(typeKek) {
  if (!Number.isSafeInteger(typeKek) || typeKek < 0 || typeKek > 0xff) {
    throw malforme(
      `« typeKek » vaut ${typeKek}, qui ne tient pas sur l'octet que le format lui réserve.`,
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
  exigerOctetDeTypeKek(typeKek);
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
  exigerOctetDeTypeKek(typeKek);
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
