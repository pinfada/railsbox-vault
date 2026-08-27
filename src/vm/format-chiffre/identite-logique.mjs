// Identité logique, nonces et bornes du format chiffré (#17, ADR 0015).
//
// Ce module ne chiffre rien. Il définit les OCTETS que le scellement lie : le nonce, qui doit être
// unique sous une clé, et les données associées, qui doivent nommer sans ambiguïté l'endroit d'où un
// bloc vient. Il est pur — aucune clé, aucun état, aucune E/S — pour qu'un relecteur externe (#20)
// puisse en juger sans exécuter quoi que ce soit.
//
// ## Le nonce, et pourquoi il ne porte pas l'adresse
//
// Douze octets, gros-boutistes :
//
// ```text
//   octet 0      domaine     0x01 bloc, 0x02 racine
//   octets 1-6   génération  48 bits
//   octets 7-11  rang        40 bits
// ```
//
// Le choix qui compte est l'ABSENCE de l'adresse. L'ADR 0014 admet qu'un même bloc soit réécrit
// plusieurs fois dans une même génération : un nonce construit sur (génération, adresse) se
// répéterait alors sur des clairs différents, ce qui sous AES-GCM livre le XOR des deux clairs ET la
// clé d'authentification H — donc la capacité de forger (NIST SP 800-38D, annexe A ; « forbidden
// attack », Joux 2006). Le RANG de l'entrée dans le journal de sa génération, lui, est unique par
// construction. L'adresse reste authentifiée par les données associées, où l'unicité n'est pas
// exigée.
//
// Le second choix est la DÉRIVATION plutôt que le tirage. Un compteur global tiré d'un état durable
// serait la construction déterministe canonique du § 8.2.1 de SP 800-38D ; il exigerait que ce
// compteur ne recule JAMAIS, y compris après la coupure que tout l'ADR 0014 existe pour survivre. La
// génération, elle, est monotone et durablement scellée par la racine ; les rangs repartent de zéro
// dans la génération suivante. Une reprise après coupure ne peut donc pas réémettre un nonce déjà
// employé, parce qu'elle ouvre une génération neuve. C'est ce que le modèle de crash de ce dépôt
// rend possible, et c'est la raison de ce choix plutôt qu'un compteur.
//
// ## Bornes
//
// Les champs sont LARGES — 2^48 générations, 2^40 entrées par génération — parce qu'un champ étroit
// reboucle en silence, ce qui est précisément la faute contre laquelle tout ce module existe. La
// borne qui MORD est ailleurs : le § 8.3 de SP 800-38D limite à 2^32 le nombre d'invocations de la
// fonction de chiffrement authentifié sous une même clé. Elle n'est pas structurelle, elle est
// COMPTÉE, et son dépassement est un refus typé.

import { CRYPTO_ERROR_CODES, CryptoError, malforme } from "./crypto-errors.mjs";
import { chainePrefixee, concatener, entierEnOctets } from "./octets.mjs";

/** Nom de l'unique algorithme admis par la v1 de cette spécification. Épinglé, pas devinable. */
export const ALGORITHME = "aes-256-gcm";

/** Nom du même algorithme dans l'API WebCrypto du W3C. */
export const ALGORITHME_WEBCRYPTO = "AES-GCM";

/** Version de la SPÉCIFICATION cryptographique, distincte de la version du format de volume. */
export const SPECIFICATION_VERSION = 1;

export const CLE_OCTETS = 32;
export const NONCE_OCTETS = 12;
export const ETIQUETTE_OCTETS = 16;

/** Longueur d'étiquette en bits : le maximum admis par SP 800-38D § 5.2.1.2. */
export const ETIQUETTE_BITS = ETIQUETTE_OCTETS * 8;

/** Empreinte de la liste des entrées d'une génération : SHA-256, comme l'empreinte du manifeste. */
export const EMPREINTE_OCTETS = 32;

export const DOMAINE_BLOC = 0x01;
export const DOMAINE_RACINE = 0x02;

const GENERATION_OCTETS = 6;
const RANG_OCTETS = 5;

/** Plus grande génération représentable par le nonce (2^48 - 1). */
export const GENERATION_MAX = 2 ** (GENERATION_OCTETS * 8) - 1;

/** Plus grand rang d'entrée représentable par le nonce (2^40 - 1). */
export const RANG_MAX = 2 ** (RANG_OCTETS * 8) - 1;

/**
 * Nombre maximal de scellements sous une même clé de volume.
 *
 * NIST SP 800-38D, § 8.3 : « The total number of invocations of the authenticated encryption
 * function shall not exceed 2^32 […] with the given key. » Ce n'est pas un seuil de confort : c'est
 * la borne du domaine de validité de la primitive telle que sa spécification l'énonce.
 */
export const BUDGET_SCELLEMENTS_PAR_CLE = 2 ** 32;

/** Étiquette de domaine d'un bloc. Elle entre dans les données associées, jamais dans le nonce. */
export const ETIQUETTE_DOMAINE_BLOC = "railsbox-vault/format-chiffre/v1/bloc";

