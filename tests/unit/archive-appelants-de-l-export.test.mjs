/**
 * Les APPELANTS DE L'EXPORT nomment tous la clé (#181, ADR 0034).
 *
 * ## Pourquoi cette garde existe, et ce qu'elle a coûté avant d'exister
 *
 * Depuis #181, une archive de volume v3 porte un ENGAGEMENT scellé sous la clé du volume : c'est
 * lui qui empêche l'archive d'accepter un mélange de secteurs venus de plusieurs états. `writeArchive`
 * l'exige donc, et refuse bruyamment quand la clé manque.
 *
 * Ce refus est à l'EXÉCUTION. Il ne dit « pas par accident » que sur les chemins qu'une épreuve
 * emprunte — et un appelant a échappé à toutes : `verserLArchive`, dans le Worker de référence, ne
 * vit que dans un navigateur, et la suite unitaire ne le charge jamais. Il a fallu une course E2E
 * de trois minutes, et un boot de machine virtuelle, pour apprendre ce qu'un balayage de source
 * apprend en une seconde. C'est exactement le reproche que la revue de #102 avait déjà formulé
 * ailleurs : *une garde à l'exécution ne dit pas « personne »*.
 *
 * Ce fichier le dit, et il le MESURE : dans `src/`, `public/` et `tools/`, tout appel à
 * `writeArchive` ou à `exportVolumeToBytes` NOMME `cle`. Les épreuves, elles, sont hors périmètre —
 * plusieurs appellent SANS clé exprès, pour prouver le refus, et une garde qui les interdirait
 * interdirait de prouver ce qu'elle garde.
 *
 * La dernière épreuve vérifie que le balayage MORD : un appel fabriqué sans clé doit être relevé.
 * Sans elle, une expression régulière devenue muette passerait pour une propriété tenue.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Le périmètre : le produit et ses bancs. `tests/` en est exclu, et c'est délibéré — voir l'en-tête.
 */
const RACINES = ["src", "public", "tools"];

/** Les deux portes d'écriture d'une archive. La seconde n'est qu'une commodité au-dessus de la première. */
const ECRIVAINS = ["writeArchive", "exportVolumeToBytes"];

/** Tous les modules `.mjs` du périmètre, chemin relatif au dépôt, en séparateurs POSIX. */
async function modules() {
  const trouves = [];
  for (const racine of RACINES) {
    await parcourir(path.join(REPO_ROOT, racine), trouves);
  }
  return trouves.map((absolu) => path.relative(REPO_ROOT, absolu).split(path.sep).join("/"));
}

/** Descend un répertoire, sans suivre `node_modules` ni les artefacts. */
async function parcourir(repertoire, trouves) {
  for (const entree of await readdir(repertoire, { withFileTypes: true })) {
    if (entree.name === "node_modules" || entree.name.startsWith(".")) continue;
    const complet = path.join(repertoire, entree.name);
    if (entree.isDirectory()) await parcourir(complet, trouves);
    else if (entree.name.endsWith(".mjs")) trouves.push(complet);
  }
}

/**
 * Rend le texte de l'objet d'arguments d'un appel commençant à `depart`, accolades équilibrées.
 *
 * L'équilibre compte : un appel d'export tient sur une dizaine de lignes et contient lui-même des
 * objets (`consistency`, `manifest`). Couper à la première `}` lirait la moitié de l'appel et
 * déclarerait absente une clé écrite trois lignes plus bas.
 */
function objetDArguments(texte, depart) {
  let profondeur = 0;
  for (let i = depart; i < texte.length; i += 1) {
    if (texte[i] === "{") profondeur += 1;
    else if (texte[i] === "}") {
      profondeur -= 1;
      if (profondeur === 0) return texte.slice(depart, i + 1);
    }
  }
  return texte.slice(depart);
}

/**
 * Les appels d'écriture d'archive d'un fichier qui NE NOMMENT PAS `cle`.
 *
 * Une DÉCLARATION (`function exportVolumeToBytes({ … })`) n'est pas un appel : elle est reconnue au
 * mot-clé qui la précède, et écartée. Sans quoi le module qui définit la commodité se dénoncerait
 * lui-même, et la liste des exceptions grossirait pour rien.
 */
function appelsSansCle(source) {
  const releves = [];
  for (const ecrivain of ECRIVAINS) {
    const motif = new RegExp(`(function\\s+)?\\b${ecrivain}\\s*\\(\\s*\\{`, "g");
    for (const trouve of source.matchAll(motif)) {
      if (trouve[1] !== undefined) continue;
      const ouvrante = source.indexOf("{", trouve.index);
      const arguments_ = objetDArguments(source, ouvrante);
      if (!/(^|[\s,{])cle\s*[,:}]/.test(arguments_)) releves.push(ecrivain);
    }
  }
  return releves;
}

test("tout appel d'export du produit ou d'un banc NOMME la clé de l'engagement", async () => {
  const fautifs = [];
  for (const fichier of await modules()) {
    const source = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    for (const ecrivain of appelsSansCle(source)) fautifs.push(`${fichier} → ${ecrivain}`);
  }

  assert.deepEqual(
    fautifs,
    [],
    "une archive de volume v3 sans engagement n'existe pas : l'appelant doit passer la clé du " +
      "volume qu'il copie, jamais compter sur un refus à l'exécution pour l'apprendre",
  );
});

test("le balayage MORD : un appel fabriqué sans clé est relevé, et le même AVEC clé ne l'est pas", () => {
  const sansCle = `await writeArchive({
    source,
    sink,
    manifest: manifesteDuDescripteur(manifest, taille, volume),
    consistency: { kind: "handle-exclusif", detail: "…" },
    recovery,
    blockBytes,
  });`;
  assert.deepEqual(appelsSansCle(sansCle), ["writeArchive"], "l'appel sans clé doit être relevé");

  const avecCle = sansCle.replace("    recovery,", "    cle: cleDuBanc(),\n    recovery,");
  assert.deepEqual(appelsSansCle(avecCle), [], "le même appel, la clé nommée, ne l'est pas");

  const declaration = `export async function exportVolumeToBytes({ source, manifest, recovery }) {}`;
  assert.deepEqual(appelsSansCle(declaration), [], "une DÉCLARATION n'est pas un appel");
});
