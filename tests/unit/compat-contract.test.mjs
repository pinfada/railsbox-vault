import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITIES,
  CAPABILITY_PROBE_CONTRACT,
  CAPABILITY_VERDICTS,
  COMPATIBILITY_STATUSES,
  REQUIRED_CAPABILITY_IDS,
  computeVaultVerdict,
  finalizeCompatReport,
  validateCompatReport,
} from "../../src/compat/capability-contract.mjs";

const REFERENCE_FIXTURE = new URL("../fixtures/compat/reference-report.json", import.meta.url);

function capabilitiesWith(overrides = {}) {
  return CAPABILITIES.map((capability) => ({
    id: capability.id,
    context: capability.context,
    verdict: overrides[capability.id] ?? "supported",
    detail: "mesure synthétique",
  }));
}

function probeReportWith(overrides = {}) {
  const capabilities = capabilitiesWith(overrides);
  return {
    contract: { ...CAPABILITY_PROBE_CONTRACT },
    generatedAt: "2026-08-23T10:00:00.000Z",
    agent: {
      userAgent: "Agent de test",
      userAgentPlatform: "Windows",
      hardwareConcurrency: 8,
      crossOriginIsolated: true,
      isSecureContext: true,
    },
    capabilities,
    vaultVerdict: computeVaultVerdict(capabilities),
  };
}

const RUNNER = Object.freeze({
  engine: "chromium",
  engineVersion: "141.0.0.0",
  playwrightVersion: "1.62.1",
  os: "win32",
  osRelease: "10.0.26200",
  node: "v22.13.0",
  recordedAt: "2026-08-23T10:00:01.000Z",
});

test("le contrat de sonde déclare un identifiant et une version stables", () => {
  assert.deepEqual(CAPABILITY_PROBE_CONTRACT, {
    id: "railsbox-vault-capability-probe",
    version: 2,
  });
  assert.deepEqual(CAPABILITY_VERDICTS, ["supported", "unsupported", "denied", "error"]);
});

test("chaque capacité obligatoire du parcours Vault est déclarée dans la matrice", () => {
  const declared = CAPABILITIES.map((capability) => capability.id);
  for (const id of REQUIRED_CAPABILITY_IDS) {
    assert.ok(declared.includes(id), `capacité obligatoire absente de la matrice : ${id}`);
  }

  const expected = [
    "moduleDedicatedWorker",
    "webCryptoAesGcm",
    "webCryptoHkdf",
    "opfsGetDirectory",
    "storageEstimate",
    "storagePersist",
    "webAssembly",
    "sharedArrayBuffer",
    "crossOriginIsolated",
    "broadcastChannel",
    "webLocks",
    "publicKeyCredential",
    "platformAuthenticatorPresence",
    "performanceMemory",
    "workerWebCryptoAesGcm",
    "opfsSyncAccessHandle",
    "workerAtomicsWait",
  ];
  assert.deepEqual(declared, expected);
  assert.equal(new Set(declared).size, declared.length);
});

test("toutes les capacités obligatoires supportées donnent le statut mesuré", () => {
  const verdict = computeVaultVerdict(capabilitiesWith());

  assert.deepEqual(verdict, {
    status: "mesuré",
    supported: true,
    blocking: [],
    rule: verdict.rule,
  });
  assert.ok(verdict.rule.length > 0);
});

test("une capacité obligatoire absente ou refusée donne le statut refusé", () => {
  const unsupported = computeVaultVerdict(
    capabilitiesWith({ opfsSyncAccessHandle: "unsupported" }),
  );
  assert.equal(unsupported.status, "refusé");
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.blocking, ["opfsSyncAccessHandle"]);

  const denied = computeVaultVerdict(capabilitiesWith({ opfsGetDirectory: "denied" }));
  assert.equal(denied.status, "refusé");
  assert.deepEqual(denied.blocking, ["opfsGetDirectory"]);
});

test("une capacité facultative absente ne dégrade pas le statut", () => {
  const verdict = computeVaultVerdict(
    capabilitiesWith({
      storagePersist: "denied",
      sharedArrayBuffer: "unsupported",
      performanceMemory: "unsupported",
      workerAtomicsWait: "error",
    }),
  );

  assert.equal(verdict.status, "mesuré");
  assert.equal(verdict.supported, true);
});

test("une mesure obligatoire en erreur rend la conclusion non concluante", () => {
  const verdict = computeVaultVerdict(capabilitiesWith({ webCryptoHkdf: "error" }));

  assert.equal(verdict.status, "candidat");
  assert.equal(verdict.supported, false);
  assert.deepEqual(verdict.blocking, ["webCryptoHkdf"]);
});

test("une capacité obligatoire manquante dans la liste rend la conclusion non concluante", () => {
  const partial = capabilitiesWith().filter((entry) => entry.id !== "webLocks");
  const verdict = computeVaultVerdict(partial);

  assert.equal(verdict.status, "candidat");
  assert.deepEqual(verdict.blocking, ["webLocks"]);
});

