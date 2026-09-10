// L'ÉCRIVAIN DE RACINES d'un journal de génération (#16, ADR 0014 ; #18, ADR 0016 ; #19, ADR 0019).
//
// Écrire une racine est le geste par lequel une génération devient VALIDÉE : la charge est scellée,
// l'empreinte de région rescellée sous la génération de cette racine, le secteur écrit à
// l'emplacement `séquence mod 2`, une barrière franchie, puis le témoin daté. C'est un geste entier,
// avec un ordre qui est le contrat, et il se lit d'un bloc.
//
// **Il vit à part depuis #181**, qui a fait franchir à `generation-store.mjs` le seuil d'alerte de
// `tests/unit/taille-des-fichiers.test.mjs`. L'inscription de #65 disait déjà « la prochaine tranche
// qui y touchera devra le scinder » ; la coupure passe ici parce que c'est le seul endroit du
// magasin qui SE SOUVIENT de quelque chose que le protocole ne porte pas : le scellé de la dernière
// racine écrite, dont le point de contrôle a besoin pour rejouer la charge validée.
//
// Ce module ne décide RIEN. Il ne sait ni quand une racine doit être écrite, ni laquelle fait
// autorité : le magasin le lui dit, et il écrit.

import { encoderRacine, offsetDeRacine, racineDeSequence } from "./generation-format.mjs";
import { identifiantVolumeEnOctets } from "./volume-chiffre-format.mjs";

export class EcrivainDeRacine {
  #journal;
  #scellement;
  #garde;
  #tailleVolume;
  #formatEcrit;

  /**
   * SCELLÉ de la dernière racine écrite, ou `null` tant qu'aucune ne l'a été.
   *
   * Il est retenu parce que le POINT DE CONTRÔLE en a besoin : il rejoue la charge validée sous la
   * racine qui fait autorité, et cette racine est celle que cette session vient d'écrire — la relire
   * du journal pour la retrouver reviendrait à redécoder ce qu'on vient d'encoder.
   */
  #scelle = null;
  #scellementsCumules = 0;

  /**
   * @param {{ journal: object, scellement: object, garde: object | null, tailleVolume: number,
   *           formatEcrit: number }} collaborateurs
   *   `garde` est la garde de fraîcheur de l'ADR 0019, ou `null` quand l'appelant l'a DÉCLARÉE
   *   absente. Le magasin a déjà tenu cette exigence : ici, `null` est un fait, pas un oubli.
   */
  constructor({ journal, scellement, garde, tailleVolume, formatEcrit }) {
    this.#journal = journal;
    this.#scellement = scellement;
    this.#garde = garde;
    this.#tailleVolume = tailleVolume;
    this.#formatEcrit = formatEcrit;
  }

  /** Le scellé de la dernière racine écrite : nonce, chiffré, étiquette. `null` avant la première. */
  get scelle() {
    return this.#scelle;
  }

  /** Scellements cumulés que la dernière racine écrite AUTHENTIFIE. */
  get scellementsCumules() {
    return this.#scellementsCumules;
  }

  /**
   * Scelle puis écrit une racine. La SÉQUENCE PRÉCÉDENTE est présentée au modèle, qui refuse une
   * séquence qui ne croîtrait pas strictement : deux racines authentiques de même séquence
   * rendraient l'autorité ambiguë à la reprise (ADR 0015).
   */
  async ecrire({ sequence, generation, entrees, sequencePrecedente }) {
    // L'empreinte de région est RESCELLÉE sous la génération de CETTE racine, jamais recopiée d'une
    // racine antérieure : une empreinte authentique mais scellée sous une génération plus ancienne,
    // épissée dans une racine récente, ferait passer la région d'hier pour celle d'aujourd'hui.
    // Le hachage, lui, n'est refait que si le volume a été écrit depuis le dernier (`marquerRegionSale`).
    const fraicheur = this.#garde === null ? null : await this.#garde.pourRacine(generation);
    const scelle = await this.#scellement.scellerRacine(
      { sequence, generation, tailleVolume: this.#tailleVolume },
      entrees,
      { sequencePrecedente },
    );
    const racine = encoderRacine({
      fraicheur,
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
    // Le TÉMOIN vient APRÈS la barrière de la racine, et l'ordre est le contrat. Une coupure entre
    // les deux laisse un témoin EN RETARD : un plancher en retard sous-détecte, il ne refuse jamais
    // à tort. L'ordre inverse laisserait un témoin en AVANCE, c'est-à-dire un volume intact refusé.
    await this.#garde?.ecrireTemoin({ sequence, generation });
    this.#scelle = Object.freeze({
      nonce: scelle.nonce,
      chiffre: scelle.chiffre,
      etiquette: scelle.etiquette,
    });
    this.#scellementsCumules = scelle.entete.scellementsCumules;
  }

  /**
   * Le DESCRIPTEUR de la racine qui fait autorité, tel que le parcours d'une charge l'attend.
   *
   * Il vit ici parce que deux de ses champs — le scellé et les scellements cumulés — sont ce que cet
   * objet retient, et qu'un descripteur assemblé ailleurs les redemanderait un à un.
   */
  descripteurDeRacineValidee({ sequenceValidee, generation, entrees, longueurCharge }) {
    return {
      // POSÉ : il dit au parcours sous quelle étiquette cette charge a été scellée (#143).
      format: this.#formatEcrit,
      sequence: sequenceValidee,
      generation,
      tailleVolume: this.#tailleVolume,
      nombreEntrees: entrees,
      longueurCharge,
      scellementsCumules: this.#scellementsCumules,
      scelle: this.#scelle,
    };
  }
}