/** Étiquette de domaine d'une racine de génération. */
export const ETIQUETTE_DOMAINE_RACINE = "railsbox-vault/format-chiffre/v1/racine";

/** Étiquette de domaine de l'empreinte de la liste des entrées d'une génération. */
export const ETIQUETTE_DOMAINE_ENTREES = "railsbox-vault/format-chiffre/v1/entrees";

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

function identifiant(nom, valeur) {
  if (typeof valeur !== "string" || valeur.length === 0 || valeur.length > 0xff) {
    throw malforme(`« ${nom} » doit être une chaîne non vide d'au plus 255 caractères.`, {
      champ: nom,
    });
  }
  return valeur;
}

/**
 * Construit le nonce d'un scellement. Déterministe, injectif, et refusé plutôt que tronqué.
 *
 * @param {{ domaine: number, generation: number, rang: number }} champs
 * @returns {Uint8Array} exactement `NONCE_OCTETS` octets
 */
export function construireNonce({ domaine, generation, rang }) {
  if (domaine !== DOMAINE_BLOC && domaine !== DOMAINE_RACINE) {
    throw malforme(
      `domaine de nonce inconnu : ${domaine}. Seuls ${DOMAINE_BLOC} (bloc) et ${DOMAINE_RACINE} (racine) existent.`,
      { domaine },
    );
  }
  entierBorne("generation", generation, GENERATION_MAX);
  entierBorne("rang", rang, RANG_MAX);
  return concatener(
    Uint8Array.of(domaine),
    entierEnOctets(generation, GENERATION_OCTETS),
    entierEnOctets(rang, RANG_OCTETS),
  );
}

/**
 * Données associées d'un bloc : l'identité logique COMPLÈTE, encodée sans ambiguïté.
 *
 * Chaque champ est de largeur fixe ou préfixé de sa longueur, si bien que deux identités distinctes
 * ne peuvent pas rendre la même chaîne d'octets. C'est la condition pour que « lier l'identité » veuille
 * dire quelque chose : une concaténation non préfixée permettrait de déplacer un caractère d'un
 * champ à l'autre sans changer les octets, donc de déplacer un bloc sans que l'étiquette bronche.
 *
 * @param {{ volume: string, formatVersion: number, generation: number, rang: number,
 *           adresse: number, longueur: number }} identite
 */
export function encoderIdentiteBloc({
  volume,
  formatVersion,
  generation,
  rang,
  adresse,
  longueur,
}) {
  identifiant("volume", volume);
  entierBorne("formatVersion", formatVersion, 0xffffffff);
  entierBorne("generation", generation, GENERATION_MAX);
  entierBorne("rang", rang, RANG_MAX);
  entierBorne("adresse", adresse, Number.MAX_SAFE_INTEGER);
  entierBorne("longueur", longueur, 0xffffffff);

  return concatener(
    chainePrefixee(ETIQUETTE_DOMAINE_BLOC),
    chainePrefixee(ALGORITHME),
    entierEnOctets(formatVersion, 4),
    chainePrefixee(volume),
    entierEnOctets(generation, 8),
    entierEnOctets(rang, 8),
    entierEnOctets(adresse, 8),
    entierEnOctets(longueur, 4),
  );
}

/**
 * Données associées d'une racine : ce que la génération AFFIRME d'elle-même.
 *
 * L'en-tête est en CLAIR sur le support et authentifié ici. Ce qu'il révèle est écrit dans
 * l'ADR 0015 : le nombre d'entrées d'une génération, la longueur de sa charge et le rang de la
 * génération. C'est un canal auxiliaire sur le VOLUME d'écriture, assumé et nommé, pas une fuite
 * découverte après coup.
 *
 * @param {{ volume: string, formatVersion: number, sequence: number, generation: number,
 *           tailleVolume: number, nombreEntrees: number, longueurCharge: number,
 *           scellementsCumules: number }} entete
 */
export function encoderEnteteRacine({
  volume,
  formatVersion,
  sequence,
  generation,
  tailleVolume,
  nombreEntrees,
  longueurCharge,
  scellementsCumules,
}) {
  identifiant("volume", volume);
  entierBorne("formatVersion", formatVersion, 0xffffffff);
  entierBorne("sequence", sequence, RANG_MAX);
  entierBorne("generation", generation, GENERATION_MAX);
  entierBorne("tailleVolume", tailleVolume, Number.MAX_SAFE_INTEGER);
  entierBorne("nombreEntrees", nombreEntrees, 0xffffffff);
  entierBorne("longueurCharge", longueurCharge, Number.MAX_SAFE_INTEGER);
  entierBorne("scellementsCumules", scellementsCumules, Number.MAX_SAFE_INTEGER);

  return concatener(
    chainePrefixee(ETIQUETTE_DOMAINE_RACINE),
    chainePrefixee(ALGORITHME),
    entierEnOctets(formatVersion, 4),
    chainePrefixee(volume),
    entierEnOctets(sequence, 8),
    entierEnOctets(generation, 8),
    entierEnOctets(tailleVolume, 8),
    entierEnOctets(nombreEntrees, 4),
    entierEnOctets(longueurCharge, 8),
    entierEnOctets(scellementsCumules, 8),
  );
}

