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
 *  - **L5 — ce que l'arbre publié CONTIENT sous `vendor/v86/artefacts/`** (#103, revue de l'ADR
 *    0023). Ce répertoire est ignoré par git et peuplé par `npm run vm:fetch` ; la copie de
 *    publication le prend en bloc, et la règle de cache `/vendor/v86/*` accorde 24 h de cache
 *    PARTAGÉ à tout ce qui s'y trouve. Un fichier qui n'est pas dans `vendor/v86/MANIFEST.json`
 *    n'a donc rien à y faire : les épreuves exigent qu'il soit un ÉCART, pas un artefact publié.
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
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  construireInventaire,
  empreinte,
  FICHIER_INVENTAIRE,
} from "../../tools/publier-inventaire.mjs";
import { nomAdresse } from "../../src/v86-adresses.mjs";
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

/**
 * Arbre publié minimal, cohérent avec son inventaire, prêt pour `--verifier`.
 *
 * Il se nomme « épreuve » et non « coquille », et c'est délibéré depuis #22 : `--verifier` déduit
 * de la décision de publication les épinglages qu'un arbre DOIT porter, et un arbre qui se
 * réclamerait de la coquille sans porter les manifestes vendus est un arbre ROMPU. Ce que ces
 * épreuves-ci mesurent est la PROVENANCE et le contrat des codes de sortie ; leur faire porter en
 * plus deux manifestes d'artefacts tiers les rendrait dépendantes d'une décision qu'elles
 * n'éprouvent pas.
 */
