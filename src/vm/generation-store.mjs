// Machine d'état d'une génération transactionnelle (#16, ADR 0014 ; #18, ADR 0016).
//
// Le magasin ne connaît ni OPFS, ni v86, ni le backend de blocs. Il reçoit le handle du journal
// voisin `<volume>.gen`, la taille logique du volume, un SCELLEMENT, et deux fonctions pour lire et
// écrire le VOLUME lui-même. C'est ce qui permet d'éprouver sous Node exactement le code que le
// Worker exécute sur le vrai support.
//
// Le protocole tient en quatre gestes, et leur ORDRE est le contrat :
//
//  1. DÉPOSER — les octets d'une écriture sont SCELLÉS puis écrits dans le journal, jamais dans le
//     volume. Un lecteur qui rouvrirait le volume ici n'en verrait rien ; l'écrivain, lui, se relit
//     (v86 exige cette cohérence de session, cf. `docs/architecture.md` § contrat de tampon).
//  2. VALIDER — la charge est franchie par une barrière, PUIS la racine est écrite, PUIS une seconde
//     barrière. L'ordre est ce qui distingue « validé » de « probablement écrit » : sans la première
//     barrière, un support pourrait rendre la racine durable avant sa charge, et la relecture
//     trouverait une génération validée dont les octets manquent — un REFUS là où une simple mise au
//     rebut aurait suffi.
//  3. POINT DE CONTRÔLE — la charge validée est RESCELLÉE en secteurs et recopiée dans le volume,
//     franchie par une barrière, puis le journal est vidé. C'est le seul geste qui touche le volume.
//  4. RÉCUPÉRER — à l'ouverture. La dernière racine valide fait autorité ; ce qui la dépasse est
//     ÉCARTÉ avec un diagnostic ; une charge validée mais incohérente est REFUSÉE, jamais devinée.
//
// Le point de validation est le geste 2 : c'est là que la barrière du guest peut être acquittée sans
// mentir. Le geste 3 ne déplace aucune promesse — il ne fait que ranger.
//
// ## Ce que #18 change, et ce qu'il ne change pas
//
// Le protocole est INTACT. Ce qui change est la nature de ce qui est écrit : chaque enregistrement
// porte un sceau de 34 octets (nonce, étiquette, GÉNÉRATION), la racine porte une étiquette à la
// place de son CRC-32, et le point de contrôle rescelle secteur par secteur sous un nonce neuf. La
// génération est stockée avec l'enregistrement parce qu'une charge en cumule PLUSIEURS tant qu'aucun
// point de contrôle ne l'a vidée — c'est la correction que l'ADR 0016 apporte à l'ADR 0015.
//
// Trois voisins portent ce que le magasin n'a pas à savoir, et sont réexportés ici pour que les
// appelants n'aient rien à changer : `generation-plafonds.mjs` les seuils calibrés,
// `generation-journal.mjs` l'accès au fichier, `generation-charge.mjs` le parcours en flux d'une
// charge, `generation-recuperation.mjs` le constat d'ouverture et son compte rendu.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { parcourirCharge } from "./generation-charge.mjs";
import {
  ENTETE_OCTETS,
  SCEAU_ENREGISTREMENT_OCTETS,
  SURCOUT_ENREGISTREMENT,
  ZONE_ENREGISTREMENTS,
  encoderEnteteEnregistrement,
  encoderRacine,
  longueurPhysiqueDeCharge,
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
import { decoderSceau, encoderSceau, identifiantVolumeEnOctets } from "./volume-chiffre-format.mjs";

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

/** État d'une charge : ce qu'elle porte, en clair et sur le support. Recopié, jamais partagé. */
function etatDeCharge(entrees = [], longueurClair = 0, longueurPhysique = 0) {
  return { entrees, longueurClair, longueurPhysique };
}

export class GenerationStore {
  #volume;
  #journal;
  #tailleVolume;
  #scellement;
  #lireVolume;
  #ecrireVolume;
  #barriereVolume;
  #plafond;
  #seuilPointDeControle;

  /** Secteur logique → l'enregistrement du journal qui le remplace, et son décalage dedans. */
  #index = new Map();
  /** Charge DÉPOSÉE : les entrées, la longueur des clairs, la longueur occupée sur le support. */
  #charge = etatDeCharge();
  /** Charge SCELLÉE par la dernière racine. Ce qui la dépasse n'est pas encore validé. */
  #validee = etatDeCharge();
  #sequence = 0;
  #generation = 0;
  #sequenceValidee = 0;
  #rapport = null;
  /**
   * CLAIR du dernier enregistrement ouvert, et sa position. Un seul, et c'est délibéré.
   *
   * Un secteur relu du journal vit à l'intérieur d'un enregistrement CHIFFRÉ : le rendre exige
   * d'ouvrir l'enregistrement entier, puisqu'une étiquette couvre tout l'enregistrement et pas
   * chacun de ses secteurs. Sans mémo, une relecture séquentielle de dix secteurs d'un même
   * enregistrement l'ouvrirait dix fois. Le mémo est vidé dès que la charge bouge, parce qu'un
   * enregistrement réécrit au même endroit n'est plus le même.
   */
  #dernierOuvert = null;
  /** Sceau et compteur de la dernière racine écrite. Conservés pour le parcours du rangement. */
  #scelleDeLaRacine = null;
  #scellementsDeLaRacine = 0;
  /**
   * Plus grande charge que ce magasin ait VALIDÉE, en octets OCCUPÉS SUR LE SUPPORT — en-têtes et
   * sceaux compris, comme en v2. Haute eau, jamais remise à zéro.
   *
   * C'est la taille de la plus grande GÉNÉRATION — ce qu'un guest fait sceller entre deux barrières.
   * Le point de contrôle remet la charge validée à zéro à chaque rangement : sans ce compteur, seule
   * la DERNIÈRE génération d'un boot serait lisible, dans le rapport de la prochaine ouverture.
   */
  #chargeMaxValidee = 0;
  /**
   * Plus grande charge DÉPOSÉE, en octets occupés sur le support. Haute eau, jamais remise à zéro.
   *
   * **C'est elle, et non la précédente, que `PLAFOND_CHARGE_OCTETS` borne.** `deposer` refuse quand
   * la charge déposée dépasse le plafond, et cette charge compte tout ce qui a été déposé depuis le
   * dernier POINT DE CONTRÔLE — y compris les écritures qu'aucune barrière n'a encore validées.
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
    this.#scellement = options.scellement;
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
   *           scellement: import("./scellement.mjs").Scellement,
   *           lireVolume: (offset: number, longueur: number) => Promise<Uint8Array>,
   *           ecrireVolume: (offset: number, octets: Uint8Array, generation: number) => unknown,
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

  /** Scellements consommés sous la clé de ce volume. Authentifié dans la racine, donc durable. */
  get scellementsCumules() {
    return this.#scellement.scellementsCumules;
  }

  /** Ce que l'ouverture a trouvé et fait. Publié, jamais tu : une mise au rebut est une nouvelle. */
  get rapport() {
    return this.#rapport;
  }

  /** Vrai si des octets déposés attendent leur validation. */
  get enAttente() {
    return this.#sequenceValidee < this.#sequence || this.#charge.longueurPhysique > 0;
  }

  /** Emplacement de la racine qui fait autorité en ce moment. */
  get racineOffset() {
    return offsetDeRacine(racineDeSequence(this.#sequenceValidee));
  }

  /** Emplacement que la prochaine écriture de racine occupera. L'alternance est observable. */
  get prochaineRacineOffset() {
    return offsetDeRacine(racineDeSequence(this.#sequence + 1));
  }

  /** Octets de charge occupés sur le support depuis le dernier point de contrôle. */
  get octetsDeCharge() {
    return this.#charge.longueurPhysique;
  }

  /**
   * Plus grande génération que ce magasin ait validée, en octets de clair. Zéro si aucune barrière
   * n'a scellé quoi que ce soit.
   */
  get chargeMaxValideeOctets() {
    return this.#chargeMaxValidee;
  }

  /** Plus grande charge DÉPOSÉE depuis un point de contrôle, en octets occupés sur le support. */
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

  /**
   * Une racine fait autorité : elle fixe la génération, et ce qui la dépasse est écarté.
   *
   * Le COMPTEUR DE SCELLEMENTS est repris ici, et d'un cran au-dessus de ce que la racine déclare :
   * elle porte le compteur d'AVANT son propre scellement, et le sien en a consommé un. Il n'est pas
   * encore authentifié à ce point — il le sera quand `ouvrirRacine` aura vérifié l'étiquette, dans
   * le parcours de la charge —, mais il faut bien le poser avant de sceller quoi que ce soit.
   */
  async #recupererDepuisRacine({ racine, chargePresente }) {
    this.#exigerIdentiteDeVolume(racine);
    this.#sequence = racine.sequence;
    this.#sequenceValidee = racine.sequence;
    this.#generation = racine.generation;
    this.#scellement.reprendreDepuis(racine.scellementsCumules + 1);

    if (racine.nombreEntrees === 0) {
      // La racine VIDE est authentifiée elle aussi, et il faut dire pourquoi : c'est elle qui fixe
      // la génération et la séquence de la session à venir. En v2, `decoderRacine` la validait par
      // un CRC-32 — c'est-à-dire par rien, contre un altérateur qui le recalcule. En v3, la
      // décoder ne prouve plus quoi que ce soit : seule l'étiquette le fait. Le parcours d'une
      // charge de zéro entrée ne lit aucun enregistrement et n'ouvre que la racine, ce qui est
      // exactement le geste voulu.
      await this.#parcourirCharge(racine);
      await this.#vider({ sequence: racine.sequence, generation: racine.generation });
      return this.#rapportDe(
        chargePresente > 0 ? GENERATION_ETATS.ecartee : GENERATION_ETATS.aucune,
        { octetsEcartes: chargePresente },
      );
    }

    const enregistrements = await this.#rejouerCharge(racine);
    await this.#barriereVolume();
    await this.#vider({ sequence: racine.sequence, generation: racine.generation });
    // Les deux chiffres publiés comptent les octets OCCUPÉS SUR LE SUPPORT, en-têtes et sceaux
    // compris : c'est la grandeur que `chargePresente` mesure, et les mélanger avec la longueur des
    // clairs que la racine authentifie rendrait « écartés » négatif sur une charge complète.
    const rejoues = longueurPhysiqueDeCharge(racine);
    return this.#rapportDe(GENERATION_ETATS.rejouee, {
      octetsEcartes: Math.max(0, chargePresente - rejoues),
      enregistrementsRejoues: enregistrements,
      octetsRejoues: rejoues,
    });
  }

  /**
   * Refuse une racine qui DÉCLARE un autre volume, avant même de vérifier son étiquette.
   *
   * L'identifiant lu ici n'est pas encore authentifié — il ne le sera que par `ouvrirRacine` — et le
   * refus qui suivrait serait de toute façon un `SCEAU_REFUSE`, puisque les données associées
   * porteraient un autre identifiant. Le contrôle sert donc au DIAGNOSTIC, pas à la sécurité : il
   * distingue « ce journal appartient à un autre volume » de « ce journal est abîmé », deux états
   * dont les remèdes n'ont rien de commun.
   */
  #exigerIdentiteDeVolume(racine) {
    const attendu = identifiantVolumeEnOctets(this.#scellement.volume);
    if (racine.identifiantVolume.every((octet, index) => octet === attendu[index])) return;
    throw new StorageError(
      STORAGE_ERROR_CODES.identiteVolume,
      `Journal de génération du volume « ${this.#volume} » refusé : sa racine DÉCLARE un autre identifiant de volume que celui du manifeste. La valeur n'est pas authentifiée à ce point — elle est seulement déclarée —, mais l'écart suffit à savoir que ce journal n'est pas celui de ce volume.`,
      { volume: this.#volume, attendu: this.#scellement.volume },
    );
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
      scellement: this.#scellement,
      emettre,
    });
  }

  /**
   * Recopie la charge d'une racine dans le volume, en flux. DEUX passes, et l'ordre est le contrat.
   *
   * La première vérifie la charge entière — structure, sceau de chaque enregistrement, étiquette de
   * la racine, compte et empreinte des entrées — sans rien écrire ; la seconde seulement recopie.
   * Les fusionner ferait payer au volume le prix d'une charge abîmée : les premiers enregistrements
   * y seraient déjà quand le dernier serait refusé, c'est-à-dire exactement le rejeu à moitié que ce
   * magasin interdit. Le prix de la sûreté est une seconde lecture du journal et un second
   * déchiffrement ; `tests/vm/recuperation-generation.spec.mjs` le mesure.
   *
   * @returns {Promise<number>} le nombre d'enregistrements recopiés
   */
  async #rejouerCharge(racine) {
    const enregistrements = await this.#parcourirCharge(racine);
    await this.#parcourirCharge(racine, (offset, octets, generation) =>
      this.#ecrireVolume(offset, octets, generation),
    );
    return enregistrements;
  }

  // ----------------------------------------------------------------- gestes

  /**
   * Dépose une écriture dans le journal, SCELLÉE. Le volume n'est pas touché.
   *
   * Une écriture qui ne couvre pas des secteurs entiers est COMPLÉTÉE par relecture plutôt que
   * refusée : le journal est indexé au secteur, et un demi-secteur déposé rendrait la relecture de
   * l'autre moitié ambiguë. Le surcoût est une lecture, et il n'existe que pour un accès dont le
   * spike #4 a mesuré que le guest ne l'émet pas. C'est aussi ce qui garantit au POINT DE CONTRÔLE
   * des enregistrements alignés, que `rescellerEnSecteurs` exige.
   */
  async deposer(offset, octets) {
    const debut = alignerBas(offset);
    const fin = alignerHaut(offset + octets.byteLength);
    let charge;
    if (debut === offset && fin === offset + octets.byteLength) {
      charge = octets;
    } else {
      charge = await this.lire(debut, fin - debut);
      charge.set(octets, offset - debut);
    }

    const ajout = SURCOUT_ENREGISTREMENT + charge.byteLength;
    if (this.#charge.longueurPhysique + ajout > this.#plafond) {
      throw generationOverflow(this.#volume, {
        pending: this.#charge.longueurPhysique,
        requested: ajout,
        limit: this.#plafond,
      });
    }

    // La génération EN VOL est celle qu'une validation donnera à cet enregistrement s'il en reçoit
    // une. Elle est stockée avec lui : voir l'ADR 0016, décision 2.
    const generation = this.#generation + 1;
    const rang = this.#charge.entrees.length;
    const scelle = await this.#scellement.scellerBloc(
      { generation, rang, adresse: debut, longueur: charge.byteLength },
      charge,
    );

    const position = ZONE_ENREGISTREMENTS + this.#charge.longueurPhysique;
    this.#ecrireEnregistrement(position, { debut, charge, generation, scelle });
    this.#inscrireEnregistrement(position, { debut, fin, charge, generation, rang, scelle, ajout });
  }

  /** Pose les trois morceaux d'un enregistrement sur le support : en-tête, sceau, chiffré. */
  #ecrireEnregistrement(position, { debut, charge, generation, scelle }) {
    this.#journal.ecrire(
      position,
      encoderEnteteEnregistrement({ offset: debut, longueur: charge.byteLength }),
    );
    this.#journal.ecrire(
      position + ENTETE_OCTETS,
      encoderSceau({ nonce: scelle.nonce, etiquette: scelle.etiquette, generation }),
    );
    this.#journal.ecrire(position + SURCOUT_ENREGISTREMENT, scelle.chiffre);
  }

  /** Enregistre en mémoire ce que le support porte désormais : entrée, hautes eaux, index, mémo. */
  #inscrireEnregistrement(position, { debut, fin, charge, generation, rang, scelle, ajout }) {
    this.#charge.entrees.push({
      adresse: debut,
      longueur: charge.byteLength,
      rang,
      etiquette: scelle.etiquette,
    });
    this.#charge.longueurClair += charge.byteLength;
    this.#charge.longueurPhysique += ajout;
    // HAUTE EAU de ce que le PLAFOND borne. Posée après l'écriture réussie : une écriture refusée
    // par le support n'a pas occupé le journal, et la compter gonflerait la mesure qui calibre.
    if (this.#charge.longueurPhysique > this.#chargeMaxDeposee) {
      this.#chargeMaxDeposee = this.#charge.longueurPhysique;
    }

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

  /**
   * Rend le CLAIR de l'enregistrement `entree`, en ouvrant le moins souvent possible.
   *
   * Une étiquette couvre l'enregistrement ENTIER : il n'y a pas de moyen d'ouvrir un seul de ses
   * secteurs, et prétendre le contraire reviendrait à rendre des octets que rien n'authentifie. Le
   * mémo d'un seul enregistrement suffit à rendre une relecture séquentielle linéaire.
   */
  async #ouvrirEnregistrement(entree) {
    if (this.#dernierOuvert?.position === entree.position) return this.#dernierOuvert.clair;
    const chiffre = this.#journal.lire(entree.position + SURCOUT_ENREGISTREMENT, entree.longueur);
    const sceau = decoderSceau(
      this.#journal.lire(entree.position + ENTETE_OCTETS, SCEAU_ENREGISTREMENT_OCTETS),
    );
    const clair = await this.#scellement.ouvrirBloc(
      {
        generation: entree.generation,
        rang: entree.rang,
        adresse: entree.adresse,
        longueur: entree.longueur,
      },
      { nonce: sceau.nonce, etiquette: sceau.etiquette, chiffre },
      { generationMinimale: null },
    );
    this.#dernierOuvert = { position: entree.position, clair };
    return clair;
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
      const clair = await this.#ouvrirEnregistrement(entree);
      tampon.set(clair.subarray(entree.decalage, entree.decalage + SECTOR_SIZE), secteur - debut);
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
  async superposer(offset, tampon) {
    if (this.#index.size === 0) return tampon;
    const fin = offset + tampon.byteLength;
    for (let secteur = alignerBas(offset); secteur < fin; secteur += SECTOR_SIZE) {
      const entree = this.#index.get(secteur);
      if (entree === undefined) continue;
      const clair = await this.#ouvrirEnregistrement(entree);
      const depuis = Math.max(offset, secteur);
      const jusque = Math.min(fin, secteur + SECTOR_SIZE);
      const dans = entree.decalage + (depuis - secteur);
      tampon.set(clair.subarray(dans, dans + (jusque - depuis)), depuis - offset);
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
    if (this.#charge.longueurPhysique === this.#validee.longueurPhysique) {
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
    await this.#ecrireRacine({ sequence, generation, entrees: this.#charge.entrees });

    this.#sequence = sequence;
    this.#generation = generation;
    this.#sequenceValidee = sequence;
    this.#validee = etatDeCharge(
      [...this.#charge.entrees],
      this.#charge.longueurClair,
      this.#charge.longueurPhysique,
    );
    // HAUTE EAU, posée APRÈS le succès de la racine : seule une génération réellement scellée
    // compte. La poser avant ferait entrer dans la statistique une charge que le support a refusée.
    if (this.#validee.longueurPhysique > this.#chargeMaxValidee) {
      this.#chargeMaxValidee = this.#validee.longueurPhysique;
    }
    return this.#generation;
  }

  /**
   * Scelle puis écrit une racine. La SÉQUENCE PRÉCÉDENTE est présentée au modèle, qui refuse une
   * séquence qui ne croîtrait pas strictement : deux racines authentiques de même séquence
   * rendraient l'autorité ambiguë à la reprise (ADR 0015).
   */
  async #ecrireRacine({ sequence, generation, entrees }) {
    const scelle = await this.#scellement.scellerRacine(
      { sequence, generation, tailleVolume: this.#tailleVolume },
      entrees,
      { sequencePrecedente: this.#sequence },
    );
    const racine = encoderRacine({
      sequence,
      generation,
      tailleVolume: this.#tailleVolume,
      nombreEntrees: scelle.entete.nombreEntrees,
      longueurCharge: scelle.entete.longueurCharge,
      identifiantVolume: identifiantVolumeEnOctets(this.#scellement.volume),
      scellementsCumules: scelle.entete.scellementsCumules,
      nonce: scelle.nonce,
      chiffre: scelle.chiffre,
      etiquette: scelle.etiquette,
    });
    this.#journal.ecrire(offsetDeRacine(racineDeSequence(sequence)), racine);
    await this.#journal.barriere();
    this.#scelleDeLaRacine = Object.freeze({
      nonce: scelle.nonce,
      chiffre: scelle.chiffre,
      etiquette: scelle.etiquette,
    });
    this.#scellementsDeLaRacine = scelle.entete.scellementsCumules;
  }

  /** Vrai si la charge validée mérite d'être rangée dans le volume dès maintenant. */
  get pointDeControleDu() {
    return this.#validee.longueurPhysique >= this.#seuilPointDeControle;
  }

  /**
   * Vrai si tout ce qui est déposé est validé. Une charge non validée n'est JAMAIS rangée dans le
   * volume : elle n'a été acquittée à personne, et la prochaine ouverture l'écartera.
   */
  get rangeable() {
    return (
      this.#validee.longueurPhysique > 0 &&
      this.#validee.longueurPhysique === this.#charge.longueurPhysique
    );
  }

  /**
   * Range la charge VALIDÉE dans le volume, puis vide le journal.
   *
   * Ce geste ne valide rien et ne promet rien de neuf : les octets étaient déjà durables. Il n'est
   * donc jamais sur le chemin d'un acquittement, et son échec n'invalide pas la génération — elle
   * reste dans le journal, et la prochaine ouverture la rejouera. C'est lui qui RESCELLE : le clair
   * relu du journal est scellé de nouveau, secteur par secteur, sous un nonce neuf (ADR 0015).
   */
  async pointDeControle() {
    if (this.#validee.longueurPhysique === 0) return;
    if (!this.rangeable) {
      const enAttente = this.#charge.longueurPhysique - this.#validee.longueurPhysique;
      throw new StorageError(
        STORAGE_ERROR_CODES.generationPending,
        `Point de contrôle refusé sur le volume « ${this.#volume} » : ${enAttente} octet(s) déposés ne sont validés par aucune barrière, et les recopier publierait un état que personne n'a acquitté.`,
        { volume: this.#volume, generation: this.#generation },
      );
    }
    await this.#rejouerCharge(this.#racineValidee());
    await this.#barriereVolume();
    await this.#vider({ sequence: this.#sequence, generation: this.#generation });
  }

  /** Le descripteur de la racine qui fait autorité, tel que le parcours l'attend. */
  #racineValidee() {
    return {
      sequence: this.#sequenceValidee,
      generation: this.#generation,
      tailleVolume: this.#tailleVolume,
      nombreEntrees: this.#validee.entrees.length,
      longueurCharge: this.#validee.longueurClair,
      scellementsCumules: this.#scellementsDeLaRacine,
      scelle: this.#scelleDeLaRacine,
    };
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
   *    charge est bornée par ce que sa racine déclare, pas par la taille du fichier.
   */
  async #vider({ sequence, generation }) {
    this.#index.clear();
    this.#dernierOuvert = null;
    this.#charge = etatDeCharge();
    this.#validee = etatDeCharge();
    const suivante = sequence + 1;
    this.#sequence = sequence;
    await this.#ecrireRacine({ sequence: suivante, generation, entrees: [] });
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
