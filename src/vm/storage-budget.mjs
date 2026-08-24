// Couche de budget de stockage (#9, `VAULT-PERSIST-001`). Elle estime l'espace disponible, demande la
// persistance quand elle existe, et transforme refus de persistance, espace insuffisant, quota dépassé
// et estimation indisponible en DIAGNOSTICS STABLES.
//
// Trois invariants la gouvernent, hérités du brief et des dépendances #2/#6 :
//
//  - un refus de `navigator.storage.persist()` n'est jamais une erreur et jamais une promesse de
//    durabilité : c'est un état qualifié où l'appelant choisit de poursuivre en volatile ou de
//    s'arrêter (la conduite produit revient à #42, pas à cette couche) ;
//  - une estimation indisponible est l'état `unknown`, PAS une capacité nulle : traiter l'inconnu
//    comme zéro bloquerait à tort une coquille parfaitement saine ;
//  - aucune procédure de récupération ne propose d'effacer des données. Elle informe et laisse
//    l'utilisateur ou la couche supérieure décider.
//
// Cette couche ne touche ni OPFS, ni le handle exclusif (#8) : elle mesure et diagnostique. Le quota
// dépassé pendant une écriture est déjà remonté par #6 comme `StorageError` typée, volume non
// réinitialisé ; `classifyWriteFailure` se contente de le qualifier pour l'exploitant sans jamais
// exposer le contenu.

import { STORAGE_ERROR_CODES, isStorageError } from "./storage-errors.mjs";

/** Codes de diagnostic stables, propres à la couche budget. Disjoints des codes de support de #6. */
export const BUDGET_DIAGNOSTIC_CODES = Object.freeze({
  /** `persist()` refusé : poursuite volatile ou arrêt, jamais une durabilité promise. */
  persistDenied: "VAULT_BUDGET_PERSIST_DENIED",
  /** `persist()`/`persisted()` absents du moteur : aucune durabilité inventée. */
  persistUnsupported: "VAULT_BUDGET_PERSIST_UNSUPPORTED",
  /** `estimate()` indisponible : état inconnu, jamais zéro capacité. */
  estimateUnavailable: "VAULT_BUDGET_ESTIMATE_UNAVAILABLE",
  /** Espace estimé inférieur au besoin, mesuré AVANT toute mutation. */
  spaceLow: "VAULT_BUDGET_SPACE_LOW",
  /** Quota dépassé pendant write/flush : échec typé, volume préservé. */
  quotaExceeded: "VAULT_BUDGET_QUOTA_EXCEEDED",
});

const KNOWN_CODES = new Set(Object.values(BUDGET_DIAGNOSTIC_CODES));

/** Sévérités : elles pilotent le rôle ARIA du message accessible (voir storage-budget-messages). */
export const BUDGET_SEVERITY = Object.freeze({
  info: "info",
  warning: "warning",
  error: "error",
});

/**
 * Actions de récupération SÛRES. Aucune ne supprime, n'efface ni ne réinitialise : le nom comme le
 * texte le garantissent, et un test de contrat l'exige.
 */
export const RECOVERY_ACTIONS = Object.freeze({
  informUser: "VAULT_RECOVERY_INFORM_USER",
  proceedVolatile: "VAULT_RECOVERY_PROCEED_VOLATILE",
  freeSpaceManually: "VAULT_RECOVERY_FREE_SPACE_MANUALLY",
  exportThenDecide: "VAULT_RECOVERY_EXPORT_THEN_DECIDE",
  retryLater: "VAULT_RECOVERY_RETRY_LATER",
});

/** Texte français d'accompagnement de chaque action. Jamais de contenu, jamais de suppression. */
export const RECOVERY_TEXT = Object.freeze({
  [RECOVERY_ACTIONS.informUser]:
    "Informer l'utilisateur de l'état du stockage et le laisser décider de la suite.",
  [RECOVERY_ACTIONS.proceedVolatile]:
    "Poursuivre sans garantie de durabilité, ou s'arrêter : le choix appartient à l'utilisateur.",
  [RECOVERY_ACTIONS.freeSpaceManually]:
    "Inviter l'utilisateur à libérer de l'espace côté navigateur avant de réessayer.",
  [RECOVERY_ACTIONS.exportThenDecide]:
    "Proposer un export avant toute décision, puis laisser l'utilisateur choisir la suite.",
  [RECOVERY_ACTIONS.retryLater]:
    "Réessayer l'opération plus tard, une fois l'espace ou la persistance résolus.",
});

