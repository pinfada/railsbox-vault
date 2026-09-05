/**
 * L'ADRESSE d'un artefact v86 change SI ET SEULEMENT SI ses octets changent (#123, ADR 0003).
 *
 * C'est la propriété que l'ADR 0023 nomme comme sa condition de réouverture, et sans laquelle
 * `immutable` — « ces octets ne changeront jamais à cette URL » — est une promesse fausse. Elle a
 * deux moitiés, et une épreuve qui n'en tiendrait qu'une laisserait passer la moitié dangereuse :
 *
 *  - **SI** — deux contenus différents ne partagent jamais une adresse. C'est celle-là qui rend le
 *    cache long sûr : un artefact périmé n'est plus jamais DEMANDÉ, donc jamais servi ;
 *  - **SEULEMENT SI** — un contenu inchangé garde son adresse à travers une montée de version. Sans
 *    elle, une adresse dérivée d'un horodatage ou de l'empreinte du manifeste ENTIER satisferait la
 *    première moitié tout en faisant re-télécharger 9,9 Mio à chaque changement d'un seul octet.
 *
 * Le second bloc d'épreuves refuse qu'une adresse d'artefact soit écrite EN DUR hors de la
 * dérivation — critère 2 de #123, sur le modèle d'inspection de source de `harnais-portes.test.mjs`.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADRESSE_MANIFESTE_V86,
  LONGUEUR_EMPREINTE_DANS_LADRESSE,
  PREFIXE_ADRESSES_V86,
  adresseDe,
  adresseDuManifesteEpingle,
  adressesDuManifeste,
  empreinteDansLAdresse,
  empreinteDeLAdresse,
  exigerAdresse,
  nomAdresse,
  nomAdresseDuManifeste,
} from "../../src/v86-adresses.mjs";
import { MANIFEST_PATH } from "../../tools/v86-paths.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const EMPREINTE_A = "8a969d64cf8f64b8183fdcc3a2ccdb31ae5ae6db7c9fba49949106f574640a7b";
const EMPREINTE_B = "408b0969f943dfd4d0350f6196404fc99fe676e853c36dc09a1959a0f9f751c2";

/** Deux manifestes qui ne diffèrent que par UN artefact : le matériau des deux moitiés. */
function manifesteDe(empreinteDuWasm) {
  return {
    artifacts: [
      { name: "libv86.mjs", sha256: EMPREINTE_B },
      { name: "v86.wasm", sha256: empreinteDuWasm },
    ],
  };
}

// --- L'adresse change SI les octets changent -----------------------------------------------------

test("deux contenus différents ne partagent jamais une adresse", () => {
  assert.notEqual(adresseDe("v86.wasm", EMPREINTE_A), adresseDe("v86.wasm", EMPREINTE_B));
});

test("une montée de version DÉPLACE l'artefact qui a changé, et lui seul", () => {
  const autreWasm = `f${EMPREINTE_A.slice(1)}`;
  const avant = adressesDuManifeste(manifesteDe(EMPREINTE_A));
  const apres = adressesDuManifeste(manifesteDe(autreWasm));

  // SI : l'ancienne adresse du wasm n'est plus référencée par le nouveau manifeste.
  assert.notEqual(apres.get("v86.wasm"), avant.get("v86.wasm"));
  assert.ok(![...apres.values()].includes(avant.get("v86.wasm")));

  // SEULEMENT SI : l'artefact inchangé garde la sienne, donc reste dans le cache du navigateur.
  // Une adresse dérivée du manifeste ENTIER — ou d'un numéro de version — échouerait ici, et
  // ferait re-télécharger jusqu'à 9,9 Mio pour un octet changé.
  assert.equal(apres.get("libv86.mjs"), avant.get("libv86.mjs"));
});

test("l'adresse ne dépend que du nom et de l'empreinte : elle est REPRODUCTIBLE", () => {
  // Le retour arrière de l'ADR 0017 reconstruit un arbre ANTÉRIEUR et exige la même empreinte de
  // racine, au bit près. Une adresse qui dépendrait d'autre chose que du manifeste — l'ordre de
  // parcours du disque, une date, un compteur — rendrait cette comparaison impossible.
  assert.equal(adresseDe("v86.wasm", EMPREINTE_A), adresseDe("v86.wasm", EMPREINTE_A));
  assert.equal(nomAdresse("v86.wasm", EMPREINTE_A), "v86-8a969d64cf8f64b8.wasm");
});

// --- La FORME de l'adresse, et ce qu'elle doit préserver ------------------------------------------