test("la sonde ne promeut jamais une cible au statut supporté", () => {
  for (const verdict of CAPABILITY_VERDICTS) {
    for (const id of REQUIRED_CAPABILITY_IDS) {
      const computed = computeVaultVerdict(capabilitiesWith({ [id]: verdict }));
      assert.notEqual(computed.status, "supporté");
      assert.ok(COMPATIBILITY_STATUSES.includes(computed.status));
    }
  }
});

test("finalizeCompatReport ajoute le bloc exécutant sans muter le rapport de sonde", () => {
  const probeReport = probeReportWith();
  const snapshot = structuredClone(probeReport);
  const report = finalizeCompatReport(probeReport, RUNNER);

  assert.deepEqual(probeReport, snapshot);
  assert.deepEqual(report.runner, RUNNER);
  assert.deepEqual(report.capabilities, probeReport.capabilities);
  assert.throws(() => {
    report.runner.engine = "firefox";
  }, TypeError);
});

test("finalizeCompatReport fige tous les blocs mesurés du rapport", () => {
  const report = finalizeCompatReport(probeReportWith(), RUNNER);

  assert.throws(() => {
    report.contract.version = 99;
  }, TypeError);
  assert.throws(() => {
    report.agent.userAgent = "usurpé";
  }, TypeError);
  assert.throws(() => {
    report.capabilities[0].verdict = "supported";
  }, TypeError);
  assert.throws(() => {
    report.capabilities.push({ id: "intrus" });
  }, TypeError);
  assert.throws(() => {
    report.vaultVerdict.status = "supporté";
  }, TypeError);
  assert.throws(() => {
    report.vaultVerdict.blocking.push("webLocks");
  }, TypeError);
});

test("finalizeCompatReport refuse un moteur inconnu", () => {
  assert.throws(
    () => finalizeCompatReport(probeReportWith(), { ...RUNNER, engine: "trident" }),
    /moteur/i,
  );
});

test("un rapport complet et cohérent est valide", () => {
  const report = finalizeCompatReport(probeReportWith(), RUNNER);
  const { valid, problems } = validateCompatReport(report);

  assert.deepEqual(problems, []);
  assert.equal(valid, true);
});

test("le validateur signale un contrat, un verdict ou un détail invalides", () => {
  const wrongContract = finalizeCompatReport(probeReportWith(), RUNNER);
  wrongContract.contract = { id: "autre", version: 9 };
  assert.match(validateCompatReport(wrongContract).problems.join(" "), /contrat/i);

  const wrongVerdict = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  wrongVerdict.capabilities[0].verdict = "peut-être";
  assert.match(validateCompatReport(wrongVerdict).problems.join(" "), /verdict/i);

  const emptyDetail = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  emptyDetail.capabilities[0].detail = "";
  assert.match(validateCompatReport(emptyDetail).problems.join(" "), /détail/i);
});

test("le validateur signale une capacité manquante, en double ou inconnue", () => {
  const missing = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  missing.capabilities = missing.capabilities.slice(1);
  assert.match(validateCompatReport(missing).problems.join(" "), /manquante/i);

  const unknown = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  unknown.capabilities.push({
    id: "téléportation",
    context: "page",
    verdict: "supported",
    detail: "x",
  });
  assert.match(validateCompatReport(unknown).problems.join(" "), /inconnue/i);

  const duplicated = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  duplicated.capabilities.push({ ...duplicated.capabilities[0] });
  assert.match(validateCompatReport(duplicated).problems.join(" "), /double/i);
});

test("le validateur refuse un verdict Vault incohérent avec les capacités mesurées", () => {
  const tampered = structuredClone(
    finalizeCompatReport(probeReportWith({ webLocks: "unsupported" }), RUNNER),
  );
  tampered.vaultVerdict = {
    ...tampered.vaultVerdict,
    status: "mesuré",
    supported: true,
    blocking: [],
  };

  assert.match(validateCompatReport(tampered).problems.join(" "), /incohérent/i);
});

test("le validateur exige les booléens explicatifs du bloc agent", () => {
  for (const flag of ["crossOriginIsolated", "isSecureContext"]) {
    const report = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
    delete report.agent[flag];

    assert.match(validateCompatReport(report).problems.join(" "), new RegExp(flag));
  }
});

test("le validateur exige le bloc exécutant et un horodatage exploitable", () => {
  const withoutRunner = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  delete withoutRunner.runner;
  assert.match(validateCompatReport(withoutRunner).problems.join(" "), /exécutant/i);

  const badDate = structuredClone(finalizeCompatReport(probeReportWith(), RUNNER));
  badDate.generatedAt = "hier";
  assert.match(validateCompatReport(badDate).problems.join(" "), /horodatage/i);
});

test("le validateur rejette une valeur non objet", () => {
  assert.equal(validateCompatReport(null).valid, false);
  assert.equal(validateCompatReport("rapport").valid, false);
});

test("la fixture de référence versionnée respecte le schéma courant", async () => {
  const fixture = JSON.parse(await readFile(REFERENCE_FIXTURE, "utf8"));
  const { valid, problems } = validateCompatReport(fixture);

  assert.deepEqual(problems, []);
  assert.equal(valid, true);
  assert.equal(fixture.contract.version, CAPABILITY_PROBE_CONTRACT.version);
});
