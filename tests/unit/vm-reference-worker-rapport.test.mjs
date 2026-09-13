import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Le Worker et ses phases sont réels ; seul le boot coûteux est remplacé.
const racine = new URL("../../", import.meta.url);
let optionsDuBoot;
let fermetures = 0;
let rapportDuBoot = { phase: "live", conforming: true };
globalThis.bootDuTest = async (options) => {
  optionsDuBoot = options;
  return {
    ...rapportDuBoot,
    fermer: async ({ capturer }) => {
      assert.equal(capturer, false);
      fermetures += 1;
      return { captured: false };
    },
    requeteHttp: () => {},
  };
};
registerHooks({
  resolve(specifier, context, suivant) {
    if (specifier.startsWith("/src/")) {
      return suivant(
        pathToFileURL(fileURLToPath(new URL(specifier.slice(1), racine))).href,
        context,
      );
    }
    return suivant(specifier, context);
  },
  load(url, context, suivant) {
    if (url === new URL("src/vm/boot-de-reference.mjs", racine).href) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const bootEtVerifier = (options) => globalThis.bootDuTest(options);
          export const acquerirRuntime = () => {};
          export const attentesDe = () => {};
          export const manifesteDuDescripteur = () => {};`,
      };
    }
    return suivant(url, context);
  },
});

let recevoir;
let repondre;
globalThis.self = {
  addEventListener: (type, ecouteur) => {
    assert.equal(type, "message");
    recevoir = ecouteur;
  },
  postMessage: (message) => repondre(structuredClone(message)),
};
await import("../../public/vm/reference-worker.mjs");

function executer(id) {
  return new Promise((resolve) => {
    repondre = resolve;
    recevoir({ data: { id, type: "run", payload: { phase: "live" } } });
  });
}

test("le boot à chaud ferme la session et rend un rapport clonable sans capacités", async () => {
  const reponse = await executer(1);
  assert.equal(optionsDuBoot.garderLaSessionOuverte, true);
  assert.equal(fermetures, 1);
  assert.deepEqual(reponse, {
    id: 1,
    ok: true,
    report: { phase: "live", conforming: true, capture: { captured: false } },
  });
});

test(
  "une erreur de clonage répond au lieu de laisser la page attendre",
  { timeout: 2_000 },
  async () => {
    rapportDuBoot = { capaciteInattendue: () => {} };
    const reponse = await executer(2);
    assert.equal(reponse.id, 2);
    assert.equal(reponse.ok, false);
    assert.equal(reponse.error.name, "DataCloneError");
    assert.equal(fermetures, 2);
  },
);
