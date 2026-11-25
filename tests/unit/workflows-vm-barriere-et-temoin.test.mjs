/**
 * Cliquet (#243) : `vm.yml` sépare la barrière de durabilité du témoin de navigateurs.
 *
 * - le job de la barrière n'installe que `chromium` ;
 * - un job distinct installe et joue `firefox` et `webkit` ;
 * - aucun des deux jobs n'a de `timeout-minutes` supérieur à 45.
 *
 * Analyse textuelle, comme `workflows-image-sur-ubuntu-24-04.test.mjs` : le dépôt n'a aucune
 * dépendance YAML. `VM_WORKFLOW` permet de rejouer le cliquet sur une autre version du fichier
 * (par exemple celle de `main`) pour en établir le rouge.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FICHIER =
  process.env.VM_WORKFLOW ??
  path.join(fileURLToPath(new URL("../../", import.meta.url)), ".github", "workflows", "vm.yml");

/**
 * @param {string} texte
 * @returns {Map<string, string>} nom de chaque job (clé à deux espaces) -> texte de son bloc
 */
function jobs(texte) {
  const lignes = texte.split("\n");
  const blocs = new Map();
  let nom = null;
  for (const ligne of lignes.slice(lignes.indexOf("jobs:") + 1)) {
    const entete = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(ligne);
    if (entete) {
      nom = entete[1];
      blocs.set(nom, []);
    } else if (nom !== null) {
      blocs.get(nom).push(ligne);
    }
  }
  return new Map([...blocs].map(([cle, lignesDuJob]) => [cle, lignesDuJob.join("\n")]));
}

/** @returns {string[]} les navigateurs passés à `npx playwright install` dans le bloc */
function navigateursInstalles(bloc) {
  const commande = /npx playwright install\s+([^\n]*)/.exec(bloc);
  if (!commande) return [];
  return commande[1].split(/\s+/).filter((mot) => mot !== "" && !mot.startsWith("-"));
}

const texte = await readFile(FICHIER, "utf8");
const blocs = jobs(texte);
const barriere = [...blocs].filter(([, bloc]) => navigateursInstalles(bloc).includes("chromium"));
const nomBarriere = barriere[0]?.[0];
const temoins = [...blocs].filter(
  ([nom, bloc]) =>
    nom !== nomBarriere &&
    JSON.stringify(navigateursInstalles(bloc).sort()) === JSON.stringify(["firefox", "webkit"]) &&
    bloc.includes("--project=firefox") &&
    bloc.includes("--project=webkit"),
);

test("la barrière n'installe que chromium", () => {
  assert.equal(barriere.length, 1, "un seul job doit installer chromium (la barrière)");
  assert.deepEqual(
    navigateursInstalles(barriere[0][1]),
    ["chromium"],
    `${nomBarriere} : la barrière installe autre chose que chromium`,
  );
});

test("un job distinct installe et joue firefox et webkit", () => {
  assert.equal(
    temoins.length,
    1,
    "il faut un job distinct de la barrière qui installe firefox et webkit et lance --project=firefox --project=webkit",
  );
});

test("aucun des deux jobs n'a de timeout-minutes supérieur à 45", () => {
  for (const [nom, bloc] of [...barriere, ...temoins]) {
    const plafond = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(bloc);
    assert.ok(plafond, `${nom} : pas de timeout-minutes (le plafond implicite est de 360 min)`);
    assert.ok(Number(plafond[1]) <= 45, `${nom} : timeout-minutes ${plafond[1]} > 45`);
  }
});
