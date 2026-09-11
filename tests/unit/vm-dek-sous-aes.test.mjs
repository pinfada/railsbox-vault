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
//
// ## Ce qu'il balaie, depuis la revue de sécurité de la PR #186 (constat 2)
//
// Il ne balayait qu'un NOM — `importerCleDeVolume` —, et son titre annonçait pourtant une
// universelle. Un module qui écrivait `crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, …)`
// EN TOUTES LETTRES passait donc la CI sans un mot : le relevé du relecteur l'a montré par deux
// mutants, dont un seul était vu. Ce qui était faux n'était pas le GARANTI — il repose sur WebCrypto
// et il tient sur trois moteurs —, c'était la MESURE ; et c'est la forme même du défaut que la revue
// externe du 10 septembre avait trouvé : une phrase que rien ne mesure.
//
// Le balayage relève maintenant DEUX gestes, et son périmètre couvre `src/` ET `public/` :
//
//  1. tout appel à la PORTE nommée, `importerCleDeVolume` — l'inventaire d'origine ;
//  2. toute IMPORTATION DIRECTE d'une clé AES-GCM : `importKey(…)` dont les arguments, lus à
//     parenthèses équilibrées, nomment AES-GCM. Ce geste est plus rare que la porte, et il est plus
//     grave : il court-circuite le seul endroit du dépôt qui sache dire sous quelle clé un artefact
//     est scellé.
//
// Il reste un INVENTAIRE : il ne distingue pas un appel d'un réexport, et il relève la porte nommée
// jusque dans la prose. Cette distinction appartient au cliquet de T2b, qui lira les APPELS.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Les modules de `src/` et `public/` qui importent ENCORE une clé AES-GCM, avec leur échéance.
 *
 * `tranche` dit QUAND l'entrée disparaîtra, et ce n'est pas décoratif : une liste d'exceptions sans
 * échéance est une liste qui grandit. Aucune de ces huit n'est un oubli, et les deux premières
 * survivront à T2b : le MODÈLE de référence, qui est la spécification exécutable, et la SONDE de
 * plate-forme, qui n'a jamais vu la DEK.
 */
