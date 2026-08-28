// L'ENVELOPPE DE CLÉ du produit : les cinq opérations, sur un support (#21, ADR 0020).
//
// Ce module ne réimplémente RIEN de la cryptographie. Il appelle `enveloppe/modele-reference.mjs`,
// qui est la spécification exécutable de l'ADR 0020, et `enveloppe/fichier-enveloppe.mjs`, qui dit
// où les octets vivent. Il n'ajoute que les trois choses qu'un module pur ne pouvait pas porter :
//
//  1. **le support** — un fichier `<volume>.cles` de taille fixe, deux pages alternées, injectable
//     pour être éprouvable sous Node comme dans un Worker ;
//  2. **l'atomicité** — écrire TOUJOURS la page qui ne fait pas autorité, puis franchir la barrière.
//     C'est la barrière qui publie ; avant elle, l'ancien état est intact ;
//  3. **la conduite du refus** — les deux pages sont jugées, la plus récente valide l'emporte, et le
//     refus rendu est le plus ÉTABLI des deux, jamais le premier venu.
//
// ## Ce que ce module NE fait pas, et ne fera pas ici
//
// Il ne DÉRIVE aucune clé de déverrouillage. Une KEK arrive en trente-deux octets, d'où qu'elle
// vienne : phrase secrète étirée par Argon2id, PRF WebAuthn, ou — dans cette tranche — le harnais,
// exactement comme la clé de volume l'est depuis #18. Les dérivateurs sont #22, la récupération
// #23. Le TYPE et les PARAMÈTRES publics du dérivateur sont transportés et AUTHENTIFIÉS ici sans
// être interprétés : #21 pose la serrure, #22 pose les clés.
//
// ## Le volume n'est pas touché, et c'est le résultat attendu de #21
//
// Aucune fonction de ce fichier ne lit ni n'écrit le fichier de VOLUME. Ajouter, remplacer ou
// révoquer une clé de déverrouillage réécrit une page de quatre kilo-octets, et rien d'autre :
// l'identité à l'octet du volume après chaque opération est éprouvée par
// `tests/unit/vm-enveloppe-operations.test.mjs`, empreinte avant et après.
//
// ## La source d'aléas est injectable, et elle est GARDÉE
//
// Deux valeurs tirées entrent dans le fichier : le NONCE de chaque scellement et l'IDENTIFIANT
// d'un emplacement. Les remplacer est nécessaire pour reproduire les vecteurs figés de l'ADR 0020,
// et catastrophique partout ailleurs — deux DEK enveloppées sous la même KEK, la même identité
// d'emplacement et le même nonce livrent le ou-exclusif des deux clés de volume. La porte exige donc
// le jeton `HARNAIS_ALEAS_JETON`, sur le modèle de `scellement.mjs` ; ce qui interdit son usage,
// c'est `tests/unit/harnais-portes.test.mjs`, qui refuse tout appelant hors des épreuves.

import { tirerNonce } from "./format-chiffre/identite-logique.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  cleRefusee,
  dernierEmplacement,
  emplacementInconnu,
  enveloppeAbsente,
  enveloppeIllisible,
  enveloppePleine,
  isEnveloppeError,
  malforme,
  rejeu,
} from "./enveloppe/enveloppe-errors.mjs";
import {
  PAGES,
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  encoderPage,
  offsetDePage,
} from "./enveloppe/fichier-enveloppe.mjs";
import {
  EMPLACEMENTS_MAX,
  ENVELOPPE_FORMAT_V1,
  TYPES_KEK,
  exigerParametres,
  exigerTypeKek,
  tirerIdentifiantEmplacement,
} from "./enveloppe/identite-enveloppe.mjs";
import {
  developper,
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
  ouvrirRacine,
  scellerRacineSousNonce,
} from "./enveloppe/modele-reference.mjs";

export { EMPLACEMENTS_MAX, ENVELOPPE_ERROR_CODES, TAILLE_FICHIER_ENVELOPPE, TYPES_KEK };

/**
 * Jeton exigé pour REMPLACER la source d'aléas. Valeur exacte : une valeur approchante n'ouvre rien.
 * Seules les épreuves qui confrontent le produit aux vecteurs de l'ADR 0020 ont une raison de
 * l'importer, et `tests/unit/harnais-portes.test.mjs` tient cette liste.
 */
