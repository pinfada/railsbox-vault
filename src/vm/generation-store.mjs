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

import { SECTOR_SIZE } from "./block-geometry.mjs";
import {
  ENTETE_OCTETS,
  ZONE_ENREGISTREMENTS,
  crc32,
  decoderEnteteEnregistrement,
  decoderRacine,
  encoderEnteteEnregistrement,
  encoderRacine,
  offsetDeRacine,
  RACINES,
  RACINE_OCTETS,
  racineDeSequence,
} from "./generation-format.mjs";
import { decodeSupportCount, readCountFailure, writeCountFailure } from "./opfs-error-mapping.mjs";
import {
  STORAGE_ERROR_CODES,
  StorageError,
  generationCorrupt,
  generationOverflow,
  generationRootCorrupt,
} from "./storage-errors.mjs";

/** États dans lesquels une ouverture peut trouver le journal. */
export const GENERATION_ETATS = Object.freeze({
  /** Aucune génération en attente : le volume EST la dernière génération validée. */
  aucune: "aucune",
  /** Une génération déposée sans validation a été écartée. Le volume n'a pas bougé. */
  ecartee: "ecartee",
  /** Une génération validée manquait au volume : elle a été rejouée. */
  rejouee: "rejouee",
});

/**
 * Plafond par défaut de la charge d'un journal, en octets.
 *
 * Il existe parce qu'une génération est bornée par la barrière du GUEST, et que rien n'oblige un
 * guest à en émettre. Sans plafond, un invité qui n'appelle jamais `fsync` ferait grossir le journal
 * jusqu'au quota, et l'échec surviendrait au pire endroit — au milieu d'une validation. Le plafond
 * refuse TÔT, avec un code à lui, plutôt que de publier une génération à moitié.
 *
 * 64 Mio : le même ordre de grandeur que la surmémoire de streaming de `docs/quality-attributes.md`.
 * Le seul relevé existant — 90 304 octets déposés par Rails entre une barrière acquittée et une
 * coupure, scénario Bout en bout de #16 — est trois ordres de grandeur en dessous, mais ce n'est PAS
 * une mesure de la plus grande génération possible. Le chiffre reste un garde-fou, pas un seuil
 * calibré, et l'ADR 0014 l'inscrit comme travail découvert.
 */
export const PLAFOND_CHARGE_OCTETS = 64 * 1024 * 1024;

/** Au-delà de ce volume de charge, le point de contrôle est déclenché de lui-même. */
export const POINT_DE_CONTROLE_OCTETS = 8 * 1024 * 1024;

/**
 * Tampon avec lequel une charge est relue, en octets. C'est la SURMÉMOIRE de la récupération.
 *
 * Il est une CONSTANTE, et c'est tout l'intérêt : la plus grande allocation d'une récupération ne
 * suit pas la taille de la charge, donc pas le plafond. Relever `PLAFOND_CHARGE_OCTETS` ne relève
 * pas la surmémoire ; `docs/quality-attributes.md` la borne à 64 Mio pour l'export et la
 * restauration, et la récupération tient désormais le même régime avec deux ordres de grandeur de
 * marge.
 *
 * 1 Mio n'est pas un optimum mesuré : c'est le compromis entre le nombre d'appels au support — un
 * `read` par tranche — et la mémoire tenue. `tests/vm/recuperation-generation.spec.mjs` mesure ce
 * que ce choix coûte en temps sur OPFS réel ; le chiffre est publié, pas supposé.
 */
export const TAMPON_RELECTURE_OCTETS = 1024 * 1024;

function alignerBas(valeur) {
  return valeur - (valeur % SECTOR_SIZE);
}

function alignerHaut(valeur) {
  return alignerBas(valeur + SECTOR_SIZE - 1);
}

export class GenerationStore {
  #volume;
  #handle;
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
  /** Plus grande allocation que la RÉCUPÉRATION a faite pour elle-même. Publiée, jamais supposée. */
  #surmemoireMax = 0;

