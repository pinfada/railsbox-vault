/**
 * Le `.gitignore` et le lien symbolique `node_modules` (#127).
 *
 * `node_modules/` — avec la barre — ne filtre que la forme RÉPERTOIRE. Un worktree qui adosse son
 * `node_modules` par lien symbolique à l'installation d'un autre arbre de travail voit ce lien
 * apparaître dans `git status --porcelain` comme un fichier non suivi : le chemin du lien porte un
 * dtype qui n'est pas un répertoire, et un motif à barre ne couvre que les répertoires.
 * `construireInventaire` inscrit alors un arbre sale, et `--verifier` avertit sans désigner rien
 * de réel. Retirer la barre couvre les deux formes.
 *
 * La contrepartie est écrite dans l'issue : un FICHIER nommé `node_modules` devient aussi couvert,
 * et la décision l'accepte — aucun usage légitime ici, et le lien en a un. Les autres entrées du
 * `.gitignore` gardent la leur : la décision n'est actée que pour celle-ci.
 *
 * Les épreuves lisent le verdict de `git check-ignore` sur un dépôt jetable portant le VRAI
 * `.gitignore` du projet. Sous POSIX, `node_modules` est posé en vrai lien symbolique. Sous
 * Windows sans privilège, git 2.49 lit la JONCTION comme un répertoire — mesuré : `git status
 * -uall` y descend — si bien que la forme à barre l'ignore déjà et que le défaut ne s'y reproduit
 * pas par elle ; c'est alors le fichier régulier nommé `node_modules` qui porte l'épreuve du dtype
 * non-répertoire que la barre laisse visible.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RACINE_DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(racine, ...args) {
  return execFileSync("git", args, { cwd: racine, encoding: "utf8", stdio: "pipe" });
}

/** Le verdict de `git check-ignore` : 0 si le chemin est ignoré, 1 sinon. */
function statutIgnorance(racine, chemin) {
  return spawnSync("git", ["check-ignore", "--", chemin], { cwd: racine }).status;
}

/** Dépôt git jetable portant le `.gitignore` RÉEL du projet. */
async function depotJetable() {
  const racine = await mkdtemp(join(tmpdir(), "vault-127-depot-"));
  git(racine, "init", "-q", "-b", "principale");
  await cp(join(RACINE_DEPOT, ".gitignore"), join(racine, ".gitignore"));
  return racine;
}

/**
 * Pose `node_modules` sous le type de lien que la plate-forme accepte sans privilège : un lien
 * symbolique là où c'est permis, et une jonction sous Windows quand le privilège manque.
 */
async function poserLien(racine, cible) {
  const lien = join(racine, "node_modules");
  try {
    await symlink(cible, lien, "dir");
  } catch {
    await symlink(cible, lien, "junction");
  }
  return lien;
}

/** Retire un lien sans suivre ce qu'il désigne. */
async function retirerLien(lien) {
  try {
    await unlink(lien);
  } catch {
    await rmdir(lien);
  }
}

test("un node_modules qui est un lien est ignoré par le .gitignore du projet", async () => {
  const racine = await depotJetable();
  const cible = await mkdtemp(join(tmpdir(), "vault-127-cible-"));
  const lien = await poserLien(racine, cible);
  try {
    assert.equal(statutIgnorance(racine, "node_modules"), 0);
  } finally {
    await retirerLien(lien);
    await rm(racine, { recursive: true, force: true });
    await rm(cible, { recursive: true, force: true });
  }
});

test("la décision de l'issue : node_modules est couvert hors de la forme répertoire", async () => {
  // La barre ne couvre que les répertoires : c'est tout l'objet de #127. Sous POSIX c'est le lien
  // symbolique qui porte le dtype non-répertoire ; sous Windows sans privilège, le fichier régulier
  // du même nom le porte aussi bien, et la décision accepte qu'il soit couvert.
  const racine = await depotJetable();
  try {
    await writeFile(
      join(racine, "node_modules"),
      "ce contenu n'est pas une installation\n",
      "utf8",
    );
    assert.equal(statutIgnorance(racine, "node_modules"), 0);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un worktree adossé par lien à une installation partagée est déclaré propre", async () => {
  const racine = await depotJetable();
  const cible = await mkdtemp(join(tmpdir(), "vault-127-cible-"));
  const lien = await poserLien(racine, cible);
  try {
    git(racine, "config", "user.email", "epreuve@exemple.invalid");
    git(racine, "config", "user.name", "Épreuve 127");
    git(racine, "add", ".gitignore");
    git(racine, "commit", "-qm", "dépôt d'épreuve");
    assert.equal(git(racine, "status", "--porcelain").trim(), "");
  } finally {
    await retirerLien(lien);
    await rm(racine, { recursive: true, force: true });
    await rm(cible, { recursive: true, force: true });
  }
});

test("un node_modules qui est un vrai répertoire reste ignoré", async () => {
  const racine = await depotJetable();
  try {
    await mkdir(join(racine, "node_modules", "paquet"), { recursive: true });
    const module = join(racine, "node_modules", "paquet", "index.js");
    await writeFile(module, "export const x = 1;\n", "utf8");
    assert.equal(statutIgnorance(racine, "node_modules"), 0);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});