export const HARNAIS_ALEAS_JETON = "vault/harnais-aleas-enveloppe/vecteurs-adr-0020";

const REFUS_ALEAS =
  `La source d'aléas d'une enveloppe ne se remplace que dans le harnais, et l'appel doit présenter ` +
  `le jeton ${HARNAIS_ALEAS_JETON}. Deux DEK enveloppées sous la même clé de déverrouillage, la ` +
  `même identité d'emplacement et le même nonce livrent le ou-exclusif des deux clés de volume. ` +
  `Aucun chemin du produit ne fournit de source : le défaut tire de crypto.getRandomValues.`;

/** Les aléas par défaut : douze octets de nonce, huit octets d'identifiant, tirés à chaque appel. */
const ALEAS_REELS = Object.freeze({
  tirerNonce,
  tirerIdentifiant: tirerIdentifiantEmplacement,
});

/**
 * Vérifie la porte des aléas et rend la source à employer.
 *
 * @param {{ tirerNonce?: () => Uint8Array, tirerIdentifiant?: () => string, jeton?: string }} aleas
 */
function aleasAdmis(aleas) {
  if (aleas === undefined) return ALEAS_REELS;
  if (aleas.jeton !== HARNAIS_ALEAS_JETON) throw new Error(REFUS_ALEAS);
  return Object.freeze({
    tirerNonce: aleas.tirerNonce ?? ALEAS_REELS.tirerNonce,
    tirerIdentifiant: aleas.tirerIdentifiant ?? ALEAS_REELS.tirerIdentifiant,
  });
}

/** Précédence des refus : le plus ÉTABLI l'emporte sur le moins établi. Voir l'ADR 0020. */
const PRECEDENCE = Object.freeze([
  ENVELOPPE_ERROR_CODES.identite,
  ENVELOPPE_ERROR_CODES.melange,
  ENVELOPPE_ERROR_CODES.troncature,
  ENVELOPPE_ERROR_CODES.racineRefusee,
  ENVELOPPE_ERROR_CODES.cleRefusee,
  ENVELOPPE_ERROR_CODES.illisible,
]);

/**
 * Retient le refus le plus établi parmi ceux qu'ont produits les deux pages.
 *
 * Sans cette règle, une page abîmée masquerait le diagnostic de l'autre selon l'ordre de lecture —
 * c'est-à-dire selon rien. `identite` et `melange` disent quelque chose du FICHIER ; `cleRefusee` ne
 * dit rien de plus que « pas avec cette clé ».
 */
function refusLePlusEtabli(refus) {
  for (const code of PRECEDENCE) {
    const trouve = refus.find((erreur) => isEnveloppeError(erreur, code));
    if (trouve !== undefined) return trouve;
  }
  return refus[0] ?? enveloppeIllisible();
}

/** Lit le fichier entier, ou refuse. Un fichier absent n'est PAS un fichier vide. */
async function lireFichier(support, contexte) {
  const etat = await support.etat();
  if (!etat.present || etat.taille === 0) throw enveloppeAbsente(contexte);
  if (etat.taille < TAILLE_FICHIER_ENVELOPPE) {
    throw enveloppeIllisible({
      ...contexte,
      taille: etat.taille,
      attendu: TAILLE_FICHIER_ENVELOPPE,
    });
  }
  return support.lire(0, TAILLE_FICHIER_ENVELOPPE);
}

