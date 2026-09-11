/**
 * Le CLIQUET ANTI-DEK, définitif : aucun scellement du produit ne reçoit la clé maîtresse
 * (#182, T2b ; ADR 0033, décision 6 ; ADR 0036, décision 5).
 *
 * ## Ce qu'il balaie, dit en une phrase
 *
 * Sur `src/` et `public/`, pris comme UN CORPUS et non fichier par fichier : tout module qui
 * DÉFINIT, APPELLE ou RÉEXPORTE — sous quelque nom que ce soit — la porte
 * `importerCleDeVolume`, et tout module qui RÉFÉRENCE la propriété `importKey`, que ce soit par un
 * appel, une liaison (`= crypto.subtle.importKey`, `.bind(`) ou une déstructuration.
 *
 * ## Ce que la revue de la PR #187 a trouvé, et pourquoi il a fallu un CORPUS
 *
 * Le cliquet d'origine lisait chaque fichier SEUL, et cherchait deux textes : le nom
 * `importerCleDeVolume(` et la chaîne `importKey(`. Le relecteur lui a présenté cinq mutants ; trois
 * ont mordu, deux sont passés, et ce sont les deux qui coûtent :
 *
 *  - **M4, le mutant que la Definition of Ready nomme mot pour mot** — « un nouveau module qui
 *    réexporte l'ancienne porte sous un autre nom ». `export { importerCleDeVolume as cleDeScellement }`
 *    dans un module, `cleDeScellement(dek)` dans un autre : aucun des deux ne contient le texte
 *    cherché, et la racine d'une page d'enveloppe se scellait de nouveau sous la clé de volume ;
 *  - **M5, la liaison locale** — `const importer = crypto.subtle.importKey.bind(crypto.subtle)`,
 *    puis `importer("raw", dek, …)`. Le motif `importKey(` ne voit pas `importKey.bind(`.
 *
 * Les deux corrections sont de même nature : **un nom n'est pas une identité**. Le cliquet suit donc
 * les ALIAS de la porte à travers le corpus, jusqu'au point fixe, et il relève la PROPRIÉTÉ
 * `importKey` plutôt qu'une forme d'appel.
 *
 * ## Ce qu'il ne remplace PAS
 *
 * Le GARANTI de la plate-forme, mesuré sur les trois moteurs par
 * `tests/browser/hierarchie-de-cles-frontiere.spec.mjs`, et le COMPTE d'`encrypt` par clé sur une
 * session complète, mesuré par `vm-budget-par-domaine.test.mjs`. Une inspection de source dit qui
 * NOMME ; elle ne dit ni ce que WebCrypto refuse, ni ce qu'une session consomme réellement.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Le CODE SERVI : `src/` et `public/`. Un chemin de production vit dans l'un des deux. */
const RACINES = ["src", "public"];

/** Le nom d'origine de la porte. Tout ce qui en descend par réexport est suivi jusqu'au point fixe. */
const PORTE = "importerCleDeVolume";

/**
 * Les SIX endroits du dépôt qui NOMMENT une clé brute, et ce que chacun tient dans la main.
 *
 * `matiere` dit de QUELS octets il s'agit, et c'est le seul champ qui décide de la propriété :
 *
 *  - `dek` — une clé de VOLUME, ou la PORTE qui en fabrique une, réexport compris. C'est le sujet de
 *    #182, et la liste de ceux-là est ce que ce fichier verrouille ;
 *  - `vecteur` — des octets PUBLIÉS, qui ne sont la clé de rien.
 *
 * `role` dit pourquoi une matière `dek` subsiste, et il n'y a que trois réponses admises :
 *
 *  - `modele` — une spécification exécutable, dont les vecteurs figés se rejouent sous une clé
 *    présentée telle quelle. Ce n'est pas un chemin de production ;
 *  - `lecture-heritee` — un format ANTÉRIEUR à la v4, dont les octets ont été scellés sous la clé de
 *    volume et ne se relisent que sous elle. Chacun est atteignable par un seul chemin, nommé ;
 *  - `reexport` — le module ne fait que RÉEXPORTER la porte pour un modèle voisin, sans jamais
 *    l'appeler. Il est inscrit depuis la revue de la PR #187 : un réexport cesse d'être innocent dès
 *    qu'il peut renommer, et le mutant M4 est précisément celui-là.
 *
 * **Aucune entrée ne porte `production`, et c'est la propriété que ce fichier mesure.** Le jour où
 * un chemin de production du format v4 aurait besoin de la clé de volume, il demanderait un ADR, pas
 * une ligne de liste.
 */
