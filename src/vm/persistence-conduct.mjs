// Couche de CONDUITE sur la persistance de stockage (#42, `VAULT-PERSIST-001`). Elle se pose
// AU-DESSUS du diagnostic de budget (#9) : #9 détecte et qualifie un verdict de `persist()` ; #42
// décide de la CONDUITE PRODUIT — quand demander la persistance, ce que la coquille affiche, et
// quelle promesse de durabilité elle fait.
//
// Trois faits établis la gouvernent :
//
//  - #2 a mesuré que `navigator.storage.persist()` est REFUSÉ sans geste utilisateur (verdict
//    `denied`, jamais `error`) sur Chromium et Firefox, ce dernier laissant la promesse PENDANTE
//    derrière une invite. La demande n'est donc légitime que derrière un geste explicite ;
//  - l'ADR 0002 confie à la coquille de confiance le recueil du consentement utilisateur ;
//  - `SECURITY.md` et `docs/quality-attributes.md` interdisent d'annoncer une durabilité non tenue :
//    « aucun succès silencieux », jamais de promesse fausse.
//
// L'invariant central, éprouvé exhaustivement par les tests : une durabilité GARANTIE n'existe QUE
// derrière une persistance réellement accordée. Un refus, une attente pendante ou une absence d'API
// ne produisent jamais « durable ». La promesse de durabilité est une valeur à TROIS états, jamais un
// booléen — un booléen ne saurait distinguer « non garanti » (refus) de « inconnu » (attente).
//
// Cette couche est PURE : elle ne touche ni au DOM, ni à `navigator.storage`, ni à OPFS. Elle prend un
// verdict déjà obtenu (le résultat de `requestPersistence()` de #9, ou son état nu) et rend un objet
// de conduite immuable. Le rendu accessible vit dans `persistence-conduct-messages.mjs`.

import {
  BUDGET_DIAGNOSTIC_CODES,
  BudgetDiagnostic,
  BUDGET_SEVERITY,
  RECOVERY_ACTIONS,
  isBudgetDiagnostic,
} from "./storage-budget.mjs";

/**
 * États de persistance acceptés en entrée. Ils normalisent le `state` rendu par `requestPersistence()`
 * de #9 (`already`, `granted`, `denied`, `unsupported`) et ajoutent `pending` — l'attente pendante que
 * #2 a mesurée sous Firefox, qu'un appelant détecte en opposant `persist()` à un délai plutôt qu'en
 * l'attendant indéfiniment.
 */
export const PERSISTENCE_VERDICTS = Object.freeze({
  /** `persisted()` vrai : le stockage était déjà durable, sans nouvelle demande. */
  alreadyPersistent: "already",
  /** `persist()` a rendu `true` : persistance accordée. */
  granted: "granted",
  /** `persist()` a rendu `false` (ou a été rejeté) : persistance refusée. */
  denied: "denied",
  /** `persist()` n'a pas encore été tranché par le navigateur (invite en attente, Firefox). */
  pending: "pending",
  /** `persist()`/`persisted()` absents du moteur : aucune durabilité n'est exposable. */
  unsupported: "unsupported",
});

const KNOWN_VERDICTS = new Set(Object.values(PERSISTENCE_VERDICTS));

/** Verdicts où la persistance est RÉELLEMENT accordée : la seule porte vers une durabilité garantie. */
const GRANTED_VERDICTS = new Set([
  PERSISTENCE_VERDICTS.granted,
  PERSISTENCE_VERDICTS.alreadyPersistent,
]);

/**
 * États de coquille. Ce sont les stances explicites que la coquille peut afficher — jamais un booléen
 * « durable oui/non ». Au moins trois portent une promesse de durabilité (durable-garanti,
 * poursuite-volatile-qualifiée, arrêt) ; deux encadrent le cycle de la demande (consentement requis,
 * attente de résolution).
 */
