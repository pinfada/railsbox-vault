/**
 * Robustesse des ENTRÉES de la chaîne de publication (#106, revue de sécurité de #45).
 *
 * Quatre points, quatre natures de défaut, et ils ne se prouvent pas au même niveau :
 *
 *  - **L1 — ce que l'outil NOMME.** Une référence git invalide et une source qui n'existait pas
 *    encore au commit visé produisent aujourd'hui le même genre de message, alors qu'elles
 *    appellent deux gestes opposés : corriger la référence, ou renoncer à publier cette version.
 *    L'épreuve porte sur la CAUSE écrite dans le message, pas seulement sur le code de sortie.
 *  - **L2 — ce que l'outil EFFACE.** `construireArbre` fait `rm -rf <sortie>/coquille` et
 *    `<sortie>/application` avant d'écrire. Les épreuves fixent le périmètre : sous la racine du
 *    dépôt, et dans un répertoire qui n'appartient qu'à la publication.
 *  - **L3 — ce que la vérification TAIT.** L'inventaire porte `commit.arbreDeTravailPropre` et
 *    `--verifier` ne le relisait pas. Les épreuves exigent qu'il le dise ET que le code de sortie
 *    reste 0 : le contrat 0/1/2/3/4/5/6 documenté en tête de `tools/publier.mjs` n'est pas modifié.
 *  - **L4 — ce que la sonde DEMANDE.** `GET` est CONSERVÉ, et l'épreuve le fixe pour qu'une bascule
 *    vers `HEAD` ne se fasse pas en silence, sans revenir sur le motif écrit.
 *
 * Deux niveaux, comme `tests/unit/v86-garde-memoire.test.mjs` : les fonctions de garde sur des
 * données fabriquées, et la COMMANDE elle-même sur des arbres jetables — une garde correcte que
 * `principal()` n'appelle pas ne garde rien.
 *
 * Les modules qui gagnent des exports dans cette tranche sont importés par leur ESPACE DE NOMS.
 * C'est délibéré : un import nommé d'un export encore absent fait échouer la LIAISON du fichier
 * entier, et le relevé rouge ne dirait plus quelle épreuve échoue pour quelle raison.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { construireInventaire, FICHIER_INVENTAIRE } from "../../tools/publier-inventaire.mjs";
import * as sondeHebergement from "../../tools/publier-sonde-hebergement.mjs";
import * as sources from "../../tools/publier-sources.mjs";
import * as publier from "../../tools/publier.mjs";

const RACINE_DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTIL = join(RACINE_DEPOT, "tools", "publier.mjs");

/** Sources d'épreuve : une source obligatoire versionnée, et rien d'optionnel. */
const SOURCES = Object.freeze([
  Object.freeze({ depuis: "public/index.html", vers: "index.html", role: "épreuve" }),
  Object.freeze({ depuis: "src/vm", vers: "src/vm", role: "épreuve" }),
]);

function git(racine, ...args) {
  execFileSync("git", args, { cwd: racine, stdio: "pipe" });
}

/**
 * Dépôt jetable à DEUX commits : le premier ne connaît pas `src/vm`, le second l'ajoute. C'est
 * exactement la situation de L1 — une référence valide dont l'arbre est lisible, et où une source
 * obligatoire n'existe pas encore.
 */
async function depotJetable() {
  const racine = await mkdtemp(join(tmpdir(), "vault-106-depot-"));
  git(racine, "init", "-q", "-b", "principale");
  git(racine, "config", "user.email", "epreuve@exemple.invalid");
  git(racine, "config", "user.name", "Épreuve 106");
  await mkdir(join(racine, "public"), { recursive: true });
  await writeFile(join(racine, "public", "index.html"), "<!doctype html>\n", "utf8");
  git(racine, "add", "-A");
  git(racine, "commit", "-qm", "avant src/vm");
  await mkdir(join(racine, "src", "vm"), { recursive: true });
  await writeFile(join(racine, "src", "vm", "blocs.mjs"), "export const x = 1;\n", "utf8");
  git(racine, "add", "-A");
  git(racine, "commit", "-qm", "avec src/vm");
  return racine;
}

