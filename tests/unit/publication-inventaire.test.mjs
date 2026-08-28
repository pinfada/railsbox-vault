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
  verifierArbre,
} from "../../tools/publier-inventaire.mjs";
import { lireEmpreinteDeRacine } from "../../tools/publier-empreinte.mjs";

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

async function inventaireDe(racine, surcharges = {}) {
  const inventaire = await construireInventaire({
    arbre: "coquille",
    role: "épreuve",
    racine,
    origine: "https://vault.exemple",
    commit: COMMIT,
    complet: true,
    banc: false,
    absentes: [],
    enTetes: { "X-Content-Type-Options": "nosniff" },
    exclusions: [{ prefixe: "public/vm/", motif: "banc" }],
    ...surcharges,
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

// --- `verifierArbre` : ce qu'elle REFUSE de relire ---------------------------------------------
//
// Un vérificateur qui accepte n'importe quel JSON n'est pas un vérificateur. Ces épreuves fixent
// les trois refus qui séparent « inventaire absent ou étranger » (code 2) d'un « écart
// d'empreintes » (code 1) : les deux se diagnostiquent différemment, et les confondre ferait
// chercher une altération là où il n'y a qu'un fichier manquant.

test("un arbre sans inventaire est refusé, pas traité comme un arbre vide", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  await assert.rejects(() => verifierArbre(racine), { code: "ENOENT" });
});

test("un inventaire d'un AUTRE contrat est refusé en nommant le contrat trouvé", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  await writeFile(
    join(racine, FICHIER_INVENTAIRE),
    JSON.stringify({ contrat: { id: "railsbox-vault-vendor-v86", version: 1 }, fichiers: [] }),
    "utf8",
  );

  await assert.rejects(() => verifierArbre(racine), /railsbox-vault-vendor-v86/u);
});

test("un inventaire SANS contrat est refusé, et le dit", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  await writeFile(join(racine, FICHIER_INVENTAIRE), JSON.stringify({ fichiers: [] }), "utf8");

  await assert.rejects(() => verifierArbre(racine), /aucun/u);
});

test("une VERSION d'inventaire non gérée est refusée plutôt que relue au petit bonheur", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);
  await writeFile(
    join(racine, FICHIER_INVENTAIRE),
    JSON.stringify({
      ...inventaire,
      contrat: { ...CONTRAT_INVENTAIRE, version: CONTRAT_INVENTAIRE.version + 1 },
    }),
    "utf8",
  );

  await assert.rejects(() => verifierArbre(racine), /Version d'inventaire non gérée/u);
});

test("un inventaire illisible — JSON tronqué — est refusé, pas ignoré", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  await writeFile(join(racine, FICHIER_INVENTAIRE), '{"contrat": {"id":', "utf8");

  await assert.rejects(() => verifierArbre(racine), SyntaxError);
});

test("`verifierArbre` rend l'inventaire relu ET les écarts mesurés", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  await inventaireDe(racine);

  const { inventaire, ecarts } = await verifierArbre(racine);
  assert.equal(inventaire.arbre, "coquille");
  assert.equal(ecarts.conforme, true);
});

// --- Complétude : un arbre exact n'est pas pour autant publiable -------------------------------

test("un arbre INCOMPLET porte sa complétude et ses sources absentes dans l'inventaire", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  const inventaire = await inventaireDe(racine, {
    complet: false,
    absentes: ["vendor/v86/artefacts"],
  });

  assert.equal(inventaire.complet, false);
  assert.deepEqual(inventaire.absentes, ["vendor/v86/artefacts"]);
});

test("un arbre incomplet reste CONFORME aux empreintes : les deux verdicts sont distincts", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  await inventaireDe(racine, { complet: false, absentes: ["vendor/v86/artefacts"] });

  const { inventaire, ecarts } = await verifierArbre(racine);
  assert.equal(ecarts.conforme, true, "l'arbre est exactement ce que son inventaire décrit");
  assert.equal(inventaire.complet, false, "et il n'est pourtant pas publiable");
});

test("un arbre de BANC se déclare comme tel, pour ne pas être pris pour une publication", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));

  assert.equal((await inventaireDe(racine, { banc: true })).banc, true);
  assert.equal((await inventaireDe(racine)).banc, false);
});

// --- `publier-empreinte.mjs` : le lecteur employé par le workflow ------------------------------

test("l'empreinte de racine se relit depuis l'inventaire sans interpoler de code", async (t) => {
  const racine = await arbreJetable(ARBRE_TEMOIN);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const inventaire = await inventaireDe(racine);

  const brut = JSON.stringify(inventaire);
  assert.equal(lireEmpreinteDeRacine(brut), inventaire.empreinteDeRacine);
});

test("le lecteur d'empreinte refuse un inventaire étranger ou une empreinte mal formée", () => {
  assert.throws(
    () => lireEmpreinteDeRacine(JSON.stringify({ contrat: { id: "autre" } })),
    /autre/u,
  );
  assert.throws(
    () =>
      lireEmpreinteDeRacine(
        JSON.stringify({ contrat: CONTRAT_INVENTAIRE, empreinteDeRacine: "trop-court" }),
      ),
    /empreinte de racine/u,
  );
});
