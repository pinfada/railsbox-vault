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
// TROIS valeurs tirées entrent dans le fichier : le NONCE de chaque scellement, l'IDENTIFIANT d'un
// emplacement, et — depuis la page v2 (#182, T2b) — le SEL de la clé de racine. Les remplacer est
// nécessaire pour reproduire les vecteurs figés, et catastrophique partout ailleurs : deux DEK
// enveloppées sous la même KEK, la même identité d'emplacement et le même nonce livrent le
// ou-exclusif des deux clés de volume ; deux pages scellées sous le même sel ET le même nonce sont
// la collision de clé/nonce que la séparation par domaine a précisément pour objet de borner. La
// porte exige donc le jeton `HARNAIS_ALEAS_JETON`, sur le modèle de `scellement.mjs` ; ce qui
// interdit son usage, c'est `tests/unit/harnais-portes.test.mjs`, qui refuse tout appelant hors des
// épreuves. Une SEULE porte pour les trois valeurs : trois portes auraient fini par diverger.

import { tirerNonce } from "./format-chiffre/identite-logique.mjs";
import { tirerSelDeDomaine } from "./derivation/cle-de-domaine.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  dernierEmplacement,
  emplacementInconnu,
  enveloppeIllisible,
  enveloppePleine,
  enveloppePresente,
  identiteDeclareeIncoherente,
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
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  TYPES_KEK,
  exigerParametres,
  exigerTypeKek,
  tirerIdentifiantEmplacement,
} from "./enveloppe/identite-enveloppe.mjs";
import { OCTET_DOMAINE_ENVELOPPE, cleNeuveDeRacineV2 } from "./enveloppe/cle-de-racine.mjs";
import {
  envelopperSousNonce,
  importerCleDeDeverrouillage,
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

/**
 * Les aléas par défaut : douze octets de nonce, huit d'identifiant, trente-deux de sel — tirés à
 * chaque appel, et par `crypto.getRandomValues` seul.
 */
const ALEAS_REELS = Object.freeze({
  tirerNonce,
  tirerIdentifiant: tirerIdentifiantEmplacement,
  tirerSel: tirerSelDeDomaine,
});

/**
 * Vérifie la porte des aléas et rend la source à employer.
 *
 * EXPORTÉE depuis #149 : `enveloppe-de-recuperation.mjs` scelle une racine, donc tire un nonce, donc
 * franchit la même porte. Lui faire réécrire la garde en aurait fait une SECONDE garde, qu'une
 * correction de l'une laisserait diverger de l'autre ; la partager laisse la porte à un seul
 * endroit, avec un seul jeton.
 *
 * @param {{ tirerNonce?: () => Uint8Array, tirerIdentifiant?: () => string,
 *           tirerSel?: () => Uint8Array, jeton?: string }} aleas
 */
export function exigerAleasAdmis(aleas) {
  if (aleas === undefined) return ALEAS_REELS;
  if (aleas.jeton !== HARNAIS_ALEAS_JETON) throw new Error(REFUS_ALEAS);
  return Object.freeze({
    tirerNonce: aleas.tirerNonce ?? ALEAS_REELS.tirerNonce,
    tirerIdentifiant: aleas.tirerIdentifiant ?? ALEAS_REELS.tirerIdentifiant,
    tirerSel: aleas.tirerSel ?? ALEAS_REELS.tirerSel,
  });
}

/**
 * OUVRE l'enveloppe, MIGRE sa page si elle est encore en v1, et rend la clé de volume.
 *
 * @param {{ support: object, identifiantVolume: string, kek: Uint8Array,
 *           versionMinimale?: number | null, aleas?: object }} appel
 * @returns {Promise<{ dek: Uint8Array, identifiantEmplacement: string, version: number,
 *                     migration: object | null }>}
 *   `migration` est `null` quand la page était déjà en v2 — le cas ordinaire.
 * @throws {EnveloppeError} `VAULT_ENVELOPPE_ABSENTE` si aucune enveloppe n'existe —
 *   distinct de `VAULT_ENVELOPPE_CLE_REFUSEE`, qui dit que la clé n'ouvre rien.
 */
export async function ouvrirEnveloppe({
  support,
  identifiantVolume,
  kek,
  versionMinimale = null,
  aleas,
}) {
  const cleKek = await importerCleDeDeverrouillage(kek);
  const etat = await lireEtat({ support, identifiantVolume, kek: cleKek, versionMinimale });
  const migration = await migrerLaPageV1({
    support,
    identifiantVolume,
    cleKek,
    etat,
    aleas,
  });
  return Object.freeze({
    dek: etat.dek,
    identifiantEmplacement: etat.identifiantEmplacement,
    version: migration === null || !migration.faite ? etat.version : migration.version,
    migration,
  });
}

/**
 * RESCELLE une page d'enveloppe **v1** en **v2**, à la PREMIÈRE OUVERTURE RÉUSSIE (#182, T2b).
 *
 * C'est le geste le plus risqué des deux tranches, et l'ADR 0033 le dit : « perdre une enveloppe,
 * c'est perdre le volume ». Tout ce qui suit est écrit pour que cette phrase reste théorique.
 *
 * ## Pourquoi ici, et pourquoi à la première ouverture RÉUSSIE
 *
 * Rescelle qui peut : il faut la DEK, et la DEK ne s'obtient qu'en développant un emplacement sous
 * une KEK valable. Le seul moment où le produit la tient est donc celui-ci. Une migration lancée
 * ailleurs — au démarrage, sur inventaire — n'aurait pas la clé ; une migration lancée sur une
 * ouverture REFUSÉE écrirait une page à partir de rien.
 *
 * ## Ce que chaque rang de coupure laisse, et pourquoi aucun ne perd le volume
 *
 * Le geste porte DEUX écritures, et pas quatre : la page v2 est publiée sur la page LIBRE, et la
 * page v1 n'est **pas** effacée. C'est la différence avec une révocation, et elle est voulue.
 *
 *  1. **avant la barrière** — la page v1 est intacte et fait autorité ; la page libre porte un
 *     brouillon que sa somme de contrôle écarte. L'enveloppe s'ouvre, en v1 ;
 *  2. **après la barrière** — la page v2 est complète, durable, et sa version est celle de la v1
 *     plus un : elle fait autorité. La page v1 reste là, plus ancienne, et redevient le repli si la
 *     v2 devient illisible. L'enveloppe s'ouvre, en v2 ;
 *  3. **jamais un sous-ensemble** — la liste des emplacements est recopiée TELLE QUELLE. Aucune
 *     DEK n'est réenveloppée, aucune KEK n'est demandée, aucun emplacement n'est perdu : c'est ce
 *     que `EMPLACEMENT_FORMAT_V1` achète, et c'est pourquoi ce champ ne suit pas la page.
 *
 * La page v1 survivante disparaît d'elle-même à la mutation suivante, qui écrit sur la page libre —
 * c'est-à-dire sur elle. Aucun geste n'est ajouté pour l'effacer : en ajouter un retirerait au rang
 * 2 le repli qui fait toute la sûreté de ce geste.
 *
 * ## Un échec d'écriture ne fait PAS échouer le déverrouillage
 *
 * Le quota est plein, le handle a disparu, le support refuse : le volume s'ouvre quand même, sous sa
 * page v1, et la migration sera retentée à la prochaine ouverture. Refuser le déverrouillage parce
 * qu'un changement de FORMAT n'a pas pu s'écrire enfermerait l'utilisateur dehors pour une raison
 * qui n'est pas la sienne. Rien n'est avalé pour autant : le refus est RENDU dans `migration`, et
 * l'appelant le publie. C'est la distinction entre « ne pas lever » et « taire ».
 *
 * ## La RELECTURE, et pourquoi elle est dans le geste
 *
 * La migration n'est déclarée faite qu'une fois la page v2 RELUE sous la même KEK, à la version
 * attendue. Écrire et croire aurait suffi tant que rien ne va mal ; relire est ce qui distingue
 * « la page est là » de « la page s'ouvre ».
 */
async function migrerLaPageV1({ support, identifiantVolume, cleKek, etat, aleas }) {
  if (etat.page.formatVersion !== ENVELOPPE_FORMAT_V1) return null;
  const version = versionSuivante(etat);
  try {
    const octets = await composerPage({
      identifiantVolume,
      version,
      dek: etat.dek,
      emplacements: etat.page.emplacements,
      aleas: exigerAleasAdmis(aleas),
    });
    await publier(support, etat.pageLibre, octets);
    const relu = await lireEtat({ support, identifiantVolume, kek: cleKek });
    if (relu.page.formatVersion !== ENVELOPPE_FORMAT_V2 || relu.version !== version) {
      return rapportDeMigration({
        faite: false,
        version: etat.version,
        refus: `la page relue est en version ${relu.page.formatVersion} à l'indice ${relu.version}`,
      });
    }
    return rapportDeMigration({ faite: true, version, refus: null });
  } catch (cause) {
    return rapportDeMigration({
      faite: false,
      version: etat.version,
      refus: cause?.code ?? cause?.name ?? String(cause),
    });
  }
}

/**
 * La version que la page MIGRÉE portera : celle de la v1, plus un.
 *
 * Un cran, et un seul. Repartir de la même ferait cohabiter deux pages de même version, que le
 * lecteur départagerait par leur INDEX — c'est-à-dire par rien —, et l'alternance cesserait de dire
 * laquelle des deux fait autorité.
 */
function versionSuivante(etat) {
  return etat.version + 1;
}

/** Le compte rendu d'une migration de page. Toujours les mêmes champs, faite ou non. */
function rapportDeMigration({ faite, version, refus }) {
  return Object.freeze({
    de: ENVELOPPE_FORMAT_V1,
    vers: ENVELOPPE_FORMAT_V2,
    faite,
    version,
    refus,
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
      // La version de format d'un EMPLACEMENT vaut 1 et ne suit PAS celle de la page : voir
      // `EMPLACEMENT_FORMAT_V1`. C'est ce qui rend la migration d'une page v1 en v2 possible sans
      // détenir les huit clés de déverrouillage.
      formatVersion: EMPLACEMENT_FORMAT_V1,
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

/**
 * Scelle la racine sur une liste ordonnée et rend les octets d'une page **v2**.
 *
 * ## Une page, une clé, un scellement (#182, ADR 0033, décisions 2, 3 et 4)
 *
 * La racine n'est plus scellée sous la DEK : le sel est TIRÉ ici, la clé du domaine `enveloppe` en
 * descend par HKDF, et elle ne sert qu'à CE scellement. C'est ce qui rend le budget de clé de ce
 * domaine exhaustif sans compteur : son budget vaut 1, et aucun état durable ne peut le rendre faux.
 *
 * **Le sel est TIRÉ ici, et nulle part ailleurs.** `cleNeuveDeRacineV2` l'EXIGE et n'en tire aucun
 * (`exigerSelDePage`) : le tirage est l'affaire de la source d'aléas, appelée trois lignes plus bas,
 * et c'est le seul endroit du chemin de production qui tire un sel de page. La campagne de mutation
 * a fait retirer un SECOND tirage qui n'était jamais atteint ; ce commentaire décrivait encore
 * l'état d'avant, et la revue de la PR #187 l'a relevé (constat 9 de la revue de format).
 *
 * Ce que la discipline vise reste vrai : un appelant qui choisirait le sel pourrait le RÉPÉTER, et
 * deux pages scellées sous la même clé et le même nonce sont la collision que la séparation par
 * domaine a précisément pour objet de borner. La source d'aléas est scriptable par le harnais, et
 * elle seule.
 *
 * **Ce chemin n'écrit JAMAIS une page v1**, et c'est la moitié « écriture » du refus de
 * rétrogradation : une enveloppe passée en v2 ne peut pas revenir en arrière par un geste du
 * produit. L'autre moitié est dans `etat-de-lenveloppe.mjs`, qui refuse qu'une page v1 fasse
 * autorité au-dessus d'une page v2.
 */
async function composerPage({
  identifiantVolume,
  version,
  dek,
  emplacements,
  aleas,
  domaine = OCTET_DOMAINE_ENVELOPPE,
}) {
  const cleDeRacine = await cleNeuveDeRacineV2({
    dek,
    identifiantVolume,
    domaine,
    sel: aleas.tirerSel(),
  });
  const racine = await scellerRacineSousNonce({
    cleDeRacine: cleDeRacine.cle,
    racine: { identifiantVolume, formatVersion: ENVELOPPE_FORMAT_V2, version },
    emplacements,
    nonce: aleas.tirerNonce(),
  });
  return encoderPage({
    identifiantVolume,
    version,
    formatVersion: ENVELOPPE_FORMAT_V2,
    racine: { nonce: racine.nonce, chiffre: racine.chiffre, etiquette: racine.etiquette },
    sel: cleDeRacine.sel,
    domaine: cleDeRacine.domaine,
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
 * ## Un fichier `.cles` déjà PRÉSENT est refusé, avant tout geste (#159)
 *
 * Un emplacement occupé n'est jamais écrasé : soit c'est l'enveloppe de CE volume (la recréer
 * détruirait des emplacements sans geste explicite), soit celle d'un AUTRE (l'écraser détruirait une
 * enveloppe qui n'est pas la nôtre) — `creer` ne lit rien de ce qui est déjà là pour trancher, donc
 * refuse avant même de fabriquer l'emplacement. Seul le retrait explicite (ADR 0020 déc. 1,
 * `removeOpfsVolume` avec ses voisins) ouvre la voie à une création sur un emplacement occupé.
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
  const etat = await support.etat();
  if (etat.present && etat.taille > 0) {
    throw enveloppePresente({ volume: identifiantVolume });
  }
  const sources = exigerAleasAdmis(aleas);
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
  const sources = exigerAleasAdmis(aleas);
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
 *
 * ## L'identifiant est confronté AVANT de retenir la plus récente (#159)
 *
 * Même règle que `ouvrirRacine` (ADR 0020, déc. 3), au même endroit de la lecture : une page dont
 * l'identifiant déclaré diffère n'est PAS candidate, quelle que soit sa version — sinon un fichier
 * portant la page d'un AUTRE volume plus récente rendrait ses données à l'inventaire. Si aucune page
 * valide ne nomme ce volume, le refus est `VAULT_ENVELOPPE_IDENTITE`, jamais « aucune enveloppe » :
 * dire « absent » là où il y a l'enveloppe d'un autre volume serait un mensonge. Sans clé, la
 * confrontation ne porte que sur le champ déclaré en clair — voir `identiteDeclareeIncoherente`.
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
  const memesVolumes = pages.filter((page) => page.identifiantVolume === identifiantVolume);
  if (memesVolumes.length === 0) throw identiteDeclareeIncoherente({ volume: identifiantVolume });
  const page = memesVolumes.reduce((a, b) => (b.version > a.version ? b : a));
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
