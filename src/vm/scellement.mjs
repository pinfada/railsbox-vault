// Le SCELLEMENT du produit : le modèle de référence, tenu par une clé et un compteur (#18, ADR 0016).
//
// Ce module ne réimplémente RIEN. Il appelle `src/vm/format-chiffre/modele-reference.mjs`, qui est la
// spécification exécutable de l'ADR 0015, et il n'ajoute que les trois choses qu'un module pur ne
// pouvait pas porter :
//
//  1. **la clé de volume et l'identité du volume**, tenues une fois pour que chaque appelant n'ait
//     pas à les répéter — et donc pas à se tromper en les répétant ;
//  2. **le compteur de scellements**, qui vit dans la racine et traverse les sessions. Le § 8.3 de
//     NIST SP 800-38D compte « all instances of the authenticated encryption function » : blocs,
//     enregistrements, secteurs rescellés ET racines. `verifierBudgetDeCle` du modèle refuse à 2^31 ;
//  3. **la traduction des refus** `VAULT_CRYPTO_*` en `VAULT_STORAGE_*`, parce qu'un appelant du
//     stockage n'a pas à connaître deux familles d'erreurs. La cause d'origine est CONSERVÉE dans le
//     contexte : un refus de sécurité qui perdrait sa cause en changeant de couche ne serait plus
//     qu'une panne.
//
// **La source de nonces est injectable, et c'est le seul point de cette tranche qui le soit.** Elle
// existe pour une raison écrite par l'ADR 0015 : « permettre à une implémentation (#18) de REPRODUIRE
// ces vecteurs ». Aucun chemin du produit ne la fournit — le défaut est `tirerNonce`, c'est-à-dire
// douze octets de `crypto.getRandomValues` à chaque scellement, et
// `tests/unit/vm-volume-chiffre.test.mjs` est le seul appelant qui la remplace.

import { CRYPTO_ERROR_CODES, isCryptoError } from "./format-chiffre/crypto-errors.mjs";
import { tirerNonce } from "./format-chiffre/identite-logique.mjs";
import {
  RANG_SECTEUR_DE_VOLUME,
  importerCleDeVolume,
  ouvrirBloc,
  ouvrirRacine,
  rescellerEnSecteurs,
  scellerBlocSousNonce,
  scellerRacineSousNonce,
} from "./format-chiffre/modele-reference.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

export { RANG_SECTEUR_DE_VOLUME };

/**
 * Traduction des refus du modèle vers la famille du stockage.
 *
 * Rejeu, troncature et mélange retombent tous sur `GENERATION_CORRUPT` : ce sont trois façons pour
 * une génération VALIDÉE de ne plus concorder, et l'ADR 0014 leur donne déjà un remède unique —
 * restaurer une sauvegarde, jamais deviner. Les distinguer dans le CODE n'apprendrait rien à
 * l'exploitant ; les distinguer dans le CONTEXTE, si, et c'est ce que `cause` fait.
 */
const TRADUCTION = Object.freeze({
  [CRYPTO_ERROR_CODES.sealRejected]: STORAGE_ERROR_CODES.sceauRefuse,
  [CRYPTO_ERROR_CODES.identityMismatch]: STORAGE_ERROR_CODES.identiteVolume,
  [CRYPTO_ERROR_CODES.replay]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.truncation]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.mixing]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.orderInvalid]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.keyBudget]: STORAGE_ERROR_CODES.budgetDeCle,
});

/**
 * Traduit un refus du format chiffré, ou laisse passer ce qui n'en est pas un.
 *
 * `VAULT_CRYPTO_MALFORME` et `VAULT_CRYPTO_ALGORITHME_INCONNU` ne sont PAS traduits : ils répondent
 * d'une violation de contrat par l'appelant — une largeur, un type, un nom d'algorithme —, c'est-à-dire
 * d'une faute de programmation en amont de toute menace. Les habiller en erreur de stockage ferait
 * croire à un support abîmé là où c'est un bogue.
 */
export function traduireRefus(cause, contexte = {}) {
  if (!isCryptoError(cause)) return cause;
  const code = TRADUCTION[cause.code];
  if (code === undefined) return cause;
  return new StorageError(code, cause.message, {
    ...contexte,
    cause: cause.code,
    menaces: cause.menaces,
    ...cause.context,
  });
}

async function traduisant(contexte, geste) {
  try {
    return await geste();
  } catch (cause) {
    throw traduireRefus(cause, contexte);
  }
}

/**
 * Le scellement d'UN volume : sa clé, son identité, son compteur.
 *
 * Une instance est partagée par le magasin de générations et par la couche chiffrée du volume, pour
 * que le compteur de scellements soit UN. Deux compteurs se seraient contredits, et c'est le budget
 * de la clé qui aurait été faux.
 */
export class Scellement {
  #volume;
  #formatVersion;
  #cle;
  #tirerNonce;
  #scellementsCumules;

  /** Utiliser `Scellement.ouvrir` : l'importation de la clé est asynchrone. */
  constructor({ volume, formatVersion, cle, scellementsCumules, tirerNonce: nonces }) {
    this.#volume = volume;
    this.#formatVersion = formatVersion;
    this.#cle = cle;
    this.#scellementsCumules = scellementsCumules;
    this.#tirerNonce = nonces;
  }

