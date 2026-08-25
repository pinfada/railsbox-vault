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
// Sortie : un tableau lisible sur la sortie standard et `reports/isolation/inventaire.json`.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

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

/**
 * Entier LEB128 non signé, avec la position d'arrivée.
 *
 * Le garde sur le décalage n'est pas de la superstition : `<<` et `|=` sont des opérateurs 32 bits
 * en JavaScript. Un varuint32 malformé de plus de cinq octets ferait reboucler le décalage modulo
 * 32 et rendrait un nombre plausible tiré d'octets qui n'en sont pas un. Un inventaire dont la
 * conclusion porte une décision d'architecture doit échouer bruyamment plutôt que deviner.
 */
function lireEntier(octets, position) {
  let resultat = 0;
  let decalage = 0;
  let octet;
  do {
    if (position >= octets.length) {
      throw new Error("Entier LEB128 tronqué : fin du module atteinte.");
    }
    if (decalage > 28) {
      throw new Error("Entier LEB128 malformé : plus de cinq octets pour un varuint32.");
    }
    octet = octets[position];
    position += 1;
    resultat |= (octet & 0x7f) << decalage;
    decalage += 7;
  } while (octet & 0x80);
  return { valeur: resultat >>> 0, position };
}

/**
 * Limites d'une mémoire WebAssembly. Le premier octet est un drapeau : le bit 0 signale la présence
 * d'un maximum, le **bit 1 signale une mémoire PARTAGÉE**. C'est ce bit-là, et lui seul, qui
 * rendrait `SharedArrayBuffer` — donc l'isolation multi-origine — nécessaire au module.
 */
function lireLimites(octets, position) {
  const drapeaux = octets[position];
  position += 1;
  const minimum = lireEntier(octets, position);
  position = minimum.position;
  let maximum = null;
  if (drapeaux & 0x01) {
    const lu = lireEntier(octets, position);
    maximum = lu.valeur;
    position = lu.position;
  }
  return {
    position,
    limites: {
      drapeaux: `0x${drapeaux.toString(16).padStart(2, "0")}`,
      partagee: Boolean(drapeaux & 0x02),
      pagesMinimum: minimum.valeur,
      pagesMaximum: maximum,
    },
  };
}

const TYPES_IMPORT = Object.freeze(["fonction", "table", "memoire", "global"]);

/** Sections « memory » et « import » d'un module WebAssembly, sans dépendance externe. */
/** `\0asm` puis la version, sur quatre octets chacun. */
const EN_TETE_WASM = Object.freeze([0x00, 0x61, 0x73, 0x6d]);
const VERSION_WASM = Object.freeze([0x01, 0x00, 0x00, 0x00]);

function analyserWasm(octets) {
  const debute = (attendu, decalage) =>
    attendu.every((valeur, index) => octets[decalage + index] === valeur);
  if (octets.length < 8 || !debute(EN_TETE_WASM, 0)) {
    throw new Error("Le fichier n'est pas un module WebAssembly.");
  }
  if (!debute(VERSION_WASM, 4)) {
    throw new Error(
      "Version de module WebAssembly inattendue : l'analyse des sections n'est pas garantie.",
    );
  }
  const memoires = [];
  const memoiresImportees = [];
  let position = 8;
  while (position < octets.length) {
    const identifiant = octets[position];
    position += 1;
    const taille = lireEntier(octets, position);
    position = taille.position;
    const finSection = position + taille.valeur;

    if (identifiant === 5) {
      let curseur = lireEntier(octets, position);
      const nombre = curseur.valeur;
      let p = curseur.position;
      for (let index = 0; index < nombre; index += 1) {
        const lu = lireLimites(octets, p);
        memoires.push(lu.limites);
        p = lu.position;
      }
    } else if (identifiant === 2) {
      let p = lireEntier(octets, position);
      const nombre = p.valeur;
      let curseur = p.position;
      for (let index = 0; index < nombre; index += 1) {
        const module = lireEntier(octets, curseur);
        curseur = module.position + module.valeur;
        const nom = lireEntier(octets, curseur);
        curseur = nom.position + nom.valeur;
        const genre = octets[curseur];
        curseur += 1;
        if (genre === 0x02) {
          const lu = lireLimites(octets, curseur);
          memoiresImportees.push(lu.limites);
          curseur = lu.position;
        } else if (genre === 0x00) {
          curseur = lireEntier(octets, curseur).position;
        } else if (genre === 0x01) {
          curseur += 1;
          curseur = lireLimites(octets, curseur).position;
        } else if (genre === 0x03) {
          curseur += 2;
        } else {
          throw new Error(`Genre d'import inconnu : ${genre} (${TYPES_IMPORT.join(", ")}).`);
        }
      }
    }
    position = finSection;
  }
  return { memoires, memoiresImportees };
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
  const { memoires, memoiresImportees } = analyserWasm(binaire);
  const partagee =
    memoires.some((memoire) => memoire.partagee) ||
    memoiresImportees.some((memoire) => memoire.partagee);

  return {
    disponible: true,
    libv86: {
      octets: Buffer.byteLength(source),
      occurrences: Object.fromEntries(JETONS.map((jeton) => [jeton, compter(jeton)])),
    },
    wasm: {
      octets: binaire.length,
      memoiresDeclarees: memoires,
      memoiresImportees,
      memoirePartagee: partagee,
    },
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
  process.stdout.write(`${lignes.join("\n")}\n`);
}

const dossier = join(REPOSITORY_ROOT, "reports", "isolation");
await mkdir(dossier, { recursive: true });
const chemin = join(dossier, "inventaire.json");
const code = await inventorierCode();
const inventaire = {
  spike: 41,
  date: new Date().toISOString(),
  jetons: JETONS,
  code,
  parFichier: agregerParFichier(code),
  v86: await inventorierV86(),
  rapport: relative(REPOSITORY_ROOT, chemin).replaceAll("\\", "/"),
};
await writeFile(chemin, `${JSON.stringify(inventaire, null, 2)}\n`);
afficher(inventaire);