async function arbrePublie(commit) {
  const racine = await repertoireJetable();
  await writeFile(join(racine, "index.html"), "<!doctype html>\n", "utf8");
  const inventaire = await construireInventaire({
    arbre: "épreuve",
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

/**
 * Un lien de répertoire, du type que la plate-forme sait poser sans privilège.
 *
 * Sous Windows, un lien symbolique de répertoire exige `SeCreateSymbolicLinkPrivilege` ; une
 * JONCTION, non — et elle traverse aussi bien. C'est donc elle que l'attaque emploierait, et elle
 * que l'épreuve pose.
 */
const TYPE_DE_LIEN = process.platform === "win32" ? "junction" : "dir";

/** Retire un lien de répertoire SANS suivre ce qu'il désigne. */
async function retirerLien(lien) {
  try {
    await unlink(lien);
  } catch {
    await rmdir(lien);
  }
}

test("L2 — un lien de répertoire qui SORT du dépôt est refusé, chemin réel à l'appui", async () => {
  // `relative()` est lexical : `<racine>/lien/publication` lui paraît interne quoi que `lien`
  // désigne. Le `rm -rf` qui suit, lui, TRAVERSE le lien. La garde doit donc parler du chemin
  // RÉEL, pas de la chaîne demandée.
  const dehors = await repertoireJetable();
  const racine = await repertoireJetable();
  const lien = join(racine, "artifacts-lie");
  try {
    await symlink(dehors, lien, TYPE_DE_LIEN);
    await assert.rejects(
      () => publier.exigerSortieUtilisable(join(lien, "publication"), racine),
      (erreur) => {
        assert.match(erreur.message, /racine du dépôt/i);
        return true;
      },
    );
  } finally {
    await retirerLien(lien);
    await rm(racine, { recursive: true, force: true });
    await rm(dehors, { recursive: true, force: true });
  }
});

test("L2 — la commande refuse une sortie liée hors du dépôt, et n'efface RIEN dehors", async () => {
  // L'épreuve de bout en bout : la jonction est posée sous `artifacts/`, que `.gitignore` couvre et
  // où la garde d'ergonomie croyait être chez elle. Sans correctif, `rm -rf <sortie>/coquille`
  // traverse le lien et emporte le témoin, hors du dépôt, sans que git n'en montre rien.
  const dehors = await repertoireJetable();
  const temoin = join(dehors, "coquille", "hors-depot.txt");
  const lien = join(RACINE_DEPOT, "artifacts", `epreuve-106-jonction-${process.pid}`);
  try {
    await mkdir(join(dehors, "coquille"), { recursive: true });
    await writeFile(temoin, "ce fichier n'appartient pas au dépôt\n", "utf8");
    await mkdir(join(RACINE_DEPOT, "artifacts"), { recursive: true });
    await symlink(dehors, lien, TYPE_DE_LIEN);

    const refus = await lancerPublier(["--sortie", lien, "--tolerer-incomplet"]);
    assert.equal(
      await existe(temoin),
      true,
      "le `rm -rf` a traversé le lien et effacé hors du dépôt",
    );
    assert.equal(refus.code, 3, `attendu 3 (usage), obtenu ${refus.code} — ${refus.stderr}`);
    assert.match(refus.stderr, /racine du dépôt/i);
  } finally {
    await retirerLien(lien);
    await rm(dehors, { recursive: true, force: true });
  }
});

test("L2 — un répertoire dont le nom COMMENCE par deux points n'est pas « hors du dépôt »", async () => {
  // `interne.startsWith("..")` refusait `..donnees` avec un message qui affirmait un fait faux :
  // ce chemin est sous la racine. Seul un segment `..` en sort.
  const racine = await repertoireJetable();
  try {
    await publier.exigerSortieUtilisable(join(racine, "..donnees"), racine);
    await publier.exigerSortieUtilisable(join(racine, "..", "vraiment-dehors"), racine).then(
      () => assert.fail("un segment `..` sort bel et bien de la racine"),
      (erreur) => assert.match(erreur.message, /racine du dépôt/i),
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------------------------
// L5 — ce que l'arbre publié contient sous `vendor/v86/artefacts/` (#103)
// ---------------------------------------------------------------------------------------------

/**
 * Arbre publié minimal portant un épinglage v86 : un manifeste, et le répertoire d'artefacts qu'il
 * décrit. `presents` peut contenir plus que `declares` — c'est exactement le cas à refuser.
 *
 * @param {{ declares: Record<string, string>, presents?: Record<string, string> }} contenu
 */
async function arbreEpingle({ declares, presents = {} }) {
  const racine = await repertoireJetable();
  const dossier = join(racine, "vendor", "v86", "artefacts");
  await mkdir(dossier, { recursive: true });
  const artifacts = [];
  const adresses = new Map();
  for (const [nom, octets] of Object.entries(declares)) {
    const sha256 = empreinte(Buffer.from(octets, "utf8"));
    // Le fichier est déposé à l'ADRESSE que son empreinte dicte (#123), pas sous son nom nu.
    adresses.set(nom, nomAdresse(nom, sha256));
    await writeFile(join(dossier, adresses.get(nom)), octets, "utf8");
    artifacts.push({ name: nom, sha256 });
  }
  for (const [nom, octets] of Object.entries(presents)) {
    await writeFile(join(dossier, nom), octets, "utf8");
  }
  await writeFile(
    join(racine, "vendor", "v86", "MANIFEST.json"),
    `${JSON.stringify({ artifacts }, null, 2)}\n`,
    "utf8",
  );
  // La copie du manifeste adressée par sa propre empreinte fait partie de tout arbre publié
  // depuis #123 : sans elle, la vérification la déclarerait absente.
  await sources.ecrireManifesteEpingle(racine, empreinte);
  return { racine, adresses };
}

test("L5 — un arbre dont chaque artefact présent est déclaré et conforme ne porte AUCUN écart", async () => {
  const { racine } = await arbreEpingle({ declares: { "v86.wasm": "octets de l'émulateur" } });
  try {
    const epinglage = await sources.verifierEpinglageV86(racine, empreinte);
    assert.equal(epinglage.verifie, true);
    assert.deepEqual(epinglage.ecarts, []);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("L5 — un fichier PRÉSENT mais non déclaré au manifeste est un écart, pas un artefact publié", async () => {
  // La classe de cache `epinglage-v86` est accordée par EMPLACEMENT, et #123 en a relevé l'enjeu
  // d'un cran : le préfixe `/vendor/v86/artefacts/*` vaut désormais UN AN de cache partagé et
  // `immutable`, là où l'ADR 0023 accordait vingt-quatre heures et où `no-store` régnait avant
  // elle. Un intrus déposé dans ce répertoire — ignoré par git — partirait donc chez l'hébergeur
  // sans révocation possible. Le manifeste est la seule liste de ce qui a le droit d'être là
  // (ADR 0003) : ce qui n'y est pas est un écart.
  const { racine } = await arbreEpingle({
    declares: { "v86.wasm": "octets de l'émulateur" },
    presents: { "dump-de-debug.bin": "trace d'un poste de développement" },
  });
  try {
    const epinglage = await sources.verifierEpinglageV86(racine, empreinte);
    assert.equal(epinglage.verifie, true);
    assert.equal(epinglage.ecarts.length, 1, "l'intrus doit être relevé, une fois");
    assert.equal(epinglage.ecarts[0].artefact, "dump-de-debug.bin");
    assert.match(epinglage.ecarts[0].motif, /non déclaré/i);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("L5 — l'écart « non déclaré » se cumule avec les deux autres, sans les masquer", async () => {
  const { racine, adresses } = await arbreEpingle({
    declares: { "v86.wasm": "octets de l'émulateur", "seabios.bin": "octets du BIOS" },
    presents: { "dump-de-debug.bin": "trace" },
  });
  try {
    await writeFile(
      join(racine, "vendor", "v86", "artefacts", adresses.get("v86.wasm")),
      "autres octets",
      "utf8",
    );
    await rm(join(racine, "vendor", "v86", "artefacts", adresses.get("seabios.bin")));
    const motifs = (await sources.verifierEpinglageV86(racine, empreinte)).ecarts.map(
      ({ artefact, motif }) => `${artefact} : ${motif}`,
    );
    assert.equal(motifs.length, 3, motifs.join(" / "));
    assert.ok(motifs.some((ligne) => /^v86-[0-9a-f]{16}\.wasm : empreinte/.test(ligne)));
    assert.ok(motifs.some((ligne) => /^seabios-[0-9a-f]{16}\.bin : absent/.test(ligne)));
    assert.ok(motifs.some((ligne) => /dump-de-debug\.bin : non déclaré/.test(ligne)));
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});
