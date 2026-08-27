#!/usr/bin/env node
// Mesure le coût de calcul du scellement (#17, ADR 0015).
//
//     node tools/mesurer-scellement.mjs                 # Node seul
//     node tools/mesurer-scellement.mjs --navigateur    # Node + Chromium, dans un vrai Worker
//     node tools/mesurer-scellement.mjs --essais=5 --lot=4
//
// Pourquoi cet outil existe : l'ADR 0015 décide d'ajouter un chiffrement authentifié à chaque
// secteur, et « un coût que personne ne mesure finit par être supposé nul » (ADR 0014). Le chiffre
// qui compte n'est PAS le débit d'AES — les cœurs modernes portent AES-NI —, c'est le coût PAR APPEL
// de `crypto.subtle`, parce que le format scelle des blocs de 512 octets un par un. C'est ce que ce
// banc sépare : il mesure 8192 appels sur 512 octets, puis UN appel sur les mêmes 4 Mio.
//
// La mesure du NAVIGATEUR fait foi : le produit vit dans un Worker (ADR 0002) et l'implémentation
// WebCrypto de Node n'est pas celle de Chromium. La mesure Node est publiée à côté pour ce qu'elle
// est — un point de comparaison, pas un substitut.
//
// Le banc est un MODULE unique (`SOURCE_BANC`), exécuté deux fois : importé par Node, servi au
// Worker de Chromium. Comparer deux bancs distincts ne dirait rien des deux moteurs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = new URL("../", import.meta.url);
const RAPPORT = new URL("../reports/crypto/mesures-scellement.json", import.meta.url);

const ARGS = process.argv.slice(2);
const drapeau = (nom) => ARGS.includes(`--${nom}`);
const nombre = (nom, defaut) => {
  const trouve = ARGS.find((arg) => arg.startsWith(`--${nom}=`));
  return trouve === undefined ? defaut : Number(trouve.slice(nom.length + 3));
};

const ESSAIS = nombre("essais", 5);
const LOT_MIO = nombre("lot", 4);
const SECTEUR = 512;

const SOURCE_BANC = `
import {
  importerCleDeVolume,
  ouvrirBloc,
  scellerBloc,
} from "/src/vm/format-chiffre/modele-reference.mjs";
import { ALGORITHME_WEBCRYPTO } from "/src/vm/format-chiffre/identite-logique.mjs";

export async function mesurer({ essais, lotMio, secteur }) {
  const blocs = (lotMio * 1024 * 1024) / secteur;
  const cle = await importerCleDeVolume(Uint8Array.from({ length: 32 }, (_, i) => i));
  const contenu = Uint8Array.from({ length: secteur }, (_, i) => (i * 7 + 13) % 256);
  const gros = new Uint8Array(lotMio * 1024 * 1024);
  // Nonce NUL, et uniquement pour ce point de mesure : cet appel unique sert à isoler le coût FIXE
  // d'un appel de \`crypto.subtle\` du coût du chiffrement lui-même, il ne produit rien qui soit
  // conservé, et il n'a lieu qu'une fois par essai. Aucun chemin du modèle n'emploie de nonce fixe.
  const nonceDeMesure = new Uint8Array(12);
  const releves = { scellement: [], ouverture: [], appelUnique: [] };

  const identite = (rang) => ({
    volume: "banc-de-mesure",
    formatVersion: 3,
    generation: 1,
    rang,
    adresse: (rang % 2048) * secteur,
    longueur: secteur,
  });

  for (let essai = 0; essai < essais; essai += 1) {
    const scelles = new Array(blocs);

    let debut = performance.now();
    for (let rang = 0; rang < blocs; rang += 1) {
      scelles[rang] = await scellerBloc({
        cle,
        identite: identite(rang),
        contenu,
        attentes: { scellementsCumules: rang },
      });
    }
    releves.scellement.push(performance.now() - debut);

    debut = performance.now();
    for (let rang = 0; rang < blocs; rang += 1) {
      await ouvrirBloc({
        cle,
        identite: identite(rang),
        scelle: scelles[rang],
        attentes: { generationMinimale: null },
      });
    }
    releves.ouverture.push(performance.now() - debut);

    debut = performance.now();
    await crypto.subtle.encrypt(
      { name: ALGORITHME_WEBCRYPTO, iv: nonceDeMesure, tagLength: 128 },
      cle,
      gros,
    );
    releves.appelUnique.push(performance.now() - debut);
  }
  return { blocs, releves };
}
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>banc de scellement</title>
<script type="module">
  const worker = new Worker("/banc-worker.mjs", { type: "module" });
  globalThis.__lancer = (parametres) =>
    new Promise((resoudre, rejeter) => {
      worker.onmessage = (evenement) => resoudre(evenement.data);
      worker.onerror = (evenement) => rejeter(new Error(evenement.message));
      worker.postMessage(parametres);
    });
</script>`;

