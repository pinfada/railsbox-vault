// La CHARGE d'un volume v3, scellée secteur par secteur (#18, ADR 0016).
//
// Cette couche s'intercale entre le backend de blocs et le support : le backend continue de parler
// en adresses LOGIQUES, et c'est ici que chaque secteur est scellé avant d'atteindre le fichier et
// ouvert après en être revenu. Elle ne connaît ni OPFS, ni v86, ni le journal de génération — deux
// fonctions de lecture et d'écriture du support lui suffisent, ce qui permet de l'éprouver sous Node
// exactement telle que le Worker l'exécute.
//
// ## Ce qu'elle ne fait jamais
//
// Elle ne rend pas de zéros. Un sceau qui ne vérifie pas est un REFUS typé
// (`VAULT_STORAGE_SCEAU_REFUSE`), et le secteur n'est pas rendu du tout — ni partiellement, ni
// complété. C'est la règle que `docs/architecture.md` impose déjà au backend pour une lecture courte,
// transposée au chiffrement : « le pilote du guest interpréterait les octets manquants comme des
// données valides ».
//
// ## L'ordre des deux écritures, et pourquoi il ne change rien
//
// Écrire un secteur, c'est écrire deux choses : sa charge chiffrée, et son sceau. Aucune atomicité ne
// les lie, et le format n'en suppose aucune. La charge est écrite EN PREMIER, si bien qu'une coupure
// entre les deux laisse « charge neuve, sceau ancien » — refusé. L'ordre inverse laisserait « sceau
// neuf, charge ancienne » — refusé aussi. Ce qui est promis ici est donc un REFUS, jamais une
// lecture ; la protection contre la PERTE est ailleurs, dans le journal de l'ADR 0014, dont le point
// de contrôle est le seul geste qui écrive le volume et dont l'échec ne valide rien.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { RANG_SECTEUR_DE_VOLUME } from "./scellement.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";
import {
  SCEAU_OCTETS,
  decoderSceau,
  encoderSceau,
  offsetDeCharge,
  offsetDeSceau,
} from "./volume-chiffre-format.mjs";

/**
 * Secteurs traités par tour lors du scellement d'un volume ENTIER.
 *
 * Ce n'est pas un lot de chiffrement — chaque secteur garde son propre appel et son propre nonce,
 * comme le format l'exige (le lot par appel est instruit et laissé fermé par l'ADR 0016). C'est un
 * lot d'E/S : il borne la surmémoire du scellement initial à ce nombre de secteurs, plutôt que de la
 * laisser suivre la taille du volume.
 */
export const SECTEURS_PAR_TOUR = 512;

export class VolumeChiffre {
  #volume;
  #scellement;
  #disposition;
  #lireSupport;
  #ecrireSupport;

  /**
   * @param {{ volume: string, scellement: import("./scellement.mjs").Scellement,
   *           disposition: object,
   *           lireSupport: (offset: number, longueur: number) => Uint8Array,
   *           ecrireSupport: (offset: number, octets: Uint8Array) => unknown }} options
   */
  constructor({ volume, scellement, disposition, lireSupport, ecrireSupport }) {
    this.#volume = volume;
    this.#scellement = scellement;
    this.#disposition = disposition;
    this.#lireSupport = lireSupport;
    this.#ecrireSupport = ecrireSupport;
  }

  get disposition() {
    return this.#disposition;
  }

  get scellement() {
    return this.#scellement;
  }