/**
 * Essaie TOUS les emplacements d'une page, sans court-circuit, et rend la DEK du premier qui ouvre.
 *
 * **Ce que l'absence de court-circuit achète, et ce qu'elle n'achète pas.** Elle n'achète PAS
 * l'indiscernabilité des deux refus : un échec parcourt la liste entière de toute façon, puisqu'il
 * n'y a jamais de correspondance. La campagne de mutation de l'ADR 0020 l'a établi en rétablissant
 * le court-circuit sans qu'aucune épreuve de refus ne bronche — la première rédaction de ce
 * commentaire se trompait.
 *
 * Elle achète ceci, qui est réel : **une ouverture qui RÉUSSIT coûte le même nombre d'appels, que
 * la clé occupe le premier ou le dernier emplacement.** Avec court-circuit, un succès au premier
 * coûterait un appel et un succès au huitième en coûterait huit ; le temps d'un déverrouillage
 * désignerait la clé employée, sur un fichier dont le nombre d'emplacements est public.
 *
 * Ce qui est mesuré est ce nombre d'appels (`vm-enveloppe-operations.test.mjs` compte les
 * invocations de `SubtleCrypto.decrypt`, à l'échec comme au succès) ; ce qui ne l'est pas est le
 * temps interne de WebCrypto, que ce dépôt ne prétend pas maîtriser.
 */
async function developperDansLaPage(page, kek) {
  let trouve = null;
  for (const emplacement of page.emplacements) {
    const dek = await developper({
      kek,
      emplacement: {
        identifiantVolume: page.identifiantVolume,
        identifiantEmplacement: emplacement.identifiantEmplacement,
        formatVersion: page.formatVersion,
        typeKek: emplacement.typeKek,
        parametres: emplacement.parametres,
      },
      scelle: {
        nonce: emplacement.nonce,
        chiffre: emplacement.dekEnveloppee,
        etiquette: emplacement.etiquette,
      },
    });
    if (dek !== null && trouve === null) {
      trouve = { dek, identifiantEmplacement: emplacement.identifiantEmplacement };
    }
  }
  return trouve;
}

/**
 * Ouvre UNE page : développe la DEK, puis vérifie la racine AVANT de rendre quoi que ce soit.
 *
 * L'ordre est le sujet de la décision 3 de l'ADR 0020. La DEK obtenue au premier temps ne sert qu'à
 * VÉRIFIER — elle n'est rendue qu'une fois la racine authentifiée, l'identité de volume confrontée,
 * le compte des emplacements confronté et l'empreinte de la suite ordonnée confrontée. Un fichier
 * réordonné, tronqué ou portant un emplacement d'un autre volume est donc refusé avant que la clé
 * du volume n'atteigne quoi que ce soit d'autre que la vérification.
 */
async function ouvrirPage(page, kek, identifiantVolume) {
  const trouve = await developperDansLaPage(page, kek);
  if (trouve === null) throw cleRefusee({ volume: identifiantVolume, version: page.version });

  const cleDek = await importerCleDeVolume(trouve.dek);
  await ouvrirRacine({
    dek: cleDek,
    entete: {
      identifiantVolume: page.identifiantVolume,
      formatVersion: page.formatVersion,
      version: page.version,
      nombreEmplacements: page.nombreEmplacements,
    },
    scelle: page.racine,
    emplacements: page.emplacements,
    attentes: { identifiantVolume, versionMinimale: null },
  });
  return Object.freeze({ ...trouve, version: page.version });
}

/**
 * Les pages STRUCTURELLEMENT valides, de la plus récente à la plus ancienne.
 *
 * Le classement se fait sur la version DÉCLARÉE, qui n'est pas encore authentifiée à ce stade. Ce
 * n'est pas un oubli : il n'existe aucun moyen de trier deux pages sans les lire, et l'autorité
 * qu'on leur accorde ici ne va pas plus loin que l'ORDRE DES ESSAIS. Une page qui mentirait sur sa
 * version serait essayée d'abord, puis refusée par son étiquette.
 *
 * L'égalité de version est départagée par l'index, pour que le résultat ne dépende jamais de
 * l'ordre de lecture. Deux pages de même version ne devraient pas exister — le compteur croît
 * strictement —, et un fichier qui en porterait deux est précisément le cas où l'on ne veut pas
 * d'un verdict tiré au sort.
 */
function pagesDeLaPlusRecente(octets) {
  const lues = [];
  for (let index = 0; index < PAGES; index += 1) {
    const lue = decoderPage(
      octets.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS),
    );
    lues.push({ index, ...lue });
  }
  return lues
    .filter((lue) => lue.valide)
    .sort((a, b) => b.page.version - a.page.version || a.index - b.index);
}

