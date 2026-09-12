/**
 * Le CLIQUET des refus de la coquille de cadre : chaque code écrit dans le Service Worker ou le
 * courtier est nommé au § 10.5 de `docs/format-de-volume-v3.md` (revues de la PR #203).
 *
 * Il vit à part de `coquille-routage-du-cadre.test.mjs` parce que la campagne de mutation rejoue
 * celle-ci dans une copie du dépôt qui n'emporte pas `docs/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CODES_DU_ROUTAGE } from "../../src/coquille/routage-du-cadre.mjs";

test("chaque refus de la coquille de cadre est NOMMÉ au § 10.5 (cliquet)", async () => {
  const { readFile } = await import("node:fs/promises");
  const lire = (chemin) => readFile(new URL(`../../${chemin}`, import.meta.url), "utf8");
  const [sw, courtier, format] = await Promise.all([
    lire("public/service-worker-du-cadre.mjs"),
    lire("public/cadre/courtier-du-cadre.mjs"),
    lire("docs/format-de-volume-v3.md"),
  ]);
  const codes = new Set([
    ...Object.values(CODES_DU_ROUTAGE),
    ...`${sw}\n${courtier}`.matchAll(/"(CADRE_[A-Z_]+)"/g).map(([, code]) => code),
  ]);
  assert.ok(codes.size >= 10, `trop peu de codes relevés (${codes.size})`);
  for (const code of codes) {
    assert.ok(format.includes(`\`${code}\``), `${code} n'est pas nommé au § 10.5`);
  }
});
