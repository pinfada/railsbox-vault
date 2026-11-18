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