/**
 * ÉTAT COMPLET de l'enveloppe : la page qui fait autorité, sa DEK, et l'index de la page libre.
 *
 * ## La règle de repli, et pourquoi elle n'est PAS « la page qui s'ouvre »
 *
 * La première écriture de ce module retenait, parmi les DEUX pages, celle de plus grande version qui
 * s'ouvrait sous la clé présentée. C'était faux, et l'épreuve
 * `vm-enveloppe-operations.test.mjs` l'a montré en trois lignes : après une révocation, la page
 * PRÉCÉDENTE porte toujours l'emplacement révoqué, elle est parfaitement valide, et la clé révoquée
 * l'ouvrait. **La révocation ne révoquait rien.** L'alternance de pages, qui donne l'atomicité,
 * conserve exprès l'état d'avant — et un déverrouillage qui accepte l'état d'avant annule toute
 * mutation de sécurité.
 *
 * La règle correcte distingue deux natures de refus sur la page la plus récente :
 *
 *  - **`VAULT_ENVELOPPE_CLE_REFUSEE`** — la page est cohérente et signée, la clé n'y a pas
 *    d'emplacement. C'est l'ÉTAT COURANT, et il dit non. Aucun repli : refuser ici est le sens même
 *    d'une révocation ;
 *  - **tout autre refus** — racine qui ne vérifie pas, liste tronquée, réordonnée, autre volume. La
 *    page n'est pas un état auquel on puisse se fier ; c'est ce qu'une coupure laisse derrière elle,
 *    et l'on retombe sur la page précédente. C'est là, et là seulement, que l'alternance opère.
 *
 * Ce que cette règle ne couvre PAS est écrit dans l'ADR 0020 : un adversaire qui EFFACE la page
 * courante fait retomber le lecteur sur la précédente, donc ressuscite une clé révoquée. Il faut un
 * ancrage monotone hors du fichier pour le refuser, et `versionMinimale` est le point où il se
 * branchera (#23). Sans ancrage, ce retour arrière n'est pas détecté, et le dire vaut mieux que de
 * laisser croire qu'une révocation résiste à qui peut écrire dans l'origine de confiance.
 */
async function lireEtat({ support, identifiantVolume, kek, versionMinimale = null }) {
  const octets = await lireFichier(support, { volume: identifiantVolume });
  const candidates = pagesDeLaPlusRecente(octets);
  if (candidates.length === 0) throw enveloppeIllisible({ volume: identifiantVolume });

  const refus = [];
  for (const candidate of candidates) {
    let ouverte;
    try {
      ouverte = await ouvrirPage(candidate.page, kek, identifiantVolume);
    } catch (cause) {
      if (!isEnveloppeError(cause)) throw cause;
      // Une clé qui n'ouvre pas l'état COURANT est refusée là, sans repli : voir ci-dessus.
      if (isEnveloppeError(cause, ENVELOPPE_ERROR_CODES.cleRefusee)) throw cause;
      refus.push(cause);
      continue;
    }
    if (versionMinimale !== null && ouverte.version < versionMinimale) {
      throw rejeu({ version: ouverte.version, minimale: versionMinimale });
    }
    return Object.freeze({
      index: candidate.index,
      page: candidate.page,
      ...ouverte,
      pageLibre: PAGES - 1 - candidate.index,
    });
  }
  throw refusLePlusEtabli(refus);
}

/**
 * OUVRE l'enveloppe et rend la clé de volume.
 *
 * @param {{ support: object, identifiantVolume: string, kek: Uint8Array,
 *           versionMinimale?: number | null }} appel
 * @returns {Promise<{ dek: Uint8Array, identifiantEmplacement: string, version: number }>}
 * @throws {EnveloppeError} `VAULT_ENVELOPPE_ABSENTE` si aucune enveloppe n'existe —
 *   distinct de `VAULT_ENVELOPPE_CLE_REFUSEE`, qui dit que la clé n'ouvre rien.
 */
export async function ouvrirEnveloppe({ support, identifiantVolume, kek, versionMinimale = null }) {
  const cleKek = await importerCleDeDeverrouillage(kek);
  const etat = await lireEtat({ support, identifiantVolume, kek: cleKek, versionMinimale });
  return Object.freeze({
    dek: etat.dek,
    identifiantEmplacement: etat.identifiantEmplacement,
    version: etat.version,
  });
}