const NOMS_DE_CLE_BRUTE = [
  {
    fichier: "src/compat/crypto-probes.mjs",
    matiere: "vecteur",
    role: null,
    scelle: true,
    motif:
      "il SONDE la plate-forme : il importe une clé AES-GCM tirée d'un vecteur PUBLIÉ — jamais la " +
      "clé de volume, qu'il ne reçoit ni ne connaît — pour constater que le moteur tient " +
      "AES-256-GCM et HKDF avant qu'un volume ne soit ouvert. Il est relevé parce que le balayage " +
      "cherche le GESTE et non l'origine des octets, et l'inscrire dit cela plutôt que de raffiner " +
      "un motif jusqu'à ce qu'il laisse passer ce qu'on voulait voir.",
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
    fichier: "src/vm/enveloppe/modele-reference.mjs",
    matiere: "dek",
    role: "reexport",
    scelle: true,
    motif:
      "il RÉEXPORTE `importerCleDeVolume` pour le modèle de l'enveloppe, et il ne l'appelle JAMAIS " +
      "— vérifiable : aucun appel dans son texte. Il importe par ailleurs une clé de " +
      "DÉVERROUILLAGE, qui est AES-GCM par construction et ne descend pas de la clé maîtresse. " +
      "L'inscrire est la correction du mutant M4 de la revue de la PR #187 : un réexport peut " +
      "renommer, et un nom qui change est une porte qu'on ne voit plus.",
  },
  {
    fichier: "src/vm/instantane/modele-reference.mjs",
    matiere: "dek",
    role: "reexport",
    scelle: true,
    motif:
      "il RÉEXPORTE `importerCleDeVolume` pour les vecteurs de l'instantané, et il ne l'appelle " +
      "jamais. Le chemin de production, lui, dérive depuis #182 : plus aucune capture n'est scellée " +
      "sous la clé de volume. Même raison d'inscription que le précédent.",
  },
  {
    fichier: "src/vm/scellement.mjs",
    matiere: "dek",
    role: "lecture-heritee",
    scelle: true,
    motif:
      "le RÉGIME ANTÉRIEUR à la v4, nommé `#sousLaCleMaitresse` : un volume v3 n'a pas de clé " +
      "maîtresse, ses secteurs sont scellés sous la clé de volume elle-même. Deux chemins " +
      "l'empruntent, et deux seulement — la MIGRATION v3 vers v4, et l'EXPORT d'un v3 avant sa " +
      "migration, qui passe par le même lecteur (`migration-source-chiffree.mjs`). Ouvrir un tel " +
      "volume écrit une empreinte de région, une racine et un témoin, plus un scellement par " +
      "secteur rejoué : c'est pourquoi cette entrée SCELLE encore, là où la lecture d'une page " +
      "d'enveloppe v1 ne le fait plus.",
  },
  {
    fichier: "src/vm/enveloppe/page-v1-lecture.mjs",
    matiere: "dek",
    role: "lecture-heritee",
    scelle: false,
    motif:
      "la racine d'une page d'enveloppe v1 est scellée sous la clé de volume (ADR 0020, " +
      "décision 3, avant T2b). Elle doit rester lisible jusqu'à ce que la page v2 soit écrite ET " +
      "relue, sans quoi une coupure pendant la migration de page coûterait le volume. La clé y est " +
      "importée avec le seul usage « decrypt » : ce module ne PEUT pas sceller, et c'est WebCrypto " +
      "qui le tient.",
  },
];

