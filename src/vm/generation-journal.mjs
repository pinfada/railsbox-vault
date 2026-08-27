// ACCÈS au fichier journal `<volume>.gen` (#16, ADR 0014).
//
// C'est la seule pièce du magasin de générations qui touche un `FileSystemSyncAccessHandle`. Elle
// n'interprète aucun octet : elle lit, écrit, franchit une barrière, tronque et ferme — et traduit
// chaque compte rendu du support en état contractuel, parce qu'une valeur de retour se lit, elle ne
// se compare pas à la va-vite (#73).
//
// La séparer du magasin sert deux choses : le magasin cesse de mêler la sémantique d'une génération
// aux conventions d'un support, et la SURMÉMOIRE — la plus grande allocation qu'une récupération
// fasse pour elle-même — est mesurée là où les allocations ont lieu, une fois, plutôt que suivie à
// la main dans chaque chemin.

import { decodeSupportCount, readCountFailure, writeCountFailure } from "./opfs-error-mapping.mjs";

export class JournalDeGeneration {
  #volume;
  #handle;
  /** Plus grande allocation faite pour la récupération en cours. Publiée, jamais supposée. */
  #surmemoireMax = 0;

  /**
   * @param {string} volume nom du volume, pour nommer les échecs
   * @param {{ read: Function, write: Function, flush: Function, getSize: Function,
   *           truncate: Function, close: Function }} handle handle exclusif du journal voisin
   */
  constructor(volume, handle) {
    this.#volume = volume;
    this.#handle = handle;
  }

  /** Plus grande allocation faite depuis la dernière remise à zéro, en octets. */
  get surmemoireMax() {
    return this.#surmemoireMax;
  }

  /** Remet la haute eau à zéro. Une récupération mesure la SIENNE, pas celle d'avant. */
  reinitialiserSurmemoire() {
    this.#surmemoireMax = 0;
  }

  /** Alloue, et RETIENT la plus grande allocation. La surmémoire est mesurée, pas estimée. */
  allouer(octets) {
    if (octets > this.#surmemoireMax) this.#surmemoireMax = octets;
    return new Uint8Array(octets);
  }

  /** Taille du fichier journal, telle que le support la rend. */
  taille() {
    return this.#handle.getSize();
  }

  /**
   * Lit le journal. Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite (#73) : un
   * support qui rend un code d'échec casté en non signé n'a pas fait une lecture courte, il n'a rien
   * lu — et `subarray` bornerait silencieusement le tampon, rendant un secteur de zéros pour une
   * racine. Une lecture COURTE, elle, est légitime : c'est ce que laisse une génération interrompue.
   */
  lire(offset, longueur) {
    const cible = this.allouer(longueur);
    const lus = this.lireDans(cible, offset);
    return lus === longueur ? cible : cible.subarray(0, lus);
  }

  /**
   * Lit dans un tampon DÉJÀ alloué et rend le nombre d'octets lus.
   *
   * C'est le geste qui rend le rejeu en flux possible : le même tampon sert à toutes les tranches
   * d'une charge, si bien que la surmémoire de la récupération ne suit pas la taille de la charge.
   */
  lireDans(cible, offset) {
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

  /** Écrit dans le journal. Tout compte qui n'est pas exact est un échec TYPÉ, jamais avalé (#73). */
  ecrire(offset, octets) {
    const echec = writeCountFailure(this.#handle.write(octets, { at: offset }), {
      requested: octets.byteLength,
      volume: this.#volume,
      offset,
      operation: "write-generation",
    });
    if (echec !== null) throw echec;
  }

  /** Barrière du journal. Son retour vaut durabilité de ce qui a été écrit avant elle. */
  async barriere() {
    await this.#handle.flush();
  }

  /** Ramène le fichier à `octets`. Jamais avant que la racine vide ne soit durable. */
  tronquer(octets) {
    this.#handle.truncate(octets);
  }

  close() {
    this.#handle.close();
  }
}
