import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CANAL_DU_HARNAIS,
  CHEMIN_INSTRUMENTE,
  FANION_DU_HARNAIS,
  harnaisDemande,
  instrumenter,
} from "../../tools/harnais-point-d-arret.mjs";

// LE POINT D'ARRÊT D'ÉPREUVE des courses entre onglets (#311, C5) : ce que le serveur de test peut
// en faire, et ce qui le borne. Le comportement de la pause, lui, est mesuré dans les navigateurs
// (`tests/browser/coquille-course-entre-onglets.spec.mjs`).

const SOURCE = await readFile(
  new URL("../../src/vm/opfs-sync-access.mjs", import.meta.url),
  "utf8",
);

test("la copie instrumentée garde l'original sous un autre nom et exporte la porte retenue", () => {
  const copie = instrumenter(SOURCE);
  assert.ok(copie.includes("async function openOpfsSyncAccessOrigine(name) {"));
  assert.equal(copie.split("export async function openOpfsSyncAccess(name) {").length, 2);
  assert.ok(copie.includes(JSON.stringify(CANAL_DU_HARNAIS)));
  // Rien d'autre du module ne change : tout ce qui précède la déclaration est identique.
  const debut = SOURCE.indexOf("export async function openOpfsSyncAccess(name) {");
  assert.equal(copie.slice(0, debut), SOURCE.slice(0, debut));
});

test("la copie instrumentée est un module VALIDE (syntaxe vérifiée par `node --check`)", async () => {
  const dossier = await mkdtemp(join(tmpdir(), "harnais-"));
  try {
    const chemin = join(dossier, "copie.mjs");
    await writeFile(chemin, instrumenter(SOURCE));
    const verdict = spawnSync(process.execPath, ["--check", chemin], { encoding: "utf8" });
    assert.equal(verdict.status, 0, verdict.stderr.slice(0, 400));
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
});

test("une source qui ne porte plus la déclaration visée est REFUSÉE, jamais servie telle quelle", () => {
  assert.throws(() => instrumenter("export const rien = 1;\n"), /inapplicable/);
  assert.throws(
    () => instrumenter(`${SOURCE}\nexport async function openOpfsSyncAccess(name) {}\n`),
    /inapplicable/,
  );
});

test("le harnais ne se demande que par l'ARGUMENT, jamais par l'environnement", () => {
  assert.equal(harnaisDemande(["--role", "shell"]), false);
  assert.equal(harnaisDemande(["--role", "shell", FANION_DU_HARNAIS]), true);
  const avant = process.env.HARNAIS_POINT_D_ARRET;
  process.env.HARNAIS_POINT_D_ARRET = "1";
  try {
    assert.equal(harnaisDemande(["--role", "shell"]), false);
  } finally {
    if (avant === undefined) delete process.env.HARNAIS_POINT_D_ARRET;
    else process.env.HARNAIS_POINT_D_ARRET = avant;
  }
  assert.equal(CHEMIN_INSTRUMENTE, "/src/vm/opfs-sync-access.mjs");
});
