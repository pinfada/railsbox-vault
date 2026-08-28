// FRAÎCHEUR du volume : empreinte de la région d'authentification, et témoin de dernière séquence
// vue (#19, ADR 0019).
//
// Ce module porte les deux objets que #19 ajoute, et rien d'autre. Il ne touche à aucun support : il
// reçoit une fonction de lecture, un scellement, et rend des octets. C'est ce qui permet de
// l'éprouver sous Node exactement tel que le Worker l'exécute.
//
// ## L'empreinte de région ferme le retour arrière d'un SECTEUR
//
// L'ADR 0015 le nomme et ne le détecte pas : un secteur du volume est ouvert sous une identité que
// le lecteur ne connaît pas d'avance, puisqu'il lit sa GÉNÉRATION dans la région d'authentification,
// juste à côté du nonce et de l'étiquette du même secteur. Le sceau et l'identité viennent du même
// endroit, et remettre en place le quadruplet complet d'une version antérieure produit un ensemble
// cohérent que le lecteur accepte.
//
// La parade est de sceller, AILLEURS, une empreinte de la région entière. « Ailleurs » veut dire :
// dans la racine de génération, dont l'autorité vient du journal et pas du volume. Un secteur ramené
// en arrière change son sceau, donc la région, donc l'empreinte — et l'ouverture refuse avant
// d'avoir lu un seul secteur.
//
// **L'empreinte est RESCELLÉE à chaque écriture de racine, sous la génération de cette racine.**
// Ce n'est pas une précaution de style : sans cela, un adversaire pourrait épisser dans une racine
// récente l'empreinte scellée d'une racine ancienne — authentique — et faire passer la région
// d'hier pour celle d'aujourd'hui. Le rescellement coûte un scellement de 32 octets par racine ; il
// est compté dans le budget de clé, et l'ADR 0019 le chiffre.
//
// ## Le témoin ferme le retour arrière PARTIEL, et pas l'autre
//
// Le témoin est un fichier voisin — `<volume>.temoin` — écrit APRÈS la racine et sa barrière. Il
// porte la dernière séquence vue, scellée sous la clé du volume. Un volume dont la racine porte une
// séquence inférieure est refusé.
//
// Ce qu'il ne fait pas, et qu'aucune formulation de ce dépôt ne doit laisser croire : il ne détecte
// PAS un retour arrière qui l'emporte lui aussi. Il vit dans la même origine que le volume.
//
// **Et l'effort n'est PAS symétrique.** Reculer le volume suppose d'en détenir une copie antérieure,
// cohérente avec son journal. Neutraliser le témoin ne suppose rien : `ouvrirTemoin` ci-dessous ne
// juge un fichier que sur son marqueur et sa longueur, si bien que le SUPPRIMER ou simplement le
// TRONQUER suffit — et sans la clé. L'ouverture repart alors sur « première ouverture », donc sans
// plancher de séquence, et la fenêtre du retour arrière complet est RÉARMÉE pour qui détient déjà
// une copie antérieure de volume + journal.
//
// Ce comportement est délibéré et ne doit pas changer : refuser tout volume sans témoin rendrait
// irouvrable un volume neuf, un volume restauré depuis une archive, ou un volume dont le témoin a
// été perdu par un incident de support — on échangerait une détection qu'on n'a pas contre une perte
// de données qu'on aurait. Ce qui manque n'est pas une garde de plus ici : c'est une ANCRE MONOTONE
// hors du support, sans laquelle aucun état local n'a d'autorité sur sa propre fraîcheur. La seule
// barrière contre le retour arrière COMPLET reste donc le partitionnement d'origine de l'ADR 0002,
// et l'ancrage est renvoyé nommément à #23.
//
// Le témoin est SCELLÉ, et il faut dire ce que cela achète : un témoin forgé — une séquence inventée
// par qui n'a pas la clé — est refusé au lieu d'être cru. Cela ne rend pas le témoin monotone ; cela
// évite seulement qu'un tiers sans clé fabrique un refus permanent en y inscrivant une séquence
// démesurée.

import {
  EMPREINTE_OCTETS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  RANG_MAX,
} from "./format-chiffre/identite-logique.mjs";
import { egalesEnTempsConstant } from "./format-chiffre/octets.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";
import { SCEAU_OCTETS, decoderSceau, encoderSceau } from "./volume-chiffre-format.mjs";

/** Empreinte SHA-256 de la région : la même largeur que celle de la suite des entrées. */
export const EMPREINTE_REGION_OCTETS = EMPREINTE_OCTETS;

