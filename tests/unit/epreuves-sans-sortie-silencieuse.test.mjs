import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CLIQUET (revue complète de la PR #305) : aucune épreuve ne sort avec SUCCÈS parce que la PAGE affiche
// un écran « stockage inaccessible » ou un état `indetermine`. Une sortie pareille, sur TOUS les moteurs,
// transforme en réussite précisément le défaut qu'une épreuve est là pour attraper. La seule exception est
// le contexte WebKit éphémère mesuré, déclaré par la FIXTURE — `test.skip(browserName === "webkit", …)`
// visible au rapport —, avec un chemin séparé qui VÉRIFIE l'écran inaccessible.
//
// Le cliquet lit les sources des épreuves : une condition sur ce que la page affiche (`=== "inaccessible"`,
// `=== "indetermine"`, `etat === …`) suivie, dans les huit lignes, d'un `return` est refusée.

const RACINE = fileURLToPath(new URL("../../tests/", import.meta.url));

async function sources(dossier) {
  const rendu = [];
  for (const entree of await readdir(dossier, { withFileTypes: true })) {
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) rendu.push(...(await sources(chemin)));
    else if (/\.(spec|mjs)$/.test(entree.name) && !chemin.includes(`${path.sep}unit${path.sep}`)) {
      rendu.push(chemin);
    }
  }
  return rendu;
}

const CONDITION_SUR_LA_PAGE =
  /(?:inaccessible\.isVisible\(|===|!==|\.includes\()\s*\(?\s*(?:"inaccessible"|"indetermine"|ETATS_DU_VOLUME\.indetermine|ETATS_SANS_VOLUME|etatsSansVolume)|(?:"inaccessible"|"indetermine")\s*\)\s*\{?\s*$/;

test("aucune épreuve ne sort par `return` sur ce que la page affiche : écran inaccessible, état indéterminé", async () => {
  const fautes = [];
  for (const chemin of await sources(RACINE)) {
    const lignes = (await readFile(chemin, "utf8")).split("\n");
    lignes.forEach((ligne, index) => {
      if (!/^\s*(if|\}\s*else if)\b/.test(ligne) || !CONDITION_SUR_LA_PAGE.test(ligne)) return;
      const suite = lignes.slice(index, index + 9).join("\n");
      if (/\breturn\b/.test(suite) && !/\breturn (false|true|expect|await|\w+\()/.test(suite)) {
        fautes.push(`${path.relative(RACINE, chemin)}:${index + 1} : ${ligne.trim()}`);
      }
    });
  }
  assert.deepEqual(fautes, [], "une sortie silencieuse sur ce que la page affiche");
});

// ---------------------------------------------------------------------------------------------------
// Revue de la PR #305 (relecteur 2) : les sorties INDIRECTES. Une épreuve qui fait
// `if (await exigerLaLimiteDuMoteur(page)) return;` sort par un utilitaire dont la condition est
// l'ÉTAT lu sur la page : sur Chromium et Firefox, un volume « indisponible » faisait alors réussir
// l'épreuve sans ses assertions. Trois règles, éprouvées ensemble :
//
// 1. les assistants de `tests/support/refus-de-capacite.mjs` sont liés au MOTEUR de la fixture :
//    Chromium et Firefox n'admettent AUCUN état « sans volume » ;
// 2. toute sortie `if (await F(…)) return` passe par une fonction `F` dont le corps pose d'abord la
//    porte du moteur (`moteurDe(page)` ou `browserName`) ;
// 3. aucune ligne de test ne lit `etatsSansVolume` pour DÉCIDER (condition, valeur rendue) sans porte du
//    moteur : hors d'un `expect(…)`, la mention est refusée.

const PORTE_DU_MOTEUR = /moteurDe\(|browserName|test\.skip\(/;

async function fonctionsDeclarees() {
  const rendu = new Map();
  for (const chemin of await sources(RACINE)) {
    const lignes = (await readFile(chemin, "utf8")).split("\n");
    lignes.forEach((ligne, index) => {
      const m = /^(?:export )?(?:async )?function (\w+)\(/.exec(ligne);
      if (!m) return;
      let fin = index;
      while (fin < lignes.length && !/^}/.test(lignes[fin])) fin += 1;
      rendu.set(`${chemin}:${m[1]}`, { chemin, corps: lignes.slice(index, fin + 1).join("\n") });
    });
  }
  return rendu;
}

test("les assistants de capacité n'admettent AUCUN état sans volume sous Chromium ni Firefox", async () => {
  const { etatsSansVolume } = await import("../support/refus-de-capacite.mjs");
  const fausse = (moteur) => ({
    context: () => ({ browser: () => ({ browserType: () => ({ name: () => moteur }) }) }),
  });
  assert.deepEqual(etatsSansVolume(fausse("chromium")), [], "Chromium : aucun état sans volume");
  assert.deepEqual(etatsSansVolume(fausse("firefox")), [], "Firefox : aucun état sans volume");
  assert.notDeepEqual(etatsSansVolume(fausse("webkit")), [], "WebKit éphémère : la limite écrite");
});

test("une sortie `if (await F(…)) return` passe par une fonction qui pose la porte du moteur D'ABORD", async () => {
  const fonctions = await fonctionsDeclarees();
  const fautes = [];
  for (const chemin of await sources(RACINE)) {
    const lignes = (await readFile(chemin, "utf8")).split("\n");
    lignes.forEach((ligne, index) => {
      const m = /^\s*if \(await (\w+)\(.*\)\) return;/.exec(ligne);
      if (!m) return;
      const definition = fonctions.get(`${chemin}:${m[1]}`);
      const corps = definition?.corps ?? "";
      const avantLaLecture = corps.split(/releve\(|etatsSansVolume\(/)[0];
      if (!PORTE_DU_MOTEUR.test(avantLaLecture)) {
        fautes.push(`${path.relative(RACINE, chemin)}:${index + 1} : ${ligne.trim()} (${m[1]})`);
      }
    });
  }
  assert.deepEqual(fautes, [], "une sortie par un utilitaire que le moteur ne conditionne pas");
});

test("aucune ligne de test ne lit `etatsSansVolume` pour décider sans porte du moteur", async () => {
  const fautes = [];
  for (const chemin of await sources(RACINE)) {
    if (chemin.endsWith(`${path.sep}refus-de-capacite.mjs`)) continue;
    const lignes = (await readFile(chemin, "utf8")).split("\n");
    lignes.forEach((ligne, index) => {
      if (!/\b(?:etatsSansVolume|ETATS_SANS_VOLUME)\b/.test(ligne)) return;
      // Les spécificateurs d'un `import { … }` coupé sur plusieurs lignes ne décident de rien.
      if (/^\s*(?:import\b|\/\/|\*|\w+,\s*$)/.test(ligne)) return;
      if (/\bexpect\(|\bexpect\s*$/.test(ligne) || PORTE_DU_MOTEUR.test(ligne)) return;
      // Les arguments d'un `expect(` coupé sur deux lignes : la mention suit un `expect([`.
      const precedente = lignes[index - 1] ?? "";
      if (/\bexpect\(\s*$/.test(precedente)) return;
      fautes.push(`${path.relative(RACINE, chemin)}:${index + 1} : ${ligne.trim()}`);
    });
  }
  assert.deepEqual(fautes, [], "un état sans volume décide d'un chemin sans porte du moteur");
});
