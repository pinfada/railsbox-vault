// RELECTURE de la génération en cours : l'index des secteurs déposés, et leur ouverture (#16,
// ADR 0014 ; #18, ADR 0016 ; #19, ADR 0019).
//
// Un guest écrit un secteur puis le relit avant sa barrière, et il doit retrouver ce qu'il vient
// d'écrire — aucun système de fichiers ne survit au contraire. Or les octets déposés vivent dans le
// JOURNAL, chiffrés, et pas encore dans le volume. Ce module tient la table qui relie un secteur
// logique à l'enregistrement qui le porte, et sait rendre son clair.
//
// Il vit à côté de `generation-store.mjs` plutôt qu'en lui parce que ce sont deux questions
// distinctes : le magasin décide de l'ÉTAT d'une génération — déposée, validée, rangée —, la
// relecture répond à « que voit l'écrivain de cette session ? ». Les tenir séparés rend aussi
// visible ce que la seconde coûte : une ouverture par enregistrement, amortie par un mémo d'un seul
// enregistrement — parce qu'une étiquette couvre l'enregistrement ENTIER et qu'il n'existe aucun
// moyen d'en ouvrir un seul secteur.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import {
  ENTETE_OCTETS,
  GENERATION_FORMATS_LUS,
  SCEAU_ENREGISTREMENT_OCTETS,
  SURCOUT_ENREGISTREMENT,
  enregistrementsSousIdentiteDeBloc,
} from "./generation-format.mjs";
import { decoderSceau } from "./volume-chiffre-format.mjs";

function alignerBas(valeur) {
  return valeur - (valeur % SECTOR_SIZE);
}

function alignerHaut(valeur) {
  return alignerBas(valeur + SECTOR_SIZE - 1);
}

export class RelectureDeCharge {
  #journal;
  #scellement;
  #lireVolume;
  /** Secteur logique → l'enregistrement du journal qui le remplace, et son décalage dedans. */
  #index = new Map();
  /**
   * CLAIR du dernier enregistrement ouvert, et sa position. Un seul, et c'est délibéré.
   *
   * Sans mémo, une relecture séquentielle de dix secteurs d'un même enregistrement l'ouvrirait dix
   * fois. Il est vidé dès que la charge bouge : un enregistrement réécrit au même endroit n'est
   * plus le même.
   */
  #dernierOuvert = null;
  /**
   * PLANCHER de génération présenté à chaque ouverture (#19).
   *
   * Le journal est VIDÉ à la fin de toute récupération : tout enregistrement qu'il porte ensuite a
   * été déposé par cette session, donc sous une génération strictement supérieure à celle de la
   * reprise. Le plancher n'est pas décoratif — il refuse la réintroduction d'un enregistrement
   * authentique d'une session antérieure, dont l'identité serait par ailleurs parfaitement
   * plausible.
   */
  #generationPlancher = 1;

  /**
   * ÉTIQUETTE DE DOMAINE des enregistrements que cet index recouvre (#143).
   *
   * Elle ne varie pas : cet index ne porte QUE des enregistrements déposés par la session en cours,
   * puisque le journal est vidé à la fin de toute récupération. Le FORMAT est donc reçu une fois du
   * magasin, qui seul sait lequel il écrit — le déduire ici aurait été une seconde source de vérité
   * pour une question qui n'en admet qu'une.
   */
  #identiteHeritee;

  /**
   * @param {{ journal: import("./generation-journal.mjs").JournalDeGeneration,
   *           scellement: import("./scellement.mjs").Scellement,
   *           lireVolume: (offset: number, longueur: number) => Promise<Uint8Array>,
   *           formatJournal: number }} options
   */
  constructor({ journal, scellement, lireVolume, formatJournal }) {
    this.#journal = journal;
    this.#scellement = scellement;
    this.#lireVolume = lireVolume;
    if (!GENERATION_FORMATS_LUS.includes(formatJournal)) {
      throw new TypeError(
        `La relecture d'une charge exige le FORMAT du journal que la session écrit, parmi ${GENERATION_FORMATS_LUS.join(", ")} : c'est lui qui dit sous quelle étiquette de domaine ses enregistrements sont scellés. Reçu ${formatJournal}.`,
      );
    }
    this.#identiteHeritee = enregistrementsSousIdentiteDeBloc(formatJournal);
  }