test("l'extension est conservée : c'est elle qui décide du type servi", () => {
  // `.wasm` → `application/wasm`, sans quoi `WebAssembly.instantiateStreaming` refuse ; `.mjs` →
  // module ES, sans quoi l'import dynamique de `libv86` échoue. Une forme d'adresse qui perdrait
  // l'extension casserait le boot sans qu'aucun maillon de la publication ne le dise.
  assert.ok(nomAdresse("v86.wasm", EMPREINTE_A).endsWith(".wasm"));
  assert.ok(nomAdresse("libv86.mjs", EMPREINTE_B).endsWith(".mjs"));
  assert.ok(nomAdresse("linux4.iso", EMPREINTE_A).endsWith(".iso"));
});

test("le nom de l'artefact reste en tête de l'adresse", () => {
  // Critère de la forme retenue : le suffixe garde l'artefact lisible dans l'inventaire de l'ADR
  // 0017, là où un répertoire `<empreinte>/` ferait trier la liste par empreinte.
  assert.ok(nomAdresse("v86.wasm", EMPREINTE_A).startsWith("v86-"));
  assert.ok(nomAdresse("libv86.mjs", EMPREINTE_B).startsWith("libv86-"));
});

test("l'adresse reste sous le préfixe immuable, et le manifeste HORS de lui", () => {
  // Le manifeste est l'INDIRECTION : c'est lui qu'on interroge pour apprendre les autres adresses,
  // et une copie périmée désignerait des adresses qui ne sont plus servies. Il ne peut donc pas
  // relever de la même règle de cache que les octets qu'il nomme (amendement de l'ADR 0023).
  assert.ok(adresseDe("v86.wasm", EMPREINTE_A).startsWith(PREFIXE_ADRESSES_V86));
  assert.ok(!ADRESSE_MANIFESTE_V86.startsWith(PREFIXE_ADRESSES_V86));
});

test("l'empreinte se relit DANS le nom : le cliquet est mesurable, pas déclaratif", () => {
  const nom = nomAdresse("v86.wasm", EMPREINTE_A);
  assert.equal(empreinteDeLAdresse(nom), EMPREINTE_A.slice(0, LONGUEUR_EMPREINTE_DANS_LADRESSE));
  assert.equal(empreinteDeLAdresse("v86.wasm"), null);
  assert.equal(empreinteDeLAdresse("MANIFEST.json"), null);
  assert.equal(
    empreinteDeLAdresse(nomAdresseDuManifeste(EMPREINTE_B)),
    EMPREINTE_B.slice(0, LONGUEUR_EMPREINTE_DANS_LADRESSE),
  );
});

test("une empreinte qui n'en est pas une est REFUSÉE, jamais tronquée en silence", () => {
  // Une adresse construite sur « undefined » ou sur une empreinte majuscule serait servie sous
  // `immutable` pendant un an sans décrire quoi que ce soit.
  for (const invalide of [
    undefined,
    null,
    "",
    "abc",
    EMPREINTE_A.toUpperCase(),
    `${EMPREINTE_A}0`,
  ]) {
    assert.throws(() => empreinteDansLAdresse(invalide), /SHA-256/);
  }
});

test("un artefact absent du manifeste est un refus NOMMÉ, pas une adresse « undefined »", () => {
  const adresses = adressesDuManifeste(manifesteDe(EMPREINTE_A));
  assert.equal(exigerAdresse(adresses, "v86.wasm"), adresses.get("v86.wasm"));
  assert.throws(() => exigerAdresse(adresses, "seabios.bin"), /seabios\.bin/);
});

// --- Le manifeste RÉEL du dépôt passe la dérivation ----------------------------------------------

test("les cinq artefacts épinglés par l'ADR 0003 rendent cinq adresses distinctes", async () => {
  const manifeste = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const adresses = adressesDuManifeste(manifeste);
  assert.equal(adresses.size, manifeste.artifacts.length);
  assert.equal(new Set(adresses.values()).size, manifeste.artifacts.length);
  for (const adresse of adresses.values()) {
    assert.ok(adresse.startsWith(PREFIXE_ADRESSES_V86));
    assert.ok(empreinteDeLAdresse(adresse) !== null, `${adresse} ne nomme pas son empreinte`);
    // Mesure inscrite dans l'amendement de l'ADR 0023 : dix-sept caractères de plus qu'avant, et
    // aucune URL au-delà de soixante — très loin des limites de chemin des hébergeurs statiques.
    assert.ok(adresse.length <= 60, `${adresse} : ${adresse.length} caractères`);
  }
});