const PORTEURS_DE_LA_DEK = [
  {
    fichier: "src/compat/crypto-probes.mjs",
    tranche: "aucune",
    motif:
      "il SONDE la plate-forme : il importe une clé AES-GCM tirée d'un vecteur PUBLIÉ — jamais la " +
      "DEK, qu'il ne reçoit ni ne connaît — pour constater que le moteur tient AES-256-GCM et " +
      "HKDF avant qu'un volume ne soit ouvert. Il est relevé parce que le balayage cherche le " +
      "GESTE et non l'origine des octets, et l'inscrire dit cela plutôt que de raffiner un motif " +
      "jusqu'à ce qu'il laisse passer ce qu'on voulait voir.",
  },
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

/** La PORTE nommée : l'inventaire d'origine, celui de la tranche T2a. */
const PORTE_NOMMEE = /\bimporterCleDeVolume\b/;

/**
 * Rend le texte des arguments d'un appel commençant à `depart`, PARENTHÈSES équilibrées.
 *
 * L'équilibre compte : un appel d'importation porte un objet d'algorithme et un tableau d'usages, et
 * couper à la première parenthèse fermante lirait la moitié de l'appel. C'est le même geste que
 * `archive-appelants-de-l-export.test.mjs` fait sur les accolades, pour la même raison.
 */
function argumentsDeLAppel(texte, depart) {
  let profondeur = 0;
  for (let index = depart; index < texte.length; index += 1) {
    if (texte[index] === "(") profondeur += 1;
    else if (texte[index] === ")") {
      profondeur -= 1;
      if (profondeur === 0) return texte.slice(depart, index + 1);
    }
  }
  return texte.slice(depart);
}

/**
 * Les IMPORTATIONS DIRECTES d'une clé AES-GCM, relevées avec leurs arguments.
 *
 * L'algorithme est cherché dans les ARGUMENTS de l'appel, sous ses deux formes — la chaîne nue
 * `"AES-GCM"` et l'objet `{ name: … }`, y compris quand le nom vient d'une constante nommée
 * `ALGORITHME_WEBCRYPTO`. Un import HKDF n'est pas relevé, et c'est tout l'objet de la tranche :
 * c'est LUI qui rend la DEK incapable de chiffrer.
 */
function importationsAesGcm(source) {
  const code = sansCommentaires(source);
  const releves = [];
  for (const trouve of code.matchAll(/\bimportKey\s*\(/g)) {
    const ouvrante = code.indexOf("(", trouve.index);
    const arguments_ = argumentsDeLAppel(code, ouvrante);
    if (/AES-GCM|ALGORITHME_WEBCRYPTO/.test(arguments_)) releves.push(arguments_);
  }
  return releves;
}

/**
 * Retire les commentaires, et RIEN d'autre — pour ce geste-ci seulement.
 *
 * La porte NOMMÉE reste relevée dans la prose, et c'est voulu : c'est un inventaire. L'importation
 * DIRECTE, elle, ne peut pas l'être, parce que le module qui referme le trou —
 * `derivation/cle-de-domaine.mjs` — écrit le CONTRE-EXEMPLE dans son en-tête, en toutes lettres :
 * « `importKey("raw", dek, "AES-GCM", …)` » y est la ligne qu'on n'écrit plus. Un balayage
 * incapable de distinguer le code d'un contre-exemple ferait inscrire, parmi les porteurs de la
 * DEK, le seul module qui l'empêche d'en être un.
 */
function sansCommentaires(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Un module est relevé s'il emprunte l'un OU l'autre des deux gestes. */
function porteLaDek(source) {
  return PORTE_NOMMEE.test(source) || importationsAesGcm(source).length > 0;
}

/** Le CODE SERVI : `src/` et `public/`. Ce dernier n'était pas balayé du tout. */
const RACINES = ["src", "public"];

/** Tous les modules du périmètre, en chemins relatifs à barre oblique. */
async function modulesDuPerimetre() {
  const fichiers = [];
  for (const racine of RACINES) {
    const entrees = await readdir(path.join(REPO_ROOT, racine), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entree of entrees) {
      if (!entree.isFile() || !entree.name.endsWith(".mjs")) continue;
      const absolu = path.join(entree.parentPath ?? entree.path, entree.name);
      fichiers.push(path.relative(REPO_ROOT, absolu).replaceAll("\\", "/"));
    }
  }
  return fichiers.sort();
}

const modules = await modulesDuPerimetre();

test("l'inventaire porte sur un périmètre réel : `src/` ET `public/` sont relus", () => {
  assert.ok(modules.length > 50, `${modules.length} modules relevés`);
  assert.ok(
    modules.some((fichier) => fichier.startsWith("public/")),
    "`public/` n'est pas balayé : le code servi au navigateur échapperait à l'inventaire",
  );
});

test("AUCUN module hors inventaire ne passe la DEK à AES-GCM — porte nommée OU importKey direct", async () => {
  const inscrits = new Set(PORTEURS_DE_LA_DEK.map((entree) => entree.fichier));
  const coupables = [];
  for (const fichier of modules) {
    if (inscrits.has(fichier)) continue;
    if (porteLaDek(await readFile(path.join(REPO_ROOT, fichier), "utf8"))) coupables.push(fichier);
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
    if (!porteLaDek(contenu)) perimees.push(entree.fichier);
  }
  assert.deepEqual(perimees, [], "Ces inscriptions ne couvrent plus rien : retirez-les.");
});

test("chaque inscription porte une ÉCHÉANCE, et deux seulement survivront à T2b", () => {
  // Une liste d'exceptions sans échéance est une liste qui grandit. Celle-ci en a une par ligne, et
  // le compte de ce qui reste APRÈS T2b est épinglé ici : le modèle de référence, qui n'est pas un
  // chemin de production, et la SONDE de plate-forme, qui n'a jamais vu la DEK. Rien d'autre. Le
  // jour où T2b passe, cette épreuve dira ce qui manque.
  for (const entree of PORTEURS_DE_LA_DEK) {
    assert.match(entree.tranche, /^(aucune|T2b)$/, `${entree.fichier} : échéance hors vocabulaire`);
    assert.ok(entree.motif.length > 40, `${entree.fichier} : « c'est ainsi » n'est pas un motif`);
  }
  const apresT2b = PORTEURS_DE_LA_DEK.filter((entree) => entree.tranche === "aucune");
  assert.deepEqual(
    apresT2b.map((entree) => entree.fichier).sort(),
    ["src/compat/crypto-probes.mjs", "src/vm/format-chiffre/modele-reference.mjs"],
    "Après T2b, deux modules seulement : le MODÈLE de référence, et la SONDE de plate-forme. Ni " +
      "l'un ni l'autre n'est un chemin de production, et ni l'un ni l'autre ne reçoit la DEK.",
  );
});

test("le balayage MORD sur les DEUX mutants du relecteur, et pas seulement sur celui qui est nommé", () => {
  // **Un balayage à vide passe toujours.** Celui-ci est donc confronté aux deux modules que la revue
  // de sécurité de la PR #186 a fabriqués dans une copie de `src/` : le premier passe par la PORTE
  // nommée, le second importe la DEK en AES-GCM directement. Le cliquet d'origine ne voyait que le
  // premier, et son titre annonçait pourtant une universelle — « mutant B SEUL : VERT ».
  const parLaPorte = `import { importerCleDeVolume } from "./modele-reference.mjs";
export async function chiffrerSousLaDek(dek, clair) {
  const cle = await importerCleDeVolume(dek);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, cle, clair);
}`;
  const directement = `export async function chiffrerSousLaDek(dek, clair) {
  const cle = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, cle, clair);
}`;
  assert.ok(porteLaDek(parLaPorte), "le mutant A — la porte nommée — doit être relevé");
  assert.ok(
    porteLaDek(directement),
    "le mutant B — l'importation directe — doit être relevé AUSSI",
  );

  // Et il LAISSE PASSER ce qui est le sujet même de la tranche : un matériau HKDF ne chiffre rien,
  // et un module qui en importe un n'a rien à inscrire.
  const materiauHkdf = `crypto.subtle.importKey("raw", cleMaitresse, "HKDF", false, ["deriveKey"]);`;
  assert.equal(porteLaDek(materiauHkdf), false, "un import HKDF n'est pas un porteur de la DEK");

  // Les PARENTHÈSES sont équilibrées : couper à la première fermante lirait la moitié de l'appel et
  // manquerait l'algorithme, qui vient après un objet imbriqué.
  const imbrique = `crypto.subtle.importKey("raw", octets(dek), { name: "AES-GCM" }, false, ["encrypt"]);`;
  assert.ok(
    porteLaDek(imbrique),
    "un argument qui contient lui-même une parenthèse ne masque rien",
  );

  // La PROSE la nomme, et c'est voulu : ce cliquet-ci est un INVENTAIRE, pas une analyse. Il relève
  // donc aussi les commentaires, et c'est pourquoi il inscrit `instantane/modele-reference.mjs`
  // alors que ce module ne fait que réexporter. La distinction appartient au cliquet de T2b, qui
  // lira les APPELS et non le texte.
  assert.ok(porteLaDek("// la DEK n'est plus passée à importerCleDeVolume depuis #182"));
});