/** Ce que la racine porte en plus depuis #19 : le sceau de l'empreinte, puis son chiffré. */
export const FRAICHEUR_OCTETS = SCEAU_OCTETS + EMPREINTE_REGION_OCTETS;

/**
 * Rangs RÉSERVÉS des deux objets de fraîcheur, pris au SOMMET de l'espace des rangs.
 *
 * Un rang sépare des domaines dans les données associées (ADR 0015). Ceux qu'un volume emploie
 * réellement partent de zéro — zéro pour un secteur du volume, le rang d'une entrée dans sa charge
 * pour un enregistrement de journal —, et la charge est plafonnée à 16 Mio, soit au plus quelques
 * dizaines de milliers d'entrées. Prendre les deux plus grands rangs représentables met donc ces
 * identités hors d'atteinte de toute collision, sans coûter un octet de format.
 */
export const RANG_EMPREINTE_REGION = RANG_MAX;
export const RANG_TEMOIN = RANG_MAX - 1;

/** Tranche de lecture de la région. Constante : la surmémoire ne suit pas la taille du volume. */
export const TRANCHE_REGION_OCTETS = 1024 * 1024;

/** Marqueur du fichier témoin. Huit octets, jamais modifiés. */
const MARQUEUR_TEMOIN = Uint8Array.from([0x56, 0x4c, 0x54, 0x54, 0x45, 0x4d, 0x30, 0x31]); // "VLTTEM01"

/** Version du format du témoin, distincte de celle du journal et de celle du volume. */
export const TEMOIN_FORMAT = 1;

/** Le CLAIR d'un témoin : séquence sur 8 octets, génération sur 6, fraîcheur sur 1, réserve sur 1. */
const TEMOIN_CLAIR_OCTETS = 16;

/** Taille du fichier témoin : en-tête, nonce, étiquette, chiffré. */
export const TEMOIN_OCTETS = 16 + NONCE_OCTETS + ETIQUETTE_OCTETS + TEMOIN_CLAIR_OCTETS;

/** Cause portée par un refus de fraîcheur de région. Distincte de celles du format chiffré. */
export const CAUSE_FRAICHEUR_REGION = "VAULT_FRAICHEUR_REGION";

/** Cause portée par un refus dû au témoin lui-même, hors rejeu constaté sur une racine. */
export const CAUSE_TEMOIN = "VAULT_TEMOIN_SEQUENCE";

function ecrireEntier(vue, position, valeur, octets) {
  if (!Number.isSafeInteger(valeur) || valeur < 0 || valeur > 2 ** (octets * 8) - 1) {
    throw new RangeError(`${valeur} ne tient pas sur ${octets} octet(s).`);
  }
  let reste = valeur;
  for (let index = 0; index < octets; index += 1) {
    vue.setUint8(position + index, reste % 256);
    reste = Math.floor(reste / 256);
  }
}

function lireEntier(vue, position, octets) {
  let valeur = 0;
  for (let index = octets - 1; index >= 0; index -= 1) {
    valeur = valeur * 256 + vue.getUint8(position + index);
  }
  return valeur;
}

/** Identité logique RÉSERVÉE de l'empreinte de région, sous la génération de sa racine. */
export function identiteDeRegion(generation) {
  return {
    generation,
    rang: RANG_EMPREINTE_REGION,
    adresse: 0,
    longueur: EMPREINTE_REGION_OCTETS,
  };
}

/** Identité logique RÉSERVÉE d'un témoin. Sa génération vit dans le CLAIR, pas dans l'identité. */
function identiteDeTemoin() {
  return { generation: 0, rang: RANG_TEMOIN, adresse: 0, longueur: TEMOIN_CLAIR_OCTETS };
}

/**
 * Empreinte SHA-256 de la région d'authentification, lue EN FLUX.
 *
 * Le hachage est incrémental (`sha256-stream.mjs`), et la surmémoire vaut une tranche — jamais la
 * taille de la région. Pour le volume applicatif de 512 Mio la région fait 34 Mio ; la tenir
 * entière serait tenable, mais la borne de `docs/quality-attributes.md` porte sur le RÉGIME, pas
 * sur un cas particulier.
 *
 * Une tranche qui ne rend pas ce qu'on lui demande est un ÉCHEC, jamais une région plus courte :
 * hacher moins d'octets rendrait une empreinte qui ne concorde avec rien, et le refus qui suivrait
 * désignerait un adversaire là où c'est le support qui a lâché.
 *
 * @param {{ lireRegion: (offset: number, longueur: number) => Promise<Uint8Array>,
 *           volume: string, regionOffset: number, regionOctets: number, tranche?: number }} appel
 * @returns {Promise<Uint8Array>} `EMPREINTE_REGION_OCTETS` octets
 */
