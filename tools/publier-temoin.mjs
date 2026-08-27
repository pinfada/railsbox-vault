#!/usr/bin/env node
// TÉMOIN D'EN-TÊTES de la chaîne de publication (#45).
//
//   node tools/publier-temoin.mjs                    Chromium
//   VAULT_MOTEURS=chromium,firefox,webkit node tools/publier-temoin.mjs
//
// Il répond à trois questions, sur les ARBRES PUBLIÉS et non sur le dépôt :
//
//  1. l'hébergement sert-il exactement les en-têtes que `tools/serve-headers.mjs` définit, plus le
//     COOP ajouté par l'ADR 0017 ? Comparaison littérale, en-tête par en-tête, par origine ;
//  2. ce COOP a-t-il l'effet qu'on lui prête ? L'ADR 0010 a nommé la preuve attendue : « un témoin
//     `window.opener === null`, relevé depuis une fenêtre ouverte par un document d'une autre
//     origine ». C'est ce qui est relevé ici, avec son TÉMOIN NÉGATIF — la même manipulation sur un
//     serveur d'où COOP a été retiré, où `window.opener` doit SURVIVRE. Sans lui, un `null` ne
//     prouverait rien : il pourrait venir d'une sonde cassée ;
//  3. l'arbre publié fonctionne-t-il encore ? Une coquille aux en-têtes parfaits qui ne démarre pas
//     n'est pas une publication. Le document est chargé et son Worker doit s'annoncer.
//
// Ce témoin ne rejoue PAS la frontière de CSP : `tests/browser/csp-frontiere.spec.mjs` la mesure
// déjà sur les trois moteurs, à chaque `npm run check`, et la dupliquer ici ferait deux vérités.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, firefox, webkit } from "@playwright/test";

import { enTetesDePublication } from "./publier-en-tetes.mjs";
import { demarrer } from "./publier-servir.mjs";
import { REPOSITORY_ROOT } from "./v86-paths.mjs";

const MOTEURS = { chromium, firefox, webkit };

/** Ports du témoin, distincts de ceux du serveur de test (4173/4174) et des bancs. */
export const PORTS = Object.freeze({ coquille: 4193, application: 4194, coquilleSansCoop: 4195 });
export const HOTE_COQUILLE = "127.0.0.1";
export const HOTE_APPLICATION = "localhost";

export const ORIGINE_COQUILLE = `http://${HOTE_COQUILLE}:${PORTS.coquille}`;
export const ORIGINE_APPLICATION = `http://${HOTE_APPLICATION}:${PORTS.application}`;
export const ORIGINE_COQUILLE_SANS_COOP = `http://${HOTE_COQUILLE}:${PORTS.coquilleSansCoop}`;

const RACINE_ARBRES = join(REPOSITORY_ROOT, "artifacts", "publication");
const RAPPORT = join(REPOSITORY_ROOT, "reports", "publication", "temoin-en-tetes.json");

/**
 * Confronte les en-têtes reçus à ceux que la publication déclare.
 *
 * La comparaison est littérale et exhaustive dans un sens : chaque en-tête attendu doit être là,
 * avec sa valeur exacte. Elle ne l'est pas dans l'autre — un hébergeur réel ajoute `Date`, `ETag`,
 * `Server`, et exiger l'égalité des ensembles ferait échouer le témoin sur du bruit.
 */
export function confronter(attendus, recus) {
  const ecarts = [];
  for (const [nom, valeur] of Object.entries(attendus)) {
    const recu = recus[nom.toLowerCase()];
    if (recu !== valeur) ecarts.push({ enTete: nom, attendu: valeur, recu: recu ?? null });
  }
  return ecarts;
}

/** Un en-tête qui ne doit PAS être servi. L'origine applicative n'en reçoit aucune CSP (ADR 0002). */
export function confronterAbsences(absents, recus) {
  return absents
    .filter((nom) => recus[nom.toLowerCase()] !== undefined)
    .map((nom) => ({ enTete: nom, attendu: null, recu: recus[nom.toLowerCase()] }));
}

async function relevePage(page, url) {
  const reponse = await page.goto(url, { waitUntil: "load" });
  return reponse.headers();
}

/**
 * Ouvre la coquille depuis un document de l'AUTRE origine et relève `window.opener`.
 *
 * L'ouverture est faite par `window.open` depuis le document applicatif : c'est exactement la
 * relation que COOP gouverne, et que `frame-ancestors` ne couvre pas (ADR 0010).
 */
async function releverOpener(contexte, urlCoquille) {
  const ouvreur = await contexte.newPage();
  await ouvreur.goto(`${ORIGINE_APPLICATION}/index.html`, { waitUntil: "load" });
  const [popup] = await Promise.all([
    contexte.waitForEvent("page"),
    ouvreur.evaluate((url) => globalThis.open(url, "_blank"), urlCoquille),
  ]);
  await popup.waitForLoadState("load");
  const openerEstNul = await popup.evaluate(() => globalThis.opener === null);
  await popup.close();
  await ouvreur.close();
  return openerEstNul;
}

async function releverDemarrage(page) {
  await page.waitForFunction(
    () => globalThis.document.documentElement.dataset.vaultReady === "true",
    undefined,
    { timeout: 15000 },
  );
  return page.textContent("#worker-status");
}

