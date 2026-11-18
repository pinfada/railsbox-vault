/**
 * Le GÉNÉRATEUR de la réserve (#299, ADR 0048 §§ 2, 3, 5 et Annexe A) : la liste épinglée — chemin,
 * taille, SHA-256, type, profil d'en-têtes — est calculée depuis l'arbre PUBLIÉ moins une table
 * d'exclusions NOMMÉE, et une surprise (un fichier publié ni listé ni exclu) fait échouer l'épreuve.
 * Patron de `publication-arborescences.test.mjs`.
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
  EXCLUS_DE_LA_RESERVE,
  PASSAGE_NOMME,
  classerLesChemins,
  fabriquerLaReserve,
  fabriquerLeScriptDeRetrait,
} from "../../tools/publier-reserve.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SORTIE = join(RACINE, "artifacts", `publication-reserve-${process.pid}`);
const sha = (octets) => createHash("sha256").update(octets).digest("hex");
const regles = analyserHeaders(
  "/*\n  Cache-Control: no-cache\n  X-Frame-Options: DENY\n/vendor/*\n  Cache-Control: public, max-age=1, immutable\n",
);
const entetesDe = (chemin) => enTetesPour(regles, chemin);
const fichiers = () =>
  new Map([
    ["/index.html", Buffer.from("<!doctype html><title>x</title>")],
    ["/main.mjs", Buffer.from("export const A = 1;\n")],
    ["/coquille/reserve-publiee.mjs", Buffer.from("export const RESERVE_PUBLIEE = null;\n")],
    ["/vendor/argon2/argon2.wasm", Buffer.from([0, 97, 115, 109])],
    ["/_headers", Buffer.from("/*\n")],
    ["/inventaire.json", Buffer.from("{}")],
    ["/artifacts/application.json", Buffer.from("{}")],
    ["/sw-coquille.mjs", Buffer.from("// le script lui-même")],
  ]);

function lister(racine, dossier = racine) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const complet = join(dossier, nom);
    if (statSync(complet).isDirectory()) sortie.push(...lister(racine, complet));
    else sortie.push("/" + relative(racine, complet).split(sep).join("/"));
  }
  return sortie.sort();
}

test("la liste porte, pour chaque fichier réservé, sa taille, son SHA-256, son type et son profil d'en-têtes", () => {
  const reserve = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4, plancher: 0 });
  assert.deepEqual(Object.keys(reserve.liste).sort(), [
    "/coquille/reserve-publiee.mjs",
    "/index.html",
    "/main.mjs",
    "/vendor/argon2/argon2.wasm",
  ]);
  const entree = reserve.liste["/main.mjs"];
  assert.equal(entree.taille, 20);
  assert.equal(entree.sha256, sha(Buffer.from("export const A = 1;\n")));
  assert.equal(entree.type, "text/javascript; charset=utf-8");
  assert.deepEqual(reserve.profils[entree.profil], {
    "Cache-Control": "no-cache",
    "X-Frame-Options": "DENY",
  });
  assert.equal(reserve.liste["/vendor/argon2/argon2.wasm"].type, "application/wasm");
  assert.deepEqual(reserve.alias, { "/": "/index.html" }, "`/` sert la page d'index : alias");
});

test("sont EXCLUS, chacun avec son motif : `_headers`, `inventaire.json`, `artifacts/**`, le script du SW lui-même", () => {
  const reserve = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4 });
  for (const chemin of [
    "/_headers",
    "/inventaire.json",
    "/artifacts/application.json",
    CHEMIN_DU_SW,
  ]) {
    assert.equal(reserve.liste[chemin], undefined, chemin);
  }
  for (const exclu of EXCLUS_DE_LA_RESERVE)
    assert.ok(exclu.chemin && exclu.motif.length > 10, "une raison par entrée");
  assert.ok(EXCLUS_DE_LA_RESERVE.some(({ chemin }) => chemin === "/artifacts/application.json"));
  assert.ok(PASSAGE_NOMME.length === 4, "quatre artefacts de VM en passage nommé");
});

test("les profils sont DÉDUPLIQUÉS et les en-têtes viennent de la table fournie, jamais d'ailleurs", () => {
  const reserve = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4 });
  const profilsDistincts = new Set(reserve.profils.map((profil) => JSON.stringify(profil)));
  assert.equal(profilsDistincts.size, reserve.profils.length);
  for (const [chemin, entree] of Object.entries(reserve.liste)) {
    assert.deepEqual(reserve.profils[entree.profil], entetesDe(chemin), chemin);
  }
});

test("l'IDENTITÉ est le SHA-256 de la liste canonique : elle ignore séquence, plancher et retrait, et bouge avec le moindre octet ou en-tête", () => {
  const base = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4, plancher: 0 });
  assert.match(base.identite, /^[0-9a-f]{64}$/);
  const autrePlancher = fabriquerLaReserve({
    fichiers: fichiers(),
    entetesDe,
    sequence: 4,
    plancher: 4,
  });
  assert.equal(
    autrePlancher.identite,
    base.identite,
    "un plancher relevé sur un contenu inchangé ne change pas l'identité",
  );
  const autreSequence = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 5 });
  assert.equal(autreSequence.identite, base.identite);
  const modifie = fichiers();
  modifie.set("/main.mjs", Buffer.from("export const A = 2;\n"));
  assert.notEqual(
    fabriquerLaReserve({ fichiers: modifie, entetesDe, sequence: 4 }).identite,
    base.identite,
  );
  const autresEntetes = (chemin) => ({ ...entetesDe(chemin), "X-Frame-Options": "SAMEORIGIN" });
  assert.notEqual(
    fabriquerLaReserve({ fichiers: fichiers(), entetesDe: autresEntetes, sequence: 4 }).identite,
    base.identite,
  );
  const sansUnFichier = fichiers();
  sansUnFichier.delete("/main.mjs");
  assert.notEqual(
    fabriquerLaReserve({ fichiers: sansUnFichier, entetesDe, sequence: 4 }).identite,
    base.identite,
  );
});

test("le SCRIPT embarque la liste, l'identité, la séquence et le plancher ; il est déterministe et sans point d'injection restant", () => {
  const a = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4, plancher: 2 });
  const b = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4, plancher: 2 });
  assert.equal(a.script, b.script, "même entrée, mêmes octets");
  assert.ok(!a.script.includes("/*__CONFIG__*/"));
  assert.equal(a.config.sequence, 4);
  assert.equal(a.config.plancher, 2);
  assert.equal(a.config.identite, a.identite);
  assert.deepEqual(a.config.liste, a.liste);
  assert.ok(a.script.includes(a.identite));
  assert.ok(a.script.includes(sha(Buffer.from("export const A = 1;\n"))));
});