/**
 * Retire les commentaires, et RIEN d'autre.
 *
 * Ce cliquet lit du CODE. Deux modules écrivent le CONTRE-EXEMPLE dans leur en-tête, en toutes
 * lettres — « `importKey("raw", dek, "AES-GCM", …)` y est la ligne qu'on n'écrit plus » : un
 * balayage incapable de distinguer le code d'un contre-exemple ferait inscrire, parmi les porteurs
 * de la clé de volume, les seuls modules qui l'empêchent d'en être un.
 */
function sansCommentaires(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Les noms sous lesquels un module CONNAÎT la porte, et ceux sous lesquels il la REND.
 *
 * Quatre formes suivies, et ce sont celles qu'un renommage emprunte :
 *
 *     import { importerCleDeVolume as X } from "…"      → X connu ici
 *     export { importerCleDeVolume as Y } from "…"      → Y rendu par ce module
 *     export { X as Y }                                  → Y rendu, si X est connu
 *     const Z = X                                        → Z connu, si X est connu
 *
 * `export * from "…"` propage TOUS les noms rendus par la cible : il est traité comme un réexport de
 * chacun d'eux.
 */
function liaisonsDuModule(code, connus) {
  const appris = new Set();
  const rendus = new Set();

  const apprendre = (origine, alias) => {
    if (connus.has(origine)) appris.add(alias);
  };

  for (const trouve of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/g)) {
    for (const piece of trouve[1].split(",")) {
      const [origine, alias] = piece.split(/\s+as\s+/).map((part) => part.trim());
      if (origine) apprendre(origine, alias ?? origine);
    }
  }
  for (const trouve of code.matchAll(/\bexport\s*\{([^}]*)\}(\s*from\s*["'][^"']*["'])?/g)) {
    for (const piece of trouve[1].split(",")) {
      const [origine, alias] = piece.split(/\s+as\s+/).map((part) => part.trim());
      if (!origine) continue;
      apprendre(origine, alias ?? origine);
      if (connus.has(origine)) rendus.add(alias ?? origine);
    }
  }
  for (const trouve of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g,
  )) {
    apprendre(trouve[2], trouve[1]);
  }
  return { appris, rendus };
}

/**
 * Le POINT FIXE des alias de la porte sur le corpus entier.
 *
 * Un module peut réexporter ce qu'un autre réexporte : deux passes ne suffisent pas, et s'arrêter à
 * deux serait une borne arbitraire. On itère jusqu'à ce que l'ensemble cesse de croître — il est
 * fini, donc cela termine.
 */
function aliasDeLaPorte(corpus) {
  const connus = new Set([PORTE]);
  let taille = 0;
  while (connus.size !== taille) {
    taille = connus.size;
    for (const code of corpus.values()) {
      for (const nom of liaisonsDuModule(code, connus).appris) connus.add(nom);
    }
  }
  return connus;
}

/**
 * Ce qu'un module fait d'une clé brute, sur un corpus dont les alias sont déjà résolus.
 *
 * `porte` couvre les TROIS façons d'en être une : la définir, l'appeler sous l'un de ses noms, ou la
 * rendre à d'autres. `importKey` couvre toute RÉFÉRENCE à la propriété — l'appeler, la lier, la
 * déstructurer —, parce que c'est la référence, et non la forme d'appel, qui donne le geste.
 */
function gestesDuModule(code, alias) {
  const definit = new RegExp(String.raw`function\s+${PORTE}\b`).test(code);
  const appelle = [...alias].some((nom) => new RegExp(String.raw`\b${nom}\s*\(`).test(code));
  const { rendus } = liaisonsDuModule(code, alias);
  const porte = definit || appelle || rendus.size > 0;
  const imports = referencesAImportKey(code);
  const nommeUneCleDeVolume = /\b(dek|DEK|cleDeVolume|cleDuVolume|cleMaitresse|CLE_DE_TEST)\b/.test(
    code,
  );
  return {
    porte,
    imports,
    releve: porte || imports.aesGcm,
    toucheLaDek: porte || (imports.aesGcm && nommeUneCleDeVolume),
    // Une clé importée SANS l'usage « encrypt » ne peut pas sceller : WebCrypto rejette
    // `crypto.subtle.encrypt` pour elle. C'est la garantie de la décision 6 de l'ADR 0033,
    // appliquée un cran plus bas.
    scelle: porte || (imports.aesGcm && /"encrypt"/.test(code)),
  };
}