async function mesurerMoteur(nom) {
  const navigateur = await MOTEURS[nom].launch();
  const contexte = await navigateur.newContext();
  const page = await contexte.newPage();

  const enTetesCoquille = await relevePage(page, `${ORIGINE_COQUILLE}/index.html`);
  const demarrage = await releverDemarrage(page);
  const enTetesApplication = await relevePage(page, `${ORIGINE_APPLICATION}/index.html`);
  await page.close();

  const mesure = {
    moteur: nom,
    coquille: {
      ecarts: confronter(
        enTetesDePublication("coquille", { origineApplication: ORIGINE_APPLICATION }),
        enTetesCoquille,
      ),
      recus: enTetesCoquille,
    },
    application: {
      ecarts: [
        ...confronter(
          enTetesDePublication("application", { origineApplication: ORIGINE_APPLICATION }),
          enTetesApplication,
        ),
        ...confronterAbsences(
          ["Content-Security-Policy", "Cross-Origin-Opener-Policy"],
          enTetesApplication,
        ),
      ],
      recus: enTetesApplication,
    },
    demarrage,
    openerAvecCoop: await releverOpener(contexte, `${ORIGINE_COQUILLE}/index.html`),
    openerSansCoop: await releverOpener(contexte, `${ORIGINE_COQUILLE_SANS_COOP}/index.html`),
  };

  await navigateur.close();
  return mesure;
}

/** Un moteur passe si les en-têtes sont conformes, que la coquille démarre, et que COOP agit. */
export function verdict(mesure) {
  const motifs = [];
  if (mesure.coquille.ecarts.length > 0) motifs.push("en-têtes de la coquille");
  if (mesure.application.ecarts.length > 0) motifs.push("en-têtes de l'origine applicative");
  if (mesure.demarrage !== "worker:ready") motifs.push(`démarrage : ${mesure.demarrage}`);
  if (mesure.openerAvecCoop !== true) motifs.push("COOP servi mais `window.opener` a survécu");
  if (mesure.openerSansCoop !== false) {
    motifs.push("témoin négatif cassé : `window.opener` est nul SANS COOP");
  }
  return { moteur: mesure.moteur, conforme: motifs.length === 0, motifs };
}

function decrire(mesure) {
  const { conforme, motifs } = verdict(mesure);
  const lignes = [
    `[${mesure.moteur}] ${conforme ? "CONFORME" : "ÉCART"}`,
    `  démarrage de la coquille        ${mesure.demarrage}`,
    `  window.opener avec COOP         ${mesure.openerAvecCoop ? "null (attendu)" : "SURVIT"}`,
    `  window.opener sans COOP         ${mesure.openerSansCoop ? "null (TÉMOIN CASSÉ)" : "survit (attendu)"}`,
  ];
  for (const ecart of [...mesure.coquille.ecarts, ...mesure.application.ecarts]) {
    lignes.push(`  ÉCART ${ecart.enTete}`);
    lignes.push(`        attendu ${ecart.attendu ?? "(absent)"}`);
    lignes.push(`        reçu    ${ecart.recu ?? "(absent)"}`);
  }
  for (const motif of motifs) lignes.push(`  MOTIF ${motif}`);
  return lignes.join("\n");
}

async function principal() {
  const moteurs = (process.env.VAULT_MOTEURS ?? "chromium")
    .split(",")
    .map((nom) => nom.trim())
    .filter(Boolean);
  for (const moteur of moteurs) {
    if (!(moteur in MOTEURS)) {
      throw new Error(
        `Moteur inconnu : ${moteur}. Valeurs admises : ${Object.keys(MOTEURS).join(", ")}.`,
      );
    }
  }

  const serveurs = await Promise.all([
    demarrer({
      arbre: join(RACINE_ARBRES, "coquille"),
      host: HOTE_COQUILLE,
      port: PORTS.coquille,
      retires: [],
    }),
    demarrer({
      arbre: join(RACINE_ARBRES, "application"),
      host: HOTE_APPLICATION,
      port: PORTS.application,
      retires: [],
    }),
    // Témoin négatif : le MÊME arbre, servi sans COOP. La seule variable est l'en-tête.
    demarrer({
      arbre: join(RACINE_ARBRES, "coquille"),
      host: HOTE_COQUILLE,
      port: PORTS.coquilleSansCoop,
      retires: ["Cross-Origin-Opener-Policy"],
    }),
  ]);

  const mesures = [];
  try {
    for (const moteur of moteurs) mesures.push(await mesurerMoteur(moteur));
  } finally {
    await Promise.all(serveurs.map(({ arreter }) => arreter()));
  }

  const verdicts = mesures.map(verdict);
  for (const mesure of mesures) process.stdout.write(`${decrire(mesure)}\n`);
  await mkdir(join(RAPPORT, ".."), { recursive: true });
  await writeFile(RAPPORT, `${JSON.stringify({ mesures, verdicts }, null, 2)}\n`, "utf8");
  process.stdout.write(`\nRapport : ${RAPPORT}\n`);
  return verdicts.every(({ conforme }) => conforme) ? 0 : 1;
}

if (process.argv[1]?.endsWith("publier-temoin.mjs")) {
  process.exitCode = await principal();
}