async function repertoireJetable() {
  return mkdtemp(join(tmpdir(), "vault-106-"));
}

async function existe(chemin) {
  try {
    await stat(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Exécute `tools/publier.mjs` et rend son code de sortie réel avec ses deux flux. */
function lancerPublier(args) {
  return new Promise((resoudre) => {
    execFile(
      process.execPath,
      [OUTIL, ...args],
      { cwd: RACINE_DEPOT, encoding: "utf8" },
      (erreur, stdout, stderr) => resoudre({ code: erreur?.code ?? 0, stdout, stderr }),
    );
  });
}

const COMMIT_PROPRE = Object.freeze({
  reference: "HEAD",
  empreinte: "a".repeat(40),
  date: "2026-08-28T00:00:00+02:00",
  arbreGit: "b".repeat(40),
  arbreDeTravailPropre: true,
});

/** Arbre publié minimal, cohérent avec son inventaire, prêt pour `--verifier`. */
async function arbrePublie(commit) {
  const racine = await repertoireJetable();
  await writeFile(join(racine, "index.html"), "<!doctype html>\n", "utf8");
  const inventaire = await construireInventaire({
    arbre: "coquille",
    role: "épreuve",
    racine,
    origine: "https://coquille.epreuve",
    commit,
    complet: true,
    banc: false,
    absentes: [],
    enTetes: {},
    exclusions: [],
  });
  await writeFile(
    join(racine, FICHIER_INVENTAIRE),
    `${JSON.stringify(inventaire, null, 2)}\n`,
    "utf8",
  );
  return racine;
}

// ---------------------------------------------------------------------------------------------
// L1 — la cause est NOMMÉE
// ---------------------------------------------------------------------------------------------

test("L1 — une référence git inconnue est refusée en la nommant, pas par un échec de `git ls-tree`", async () => {
  const racine = await depotJetable();
  const destination = await repertoireJetable();
  try {
    await assert.rejects(
      () =>
        sources.materialiser({
          racine,
          reference: "cette-ref-n-existe-pas",
          sources: SOURCES,
          destination,
        }),
      (erreur) => {
        assert.equal(
          erreur.referenceInvalide,
          true,
          "l'erreur doit se déclarer référence invalide",
        );
        assert.match(erreur.message, /cette-ref-n-existe-pas/);
        assert.match(erreur.message, /[Rr]éférence git/);
        assert.doesNotMatch(
          erreur.message,
          /ls-tree|Command failed/,
          "le message ne doit pas être un dump de la commande git",
        );
        return true;
      },
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("L1 — une source obligatoire qui n'existait PAS ENCORE au commit le dit, plutôt que « absente »", async () => {
  const racine = await depotJetable();
  const destination = await repertoireJetable();
  try {
    await assert.rejects(
      () => sources.materialiser({ racine, reference: "HEAD~1", sources: SOURCES, destination }),
      (erreur) => {
        assert.match(erreur.message, /src\/vm/);
        assert.match(erreur.message, /n'existait pas/i);
        assert.equal(erreur.sourceAbsente, true, "le code de sortie 4 reste le bon");
        assert.equal(erreur.motif, "absenteAuCommit");
        return true;
      },
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("L1 — une source absente de l'ARBRE DE TRAVAIL reçoit un message distinct", async () => {
  const racine = await depotJetable();
  const destination = await repertoireJetable();
  try {
    await rm(join(racine, "src"), { recursive: true, force: true });
    await assert.rejects(
      () => sources.materialiser({ racine, reference: null, sources: SOURCES, destination }),
      (erreur) => {
        assert.match(erreur.message, /arbre de travail/i);
        assert.equal(erreur.sourceAbsente, true);
        assert.equal(erreur.motif, "absenteDeLArbreDeTravail");
        return true;
      },
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("L1 — `--commit` sur une référence inconnue n'EFFACE PAS la publication précédente", async () => {
  const sortie = join(RACINE_DEPOT, "artifacts", `epreuve-106-${process.pid}`);
  try {
    const construction = await lancerPublier(["--sortie", sortie, "--tolerer-incomplet"]);
    assert.equal(construction.code, 0, construction.stderr);
    const avant = await readFile(join(sortie, "coquille", FICHIER_INVENTAIRE), "utf8");

    const refus = await lancerPublier([
      "--commit",
      "cette-ref-n-existe-pas",
      "--sortie",
      sortie,
      "--tolerer-incomplet",
    ]);
    assert.match(refus.stderr, /cette-ref-n-existe-pas/);
    assert.equal(
      await existe(join(sortie, "coquille", FICHIER_INVENTAIRE)),
      true,
      "l'arbre précédent a été EFFACÉ avant que la référence ne soit refusée",
    );
    assert.equal(
      await readFile(join(sortie, "coquille", FICHIER_INVENTAIRE), "utf8"),
      avant,
      "l'arbre précédent doit être intact : le refus précède l'effacement",
    );
    assert.equal(refus.code, 3, `attendu 3 (usage), obtenu ${refus.code}`);
  } finally {
    await rm(sortie, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// L2 — ce que `--sortie` autorise à effacer
// ---------------------------------------------------------------------------------------------

test("L2 — une sortie hors de la racine du dépôt est refusée", async () => {
  const dehors = await repertoireJetable();
  const racine = await repertoireJetable();
  try {
    await assert.rejects(
      () => publier.exigerSortieUtilisable(join(dehors, "publication"), racine),
      (erreur) => {
        assert.match(erreur.message, /racine du dépôt/i);
        return true;
      },
    );
  } finally {
    await rm(dehors, { recursive: true, force: true });
    await rm(racine, { recursive: true, force: true });
  }
});

test("L2 — la racine du dépôt elle-même n'est pas une sortie", async () => {
  const racine = await repertoireJetable();
  try {
    await assert.rejects(() => publier.exigerSortieUtilisable(racine, racine), /racine du dépôt/i);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("L2 — une sortie qui contient autre chose que des arbres de publication est refusée, et l'intrus est nommé", async () => {
  const racine = await repertoireJetable();
  const sortie = join(racine, "documents");
  try {
    await mkdir(sortie, { recursive: true });
    await writeFile(join(sortie, "notes-importantes.txt"), "à ne pas effacer\n", "utf8");
    await assert.rejects(
      () => publier.exigerSortieUtilisable(sortie, racine),
      (erreur) => {
        assert.match(erreur.message, /notes-importantes\.txt/);
        return true;
      },
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("L2 — une sortie absente, vide, ou d'une publication précédente est acceptée", async () => {
  const racine = await repertoireJetable();
  try {
    await publier.exigerSortieUtilisable(join(racine, "jamais-construit"), racine);

    const vide = join(racine, "vide");
    await mkdir(vide, { recursive: true });
    await publier.exigerSortieUtilisable(vide, racine);

    const precedente = join(racine, "precedente");
    await mkdir(join(precedente, "coquille"), { recursive: true });
    await mkdir(join(precedente, "application"), { recursive: true });
    await publier.exigerSortieUtilisable(precedente, racine);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("L2 — la commande refuse une sortie hors du dépôt en code 3, sans rien créer", async () => {
  const dehors = join(tmpdir(), `vault-106-hors-depot-${process.pid}`);
  try {
    const refus = await lancerPublier(["--sortie", dehors, "--tolerer-incomplet"]);
    assert.equal(refus.code, 3, `attendu 3 (usage), obtenu ${refus.code} — ${refus.stderr}`);
    assert.match(refus.stderr, /racine du dépôt/i);
    assert.equal(await existe(dehors), false, "aucun répertoire ne doit avoir été créé");
  } finally {
    await rm(dehors, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// L3 — la provenance est DITE, sans changer le contrat des codes de sortie
// ---------------------------------------------------------------------------------------------

test("L3 — un inventaire construit sur un arbre de travail propre ne déclenche aucun avertissement", () => {
  const provenance = publier.provenanceDeLInventaire({ commit: COMMIT_PROPRE });
  assert.equal(provenance.avertissement, false);
  assert.match(provenance.ligne, /propre/i);
});

test("L3 — un inventaire construit sur un arbre de travail SALE est signalé", () => {
  const provenance = publier.provenanceDeLInventaire({
    commit: { ...COMMIT_PROPRE, arbreDeTravailPropre: false },
  });
  assert.equal(provenance.avertissement, true);
  assert.match(provenance.ligne, /AVERTISSEMENT/);
  assert.match(provenance.ligne, /arbre de travail/i);
});

test("L3 — un inventaire sans empreinte de commit annonce une provenance INCONNUE", () => {
  const provenance = publier.provenanceDeLInventaire({
    commit: { ...COMMIT_PROPRE, empreinte: null, arbreDeTravailPropre: false },
  });
  assert.equal(provenance.avertissement, true);
  assert.match(provenance.ligne, /inconnue/i);
});

test("L3 — `--verifier` avertit sur un arbre bâti d'un disque sale, et rend TOUJOURS 0", async () => {
  const arbre = await arbrePublie({ ...COMMIT_PROPRE, arbreDeTravailPropre: false });
  try {
    const verification = await lancerPublier(["--verifier", arbre]);
    assert.equal(
      verification.code,
      0,
      "le contrat des codes de sortie est inchangé : ce n'est pas un écart",
    );
    assert.match(`${verification.stdout}${verification.stderr}`, /AVERTISSEMENT/);
    assert.match(`${verification.stdout}${verification.stderr}`, /arbre de travail/i);
  } finally {
    await rm(arbre, { recursive: true, force: true });
  }
});

test("L3 — `--verifier` n'avertit PAS sur un arbre bâti d'un disque propre", async () => {
  const arbre = await arbrePublie(COMMIT_PROPRE);
  try {
    const verification = await lancerPublier(["--verifier", arbre]);
    assert.equal(verification.code, 0, verification.stderr);
    assert.doesNotMatch(`${verification.stdout}${verification.stderr}`, /AVERTISSEMENT/);
    assert.match(verification.stdout, /propre/i);
  } finally {
    await rm(arbre, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// L4 — la sonde d'hébergement garde GET, et le dit
// ---------------------------------------------------------------------------------------------

test("L4 — la sonde d'hébergement interroge en GET", async () => {
  const demandes = [];
  const fauxFetch = async (url, init) => {
    demandes.push({ url, init });
    return { status: 200, url, headers: new Headers({ server: "épreuve" }) };
  };
  const releve = await sondeHebergement.interroger(
    { hebergeur: "Épreuve", url: "https://exemple.invalid/", mecanismeDEnTetes: "aucun" },
    fauxFetch,
  );
  assert.equal(demandes.length, 1);
  assert.equal(demandes[0].init.method, "GET");
  assert.equal(releve.statut, 200);
  assert.equal(releve.enTetes.server, "épreuve");
});

test("L4 — le choix de GET porte son motif écrit, qui nomme HEAD", () => {
  assert.equal(sondeHebergement.METHODE_SONDE.methode, "GET");
  assert.match(sondeHebergement.METHODE_SONDE.motif, /HEAD/);
  assert.ok(
    sondeHebergement.METHODE_SONDE.motif.length > 80,
    "un motif accepté doit être écrit, pas déclaré",
  );
});