/**
 * Diagnostic stable de la couche budget : un code, une opération, une sévérité, un message français,
 * une action de récupération sûre et un contexte sérialisable SANS donnée utilisateur.
 */
export class BudgetDiagnostic {
  /**
   * @param {string} code une valeur de `BUDGET_DIAGNOSTIC_CODES`
   * @param {object} détail
   * @param {string} détail.operation opération concernée (`estimate`, `persist`, `reserve`, `write`…)
   * @param {string} [détail.severity] une valeur de `BUDGET_SEVERITY`
   * @param {string} [détail.message] message destiné à l'exploitant, en français
   * @param {string} [détail.recovery] une valeur de `RECOVERY_ACTIONS`
   * @param {Record<string, unknown>} [détail.context] contexte structuré, sans contenu utilisateur
   */
  constructor(
    code,
    {
      operation,
      severity = BUDGET_SEVERITY.warning,
      message = "",
      recovery = RECOVERY_ACTIONS.informUser,
      context = {},
    } = {},
  ) {
    if (!KNOWN_CODES.has(code)) {
      throw new Error(`Code de diagnostic de budget inconnu : ${code}`);
    }
    if (typeof operation !== "string" || operation.length === 0) {
      throw new Error("Un diagnostic de budget doit nommer son opération.");
    }
    if (!RECOVERY_TEXT[recovery]) {
      throw new Error(`Action de récupération inconnue : ${recovery}`);
    }
    this.code = code;
    this.operation = operation;
    this.severity = severity;
    this.message = message;
    this.recovery = recovery;
    this.recoveryText = RECOVERY_TEXT[recovery];
    this.context = Object.freeze({ ...context });
    Object.freeze(this);
  }

  /** Forme transportable par `postMessage` : un diagnostic ne doit pas se perdre au passage du port. */
  toJSON() {
    return {
      code: this.code,
      operation: this.operation,
      severity: this.severity,
      message: this.message,
      recovery: this.recovery,
      recoveryText: this.recoveryText,
      context: this.context,
    };
  }
}

/** Vrai si `value` est un diagnostic de budget portant `code`. */
export function isBudgetDiagnostic(value, code) {
  return value instanceof BudgetDiagnostic && (code === undefined || value.code === code);
}

/** Un quota numérique fini et positif est exploitable ; toute autre valeur laisse l'état inconnu. */
function isNumericBytes(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function estimateUnavailableDiagnostic(operation) {
  return new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.estimateUnavailable, {
    operation,
    severity: BUDGET_SEVERITY.warning,
    message:
      "L'estimation du stockage est indisponible : capacité inconnue, et non nulle. Aucune décision de capacité ne peut être garantie.",
    recovery: RECOVERY_ACTIONS.informUser,
    context: { state: "unknown" },
  });
}

/**
 * Construit une couche budget au-dessus de primitives injectées. Sous Node, ce sont des doubles
 * déterministes ; en production, `bindNavigatorStorage(navigator.storage)`. Chaque primitive peut être
 * absente : la couche le traite en état diagnostiqué, jamais en exception opaque.
 *
 * @param {{ estimate?: () => Promise<StorageEstimate>, persist?: () => Promise<boolean>, persisted?: () => Promise<boolean> }} primitives
 */