export const SHELL_STATES = Object.freeze({
  /** Aucune demande légitime encore possible : un geste utilisateur doit d'abord la déclencher. */
  consentRequired: "CONSENTEMENT_REQUIS",
  /** Persistance accordée : le stockage est durable et ne sera pas évincé sans action utilisateur. */
  durableGuaranteed: "DURABLE_GARANTI",
  /** Attente pendante (Firefox) : décision haltée, aucune promesse tant que l'invite n'a pas répondu. */
  awaitingResolution: "ATTENTE_RESOLUTION",
  /** Refus/indisponible + poursuite : l'utilisateur avance SANS garantie, explicitement qualifiée. */
  qualifiedVolatile: "POURSUITE_VOLATILE_QUALIFIEE",
  /** Refus/indisponible + arrêt : l'utilisateur s'arrête plutôt que d'écrire sans garantie. */
  halted: "ARRET",
});

/**
 * Promesse de durabilité à TROIS valeurs. Un booléen confondrait « non garanti » (le moteur a
 * répondu : pas de durabilité) et « inconnu » (le moteur n'a pas encore répondu) — deux situations
 * qui appellent des conduites différentes.
 */
export const DURABILITY_PROMISE = Object.freeze({
  /** Durabilité tenue : persistance accordée. */
  guaranteed: "GARANTIE",
  /** Durabilité NON tenue : refus ou absence d'API, la donnée peut être évincée. */
  notGuaranteed: "NON_GARANTIE",
  /** Durabilité indéterminée : demande non tranchée, ou pas encore émise. */
  unknown: "INCONNUE",
});

/** Choix de l'utilisateur face à une durabilité non garantie. */
export const USER_STANCE = Object.freeze({
  proceed: "proceed",
  stop: "stop",
});

/**
 * Actions de conduite SÛRES offertes à la coquille. Aucune ne supprime, n'efface ni ne réinitialise —
 * le nom comme le texte le garantissent, et un test de contrat l'exige. `proceedVolatile` réutilise
 * l'action de récupération de #9.
 */
export const CONDUCT_ACTIONS = Object.freeze({
  requestBehindGesture: "VAULT_CONDUCT_REQUEST_BEHIND_GESTURE",
  proceedVolatile: RECOVERY_ACTIONS.proceedVolatile,
  stop: "VAULT_CONDUCT_STOP",
  awaitPromptResolution: "VAULT_CONDUCT_AWAIT_PROMPT",
});

/** Texte français d'accompagnement de chaque action. Jamais de suppression, jamais de contenu. */
export const CONDUCT_ACTION_TEXT = Object.freeze({
  [CONDUCT_ACTIONS.requestBehindGesture]:
    "Demander la persistance à la suite d'un geste explicite de l'utilisateur, jamais au chargement.",
  [CONDUCT_ACTIONS.proceedVolatile]:
    "Poursuivre sans garantie de durabilité, l'état volatile étant affiché sans ambiguïté.",
  [CONDUCT_ACTIONS.stop]:
    "S'arrêter plutôt que d'écrire sans garantie de durabilité : le choix appartient à l'utilisateur.",
  [CONDUCT_ACTIONS.awaitPromptResolution]:
    "Attendre que le navigateur tranche l'invite de persistance avant toute décision.",
});

/** Sévérité de chaque état, réutilisant le vocabulaire de #9 pour le rendu accessible. */
const SEVERITY_BY_STATE = Object.freeze({
  [SHELL_STATES.consentRequired]: BUDGET_SEVERITY.info,
  [SHELL_STATES.durableGuaranteed]: BUDGET_SEVERITY.info,
  [SHELL_STATES.awaitingResolution]: BUDGET_SEVERITY.warning,
  [SHELL_STATES.qualifiedVolatile]: BUDGET_SEVERITY.warning,
  [SHELL_STATES.halted]: BUDGET_SEVERITY.warning,
});