test("la copie du manifeste adressée par son empreinte relève du préfixe immuable", () => {
  const adresse = adresseDuManifesteEpingle(EMPREINTE_A);
  assert.ok(adresse.startsWith(PREFIXE_ADRESSES_V86));
  assert.ok(empreinteDeLAdresse(adresse) !== null);
  assert.notEqual(adresse, ADRESSE_MANIFESTE_V86);
});

// --- Aucune adresse écrite en dur hors de la dérivation (critère 2 de #123) -----------------------

/** Tout le code du dépôt : une adresse écrite en dur nuit d'où qu'elle vienne. */
const RACINES = ["src", "public", "tools", "tests"];

/**
 * Fichiers autorisés à écrire le préfixe d'adresses, avec leur motif.
 *
 * La liste ne contient que la DÉFINITION et l'épreuve qui la mesure. Tout le reste — chargeurs des
 * bancs, serveur de développement, publication, épreuves de bout en bout — passe par la dérivation,
 * et c'est ce que cette épreuve établit.
 */
const PORTEURS_DU_PREFIXE = [
  {
    fichier: "src/v86-adresses.mjs",
    motif: "il DÉFINIT le préfixe et la forme d'adresse ; il est la dérivation elle-même.",
  },
];

/**
 * Chargeurs de v86 : ils DOIVENT importer la dérivation.
 *
 * Le pendant de la liste ci-dessus, et il n'est pas décoratif : sans lui, un chargeur qui
 * reviendrait à un chemin en dur formulé autrement — une concaténation, une variable — passerait
 * l'épreuve du préfixe sans lire le manifeste. Une inscription périmée fait échouer l'épreuve.
 */
const CHARGEURS_DE_V86 = [
  "public/vm/runtime-worker.mjs",
  "public/csp/ordonnancement-worker.mjs",
  "public/spike/isolation/runtime-worker.mjs",
];

async function parcourir(repertoire, trouves) {
  for (const entree of await readdir(repertoire, { withFileTypes: true })) {
    const complet = path.join(repertoire, entree.name);
    if (entree.isDirectory()) {
      if (entree.name === "node_modules") continue;
      await parcourir(complet, trouves);
      continue;
    }
    if (entree.name.endsWith(".mjs") || entree.name.endsWith(".js")) trouves.push(complet);
  }
}

async function modules() {
  const trouves = [];
  for (const racine of RACINES) await parcourir(path.join(REPO_ROOT, racine), trouves);
  return trouves.map((absolu) => path.relative(REPO_ROOT, absolu).split(path.sep).join("/")).sort();
}

/**
 * Retire les commentaires avant de chercher.
 *
 * Un module a le droit d'EXPLIQUER l'ancienne forme d'adresse — plusieurs le font, et l'ADR 0023 en
 * dépend pour être lisible. Ce qui est refusé est de la CONSTRUIRE. Sans ce dépouillement,
 * l'épreuve pousserait à retirer les explications plutôt que les chemins.
 */
function codeSeul(texte) {
  return texte.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

test("aucun module n'écrit en dur une adresse d'artefact v86", async () => {
  const autorises = new Set(PORTEURS_DU_PREFIXE.map(({ fichier }) => fichier));
  const coupables = [];
  for (const fichier of await modules()) {
    if (autorises.has(fichier)) continue;
    const code = codeSeul(await readFile(path.join(REPO_ROOT, fichier), "utf8"));
    if (code.includes(PREFIXE_ADRESSES_V86)) coupables.push(fichier);
  }
  assert.deepEqual(
    coupables,
    [],
    "Ces fichiers construisent une adresse d'artefact v86 sans passer par le manifeste. Une " +
      "adresse écrite en dur survit à une montée de version : elle rend un 404, ou pire, les " +
      "octets d'hier sous une promesse d'immuabilité. Passez par `src/v86-adresses.mjs`.",
  );
});

test("les autorisations sont à jour : aucune inscription périmée", async () => {
  for (const { fichier } of PORTEURS_DU_PREFIXE) {
    const contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    assert.ok(
      contenu.includes(PREFIXE_ADRESSES_V86),
      `${fichier} est inscrit comme porteur du préfixe et ne l'écrit plus.`,
    );
  }
});

test("chaque chargeur de v86 lit le manifeste plutôt qu'un chemin", async () => {
  for (const fichier of CHARGEURS_DE_V86) {
    const code = codeSeul(await readFile(path.join(REPO_ROOT, fichier), "utf8"));
    assert.ok(
      code.includes("v86-adresses.mjs"),
      `${fichier} charge le runtime v86 sans dériver son adresse du manifeste d'épinglage.`,
    );
  }
});
