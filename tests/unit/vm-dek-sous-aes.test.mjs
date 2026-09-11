import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CE QUI REÇOIT ENCORE LA DEK EN CLÉ AES, et ce qui ne le fait plus (#182, ADR 0033, décision 6).
//
// L'ADR 0033 écrit « la DEK n'est plus jamais passée à AES-GCM », et la tranche T2a ne la rend vraie
// qu'À MOITIÉ : les domaines du volume, du journal, de l'instantané et de l'archive scellent sous une
// clé dérivée, mais la page d'enveloppe et la section de récupération scellent encore sous elle.
// C'est la tranche **T2b** qui les livre, avec le CLIQUET définitif — une épreuve d'inspection de
// source qui refuse qu'un scellement reçoive la DEK, sur le modèle de `harnais-portes.test.mjs`.
//
// **Ce fichier est le cliquet PROVISOIRE, et il est écrit pour être remplacé.** Il ne refuse rien
// d'absolu : il tient l'INVENTAIRE de ce qui importe encore la DEK en clé AES-GCM, et il rougit dès
// qu'un module s'y ajoute. C'est la moitié qu'on peut tenir aujourd'hui, et la dire ainsi vaut mieux
// que d'écrire dans un ADR une phrase que rien ne mesure — c'est exactement ce que la revue externe
// du 10 septembre a trouvé.
//
// Ce qu'il ne remplace PAS : le GARANTI de la plate-forme, mesuré par
// `tests/browser/hierarchie-de-cles-frontiere.spec.mjs` sur les trois moteurs. Un inventaire dit qui
// appelle ; il ne dit pas ce que WebCrypto refuse.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Les modules de `src/` qui importent ENCORE une clé AES-GCM depuis la DEK, avec leur échéance.
 *
 * `tranche` dit QUAND l'entrée disparaîtra, et ce n'est pas décoratif : une liste d'exceptions sans
 * échéance est une liste qui grandit. Aucune de ces cinq n'est un oubli.
 */
const PORTEURS_DE_LA_DEK = [
  {
    fichier: "src/vm/format-chiffre/modele-reference.mjs",
    tranche: "aucune",
    motif:
      "il DÉFINIT `importerCleDeVolume`, et il est le modèle de référence de l'ADR 0015 : ses " +
      "vecteurs figés se rejouent sous une clé présentée telle quelle. Ce n'est pas un chemin de " +
      "production, c'est la spécification exécutable.",
  },
  {
    fichier: "src/vm/scellement.mjs",
    tranche: "T2b",
    motif:
      "le RÉGIME ANTÉRIEUR à la v4, nommé `#sousLaCleMaitresse` : la MIGRATION est le seul geste " +
      "du produit qui tienne les deux clés à la fois, et elle doit ouvrir les secteurs v3 sous la " +
      "DEK. C'est l'unique exception que le cliquet de T2b inscrira, avec sa raison à côté.",
  },
  {
    fichier: "src/vm/enveloppe-de-cle.mjs",
    tranche: "T2b",
    motif:
      "la racine d'une page de `<volume>.cles` est encore scellée sous la DEK (ADR 0020, " +
      "décision 3). Le domaine `enveloppe` et la page v2 sont le premier livrable de T2b.",
  },
  {
    fichier: "src/vm/enveloppe-de-recuperation.mjs",
    tranche: "T2b",
    motif:
      "la racine rescellée à l'export (ADR 0027) est encore scellée sous la DEK. Le domaine " +
      "`recuperation` est le troisième livrable de T2b.",
  },
  {
    fichier: "src/vm/enveloppe/etat-de-lenveloppe.mjs",
    tranche: "T2b",
    motif:
      "il OUVRE la racine d'une page d'enveloppe, donc sous la même clé que celle qui l'a scellée. " +
      "Il tombera avec le domaine `enveloppe`.",
  },
  {
    fichier: "src/vm/enveloppe/modele-reference.mjs",
    tranche: "T2b",
    motif: "il RÉEXPORTE `importerCleDeVolume` pour le modèle de l'enveloppe. Réexport, pas appel.",
  },
  {
    fichier: "src/vm/instantane/modele-reference.mjs",
    tranche: "T2b",
    motif:
      "il RÉEXPORTE `importerCleDeVolume` pour les vecteurs de l'instantané. Le chemin de " +
      "production, lui, dérive depuis #182 : plus aucune capture n'est scellée sous la DEK.",
  },
];

const MOTIF = /\bimporterCleDeVolume\b/;

/** Tous les modules de `src/`, en chemins relatifs à barre oblique. */
async function modulesDeSrc() {
  const entrees = await readdir(path.join(REPO_ROOT, "src"), {
    recursive: true,
    withFileTypes: true,
  });
  const fichiers = [];
  for (const entree of entrees) {
    if (!entree.isFile() || !entree.name.endsWith(".mjs")) continue;
    const absolu = path.join(entree.parentPath ?? entree.path, entree.name);
    fichiers.push(path.relative(REPO_ROOT, absolu).replaceAll("\\", "/"));
  }
  return fichiers.sort();
}

const modules = await modulesDeSrc();

test("l'inventaire porte sur un périmètre réel : `src/` est relu, et il n'est pas vide", () => {
  assert.ok(modules.length > 50, `${modules.length} modules relevés sous src/`);
});

test("AUCUN module de `src/` hors inventaire n'importe la DEK en clé AES-GCM", async () => {
  const inscrits = new Set(PORTEURS_DE_LA_DEK.map((entree) => entree.fichier));
  const coupables = [];
  for (const fichier of modules) {
    if (inscrits.has(fichier)) continue;
    if (MOTIF.test(await readFile(path.join(REPO_ROOT, fichier), "utf8"))) coupables.push(fichier);
  }
  assert.deepEqual(
    coupables,
    [],
    "Ces modules passent la clé MAÎTRESSE à AES-GCM. Depuis l'ADR 0033, un scellement scelle sous " +
      "une clé DÉRIVÉE ; si un chemin a vraiment besoin de l'autre, il demande un ADR, pas une " +
      "ligne de liste.",
  );
});

test("les inscriptions sont à jour : aucune ne couvre un module qui a cessé de l'appeler", async () => {
  const perimees = [];
  for (const entree of PORTEURS_DE_LA_DEK) {
    const contenu = await readFile(path.join(REPO_ROOT, entree.fichier), "utf8");
    if (!MOTIF.test(contenu)) perimees.push(entree.fichier);
  }
  assert.deepEqual(perimees, [], "Ces inscriptions ne couvrent plus rien : retirez-les.");
});

test("chaque inscription porte une ÉCHÉANCE, et une seule survivra à T2b", () => {
  // Une liste d'exceptions sans échéance est une liste qui grandit. Celle-ci en a une par ligne, et
  // le compte de ce qui reste APRÈS T2b est épinglé ici : le modèle de référence, qui n'est pas un
  // chemin de production, et rien d'autre. Le jour où T2b passe, cette épreuve dira ce qui manque.
  for (const entree of PORTEURS_DE_LA_DEK) {
    assert.match(entree.tranche, /^(aucune|T2b)$/, `${entree.fichier} : échéance hors vocabulaire`);
    assert.ok(entree.motif.length > 40, `${entree.fichier} : « c'est ainsi » n'est pas un motif`);
  }
  const apresT2b = PORTEURS_DE_LA_DEK.filter((entree) => entree.tranche === "aucune");
  assert.deepEqual(
    apresT2b.map((entree) => entree.fichier),
    ["src/vm/format-chiffre/modele-reference.mjs"],
    "Après T2b, un seul module doit encore définir l'importation d'une clé de volume : le MODÈLE.",
  );
});

test("le balayage MORD : un module inventé qui appellerait la porte serait relevé", () => {
  // Un balayage à vide passe toujours. Celui-ci est donc confronté au texte qu'il doit refuser et à
  // celui qu'il doit laisser passer — la PROSE des modules, qui nomme abondamment `importerCleDeVolume`
  // sans jamais l'appeler.
  assert.ok(MOTIF.test("const cle = await importerCleDeVolume(dek);"));
  assert.ok(MOTIF.test('import { importerCleDeVolume } from "./modele-reference.mjs";'));
  // La prose la nomme, et c'est voulu : ce cliquet-ci est un INVENTAIRE, pas une analyse. Il relève
  // donc aussi les commentaires, et c'est pourquoi il inscrit `instantane/modele-reference.mjs`
  // alors que ce module ne fait que réexporter. La distinction appartient au cliquet de T2b, qui
  // lira les APPELS et non le texte.
  assert.ok(MOTIF.test("// la DEK n'est plus passée à importerCleDeVolume depuis #182"));
});