/**
 * Les RÉFÉRENCES à la propriété `importKey`, classées par ce qu'on peut en lire.
 *
 * Trois formes, et la troisième décide de la conduite :
 *
 *  - un APPEL LISIBLE — `…importKey(…)`, arguments lus à parenthèses équilibrées. On sait alors quel
 *    algorithme est demandé, et un import HKDF n'est pas relevé : c'est LUI qui rend la clé de
 *    volume incapable de chiffrer, et le relever ferait inscrire, parmi les porteurs, le module qui
 *    les empêche d'en être ;
 *  - une LIAISON ou une DÉSTRUCTURATION — `= crypto.subtle.importKey`, `.importKey.bind(`,
 *    `const { importKey } = crypto.subtle`. Les arguments ne sont pas au même endroit que le nom, et
 *    parfois pas dans le même fichier. On ne devine pas : **toute référence opaque est relevée**,
 *    et c'est le mutant M5 de la revue de la PR #187 ;
 *  - rien du tout.
 *
 * L'équilibre des parenthèses compte : un appel d'importation porte un objet d'algorithme et un
 * tableau d'usages, et couper à la première parenthèse fermante lirait la moitié de l'appel.
 */
function referencesAImportKey(code) {
  const appels = [];
  for (const trouve of code.matchAll(/\bimportKey\s*\(/g)) {
    const ouvrante = code.indexOf("(", trouve.index);
    appels.push(argumentsDeLAppel(code, ouvrante));
  }
  const references = [...code.matchAll(/\.\s*importKey\b|\{[^}]*\bimportKey\b[^}]*\}\s*=/g)];
  // Une référence qui n'est pas suivie d'une parenthèse ouvrante est une LIAISON : opaque.
  const opaques = references.filter(
    (trouve) =>
      !/^\.\s*importKey\s*\(/.test(
        trouve[0] +
          code.slice(trouve.index + trouve[0].length, trouve.index + trouve[0].length + 2),
      ),
  ).length;
  return {
    appels,
    opaques,
    aesGcm: opaques > 0 || appels.some((appel) => /AES-GCM|ALGORITHME_WEBCRYPTO/.test(appel)),
  };
}

/** Rend le texte des arguments d'un appel commençant à `depart`, PARENTHÈSES équilibrées. */
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
 * RELÈVE tout le corpus d'un coup : les alias d'abord, les gestes ensuite.
 *
 * C'est la correction du mutant M4 : un module qui renomme la porte et un module qui appelle le
 * nouveau nom ne se voient ni l'un ni l'autre lus SÉPARÉMENT. Le corpus les relie.
 */
function relever(corpus) {
  const alias = aliasDeLaPorte(corpus);
  const gestes = new Map();
  for (const [fichier, source] of corpus) {
    gestes.set(fichier, gestesDuModule(sansCommentaires(source), alias));
  }
  propagerParReexportEnBloc(corpus, gestes);
  return {
    alias,
    releves: new Map([...gestes].filter(([, geste]) => geste.releve)),
  };
}

/**
 * PROPAGE la qualité de porte à travers `export * from "…"`, jusqu'au point fixe.
 *
 * Un réexport EN BLOC ne nomme rien : il rend tout ce que sa cible rend, la porte comprise, et un
 * module qui l'importe ensuite n'a aucun texte particulier à montrer. C'est la troisième forme de
 * renommage — après `export { x as y }` et `const y = x` —, et la seule qui ne se lise pas dans le
 * fichier qui en profite.
 *
 * La cible est résolue par son CHEMIN, relatif au module qui la réexporte : se fier au nom de
 * fichier ferait confondre deux `modele-reference.mjs`, et le dépôt en a trois.
 */
function propagerParReexportEnBloc(corpus, gestes) {
  let change = true;
  while (change) {
    change = false;
    for (const [fichier, source] of corpus) {
      if (gestes.get(fichier).porte) continue;
      for (const trouve of sansCommentaires(source).matchAll(
        /\bexport\s*\*\s*from\s*["']([^"']+)["']/g,
      )) {
        const cible = resoudre(fichier, trouve[1]);
        if (cible === null || !gestes.get(cible)?.porte) continue;
        gestes.set(fichier, { ...gestes.get(fichier), porte: true, releve: true });
        change = true;
        break;
      }
    }
  }
}