/** Promesse de durabilité de chaque état. */
const DURABILITY_BY_STATE = Object.freeze({
  [SHELL_STATES.consentRequired]: DURABILITY_PROMISE.unknown,
  [SHELL_STATES.durableGuaranteed]: DURABILITY_PROMISE.guaranteed,
  [SHELL_STATES.awaitingResolution]: DURABILITY_PROMISE.unknown,
  [SHELL_STATES.qualifiedVolatile]: DURABILITY_PROMISE.notGuaranteed,
  [SHELL_STATES.halted]: DURABILITY_PROMISE.notGuaranteed,
});

/** Actions offertes par état : ce que la coquille peut proposer ensuite, jamais une suppression. */
const BRANCHES_BY_STATE = Object.freeze({
  [SHELL_STATES.consentRequired]: Object.freeze([CONDUCT_ACTIONS.requestBehindGesture]),
  [SHELL_STATES.durableGuaranteed]: Object.freeze([]),
  [SHELL_STATES.awaitingResolution]: Object.freeze([CONDUCT_ACTIONS.awaitPromptResolution]),
  [SHELL_STATES.qualifiedVolatile]: Object.freeze([
    CONDUCT_ACTIONS.proceedVolatile,
    CONDUCT_ACTIONS.stop,
  ]),
  [SHELL_STATES.halted]: Object.freeze([CONDUCT_ACTIONS.requestBehindGesture]),
});

/**
 * Décide QUAND demander la persistance. La demande n'est légitime que derrière un geste utilisateur
 * explicite (#2, ADR 0002), et jamais si le stockage est déjà persistant.
 *
 * @param {{ userGesture?: boolean, alreadyPersistent?: boolean }} contexte
 * @returns {boolean}
 */
export function shouldRequestPersistence({ userGesture = false, alreadyPersistent = false } = {}) {
  if (alreadyPersistent === true) {
    return false;
  }
  return userGesture === true;
}

/**
 * Normalise l'entrée `verdict` en un état connu et récupère le diagnostic #9 s'il est transporté.
 * Accepte `null`/`undefined` (aucune demande émise), un état nu (`"denied"`) ou l'objet rendu par
 * `requestPersistence()` de #9 (`{ state, durable, diagnostic }`).
 *
 * @param {null | undefined | string | { state?: string, diagnostic?: unknown }} verdict
 * @returns {{ state: string | null, diagnostic: import("./storage-budget.mjs").BudgetDiagnostic | null }}
 */
function normalizeVerdict(verdict) {
  if (verdict === null || verdict === undefined) {
    return { state: null, diagnostic: null };
  }
  if (typeof verdict === "string") {
    if (!KNOWN_VERDICTS.has(verdict)) {
      throw new Error(`Verdict de persistance inconnu : ${verdict}`);
    }
    return { state: verdict, diagnostic: null };
  }
  if (typeof verdict === "object" && typeof verdict.state === "string") {
    if (!KNOWN_VERDICTS.has(verdict.state)) {
      throw new Error(`Verdict de persistance inconnu : ${verdict.state}`);
    }
    const diagnostic = isBudgetDiagnostic(verdict.diagnostic) ? verdict.diagnostic : null;
    return { state: verdict.state, diagnostic };
  }
  throw new Error("Un verdict de persistance doit être un état connu ou l'objet rendu par #9.");
}

/**
 * Choisit l'état de coquille à partir de l'état de verdict normalisé et du contexte. Fonction totale :
 * chaque état de verdict connu (et l'absence de verdict) a une image explicite.
 */
function chooseShellState(state, userGesture, stance) {
  if (state === null) {
    // Aucune demande émise : au chargement, seule la lecture de `persisted()` peut établir un état
    // durable. Faute de verdict, la coquille doit d'abord recueillir un consentement — le geste ne
    // fait qu'autoriser la demande à venir, il ne fabrique aucune durabilité.
    return SHELL_STATES.consentRequired;
  }
  if (GRANTED_VERDICTS.has(state)) {
    return SHELL_STATES.durableGuaranteed;
  }
  if (state === PERSISTENCE_VERDICTS.pending) {
    // L'attente n'est pas tranchée : ni durable, ni « volatile confirmé ». Halte jusqu'à la réponse,
    // même si l'utilisateur a exprimé « poursuivre » — l'invite peut encore accorder la persistance.
    return SHELL_STATES.awaitingResolution;
  }
  // Refus ou indisponible : durabilité non garantie. L'utilisateur poursuit en volatile qualifié, ou
  // s'arrête. Sans choix explicite, la coquille reste sur la poursuite qualifiée, qui affiche l'état
  // volatile sans ambiguïté et offre l'arrêt en alternative.
  void userGesture;
  return stance === USER_STANCE.stop ? SHELL_STATES.halted : SHELL_STATES.qualifiedVolatile;
}