export async function empreinteDeRegion({
  lireRegion,
  volume,
  regionOffset,
  regionOctets,
  tranche = TRANCHE_REGION_OCTETS,
}) {
  const flux = createSha256Stream();
  for (let position = 0; position < regionOctets; position += tranche) {
    const longueur = Math.min(tranche, regionOctets - position);
    const octets = await lireRegion(regionOffset + position, longueur);
    if (!(octets instanceof Uint8Array) || octets.byteLength !== longueur) {
      throw new StorageError(
        STORAGE_ERROR_CODES.shortRead,
        `Région d'authentification du volume « ${volume} » : ${octets?.byteLength ?? "aucun"} octet(s) rendus sur ${longueur} demandés à l'offset ${regionOffset + position}. Rien n'est complété, et aucune empreinte n'est calculée sur une région partielle.`,
        { volume, offset: regionOffset + position, requested: longueur },
      );
    }
    flux.update(octets);
  }
  return flux.digest();
}

/**
 * SCELLE une empreinte de région sous la génération d'une racine. Rend les octets que la racine
 * porte : le sceau, puis le chiffré.
 *
 * @param {import("./scellement.mjs").Scellement} scellement
 * @param {number} generation génération de la racine qui portera ces octets
 * @param {Uint8Array} empreinte
 * @returns {Promise<Uint8Array>} `FRAICHEUR_OCTETS` octets
 */
export async function scellerFraicheur(scellement, generation, empreinte) {
  const scelle = await scellement.scellerBloc(identiteDeRegion(generation), empreinte);
  const octets = new Uint8Array(FRAICHEUR_OCTETS);
  octets.set(encoderSceau({ nonce: scelle.nonce, etiquette: scelle.etiquette, generation }), 0);
  octets.set(scelle.chiffre, SCEAU_OCTETS);
  return octets;
}

/**
 * CONFRONTE la région relue à l'empreinte qu'une racine scelle.
 *
 * L'ordre est celui de l'ADR 0015, et il n'est pas négociable : l'empreinte authentique est obtenue
 * d'abord — c'est `ouvrirBloc` qui vérifie l'étiquette —, et la comparaison ne vient qu'après. Le
 * MINIMUM DE GÉNÉRATION présenté est celui de la racine porteuse : une empreinte authentique mais
 * scellée sous une génération antérieure a été épissée, et le refus est alors un `VAULT_CRYPTO_REJEU`
 * établi, pas une devinette.
 *
 * @param {{ scellement: object, volume: string, fraicheur: Uint8Array, generation: number,
 *           empreinte: Uint8Array }} appel
 */
export async function confronterFraicheur({
  scellement,
  volume,
  fraicheur,
  generation,
  empreinte,
}) {
  const sceau = decoderSceau(fraicheur.subarray(0, SCEAU_OCTETS));
  const authentique = await scellement.ouvrirBloc(
    identiteDeRegion(sceau.generation),
    {
      nonce: sceau.nonce,
      etiquette: sceau.etiquette,
      chiffre: fraicheur.slice(SCEAU_OCTETS, FRAICHEUR_OCTETS),
    },
    { generationMinimale: generation },
  );
  if (egalesEnTempsConstant(authentique, empreinte)) return;
  throw new StorageError(
    STORAGE_ERROR_CODES.generationCorrupt,
    `Volume « ${volume} » refusé : la région d'authentification relue ne concorde pas avec l'empreinte que la dernière racine validée scelle. Au moins un secteur porte un sceau qui n'est pas celui de cet état — typiquement une version antérieure remise en place. Aucun secteur n'est lu ; le remède est de restaurer une sauvegarde.`,
    { volume, generation, cause: CAUSE_FRAICHEUR_REGION },
  );
}

/**
 * SCELLE un témoin. Le clair porte séquence, génération et l'état de la fraîcheur de région ; ce
 * dernier bit existe pour qu'une racine qui perdrait son empreinte soit vue comme un RECUL et non
 * comme un volume d'avant #19.
 *
 * @param {import("./scellement.mjs").Scellement} scellement
 * @param {{ sequence: number, generation: number, fraicheurActive: boolean }} vu
 * @returns {Promise<Uint8Array>} `TEMOIN_OCTETS` octets, prêts à écrire
 */