test("le MODULE DE PAGE dit la séquence que la page attend, et rien de plus", () => {
  const reserve = fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 12 });
  assert.match(
    reserve.moduleDePage,
    /export const RESERVE_PUBLIEE = Object\.freeze\(\{ sequence: 12 \}\);/,
  );
  assert.equal(CHEMIN_DU_MODULE_DE_PAGE, "/coquille/reserve-publiee.mjs");
});

test("la séquence et le plancher sont des entiers positifs : un autre type est refusé", () => {
  for (const sequence of [0, -1, 1.5, "3", null, undefined, Number.NaN]) {
    assert.throws(
      () => fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence }),
      /séquence/,
      String(sequence),
    );
  }
  for (const plancher of [-1, 1.5, "3", null, Number.NaN]) {
    assert.throws(
      () => fabriquerLaReserve({ fichiers: fichiers(), entetesDe, sequence: 4, plancher }),
      /plancher/,
      String(plancher),
    );
  }
});

test("le script de RETRAIT est le même modèle, sans liste, marqué retrait, avec les anciens préfixes NOMMÉS", () => {
  const retrait = fabriquerLeScriptDeRetrait({ prefixesAnciens: ["coquille-v1-"] });
  assert.ok(retrait.includes('"retrait":true'));
  assert.ok(retrait.includes("coquille-v1-"));
  assert.ok(!retrait.includes("/*__CONFIG__*/"));
  assert.throws(() => fabriquerLeScriptDeRetrait({ prefixesAnciens: ["", "x"] }), /préfixe/);
});

test("le classement de chemins reconnaît la surprise : un chemin ni listé, ni exclu, ni en passage est INCONNU", () => {
  const classes = classerLesChemins([
    ...fichiers().keys(),
    "/vendor/v86/artefacts/v86-0123456789abcdef.wasm",
  ]);
  assert.deepEqual(classes.passage, ["/vendor/v86/artefacts/v86-0123456789abcdef.wasm"]);
  assert.deepEqual(classes.inconnus, []);
  assert.ok(classes.exclus.includes("/_headers") && classes.exclus.includes("/inventaire.json"));
  assert.ok(classes.exclus.includes(CHEMIN_DU_SW));
  assert.ok(classes.reserve.includes("/main.mjs"));
});

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