/** Construit UN emplacement scellé : la DEK enveloppée sous la KEK, avec ses données associées. */
async function fabriquerEmplacement({
  identifiantVolume,
  dek,
  kek,
  typeKek,
  parametres,
  aleas,
  identifiantEmplacement: fourni,
}) {
  exigerTypeKek(typeKek);
  exigerParametres(parametres);
  // L'identifiant peut être FOURNI depuis #22 (ADR 0021) : la KEK d'un dérivateur est liée à cet
  // identifiant par son info HKDF, il faut donc qu'il existe AVANT la dérivation. Le défaut reste
  // le tirage, et l'unicité reste celle du tirage — `exigerIdentifiantLibre` refuse un doublon.
  const identifiantEmplacement =
    fourni === undefined ? aleas.tirerIdentifiant() : identifiantEmplacementFourni(fourni);
  const scelle = await envelopperSousNonce({
    kek: await importerCleDeDeverrouillage(kek),
    emplacement: {
      identifiantVolume,
      identifiantEmplacement,
      formatVersion: ENVELOPPE_FORMAT_V1,
      typeKek,
      parametres,
    },
    dek,
    nonce: aleas.tirerNonce(),
  });
  return Object.freeze({
    identifiantEmplacement,
    typeKek,
    parametres,
    nonce: scelle.nonce,
    dekEnveloppee: scelle.chiffre,
    etiquette: scelle.etiquette,
  });
}

/** Exige la forme d'un identifiant d'emplacement fourni. Une forme approchante n'en est pas un. */
function identifiantEmplacementFourni(valeur) {
  if (typeof valeur !== "string" || !/^[0-9a-f]{16}$/.test(valeur)) {
    throw malforme(
      `« identifiantEmplacement » doit être seize hexadécimaux minuscules, reçu ${JSON.stringify(valeur)}.`,
    );
  }
  return valeur;
}

/**
 * Refuse un identifiant DÉJÀ présent dans la liste.
 *
 * La garde n'existait pas tant que #21 tirait seul : deux tirages de huit octets ne se rencontrent
 * pas. Depuis que #22 peut en fournir un, elle est nécessaire — deux emplacements de même
 * identifiant rendraient `revoquerEmplacement` ambigu, et la racine authentifierait une liste dont
 * deux éléments prétendent au même nom.
 */
function exigerIdentifiantLibre(emplacements, identifiantEmplacement, identifiantVolume) {
  if (identifiantEmplacement === undefined) return;
  const present = emplacements.some(
    (existant) => existant.identifiantEmplacement === identifiantEmplacement,
  );
  if (present) {
    throw malforme(
      `l'emplacement « ${identifiantEmplacement} » existe déjà dans cette enveloppe. Deux emplacements de même identifiant rendraient toute révocation ambiguë.`,
      { volume: identifiantVolume, identifiantEmplacement },
    );
  }
}

/** Scelle la racine sur une liste ordonnée et rend les octets de la page. */
async function composerPage({ identifiantVolume, version, dek, emplacements, aleas }) {
  const racine = await scellerRacineSousNonce({
    dek: await importerCleDeVolume(dek),
    racine: { identifiantVolume, formatVersion: ENVELOPPE_FORMAT_V1, version },
    emplacements,
    nonce: aleas.tirerNonce(),
  });
  return encoderPage({
    identifiantVolume,
    version,
    racine: { nonce: racine.nonce, chiffre: racine.chiffre, etiquette: racine.etiquette },
    emplacements,
  });
}

/**
 * PUBLIE une page : elle est écrite là où elle ne fait pas autorité, puis la barrière la publie.
 *
 * L'ordre n'est pas une commodité. Écrire la page qui fait autorité détruirait l'état courant avant
 * que le nouveau ne soit durable, et une coupure ne laisserait alors NI l'un NI l'autre — l'état que
 * #21 interdit.
 */
async function publier(support, index, octets) {
  await support.ecrire(offsetDePage(index), octets);
  await support.barriere();
}

