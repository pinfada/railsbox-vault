/**
 * Le CLIQUET ANTI-DEK, définitif : aucun scellement du produit ne reçoit la clé maîtresse
 * (#182, T2b ; ADR 0033, décision 6 ; ADR 0036).
 *
 * ## Ce qu'il remplace, et pourquoi celui-ci n'est plus un inventaire
 *
 * La tranche T2a a posé un cliquet PROVISOIRE (`vm-dek-sous-aes.test.mjs`) écrit pour être remplacé :
 * il tenait l'INVENTAIRE des modules qui importaient encore la DEK en clé AES-GCM, et rougissait
 * quand un module s'y ajoutait. Il relevait le nom de la porte jusque dans la prose, et ne
 * distinguait pas un APPEL d'un réexport — huit inscriptions, dont cinq n'étaient que des mentions.
 *
 * Celui-ci lit les APPELS. Il ne dit plus « voici qui la touche encore », il dit **« plus personne
 * ne scelle sous elle »**, et la liste de ce qui reste tient en quatre lignes : trois modules qui ne
 * sont pas des chemins de production du format v4, et un régime HÉRITÉ que la migration seule
 * emprunte.
 *
 * ## Les deux motifs, et pourquoi il en faut deux
 *
 *  1. **la PORTE nommée** — un appel à `importerCleDeVolume(…)`, la seule fonction du dépôt qui
 *     construise une `CryptoKey` AES-GCM à partir des octets d'une clé de volume. C'est le geste
 *     ordinaire, et c'est celui qu'un chemin distrait emprunterait ;
 *  2. **l'IMPORTATION DIRECTE** — un appel à `importKey(…)` dont les arguments, lus à parenthèses
 *     équilibrées, nomment AES-GCM. C'est le geste RARE, et il est plus grave : il court-circuite le
 *     seul endroit du dépôt qui sache dire sous quelle clé un artefact est scellé. La revue de
 *     sécurité de la PR #186 l'avait fabriqué en mutant, et le cliquet d'alors ne le voyait pas.
 *
 * Un import **HKDF** n'est jamais relevé, et c'est tout l'objet de la tranche : c'est lui qui rend
 * la DEK incapable de chiffrer, par la spécification WebCrypto et non par une revue.
 *
 * ## Ce qu'il ne remplace PAS
 *
 * Le GARANTI de la plate-forme, mesuré sur les trois moteurs par
 * `tests/browser/hierarchie-de-cles-frontiere.spec.mjs`, et le COMPTE d'`encrypt` par clé sur une
 * session complète, mesuré par `vm-budget-par-domaine.test.mjs`. Une inspection de source dit qui
 * APPELLE ; elle ne dit ni ce que WebCrypto refuse, ni ce qu'une session consomme réellement.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Le CODE SERVI : `src/` et `public/`. Un chemin de production vit dans l'un des deux. */
const RACINES = ["src", "public"];

/**
 * Les CINQ endroits du dépôt où une clé AES-GCM est construite depuis des octets bruts, et ce que
 * chacun tient dans la main.
 *
 * `matiere` dit de QUELS octets il s'agit, et c'est le seul champ qui décide de la propriété :
 *
 *  - `dek` — une clé de VOLUME. C'est le sujet de #182, et la liste de ceux-là est ce que ce
 *    fichier verrouille ;
 *  - `kek` — une clé de DÉVERROUILLAGE (ADR 0020). Elle est AES-GCM par construction, elle n'est
 *    pas dérivée de la DEK, elle en enveloppe une. Rien de ce que #182 corrige ne la concerne ;
 *  - `vecteur` — des octets PUBLIÉS, qui ne sont la clé de rien.
 *
 * `role` dit pourquoi une matière `dek` subsiste, et il n'y a que deux réponses admises :
 *
 *  - `modele` — une spécification exécutable, dont les vecteurs figés se rejouent sous une clé
 *    présentée telle quelle. Ce n'est pas un chemin de production ;
 *  - `lecture-heritee` — un format ANTÉRIEUR à la v4, dont les octets ont été scellés sous la DEK
 *    et ne se relisent que sous elle. Chacun est atteignable par un seul chemin, nommé.
 *
 * **Aucune entrée ne porte `production`, et c'est la propriété que ce fichier mesure.** Le jour où
 * un chemin de production du format v4 aurait besoin de la DEK, il demanderait un ADR, pas une ligne
 * de liste.
 */
