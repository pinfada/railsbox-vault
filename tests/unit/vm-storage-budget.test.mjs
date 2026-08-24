import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_DIAGNOSTIC_CODES,
  BUDGET_SEVERITY,
  BudgetDiagnostic,
  RECOVERY_ACTIONS,
  RECOVERY_TEXT,
  bindNavigatorStorage,
  createStorageBudget,
  isBudgetDiagnostic,
} from "../../src/vm/storage-budget.mjs";
import { describeDiagnostic } from "../../src/vm/storage-budget-messages.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "../../src/vm/storage-errors.mjs";

// Preuve unitaire de la couche budget de stockage (#9, `VAULT-PERSIST-001`). Elle transforme
// estimation, persistance, espace insuffisant et quota dépassé en DIAGNOSTICS STABLES, chacun porteur
// d'un code, d'une opération et d'une action de récupération sûre — jamais une suppression, jamais une
// promesse de durabilité, jamais le contenu de l'utilisateur.
//
// Tout est piloté par des DOUBLES DÉTERMINISTES d'estimate/persist/persisted et par des erreurs
// typées de #6. Aucune de ces branches n'a besoin d'un vrai navigateur : le niveau navigateur
// (`tests/browser/storage-budget.spec.mjs`) rejoue seulement les branches réellement atteignables sur
// le vrai `navigator.storage`.

const MO = 1024 * 1024;

/** Double d'estimation qui rend exactement ce qu'on lui fixe. */
function fixerEstimation(valeur) {
  return async () => valeur;
}

/** Double d'estimation qui échoue comme un moteur qui n'expose rien d'exploitable. */
function estimationEnPanne(erreur) {
  return async () => {
    throw erreur;
  };
}

// --- Scénario : estimation disponible -------------------------------------------------------------

test("measure rapporte un état connu quand estimate() rend des octets numériques", async () => {
  const budget = createStorageBudget({
    estimate: fixerEstimation({ quota: 100 * MO, usage: 30 * MO }),
  });

  const mesure = await budget.measure();

  assert.equal(mesure.state, "known");
  assert.equal(mesure.quota, 100 * MO);
  assert.equal(mesure.usage, 30 * MO);
  assert.equal(mesure.available, 70 * MO);
  assert.equal(mesure.diagnostic, null);
});

test("measure traite un usage absent comme zéro, jamais comme une capacité nulle", async () => {
  const budget = createStorageBudget({ estimate: fixerEstimation({ quota: 50 * MO }) });

  const mesure = await budget.measure();

  assert.equal(mesure.state, "known");
  assert.equal(mesure.usage, 0);
  assert.equal(mesure.available, 50 * MO);
});

// --- Scénario : estimation indisponible → unknown, PAS zéro ---------------------------------------

test("measure passe en unknown quand estimate() échoue, sans prétendre zéro capacité", async () => {
  const budget = createStorageBudget({
    estimate: estimationEnPanne(new Error("indisponible")),
  });

  const mesure = await budget.measure();

  assert.equal(mesure.state, "unknown");
  assert.equal(mesure.quota, null);
  assert.equal(mesure.available, null); // surtout PAS 0 : une capacité inconnue n'est pas une absence
  assert.ok(isBudgetDiagnostic(mesure.diagnostic, BUDGET_DIAGNOSTIC_CODES.estimateUnavailable));
  assert.equal(mesure.diagnostic.severity, BUDGET_SEVERITY.warning);
});

test("measure passe en unknown quand estimate() rend un quota non numérique", async () => {
  const budget = createStorageBudget({ estimate: fixerEstimation({ quota: undefined }) });

  const mesure = await budget.measure();

  assert.equal(mesure.state, "unknown");
  assert.equal(mesure.available, null);
});

