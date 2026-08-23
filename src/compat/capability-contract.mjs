/**
 * Contrat du rapport de compatibilité : matrice des capacités, règle de verdict Vault et
 * validation de schéma. Ce module est pur — aucune API navigateur — afin d'être testé sous Node
 * et réutilisé aussi bien par la sonde que par la suite Playwright.
 */

export const CAPABILITY_PROBE_CONTRACT = Object.freeze({
  id: "railsbox-vault-capability-probe",
  version: 1,
});

export const CAPABILITY_VERDICTS = Object.freeze(["supported", "unsupported", "denied", "error"]);

/** Statuts de `docs/compatibility.md`. */
export const COMPATIBILITY_STATUSES = Object.freeze([
  "candidat",
  "mesuré",
  "supporté",
  "refusé",
  "expérimental",
]);

export const SUPPORTED_ENGINES = Object.freeze(["chromium", "firefox", "webkit"]);

function capability(id, context, required, label) {
  return Object.freeze({ id, context, required, label });
}

/**
 * Matrice des capacités sondées. `required` distingue « primitive disponible » de « parcours Vault
 * supporté » : seules les capacités obligatoires entrent dans le verdict Vault, les autres sont
 * mesurées pour information.
 */
export const CAPABILITIES = Object.freeze([
  capability("moduleDedicatedWorker", "page", true, "Worker dédié de type module"),
  capability("webCryptoAesGcm", "page", true, "WebCrypto AES-GCM sur vecteur connu"),
  capability("webCryptoHkdf", "page", true, "WebCrypto HKDF-SHA-256 sur vecteur RFC 5869"),
  capability("opfsGetDirectory", "page", true, "OPFS : navigator.storage.getDirectory()"),
  capability("storageEstimate", "page", true, "navigator.storage.estimate()"),
  capability("storagePersist", "page", false, "navigator.storage.persist() / persisted()"),
  capability("webAssembly", "page", true, "WebAssembly : instanciation d'un module minimal"),
  capability("sharedArrayBuffer", "page", false, "SharedArrayBuffer"),
  capability("crossOriginIsolated", "page", false, "Contexte isolé multi-origine"),
  capability("broadcastChannel", "page", true, "BroadcastChannel"),
  capability("webLocks", "page", true, "Web Locks (navigator.locks)"),
  capability("publicKeyCredential", "page", false, "PublicKeyCredential exposé"),
  capability(
    "platformAuthenticatorPresence",
    "page",
    false,
    "isUserVerifyingPlatformAuthenticatorAvailable exposé",
  ),
  capability("performanceMemory", "page", false, "performance.memory (spécifique Chromium)"),
  capability("workerWebCryptoAesGcm", "worker", true, "WebCrypto AES-GCM dans le Worker"),
  capability("opfsSyncAccessHandle", "worker", true, "FileSystemSyncAccessHandle dans le Worker"),
  capability("workerAtomicsWait", "worker", false, "Atomics.wait dans le Worker"),
]);

export const REQUIRED_CAPABILITY_IDS = Object.freeze(
  CAPABILITIES.filter((entry) => entry.required).map((entry) => entry.id),
);

export const VAULT_VERDICT_RULE = [
  "Le parcours Vault est « mesuré » seulement si toutes les capacités obligatoires valent",
  "« supported ». Une capacité obligatoire « unsupported » ou « denied » donne « refusé ».",
  "Une capacité obligatoire « error » ou absente du rapport donne « candidat » : la mesure n'est",
  "pas concluante. La sonde ne promeut jamais au statut « supporté », qui exige le scénario",
  "bout en bout du jalon 1.",
].join(" ");

/**
 * Calcule le verdict Vault à partir des verdicts de capacités.
 * Fonction pure : mêmes entrées, même sortie, aucun accès à l'environnement.
 */
export function computeVaultVerdict(capabilities) {
  const byId = new Map((capabilities ?? []).map((entry) => [entry?.id, entry]));
  const inconclusive = [];
  const refused = [];

  for (const id of REQUIRED_CAPABILITY_IDS) {
    const verdict = byId.get(id)?.verdict;
    if (verdict === "supported") continue;
    if (verdict === "unsupported" || verdict === "denied") {
      refused.push(id);
      continue;
    }
    inconclusive.push(id);
  }

  if (inconclusive.length > 0) {
    return {
      status: "candidat",
      supported: false,
      blocking: [...inconclusive, ...refused].sort(),
      rule: VAULT_VERDICT_RULE,
    };
  }
  if (refused.length > 0) {
    return {
      status: "refusé",
      supported: false,
      blocking: refused.sort(),
      rule: VAULT_VERDICT_RULE,
    };
  }
  return { status: "mesuré", supported: true, blocking: [], rule: VAULT_VERDICT_RULE };
}