/**
 * CRÉE l'enveloppe d'un volume : un fichier de taille fixe, un emplacement, la version 1.
 *
 * Le fichier est alloué AVANT d'écrire quoi que ce soit, et il ne changera plus jamais de taille.
 * Une coupure pendant la création laisse soit une enveloppe qui s'ouvre sous `kek`, soit un fichier
 * dont aucune page ne se relit (`VAULT_ENVELOPPE_ILLISIBLE`) — jamais une enveloppe à moitié vraie.
 * L'ordre voulu par l'ADR 0020 est que le VOLUME ne soit créé qu'après cette barrière : l'inverse
 * laisserait un volume qu'aucune clé n'ouvre.
 *
 * @param {{ support: object, identifiantVolume: string, dek: Uint8Array, kek: Uint8Array,
 *           typeKek?: number, parametres?: Uint8Array, aleas?: object }} appel
 */
export async function creerEnveloppe({
  support,
  identifiantVolume,
  dek,
  kek,
  typeKek = TYPES_KEK.harnais,
  parametres = new Uint8Array(0),
  identifiantEmplacement,
  aleas,
}) {
  const sources = aleasAdmis(aleas);
  const emplacement = await fabriquerEmplacement({
    identifiantVolume,
    dek,
    kek,
    typeKek,
    parametres,
    identifiantEmplacement,
    aleas: sources,
  });
  const octets = await composerPage({
    identifiantVolume,
    version: 1,
    dek,
    emplacements: [emplacement],
    aleas: sources,
  });
  await support.allouer(TAILLE_FICHIER_ENVELOPPE);
  await publier(support, 0, octets);
  return Object.freeze({ identifiantEmplacement: emplacement.identifiantEmplacement, version: 1 });
}

/** Applique une transformation de la liste, scelle, et publie sur la page libre. */
async function muter({ support, identifiantVolume, kek, aleas, transformer }) {
  const sources = aleasAdmis(aleas);
  const cleKek = await importerCleDeDeverrouillage(kek);
  const etat = await lireEtat({ support, identifiantVolume, kek: cleKek });
  const emplacements = await transformer(etat, sources);
  const version = etat.version + 1;
  const octets = await composerPage({
    identifiantVolume,
    version,
    dek: etat.dek,
    emplacements,
    aleas: sources,
  });
  await publier(support, etat.pageLibre, octets);
  return Object.freeze({ version, nombreEmplacements: emplacements.length });
}

/**
 * AJOUTE une clé de déverrouillage. Le volume n'est pas touché : la DEK est la même, réenveloppée
 * une fois de plus.
 *
 * Il faut détenir une KEK VALABLE pour ajouter : une enveloppe n'est pas un trousseau ouvert en
 * écriture, c'est un état signé par la clé qu'elle protège.
 */
export async function ajouterEmplacement({
  support,
  identifiantVolume,
  kek,
  kekNouvelle,
  typeKek = TYPES_KEK.harnais,
  parametres = new Uint8Array(0),
  identifiantEmplacement,
  aleas,
}) {
  return muter({
    support,
    identifiantVolume,
    kek,
    aleas,
    transformer: async (etat, sources) => {
      if (etat.page.emplacements.length >= EMPLACEMENTS_MAX) {
        throw enveloppePleine({ plafond: EMPLACEMENTS_MAX, volume: identifiantVolume });
      }
      exigerIdentifiantLibre(etat.page.emplacements, identifiantEmplacement, identifiantVolume);
      const ajoute = await fabriquerEmplacement({
        identifiantVolume,
        dek: etat.dek,
        kek: kekNouvelle,
        typeKek,
        parametres,
        identifiantEmplacement,
        aleas: sources,
      });
      return [...etat.page.emplacements, ajoute];
    },
  });
}

/**
 * REMPLACE la clé d'un emplacement, EN PLACE. L'identifiant d'emplacement change avec la clé : le
 * conserver ferait de lui un nom stable pour deux secrets successifs, et les données associées ne
 * distingueraient plus l'ancienne enveloppe de la nouvelle.
 */