  /**
   * Rend la plage de SECTEURS qui couvre `[adresse, adresse + longueur)`.
   *
   * Le secteur est l'unité indivisible du scellement : une étiquette couvre un secteur entier, et
   * en ouvrir la moitié n'a pas de sens. Un accès qui déborde est donc élargi aux secteurs qui le
   * portent, jamais tronqué. C'est la même règle que `deposer` applique déjà côté journal, pour la
   * même raison.
   */
  #couverture(adresse, longueur) {
    if (!Number.isInteger(adresse) || adresse < 0 || !Number.isInteger(longueur) || longueur <= 0) {
      throw new RangeError(`Plage invalide : offset=${adresse} length=${longueur}.`);
    }
    if (adresse + longueur > this.#disposition.tailleLogique) {
      throw new StorageError(
        STORAGE_ERROR_CODES.outOfRange,
        `Accès hors bornes : ${longueur} octet(s) à l'offset ${adresse} d'un volume de ${this.#disposition.tailleLogique} octets.`,
        { volume: this.#volume, offset: adresse, length: longueur },
      );
    }
    const debut = adresse - (adresse % SECTOR_SIZE);
    const fin = Math.ceil((adresse + longueur) / SECTOR_SIZE) * SECTOR_SIZE;
    return { debut, longueur: fin - debut, decalage: adresse - debut };
  }

  /**
   * Relit une plage de secteurs et rend leur CLAIR. Une seule lecture de sceaux et une seule lecture
   * de charge, quelle que soit la plage : les sceaux d'adresses consécutives sont eux-mêmes
   * consécutifs dans la région, ce qui est toute la raison d'être de la disposition.
   *
   * @returns {Promise<Uint8Array>} tampon neuf, détaché du support
   */
  async lireSecteurs(adresse, longueur) {
    const plage = this.#couverture(adresse, longueur);
    const clair = await this.#lireCouverture(plage);
    return plage.decalage === 0 && plage.longueur === longueur
      ? clair
      : clair.slice(plage.decalage, plage.decalage + longueur);
  }

  /** Ouvre chaque secteur d'une plage ALIGNÉE. Une seule lecture de sceaux, une seule de charge. */
  async #lireCouverture({ debut, longueur }) {
    const nombre = longueur / SECTOR_SIZE;
    const sceaux = this.#lireSupport(
      offsetDeSceau(this.#disposition, debut),
      nombre * SCEAU_OCTETS,
    );
    const charge = this.#lireSupport(offsetDeCharge(this.#disposition, debut), longueur);
    this.#exigerCompte(sceaux, nombre * SCEAU_OCTETS, debut, "sceaux");
    this.#exigerCompte(charge, longueur, debut, "charge");

