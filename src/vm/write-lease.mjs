// Machine à états du bail d'écriture (#8, `VAULT-PERSIST-002`).
//
// Un volume possède AU PLUS un écrivain. Cette machine porte cet invariant sous une forme pure et
// testable : elle ne connaît ni Web Locks, ni OPFS, ni `BroadcastChannel`. Le transport
// (`write-lease-transport.mjs`) n'est qu'une couche fine qui traduit les événements réels du
// navigateur — verrou acquis, handle ouvert, contexte mort — en transitions de cette machine.
//
// La séparer du transport est délibéré. Le vrai arbitrage vient de Web Locks, exclusif à la mort du
// contexte près ; mais s'appuyer sur cette seule coïncidence serait fragile (c'est le raisonnement
// de l'ADR 0002 pour le handle OPFS). La machine rend la règle EXPLICITE et vérifiable sous Node,
// et le niveau navigateur prouve ensuite que le transport la respecte réellement.
//
// Aucune transition n'est silencieuse : une transition interdite lève une erreur typée plutôt que
// de laisser un bail glisser dans un état incohérent.

/** États du bail, du point de vue d'un contexte (un onglet, un Worker). */
export const LEASE_STATES = Object.freeze({
  /** Ni détenu, ni demandé : le contexte n'écrit pas. */
  free: "libre",
  /** Bail demandé ; un autre le détient, on patiente dans la file. */
  waiting: "attente",
  /** Ce contexte détient le bail ET le handle exclusif : c'est L'écrivain. */
  held: "detenu",
  /** Le détenteur rend la main : le handle se ferme avant qu'un autre acquière. */
  relaying: "relais",
  /** Demande refusée : délai dépassé ou refus explicite. Un autre écrit toujours. */
  denied: "refus",
  /** Bail détenu puis perdu sans fermeture propre (mort du support ou du contexte). */
  lost: "perdu",
});

/**
 * Statut destiné à l'UI. C'est un ÉTAT EXPLICITE, jamais un booléen « peut écrire » : un onglet en
 * attente, en conflit ou en erreur ne se distinguerait pas d'un onglet en lecture seule sous un
 * simple drapeau, et l'utilisateur ne saurait pas s'il doit patienter, réessayer ou s'inquiéter.
 */
export const LEASE_STATUS = Object.freeze({
  readOnly: "lecture-seule",
  waiting: "attente",
  writing: "ecriture",
  conflict: "conflit",
  error: "erreur",
});

/** Statut d'UI par état. La relève est encore une lecture seule : le contexte n'écrit déjà plus. */
const STATUS_BY_STATE = Object.freeze({
  [LEASE_STATES.free]: LEASE_STATUS.readOnly,
  [LEASE_STATES.waiting]: LEASE_STATUS.waiting,
  [LEASE_STATES.held]: LEASE_STATUS.writing,
  [LEASE_STATES.relaying]: LEASE_STATUS.readOnly,
  [LEASE_STATES.denied]: LEASE_STATUS.conflict,
  [LEASE_STATES.lost]: LEASE_STATUS.error,
});

/**
 * Budget de relais-ou-refus du produit (`docs/quality-attributes.md`) : un second contexte obtient
 * en 5 s au plus soit un relais sûr, soit un refus explicite.
 */
export const RELAY_DEADLINE_MS = 5000;

/**
 * Table des transitions autorisées : `état → { événement → état cible }`. Elle EST le contrat.
 * Toute paire absente est interdite et lève `LeaseTransitionError`. Documentée dans
 * `docs/architecture.md` (§ concurrence et bail d'écriture).
 */
export const LEASE_TRANSITIONS = Object.freeze({
  [LEASE_STATES.free]: Object.freeze({ request: LEASE_STATES.waiting }),
  [LEASE_STATES.waiting]: Object.freeze({
    grant: LEASE_STATES.held,
    deny: LEASE_STATES.denied,
    expire: LEASE_STATES.denied,
    abandon: LEASE_STATES.free,
  }),
  [LEASE_STATES.held]: Object.freeze({
    release: LEASE_STATES.relaying,
    lose: LEASE_STATES.lost,
  }),
  [LEASE_STATES.relaying]: Object.freeze({ settle: LEASE_STATES.free }),
  [LEASE_STATES.denied]: Object.freeze({ reset: LEASE_STATES.free, retry: LEASE_STATES.waiting }),
  [LEASE_STATES.lost]: Object.freeze({ reset: LEASE_STATES.free, retry: LEASE_STATES.waiting }),
});

/** Erreur d'une transition interdite ou d'une expiration prématurée. Jamais avalée. */
export class LeaseTransitionError extends Error {
  constructor(from, event, message) {
    super(message ?? `Transition de bail interdite : « ${event} » depuis « ${from} ».`);
    this.name = "LeaseTransitionError";
    this.code = "VAULT_LEASE_TRANSITION";
    this.from = from;
    this.event = event;
  }
}

/**
 * Bail d'écriture d'un contexte. IMMUABLE : chaque transition rend une NOUVELLE instance, jamais une
 * mutation. Une horloge est injectée (`now`) pour que les échéances soient contrôlables au test et
 * réelles en production ; la machine ne lit jamais le temps elle-même.
 */
export class WriteLease {
  #volume;
  #now;
  #deadlineMs;
  #state;
  #requestedAt;
  #deadlineAt;
  #grantedAt;
  #reason;