/** Le chemin de corpus qu'un spécificateur relatif désigne, ou `null` s'il sort du périmètre. */
function resoudre(depuis, specificateur) {
  if (!specificateur.startsWith(".")) return null;
  const resolu = path.posix.normalize(path.posix.join(path.posix.dirname(depuis), specificateur));
  return resolu.startsWith("..") ? null : resolu;
}

/** Tous les modules du périmètre, en chemins relatifs à barre oblique. */
async function corpusDuPerimetre() {
  const corpus = new Map();
  for (const racine of RACINES) {
    const entrees = await readdir(path.join(REPO_ROOT, racine), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entree of entrees) {
      if (!entree.isFile() || !entree.name.endsWith(".mjs")) continue;
      const absolu = path.join(entree.parentPath ?? entree.path, entree.name);
      const relatif = path.relative(REPO_ROOT, absolu).replaceAll("\\", "/");
      corpus.set(relatif, await readFile(absolu, "utf8"));
    }
  }
  return new Map([...corpus].sort(([a], [b]) => a.localeCompare(b)));
}

const CORPUS = await corpusDuPerimetre();
const RELEVE = relever(CORPUS);

test("le cliquet porte sur un périmètre réel : `src/` ET `public/` sont relus, comme UN corpus", () => {
  assert.ok(CORPUS.size > 50, `${CORPUS.size} modules relevés`);
  assert.ok(
    [...CORPUS.keys()].some((fichier) => fichier.startsWith("public/")),
    "`public/` n'est pas balayé : le code servi au navigateur échapperait au cliquet",
  );
});

test("AUCUN module hors de la liste ne nomme une clé brute, sous quelque alias que ce soit", async () => {
  const inscrits = new Set(NOMS_DE_CLE_BRUTE.map((entree) => entree.fichier));
  const coupables = [...RELEVE.releves.keys()].filter((fichier) => !inscrits.has(fichier));
  assert.deepEqual(
    coupables,
    [],
    "Ces modules nomment une clé brute — la porte, l'un de ses alias, ou la propriété `importKey`. " +
      "Depuis l'ADR 0033, un scellement scelle sous une clé DÉRIVÉE par domaine ; si un chemin a " +
      "vraiment besoin de l'autre, il demande un ADR, pas une ligne de liste.",
  );
});

test("les inscriptions sont à jour : aucune ne couvre un module qui a cessé de le faire", () => {
  const perimees = NOMS_DE_CLE_BRUTE.map((entree) => entree.fichier).filter(
    (fichier) => !RELEVE.releves.has(fichier),
  );
  assert.deepEqual(perimees, [], "Ces inscriptions ne couvrent plus rien : retirez-les.");
});

test("ce qui touche une clé de VOLUME se compte sur cinq doigts, et aucun n'est un chemin v4", () => {
  // Une liste d'exceptions sans nature est une liste qui grandit. Les trois rôles admis sont écrits
  // en tête de ce fichier, et « production » n'en fait pas partie : c'est là toute la tranche.
  for (const entree of NOMS_DE_CLE_BRUTE) {
    assert.match(entree.matiere, /^(dek|vecteur)$/, `${entree.fichier} : matière inconnue`);
    assert.equal(
      entree.role === null,
      entree.matiere !== "dek",
      `${entree.fichier} : un nom de matière « dek » porte un rôle, les autres n'en portent pas`,
    );
    if (entree.role !== null) {
      assert.match(
        entree.role,
        /^(modele|lecture-heritee|reexport)$/,
        `${entree.fichier} : rôle hors vocabulaire`,
      );
    }
    assert.ok(entree.motif.length > 80, `${entree.fichier} : « c'est ainsi » n'est pas un motif`);
  }
  assert.deepEqual(
    NOMS_DE_CLE_BRUTE.filter((entree) => entree.matiere === "dek")
      .map((entree) => entree.fichier)
      .sort(),
    [
      "src/vm/enveloppe/modele-reference.mjs",
      "src/vm/enveloppe/page-v1-lecture.mjs",
      "src/vm/format-chiffre/modele-reference.mjs",
      "src/vm/instantane/modele-reference.mjs",
      "src/vm/scellement.mjs",
    ],
    "Cinq endroits nomment encore une clé de VOLUME : le MODÈLE de référence qui la définit, DEUX " +
      "réexports qui ne l'appellent jamais, le RÉGIME v3, et la LECTURE d'une page d'enveloppe v1. " +
      "Aucun n'est un chemin de production du format v4.",
  );
});

