// Machine d'état d'une génération transactionnelle (#16, ADR 0014).
//
// Le magasin ne connaît ni OPFS, ni v86, ni le backend de blocs. Il reçoit le handle du journal
// voisin `<volume>.gen`, la taille logique du volume, et deux fonctions pour lire et écrire le
// VOLUME lui-même. C'est ce qui permet d'éprouver sous Node exactement le code que le Worker exécute
// sur le vrai support.
//
// Le protocole tient en quatre gestes, et leur ORDRE est le contrat :
//
//  1. DÉPOSER — les octets d'une écriture vont dans le journal, jamais dans le volume. Un lecteur qui
//     rouvrirait le volume ici n'en verrait rien ; l'écrivain, lui, se relit (v86 exige cette
//     cohérence de session, cf. `docs/architecture.md` § contrat de tampon).
//  2. VALIDER — la charge est franchie par une barrière, PUIS la racine est écrite, PUIS une seconde
//     barrière. L'ordre est ce qui distingue « validé » de « probablement écrit » : sans la première
//     barrière, un support pourrait rendre la racine durable avant sa charge, et la relecture
//     trouverait une génération validée dont les octets manquent — un REFUS là où une simple mise au
//     rebut aurait suffi.
//  3. POINT DE CONTRÔLE — la charge validée est recopiée dans le volume, franchie par une barrière,
//     puis le journal est vidé. C'est le seul geste qui touche le volume.
//  4. RÉCUPÉRER — à l'ouverture. La dernière racine valide fait autorité ; ce qui la dépasse est
//     ÉCARTÉ avec un diagnostic ; une charge validée mais incohérente est REFUSÉE, jamais devinée.
//
// Le point de validation est le geste 2 : c'est là que la barrière du guest peut être acquittée sans
// mentir. Le geste 3 ne déplace aucune promesse — il ne fait que ranger.
//
// Trois voisins portent ce que le magasin n'a pas à savoir, et sont réexportés ici pour que les
// appelants n'aient rien à changer : `generation-plafonds.mjs` les seuils calibrés,
// `generation-journal.mjs` l'accès au fichier, `generation-charge.mjs` le parcours en flux d'une
// charge, `generation-recuperation.mjs` le constat d'ouverture et son compte rendu.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { parcourirCharge } from "./generation-charge.mjs";
import {
  ENTETE_OCTETS,
  ZONE_ENREGISTREMENTS,
  crc32,
  encoderEnteteEnregistrement,
  encoderRacine,
  offsetDeRacine,
  racineDeSequence,
} from "./generation-format.mjs";
import { JournalDeGeneration } from "./generation-journal.mjs";
import { PLAFOND_CHARGE_OCTETS, POINT_DE_CONTROLE_OCTETS } from "./generation-plafonds.mjs";
import {
  GENERATION_ETATS,
  constaterOuverture,
  poserRapport,
  remedeSansRacine,
} from "./generation-recuperation.mjs";
import { STORAGE_ERROR_CODES, StorageError, generationOverflow } from "./storage-errors.mjs";

export { GENERATION_ETATS };
export {
  PLAFOND_CHARGE_OCTETS,
  POINT_DE_CONTROLE_OCTETS,
  TAMPON_RELECTURE_OCTETS,
} from "./generation-plafonds.mjs";

function alignerBas(valeur) {
  return valeur - (valeur % SECTOR_SIZE);
}

function alignerHaut(valeur) {
  return alignerBas(valeur + SECTOR_SIZE - 1);
}

export class GenerationStore {
  #volume;
  #journal;
  #tailleVolume;
  #lireVolume;
  #ecrireVolume;
  #barriereVolume;
  #plafond;
  #seuilPointDeControle;

