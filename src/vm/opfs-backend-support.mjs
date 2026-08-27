// TRADUCTION du support OPFS en états contractuels (#6, `VAULT-PERSIST-001`).
//
// Toute sollicitation du `FileSystemSyncAccessHandle` d'un volume passe ici, et rien d'autre ne
// passe ici. La séparation tient à une propriété qu'on ne veut pas voir se disperser : un échec du
// support n'est jamais avalé, il devient une `StorageError` NOMMÉE, il est inscrit au journal d'E/S,
// et un handle perdu marque la session comme perdue une fois pour toutes. Trois gestes, aux trois
// mêmes endroits, pour toutes les opérations — c'est ce qui rend « rien n'est avalé » vérifiable
// plutôt qu'affirmé.
//
// Ce module ne connaît ni la géométrie logique du volume, ni les fautes programmées, ni les
// générations : `opfs-block-backend.mjs` garde ces décisions, et ne garde qu'elles.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { toStorageError } from "./opfs-error-mapping.mjs";
import { STORAGE_ERROR_CODES, StorageError, geometryMismatch } from "./storage-errors.mjs";

export class AccesSupport {
  #volume;
  #handle;
  #journal;
  #ferme = false;
  #perdu = false;

  /**
   * @param {{ volume: string, handle: object,
   *           journal: import("./block-journal.mjs").BlockJournal }} options
   */
  constructor({ volume, handle, journal }) {
    this.#volume = volume;
    this.#handle = handle;
    this.#journal = journal;
  }

  /** Vrai dès que la fermeture a été annoncée. Une seule fermeture compte. */
  get ferme() {
    return this.#ferme;
  }

  /** Marque la session fermée. Le handle n'est rendu qu'ensuite, par `fermer()`. */
  marquerFerme() {
    this.#ferme = true;
  }

  /** Marque le handle perdu. Une faute programmée s'en sert au même titre qu'un vrai refus. */
  marquerPerdu() {
    this.#perdu = true;
  }

  /**
   * Refuse toute E/S sur un volume fermé ou dont le handle est perdu, et distingue les deux : une
   * fermeture est un choix de l'appelant, une perte de handle est un accident du support, et les
   * deux se corrigent différemment — rouvrir dans un cas, réessayer dans l'autre.
   */
  assertUtilisable() {
    if (this.#ferme) {
      throw new StorageError(
        STORAGE_ERROR_CODES.closed,
        `Volume « ${this.#volume} » fermé : plus aucune E/S n'est acceptée.`,
        { volume: this.#volume },
      );
    }
    if (this.#perdu) {
      throw new StorageError(
        STORAGE_ERROR_CODES.handleLost,
        `Handle exclusif du volume « ${this.#volume} » perdu : le support ne répond plus.`,
        { volume: this.#volume },
      );
    }
  }

  /** Traduit un échec du support en état contractuel, marque le handle perdu et le journalise. */
  #traduire(cause, operation, details) {
    const typed = toStorageError(cause, { operation, volume: this.#volume, ...details });
    if (typed.code === STORAGE_ERROR_CODES.handleLost) this.#perdu = true;
    this.#journal.record(JOURNAL_OPERATIONS.failure, {
      code: typed.code,
      message: typed.message,
      source: operation,
    });
    return typed;
  }

  /** Appelle le support SYNCHRONE et traduit tout échec en état contractuel. Rien n'est avalé. */
  appeler(operation, action, details = {}) {
    try {
      return action();
    } catch (cause) {
      throw this.#traduire(cause, operation, details);
    }
  }

  /**
   * Appelle le support et ATTEND sa résolution avant de rendre la main. Réservé à la barrière : elle
   * est la seule opération dont le guest doit attendre l'aboutissement RÉEL, parce que son
   * acquittement vaut promesse de durabilité (`SEC-DURABLE-001`). Un `FileSystemSyncAccessHandle`
   * réel rend `undefined` de façon synchrone — `await undefined` ne coûte alors qu'une microtâche —,
   * mais attendre garantit qu'un support dont la barrière n'a pas encore abouti n'est jamais acquitté
   * par anticipation.
   */
  async attendre(operation, action, details = {}) {
    try {
      return await action();
    } catch (cause) {
      throw this.#traduire(cause, operation, details);
    }
  }

  /** Lit dans un tampon fourni et rend le compte que le support annonce, sans l'interpréter. */
  lire(cible, offset, details = {}) {
    return this.appeler("read", () => this.#handle.read(cible, { at: offset }), details);
  }

  /** Écrit et rend le compte que le support annonce, sans l'interpréter. */
  ecrire(octets, offset, details = {}) {
    return this.appeler("write", () => this.#handle.write(octets, { at: offset }), details);
  }

  /** Barrière du support. Son ATTENTE est ce qui interdit l'acquittement anticipé. */
  barriere(details = {}) {
    return this.attendre("flush", () => this.#handle.flush(), details);
  }

  /**
   * La géométrie du support est revérifiée avant chaque E/S. Un fichier qui rétrécit sous un volume
   * ouvert transformerait toutes les lectures suivantes en lectures courtes, sans que rien ne dise
   * pourquoi ; la taille de session ne doit pas non plus se mettre à suivre la nouvelle taille.
   * `getSize()` est synchrone et local : le coût est celui d'un appel, pas d'une E/S.
   */
  assertGeometrieInchangee(operation, attendue) {
    const observed = this.appeler(operation, () => this.#handle.getSize());
    if (observed !== attendue) {
      throw geometryMismatch(this.#volume, {
        observed,
        expected: attendue,
        reason: "La géométrie du support a changé pendant la session.",
      });
    }
  }

  /** Rend le handle au support. L'échec remonte : une fermeture ratée n'est pas une fermeture. */
  fermer() {
    this.#handle.close();
  }
}