test("measure passe en unknown quand estimate n'est pas exposé", async () => {
  const budget = createStorageBudget({ estimate: undefined });

  const mesure = await budget.measure();

  assert.equal(mesure.state, "unknown");
  assert.ok(isBudgetDiagnostic(mesure.diagnostic, BUDGET_DIAGNOSTIC_CODES.estimateUnavailable));
});

// --- Scénario : refus de persist() → jamais une promesse de durabilité ----------------------------

test("requestPersistence qualifie un refus sans jamais promettre la durabilité", async () => {
  const budget = createStorageBudget({
    persisted: async () => false,
    persist: async () => false,
  });

  const issue = await budget.requestPersistence();

  assert.equal(issue.state, "denied");
  assert.equal(issue.durable, false); // invariant central : refus ⇒ jamais durable
  assert.ok(isBudgetDiagnostic(issue.diagnostic, BUDGET_DIAGNOSTIC_CODES.persistDenied));
  assert.equal(issue.diagnostic.operation, "persist");
});

test("requestPersistence traite un persist() qui lève comme un refus typé, non durable", async () => {
  const budget = createStorageBudget({
    persisted: async () => false,
    persist: async () => {
      throw new Error("refusé par le moteur");
    },
  });

  const issue = await budget.requestPersistence();

  assert.equal(issue.state, "denied");
  assert.equal(issue.durable, false);
  assert.ok(isBudgetDiagnostic(issue.diagnostic, BUDGET_DIAGNOSTIC_CODES.persistDenied));
});

test("requestPersistence accorde la durabilité quand persist() la renvoie", async () => {
  const budget = createStorageBudget({
    persisted: async () => false,
    persist: async () => true,
  });

  const issue = await budget.requestPersistence();

  assert.equal(issue.state, "granted");
  assert.equal(issue.durable, true);
  assert.equal(issue.diagnostic, null);
});

test("requestPersistence reconnaît un stockage déjà persistant sans redemander", async () => {
  let persistAppele = false;
  const budget = createStorageBudget({
    persisted: async () => true,
    persist: async () => {
      persistAppele = true;
      return true;
    },
  });

  const issue = await budget.requestPersistence();

  assert.equal(issue.state, "already");
  assert.equal(issue.durable, true);
  assert.equal(persistAppele, false);
});

test("requestPersistence signale l'absence de l'API sans inventer de durabilité", async () => {
  const budget = createStorageBudget({ persist: undefined, persisted: undefined });

  const issue = await budget.requestPersistence();

  assert.equal(issue.state, "unsupported");
  assert.equal(issue.durable, false);
  assert.ok(isBudgetDiagnostic(issue.diagnostic, BUDGET_DIAGNOSTIC_CODES.persistUnsupported));
});

// --- Scénario : espace estimé < besoin → avertissement AVANT mutation ------------------------------

test("reserve avertit quand l'espace disponible est inférieur au besoin", async () => {
  const budget = createStorageBudget({
    estimate: fixerEstimation({ quota: 100 * MO, usage: 95 * MO }),
  });

  const verdict = await budget.reserve(20 * MO);

  assert.equal(verdict.sufficient, false);
  assert.equal(verdict.available, 5 * MO);
  assert.equal(verdict.requiredBytes, 20 * MO);
  assert.ok(isBudgetDiagnostic(verdict.diagnostic, BUDGET_DIAGNOSTIC_CODES.spaceLow));
  assert.equal(verdict.diagnostic.severity, BUDGET_SEVERITY.warning);
  assert.equal(verdict.diagnostic.operation, "reserve");
});

test("reserve accepte quand l'espace disponible couvre le besoin", async () => {
  const budget = createStorageBudget({
    estimate: fixerEstimation({ quota: 100 * MO, usage: 10 * MO }),
  });

  const verdict = await budget.reserve(20 * MO);

  assert.equal(verdict.sufficient, true);
  assert.equal(verdict.diagnostic, null);
});