/**
 * Encodage canonique de la SUITE des entrées d'une génération, dont la racine scelle l'empreinte.
 *
 * Chaque entrée y porte son adresse, sa longueur, son rang et l'ÉTIQUETTE de son bloc scellé — pas
 * le chiffré. La raison est bon marché et se dit : sous une même clé, un même nonce et une même
 * identité, deux chiffrés distincts partageant une étiquette constituent une forgerie GCM, bornée
 * par 2^-128. La racine dit donc QUELS blocs composent la génération ; chaque bloc dit qu'il est
 * intact. Aucune des deux vérifications ne remplace l'autre.
 *
 * Le nonce n'y figure pas : il se dérive de (génération, rang), tous deux déjà couverts.
 *
 * @param {Array<{ adresse: number, longueur: number, rang: number, etiquette: Uint8Array }>} entrees
 */
export function encoderEntrees(entrees) {
  if (!Array.isArray(entrees)) {
    throw malforme("« entrees » doit être un tableau.");
  }
  const morceaux = [chainePrefixee(ETIQUETTE_DOMAINE_ENTREES), entierEnOctets(entrees.length, 4)];
  for (const [index, entree] of entrees.entries()) {
    const { adresse, longueur, rang, etiquette } = entree ?? {};
    entierBorne(`entrees[${index}].adresse`, adresse, Number.MAX_SAFE_INTEGER);
    entierBorne(`entrees[${index}].longueur`, longueur, 0xffffffff);
    entierBorne(`entrees[${index}].rang`, rang, RANG_MAX);
    if (!(etiquette instanceof Uint8Array) || etiquette.byteLength !== ETIQUETTE_OCTETS) {
      throw malforme(`« entrees[${index}].etiquette » doit faire ${ETIQUETTE_OCTETS} octets.`, {
        index,
      });
    }
    morceaux.push(
      entierEnOctets(adresse, 8),
      entierEnOctets(longueur, 4),
      entierEnOctets(rang, 8),
      etiquette,
    );
  }
  return concatener(...morceaux);
}

/**
 * Refuse deux entrées de même rang dans une même génération : leur nonce serait identique.
 *
 * Le modèle ne peut pas vérifier l'unicité d'un rang à l'échelle d'un seul bloc — un scellement
 * isolé ne sait rien des autres. Il le peut à l'échelle de la GÉNÉRATION, quand la racine énumère
 * ses entrées, et c'est là qu'il le fait. L'obligation de l'appelant (#18) devient ainsi
 * falsifiable au lieu de rester une consigne.
 */
export function verifierRangsDistincts(entrees) {
  const vus = new Set();
  for (const [index, entree] of entrees.entries()) {
    if (vus.has(entree.rang)) {
      throw new CryptoError(
        CRYPTO_ERROR_CODES.nonceReuse,
        `Scellement refusé : l'entrée ${index} de cette génération reprend le rang ${entree.rang}, déjà employé. Le nonce se répéterait sous la même clé, ce qui livrerait le XOR des deux clairs ET la clé d'authentification GCM. Aucun octet n'est produit.`,
        { context: { index, rang: entree.rang } },
      );
    }
    vus.add(entree.rang);
  }
  return entrees;
}

/**
 * Refuse un scellement au-delà du budget de la clé. Rendu tel quel sous la limite, pour qu'un
 * appelant puisse l'employer comme compteur sans dupliquer la règle.
 */
export function verifierBudgetDeCle(scellementsCumules) {
  entierBorne("scellementsCumules", scellementsCumules, Number.MAX_SAFE_INTEGER);
  if (scellementsCumules >= BUDGET_SCELLEMENTS_PAR_CLE) {
    throw new CryptoError(
      CRYPTO_ERROR_CODES.keyBudget,
      `Scellement refusé : ${scellementsCumules} scellements sous cette clé, budget de ${BUDGET_SCELLEMENTS_PAR_CLE} (NIST SP 800-38D, § 8.3). Poursuivre exigerait une clé de volume neuve ; continuer sortirait du domaine de validité de la primitive.`,
      { context: { scellementsCumules, budget: BUDGET_SCELLEMENTS_PAR_CLE } },
    );
  }
  return scellementsCumules;
}

/** Refuse un nom d'algorithme autre que l'unique nom admis. L'agilité passe par une version, pas ici. */
export function verifierAlgorithme(nom) {
  if (nom !== undefined && nom !== ALGORITHME) {
    throw new CryptoError(
      CRYPTO_ERROR_CODES.algorithmUnsupported,
      `Algorithme refusé : « ${nom} ». Cette version de la spécification n'admet que « ${ALGORITHME} ». Un second algorithme exigera une version de format et un ADR.`,
      { context: { presente: nom, admis: ALGORITHME } },
    );
  }
  return ALGORITHME;
}
