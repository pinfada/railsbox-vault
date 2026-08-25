/**
 * Vérifie que `eslint.config.mjs` sépare réellement les globals par répertoire et par contexte
 * d'exécution : Node dans `tools/`, `tests/unit/`, `tests/vm/` et les configurations racine ; page dans
 * `public/` ; Worker dédié pour les modules `*worker*.mjs` ; et, pour les modules de `src/`
 * partagés entre la page et le Worker, l'intersection des deux jeux.
 *
 * Le test lint des chemins *virtuels* : aucun fichier témoin n'est écrit dans le dépôt. Seule la
 * résolution de configuration par chemin est exercée, ce qui évite d'introduire du code mort
 * uniquement destiné au lint.
 *
 * Une épreuve fait exception et vise un module *réel* : celle qui exige qu'un module effectivement
 * partagé entre la page et le Worker soit rangé là où la configuration lui accorde l'intersection.
 * Cette exigence porte sur l'emplacement d'un fichier du dépôt, pas sur une règle abstraite : elle
 * ne se démontre donc pas sur un chemin inventé.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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

/** Racines dont le contenu est servi au navigateur, donc candidates à héberger un module web. */
const RACINES_WEB = ["public", "src"];

/**
 * Localise un module servi au navigateur par son nom de fichier, sans présumer de sa racine.
 *
 * L'épreuve qui s'en sert doit échouer tant que le module est mal rangé, et non le chercher là où
 * on souhaite qu'il soit : la recherche couvre donc les deux racines et exige une occurrence unique,
 * faute de quoi le chemin retenu serait arbitraire.
 *
 * @param {string} nomFichier nom du module, extension comprise
 * @returns {string} chemin relatif au dépôt, séparé par « / »
 */
function localiserModuleWeb(nomFichier) {
  const trouves = RACINES_WEB.flatMap((racine) => {
    const base = path.join(REPO_ROOT, racine);
    return readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entree) => entree.isFile() && entree.name === nomFichier)
      .map((entree) =>
        path
          .relative(REPO_ROOT, path.join(entree.parentPath, entree.name))
          .split(path.sep)
          .join("/"),
      );
  });

  assert.equal(
    trouves.length,
    1,
    `${nomFichier} doit exister en un seul exemplaire sous ${RACINES_WEB.join(" ou ")} ; trouvé : ${JSON.stringify(trouves)}`,
  );
  return trouves[0];
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
  // La suite VM boote un émulateur sous Node : elle n'a jamais de DOM, malgré
  // le mot « navigateur » qui traîne dans son sujet.
  assert.deepEqual(await globalsRefuses("tests/vm/temoin-globals.test.mjs", USAGE_DOM), [
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
  assert.deepEqual(await globalsRefuses("tests/vm/temoin-globals.test.mjs", USAGE_NODE), []);
  assert.deepEqual(await globalsRefuses("temoin.config.mjs", USAGE_NODE), []);
});

/**
 * `isolation-probe.mjs` est importé par la coquille du spike #35, par son Worker runtime et par le
 * document applicatif : il est partagé au sens strict. Rangé sous `public/`, il recevrait les
 * globals de page, et un `document` y passerait le lint pour casser le Worker à l'exécution. Cette
 * épreuve fixe donc l'emplacement par sa conséquence observable — les globals réellement accordés —
 * plutôt que par une comparaison de chaîne de caractères.
 */
test("un module réellement partagé est rangé là où il reçoit l'intersection", async () => {
  const chemin = localiserModuleWeb("isolation-probe.mjs");

  assert.deepEqual(
    await globalsRefuses(chemin, USAGE_DOM),
    ["document"],
    `${chemin} reçoit le DOM : il est analysé comme un script de page, pas comme un module partagé`,
  );
  assert.deepEqual(
    await globalsRefuses(chemin, USAGE_WORKER),
    ["FileSystemSyncAccessHandle"],
    `${chemin} reçoit les globals propres au Worker, absents de la page`,
  );
});

test("les spécifications Playwright cumulent Node et navigateur", async () => {
  for (const repertoire of ["tests/browser", "tests/compat", "tests/vm"]) {
    assert.deepEqual(await globalsRefuses(`${repertoire}/temoin.spec.mjs`, USAGE_NODE), []);
    assert.deepEqual(await globalsRefuses(`${repertoire}/temoin.spec.mjs`, USAGE_DOM), []);
  }
});