  /** Secteur logique → position, dans le journal, des octets qui le remplacent. */
  #index = new Map();
  #longueurCharge = 0;
  #enregistrements = 0;
  #sommeCharge = 0;
  /** Charge SCELLÉE par la dernière racine. Ce qui la dépasse n'est pas encore validé. */
  #longueurValidee = 0;
  #enregistrementsValides = 0;
  #sommeValidee = 0;
  #sequence = 0;
  #generation = 0;
  #sequenceValidee = 0;
  #rapport = null;
  /**
   * Plus grande charge que ce magasin ait VALIDÉE, en octets. Haute eau, jamais remise à zéro.
   *
   * C'est la taille de la plus grande GÉNÉRATION — ce qu'un guest fait sceller entre deux barrières.
   * Le point de contrôle remet `#longueurValidee` à zéro à chaque rangement : sans ce compteur, seule
   * la DERNIÈRE génération d'un boot serait lisible, dans le rapport de la prochaine ouverture.
   */
  #chargeMaxValidee = 0;
  /**
   * Plus grande charge DÉPOSÉE, en octets. Haute eau, jamais remise à zéro.
   *
   * **C'est elle, et non la précédente, que `PLAFOND_CHARGE_OCTETS` borne.** `deposer` refuse quand
   * `#longueurCharge` dépasse le plafond, et `#longueurCharge` compte tout ce qui a été déposé depuis
   * le dernier POINT DE CONTRÔLE — y compris les écritures qu'aucune barrière n'a encore validées.
   *
   * La distinction n'est pas théorique : le relevé de bout en bout du 2026-08-27 a mesuré un boot à
   * 68 écritures OPFS pour UNE barrière. La plus grande génération validée y valait 4 112 octets,
   * mais la charge réellement présentée au plafond était près de vingt fois supérieure. Calibrer le
   * plafond sur la seule charge validée le calibrerait sur la mauvaise grandeur (#91).
   */
  #chargeMaxDeposee = 0;

  constructor(options) {
    this.#volume = options.volume;
    this.#journal = new JournalDeGeneration(options.volume, options.handle);
    this.#tailleVolume = options.tailleVolume;
    this.#lireVolume = options.lireVolume;
    this.#ecrireVolume = options.ecrireVolume;
    this.#barriereVolume = options.barriereVolume ?? (async () => {});
    this.#plafond = options.plafondOctets ?? PLAFOND_CHARGE_OCTETS;
    this.#seuilPointDeControle = options.seuilPointDeControle ?? POINT_DE_CONTROLE_OCTETS;
  }

  /**
   * Ouvre le magasin et RÉCUPÈRE : c'est le seul chemin admis.
   *
   * @param {{ volume: string, handle: object, tailleVolume: number,
   *           lireVolume: (offset: number, longueur: number) => Uint8Array,
   *           ecrireVolume: (offset: number, octets: Uint8Array) => unknown,
   *           plafondOctets?: number, seuilPointDeControle?: number }} options
   * @returns {Promise<GenerationStore>}
   */
  static async ouvrir(options) {
    const magasin = new GenerationStore(options);
    await magasin.#recuperer();
    return magasin;
  }

  /** Numéro de la dernière génération VALIDÉE. Zéro tant qu'aucune barrière n'a été acquittée. */
  get generationValidee() {
    return this.#generation;
  }

  /** Ce que l'ouverture a trouvé et fait. Publié, jamais tu : une mise au rebut est une nouvelle. */
  get rapport() {
    return this.#rapport;
  }

  /** Vrai si des octets déposés attendent leur validation. */
  get enAttente() {
    return this.#sequenceValidee < this.#sequence || this.#longueurCharge > 0;
  }

  /** Emplacement de la racine qui fait autorité en ce moment. */
  get racineOffset() {
    return offsetDeRacine(racineDeSequence(this.#sequenceValidee));
  }

  /** Emplacement que la prochaine écriture de racine occupera. L'alternance est observable. */
  get prochaineRacineOffset() {
    return offsetDeRacine(racineDeSequence(this.#sequence + 1));
  }

  /** Octets de charge déposés depuis le dernier point de contrôle. */
  get octetsDeCharge() {
    return this.#longueurCharge;
  }

  /**
   * Plus grande génération que ce magasin ait validée, en octets. Zéro si aucune barrière n'a scellé
   * quoi que ce soit.
   *
   * C'est ce qu'un guest fait sceller entre deux barrières. Elle ne compte que les générations
   * validées par CETTE session ; celle qu'une ouverture rejoue est publiée à part, par
   * `rapport.octetsRejoues`.
   */
  get chargeMaxValideeOctets() {
    return this.#chargeMaxValidee;
  }

  /**
   * Plus grande charge DÉPOSÉE depuis un point de contrôle, en octets. C'est la grandeur que
   * `PLAFOND_CHARGE_OCTETS` borne, et donc celle qui le calibre : un guest qui écrit sans franchir de
   * barrière la fait croître sans rien valider, et c'est elle qui bute la première.
   */
  get chargeMaxDeposeeOctets() {
    return this.#chargeMaxDeposee;
  }

  // ------------------------------------------------------------ récupération

  async #recuperer() {
    this.#journal.reinitialiserSurmemoire();
    const constat = constaterOuverture({
      journal: this.#journal,
      tailleVolume: this.#tailleVolume,
    });

    if (constat.racine === null) {
      this.#rapport = await this.#recupererSansRacine(constat);
      return;
    }
    this.#rapport = await this.#recupererDepuisRacine(constat);
  }

  /** AUCUNE racine ne fait autorité : le remède est décidé avant d'écrire quoi que ce soit. */
  async #recupererSansRacine({ abimees, chargePresente }) {
    const remede = remedeSansRacine({ volume: this.#volume, abimees, chargePresente });
    if (remede === "aucune") return this.#rapportDe(GENERATION_ETATS.aucune, {});
    await this.#vider({ sequence: 0, generation: 0 });
    return this.#rapportDe(GENERATION_ETATS.ecartee, { octetsEcartes: chargePresente });
  }

  /** Une racine fait autorité : elle fixe la génération, et ce qui la dépasse est écarté. */
  async #recupererDepuisRacine({ racine, chargePresente }) {
    this.#sequence = racine.sequence;
    this.#sequenceValidee = racine.sequence;
    this.#generation = racine.generation;

    if (racine.longueurCharge === 0) {
      await this.#vider({ sequence: racine.sequence, generation: racine.generation });
      return this.#rapportDe(
        chargePresente > 0 ? GENERATION_ETATS.ecartee : GENERATION_ETATS.aucune,
        { octetsEcartes: chargePresente },
      );
    }

    const enregistrements = this.#rejouerCharge(racine);
    await this.#barriereVolume();
    await this.#vider({ sequence: racine.sequence, generation: racine.generation });
    return this.#rapportDe(GENERATION_ETATS.rejouee, {
      octetsEcartes: Math.max(0, chargePresente - racine.longueurCharge),
      enregistrementsRejoues: enregistrements,
      octetsRejoues: racine.longueurCharge,
    });
  }

