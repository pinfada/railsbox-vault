/**
 * Le GÉNÉRATEUR de la réserve sur l'arbre PUBLIÉ pour de bon (#299, ADR 0048 §§ 2 et 3) : aucune surprise,
 * liste fidèle aux octets, profils égaux à `_headers`. Séparée de `reserve-generateur.test.mjs` (pure) parce
 * qu'elle publie l'arbre : elle a besoin de `vendor/` et reste hors des ateliers de mutation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { analyserHeaders, enTetesPour } from "../../tools/publier-en-tetes.mjs";
import {
  CHEMIN_DU_MODULE_DE_PAGE,
  CHEMIN_DU_SW,
  classerLesChemins,
} from "../../tools/publier-reserve.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SORTIE = join(RACINE, "artifacts", `publication-reserve-${process.pid}`);
const sha = (octets) => createHash("sha256").update(octets).digest("hex");

function lister(racine, dossier = racine) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const complet = join(dossier, nom);
    if (statSync(complet).isDirectory()) sortie.push(...lister(racine, complet));
    else sortie.push("/" + relative(racine, complet).split(sep).join("/"));
  }
  return sortie.sort();
}

// --- L'arbre PUBLIÉ pour de bon ------------------------------------------------------------------

let arbre;
before(() => {
  mkdirSync(SORTIE, { recursive: true });
  execFileSync(
    process.execPath,
    [
      "tools/publier.mjs",
      "--sortie",
      SORTIE,
      "--origine-application",
      "http://localhost:4194",
      "--origine-coquille",
      "http://127.0.0.1:4193",
      "--tolerer-incomplet",
      "--sequence",
      "42",
    ],
    { cwd: RACINE, stdio: "pipe" },
  );
  arbre = join(SORTIE, "coquille");
});
after(() => rmSync(SORTIE, { recursive: true, force: true }));

test("PUBLIÉ : tout fichier de l'arbre est listé, exclu ou en passage nommé — aucune SURPRISE", () => {
  const classes = classerLesChemins(lister(arbre));
  assert.deepEqual(classes.inconnus, [], "un fichier publié ni listé ni exclu échoue ici");
  assert.ok(
    classes.reserve.length > 100,
    "la réserve porte l'arbre : page, code, Workers, src, Argon2",
  );
  for (const attendu of [
    "/index.html",
    "/main.mjs",
    "/runtime-worker.mjs",
    CHEMIN_DU_MODULE_DE_PAGE,
    "/vendor/argon2/argon2.wasm",
  ]) {
    assert.ok(classes.reserve.includes(attendu), attendu);
  }
  for (const exclu of ["/_headers", "/inventaire.json", CHEMIN_DU_SW])
    assert.ok(classes.exclus.includes(exclu), exclu);
});

test("PUBLIÉ : le script du SW est à la RACINE de l'arbre, la liste correspond octet pour octet aux fichiers publiés", () => {
  const script = readFileSync(join(arbre, "sw-coquille.mjs"), "utf8");
  const config = JSON.parse(script.match(/const CONFIG = (\{.*\});/)[1]);
  assert.equal(config.sequence, 42);
  assert.equal(config.retrait, false);
  for (const [chemin, entree] of Object.entries(config.liste)) {
    const octets = readFileSync(join(arbre, chemin));
    assert.equal(entree.taille, octets.byteLength, chemin);
    assert.equal(entree.sha256, sha(octets), chemin);
  }
  assert.ok(Object.keys(config.liste).includes(CHEMIN_DU_MODULE_DE_PAGE));
});

test("PUBLIÉ : le module de page est GÉNÉRÉ (séquence 42), et la liste l'épingle tel qu'il est publié", () => {
  const module = readFileSync(join(arbre, "coquille", "reserve-publiee.mjs"), "utf8");
  assert.match(module, /sequence: 42/);
  const config = JSON.parse(
    readFileSync(join(arbre, "sw-coquille.mjs"), "utf8").match(/const CONFIG = (\{.*\});/)[1],
  );
  assert.equal(config.liste[CHEMIN_DU_MODULE_DE_PAGE].sha256, sha(Buffer.from(module)));
});

test("PUBLIÉ : le profil de chaque entrée est EXACTEMENT ce que `_headers` rend pour ce chemin (garde 15, source de vérité unique)", () => {
  const regles = analyserHeaders(readFileSync(join(arbre, "_headers"), "utf8"));
  const config = JSON.parse(
    readFileSync(join(arbre, "sw-coquille.mjs"), "utf8").match(/const CONFIG = (\{.*\});/)[1],
  );
  for (const [chemin, entree] of Object.entries(config.liste)) {
    assert.deepEqual(config.profils[entree.profil], enTetesPour(regles, chemin), chemin);
  }
  const page = config.profils[config.liste["/index.html"].profil];
  for (const nom of ["Content-Security-Policy", "Cross-Origin-Opener-Policy", "X-Frame-Options"]) {
    assert.ok(
      Object.keys(page).some((cle) => cle.toLowerCase() === nom.toLowerCase()),
      `la page porte ${nom}`,
    );
  }
});

test("PUBLIÉ : `/sw-coquille.mjs` reçoit la politique de cache `no-cache` de la nature `coquille`", () => {
  const regles = analyserHeaders(readFileSync(join(arbre, "_headers"), "utf8"));
  assert.equal(enTetesPour(regles, CHEMIN_DU_SW)["Cache-Control"], "no-cache");
});
