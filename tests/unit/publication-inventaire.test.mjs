/**
 * Épreuves de l'inventaire d'empreintes de la chaîne de publication (#45, ADR 0017).
 *
 * Ce que ces épreuves doivent établir, et qui n'est pas la même chose qu'« il y a un inventaire » :
 *
 *  - l'inventaire est COMPLET — chaque fichier de l'arbre y figure, sous-répertoires compris, et
 *    l'exception (le fichier d'inventaire lui-même) est déclarée plutôt que silencieuse ;
 *  - il DÉTECTE les trois écarts qui ne se diagnostiquent pas pareil : un fichier altéré, un
 *    fichier ajouté, un fichier manquant. Un vérificateur qui n'attrape que le premier laisserait
 *    passer exactement la surface qu'une publication ne doit pas servir ;
 *  - l'empreinte de RACINE change dans chacun de ces trois cas, y compris celui — le plus sournois
 *    — où un fichier est simplement RENOMMÉ : le contenu total est alors inchangé, et une somme
 *    des empreintes n'y verrait rien.
 *
 * Les épreuves travaillent sur des arbres jetables écrits dans un répertoire temporaire : elles ne
 * dépendent ni du contenu du dépôt ni d'une construction préalable.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTRAT_INVENTAIRE,
  FICHIER_INVENTAIRE,
  comparer,
  construireInventaire,
  empreinte,
  empreinteDeRacine,
  relever,
} from "../../tools/publier-inventaire.mjs";

const COMMIT = Object.freeze({
  empreinte: "0".repeat(40),
  date: "2026-08-27T00:00:00+02:00",
  arbreGit: "1".repeat(40),
  proprePendantLaConstruction: true,
});

async function arbreJetable(fichiers) {
  const racine = await mkdtemp(join(tmpdir(), "vault-publication-"));
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    const absolu = join(racine, chemin);
    await mkdir(join(absolu, ".."), { recursive: true });
    await writeFile(absolu, contenu, "utf8");
  }
  return racine;
}

async function inventaireDe(racine) {
  const inventaire = await construireInventaire({
    arbre: "coquille",
    role: "épreuve",
    racine,
    origine: "https://vault.exemple",
    commit: COMMIT,
    complet: true,
    absentes: [],
    enTetes: { "X-Content-Type-Options": "nosniff" },
    exclusions: [{ prefixe: "public/vm/", motif: "banc" }],
  });
  await writeFile(
    join(racine, FICHIER_INVENTAIRE),
    `${JSON.stringify(inventaire, null, 2)}\n`,
    "utf8",
  );
  return inventaire;
}

const ARBRE_TEMOIN = Object.freeze({
  "index.html": "<!doctype html><title>coquille</title>\n",
  "main.mjs": "export const marque = 1;\n",
  "src/vm/volume-manifest.mjs": "export const format = 2;\n",
  "vendor/v86/MANIFEST.json": '{"contract":{"id":"x","version":1}}\n',
});

test("l'inventaire couvre chaque fichier de l'arbre, sous-répertoires compris", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  const inventaire = await inventaireDe(racine);

  assert.deepEqual(
    inventaire.fichiers.map(({ chemin }) => chemin),
    ["index.html", "main.mjs", "src/vm/volume-manifest.mjs", "vendor/v86/MANIFEST.json"],
  );
  assert.equal(inventaire.contrat.id, CONTRAT_INVENTAIRE.id);
  assert.equal(
    inventaire.fichiers.find(({ chemin }) => chemin === "main.mjs").sha256,
    empreinte(ARBRE_TEMOIN["main.mjs"]),
  );
});

test("le fichier d'inventaire est hors de son propre inventaire, et le déclare", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  const inventaire = await inventaireDe(racine);

  assert.ok(
    !inventaire.fichiers.some(({ chemin }) => chemin === FICHIER_INVENTAIRE),
    "un inventaire ne peut pas porter sa propre empreinte : la calculer la changerait",
  );
  assert.deepEqual(inventaire.horsInventaire, [FICHIER_INVENTAIRE]);
});

test("les exclusions décidées sont inscrites dans l'inventaire, avec leur motif", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  const inventaire = await inventaireDe(racine);

  assert.deepEqual(inventaire.exclusions, [{ prefixe: "public/vm/", motif: "banc" }]);
});

test("un arbre intact est conforme, et son empreinte de racine est stable", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  const inventaire = await inventaireDe(racine);
  const ecarts = comparer(inventaire, await relever(racine));

  assert.equal(ecarts.conforme, true);
  assert.deepEqual([ecarts.alteres, ecarts.ajoutes, ecarts.manquants], [[], [], []]);
  assert.equal(ecarts.racineMesuree, inventaire.empreinteDeRacine);
});

test("un fichier ALTÉRÉ est détecté, avec l'empreinte attendue et l'empreinte mesurée", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);

  await writeFile(join(racine, "main.mjs"), "export const marque = 2;\n", "utf8");
  const ecarts = comparer(inventaire, await relever(racine));

  assert.equal(ecarts.conforme, false);
  assert.deepEqual(
    ecarts.alteres.map(({ chemin }) => chemin),
    ["main.mjs"],
  );
  assert.equal(ecarts.alteres[0].attendu.sha256, empreinte(ARBRE_TEMOIN["main.mjs"]));
  assert.equal(ecarts.alteres[0].mesure.sha256, empreinte("export const marque = 2;\n"));
  assert.notEqual(ecarts.racineMesuree, ecarts.racineAttendue);
});

test("une altération de MÊME TAILLE est détectée : la comparaison porte sur les octets", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);

  await writeFile(join(racine, "main.mjs"), "export const marque = 9;\n", "utf8");
  const ecarts = comparer(inventaire, await relever(racine));

  assert.equal(ecarts.alteres.length, 1);
  assert.equal(ecarts.alteres[0].attendu.octets, ecarts.alteres[0].mesure.octets);
});

test("un fichier AJOUTÉ est détecté — c'est le cas des surfaces de mesure", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);

  await mkdir(join(racine, "spike", "origin"), { recursive: true });
  await writeFile(join(racine, "spike", "origin", "app.html"), "<title>hostile</title>\n", "utf8");
  const ecarts = comparer(inventaire, await relever(racine));

  assert.equal(ecarts.conforme, false);
  assert.deepEqual(ecarts.ajoutes, ["spike/origin/app.html"]);
  assert.deepEqual(ecarts.alteres, []);
  assert.deepEqual(ecarts.manquants, []);
});

test("un fichier MANQUANT est détecté", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);

  await rm(join(racine, "src", "vm", "volume-manifest.mjs"));
  const ecarts = comparer(inventaire, await relever(racine));

  assert.equal(ecarts.conforme, false);
  assert.deepEqual(ecarts.manquants, ["src/vm/volume-manifest.mjs"]);
});

test("un RENOMMAGE change l'empreinte de racine, qu'une somme des empreintes ne verrait pas", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);

  const contenu = ARBRE_TEMOIN["main.mjs"];
  await rm(join(racine, "main.mjs"));
  await writeFile(join(racine, "principal.mjs"), contenu, "utf8");
  const ecarts = comparer(inventaire, await relever(racine));

  assert.deepEqual(ecarts.manquants, ["main.mjs"]);
  assert.deepEqual(ecarts.ajoutes, ["principal.mjs"]);
  assert.notEqual(ecarts.racineMesuree, ecarts.racineAttendue);
});

test("l'empreinte de racine ne dépend pas de l'ordre de parcours du système de fichiers", () => {
  const fichiers = [
    { chemin: "b.mjs", octets: 2, sha256: "bb" },
    { chemin: "a.mjs", octets: 1, sha256: "aa" },
  ];
  assert.equal(empreinteDeRacine(fichiers), empreinteDeRacine([...fichiers].reverse()));
});

test("l'empreinte de racine distingue deux arbres de mêmes empreintes mais de tailles déclarées différentes", () => {
  assert.notEqual(
    empreinteDeRacine([{ chemin: "a", octets: 1, sha256: "aa" }]),
    empreinteDeRacine([{ chemin: "a", octets: 2, sha256: "aa" }]),
  );
});
