#!/usr/bin/env node
// Imprime l'empreinte de racine inscrite dans l'inventaire d'un arbre publié, et rien d'autre.
//
//   node tools/publier-empreinte.mjs artifacts/publication/coquille
//
// Un `node -e "… require(…) …"` ferait la même chose en une ligne de workflow. Il la ferait mal :
// le chemin devrait y être interpolé dans une chaîne de code, ce qui est exactement la construction
// que `tests/unit/workflows-sans-interpolation.test.mjs` interdit ailleurs. Ici le chemin est un
// ARGUMENT, jamais du code, et l'outil vérifie qu'il lit bien un inventaire de ce dépôt.

import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { CONTRAT_INVENTAIRE, FICHIER_INVENTAIRE } from "./publier-inventaire.mjs";

/** @param {string} brut contenu de `inventaire.json` */
export function lireEmpreinteDeRacine(brut) {
  const inventaire = JSON.parse(brut);
  if (inventaire?.contrat?.id !== CONTRAT_INVENTAIRE.id) {
    throw new Error(
      `Inventaire d'un autre contrat : ${inventaire?.contrat?.id ?? "aucun"} au lieu de ${CONTRAT_INVENTAIRE.id}.`,
    );
  }
  if (
    typeof inventaire.empreinteDeRacine !== "string" ||
    inventaire.empreinteDeRacine.length !== 64
  ) {
    throw new Error("L'inventaire ne porte pas d'empreinte de racine exploitable.");
  }
  return inventaire.empreinteDeRacine;
}

if (basename(process.argv[1] ?? "") === "publier-empreinte.mjs") {
  const arbre = process.argv[2];
  if (arbre === undefined) {
    process.stderr.write("Usage : node tools/publier-empreinte.mjs <arborescence>\n");
    process.exitCode = 3;
  } else {
    try {
      const brut = await readFile(join(resolve(arbre), FICHIER_INVENTAIRE), "utf8");
      process.stdout.write(lireEmpreinteDeRacine(brut));
    } catch (erreur) {
      process.stderr.write(`${erreur.message}\n`);
      process.exitCode = 2;
    }
  }
}