  /** Nombre de secteurs que la charge en cours recouvre. Zéro veut dire « le volume suffit ». */
  get secteursCouverts() {
    return this.#index.size;
  }

  /** Pose le plancher de génération. Le magasin le relève au vidage, jamais à la validation. */
  poserPlancher(generation) {
    this.#generationPlancher = generation;
  }

  /** Inscrit ce qu'un dépôt vient de poser sur le support, et mémorise son clair. */
  inscrire(position, { debut, fin, charge, generation, rang }) {
    this.#dernierOuvert = { position, clair: charge };
    for (let secteur = debut; secteur < fin; secteur += SECTOR_SIZE) {
      this.#index.set(secteur, {
        position,
        decalage: secteur - debut,
        rang,
        adresse: debut,
        longueur: charge.byteLength,
        generation,
      });
    }
  }

  /** La charge a disparu du journal : plus rien ne recouvre le volume. */
  vider() {
    this.#index.clear();
    this.#dernierOuvert = null;
  }

  /**
   * Relit `longueur` octets tels que l'écrivain de cette session les voit : le journal d'abord, le
   * volume pour tout ce que le journal ne couvre pas.
   */
  async lire(offset, longueur) {
    const debut = alignerBas(offset);
    const fin = alignerHaut(offset + longueur);
    const tampon = await this.#lireVolume(debut, fin - debut);
    for (let secteur = debut; secteur < fin; secteur += SECTOR_SIZE) {
      const entree = this.#index.get(secteur);
      if (entree === undefined) continue;
      const clair = await this.#ouvrir(entree);
      tampon.set(clair.subarray(entree.decalage, entree.decalage + SECTOR_SIZE), secteur - debut);
    }
    return tampon.subarray(offset - debut, offset - debut + longueur);
  }

  /**
   * SUPERPOSE la génération en cours à un tampon déjà relu du volume, en place.
   *
   * Le backend garde ainsi son chemin de lecture — bornes, faute programmée, contrôle de géométrie,
   * traduction des échecs du support — et n'y ajoute qu'un recouvrement.
   *
   * @param {number} offset offset logique du premier octet de `tampon`
   * @param {Uint8Array} tampon modifié en place, puis rendu
   */
  async superposer(offset, tampon) {
    if (this.#index.size === 0) return tampon;
    const fin = offset + tampon.byteLength;
    for (let secteur = alignerBas(offset); secteur < fin; secteur += SECTOR_SIZE) {
      const entree = this.#index.get(secteur);
      if (entree === undefined) continue;
      const clair = await this.#ouvrir(entree);
      const depuis = Math.max(offset, secteur);
      const jusque = Math.min(fin, secteur + SECTOR_SIZE);
      const dans = entree.decalage + (depuis - secteur);
      tampon.set(clair.subarray(dans, dans + (jusque - depuis)), depuis - offset);
    }
    return tampon;
  }

  /** Rend le CLAIR de l'enregistrement `entree`, en ouvrant le moins souvent possible. */
  async #ouvrir(entree) {
    if (this.#dernierOuvert?.position === entree.position) return this.#dernierOuvert.clair;
    const chiffre = this.#journal.lire(entree.position + SURCOUT_ENREGISTREMENT, entree.longueur);
    const sceau = decoderSceau(
      this.#journal.lire(entree.position + ENTETE_OCTETS, SCEAU_ENREGISTREMENT_OCTETS),
    );
    const identite = {
      generation: entree.generation,
      rang: entree.rang,
      adresse: entree.adresse,
      longueur: entree.longueur,
    };
    const scelle = { nonce: sceau.nonce, etiquette: sceau.etiquette, chiffre };
    const attentes = { generationMinimale: this.#generationPlancher };
    // Même choix qu'au parcours d'une charge, et pour la même raison : dans un journal d'avant le
    // format 4, un enregistrement porte l'identité d'un BLOC du volume (#143).
    const clair = this.#identiteHeritee
      ? await this.#scellement.ouvrirBloc(identite, scelle, attentes)
      : await this.#scellement.ouvrirEnregistrement(identite, scelle, attentes);
    this.#dernierOuvert = { position: entree.position, clair };
    return clair;
  }
}