    const clair = new Uint8Array(longueur);
    for (let index = 0; index < nombre; index += 1) {
      const sceau = decoderSceau(sceaux.subarray(index * SCEAU_OCTETS, (index + 1) * SCEAU_OCTETS));
      const octets = await this.#scellement.ouvrirBloc(
        {
          generation: sceau.generation,
          rang: RANG_SECTEUR_DE_VOLUME,
          adresse: debut + index * SECTOR_SIZE,
          longueur: SECTOR_SIZE,
        },
        {
          nonce: sceau.nonce,
          etiquette: sceau.etiquette,
          chiffre: charge.slice(index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE),
        },
        // AUCUNE génération minimale n'est présentée pour un secteur du VOLUME, et l'ADR 0015 dit
        // pourquoi : le lecteur lit la génération dans le sceau voisin, c'est-à-dire au même endroit
        // que le sceau lui-même. Un minimum qui viendrait de là ne prouverait rien. Le retour arrière
        // d'un secteur n'est donc pas détecté, et ce n'est pas une omission — c'est écrit.
        { generationMinimale: null },
      );
      clair.set(octets, index * SECTOR_SIZE);
    }
    return clair;
  }

  /** Un support qui rend moins d'octets que demandé n'a pas fait une lecture courte : il a échoué. */
  #exigerCompte(rendus, attendus, adresse, zone) {
    if (rendus.byteLength === attendus) return;
    throw new StorageError(
      STORAGE_ERROR_CODES.shortRead,
      `Lecture courte de la ${zone} du volume « ${this.#volume} » à l'adresse logique ${adresse} : ${rendus.byteLength} octet(s) sur ${attendus}. Rien n'est complété.`,
      { volume: this.#volume, offset: adresse, requested: attendus, obtained: rendus.byteLength },
    );
  }

  /**
   * Scelle une plage de secteurs sous `generation` et l'écrit. La charge d'abord, les sceaux
   * ensuite : voir l'en-tête de ce fichier.
   *
   * `octetsAcceptes` modélise une écriture DÉCHIRÉE : les secteurs sont scellés entiers, mais seuls
   * les premiers octets du chiffré atteignent le support, et les sceaux ne sont pas écrits du tout.
   * C'est ce que #15 injecte, et le résultat est un secteur REFUSÉ à la relecture — jamais un
   * secteur à moitié plausible.
   *
   * Une écriture qui ne couvre pas des secteurs entiers est COMPLÉTÉE par relecture. C'est la
   * lecture-modification-réécriture que l'ADR 0015 réclame de l'appelant de `rescellerEnSecteurs`,
   * et elle vit ici parce que c'est ici qu'on sait lire. Un demi-secteur scellé n'existe pas : une
   * étiquette couvre un secteur, et compléter par des zéros écraserait la moitié qu'on n'a pas
   * reçue.
   */
  async ecrireSecteurs(adresse, octets, generation, { octetsAcceptes = null } = {}) {
    const plage = this.#couverture(adresse, octets.byteLength);
    const acceptes = octetsAcceptes ?? octets.byteLength;
    const contenu = await this.#completer(plage, octets);
    const { secteurs } = await this.#scellement.rescellerEnSecteurs({
      adresse: plage.debut,
      contenu,
      generation,
    });

    const charge = new Uint8Array(plage.longueur);
    const sceaux = new Uint8Array(secteurs.length * SCEAU_OCTETS);
    for (const [index, secteur] of secteurs.entries()) {
      charge.set(secteur.scelle.chiffre, index * SECTOR_SIZE);
      sceaux.set(
        encoderSceau({
          nonce: secteur.scelle.nonce,
          etiquette: secteur.scelle.etiquette,
          generation,
        }),
        index * SCEAU_OCTETS,
      );
    }
    const debutCharge = offsetDeCharge(this.#disposition, plage.debut);
    if (acceptes < octets.byteLength) {
      this.#ecrireSupport(debutCharge, charge.subarray(0, plage.decalage + acceptes));
      return;
    }
    this.#ecrireSupport(debutCharge, charge);
    this.#ecrireSupport(offsetDeSceau(this.#disposition, plage.debut), sceaux);
  }

  /** Complète une écriture non alignée par relecture des secteurs qui la portent. */
  async #completer(plage, octets) {
    if (plage.decalage === 0 && plage.longueur === octets.byteLength) return octets;
    const contenu = await this.#lireCouverture(plage);
    contenu.set(octets, plage.decalage);
    return contenu;
  }

  /**
   * Scelle le volume ENTIER sous `generation` — ce que la création et la restauration doivent faire.
   *
   * « Un secteur jamais écrit n'existe pas en v3 » (ADR 0015) : si la région d'authentification était
   * à zéro pour un secteur vierge, il suffirait de la zéroter pour faire lire un secteur comme blanc.
   * Le prix est un scellement par secteur du volume, mesuré dans `docs/quality-attributes.md`.
   *
   * @returns {Promise<number>} le nombre de secteurs scellés
   */
  async scellerTout(generation, { secteursParTour = SECTEURS_PAR_TOUR } = {}) {
    const vierge = new Uint8Array(secteursParTour * SECTOR_SIZE);
    let scelles = 0;
    for (let adresse = 0; adresse < this.#disposition.tailleLogique;) {
      const longueur = Math.min(vierge.byteLength, this.#disposition.tailleLogique - adresse);
      await this.ecrireSecteurs(adresse, vierge.subarray(0, longueur), generation);
      scelles += longueur / SECTOR_SIZE;
      adresse += longueur;
    }
    return scelles;
  }
}
