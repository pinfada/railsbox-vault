import assert from "node:assert/strict";
import test from "node:test";

import {
  DeniedCapabilityError,
  MissingCapabilityError,
  measureCapability,
  unmeasuredCapability,
} from "../../src/compat/probe-runner.mjs";

const BASE = { id: "webLocks", context: "page" };

test("une mesure réussie produit le verdict supported et son détail", async () => {
  const record = await measureCapability({ ...BASE, run: async () => "verrou acquis" });

  assert.deepEqual(record, {
    id: "webLocks",
    context: "page",
    verdict: "supported",
    detail: "verrou acquis",
  });
});

test("une mesure réussie sans détail explicite reste documentée", async () => {
  const record = await measureCapability({ ...BASE, run: async () => undefined });

  assert.equal(record.verdict, "supported");
  assert.ok(record.detail.length > 0);
});

test("une capacité absente produit unsupported et non une erreur", async () => {
  const record = await measureCapability({
    ...BASE,
    run: async () => {
      throw new MissingCapabilityError("navigator.locks est absent");
    },
  });

  assert.equal(record.verdict, "unsupported");
  assert.equal(record.detail, "navigator.locks est absent");
});

test("une capacité refusée produit denied et non une erreur", async () => {
  const record = await measureCapability({
    ...BASE,
    run: async () => {
      throw new DeniedCapabilityError("persistance refusée par le navigateur");
    },
  });

  assert.equal(record.verdict, "denied");
  assert.equal(record.detail, "persistance refusée par le navigateur");
});

test("une exception inattendue produit error avec le nom de l'exception", async () => {
  const record = await measureCapability({
    ...BASE,
    run: async () => {
      throw new TypeError("handle.write n'est pas une fonction");
    },
  });

  assert.equal(record.verdict, "error");
  assert.match(record.detail, /^TypeError : handle\.write/);
});

test("un dépassement de délai produit error sans bloquer la sonde", async () => {
  const record = await measureCapability({
    ...BASE,
    timeoutMs: 20,
    run: () => new Promise(() => {}),
  });

  assert.equal(record.verdict, "error");
  assert.match(record.detail, /délai/i);
});

test("un détail trop long est tronqué et débarrassé des sauts de ligne", async () => {
  const record = await measureCapability({
    ...BASE,
    run: async () => {
      throw new Error(`ligne un\nligne deux ${"x".repeat(500)}`);
    },
  });

  assert.ok(record.detail.length <= 300);
  assert.ok(!record.detail.includes("\n"));
  assert.match(record.detail, /…$/);
});

test("une capacité non mesurable est signalée en erreur explicite", () => {
  const record = unmeasuredCapability("opfsSyncAccessHandle", "worker", "Worker indisponible");

  assert.deepEqual(record, {
    id: "opfsSyncAccessHandle",
    context: "worker",
    verdict: "error",
    detail: "Worker indisponible",
  });
});