test("reserve rend un verdict indéterminé, pas insuffisant, quand l'estimation est inconnue", async () => {
  const budget = createStorageBudget({ estimate: estimationEnPanne(new Error("indisponible")) });

  const verdict = await budget.reserve(20 * MO);

  assert.equal(verdict.state, "unknown");
  assert.equal(verdict.sufficient, null); // surtout PAS false : inconnu n'est pas insuffisant
  assert.ok(isBudgetDiagnostic(verdict.diagnostic, BUDGET_DIAGNOSTIC_CODES.estimateUnavailable));
});

test("reserve rejette un besoin non numérique à la frontière", async () => {
  const budget = createStorageBudget({ estimate: fixerEstimation({ quota: MO }) });

  await assert.rejects(() => budget.reserve(-1), /besoin/i);
  await assert.rejects(() => budget.reserve(Number.NaN), /besoin/i);
});

// --- Scénario : quota dépassé pendant write/flush → échec typé, volume préservé --------------------

test("classifyWriteFailure transforme un quota #6 en diagnostic sans réinitialiser le volume", () => {
  const erreur = new StorageError(
    STORAGE_ERROR_CODES.quotaExceeded,
    "Le support OPFS a refusé l'opération : QuotaExceededError",
    { operation: "write", volume: "vault" },
  );

  const diagnostic = budgetPourClassement().classifyWriteFailure(erreur, { operation: "flush" });

  assert.ok(isBudgetDiagnostic(diagnostic, BUDGET_DIAGNOSTIC_CODES.quotaExceeded));
  assert.equal(diagnostic.severity, BUDGET_SEVERITY.error);
  assert.equal(diagnostic.operation, "flush");
  assert.equal(diagnostic.context.volumeReset, false);
  assert.equal(diagnostic.context.priorDataReadable, true);
  assert.equal(diagnostic.context.cause, STORAGE_ERROR_CODES.quotaExceeded);
});

test("classifyWriteFailure reconnaît un QuotaExceededError brut du support", () => {
  const brut = Object.assign(new Error("quota"), { name: "QuotaExceededError" });

  const diagnostic = budgetPourClassement().classifyWriteFailure(brut, { operation: "write" });

  assert.ok(isBudgetDiagnostic(diagnostic, BUDGET_DIAGNOSTIC_CODES.quotaExceeded));
});

test("classifyWriteFailure laisse les autres échecs typés à la couche #6", () => {
  const autre = new StorageError(STORAGE_ERROR_CODES.handleLost, "handle perdu");

  const diagnostic = budgetPourClassement().classifyWriteFailure(autre, { operation: "write" });

  assert.equal(diagnostic, null); // #9 ne réétiquette pas les états de #6 qu'il ne possède pas
});

test("classifyWriteFailure n'expose jamais le message brut du support", () => {
  const erreur = new StorageError(
    STORAGE_ERROR_CODES.quotaExceeded,
    "octets sensibles CONTENU-SECRET-42 dans le tampon",
    { operation: "write", volume: "vault" },
  );

  const diagnostic = budgetPourClassement().classifyWriteFailure(erreur, { operation: "write" });

  const serialise = JSON.stringify(diagnostic.toJSON());
  assert.equal(serialise.includes("CONTENU-SECRET-42"), false);
  assert.equal(diagnostic.message.includes("CONTENU-SECRET-42"), false);
});

function budgetPourClassement() {
  return createStorageBudget({ estimate: fixerEstimation({ quota: MO }) });
}

// --- Modèle de diagnostic : code + opération + action, aucune suppression --------------------------

test("chaque action de récupération publiée exclut toute suppression de données", () => {
  for (const [nom, texte] of Object.entries(RECOVERY_TEXT)) {
    assert.equal(
      /supprim|efface|purg|delete|réinitialis/i.test(texte),
      false,
      `l'action « ${nom} » ne doit jamais proposer d'effacer des données : ${texte}`,
    );
  }
  // Aucune action nommée ne doit ressembler à une suppression.
  for (const action of Object.values(RECOVERY_ACTIONS)) {
    assert.equal(/DELETE|PURGE|ERASE|RESET/.test(action), false);
  }
});

