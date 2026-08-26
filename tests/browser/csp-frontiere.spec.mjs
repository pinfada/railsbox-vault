// Tests de FRONTIÈRE de la CSP de la coquille (#52, ADR 0013).
//
// La CSP est une frontière de sécurité : ce qu'elle admet doit être aussi précisément éprouvé que
// ce qu'elle refuse. Sans les deux moitiés, un jeton pourrait être retiré sans qu'aucun test ne
// rougisse (`'wasm-unsafe-eval'` avant cette suite), ou ajouté sans qu'aucun test ne le remarque.
//
// Ces épreuves n'ont besoin d'aucun artefact v86 : elles sont donc rattachées à `npm run check`, et
// exécutées sur les trois moteurs de la matrice #2 par des projets dédiés de
// `playwright.config.mjs`. La mesure du démarrage de l'ÉMULATEUR, elle, exige les artefacts et vit
// dans `npm run test:csp`.

import { expect, test } from "@playwright/test";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const PAGE_SERVIE = "/csp/frontiere.html";
const PAGE_SANS_WASM = "/csp/frontiere-sans-wasm.html";

/** Ouvre une page de sondes et rend son relevé, une fois toutes les sondes terminées. */
async function relever(page, chemin) {
  await page.goto(chemin);
  await expect(page.locator("html")).toHaveAttribute("data-vault-sondes", "terminees", {
    timeout: 30000,
  });
  return page.evaluate(() => globalThis.releveFrontiere);
}

/**
 * Exige une violation portant À LA FOIS la directive attendue et la ressource attendue.
 *
 * La directive seule ne suffit pas : la page déclenche plusieurs refus sous `script-src`, si bien
 * qu'une épreuve qui se contenterait de « une violation `script-src` existe » resterait verte alors
 * même que le Worker `blob:` serait devenu vivant. Le couple (directive, ressource bloquée) est
 * unique pour chacune des quatre sondes de refus.
 *
 * @param {string[]} directives noms admis pour cette ressource, d'un moteur à l'autre
 * @param {RegExp} ressource motif attendu du `blockedURI`
 */
function violationPour(releve, directives, ressource) {
  return releve.violations.filter(
    (violation) =>
      directives.some((directive) => violation.directive.includes(directive)) &&
      ressource.test(String(violation.bloque)),
  );
}

/** Directives sous lesquelles les moteurs classent un Worker refusé, `worker-src` étant servi. */
const DIRECTIVES_WORKER = ["worker-src", "child-src"];
/** Directives sous lesquelles les moteurs classent un script refusé. */
const DIRECTIVES_SCRIPT = ["script-src"];

test("la CSP servie nomme WebAssembly et ne nomme pas blob:", async ({ request }) => {
  const reponse = await request.get(`${SHELL_ORIGIN}${PAGE_SERVIE}`);
  const politique = reponse.headers()["content-security-policy"];

  expect(politique).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(politique).toContain("worker-src 'self'");
  // L'ADR 0013 retient `worker-src 'self'`. Le drapeau de mesure `--worker-src-blob` existe pour
  // rendre cette décision falsifiable ; aucun service par défaut ne doit le poser.
  expect(politique).not.toContain("blob:");
  expect(politique).not.toContain("'unsafe-eval'");
  expect(politique).not.toContain("'unsafe-inline'");
});

test("sous la CSP servie : WebAssembly s'instancie, un Worker de l'origine vit", async ({
  page,
}, info) => {
  const releve = await relever(page, PAGE_SERVIE);
  await info.attach(`frontiere-servie-${info.project.name}.json`, {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });

  // Témoins POSITIFS. Sans eux, un relevé « tout refusé » ne prouverait qu'un banc cassé.
  expect(releve.wasm).toBe("instancie");
  expect(releve.workerSelf).toBe("vivant");
});

test("sous la CSP servie : un Worker blob:, un script blob:, data: ou inline sont refusés", async ({
  page,
}, info) => {
  const releve = await relever(page, PAGE_SERVIE);
  await info.attach(`refus-${info.project.name}.json`, {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });

  // Le fait le plus important de #52 : le refus d'un Worker `blob:` ne lève AUCUNE exception à la
  // construction. C'est ce silence-là qui a coûté un spike, et c'est pour cela que la sonde mesure
  // le SIGNE DE VIE. Le refus, lui, est bien observable — par une violation de `worker-src`, et par
  // un événement `error` sur le Worker, que la sonde rapporte quand il arrive.
  expect(releve.workerBlob).not.toBe("vivant");
  expect(violationPour(releve, DIRECTIVES_WORKER, /blob/)).not.toHaveLength(0);

  // `script-src` reste fermé à tout ce qui n'est pas servi par l'origine — c'est la garantie que
  // l'ADR 0013 exige de conserver quelle que soit la décision sur `worker-src`. Chaque refus est
  // exigé DEUX fois : le script n'a pas produit son effet, ET le moteur a signalé la violation.
  expect(releve.scriptBlob).toBe("non-execute");
  expect(violationPour(releve, DIRECTIVES_SCRIPT, /blob/)).not.toHaveLength(0);
  expect(releve.scriptData).toBe("non-execute");
  expect(violationPour(releve, DIRECTIVES_SCRIPT, /data/)).not.toHaveLength(0);
  expect(releve.scriptInline).toBe("non-execute");
  expect(violationPour(releve, DIRECTIVES_SCRIPT, /inline/)).not.toHaveLength(0);
});

test("sans 'wasm-unsafe-eval', l'instanciation WebAssembly est refusée", async ({ page }, info) => {
  const releve = await relever(page, PAGE_SANS_WASM);
  await info.attach(`sans-wasm-${info.project.name}.json`, {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });

  // Témoin d'intégrité de la page : la politique additionnelle est bien celle qu'on croit, et le
  // module de sondes s'est bien exécuté sous elle.
  expect(releve.politiqueMeta).toBe("script-src 'self'");
  expect(releve.workerSelf).toBe("vivant");

  expect(releve.wasm).toMatch(/^refuse:/);
});