/**
 * Construit le diagnostic accessible d'un état volatile qualifié quand le verdict n'en transporte pas
 * (état nu, ou indisponible sans objet #9). Réutilise les codes et le vocabulaire de #9, sans recopier
 * ses messages ailleurs qu'ici.
 */
function volatileDiagnostic(state) {
  if (state === PERSISTENCE_VERDICTS.unsupported) {
    return new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.persistUnsupported, {
      operation: "persist",
      severity: BUDGET_SEVERITY.info,
      message:
        "La persistance de stockage n'est pas exposée par ce moteur : aucune durabilité ne peut être demandée ni promise.",
      recovery: RECOVERY_ACTIONS.proceedVolatile,
      context: { state: "unsupported" },
    });
  }
  return new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.persistDenied, {
    operation: "persist",
    severity: BUDGET_SEVERITY.warning,
    message:
      "La persistance a été refusée : les données peuvent être évincées par le navigateur. Poursuivre reste possible mais SANS garantie de durabilité.",
    recovery: RECOVERY_ACTIONS.proceedVolatile,
    context: { state: "denied", durable: false },
  });
}

/**
 * Conduite produite : l'état de coquille, la promesse de durabilité à trois valeurs, le verdict
 * normalisé, le diagnostic #9 le cas échéant, les actions sûres offertes et la sévérité (pour le rendu
 * accessible). Objet gelé : aucune mutation après coup.
 */
export class ShellConduct {
  constructor({ shellState, durability, verdict, diagnostic, branches, severity }) {
    this.shellState = shellState;
    this.durability = durability;
    this.verdict = verdict;
    this.diagnostic = diagnostic;
    this.branches = Object.freeze([...branches]);
    this.severity = severity;
    Object.freeze(this);
  }
}

/**
 * Décide la conduite à tenir à partir d'un verdict de persistance et du contexte. Pure et totale.
 *
 * @param {object} entrée
 * @param {null | undefined | string | object} entrée.verdict état nu, objet #9, ou absence de demande
 * @param {boolean} [entrée.userGesture] un geste utilisateur explicite est-il présent ?
 * @param {string} [entrée.stance] choix `proceed`/`stop` face à une durabilité non garantie
 * @returns {ShellConduct}
 */
export function conductForPersistence({ verdict, userGesture = false, stance } = {}) {
  if (stance !== undefined && stance !== USER_STANCE.proceed && stance !== USER_STANCE.stop) {
    throw new Error(`Choix utilisateur inconnu : ${stance}`);
  }
  const { state, diagnostic: verdictDiagnostic } = normalizeVerdict(verdict);
  const shellState = chooseShellState(state, userGesture, stance);

  let diagnostic = null;
  if (shellState === SHELL_STATES.qualifiedVolatile) {
    diagnostic = verdictDiagnostic ?? volatileDiagnostic(state);
  }

  return new ShellConduct({
    shellState,
    durability: DURABILITY_BY_STATE[shellState],
    verdict: state,
    diagnostic,
    branches: BRANCHES_BY_STATE[shellState],
    severity: SEVERITY_BY_STATE[shellState],
  });
}

/** Vrai UNIQUEMENT si la conduite promet une durabilité garantie. Jamais un booléen exposé ailleurs. */
export function isDurableGuaranteed(conduct) {
  return conduct instanceof ShellConduct && conduct.durability === DURABILITY_PROMISE.guaranteed;
}
