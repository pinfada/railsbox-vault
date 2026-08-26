// Inventaire factuel des dépendances à l'isolation multi-origine (spike #41).
//
// Il répond à une question qu'aucune lecture de documentation ne remplace : QUI, dans ce dépôt et
// dans le v86 épinglé, a besoin de `crossOriginIsolated` ? Une capacité n'est réputée exigée que si
// quelque chose l'appelle. L'outil ne juge donc rien — il compte, et il nomme les fichiers.
//
// Deux sources sont lues :
//
//  - le CODE du dépôt (`src/`, `public/`, `tools/`, `tests/`, configurations), hors artefacts
//    tiers, dépendances et rapports ;
//  - les ARTEFACTS v86 épinglés (`vendor/v86/artefacts/`), récupérés par `npm run vm:fetch`. Pour
//    `v86.wasm` la lecture ne peut pas être textuelle : c'est la section « memory » du binaire qui
//    dit si le module réclame une mémoire PARTAGÉE, seule construction qui exigerait un
//    `SharedArrayBuffer` — donc l'isolation.
//
// Sortie : un tableau lisible sur la sortie standard, `reports/isolation/inventaire.json`, et un
// CODE DE SORTIE. Ce dernier est la garde de l'ADR 0010 : trouver une mémoire partagée fait échouer
// la commande, parce qu'une décision de ne rien faire ne reste falsifiable que si son instrument
// sait dire non. `--exiger-v86` transforme en outre l'absence d'artefacts en échec, pour les
// contextes — intégration continue, montée de version de v86 — où n'avoir rien lu n'est pas un
// succès.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import {
  CODES_DE_SORTIE,
  VERDICT_MEMOIRE_PARTAGEE,
  analyserWasm,
  codeDeSortie,
} from "./isolation-analyse-wasm.mjs";
import { ARTIFACT_DIRECTORY, REPOSITORY_ROOT } from "./v86-paths.mjs";

/** Jetons cherchés. Chacun est une manière distincte de dépendre de l'isolation. */
const JETONS = Object.freeze([
  "SharedArrayBuffer",
  "Atomics",
  "crossOriginIsolated",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Embedder-Policy",
  "measureUserAgentSpecificMemory",
]);

const RACINES = Object.freeze(["src", "public", "tools", "tests", "apps"]);
const FICHIERS_RACINE = Object.freeze([
  "playwright.config.mjs",
  "playwright.compat.config.mjs",
  "playwright.e2e.config.mjs",
  "playwright.vm.config.mjs",
  "playwright.isolation.config.mjs",
  "eslint.config.mjs",
  "package.json",
]);
// `.rb` et `.erb` ne sont pas décoratifs : l'application Rails de référence vit sous `apps/`, et
// c'est précisément le territoire applicatif qu'une isolation `require-corp` obligerait à servir
// COEP. Ne scanner que le JavaScript laisserait un usage côté Rails apparaître sans être vu.
const EXTENSIONS = new Set([".mjs", ".js", ".html", ".json", ".rb", ".erb"]);
const DOSSIERS_IGNORES = new Set(["node_modules", "artefacts", "tmp", "log", "var"]);

async function* fichiers(racine) {
  let entrees;
  try {
    entrees = await readdir(racine, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entree of entrees) {
    const chemin = join(racine, entree.name);
    if (entree.isDirectory()) {
      if (DOSSIERS_IGNORES.has(entree.name)) continue;
      yield* fichiers(chemin);
    } else if (EXTENSIONS.has(extname(entree.name))) {
      yield chemin;
    }
  }
}

async function inventorierCode() {
  const occurrences = [];
  const chemins = [];
  for (const racine of RACINES) {
    for await (const chemin of fichiers(join(REPOSITORY_ROOT, racine))) chemins.push(chemin);
  }
  for (const nom of FICHIERS_RACINE) chemins.push(join(REPOSITORY_ROOT, nom));

  for (const chemin of chemins) {
    let contenu;
    try {
      contenu = await readFile(chemin, "utf8");
    } catch {
      continue;
    }
    const lignes = contenu.split("\n");
    lignes.forEach((ligne, index) => {
      for (const jeton of JETONS) {
        if (!ligne.includes(jeton)) continue;
        occurrences.push({
          fichier: relative(REPOSITORY_ROOT, chemin).replaceAll("\\", "/"),
          ligne: index + 1,
          jeton,
          extrait: ligne.trim().slice(0, 160),
        });
      }
    });
  }
  return occurrences.sort(
    (a, b) =>
      a.fichier.localeCompare(b.fichier) || a.ligne - b.ligne || a.jeton.localeCompare(b.jeton),
  );
}

async function inventorierV86() {
  const cheminJs = join(ARTIFACT_DIRECTORY, "libv86.mjs");
  const cheminWasm = join(ARTIFACT_DIRECTORY, "v86.wasm");
  let source;
  let binaire;
  try {
    source = await readFile(cheminJs, "utf8");
    binaire = await readFile(cheminWasm);
  } catch {
    return {
      disponible: false,
      raison:
        "Artefacts v86 absents. Exécuter « npm run vm:fetch » : ils ne sont pas versionnés, ils sont vérifiés par empreinte.",
    };
  }

  const compter = (jeton) => source.split(jeton).length - 1;
  const analyse = analyserWasm(binaire);

  return {
    disponible: true,
    libv86: {
      octets: Buffer.byteLength(source),
      occurrences: Object.fromEntries(JETONS.map((jeton) => [jeton, compter(jeton)])),
    },
    wasm: { octets: binaire.length, ...analyse },
  };
}

/**
 * Agrégat par fichier. C'est cette vue-là que la documentation du spike publie : une liste de 96
 * lignes brutes ne se relit pas, et un tableau recopié à la main se périme au premier fichier
 * ajouté. Le compte total et le nombre de fichiers sont rendus avec, pour que toute citation soit
 * vérifiable par une seule commande.
 */
function agregerParFichier(occurrences) {
  const parFichier = new Map();
  for (const occurrence of occurrences) {
    if (!parFichier.has(occurrence.fichier)) {
      parFichier.set(occurrence.fichier, { occurrences: 0, jetons: new Set() });
    }
    const agregat = parFichier.get(occurrence.fichier);
    agregat.occurrences += 1;
    agregat.jetons.add(occurrence.jeton);
  }
  return [...parFichier]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fichier, agregat]) => ({
      fichier,
      occurrences: agregat.occurrences,
      jetons: [...agregat.jetons].sort(),
    }));
}

