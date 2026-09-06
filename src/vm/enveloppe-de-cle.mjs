// L'ENVELOPPE DE CLÉ du produit : les six opérations, sur un support (#21, ADR 0020 ; #148, ADR 0026).
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
  dernierEmplacement,
  emplacementInconnu,
  enveloppeIllisible,
  enveloppePleine,
  malforme,
} from "./enveloppe/enveloppe-errors.mjs";
import {
  effacerLaPageLiberee,
  lireEtat,
  lireFichier,
  publier,
} from "./enveloppe/etat-de-lenveloppe.mjs";
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
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
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

/**
 * Applique une transformation de la liste, scelle, et publie sur la page libre.
 *
 * `transformer` reçoit l'ÉTAT COMPLET, et notamment `identifiantEmplacement` : l'emplacement que la
 * KEK présentée a réellement ouvert. C'est ce qui permet à `revoquerToutSauf` de conserver celui
 * qu'on tient sans qu'on ait à le nommer.
 *
 * `retire` dit si la mutation RETIRE une clé de déverrouillage. Si oui, la page qui vient de perdre
 * l'autorité est effacée après la barrière : voir `effacerLaPageLiberee`. Une mutation qui n'en
 * retire aucune — créer, ajouter — ne l'efface pas ; elle paierait une écriture et une barrière pour
 * rien, et retirerait au geste SUIVANT le point de reprise que l'alternance lui offre.
 */
async function muter({ support, identifiantVolume, kek, aleas, transformer, retire = false }) {
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
  if (retire) await effacerLaPageLiberee(support, etat.index);
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
    // Un remplacement RETIRE une clé, tout comme une révocation : la même règle s'applique, et
    // laisser l'ancien scellement dans la page libre ferait de la rotation d'une clé compromise un
    // geste qui ne retire rien pendant une mutation entière.
    retire: true,
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
 * zéro compris. Rien de l'ancien emplacement ne survit dans la page publiée, ni — depuis #148 —
 * dans la page qu'elle libère.
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
    retire: true,
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

/**
 * RÉVOCATION D'URGENCE : retire TOUS les emplacements sauf celui que la KEK présentée ouvre, en une
 * version et une barrière (#148, ADR 0026).
 *
 * ## Il n'y a PAS de paramètre pour désigner l'emplacement conservé, et c'est la décision
 *
 * L'emplacement retenu est **celui que la KEK présentée ouvre**, jamais un identifiant fourni. On ne
 * garde pas un emplacement qu'on ne sait pas ouvrir : ce serait la seule façon de sortir d'une
 * urgence avec une enveloppe dont on a perdu la clé, et surtout la seule façon de conserver par
 * mégarde l'emplacement d'un adversaire. « Tout sauf celui que je tiens » est littéral.
 *
 * ## Pourquoi UN geste, et non N−1 révocations
 *
 * `revoquerEmplacement` retire un emplacement par version. Réduire une enveloppe de huit clés à une
 * demandait donc sept mutations, sept barrières et six états intermédiaires — six rangs où une
 * coupure laisse une révocation PARTIELLE, c'est-à-dire un adversaire dont la clé a survécu au geste
 * qui devait la retirer. Ici, la matrice de coupures ne connaît que deux états : toutes les clés, ou
 * la seule retenue.
 *
 * ## Un SEUL emplacement présent est admis
 *
 * Il n'y a rien à retirer, et le geste écrit tout de même : la version avance, et la page libérée
 * est effacée — ce qui est précisément ce qu'une urgence veut. Refuser ici ferait dépendre l'issue
 * du geste d'un état que l'appelant n'a pas à connaître, et il n'existe aucun refus à inventer pour
 * cela. `VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` ne s'applique pas : ce geste ne peut pas vider
 * l'enveloppe, il en laisse toujours exactement un.
 *
 * @param {{ support: object, identifiantVolume: string, kek: Uint8Array, aleas?: object }} appel
 * @returns {Promise<{ version: number, nombreEmplacements: number }>} `nombreEmplacements` vaut 1
 * @throws {EnveloppeError} `VAULT_ENVELOPPE_CLE_REFUSEE` si la KEK n'ouvre rien — le même refus que
 *   toute autre mutation, et aucun code nouveau
 */
export async function revoquerToutSauf({ support, identifiantVolume, kek, aleas }) {
  return muter({
    support,
    identifiantVolume,
    kek,
    aleas,
    retire: true,
    transformer: async (etat) =>
      etat.page.emplacements.filter(
        (existant) => existant.identifiantEmplacement === etat.identifiantEmplacement,
      ),
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