const IMPORTS_DE_CLE_AES = [
  {
    fichier: "src/compat/crypto-probes.mjs",
    matiere: "vecteur",
    role: null,
    scelle: true,
    motif:
      "il SONDE la plate-forme : il importe une clé AES-GCM tirée d'un vecteur PUBLIÉ — jamais la " +
      "DEK, qu'il ne reçoit ni ne connaît — pour constater que le moteur tient AES-256-GCM et " +
      "HKDF avant qu'un volume ne soit ouvert. Il est relevé parce que le balayage cherche le " +
      "GESTE et non l'origine des octets, et l'inscrire dit cela plutôt que de raffiner un motif " +
      "jusqu'à ce qu'il laisse passer ce qu'on voulait voir.",
  },
  {
    fichier: "src/vm/enveloppe/modele-reference.mjs",
    matiere: "kek",
    role: null,
    scelle: true,
    motif:
      "il importe une clé de DÉVERROUILLAGE — `importerCleDeDeverrouillage` —, celle qui ENVELOPPE " +
      "la DEK dans un emplacement (ADR 0020). Une KEK est une clé AES-GCM par construction et ne " +
      "descend pas de la clé maîtresse : la séparation par domaine de #182 ne la concerne pas. Il " +
      "RÉEXPORTE par ailleurs `importerCleDeVolume` sans jamais l'appeler.",
  },
  {
    fichier: "src/vm/format-chiffre/modele-reference.mjs",
    matiere: "dek",
    role: "modele",
    scelle: true,
    motif:
      "il DÉFINIT `importerCleDeVolume`, et il est le modèle de référence de l'ADR 0015 : ses " +
      "vecteurs figés se rejouent sous une clé présentée telle quelle. Ce n'est pas un chemin de " +
      "production, c'est la spécification exécutable.",
  },
  {
    fichier: "src/vm/scellement.mjs",
    matiere: "dek",
    role: "lecture-heritee",
    scelle: true,
    motif:
      "le RÉGIME ANTÉRIEUR à la v4, nommé `#sousLaCleMaitresse` : un volume v3 n'a pas de clé " +
      "maîtresse, ses secteurs sont scellés sous la DEK elle-même. Deux chemins l'empruntent, et " +
      "deux seulement — la MIGRATION v3 vers v4, et l'EXPORT d'un v3 avant sa migration, qui passe " +
      "par le même lecteur (`migration-source-chiffree.mjs`). Ouvrir un tel volume fait écrire au " +
      "magasin une racine v3 : c'est pourquoi cette entrée SCELLE encore, là où la lecture d'une " +
      "page d'enveloppe v1 ne le fait plus.",
  },
  {
    fichier: "src/vm/enveloppe/page-v1-lecture.mjs",
    matiere: "dek",
    role: "lecture-heritee",
    scelle: false,
    motif:
      "la racine d'une page d'enveloppe v1 est scellée sous la DEK (ADR 0020, décision 3, avant " +
      "T2b). Elle doit rester lisible jusqu'à ce que la page v2 soit écrite ET relue, sans quoi " +
      "une coupure pendant la migration de page coûterait le volume. La clé y est importée avec " +
      "le seul usage « decrypt » : ce module ne PEUT pas sceller, et c'est WebCrypto qui le tient.",
  },
];

