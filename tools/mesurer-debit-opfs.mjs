#!/usr/bin/env node
// Banc de débit de lecture OPFS par blocs, sur les trois moteurs (#247, lot D, étape 0 de D1).
//
//     node tools/mesurer-debit-opfs.mjs                 # 522 Mio, Chromium, Firefox et WebKit
//     node tools/mesurer-debit-opfs.mjs --mio=64        # fichier plus petit
//     node tools/mesurer-debit-opfs.mjs --essais=3      # plusieurs essais par moteur
//
// Il sert `public/` par `tools/serve.mjs`, ouvre `public/vm/debit-opfs.html` dans chaque moteur
// Playwright et relève ce que le Worker publie : écriture, relecture 4 Kio séquentielle et
// aléatoire par `FileSystemSyncAccessHandle.read(cible, { at })`, empreintes SHA-256 par tranches
// de 8 Mio. Un moteur sans accès synchrone est rapporté tel quel, sans chiffre inventé.
//
// Le rapport JSON est écrit dans `reports/debit-opfs/mesures-debit-opfs.json`.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, firefox, webkit } from "@playwright/test";

const nombre = (nom, defaut) => {
  const option = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return option ? Number(option.split("=")[1]) : defaut;
};

const MIO = nombre("mio", 522);
const ESSAIS = nombre("essais", 1);
const PORT = nombre("port", 4189);
const HOTE = "127.0.0.1";
const ORIGINE = `http://${HOTE}:${PORT}`;
const DELAI_MS = 10 * 60 * 1000;
const MOTEURS = { chromium, firefox, webkit };

async function demarrerServeur() {
  const serveur = spawn(
    process.execPath,
    ["tools/serve.mjs", "--role", "shell", "--host", HOTE, "--port", String(PORT)],
    { stdio: "ignore" },
  );
  for (let essai = 0; essai < 100; essai += 1) {
    try {
      const reponse = await fetch(`${ORIGINE}/vm/debit-opfs.html`);
      if (reponse.ok) return serveur;
    } catch {
      /* le serveur n'écoute pas encore */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  serveur.kill();
  throw new Error(`Le serveur de test n'a pas répondu sur ${ORIGINE}.`);
}

async function mesurerMoteur(nom, type) {
  const navigateur = await type.launch();
  const version = navigateur.version();
  const essais = [];
  try {
    for (let i = 0; i < ESSAIS; i += 1) {
      const contexte = await navigateur.newContext();
      const page = await contexte.newPage();
      await page.goto(`${ORIGINE}/vm/debit-opfs.html?mio=${MIO}`);
      const resultat = await page.evaluate(
        (delai) =>
          Promise.race([
            globalThis.__debitOpfs,
            new Promise((r) => setTimeout(() => r({ ok: false, error: { name: "Délai" } }), delai)),
          ]),
        DELAI_MS,
      );
      essais.push(resultat);
      process.stdout.write(`${nom} essai ${i + 1} : ${JSON.stringify(resultat)}\n`);
      await contexte.close();
    }
  } finally {
    await navigateur.close();
  }
  return { moteur: nom, version, essais };
}

const serveur = await demarrerServeur();
const moteurs = [];
try {
  for (const [nom, type] of Object.entries(MOTEURS)) {
    moteurs.push(await mesurerMoteur(nom, type));
  }
} finally {
  serveur.kill();
}

const dossier = join("reports", "debit-opfs");
mkdirSync(dossier, { recursive: true });
const chemin = join(dossier, "mesures-debit-opfs.json");
writeFileSync(
  chemin,
  `${JSON.stringify({ date: new Date().toISOString(), tailleMio: MIO, moteurs }, null, 2)}\n`,
);
process.stdout.write(`Rapport : ${chemin}\n`);