test("la matière déclarée est celle que le CODE présente, et elle est relue", () => {
  for (const entree of NOMS_DE_CLE_BRUTE) {
    assert.equal(
      RELEVE.releves.get(entree.fichier).toucheLaDek,
      entree.matiere === "dek",
      `${entree.fichier} : l'inscription dit « ${entree.matiere} » et le code dit l'inverse`,
    );
  }
});

test("ce que chaque inscription peut CHIFFRER est mesuré, pas déclaré", () => {
  // Le champ `scelle` n'est pas une intention : il est confronté aux usages que le module demande
  // réellement. Une lecture héritée qui se mettrait à demander « encrypt » rougirait ici, et c'est
  // le seul endroit du dépôt où cette distinction est tenue.
  for (const entree of NOMS_DE_CLE_BRUTE) {
    assert.equal(
      RELEVE.releves.get(entree.fichier).scelle,
      entree.scelle,
      `${entree.fichier} : l'inscription dit « scelle : ${entree.scelle} » et le code dit l'inverse`,
    );
  }
  assert.deepEqual(
    NOMS_DE_CLE_BRUTE.filter((entree) => entree.matiere === "dek" && entree.scelle === false).map(
      (entree) => entree.fichier,
    ),
    ["src/vm/enveloppe/page-v1-lecture.mjs"],
    "Un seul module nomme une clé de volume sans pouvoir chiffrer : la LECTURE d'une page v1, " +
      "importée sans « encrypt ». C'est WebCrypto qui le tient, pas une discipline.",
  );
});

