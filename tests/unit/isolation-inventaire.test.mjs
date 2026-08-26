import assert from "node:assert/strict";
import test from "node:test";

import { analyserWasm, codeDeSortie } from "../../tools/isolation-analyse-wasm.mjs";
import {
  LIMITES_PARTAGEES,
  LIMITES_SIMPLES,
  moduleWasm,
  sectionImportMemoire,
  sectionMemoire,
} from "./fabrique-module-wasm.mjs";

// L'ADR 0010 décide de ne PAS imposer l'isolation multi-origine, et fait reposer cette décision sur
// un fait vérifiable : la mémoire WebAssembly de v86 épinglé n'est pas partagée. Il ajoute que la
// décision « doit rester falsifiable » et désigne `npm run isolation:inventaire` comme l'instrument
// de la falsification.
//
// Un instrument qui sort 0 quoi qu'il trouve ne falsifie rien. Ces épreuves exigent donc les deux
// moitiés de la garde :
//
//  1. l'analyseur sait répondre OUI. C'est le point aveugle d'un test qui n'exercerait que le cas
//     réel : sur un binaire non partagé, un parseur qui rendrait toujours `false` passerait. Il
//     faut un module fabriqué AVEC le drapeau partagé pour prouver que la détection existe ;
//  2. le verdict se traduit en code de sortie non nul. Sans cela, la garde est un commentaire.
//
// Les modules sont fabriqués plutôt que lus dans `vendor/` : une épreuve unitaire ne doit dépendre
// ni du réseau, ni d'artefacts tiers, et surtout elle doit pouvoir exhiber le cas que le dépôt ne
// contient pas. La fabrique vit dans `fabrique-module-wasm.mjs`, partagée avec l'épreuve de la
// garde branchée sur `npm run vm:check` (#75).

test("une mémoire déclarée non partagée est rendue telle quelle", () => {
  const analyse = analyserWasm(moduleWasm(sectionMemoire(LIMITES_SIMPLES)));

  assert.equal(analyse.memoirePartagee, false);
  assert.deepEqual(analyse.memoiresDeclarees, [
    { drapeaux: "0x00", partagee: false, pagesMinimum: 1, pagesMaximum: null },
  ]);
  assert.deepEqual(analyse.memoiresImportees, []);
});

test("une mémoire déclarée PARTAGÉE est détectée : l'analyseur sait répondre oui", () => {
  const analyse = analyserWasm(moduleWasm(sectionMemoire(LIMITES_PARTAGEES)));

  assert.equal(analyse.memoirePartagee, true);
  assert.deepEqual(analyse.memoiresDeclarees, [
    { drapeaux: "0x03", partagee: true, pagesMinimum: 1, pagesMaximum: 2 },
  ]);
});

test("une mémoire IMPORTÉE partagée est détectée aussi : la déclarer n'est pas la seule voie", () => {
  const analyse = analyserWasm(moduleWasm(sectionImportMemoire(LIMITES_PARTAGEES)));

  assert.equal(analyse.memoirePartagee, true);
  assert.deepEqual(analyse.memoiresImportees, [
    { drapeaux: "0x03", partagee: true, pagesMinimum: 1, pagesMaximum: 2 },
  ]);
  assert.deepEqual(analyse.memoiresDeclarees, []);
});

test("un fichier qui n'est pas un module WebAssembly est refusé, jamais interprété", () => {
  assert.throws(() => analyserWasm(Uint8Array.from([0x00, 0x61, 0x00, 0x00, 0, 0, 0, 0])), {
    message: /n'est pas un module WebAssembly/,
  });
});

test("une version de module inattendue est refusée : l'analyse des sections n'y est pas garantie", () => {
  const octets = moduleWasm(sectionMemoire(LIMITES_SIMPLES));
  octets[4] = 0x02;

  assert.throws(() => analyserWasm(octets), {
    message: /Version de module WebAssembly inattendue/,
  });
});

test("un entier LEB128 malformé échoue bruyamment plutôt que de rendre un nombre plausible", () => {
  // Six octets de continuation : au-delà de cinq, le décalage reboucle modulo 32 et rendrait un
  // nombre tiré d'octets qui n'en sont pas un.
  const octets = moduleWasm([5, 8, 1, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  assert.throws(() => analyserWasm(octets), { message: /LEB128 malformé/ });
});

test("un entier LEB128 tronqué par la fin du module échoue aussi", () => {
  const octets = moduleWasm([5, 3, 1, 0x00, 0x80]);

  assert.throws(() => analyserWasm(octets), { message: /LEB128 tronqué/ });
});

test("le code de sortie est nul quand aucune mémoire partagée n'est trouvée", () => {
  const v86 = { disponible: true, wasm: { memoirePartagee: false } };

  assert.equal(codeDeSortie({ v86, exigerV86: false }), 0);
  assert.equal(codeDeSortie({ v86, exigerV86: true }), 0);
});

test("une mémoire partagée fait sortir en erreur : c'est ce qui rend l'ADR 0010 falsifiable", () => {
  const v86 = { disponible: true, wasm: { memoirePartagee: true } };

  assert.notEqual(codeDeSortie({ v86, exigerV86: false }), 0);
  assert.notEqual(codeDeSortie({ v86, exigerV86: true }), 0);
});

test("des artefacts absents ne sont une erreur que si on les a exigés", () => {
  const v86 = { disponible: false, raison: "artefacts absents" };

  // Sans le drapeau, l'inventaire du code seul reste utile : un poste sans `npm run vm:fetch` doit
  // pouvoir le produire.
  assert.equal(codeDeSortie({ v86, exigerV86: false }), 0);
  // Avec, l'absence est un échec : une garde qui « passe » parce qu'elle n'a rien lu ne garde rien.
  assert.notEqual(codeDeSortie({ v86, exigerV86: true }), 0);
});