export async function scellerTemoin(scellement, { sequence, generation, fraicheurActive }) {
  const clair = new Uint8Array(TEMOIN_CLAIR_OCTETS);
  const vueClair = new DataView(clair.buffer);
  ecrireEntier(vueClair, 0, sequence, 8);
  ecrireEntier(vueClair, 8, generation, 6);
  clair[14] = fraicheurActive ? 1 : 0;
  const scelle = await scellement.scellerBloc(identiteDeTemoin(), clair);

  const octets = new Uint8Array(TEMOIN_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MARQUEUR_TEMOIN, 0);
  vue.setUint32(8, TEMOIN_FORMAT, true);
  octets.set(scelle.nonce, 16);
  octets.set(scelle.etiquette, 16 + NONCE_OCTETS);
  octets.set(scelle.chiffre, 16 + NONCE_OCTETS + ETIQUETTE_OCTETS);
  return octets;
}

/** Vrai si `octets` a l'apparence d'un témoin. Un fichier absent ou vide n'en est pas un. */
function ressembleAUnTemoin(octets) {
  return (
    octets instanceof Uint8Array &&
    octets.byteLength >= TEMOIN_OCTETS &&
    MARQUEUR_TEMOIN.every((attendu, position) => octets[position] === attendu)
  );
}

/**
 * OUVRE un témoin, ou rend `null` s'il n'y en a pas.
 *
 * `null` veut dire PREMIÈRE OUVERTURE, et jamais autre chose : un témoin absent n'est la preuve de
 * rien, et surtout pas qu'aucune séquence n'a jamais été vue. C'est écrit ici parce que c'est le
 * point où la nuance se perd le plus facilement.
 *
 * Un fichier qui ressemble à un témoin mais dont le sceau ne vérifie pas est REFUSÉ, jamais ignoré :
 * l'ignorer offrirait à quiconque peut écrire dans l'origine le moyen de désarmer le contrôle en
 * abîmant huit octets.
 *
 * `attentes.generationMinimale` vaut `null`, et c'est le SEUL `null` que #19 laisse sur un chemin de
 * production. La raison est écrite dans l'ADR 0019 : à l'ouverture, rien n'est encore connu qui
 * puisse minorer la génération d'un témoin, et un plancher de zéro serait décoratif — il ne
 * refuserait aucun témoin authentique. Ce qui contrôle le témoin est la confrontation de sa
 * SÉQUENCE à celle de la racine, faite par `ouvrirRacine`, sur un en-tête authentifié.
 *
 * @param {import("./scellement.mjs").Scellement} scellement
 * @param {string} volume
 * @param {Uint8Array | null} octets contenu du fichier voisin, ou `null`
 * @returns {Promise<{ sequence: number, generation: number, fraicheurActive: boolean } | null>}
 */
export async function ouvrirTemoin(scellement, volume, octets) {
  if (!ressembleAUnTemoin(octets)) return null;
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const format = vue.getUint32(8, true);
  if (format !== TEMOIN_FORMAT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.generationCorrupt,
      `Témoin de séquence du volume « ${volume} » refusé : format ${format} inconnu. Un témoin qu'on ne sait pas lire n'est pas un témoin absent — l'ignorer reviendrait à désarmer le contrôle en changeant quatre octets.`,
      { volume, format, cause: CAUSE_TEMOIN },
    );
  }
  const clair = await scellement.ouvrirBloc(
    identiteDeTemoin(),
    {
      nonce: octets.slice(16, 16 + NONCE_OCTETS),
      etiquette: octets.slice(16 + NONCE_OCTETS, 16 + NONCE_OCTETS + ETIQUETTE_OCTETS),
      chiffre: octets.slice(
        16 + NONCE_OCTETS + ETIQUETTE_OCTETS,
        16 + NONCE_OCTETS + ETIQUETTE_OCTETS + TEMOIN_CLAIR_OCTETS,
      ),
    },
    { generationMinimale: null },
  );
  const vueClair = new DataView(clair.buffer, clair.byteOffset, clair.byteLength);
  return Object.freeze({
    sequence: lireEntier(vueClair, 0, 8),
    generation: lireEntier(vueClair, 8, 6),
    fraicheurActive: clair[14] === 1,
  });
}

/**
 * Refus d'un volume dont le journal ne porte plus la racine que le témoin atteste.
 *
 * Ce cas est distinct du rejeu : il n'y a AUCUNE racine à confronter. Le témoin, lui, ne s'écrit
 * qu'après une racine et sa barrière — son existence prouve donc qu'une racine a été durable.
 */