  #rapportDe(etat, details) {
    return poserRapport({
      volume: this.#volume,
      etat,
      generation: this.#generation,
      sequence: this.#sequence,
      surmemoireMax: this.#journal.surmemoireMax,
      details,
    });
  }

  #parcourirCharge(racine, emettre = null) {
    return parcourirCharge({
      journal: this.#journal,
      volume: this.#volume,
      tailleVolume: this.#tailleVolume,
      racine,
      emettre,
    });
  }

  /**
   * Recopie la charge d'une racine dans le volume, en flux. DEUX passes, et l'ordre est le contrat.
   *
   * La première vérifie la charge entière — structure, compte, somme de contrôle — sans rien écrire ;
   * la seconde seulement recopie. Les fusionner ferait payer au volume le prix d'une charge abîmée :
   * les premiers enregistrements y seraient déjà quand la somme de contrôle refuserait le dernier,
   * c'est-à-dire exactement le rejeu à moitié que ce magasin interdit. Le prix de la sûreté est une
   * seconde lecture du journal ; `tests/vm/recuperation-generation.spec.mjs` la mesure.
   *
   * @returns {number} le nombre d'enregistrements recopiés
   */
  #rejouerCharge(racine) {
    const enregistrements = this.#parcourirCharge(racine);
    this.#parcourirCharge(racine, (offset, octets) => this.#ecrireVolume(offset, octets));
    return enregistrements;
  }

  // ----------------------------------------------------------------- gestes

  /**
   * Dépose une écriture dans le journal. Le volume n'est pas touché.
   *
   * Une écriture qui ne couvre pas des secteurs entiers est COMPLÉTÉE par relecture plutôt que
   * refusée : le journal est indexé au secteur, et un demi-secteur déposé rendrait la relecture de
   * l'autre moitié ambiguë. Le surcoût est une lecture, et il n'existe que pour un accès dont le
   * spike #4 a mesuré que le guest ne l'émet pas.
   */
  async deposer(offset, octets) {
    const debut = alignerBas(offset);
    const fin = alignerHaut(offset + octets.byteLength);
    let charge;
    if (debut === offset && fin === offset + octets.byteLength) {
      charge = octets;
    } else {
      charge = this.lire(debut, fin - debut);
      charge.set(octets, offset - debut);
    }

    const ajout = ENTETE_OCTETS + charge.byteLength;
    if (this.#longueurCharge + ajout > this.#plafond) {
      throw generationOverflow(this.#volume, {
        pending: this.#longueurCharge,
        requested: ajout,
        limit: this.#plafond,
      });
    }

    const entete = encoderEnteteEnregistrement({ offset: debut, longueur: charge.byteLength });
    const position = ZONE_ENREGISTREMENTS + this.#longueurCharge;
    this.#journal.ecrire(position, entete);
    this.#journal.ecrire(position + ENTETE_OCTETS, charge);
    this.#sommeCharge = crc32(charge, crc32(entete, this.#sommeCharge));
    this.#longueurCharge += ajout;
    this.#enregistrements += 1;
    // HAUTE EAU de ce que le PLAFOND borne. Posée après l'écriture réussie : une écriture refusée
    // par le support n'a pas occupé le journal, et la compter gonflerait la mesure qui calibre.
    if (this.#longueurCharge > this.#chargeMaxDeposee) {
      this.#chargeMaxDeposee = this.#longueurCharge;
    }

    const positionCharge = position + ENTETE_OCTETS;
    for (let secteur = debut; secteur < fin; secteur += SECTOR_SIZE) {
      this.#index.set(secteur, positionCharge + (secteur - debut));
    }
  }

  /**
   * Relit `longueur` octets tels que l'écrivain de cette session les voit : le journal d'abord, le
   * volume pour tout ce que le journal ne couvre pas.
   */
  lire(offset, longueur) {
    const debut = alignerBas(offset);
    const fin = alignerHaut(offset + longueur);
    const tampon = this.#lireVolume(debut, fin - debut);
    for (let secteur = debut; secteur < fin; secteur += SECTOR_SIZE) {
      const position = this.#index.get(secteur);
      if (position === undefined) continue;
      tampon.set(this.#journal.lire(position, SECTOR_SIZE), secteur - debut);
    }
    return tampon.subarray(offset - debut, offset - debut + longueur);
  }

  /**
   * SUPERPOSE la génération en cours à un tampon déjà relu du volume, en place.
   *
   * Le backend garde ainsi son chemin de lecture — bornes, faute programmée, contrôle de géométrie,
   * traduction des échecs du support — et n'y ajoute qu'un recouvrement. Sans lui, un guest ne se
   * relirait pas : il écrirait un secteur, le relirait avant la barrière, et retrouverait l'état
   * d'avant. Aucun système de fichiers ne survit à cela.
   *
   * @param {number} offset offset logique du premier octet de `tampon`
   * @param {Uint8Array} tampon modifié en place, puis rendu
   */
  superposer(offset, tampon) {
    if (this.#index.size === 0) return tampon;
    const fin = offset + tampon.byteLength;
    for (let secteur = alignerBas(offset); secteur < fin; secteur += SECTOR_SIZE) {
      const position = this.#index.get(secteur);
      if (position === undefined) continue;
      const depuis = Math.max(offset, secteur);
      const jusque = Math.min(fin, secteur + SECTOR_SIZE);
      const octets = this.#journal.lire(position + (depuis - secteur), jusque - depuis);
      tampon.set(octets, depuis - offset);
    }
    return tampon;
  }

  /**
   * VALIDE la génération en cours. Au retour, elle est durable : c'est le point où la barrière du
   * guest peut être acquittée sans mentir.
   *
   * @returns {Promise<number>} le numéro de la génération validée
   */
  async valider() {
    if (this.#longueurCharge === this.#longueurValidee) {
      // Barrière À VIDE : rien n'a été déposé depuis la dernière validation, et écrire une racine
      // identique ne rendrait rien plus durable. Le support est TOUT DE MÊME sollicité : le guest a
      // demandé une durabilité, et lui répondre « oui » sans rien demander au support serait
      // exactement l'acquittement anticipé que `SEC-DURABLE-001` refuse — un support qui ne peut plus
      // écrire resterait alors invisible jusqu'à la prochaine écriture.
      await this.#journal.barriere();
      return this.#generation;
    }
    // La charge AVANT la racine : sans cette barrière, un support pourrait rendre la racine durable
    // avant les octets qu'elle scelle, et la relecture refuserait une génération que rien n'obligeait
    // à perdre.
    await this.#journal.barriere();

    // La racine est écrite AVANT que la mémoire n'enregistre quoi que ce soit. L'ordre décide d'un
    // cas réel : si le support refuse la racine — quota, handle perdu —, la barrière du guest échoue
    // et la génération n'est PAS validée. Poser les compteurs d'abord ferait croire au magasin qu'une
    // génération scellée l'attend, et la fermeture propre la rangerait dans le volume : elle
    // publierait un état que personne n'a acquitté. La racine partiellement écrite, elle, occupe
    // l'emplacement ALTERNÉ : celle qui fait autorité est intacte.
    const sequence = this.#sequence + 1;
    const generation = this.#generation + 1;
    await this.#ecrireRacine({
      sequence,
      generation,
      enregistrements: this.#enregistrements,
      longueurCharge: this.#longueurCharge,
      sommeCharge: this.#sommeCharge,
    });

    this.#sequence = sequence;
    this.#generation = generation;
    this.#sequenceValidee = sequence;
    this.#longueurValidee = this.#longueurCharge;
    this.#enregistrementsValides = this.#enregistrements;
    this.#sommeValidee = this.#sommeCharge;
    // HAUTE EAU, posée APRÈS le succès de la racine : seule une génération réellement scellée
    // compte. La poser avant ferait entrer dans la statistique une charge que le support a refusée.
    if (this.#longueurValidee > this.#chargeMaxValidee) {
      this.#chargeMaxValidee = this.#longueurValidee;
    }
    return this.#generation;
  }

  async #ecrireRacine(descripteur) {
    const racine = encoderRacine({ ...descripteur, tailleVolume: this.#tailleVolume });
    this.#journal.ecrire(offsetDeRacine(racineDeSequence(descripteur.sequence)), racine);
    await this.#journal.barriere();
  }

  /** Vrai si la charge validée mérite d'être rangée dans le volume dès maintenant. */
  get pointDeControleDu() {
    return this.#longueurValidee >= this.#seuilPointDeControle;
  }

  /**
   * Vrai si tout ce qui est déposé est validé. Une charge non validée n'est JAMAIS rangée dans le
   * volume : elle n'a été acquittée à personne, et la prochaine ouverture l'écartera.
   */
  get rangeable() {
    return this.#longueurValidee > 0 && this.#longueurValidee === this.#longueurCharge;
  }

  /**
   * Range la charge VALIDÉE dans le volume, puis vide le journal.
   *
   * Ce geste ne valide rien et ne promet rien de neuf : les octets étaient déjà durables. Il n'est
   * donc jamais sur le chemin d'un acquittement, et son échec n'invalide pas la génération — elle
   * reste dans le journal, et la prochaine ouverture la rejouera.
   */
  async pointDeControle() {
    if (this.#longueurValidee === 0) return;
    if (!this.rangeable) {
      throw new StorageError(
        STORAGE_ERROR_CODES.generationPending,
        `Point de contrôle refusé sur le volume « ${this.#volume} » : ${this.#longueurCharge - this.#longueurValidee} octet(s) déposés ne sont validés par aucune barrière, et les recopier publierait un état que personne n'a acquitté.`,
        { volume: this.#volume, generation: this.#generation },
      );
    }
    this.#rejouerCharge({
      generation: this.#generation,
      enregistrements: this.#enregistrementsValides,
      longueurCharge: this.#longueurValidee,
      sommeCharge: this.#sommeValidee,
    });
    await this.#barriereVolume();
    await this.#vider({ sequence: this.#sequence, generation: this.#generation });
  }

  /**
   * Remet le journal à l'état « rien en attente », en conservant la génération constatée.
   *
   * **La racine vide est rendue DURABLE avant la troncature, et l'ordre inverse serait une perte.**
   * Tronquer d'abord retirerait du fichier les octets qu'une racine encore autoritaire déclare
   * toujours : un arrêt — ou une simple exception, quota ou handle perdu — entre les deux gestes
   * laisserait une racine annonçant `L` octets au-dessus d'un fichier qui n'en porte plus aucun, et
   * la prochaine ouverture REFUSERAIT le volume par `VAULT_STORAGE_GENERATION_CORRUPT` alors que ses
   * octets sont intacts. Dans l'ordre retenu, les deux interruptions possibles sont sûres :
   *
   *  - avant que la racine vide ne soit durable, l'ancienne racine fait toujours autorité et sa
   *    charge est encore là — la génération est rejouée une seconde fois, ce qui est idempotent ;
   *  - après, la racine vide fait autorité et les octets qui traînent au-delà ne sont pas lus : une
   *    charge est bornée par la longueur que sa racine déclare, pas par la taille du fichier.
   */
  async #vider({ sequence, generation }) {
    this.#index.clear();
    this.#longueurCharge = 0;
    this.#enregistrements = 0;
    this.#sommeCharge = 0;
    this.#longueurValidee = 0;
    this.#enregistrementsValides = 0;
    this.#sommeValidee = 0;
    const suivante = sequence + 1;
    await this.#ecrireRacine({
      sequence: suivante,
      generation,
      enregistrements: 0,
      longueurCharge: 0,
      sommeCharge: 0,
    });
    this.#journal.tronquer(ZONE_ENREGISTREMENTS);
    this.#sequence = suivante;
    this.#generation = generation;
    this.#sequenceValidee = suivante;
  }

  /** Ferme le journal. La charge validée non rangée reste dans le fichier : elle est durable. */
  close() {
    this.#journal.close();
  }
}
