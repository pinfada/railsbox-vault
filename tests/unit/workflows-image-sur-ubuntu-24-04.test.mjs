/**
 * Cliquet PROVISOIRE (#295) : les workflows qui fabriquent l'image de référence ou lancent les
 * épreuves VM restent sur `ubuntu-24.04`, avec la raison écrite à côté du `runs-on`.
 *
 * `ubuntu-latest` bascule vers ubuntu-26.04 (déploiement progressif du 19/10 au 19/11/2026,
 * runner-images#14748 ; premier rouge observé ici le 29/10/2026). Deux défauts distincts y cassent
 * ces jobs, tous deux établis par exécution CI :
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

/**
 * Les `runs-on` dont le commentaire contigu juste au-dessus ne porte pas « PROVISOIRE » et « #295 » :
 * la raison doit se lire à côté de CHAQUE job, pas quelque part dans le fichier.
 *
 * @param {string} texte
 * @returns {number[]} numéros de ligne (à partir de 1)
 */
function runsOnSansRaison(texte) {
  const lignes = texte.split("\n");
  const sansRaison = [];
  for (const [index, ligne] of lignes.entries()) {
    if (!/^\s*runs-on:/.test(ligne)) continue;
    const commentaire = [];
    for (let i = index - 1; i >= 0 && /^\s*#/.test(lignes[i]); i -= 1) commentaire.push(lignes[i]);
    const bloc = commentaire.join("\n");
    if (!(/PROVISOIRE/.test(bloc) && /#295/.test(bloc))) sansRaison.push(index + 1);
  }
  return sansRaison;
}

for (const fichier of WORKFLOWS_EPINGLES) {
  test(`${fichier} : chaque job est sur ubuntu-24.04 et porte sa raison provisoire`, async () => {
    const texte = await readFile(path.join(DOSSIER, fichier), "utf8");
    const valeurs = runsOn(texte);
    assert.ok(valeurs.length > 0, `${fichier} ne déclare aucun runs-on`);
    assert.deepEqual(
      valeurs.filter((v) => v !== "ubuntu-24.04"),
      [],
      `${fichier} : un job n'est pas épinglé sur ubuntu-24.04 (voir #295)`,
    );
    assert.deepEqual(
      runsOnSansRaison(texte),
      [],
      `${fichier} : un runs-on n'a pas la raison PROVISOIRE (#295) dans le commentaire qui le précède`,
    );
  });
}

test("le cliquet mord : ubuntu-latest, l'absence de raison et une raison éloignée sont refusés", () => {
  assert.deepEqual(runsOn("jobs:\n  a:\n    runs-on: ubuntu-latest\n"), ["ubuntu-latest"]);
  assert.deepEqual(runsOnSansRaison("jobs:\n  a:\n    runs-on: ubuntu-24.04\n"), [2 + 1]);
  const lointaine = "# PROVISOIRE (#295)\njobs:\n  a:\n    runs-on: ubuntu-24.04\n";
  assert.deepEqual(runsOnSansRaison(lointaine), [4]);
  const proche = "jobs:\n  a:\n    # PROVISOIRE (#295) : raison\n    runs-on: ubuntu-24.04\n";
  assert.deepEqual(runsOnSansRaison(proche), []);
});