  constructor({
    volume,
    now = () => 0,
    deadlineMs = RELAY_DEADLINE_MS,
    state = LEASE_STATES.free,
    requestedAt = null,
    deadlineAt = null,
    grantedAt = null,
    reason = null,
  } = {}) {
    if (typeof volume !== "string" || volume === "") {
      throw new TypeError(`Nom de volume invalide pour un bail : ${JSON.stringify(volume)}.`);
    }
    this.#volume = volume;
    this.#now = now;
    this.#deadlineMs = deadlineMs;
    this.#state = state;
    this.#requestedAt = requestedAt;
    this.#deadlineAt = deadlineAt;
    this.#grantedAt = grantedAt;
    this.#reason = reason;
  }

  get volume() {
    return this.#volume;
  }

  get state() {
    return this.#state;
  }

  get status() {
    return STATUS_BY_STATE[this.#state];
  }

  get isWriter() {
    return this.#state === LEASE_STATES.held;
  }

  get reason() {
    return this.#reason;
  }

  get requestedAt() {
    return this.#requestedAt;
  }

  get grantedAt() {
    return this.#grantedAt;
  }

  /** Millisecondes restantes avant expiration en attente ; `null` hors attente. */
  remainingMs() {
    if (this.#state !== LEASE_STATES.waiting || this.#deadlineAt === null) return null;
    return Math.max(0, this.#deadlineAt - this.#now());
  }

  /** Vrai si le délai de relais-ou-refus est atteint. Faux hors attente. */
  isOverdue() {
    if (this.#state !== LEASE_STATES.waiting || this.#deadlineAt === null) return false;
    return this.#now() >= this.#deadlineAt;
  }

  #with(patch) {
    return new WriteLease({
      volume: this.#volume,
      now: this.#now,
      deadlineMs: this.#deadlineMs,
      state: this.#state,
      requestedAt: this.#requestedAt,
      deadlineAt: this.#deadlineAt,
      grantedAt: this.#grantedAt,
      reason: this.#reason,
      ...patch,
    });
  }

  /** Avance selon la table, ou lève l'erreur typée. Le cœur du contrat. */
  #advance(event, patch = {}) {
    const target = LEASE_TRANSITIONS[this.#state]?.[event];
    if (target === undefined) throw new LeaseTransitionError(this.#state, event);
    return this.#with({ state: target, ...patch });
  }

  /** libre → attente. Fixe l'instant de la demande et l'échéance de relais-ou-refus. */
  request() {
    const requestedAt = this.#now();
    return this.#advance("request", {
      requestedAt,
      deadlineAt: requestedAt + this.#deadlineMs,
      reason: null,
    });
  }

  /** attente → détenu. Le transport a le verrou ET le handle : ce contexte est l'écrivain. */
  grant() {
    return this.#advance("grant", { grantedAt: this.#now() });
  }

  /** attente → refus explicite (un autre détient déjà, ou refus du transport). */
  deny(reason = "refus") {
    return this.#advance("deny", { reason });
  }

  /** attente → refus par expiration. Refusée tant que l'échéance n'est pas atteinte. */
  expire() {
    if (!this.isOverdue()) {
      throw new LeaseTransitionError(
        this.#state,
        "expire",
        "Expiration prématurée : l'échéance de relais-ou-refus n'est pas atteinte.",
      );
    }
    return this.#advance("expire", { reason: "delai-depasse" });
  }

  /** attente → libre : le contexte renonce de lui-même à la demande. */
  abandon() {
    return this.#advance("abandon", { reason: null, deadlineAt: null });
  }

  /** détenu → relais : le détenteur commence à rendre la main (fermeture du handle). */
  release() {
    return this.#advance("release");
  }

  /** relais → libre : le handle est effectivement fermé, le verrou peut passer au suivant. */
  settle() {
    return this.#advance("settle", { grantedAt: null });
  }

  /** détenu → perdu : le support ou le contexte a disparu sans fermeture propre. */
  lose(reason = "bail-perdu") {
    return this.#advance("lose", { reason });
  }

  /** refus|perdu → libre : repart d'un état propre. */
  reset() {
    return this.#advance("reset", { reason: null, requestedAt: null, deadlineAt: null });
  }

  /** refus|perdu → attente : redemande immédiatement, avec une nouvelle échéance. */
  retry() {
    const requestedAt = this.#now();
    return this.#advance("retry", {
      requestedAt,
      deadlineAt: requestedAt + this.#deadlineMs,
      reason: null,
    });
  }

  /** Forme sérialisable, franchissable par `postMessage`. Ne porte aucune donnée utilisateur. */
  toJSON() {
    return {
      volume: this.#volume,
      state: this.#state,
      status: this.status,
      reason: this.#reason,
      requestedAt: this.#requestedAt,
      grantedAt: this.#grantedAt,
    };
  }
}

/**
 * Garde d'invariant : au plus un bail détenu dans une collection. C'est la propriété centrale de
 * #8, vérifiée aussi bien par l'arbitre modèle que par le banc navigateur.
 * @param {Iterable<WriteLease>} leases
 */
export function assertAtMostOneWriter(leases) {
  const holders = [...leases].filter((bail) => bail.isWriter);
  if (holders.length > 1) {
    throw new LeaseTransitionError(
      LEASE_STATES.held,
      "grant",
      `Invariant rompu : ${holders.length} écrivains simultanés sur « ${holders[0].volume} ».`,
    );
  }
}