  constructor(options) {
    this.#volume = options.volume;
    this.#handle = options.handle;
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

  // ---------------------------------------------------------------- support

  /**
   * Lit le journal. Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite (#73) : un
   * support qui rend un code d'échec casté en non signé n'a pas fait une lecture courte, il n'a rien
   * lu — et `subarray` bornerait silencieusement le tampon, rendant un secteur de zéros pour une
   * racine. Une lecture COURTE, elle, est légitime : c'est ce que laisse une génération interrompue.
   */
  #lireJournal(offset, longueur) {
    const cible = this.#allouer(longueur);
    const lus = this.#lireJournalDans(cible, offset);
    return lus === longueur ? cible : cible.subarray(0, lus);
  }

  /**
   * Lit dans un tampon DÉJÀ alloué et rend le nombre d'octets lus.
   *
   * C'est le geste qui rend le rejeu en flux possible : le même tampon sert à toutes les tranches
   * d'une charge, si bien que la surmémoire de la récupération ne suit pas la taille de la charge.
   */
  #lireJournalDans(cible, offset) {
    const longueur = cible.byteLength;
    const lus = this.#handle.read(cible, { at: offset });
    if (decodeSupportCount(lus, longueur).kind === "errno") {
      throw readCountFailure(lus, {
        requested: longueur,
        volume: this.#volume,
        offset,
        operation: "read-generation",
      });
    }
    return lus;
  }

  /** Alloue, et RETIENT la plus grande allocation. La surmémoire est mesurée, pas estimée. */
  #allouer(octets) {
    if (octets > this.#surmemoireMax) this.#surmemoireMax = octets;
    return new Uint8Array(octets);
  }

  /** Écrit dans le journal. Tout compte qui n'est pas exact est un échec TYPÉ, jamais avalé (#73). */
  #ecrireJournal(offset, octets) {
    const echec = writeCountFailure(this.#handle.write(octets, { at: offset }), {
      requested: octets.byteLength,
      volume: this.#volume,
      offset,
      operation: "write-generation",
    });
    if (echec !== null) throw echec;
  }

  async #barriereJournal() {
    await this.#handle.flush();
  }

  // ------------------------------------------------------------ récupération

  /**
   * Relit les deux racines et rend celle qui fait autorité, en distinguant VIERGE et ABÎMÉE.
   *
   * La distinction décide du remède, et `decoderRacine` la fournit déjà : la jeter reviendrait à
   * traiter un secteur de racine illisible comme un secteur jamais écrit. Une racine abîmée peut
   * avoir scellé une génération acquittée ; l'écarter en silence, sous l'étiquette « issue normale
   * d'une coupure », effacerait une écriture durable sans le dire.
   *
   * @returns {{ racine: object | null, abimees: number }}
   */
  #racineFaisantAutorite() {
    let retenue = null;
    let abimees = 0;
    for (let rang = 0; rang < RACINES; rang += 1) {
      const secteur = this.#lireJournal(offsetDeRacine(rang), RACINE_OCTETS);
      if (secteur.byteLength < RACINE_OCTETS) continue;
      const lue = decoderRacine(secteur, { tailleVolume: this.#tailleVolume });
      if (!lue.valide) {
        // Un secteur VIERGE n'a jamais porté de racine : ce n'est pas une avarie, c'est une place
        // libre — l'état normal du second emplacement tant qu'aucune alternance n'a eu lieu.
        if (!lue.vierge) abimees += 1;
        continue;
      }
      if (retenue === null || lue.racine.sequence > retenue.sequence) retenue = lue.racine;
    }
    return { racine: retenue, abimees };
  }

  async #recuperer() {
    this.#surmemoireMax = 0;
    const taille = this.#handle.getSize();
    const lecture =
      taille >= ZONE_ENREGISTREMENTS ? this.#racineFaisantAutorite() : { racine: null, abimees: 0 };
    const { racine, abimees } = lecture;
    const chargePresente = Math.max(0, taille - ZONE_ENREGISTREMENTS);

    if (racine === null) {
      // AUCUNE racine valide, mais au moins une abîmée : on ne sait pas ce qui a été validé. Écarter
      // serait peut-être juste — et peut-être une perte d'écriture acquittée. Le refus est le seul
      // état qui ne ment pas. C'est la même règle que pour une charge scellée devenue incohérente :
      // pas de réparation par devinette.
      if (abimees > 0) {
        throw generationRootCorrupt(this.#volume, {
          abimees,
          octets: chargePresente,
        });
      }
      // Toutes les racines sont VIERGES : rien n'a jamais été validé dans ce journal. Ce qui traîne
      // est le reliquat d'une génération déposée puis interrompue, et il est ÉCARTÉ — le volume,
      // lui, est intact.
      if (chargePresente === 0) {
        // Journal vierge ET vide : il n'y a RIEN à faire, et surtout rien à écrire. Une ouverture
        // qui écrirait ici ferait échouer un export sur un support saturé — c'est-à-dire le geste
        // même par lequel l'utilisateur libère de la place. La racine initiale sera écrite au
        // premier dépôt, c'est-à-dire quand une écriture aura réellement lieu.
        this.#rapport = this.#poserRapport(GENERATION_ETATS.aucune, {});
        return;
      }
      await this.#vider({ sequence: 0, generation: 0 });
      this.#rapport = this.#poserRapport(GENERATION_ETATS.ecartee, {
        octetsEcartes: chargePresente,
      });
      return;
    }

    this.#sequence = racine.sequence;
    this.#sequenceValidee = racine.sequence;
    this.#generation = racine.generation;

    if (racine.longueurCharge === 0) {
      await this.#vider({ sequence: racine.sequence, generation: racine.generation });
      this.#rapport = this.#poserRapport(
        chargePresente > 0 ? GENERATION_ETATS.ecartee : GENERATION_ETATS.aucune,
        { octetsEcartes: chargePresente },
      );
      return;
    }

    const enregistrements = this.#rejouerCharge(racine);
    await this.#barriereVolume();
    await this.#vider({ sequence: racine.sequence, generation: racine.generation });
    this.#rapport = this.#poserRapport(GENERATION_ETATS.rejouee, {
      octetsEcartes: Math.max(0, chargePresente - racine.longueurCharge),
      enregistrementsRejoues: enregistrements,
      octetsRejoues: racine.longueurCharge,
    });
  }

  /** Refus TYPÉ d'une charge scellée devenue incohérente. Un doute est un refus, jamais un remède. */
  #chargeIncoherente(racine, reason) {
    return generationCorrupt(this.#volume, { generation: racine.generation, reason });
  }

  /** Lit une tranche de la charge dans le tampon partagé. Une lecture COURTE est une incohérence. */
  #lireTranche(tampon, racine, position, longueur) {
    const cible = tampon.subarray(0, longueur);
    const lus = this.#lireJournalDans(cible, ZONE_ENREGISTREMENTS + position);
    if (lus !== longueur) {
      throw this.#chargeIncoherente(
        racine,
        `la charge annonce ${racine.longueurCharge} octet(s), le journal n'en rend que ${position + lus}.`,
      );
    }
    return cible;
  }

  /**
   * Parcourt la charge d'une racine, ENREGISTREMENT PAR ENREGISTREMENT, et la refuse si elle ne
   * tient pas.
   *
   * Le parcours ne tient jamais plus qu'un tampon de `TAMPON_RELECTURE_OCTETS` : la somme de
   * contrôle est déjà incrémentale, et un enregistrement plus grand que le tampon est lu par
   * tranches. C'est le même régime que l'export et la restauration (`docs/quality-attributes.md` :
   * surmémoire de streaming ≤ 64 Mio), que la récupération ne tenait pas — elle lisait la charge
   * d'un seul tenant, soit ~128 Mio au plafond avec les tranches rejouées (#91).
   *
   * Le refus reste ferme : une génération VALIDÉE dont les octets manquent ou ne concordent plus
   * n'est pas réparable par déduction. La rejouer à moitié écrirait dans le volume des octets dont
   * personne ne sait s'ils forment un état cohérent ; l'ignorer perdrait une écriture acquittée.
   * Reste à le dire, avec un code que l'exploitant peut chercher.
   *
   * @param {object} racine descripteur scellé de la charge
   * @param {((offset: number, octets: Uint8Array) => unknown) | null} [emettre] appelé pour chaque
   *   tranche, avec l'offset du VOLUME où elle va. Le tampon lui est PRÊTÉ : il est réécrit dès la
   *   tranche suivante, et le retenir serait une faute.
   * @returns {number} le nombre d'enregistrements parcourus
   */
  #parcourirCharge(racine, emettre = null) {
    const tampon = this.#allouer(Math.min(TAMPON_RELECTURE_OCTETS, this.#tailleTampon(racine)));
    let position = 0;
    let enregistrements = 0;
    let somme = 0;

    while (position < racine.longueurCharge) {
      const entete = this.#lireTranche(tampon, racine, position, ENTETE_OCTETS);
      const decode = decoderEnteteEnregistrement(entete, { tailleVolume: this.#tailleVolume });
      if (decode === null || position + ENTETE_OCTETS + decode.longueur > racine.longueurCharge) {
        throw this.#chargeIncoherente(
          racine,
          `enregistrement illisible à l'octet ${position} d'une charge pourtant scellée.`,
        );
      }
      // L'en-tête entre dans la somme AVANT que le tampon ne soit réécrit par ses propres octets.
      somme = crc32(entete, somme);
      position += ENTETE_OCTETS;
      for (let porte = 0; porte < decode.longueur;) {
        const large = Math.min(tampon.byteLength, decode.longueur - porte);
        const tranche = this.#lireTranche(tampon, racine, position + porte, large);
        somme = crc32(tranche, somme);
        if (emettre !== null) emettre(decode.offset + porte, tranche);
        porte += large;
      }
      position += decode.longueur;
      enregistrements += 1;
    }

    if (enregistrements !== racine.enregistrements) {
      throw this.#chargeIncoherente(
        racine,
        `la racine annonce ${racine.enregistrements} enregistrement(s), la charge en porte ${enregistrements}.`,
      );
    }
    if (somme !== racine.sommeCharge) {
      throw this.#chargeIncoherente(
        racine,
        "la somme de contrôle de la charge ne concorde pas avec celle que la racine scelle.",
      );
    }
    return enregistrements;
  }

  /** Un tampon plus grand que la charge ne servirait à rien ; plus petit qu'un en-tête, à rien non plus. */
  #tailleTampon(racine) {
    return Math.max(ENTETE_OCTETS, Math.min(racine.longueurCharge, TAMPON_RELECTURE_OCTETS));
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

  #poserRapport(etat, details) {
    return Object.freeze({
      volume: this.#volume,
      etat,
      code: etat === GENERATION_ETATS.ecartee ? STORAGE_ERROR_CODES.generationDiscarded : null,
      generation: this.#generation,
      sequence: this.#sequence,
      racineOffset: offsetDeRacine(racineDeSequence(this.#sequence)),
      prochaineRacineOffset: offsetDeRacine(racineDeSequence(this.#sequence + 1)),
      octetsEcartes: 0,
      enregistrementsRejoues: 0,
      octetsRejoues: 0,
      // SURMÉMOIRE DE POINTE de la récupération, en octets : la plus grande allocation qu'elle a
      // faite pour elle-même. Publiée pour la même raison que l'export et la restauration publient
      // la leur (`docs/quality-attributes.md`) — un budget qu'on ne mesure pas n'est pas tenu, il
      // est supposé. Elle ne suit PAS la taille de la charge : le tampon de relecture est constant.
      surmemoireMaxOctets: this.#surmemoireMax,
      ...details,
    });
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
    this.#ecrireJournal(position, entete);
    this.#ecrireJournal(position + ENTETE_OCTETS, charge);
    this.#sommeCharge = crc32(charge, crc32(entete, this.#sommeCharge));
    this.#longueurCharge += ajout;
    this.#enregistrements += 1;

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
      tampon.set(this.#lireJournal(position, SECTOR_SIZE), secteur - debut);
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
      const octets = this.#lireJournal(position + (depuis - secteur), jusque - depuis);
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
      await this.#barriereJournal();
      return this.#generation;
    }
    // La charge AVANT la racine : sans cette barrière, un support pourrait rendre la racine durable
    // avant les octets qu'elle scelle, et la relecture refuserait une génération que rien n'obligeait
    // à perdre.
    await this.#barriereJournal();

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
    return this.#generation;
  }

  async #ecrireRacine(descripteur) {
    const racine = encoderRacine({ ...descripteur, tailleVolume: this.#tailleVolume });
    this.#ecrireJournal(offsetDeRacine(racineDeSequence(descripteur.sequence)), racine);
    await this.#barriereJournal();
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
    this.#handle.truncate(ZONE_ENREGISTREMENTS);
    this.#sequence = suivante;
    this.#generation = generation;
    this.#sequenceValidee = suivante;
  }

  /** Ferme le journal. La charge validée non rangée reste dans le fichier : elle est durable. */
  close() {
    this.#handle.close();
  }
}