/**
 * Complète le rapport produit dans la page avec les métadonnées de l'exécutant Playwright.
 * Le rapport renvoyé est une copie profonde et figée du rapport de sonde : le finaliser ne peut
 * pas altérer son entrée, et les blocs mesurés ne peuvent plus être réécrits après coup.
 */
export function finalizeCompatReport(probeReport, runner) {
  if (!SUPPORTED_ENGINES.includes(runner?.engine)) {
    throw new TypeError(`moteur inconnu : ${runner?.engine}`);
  }

  const verdict = probeReport.vaultVerdict;
  return {
    contract: Object.freeze({ ...probeReport.contract }),
    generatedAt: probeReport.generatedAt,
    agent: Object.freeze({ ...probeReport.agent }),
    runner: Object.freeze({ ...runner }),
    capabilities: Object.freeze(
      probeReport.capabilities.map((entry) => Object.freeze({ ...entry })),
    ),
    vaultVerdict: Object.freeze({ ...verdict, blocking: Object.freeze([...verdict.blocking]) }),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function collectCapabilityProblems(capabilities) {
  const problems = [];
  if (!Array.isArray(capabilities)) {
    return ["Le champ `capabilities` n'est pas un tableau."];
  }

  const declared = new Map(CAPABILITIES.map((entry) => [entry.id, entry]));
  const seen = new Set();

  for (const entry of capabilities) {
    const expected = declared.get(entry?.id);
    if (!expected) {
      problems.push(`Capacité inconnue dans le rapport : ${entry?.id}.`);
      continue;
    }
    if (seen.has(entry.id)) {
      problems.push(`Capacité en double dans le rapport : ${entry.id}.`);
      continue;
    }
    seen.add(entry.id);

    if (entry.context !== expected.context) {
      problems.push(`Contexte incorrect pour ${entry.id} : ${entry.context}.`);
    }
    if (!CAPABILITY_VERDICTS.includes(entry.verdict)) {
      problems.push(`Verdict invalide pour ${entry.id} : ${entry.verdict}.`);
    }
    if (!isNonEmptyString(entry.detail)) {
      problems.push(`Détail manquant pour ${entry.id}.`);
    }
  }

  for (const id of declared.keys()) {
    if (!seen.has(id)) problems.push(`Capacité manquante dans le rapport : ${id}.`);
  }
  return problems;
}

function collectRunnerProblems(runner) {
  if (!runner || typeof runner !== "object") {
    return ["Bloc exécutant absent du rapport."];
  }
  const problems = [];
  if (!SUPPORTED_ENGINES.includes(runner.engine)) {
    problems.push(`Bloc exécutant : moteur inconnu ${runner.engine}.`);
  }
  for (const field of ["engineVersion", "playwrightVersion", "os", "osRelease", "node"]) {
    if (!isNonEmptyString(runner[field])) {
      problems.push(`Bloc exécutant : champ ${field} manquant.`);
    }
  }
  if (!isIsoDate(runner.recordedAt)) {
    problems.push("Bloc exécutant : horodatage `recordedAt` inexploitable.");
  }
  return problems;
}

/** Valide le schéma d'un rapport finalisé et la cohérence de son verdict Vault. */
export function validateCompatReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { valid: false, problems: ["Le rapport n'est pas un objet."] };
  }

  const problems = [];
  if (
    report.contract?.id !== CAPABILITY_PROBE_CONTRACT.id ||
    report.contract?.version !== CAPABILITY_PROBE_CONTRACT.version
  ) {
    problems.push("Contrat de sonde inattendu.");
  }
  if (!isIsoDate(report.generatedAt)) {
    problems.push("Horodatage `generatedAt` inexploitable.");
  }
  if (!isNonEmptyString(report.agent?.userAgent)) {
    problems.push("Agent : `userAgent` manquant.");
  }
  if (typeof report.agent?.crossOriginIsolated !== "boolean") {
    problems.push("Agent : `crossOriginIsolated` doit être un booléen.");
  }

  problems.push(...collectCapabilityProblems(report.capabilities));
  problems.push(...collectRunnerProblems(report.runner));

  const expectedVerdict = computeVaultVerdict(report.capabilities ?? []);
  if (JSON.stringify(report.vaultVerdict) !== JSON.stringify(expectedVerdict)) {
    problems.push(
      `Verdict Vault incohérent avec les capacités mesurées : attendu ${expectedVerdict.status}.`,
    );
  }

  return { valid: problems.length === 0, problems };
}