test("le cliquet MORD sur les CINQ mutants de la revue, et laisse passer le geste de la v4", () => {
  // **Un balayage à vide passe toujours.** Celui-ci est donc confronté aux cinq mutants que la revue
  // de sécurité de la PR #187 a fabriqués dans une copie de `src/` et `public/`. Trois mordaient
  // déjà ; les deux derniers passaient, et ce sont eux qui coûtaient — M4 est le mutant que la
  // Definition of Ready de #182 nomme mot pour mot.
  const mord = (corpus) => relever(new Map(Object.entries(corpus))).releves.size > 0;

  const m1 = `export async function chiffrerSousLaDek(dek, clair) {
  const cle = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, cle, clair);
}`;
  const m2 = `import { importerCleDeVolume } from "./modele-reference.mjs";
export async function chiffrer(dek, clair) {
  const cle = await importerCleDeVolume(dek);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, cle, clair);
}`;
  const m3 = `import { importerCleDeVolume } from "./modele-reference.mjs";
export async function composerPage({ dek, racine, emplacements }) {
  return scellerRacineSousNonce({ cleDeRacine: await importerCleDeVolume(dek), racine, emplacements });
}`;
  // M4 : DEUX modules. Ni l'un ni l'autre ne contient le texte que le cliquet d'origine cherchait.
  const m4Alias = `export { importerCleDeVolume as cleDeScellement } from "./format-chiffre/modele-reference.mjs";`;
  const m4Consommateur = `import { cleDeScellement } from "./m4-alias.mjs";
import { scellerRacineSousNonce } from "./enveloppe/modele-reference.mjs";
export async function composerPageV1({ dek, racine, emplacements, nonce }) {
  return scellerRacineSousNonce({ cleDeRacine: await cleDeScellement(dek), racine, emplacements, nonce });
}`;
  // M5 : la propriété `importKey` est LIÉE, jamais appelée par son nom.
  const m5 = `const importer = crypto.subtle.importKey.bind(crypto.subtle);
export async function sceller(dek, clair) {
  const cle = await importer("raw", dek, { name: "AES-GCM" }, false, ["encrypt"]);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, cle, clair);
}`;

  assert.ok(mord({ "src/vm/m1.mjs": m1 }), "M1 — importKey direct sous la clé de volume");
  assert.ok(mord({ "src/vm/m2.mjs": m2 }), "M2 — encrypt sous une CryptoKey issue de la porte");
  assert.ok(mord({ "src/vm/m3.mjs": m3 }), "M3 — racine d'enveloppe sous la clé de volume");
  assert.ok(
    mord({ "src/vm/m4-alias.mjs": m4Alias, "src/vm/m4-consommateur.mjs": m4Consommateur }),
    "M4 — la porte RÉEXPORTÉE sous un autre nom, puis appelée : le mutant de la DoR",
  );
  assert.ok(mord({ "src/vm/m5.mjs": m5 }), "M5 — `importKey` atteint par une liaison locale");

  // M6 — la troisième forme de renommage, que la revue nomme sans la fabriquer : le réexport EN
  // BLOC. Il ne nomme RIEN, et le module qui en profite n'a aucun texte particulier à montrer. Ce
  // qui est exigé n'est pas que le corpus rougisse — le module qui DÉFINIT la porte y suffirait —
  // mais que le module de réexport soit relevé LUI.
  const m6 = relever(
    new Map([
      [
        "src/vm/format-chiffre/modele-reference.mjs",
        `export function ${PORTE}(octets) { return octets; }`,
      ],
      ["src/vm/m6-bloc.mjs", `export * from "./format-chiffre/modele-reference.mjs";`],
    ]),
  );
  assert.ok(
    m6.releves.has("src/vm/m6-bloc.mjs"),
    "M6 — la porte réexportée EN BLOC : le module qui la rend doit être relevé",
  );

  // Et le CONSOMMATEUR de M4 est relevé à lui seul, pas seulement le module qui renomme : sans
  // cela, retirer le module d'alias suffirait à rendre le corpus vert alors que l'appel reste.
  const m4 = relever(
    new Map([
      ["src/vm/m4-alias.mjs", m4Alias],
      ["src/vm/m4-consommateur.mjs", m4Consommateur],
    ]),
  );
  assert.deepEqual(
    [...m4.releves.keys()].sort(),
    ["src/vm/m4-alias.mjs", "src/vm/m4-consommateur.mjs"],
    "le module qui RENOMME et celui qui APPELLE doivent être relevés tous les deux",
  );
  assert.ok(m4.alias.has("cleDeScellement"), "l'alias est suivi jusqu'au point fixe");

  // Et le geste de la v4 passe : un matériau HKDF ne chiffre rien, et la clé qui en descend est
  // dérivée, jamais importée depuis la clé de volume.
  const v4 = `const base = await crypto.subtle.importKey("raw", cleMaitresse, "HKDF", false, ["deriveKey"]);
return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);`;
  assert.equal(
    mord({ "src/vm/v4.mjs": v4 }),
    false,
    "la dérivation par domaine est le geste de la v4 : elle ne doit rien déclencher",
  );

  // Et le TÉMOIN de l'exemption : ce sont bien les DEUX modules de dérivation du dépôt qui en
  // vivent. Si l'exemption cessait de s'appliquer à eux, la liste d'inscriptions grandirait de deux
  // sans qu'aucune clé de volume ne soit en cause — et une liste qui grandit pour rien finit par
  // être lue sans être relue.
  for (const module of [
    "src/vm/derivation/cle-de-domaine.mjs",
    "src/vm/derivation/derivateur.mjs",
  ]) {
    assert.ok(/\bimportKey\s*\(/.test(CORPUS.get(module)), `${module} importe bien une clé`);
    assert.equal(RELEVE.releves.has(module), false, `${module} n'importe QUE du matériau HKDF`);
  }

  // La PROSE ne mord pas : ce cliquet lit du CODE.
  assert.equal(
    mord({ "src/vm/prose.mjs": "// la DEK n'est plus passée à importerCleDeVolume depuis #182" }),
    false,
    "une mention en commentaire n'est pas un geste",
  );
});