function afficher(inventaire) {
  const lignes = [];
  lignes.push("Inventaire des dépendances à l'isolation multi-origine (spike #41)");
  lignes.push("");
  lignes.push(
    `— Code du dépôt : ${inventaire.code.length} occurrences dans ${inventaire.parFichier.length} fichiers —`,
  );
  if (inventaire.parFichier.length === 0) {
    lignes.push("  aucune occurrence.");
  } else {
    for (const agregat of inventaire.parFichier) {
      lignes.push(
        `  ${String(agregat.occurrences).padStart(3)}  ${agregat.fichier}  ::  ${agregat.jetons.join(", ")}`,
      );
    }
  }
  lignes.push("");
  lignes.push("— v86 épinglé —");
  if (!inventaire.v86.disponible) {
    lignes.push(`  ${inventaire.v86.raison}`);
  } else {
    for (const [jeton, nombre] of Object.entries(inventaire.v86.libv86.occurrences)) {
      lignes.push(`  libv86.mjs  ${jeton} : ${nombre}`);
    }
    for (const memoire of inventaire.v86.wasm.memoiresDeclarees) {
      lignes.push(
        `  v86.wasm    mémoire déclarée : drapeaux ${memoire.drapeaux}, partagée=${memoire.partagee}, min=${memoire.pagesMinimum} pages, max=${memoire.pagesMaximum ?? "aucun"}`,
      );
    }
    lignes.push(
      `  v86.wasm    mémoires importées : ${inventaire.v86.wasm.memoiresImportees.length}`,
    );
    lignes.push(`  v86.wasm    mémoire partagée : ${inventaire.v86.wasm.memoirePartagee}`);
  }
  lignes.push("");
  lignes.push(`Rapport : ${inventaire.rapport}`);
  lignes.push("");
  lignes.push(`Verdict : ${verdict(inventaire)}`);
  process.stdout.write(`${lignes.join("\n")}\n`);
}

/**
 * Phrase du verdict. Elle dit ce que le code de sortie signifie, sur la sortie standard, pour que
 * l'échec d'une commande ne se lise pas comme une panne d'outil.
 */
function verdict(inventaire) {
  switch (inventaire.codeDeSortie) {
    case CODES_DE_SORTIE.memoirePartagee:
      // La phrase vit dans `isolation-analyse-wasm.mjs` : `npm run vm:check` la rend aussi (#75), et
      // deux formulations du même refus se seraient mises à diverger.
      return `ÉCHEC — ${VERDICT_MEMOIRE_PARTAGEE}`;
    case CODES_DE_SORTIE.artefactsAbsents:
      return "ÉCHEC — artefacts v86 exigés (--exiger-v86) et absents. Exécuter « npm run vm:fetch » : une garde qui n'a rien lu ne garde rien.";
    default:
      return inventaire.v86.disponible
        ? "aucune dépendance à l'isolation, et aucune mémoire WebAssembly partagée dans v86 épinglé."
        : "aucune dépendance à l'isolation dans le code. v86 non inventorié : artefacts absents, et non exigés.";
  }
}

const exigerV86 = process.argv.slice(2).includes("--exiger-v86");
const dossier = join(REPOSITORY_ROOT, "reports", "isolation");
await mkdir(dossier, { recursive: true });
const chemin = join(dossier, "inventaire.json");
const code = await inventorierCode();
const v86 = await inventorierV86();
const inventaire = {
  spike: 41,
  date: new Date().toISOString(),
  jetons: JETONS,
  exigerV86,
  code,
  parFichier: agregerParFichier(code),
  v86,
  codeDeSortie: codeDeSortie({ v86, exigerV86 }),
  rapport: relative(REPOSITORY_ROOT, chemin).replaceAll("\\", "/"),
};
await writeFile(chemin, `${JSON.stringify(inventaire, null, 2)}\n`);
afficher(inventaire);
// Le rapport est écrit AVANT de sortir en erreur : un échec doit laisser de quoi être diagnostiqué.
process.exitCode = inventaire.codeDeSortie;