  /**
   * Importe la clé — NON EXTRACTIBLE — et rend un scellement prêt.
   *
   * @param {{ volume: string, cleOctets: Uint8Array, formatVersion?: number,
   *           scellementsCumules?: number, tirerNonce?: () => Uint8Array }} options
   *   `volume` est l'identifiant TEXTUEL du volume (trente-deux hexadécimaux), tel qu'il entre dans
   *   les données associées. La conversion depuis les seize octets du disque est fixée par
   *   l'ADR 0015 et faite par l'ouvreur, pas ici.
   */
  static async ouvrir({
    volume,
    cleOctets,
    formatVersion,
    scellementsCumules = 0,
    tirerNonce: nonces = tirerNonce,
  }) {
    return new Scellement({
      volume,
      formatVersion,
      cle: await importerCleDeVolume(cleOctets),
      scellementsCumules,
      tirerNonce: nonces,
    });
  }

  /** Identifiant TEXTUEL du volume, tel qu'il entre dans les données associées. */
  get volume() {
    return this.#volume;
  }

  get formatVersion() {
    return this.#formatVersion;
  }

  /** Scellements consommés sous cette clé. Authentifié dans la racine, donc durable. */
  get scellementsCumules() {
    return this.#scellementsCumules;
  }

  /**
   * REPREND le compteur depuis une racine authentifiée. C'est le seul moyen admis de le reculer, et
   * il n'est pas un remède : l'écart entre ce compteur et le nombre réel d'invocations sous la clé
   * est la question n° 4 de l'ADR 0015, nommée là-bas et non résolue ici.
   */
  reprendreDepuis(scellementsCumules) {
    this.#scellementsCumules = scellementsCumules;
  }

  #identite({ generation, rang, adresse, longueur }) {
    return {
      volume: this.#volume,
      formatVersion: this.#formatVersion,
      generation,
      rang,
      adresse,
      longueur,
    };
  }

  /** Scelle un bloc — un enregistrement de journal ou un secteur — et consomme un scellement. */
  async scellerBloc(identite, contenu) {
    const scelle = await traduisant({ volume: this.#volume, adresse: identite.adresse }, () =>
      scellerBlocSousNonce({
        cle: this.#cle,
        identite: this.#identite(identite),
        contenu,
        nonce: this.#tirerNonce(),
        attentes: { scellementsCumules: this.#scellementsCumules },
      }),
    );
    this.#scellementsCumules += 1;
    return scelle;
  }

  /**
   * Ouvre un bloc sous l'identité présentée. Un écart quelconque est un REFUS : aucun clair partiel,
   * aucun zéro, aucun diagnostic inventé sur la cause.
   */
  async ouvrirBloc(identite, scelle, { generationMinimale = null } = {}) {
    return traduisant({ volume: this.#volume, adresse: identite.adresse }, () =>
      ouvrirBloc({
        cle: this.#cle,
        identite: this.#identite(identite),
        scelle,
        attentes: { generationMinimale },
      }),
    );
  }

  /**
   * RESCELLE un contenu en secteurs du volume, sous un nonce neuf par secteur — le geste du POINT DE
   * CONTRÔLE. Le modèle épingle le rang à zéro et refuse un contenu non aligné ; l'appelant a déjà
   * fait la lecture-modification-réécriture, comme `deposer` le fait côté journal.
   */
  async rescellerEnSecteurs({ adresse, contenu, generation }) {
    const rescelle = await traduisant({ volume: this.#volume, adresse }, () =>
      rescellerEnSecteurs({
        cle: this.#cle,
        adresse,
        contenu,
        identite: { volume: this.#volume, formatVersion: this.#formatVersion, generation },
        attentes: { scellementsCumules: this.#scellementsCumules },
        nonces: this.#tirerNonce,
      }),
    );
    this.#scellementsCumules = rescelle.scellementsCumules;
    return rescelle;
  }

  /**
   * Scelle la racine d'une génération. Le compte des entrées et la longueur de charge sont DÉRIVÉS
   * par le modèle, jamais reçus d'ici : une racine qui annoncerait autre chose que ce qu'elle scelle
   * serait une troncature signée par son propre producteur.
   */
  async scellerRacine({ sequence, generation, tailleVolume }, entrees, { sequencePrecedente }) {
    const scelle = await traduisant({ volume: this.#volume, sequence, generation }, () =>
      scellerRacineSousNonce({
        cle: this.#cle,
        racine: {
          volume: this.#volume,
          formatVersion: this.#formatVersion,
          sequence,
          generation,
          tailleVolume,
          scellementsCumules: this.#scellementsCumules,
        },
        entrees,
        nonce: this.#tirerNonce(),
        attentes: { sequencePrecedente },
      }),
    );
    this.#scellementsCumules += 1;
    return scelle;
  }

  /**
   * Ouvre une racine et confronte la génération trouvée à ce qu'elle authentifie. Les trois
   * classements — rejeu, troncature, mélange — sont posés APRÈS la vérification de l'étiquette, donc
   * sur un en-tête authentique. C'est l'ordre de l'ADR 0015, et il n'est pas négociable.
   */
  async ouvrirRacine(entete, scelle, entrees, attentes) {
    return traduisant({ volume: this.#volume, sequence: entete.sequence }, () =>
      ouvrirRacine({ cle: this.#cle, entete, scelle, entrees, attentes }),
    );
  }
}