export function journalSousLeTemoin(volume, temoin) {
  return new StorageError(
    STORAGE_ERROR_CODES.generationCorrupt,
    `Volume « ${volume} » refusé : le témoin atteste la séquence ${temoin.sequence}, durable après une barrière, et le journal de génération n'en porte plus aucune. Ce n'est pas un volume neuf — un volume neuf n'a pas de témoin. Aucun octet n'est écrit ; le remède est de restaurer une sauvegarde.`,
    { volume, sequence: temoin.sequence, cause: CAUSE_TEMOIN },
  );
}

/**
 * Refus d'une racine qui a PERDU son empreinte de région alors que le témoin la disait active.
 *
 * Sans ce contrôle, l'empreinte serait désarmable par un simple retour au format de journal
 * antérieur : présenter une racine authentique d'avant #19 suffirait à faire dire à l'ouverture
 * « ce volume n'a pas de fraîcheur, tant pis ». Le témoin ferme cette porte pour tout ce qui n'est
 * pas un retour arrière COMPLET — qui l'emporterait lui aussi, et que l'ADR 0019 laisse ouvert.
 */
export function fraicheurDesarmee(volume, temoin) {
  return new StorageError(
    STORAGE_ERROR_CODES.generationCorrupt,
    `Volume « ${volume} » refusé : sa dernière racine ne scelle aucune empreinte de région, alors que le témoin en atteste une à la séquence ${temoin.sequence}. Une propriété acquise ne se reperd pas ; ce que cet état décrit est un retour à une racine d'avant la fraîcheur. Le remède est de restaurer une sauvegarde.`,
    { volume, sequence: temoin.sequence, cause: CAUSE_FRAICHEUR_REGION },
  );
}

/**
 * ÉTATS de la fraîcheur, tels que le rapport d'ouverture les publie. Un contrôle qu'on ne publie pas
 * finit par être supposé actif.
 */
export const FRAICHEUR_ETATS = Object.freeze({
  /** Le magasin n'a reçu aucune source de région : aucune fraîcheur n'est prétendue. */
  nonFournie: "non-fournie",
  /** Aucune racine ne faisait autorité : il n'y avait rien à confronter. */
  sansRacine: "sans-racine",
  /** La racine trouvée est d'avant #19 ; la prochaine racine écrite portera l'empreinte. */
  migree: "migree",
  /** La région relue concorde avec l'empreinte que la dernière racine validée scelle. */
  verifiee: "verifiee",
});

/**
 * GARDE de fraîcheur d'un magasin : l'empreinte de région et le témoin, tenus ensemble.
 *
 * Elle vit à côté du magasin plutôt qu'en lui pour une raison de responsabilité, pas de taille : le
 * magasin décide de l'état d'une génération, la garde décide de ce qu'un support a le droit de
 * prétendre. Les mêler aurait mis la question « ce volume est-il celui que j'ai quitté ? » au milieu
 * de la machine à états d'une transaction.
 *
 * `null` n'existe pas ici : un magasin sans fraîcheur ne construit pas de garde, et le DÉCLARE.
 */
export class GardeDeFraicheur {
  #volume;
  #scellement;
  #source;
  #empreinte = null;
  /** Vrai tant que l'empreinte en cache ne décrit peut-être plus la région. Vrai au départ. */
  #sale = true;
  #temoin = null;
  #etat = FRAICHEUR_ETATS.nonFournie;

  /**
   * @param {{ volume: string, scellement: object,
   *           source: { regionOffset: number, regionOctets: number,
   *                     lireRegion: (offset: number, longueur: number) => Promise<Uint8Array>,
   *                     lireTemoin: () => Promise<Uint8Array | null>,
   *                     ecrireTemoin: (octets: Uint8Array) => Promise<unknown> } }} options
   */
  constructor({ volume, scellement, source }) {
    this.#volume = volume;
    this.#scellement = scellement;
    this.#source = source;
  }

  /** Ce que l'ouverture a fait de la fraîcheur. Publié dans le rapport, jamais tu. */
  get etat() {
    return this.#etat;
  }

  /** Le témoin trouvé à l'ouverture, ou `null` — c'est-à-dire PREMIÈRE OUVERTURE, rien de plus. */
  get temoin() {
    return this.#temoin;
  }

  /** Rend ce que la source tient — typiquement le handle exclusif du témoin. Jamais deux fois. */
  fermer() {
    this.#source.fermer?.();
  }