/** La PORTE nommée, APPELÉE : `importerCleDeVolume(` — ni un import, ni un réexport, ni la prose. */
const APPEL_DE_LA_PORTE = /\bimporterCleDeVolume\s*\(/;

/** La DÉFINITION de la porte. Le module qui l'écrit fait le geste, quel que soit le nom du matériau. */
const DEFINITION_DE_LA_PORTE = /function\s+importerCleDeVolume\b/;

/**
 * Les noms sous lesquels une clé de VOLUME circule dans ce dépôt.
 *
 * Le balayage est BROAD sur `importKey` — tout import AES-GCM est relevé, et doit être inscrit —,
 * et c'est ce champ qui dit ensuite de quelle matière il s'agit. Un import dont le matériau porte
 * l'un de ces noms est une clé de volume ; les deux autres matières sont inscrites nommément.
 */
const NOMS_DE_LA_DEK = /\b(dek|DEK|cleDeVolume|cleDuVolume|cleMaitresse|CLE_DE_TEST)\b/;

/**
 * Rend le texte des arguments d'un appel commençant à `depart`, PARENTHÈSES équilibrées.
 *
 * L'équilibre compte : un appel d'importation porte un objet d'algorithme et un tableau d'usages, et
 * couper à la première parenthèse fermante lirait la moitié de l'appel.
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
 * `"AES-GCM"` et l'objet `{ name: … }`, y compris quand le nom vient de la constante
 * `ALGORITHME_WEBCRYPTO`. Un import HKDF n'est jamais relevé, et c'est tout l'objet de la tranche :
 * c'est lui qui rend la DEK incapable de chiffrer.
 */
function importationsAesGcm(code) {
  const releves = [];
  for (const trouve of code.matchAll(/\bimportKey\s*\(/g)) {
    const ouvrante = code.indexOf("(", trouve.index);
    const arguments_ = argumentsDeLAppel(code, ouvrante);
    if (/AES-GCM|ALGORITHME_WEBCRYPTO/.test(arguments_)) releves.push(arguments_);
  }
  return releves;
}

/**
 * Retire les commentaires, et RIEN d'autre.
 *
 * Ce cliquet lit du CODE. Deux modules écrivent le CONTRE-EXEMPLE dans leur en-tête, en toutes
 * lettres — « `importKey("raw", dek, "AES-GCM", …)` y est la ligne qu'on n'écrit plus » : un
 * balayage incapable de distinguer le code d'un contre-exemple ferait inscrire, parmi les porteurs
 * de la DEK, les seuls modules qui l'empêchent d'en être un.
 */
function sansCommentaires(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Ce qu'un module fait d'une clé brute : rien, ou l'un des trois gestes relevés. */
function gestesReleves(source) {
  const code = sansCommentaires(source);
  const imports = importationsAesGcm(code);
  const porte = APPEL_DE_LA_PORTE.test(code) || DEFINITION_DE_LA_PORTE.test(code);
  return {
    porte,
    imports,
    // La MATIÈRE : une porte de clé de volume, ou un import dont le matériau porte l'un des noms
    // sous lesquels une DEK circule. Un import d'une autre matière est relevé aussi — il doit être
    // inscrit —, mais il n'entre pas dans la propriété que #182 verrouille.
    toucheLaDek: porte || imports.some((appel) => NOMS_DE_LA_DEK.test(appel)),
    // Une clé importée SANS l'usage « encrypt » ne peut pas sceller : WebCrypto rejette
    // `crypto.subtle.encrypt` pour elle. C'est la garantie de la décision 6 de l'ADR 0033,
    // appliquée un cran plus bas.
    scelle: porte || imports.some((appel) => /"encrypt"/.test(appel)),
  };
}

/** Un module est relevé s'il emprunte l'un des gestes. */
function porteLaDek(source) {
  const gestes = gestesReleves(source);
  return gestes.porte || gestes.imports.length > 0;
}

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

test("le cliquet porte sur un périmètre réel : `src/` ET `public/` sont relus", () => {
  assert.ok(modules.length > 50, `${modules.length} modules relevés`);
  assert.ok(
    modules.some((fichier) => fichier.startsWith("public/")),
    "`public/` n'est pas balayé : le code servi au navigateur échapperait au cliquet",
  );
});

test("AUCUN module hors de la liste ne construit de clé AES-GCM depuis des octets bruts", async () => {
  const inscrits = new Set(IMPORTS_DE_CLE_AES.map((entree) => entree.fichier));
  const coupables = [];
  for (const fichier of modules) {
    if (inscrits.has(fichier)) continue;
    if (porteLaDek(await readFile(path.join(REPO_ROOT, fichier), "utf8"))) coupables.push(fichier);
  }
  assert.deepEqual(
    coupables,
    [],
    "Ces modules construisent une clé AES-GCM depuis une clé de volume. Depuis l'ADR 0033, un " +
      "scellement scelle sous une clé DÉRIVÉE par domaine ; si un chemin a vraiment besoin de " +
      "l'autre, il demande un ADR, pas une ligne de liste.",
  );
});

test("les inscriptions sont à jour : aucune ne couvre un module qui a cessé de le faire", async () => {
  const perimees = [];
  for (const entree of IMPORTS_DE_CLE_AES) {
    const contenu = await readFile(path.join(REPO_ROOT, entree.fichier), "utf8");
    if (!porteLaDek(contenu)) perimees.push(entree.fichier);
  }
  assert.deepEqual(perimees, [], "Ces inscriptions ne couvrent plus rien : retirez-les.");
});

test("ce qui touche la DEK se compte sur trois doigts, et aucun n'est un chemin v4", () => {
  // Une liste d'exceptions sans nature est une liste qui grandit. Les deux rôles admis sont écrits
  // en tête de ce fichier, et « production » n'en fait pas partie : c'est là toute la tranche.
  for (const entree of IMPORTS_DE_CLE_AES) {
    assert.match(entree.matiere, /^(dek|kek|vecteur)$/, `${entree.fichier} : matière inconnue`);
    assert.equal(
      entree.role === null,
      entree.matiere !== "dek",
      `${entree.fichier} : un import de matière « dek » porte un rôle, les autres n'en portent pas`,
    );
    if (entree.role !== null) {
      assert.match(
        entree.role,
        /^(modele|lecture-heritee)$/,
        `${entree.fichier} : rôle hors vocabulaire`,
      );
    }
    assert.ok(entree.motif.length > 80, `${entree.fichier} : « c'est ainsi » n'est pas un motif`);
  }
  assert.deepEqual(
    IMPORTS_DE_CLE_AES.filter((entree) => entree.matiere === "dek")
      .map((entree) => entree.fichier)
      .sort(),
    [
      "src/vm/enveloppe/page-v1-lecture.mjs",
      "src/vm/format-chiffre/modele-reference.mjs",
      "src/vm/scellement.mjs",
    ],
    "Trois endroits construisent encore une clé AES-GCM depuis une clé de VOLUME : le MODÈLE de " +
      "référence, le RÉGIME v3 et la LECTURE d'une page d'enveloppe v1. Aucun n'est un chemin de " +
      "production du format v4.",
  );
});

test("la matière déclarée est celle que le CODE présente, et elle est relue", async () => {
  for (const entree of IMPORTS_DE_CLE_AES) {
    const contenu = await readFile(path.join(REPO_ROOT, entree.fichier), "utf8");
    assert.equal(
      gestesReleves(contenu).toucheLaDek,
      entree.matiere === "dek",
      `${entree.fichier} : l'inscription dit « ${entree.matiere} » et le code dit l'inverse`,
    );
  }
});

test("ce que chaque exception peut CHIFFRER est mesuré, pas déclaré", async () => {
  // Le champ `scelle` n'est pas une intention : il est confronté aux usages que le module demande
  // réellement à `importKey`. Une lecture héritée qui se mettrait à demander « encrypt » rougirait
  // ici, et c'est le seul endroit du dépôt où cette distinction est tenue.
  for (const entree of IMPORTS_DE_CLE_AES) {
    const contenu = await readFile(path.join(REPO_ROOT, entree.fichier), "utf8");
    assert.equal(
      gestesReleves(contenu).scelle,
      entree.scelle,
      `${entree.fichier} : l'inscription dit « scelle : ${entree.scelle} » et le code dit l'inverse`,
    );
  }
  assert.deepEqual(
    IMPORTS_DE_CLE_AES.filter((entree) => entree.matiere === "dek" && entree.scelle)
      .map((entree) => entree.fichier)
      .sort(),
    ["src/vm/format-chiffre/modele-reference.mjs", "src/vm/scellement.mjs"],
    "Deux endroits peuvent encore CHIFFRER sous une clé de volume : le MODÈLE de référence, qui " +
      "n'est pas un chemin de production, et le RÉGIME v3, qu'une migration et un export de v3 " +
      "empruntent. La lecture d'une page v1, elle, importe sans « encrypt » : elle ne le peut pas.",
  );
});

test("le cliquet MORD : les quatre mutants sont relevés, et le geste v4 ne l'est pas", () => {
  // **Un balayage à vide passe toujours.** Celui-ci est donc confronté à ce qu'il doit refuser, et
  // le premier mutant est le sujet même de la tranche : une racine de page d'enveloppe scellée sous
  // la DEK directe, c'est-à-dire le code qui était en production avant T2b.
  const racineSousLaDek = `import { importerCleDeVolume } from "./modele-reference.mjs";
export async function composerPage({ dek, racine, emplacements }) {
  return scellerRacineSousNonce({ dek: await importerCleDeVolume(dek), racine, emplacements });
}`;
  const directement = `export async function chiffrerSousLaDek(dek, clair) {
  const cle = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, cle, clair);
}`;
  const imbrique = `crypto.subtle.importKey("raw", octets(dek), { name: "AES-GCM" }, false, ["encrypt"]);`;
  const parLaConstante = `crypto.subtle.importKey("raw", dek, { name: ALGORITHME_WEBCRYPTO }, false, ["decrypt"]);`;

  assert.ok(porteLaDek(racineSousLaDek), "mutant A — la racine de page sous la DEK — doit mordre");
  assert.ok(porteLaDek(directement), "mutant B — l'importation directe — doit mordre AUSSI");
  assert.ok(porteLaDek(imbrique), "mutant C — un argument parenthésé ne masque rien");
  assert.ok(porteLaDek(parLaConstante), "mutant D — la constante d'algorithme ne masque rien");

  // Et le geste de la v4 passe : un matériau HKDF ne chiffre rien, et la clé qui en descend est
  // dérivée, jamais importée depuis la DEK.
  const materiauHkdf = `const base = await crypto.subtle.importKey("raw", cleMaitresse, "HKDF", false, ["deriveKey"]);
return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);`;
  assert.equal(
    porteLaDek(materiauHkdf),
    false,
    "la dérivation par domaine est le geste de la v4 : elle ne doit rien déclencher",
  );

  // La PROSE ne mord pas : ce cliquet-ci lit des APPELS. C'est ce qui lui permet de tomber de huit
  // inscriptions à quatre — cinq des inscriptions de T2a n'étaient que des mentions ou des
  // réexports.
  assert.equal(
    porteLaDek("// la DEK n'est plus passée à importerCleDeVolume depuis #182"),
    false,
    "une mention en commentaire n'est pas un appel",
  );
  assert.equal(
    porteLaDek(`export { importerCleDeVolume } from "../format-chiffre/modele-reference.mjs";`),
    false,
    "un réexport n'est pas un appel",
  );
});