test("un diagnostic porte toujours code stable, opération et action connue", () => {
  const diagnostic = new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.spaceLow, {
    operation: "reserve",
    severity: BUDGET_SEVERITY.warning,
    message: "Espace estimé insuffisant.",
    recovery: RECOVERY_ACTIONS.exportThenDecide,
    context: { available: 1, requiredBytes: 2 },
  });

  assert.ok(Object.values(BUDGET_DIAGNOSTIC_CODES).includes(diagnostic.code));
  assert.equal(typeof diagnostic.operation, "string");
  assert.ok(Object.values(RECOVERY_ACTIONS).includes(diagnostic.recovery));
  assert.equal(typeof diagnostic.recoveryText, "string");
  assert.ok(diagnostic.recoveryText.length > 0);
});

test("BudgetDiagnostic refuse un code inconnu", () => {
  assert.throws(
    () => new BudgetDiagnostic("VAULT_BUDGET_INVENTÉ", { operation: "x" }),
    /inconnu/i,
  );
});

test("BudgetDiagnostic gèle son contexte et se sérialise pour postMessage", () => {
  const diagnostic = new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.persistDenied, {
    operation: "persist",
    severity: BUDGET_SEVERITY.warning,
    message: "Persistance refusée.",
    recovery: RECOVERY_ACTIONS.proceedVolatile,
    context: { permission: "prompt" },
  });

  assert.throws(() => {
    diagnostic.context.permission = "granted";
  });
  const json = diagnostic.toJSON();
  assert.equal(json.code, BUDGET_DIAGNOSTIC_CODES.persistDenied);
  assert.equal(json.recovery, RECOVERY_ACTIONS.proceedVolatile);
  assert.equal(json.operation, "persist");
});

// --- Messages UI accessibles ----------------------------------------------------------------------

test("describeDiagnostic mappe une erreur sur role=alert et un avertissement sur role=status", () => {
  const erreur = new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.quotaExceeded, {
    operation: "flush",
    severity: BUDGET_SEVERITY.error,
    message: "Quota dépassé.",
    recovery: RECOVERY_ACTIONS.freeSpaceManually,
    context: { volumeReset: false },
  });
  const avertissement = new BudgetDiagnostic(BUDGET_DIAGNOSTIC_CODES.spaceLow, {
    operation: "reserve",
    severity: BUDGET_SEVERITY.warning,
    message: "Espace faible.",
    recovery: RECOVERY_ACTIONS.exportThenDecide,
    context: {},
  });

  const vueErreur = describeDiagnostic(erreur);
  const vueAvertissement = describeDiagnostic(avertissement);

  assert.equal(vueErreur.role, "alert");
  assert.equal(vueAvertissement.role, "status");
  assert.equal(vueErreur.code, BUDGET_DIAGNOSTIC_CODES.quotaExceeded);
  assert.ok(vueErreur.text.includes("Quota dépassé."));
  // Le texte accessible porte l'action de récupération, jamais le contenu.
  assert.ok(vueErreur.text.length > "Quota dépassé.".length);
});

// --- Liaison au navigateur (branches d'absence) ---------------------------------------------------

test("bindNavigatorStorage n'expose que les membres réellement présents", () => {
  const primitives = bindNavigatorStorage({
    estimate: async () => ({ quota: 1 }),
    // persist et persisted absents : un moteur partiel
  });

  assert.equal(typeof primitives.estimate, "function");
  assert.equal(primitives.persist, undefined);
  assert.equal(primitives.persisted, undefined);
});

test("bindNavigatorStorage tolère un gestionnaire de stockage absent", () => {
  const primitives = bindNavigatorStorage(undefined);

  assert.equal(primitives.estimate, undefined);
  assert.equal(primitives.persist, undefined);
  assert.equal(primitives.persisted, undefined);
});
