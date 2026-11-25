/**
 * Dans une même page, le PORTAIL de la réserve n'est appelé qu'UNE fois (#299, ADR 0048 § 7 et critère 13c).
 *
 * Le critère 13c demandait « une nouvelle ouverture dans la même page, refusée après un changement de
 * contrôleur ». Le produit n'a aucun tel parcours : le Worker de confiance n'est créé que par
 * `creerCanalDeConfiance`, appelé UNE fois (`public/main.mjs`, au niveau du module) par le portail ; et
 * verrouiller, rouvrir après la mort du Worker et la préparation de la première visite RECHARGENT la page
 * (ADR 0031, décision 1) — un nouveau document, donc un nouvel état. « Réessayer », une phrase ou un code
 * faux, le déverrouillage passent par le canal DÉJÀ établi (`demanderAuWorker`), jamais par le portail.
 *
 * Cette épreuve est la GARDE de cette preuve : si un parcours qui rappelle le portail dans la même page
 * apparaît, elle rougit — et il faudra alors l'éprouver en E2E (zéro Worker, zéro requête de démarrage après
 * un changement de contrôleur) au lieu de s'en remettre à l'épreuve unitaire des portails successifs.
 * Elle compte des APPELS dans le code de production ; elle ne prétend pas prouver un comportement.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../../", import.meta.url));
const PERIMETRE = ["public/main.mjs", "public/coquille", "src/coquille", "src/vm"];

/** Les lignes de code (hors commentaires) de chaque fichier du périmètre : `[fichier, numéro, ligne]`. */
async function lignesDeCode() {
  const sortie = [];
  const lire = async (relatif) => {
    const absolu = path.join(RACINE, relatif);
    let entrees;
    try {
      entrees = await readdir(absolu, { withFileTypes: true });
    } catch {
      const lignes = (await readFile(absolu, "utf8")).split("\n");
      lignes.forEach((ligne, i) => {
        if (!/^\s*(\/\/|\*|\/\*)/.test(ligne)) sortie.push([relatif, i + 1, ligne]);
      });
      return;
    }
    for (const entree of entrees) {
      const enfant = path.posix.join(relatif, entree.name);
      if (entree.isDirectory()) await lire(enfant);
      else if (entree.name.endsWith(".mjs")) await lire(enfant);
    }
  };
  for (const relatif of PERIMETRE) await lire(relatif);
  return sortie;
}

const appels = (lignes, motif) => lignes.filter(([, , ligne]) => motif.test(ligne));

test("le Worker de confiance n'est construit qu'en UN endroit, appelé en UN endroit", async () => {
  const lignes = await lignesDeCode();
  assert.deepEqual(
    appels(lignes, /new Worker\([^)]*runtime-worker\.mjs/).map(([f]) => f),
    ["public/coquille/canal-de-confiance.mjs"],
  );
  const appelants = appels(lignes, /\bcreerCanalDeConfiance\(/).filter(
    ([f, , l]) => !(f === "public/coquille/canal-de-confiance.mjs" && /export function/.test(l)),
  );
  assert.deepEqual(
    appelants.map(([f]) => f),
    ["public/main.mjs"],
    "un seul appelant : le rappel passé au portail",
  );
});

test("le portail n'est ouvert qu'UNE fois, au niveau du module de la page — jamais depuis un geste ni un rappel", async () => {
  const lignes = await lignesDeCode();
  const ouvertures = appels(lignes, /\.ouvrir\(\)/).filter(
    ([f]) => f !== "src/vm/boot-de-reference.mjs",
  );
  assert.deepEqual(
    ouvertures.map(([f, , l]) => [f, l.trim()]),
    [["public/main.mjs", "pont.canal = await reserve.ouvrir();"]],
  );
  const portails = appels(lignes, /\bouvrirLePortail\(/).filter(
    ([f, , l]) => f !== "src/coquille/reserve-portail.mjs" || !/function|ouvrirLePortail:/.test(l),
  );
  assert.deepEqual(
    portails.map(([f]) => f),
    ["public/coquille/reserve-de-la-page.mjs"],
    "un seul appelant du portail : `ouvrir()` de la réserve de la page",
  );
});

test("verrouiller, rouvrir après la mort du Worker et la première visite RECHARGENT : un nouveau document", async () => {
  const lignes = await lignesDeCode();
  const recharges = appels(lignes, /location\.reload\(\)/).map(([f]) => f);
  assert.ok(
    recharges.includes("public/coquille/verrouillage-et-fins-d-onglet.mjs"),
    "verrouillage",
  );
  assert.ok(recharges.includes("public/coquille/cycle-de-la-page.mjs"), "« Rouvrir le coffre »");
  assert.ok(
    recharges.includes("public/coquille/reserve-de-la-page.mjs"),
    "préparation de la première visite",
  );
});
