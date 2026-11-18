/**
 * Chaque mutant des campagnes `hors-ligne` et `magasin` porte sur du code que le PRODUIT exécute (#247, D1g ; revue
 * de #298, second tour, constat 2). Voir `tools/atteinte-des-gardes.mjs` : un mutant qui retire une garde que seule une
 * épreuve appelle est « tué » sans rien prouver du boot.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { atteinteDesMutations } from "../../tools/atteinte-des-gardes.mjs";
import { MUTATIONS as HORS_LIGNE } from "../../tools/muter-gardes-hors-ligne.mjs";
import { MUTATIONS as MAGASIN } from "../../tools/muter-gardes-magasin.mjs";

/** Les mutations de la FABRICATION du descripteur (`image:manifest`) : un outil, pas le navigateur. */
const OUTILS_ADMIS = new Set(["tools/build-reference-image/manifest.mjs"]);

for (const [campagne, mutations] of [
  ["hors-ligne", HORS_LIGNE],
  ["magasin", MAGASIN],
]) {
  test(`campagne ${campagne} : aucun mutant ne porte sur du code que seul un test appelle`, () => {
    const inertes = atteinteDesMutations(mutations)
      .map((atteinte, rang) => ({ ...atteinte, nom: mutations[rang].nom }))
      .filter(({ statut }) => statut === "inerte")
      .map(({ nom, declaration }) => `${nom} (${declaration ?? "déclaration introuvable"})`);
    assert.deepEqual(inertes, [], "des gardes mutées ne sont pas sur le chemin de production");
  });
}

test("les mutations d'outil sont celles de la fabrication du descripteur, et seulement elles", () => {
  const fichiers = [...HORS_LIGNE, ...MAGASIN]
    .map(({ fichier }) => fichier)
    .filter((fichier) => fichier.startsWith("tools/"));
  assert.ok(
    fichiers.every((fichier) => OUTILS_ADMIS.has(fichier)),
    fichiers.join(", "),
  );
});

test("le détecteur voit un mutant inerte : une fonction que seul un test appelait ne serait pas atteinte", () => {
  // `fabriquerDeLaFabrication` n'existe pas : un texte introuvable est « inerte », jamais « atteint ».
  const [verdict] = atteinteDesMutations([
    { fichier: "src/vm/acquisition-des-artefacts.mjs", avant: "texte qui n'existe nulle part" },
  ]);
  assert.equal(verdict.statut, "inerte");
});