export function createStorageBudget({ estimate, persist, persisted } = {}) {
  async function measure() {
    if (typeof estimate !== "function") {
      return unknownMeasure("estimate");
    }
    let raw;
    try {
      raw = await estimate();
    } catch {
      // Un moteur qui refuse d'estimer ne rend pas une capacité : il rend une inconnue.
      return unknownMeasure("estimate");
    }
    if (!isNumericBytes(raw?.quota)) {
      return unknownMeasure("estimate");
    }
    const quota = raw.quota;
    const usage = isNumericBytes(raw.usage) ? raw.usage : 0;
    const available = Math.max(0, quota - usage);
    return { operation: "estimate", state: "known", quota, usage, available, diagnostic: null };
  }

  function unknownMeasure(operation) {
    return {
      operation,
      state: "unknown",
      quota: null,
      usage: null,
      available: null,
      diagnostic: estimateUnavailableDiagnostic(operation),
    };
  }

  async function requestPersistence() {
    if (typeof persist !== "function" || typeof persisted !== "function") {
      return {
        operation: "persist",
        state: "unsupported",
        durable: false,
        diagnostic: new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.persistUnsupported, {
          operation: "persist",
          severity: BUDGET_SEVERITY.info,
          message:
            "La persistance de stockage n'est pas exposée par ce moteur : aucune durabilité ne peut être demandée ni promise.",
          recovery: RECOVERY_ACTIONS.informUser,
          context: { state: "unsupported" },
        }),
      };
    }

    if (await persisted()) {
      return { operation: "persist", state: "already", durable: true, diagnostic: null };
    }

    let granted;
    try {
      granted = (await persist()) === true;
    } catch {
      // Firefox laisse parfois la promesse pendante derrière une invite ; un rejet vaut refus.
      // Un refus n'est pas une erreur : c'est un état qualifié, non durable.
      granted = false;
    }

    if (granted) {
      return { operation: "persist", state: "granted", durable: true, diagnostic: null };
    }

    return {
      operation: "persist",
      state: "denied",
      durable: false,
      diagnostic: new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.persistDenied, {
        operation: "persist",
        severity: BUDGET_SEVERITY.warning,
        message:
          "La persistance a été refusée : les données peuvent être évincées par le navigateur. Poursuivre reste possible mais SANS garantie de durabilité.",
        recovery: RECOVERY_ACTIONS.proceedVolatile,
        context: { state: "denied", durable: false },
      }),
    };
  }

  async function reserve(requiredBytes) {
    if (!isNumericBytes(requiredBytes)) {
      throw new TypeError(
        `Le besoin de réservation doit être un nombre d'octets ≥ 0 : ${requiredBytes}`,
      );
    }
    const mesure = await measure();
    if (mesure.state === "unknown") {
      return {
        operation: "reserve",
        state: "unknown",
        requiredBytes,
        available: null,
        sufficient: null,
        diagnostic: estimateUnavailableDiagnostic("reserve"),
      };
    }
    if (mesure.available < requiredBytes) {
      return {
        operation: "reserve",
        state: "known",
        requiredBytes,
        available: mesure.available,
        sufficient: false,
        diagnostic: new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.spaceLow, {
          operation: "reserve",
          severity: BUDGET_SEVERITY.warning,
          message:
            "L'espace estimé est inférieur au besoin annoncé. L'avertissement précède toute mutation ; aucune écriture n'est tentée.",
          recovery: RECOVERY_ACTIONS.exportThenDecide,
          context: { available: mesure.available, requiredBytes },
        }),
      };
    }
    return {
      operation: "reserve",
      state: "known",
      requiredBytes,
      available: mesure.available,
      sufficient: true,
      diagnostic: null,
    };
  }

  function classifyWriteFailure(error, { operation = "write" } = {}) {
    if (typeof operation !== "string" || operation.length === 0) {
      throw new Error("classifyWriteFailure doit nommer son opération.");
    }
    const isQuota =
      isStorageError(error, STORAGE_ERROR_CODES.quotaExceeded) ||
      error?.code === STORAGE_ERROR_CODES.quotaExceeded ||
      error?.name === "QuotaExceededError";
    if (!isQuota) {
      // Les autres états typés appartiennent à #6 : #9 ne les réétiquette pas.
      return null;
    }
    return new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.quotaExceeded, {
      operation,
      severity: BUDGET_SEVERITY.error,
      message:
        "Le quota de stockage a été dépassé pendant l'opération. Le volume n'est PAS réinitialisé et les données antérieures valides restent lisibles.",
      recovery: RECOVERY_ACTIONS.freeSpaceManually,
      // Contexte volontairement réduit à des drapeaux et au code de cause : jamais le message brut,
      // jamais un octet de contenu.
      context: {
        volumeReset: false,
        priorDataReadable: true,
        cause: STORAGE_ERROR_CODES.quotaExceeded,
      },
    });
  }

  return { measure, requestPersistence, reserve, classifyWriteFailure };
}

/**
 * Extrait des primitives liées d'un `StorageManager` réel, en n'exposant QUE les membres présents.
 * Un moteur partiel (estimate sans persist, par exemple) produit des `undefined`, que la couche
 * traduit ensuite en états diagnostiqués — jamais en `TypeError` opaque à l'appel.
 *
 * @param {StorageManager | undefined} storageManager typiquement `navigator.storage`
 */
export function bindNavigatorStorage(storageManager) {
  const bind = (member) =>
    typeof storageManager?.[member] === "function"
      ? storageManager[member].bind(storageManager)
      : undefined;
  return {
    estimate: bind("estimate"),
    persist: bind("persist"),
    persisted: bind("persisted"),
  };
}
