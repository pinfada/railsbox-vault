#!/usr/bin/env node
// PRODUIT la fixture d'un coffre de développement ANTÉRIEUR à l'ADR 0039 (#207).
//
//     node tools/produire-coffre-anterieur.mjs [--commit bb59de7] [--sortie <fichier.json>]
//
// La fixture n'est pas fabriquée : c'est la coquille du commit donné — le produit d'avant « un
// coffre, une identité » — qui crée le coffre, dans un vrai Chromium, par le geste d'un utilisateur
// (une phrase), puis qui le verrouille. L'outil ne fait que relever, octet pour octet, ce que cette
// coquille a laissé dans l'OPFS de son origine, et l'écrit en base64 avec sa provenance.
//
// `tests/browser/coquille-portabilite.spec.mjs` rejoue ces fichiers dans l'OPFS de la coquille
// courante et exige `VAULT_COQUILLE_COFFRE_ANTERIEUR`, rendu dès l'inventaire.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/* global document */
import { chromium } from "@playwright/test";

const PORT = 4291;
const PHRASE = "une phrase de coffre antérieur, pour la fixture de #207";

function lireOption(nom, defaut) {
  const rang = process.argv.indexOf(`--${nom}`);
  return rang === -1 ? defaut : process.argv[rang + 1];
}

function extraire(commit, dossier) {
  const tar = join(dossier, "source.tar");
  const archive = spawnSync("git", ["archive", "--format=tar", "-o", tar, commit], {
    stdio: "inherit",
  });
  if (archive.status !== 0) throw new Error(`git archive ${commit} a échoué`);
  const racine = join(dossier, "source");
  mkdirSync(racine, { recursive: true });
  // Chemins RELATIFS : un tar de l'hôte lit « C: » comme un hôte distant.
  const extrait = spawnSync("tar", ["-xf", "source.tar", "-C", "source"], {
    cwd: dossier,
    stdio: "inherit",
  });
  if (extrait.status !== 0) throw new Error("tar -xf a échoué");
  return racine;
}

async function attendreLeServeur(url) {
  for (let essai = 0; essai < 100; essai += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((fin) => setTimeout(fin, 200));
  }
  throw new Error(`le serveur de l'ancienne coquille ne répond pas : ${url}`);
}

async function relever(page) {
  return page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const volumes = await racine.getDirectoryHandle("vault-volumes");
    const fichiers = {};
    for await (const [nom, handle] of volumes.entries()) {
      if (handle.kind !== "file") continue;
      const octets = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      let binaire = "";
      for (const octet of octets) binaire += String.fromCharCode(octet);
      fichiers[nom] = btoa(binaire);
    }
    return fichiers;
  });
}

async function principal() {
  const commit = lireOption("commit", "bb59de7");
  const sortie = resolve(
    lireOption("sortie", "tests/fixtures/coffre-anterieur/coffre-anterieur.json"),
  );
  const atelier = await mkdtemp(join(tmpdir(), "coffre-anterieur-"));
  const racine = extraire(commit, atelier);
  const serveur = spawn(
    process.execPath,
    ["tools/serve.mjs", "--role", "shell", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: racine, stdio: "ignore" },
  );
  const navigateur = await chromium.launch();
  try {
    const origine = `http://127.0.0.1:${PORT}`;
    await attendreLeServeur(`${origine}/index.html`);
    const page = await navigateur.newPage();
    await page.goto(`${origine}/index.html`);
    await page.locator("#deverrouillage-moyens").filter({ hasText: /./ }).waitFor();
    await page.fill("#saisie-phrase", PHRASE);
    await page.click("#ouvrir-par-phrase");
    await page.waitForFunction(
      () => JSON.parse(document.querySelector("#coquille-rapport").textContent).etat === "ouvert",
      null,
      { timeout: 120_000 },
    );
    await page.click("#verrouiller-le-coffre");
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector("#coquille-rapport").textContent).etat === "verrouille",
      null,
      { timeout: 120_000 },
    );
    const fichiers = await relever(page);
    await mkdir(dirname(sortie), { recursive: true });
    await writeFile(
      sortie,
      `${JSON.stringify(
        {
          provenance: {
            commit,
            produitLe: new Date().toISOString(),
            outil: "tools/produire-coffre-anterieur.mjs",
            moteur: `chromium ${navigateur.version()}`,
            geste: "coffre créé par la phrase de la fixture, puis verrouillé par le bouton",
            phrase: PHRASE,
          },
          fichiers,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`${Object.keys(fichiers).join(", ")} → ${sortie}\n`);
  } finally {
    await navigateur.close();
    serveur.kill();
    // Sous Windows, le serveur tué tient encore son répertoire un instant : l'atelier temporaire
    // est laissé au système plutôt que de faire échouer une fixture déjà écrite.
    await new Promise((fin) => serveur.once("exit", fin));
    await rm(atelier, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

await principal();
