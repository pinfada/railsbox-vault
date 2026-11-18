/**
 * Cliquet PROVISOIRE (#295) : les workflows qui fabriquent l'image de référence ou lancent les
 * épreuves VM restent sur `ubuntu-24.04`, avec la raison écrite à côté du `runs-on`.
 *
 * Depuis le 29/10/2026 `ubuntu-latest` est ubuntu-26.04. Deux défauts distincts y cassent ces jobs,
 * tous deux établis par exécution CI :
 *
 * - Docker 29.4.2 y donne `ENOSYS` à `socket` aux processus 32 bits des étapes `RUN` : l'étage
 *   i386 de `guest.Dockerfile` ne résout plus `deb.debian.org` (« Temporary failure resolving »).
 * - le WebKit de Playwright y manque de `libicu74` et `libxml2.so.2` : `tests/vm` sous WebKit
 *   échoue au lancement du navigateur.
 *
 * Ce cliquet empêche qu'un retour à `ubuntu-latest` passe inaperçu avant que #295 (suite) ne
 * l'autorise. Il se retire avec l'épinglage lui-même. Analyse textuelle, comme
 * `workflows-sans-interpolation.test.mjs` : le dépôt n'a aucune dépendance YAML.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DOSSIER = path.join(
  fileURLToPath(new URL("../../", import.meta.url)),
  ".github",
  "workflows",
);

const WORKFLOWS_EPINGLES = ["image-reference.yml", "mesure-reprise.yml", "reprise.yml", "vm.yml"];

/** @param {string} texte @returns {string[]} les valeurs de chaque `runs-on:` */
function runsOn(texte) {
  return [...texte.matchAll(/^\s*runs-on:\s*(\S+)/gm)].map((m) => m[1]);
}

/** @param {string} texte */
function porteLaRaison(texte) {
  return /PROVISOIRE/.test(texte) && /#295/.test(texte);
}

for (const fichier of WORKFLOWS_EPINGLES) {
  test(`${fichier} : chaque job est sur ubuntu-24.04, et la raison provisoire est écrite`, async () => {
    const texte = await readFile(path.join(DOSSIER, fichier), "utf8");
    const valeurs = runsOn(texte);
    assert.ok(valeurs.length > 0, `${fichier} ne déclare aucun runs-on`);
    assert.deepEqual(
      valeurs.filter((v) => v !== "ubuntu-24.04"),
      [],
      `${fichier} : un job n'est pas épinglé sur ubuntu-24.04 (voir #295)`,
    );
    assert.ok(porteLaRaison(texte), `${fichier} : la raison PROVISOIRE (#295) n'est pas écrite`);
  });
}

test("le cliquet mord : ubuntu-latest et l'absence de raison sont refusés", () => {
  assert.deepEqual(runsOn("jobs:\n  a:\n    runs-on: ubuntu-latest\n"), ["ubuntu-latest"]);
  assert.equal(porteLaRaison("runs-on: ubuntu-24.04\n"), false);
  assert.equal(porteLaRaison("# PROVISOIRE (#295)\nruns-on: ubuntu-24.04\n"), true);
});