  /** La région a changé : l'empreinte en cache ne la décrit plus. Appelé à chaque écriture du volume. */
  marquerRegionSale() {
    this.#sale = true;
  }

  /** Lit et ouvre le témoin. À faire AVANT de constater le journal : il fixe le plancher. */
  async lireTemoin() {
    this.#temoin = await ouvrirTemoin(
      this.#scellement,
      this.#volume,
      await this.#source.lireTemoin(),
    );
    return this.#temoin;
  }

  /** Empreinte de la région, recalculée seulement si le volume a été écrit depuis la dernière. */
  async empreinte() {
    if (!this.#sale && this.#empreinte !== null) return this.#empreinte;
    this.#empreinte = await empreinteDeRegion({
      lireRegion: this.#source.lireRegion,
      volume: this.#volume,
      regionOffset: this.#source.regionOffset,
      regionOctets: this.#source.regionOctets,
    });
    this.#sale = false;
    return this.#empreinte;
  }

  /**
   * CONFRONTE la région à ce que la racine qui fait autorité scelle. À faire AVANT toute lecture de
   * secteur : un volume dont la région ne concorde plus ne doit rendre aucun clair, fût-il
   * authentique.
   */
  async confronter(racine) {
    if (racine === null) {
      if (this.#temoin !== null) throw journalSousLeTemoin(this.#volume, this.#temoin);
      this.#etat = FRAICHEUR_ETATS.sansRacine;
      return;
    }
    if (racine.fraicheur === null) {
      if (this.#temoin?.fraicheurActive) throw fraicheurDesarmee(this.#volume, this.#temoin);
      this.#etat = FRAICHEUR_ETATS.migree;
      return;
    }
    await confronterFraicheur({
      scellement: this.#scellement,
      volume: this.#volume,
      fraicheur: racine.fraicheur,
      generation: racine.generation,
      empreinte: await this.empreinte(),
    });
    this.#etat = FRAICHEUR_ETATS.verifiee;
  }

  /**
   * Les octets de fraîcheur qu'une racine de génération `generation` doit porter.
   *
   * **L'état publié n'est PAS touché ici, et c'est le point.** Écrire une empreinte n'est pas en
   * vérifier une : le rapport d'ouverture doit dire ce que la CONFRONTATION a trouvé, pas ce que le
   * vidage a écrit juste après. Le relever ici ferait dire « vérifiée » à l'ouverture qui MIGRE un
   * volume de #18 — c'est-à-dire précisément à la seule qui n'a rien vérifié.
   */
  async pourRacine(generation) {
    return scellerFraicheur(this.#scellement, generation, await this.empreinte());
  }

  /**
   * Écrit le témoin. Appelé APRÈS la racine et sa barrière, et jamais avant : un témoin en avance
   * sur le journal refuserait un volume que rien n'a fait reculer.
   */
  async ecrireTemoin({ sequence, generation }) {
    await this.#source.ecrireTemoin(
      await scellerTemoin(this.#scellement, { sequence, generation, fraicheurActive: true }),
    );
    this.#temoin = Object.freeze({ sequence, generation, fraicheurActive: true });
  }
}

/**
 * Construit la GARDE de fraîcheur, ou refuse un oubli.
 *
 * `undefined` est refusé, `null` déclare l'absence. La distinction n'est pas de la coquetterie : un
 * magasin sans garde n'écrit aucune empreinte de région et n'écrit aucun témoin, donc il produit un
 * volume que #19 ne sait pas dater. C'est une décision, elle doit s'écrire à l'appel — et les seuls
 * appelants qui la prennent sont des bancs et des outils de mesure, jamais l'ouvreur du produit.
 */
export function construireGarde({ volume, scellement, fraicheur }) {
  if (fraicheur === undefined) {
    throw new TypeError(
      `Magasin de générations du volume « ${volume} » : « fraicheur » est obligatoire — une source de région et de témoin (ADR 0019), ou « null » pour déclarer qu'aucune fraîcheur n'est tenue. Un oubli aurait produit un volume sans empreinte de région ni témoin, sans que personne l'ait décidé.`,
    );
  }
  if (fraicheur === null) return null;
  for (const nom of ["regionOffset", "regionOctets", "lireRegion", "lireTemoin", "ecrireTemoin"]) {
    if (fraicheur[nom] === undefined) {
      throw new TypeError(`« fraicheur.${nom} » manque au magasin du volume « ${volume} ».`);
    }
  }
  return new GardeDeFraicheur({ volume, scellement, source: fraicheur });
}