export async function remplacerEmplacement({
  support,
  identifiantVolume,
  kek,
  identifiantEmplacement,
  kekNouvelle,
  typeKek = TYPES_KEK.harnais,
  parametres = new Uint8Array(0),
  identifiantNouveau,
  aleas,
}) {
  return muter({
    support,
    identifiantVolume,
    kek,
    aleas,
    transformer: async (etat, sources) => {
      const rang = rangDe(etat.page.emplacements, identifiantEmplacement, identifiantVolume);
      exigerIdentifiantLibre(etat.page.emplacements, identifiantNouveau, identifiantVolume);
      const remplacant = await fabriquerEmplacement({
        identifiantVolume,
        dek: etat.dek,
        kek: kekNouvelle,
        typeKek,
        parametres,
        identifiantEmplacement: identifiantNouveau,
        aleas: sources,
      });
      return etat.page.emplacements.map((existant, index) =>
        index === rang ? remplacant : existant,
      );
    },
  });
}

/**
 * RÉVOQUE un emplacement : il est RETIRÉ de la liste, et la page est réécrite entière, remplissage à
 * zéro compris. Rien de l'ancien emplacement ne survit dans la page publiée.
 *
 * Révoquer le dernier emplacement est REFUSÉ. La règle n'est pas une politesse : un volume dont
 * toutes les clés sont révoquées est un volume perdu, et perdre des données ne doit jamais être le
 * résultat d'un seul geste réussi.
 */
export async function revoquerEmplacement({
  support,
  identifiantVolume,
  kek,
  identifiantEmplacement,
  aleas,
}) {
  return muter({
    support,
    identifiantVolume,
    kek,
    aleas,
    transformer: async (etat) => {
      const emplacements = etat.page.emplacements;
      const rang = rangDe(emplacements, identifiantEmplacement, identifiantVolume);
      if (emplacements.length === 1) {
        throw dernierEmplacement({ volume: identifiantVolume, identifiantEmplacement });
      }
      return emplacements.filter((_, index) => index !== rang);
    },
  });
}

/** Rang d'un emplacement dans la liste, ou refus typé. Jamais un emplacement créé pour l'occasion. */
function rangDe(emplacements, identifiantEmplacement, identifiantVolume) {
  if (typeof identifiantEmplacement !== "string") {
    throw malforme("« identifiantEmplacement » doit être une chaîne hexadécimale.");
  }
  const rang = emplacements.findIndex(
    (existant) => existant.identifiantEmplacement === identifiantEmplacement,
  );
  if (rang === -1) {
    throw emplacementInconnu({ volume: identifiantVolume, identifiantEmplacement });
  }
  return rang;
}

/**
 * INVENTAIRE public d'une enveloppe : ce qu'on peut en dire SANS clé.
 *
 * Il ne rend ni DEK, ni DEK enveloppée, ni étiquette : seulement ce que le fichier expose déjà en
 * clair — sa version, le nombre et le type de ses emplacements. C'est ce dont une interface (#24)
 * aura besoin pour dire « ce volume s'ouvre par une phrase ou par une passkey » avant que quoi que
 * ce soit ne soit déverrouillé. Ce qu'il RÉVÈLE est écrit dans l'ADR 0020 et assumé : le nombre de
 * clés d'un volume et leur nature sont un canal auxiliaire, et le fichier les porte en clair parce
 * qu'un dérivateur doit pouvoir lire ses paramètres avant de dériver quoi que ce soit.
 */
export async function inventorierEnveloppe({ support, identifiantVolume }) {
  const octets = await lireFichier(support, { volume: identifiantVolume });
  const pages = [];
  for (let index = 0; index < PAGES; index += 1) {
    const lue = decoderPage(
      octets.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS),
    );
    if (lue.valide) pages.push(lue.page);
  }
  if (pages.length === 0) throw enveloppeIllisible({ volume: identifiantVolume });
  const page = pages.reduce((a, b) => (b.version > a.version ? b : a));
  return Object.freeze({
    version: page.version,
    identifiantVolume: page.identifiantVolume,
    emplacements: Object.freeze(
      page.emplacements.map((emplacement) =>
        Object.freeze({
          identifiantEmplacement: emplacement.identifiantEmplacement,
          typeKek: emplacement.typeKek,
          parametres: emplacement.parametres,
        }),
      ),
    ),
  });
}
