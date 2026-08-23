/**
 * Vérifie que `eslint.config.mjs` sépare réellement les globals par répertoire et par contexte
 * d'exécution : Node dans `tools/`, `tests/unit/` et les configurations racine ; page dans
 * `public/` ; Worker dédié pour les modules `*worker*.mjs` ; et, pour les modules de `src/`
 * partagés entre la page et le Worker, l'intersection des deux jeux.
 *
 * Le test lint des chemins *virtuels* : aucun fichier témoin n'est écrit dans le dépôt. Seule la
 * résolution de configuration par chemin est exercée, ce qui évite d'introduire du code mort
 * uniquement destiné au lint.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const eslint = new ESLint({ cwd: REPO_ROOT });

/** Sources témoins : chacune n'emploie qu'un seul global, pour que l'échec désigne sa cause. */
const USAGE_NODE = "export const racine = process.cwd();\n";
const USAGE_DOM = "export const titre = document.title;\n";
const USAGE_WORKER = "export const poignee = FileSystemSyncAccessHandle;\n";

/**
 * Lint une source en la présentant sous un chemin virtuel du dépôt et rend les globals que la
 * configuration a refusés.
 *
 * @param {string} cheminRelatif chemin, inexistant sur le disque, servant à choisir la configuration
 * @param {string} source module à analyser
 * @returns {Promise<string[]>} noms des identifiants signalés par `no-undef`
 */
async function globalsRefuses(cheminRelatif, source) {
  const [resultat] = await eslint.lintText(source, {
    filePath: path.join(REPO_ROOT, cheminRelatif),
  });

  assert.ok(resultat, `aucun résultat de lint pour ${cheminRelatif}`);

  const inattendus = resultat.messages.filter(
    (message) => message.ruleId !== "no-undef" && message.severity === 2,
  );
  assert.deepEqual(
    inattendus.map((message) => `${message.ruleId}: ${message.message}`),
    [],
    `${cheminRelatif} déclenche des erreurs étrangères au périmètre du test`,
  );

  return resultat.messages
    .filter((message) => message.ruleId === "no-undef")
    .map((message) => /'(?<nom>[^']+)'/u.exec(message.message)?.groups?.nom ?? message.message);
}

test("le code servi au navigateur n'a pas accès aux globals Node", async () => {
  assert.deepEqual(await globalsRefuses("src/temoin-globals.mjs", USAGE_NODE), ["process"]);
  assert.deepEqual(await globalsRefuses("src/compat/page-temoin.mjs", USAGE_NODE), ["process"]);
  assert.deepEqual(await globalsRefuses("src/compat/temoin-worker.mjs", USAGE_NODE), ["process"]);
  assert.deepEqual(await globalsRefuses("public/temoin-globals.mjs", USAGE_NODE), ["process"]);
  assert.deepEqual(await globalsRefuses("public/spike/origin/temoin-sw.mjs", USAGE_NODE), [
    "process",
  ]);
});

test("le code Node n'a pas accès aux globals du navigateur", async () => {
  assert.deepEqual(await globalsRefuses("tools/temoin-globals.mjs", USAGE_DOM), ["document"]);
  assert.deepEqual(await globalsRefuses("tests/unit/temoin-globals.test.mjs", USAGE_DOM), [
    "document",
  ]);
});

test("un module Worker n'a pas accès au DOM mais garde ses globals propres", async () => {
  assert.deepEqual(await globalsRefuses("src/compat/temoin-worker.mjs", USAGE_DOM), ["document"]);
  assert.deepEqual(await globalsRefuses("public/temoin-worker.mjs", USAGE_DOM), ["document"]);
  assert.deepEqual(await globalsRefuses("public/spike/origin/temoin-sw.mjs", USAGE_DOM), [
    "document",
  ]);
  assert.deepEqual(await globalsRefuses("src/compat/temoin-worker.mjs", USAGE_WORKER), []);
});

test("un module partagé de src/ ne reçoit que l'intersection page et Worker", async () => {
  assert.deepEqual(await globalsRefuses("src/compat/temoin-partage.mjs", USAGE_DOM), ["document"]);
  assert.deepEqual(await globalsRefuses("src/compat/temoin-partage.mjs", USAGE_WORKER), [
    "FileSystemSyncAccessHandle",
  ]);
  assert.deepEqual(
    await globalsRefuses("src/compat/temoin-partage.mjs", "export const cle = crypto.subtle;\n"),
    [],
  );
});

test("un module de page garde le DOM et un module Node garde les globals Node", async () => {
  assert.deepEqual(await globalsRefuses("public/temoin-globals.mjs", USAGE_DOM), []);
  assert.deepEqual(await globalsRefuses("src/compat/page-temoin.mjs", USAGE_DOM), []);
  assert.deepEqual(await globalsRefuses("tools/temoin-globals.mjs", USAGE_NODE), []);
  assert.deepEqual(await globalsRefuses("temoin.config.mjs", USAGE_NODE), []);
});

test("les spécifications Playwright cumulent Node et navigateur", async () => {
  for (const repertoire of ["tests/browser", "tests/compat", "tests/vm"]) {
    assert.deepEqual(await globalsRefuses(`${repertoire}/temoin.spec.mjs`, USAGE_NODE), []);
    assert.deepEqual(await globalsRefuses(`${repertoire}/temoin.spec.mjs`, USAGE_DOM), []);
  }
});