const WORKER = `
import { mesurer } from "/banc.mjs";
self.onmessage = async (evenement) => {
  try {
    self.postMessage({ ok: true, ...(await mesurer(evenement.data)) });
  } catch (erreur) {
    self.postMessage({ ok: false, message: String(erreur) });
  }
};
`;

function percentile(valeurs, rang) {
  const triees = [...valeurs].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((rang / 100) * triees.length) - 1);
  return triees[Math.min(index, triees.length - 1)];
}

function resumer(releves, blocs, lotMio) {
  const mio = lotMio;
  const resume = {};
  for (const [nom, valeurs] of Object.entries(releves)) {
    const p50 = percentile(valeurs, 50);
    resume[nom] = {
      essais: valeurs.length,
      p50Ms: Number(p50.toFixed(2)),
      p95Ms: Number(percentile(valeurs, 95).toFixed(2)),
      microsecondesParBloc:
        nom === "appelUnique" ? null : Number(((p50 * 1000) / blocs).toFixed(2)),
      mioParSeconde: Number((mio / (p50 / 1000)).toFixed(1)),
    };
  }
  return resume;
}

/** Sert le banc à Node en réécrivant ses imports absolus en URL de fichier. */
async function mesurerSousNode() {
  const chemin = new URL("../reports/crypto/banc.mjs", import.meta.url);
  mkdirSync(dirname(fileURLToPath(chemin)), { recursive: true });
  const source = SOURCE_BANC.replaceAll('"/src/vm/', `"${new URL("src/vm/", RACINE).href}`);
  writeFileSync(chemin, source, "utf8");
  const { mesurer } = await import(chemin.href);
  const { blocs, releves } = await mesurer({ essais: ESSAIS, lotMio: LOT_MIO, secteur: SECTEUR });
  return { blocs, resume: resumer(releves, blocs, LOT_MIO) };
}

function servir(chemin) {
  if (chemin === "/banc.html") return { contentType: "text/html; charset=utf-8", body: PAGE };
  const javascript = "text/javascript; charset=utf-8";
  if (chemin === "/banc-worker.mjs") return { contentType: javascript, body: WORKER };
  if (chemin === "/banc.mjs") return { contentType: javascript, body: SOURCE_BANC };
  if (chemin.startsWith("/src/")) {
    return { contentType: javascript, body: readFileSync(new URL(`.${chemin}`, RACINE), "utf8") };
  }
  return { status: 404, body: "" };
}

/** Mesure dans un Worker de module RÉEL sous Chromium : le contexte du produit, pas une page. */
async function mesurerSousChromium() {
  const { chromium } = await import("@playwright/test");
  const navigateur = await chromium.launch();
  try {
    const page = await navigateur.newPage();
    await page.route("**/*", (route) =>
      route.fulfill(servir(new URL(route.request().url()).pathname)),
    );
    await page.goto("https://banc-de-mesure.invalide/banc.html");
    const rendu = await page.evaluate((parametres) => globalThis.__lancer(parametres), {
      essais: ESSAIS,
      lotMio: LOT_MIO,
      secteur: SECTEUR,
    });
    if (rendu.ok !== true) {
      throw new Error(`Banc navigateur en échec : ${rendu.message}`);
    }
    return {
      blocs: rendu.blocs,
      version: navigateur.version(),
      resume: resumer(rendu.releves, rendu.blocs, LOT_MIO),
    };
  } finally {
    await navigateur.close();
  }
}

async function main() {
  const [premier] = cpus();
  const rapport = {
    date: new Date().toISOString(),
    parametres: { essais: ESSAIS, lotMio: LOT_MIO, secteur: SECTEUR, algorithme: "aes-256-gcm" },
    machine: {
      plateforme: process.platform,
      node: process.version,
      coeursLogiques: cpus().length,
      processeur: premier?.model ?? null,
    },
    node: await mesurerSousNode(),
  };

  if (drapeau("navigateur")) {
    rapport.chromium = await mesurerSousChromium();
  }

  mkdirSync(dirname(fileURLToPath(RAPPORT)), { recursive: true });
  writeFileSync(RAPPORT, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(rapport, null, 2)}\n`);
}

await main();
