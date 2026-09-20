// LE BANC DU PREMIER CLIC (#251) : mesurer AVANT de corriger.
//
// La recette QA du 20/09/2026 a vu, sous Chrome installé FENÊTRÉ et machine virtuelle RÉELLE, un
// premier clic perdu dans la coquille après que l'application s'est affichée : aucun effet, aucun
// signe, second clic pris. Deux causes ont été ÉCARTÉES par le mainteneur le même jour — fenêtré
// contre sans fenêtre, et le focus tenu par un cadre d'une autre origine : cinq scénarios à
// application SIMULÉE passent. Ce qui reste à départager demande la VM réelle, et se mesure ici.
//
// ## Ce que ce banc fait, et ce qu'il ne fait pas
//
// Il NE joue PAS le geste. Un clic sur « Verrouiller mon coffre » verrouille et RECHARGE : trente
// essais coûteraient trente boots. Le banc pose donc, en CAPTURE sur le document, un écouteur qui
// relève tout — cible réelle, `elementFromPoint` aux coordonnées du clic, `activeElement`,
// `document.hasFocus()`, rectangle des boutons — puis SUSPEND le geste
// (`stopImmediatePropagation`). La question mesurée est « le clic atteint-il le bouton ? », et elle
// se tranche avant tout gestionnaire. Le DERNIER essai, lui, n'est pas suspendu : il verrouille pour
// de bon, et dit si le geste RÉEL part au premier clic.
//
// S'y ajoutent, horodatés sur la même horloge : les décalages de mise en page (`layout-shift`, avec
// les rectangles d'avant et d'après), les mutations du bouton et de ses ancêtres, et le compte des
// battements du Worker relevé à la visée puis au clic.
//
// ## Emploi
//
//     node tools/reproduire-le-premier-clic.mjs [--essais 16] [--sessions 2]
//
// Prérequis : `npm run vm:fetch`, `npm run image:build`, `npm run image:manifest`, et Chrome
// installé. Hors intégration continue — il ouvre une fenêtre, boote un guest Linux, et dure des
// minutes. Sortie : `reports/premier-clic/<horodatage>.json` et un résumé lisible.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { artefactsV86Absents } from "./v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "premier-clic");

/** Le couple d'origines du banc : jamais celui du README, qu'un mainteneur peut tenir ouvert. */
const HOTE_COQUILLE = "127.0.0.1";
const PORT_COQUILLE = 4279;
const HOTE_APPLICATION = "localhost";
const PORT_APPLICATION = 4280;
const ORIGINE_COQUILLE = `http://${HOTE_COQUILLE}:${PORT_COQUILLE}`;
const ORIGINE_APPLICATION = `http://${HOTE_APPLICATION}:${PORT_APPLICATION}`;

const PHRASE = "une phrase du banc du premier clic assez longue pour argon";
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

/** Les INSTANTS visés après l'affichage de l'application, en millisecondes. */
const INSTANTS = [
  500, 1_000, 1_500, 2_000, 3_000, 4_000, 5_000, 7_000, 10_000, 13_000, 16_000, 20_000, 25_000,
  30_000, 40_000, 50_000,
];

/** Les deux boutons que la QA a vus perdre un clic, sur l'écran « Votre application ». */
const BOUTONS = ["verrouiller-le-coffre", "parcours-continuer", "sauvegarder-le-coffre"];

/** Entre la VISÉE (le rectangle relevé) et l'appui : le temps qu'une main met à arriver. */
const VISEE_AVANT_APPUI_MS = 150;

const BUDGET_DEMARRAGE_MS = 900_000;
const BUDGET_OUVERTURE_MS = 180_000;

function options(argv) {
  const lire = (nom, defaut) => {
    const rang = argv.indexOf(nom);
    return rang === -1 ? defaut : Number(argv[rang + 1]);
  };
  return { essais: lire("--essais", INSTANTS.length), sessions: lire("--sessions", 2) };
}

/** Ce qui manque pour jouer le banc, ou `null`. */
function raisonDIndisponibilite() {
  const manifeste = join(RACINE, "tools", "build-reference-image", "manifest.json");
  if (!existsSync(manifeste)) return "manifeste de l'image absent : « npm run image:build »";
  const absents = JSON.parse(readFileSync(manifeste, "utf8"))
    .artifacts.map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(RACINE, "artifacts", "reference-image", nom)));
  if (absents.length > 0) return `artefacts de l'image absents : ${absents.join(", ")}`;
  if (!existsSync(join(RACINE, "artifacts", "application.json"))) {
    return "descripteur applicatif absent : « npm run image:manifest »";
  }
  const v86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  return v86.length > 0 ? `artefacts v86 absents : ${v86.join(", ")}` : null;
}

/** Lève un serveur du dépôt et attend qu'il réponde. */
async function lever(role, hote, port, origineApplicative = null) {
  const parametres = ["tools/serve.mjs", "--role", role, "--host", hote, "--port", String(port)];
  if (origineApplicative !== null) parametres.push("--app-origin", origineApplicative);
  const enfant = spawn(process.execPath, parametres, { cwd: RACINE, stdio: "ignore" });
  const limite = Date.now() + 30_000;
  const url = `http://${hote}:${port}/`;
  while (Date.now() < limite) {
    try {
      await fetch(url, { method: "HEAD" });
      return enfant;
    } catch {
      await new Promise((tenir) => setTimeout(tenir, 300));
    }
  }
  enfant.kill();
  throw new Error(`Le serveur ${role} n'a pas répondu sur ${url}.`);
}

const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });
const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });

/** Crée le coffre, éprouve la feuille, déclare la visite finie : mène à l'écran « Votre application ». */
async function jusquALAccueil(page) {
  await page.goto(`${ORIGINE_COQUILLE}/index.html`, { waitUntil: "commit" });
  await ecran(page, "Créer votre coffre").waitFor({ timeout: BUDGET_OUVERTURE_MS });
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: BUDGET_OUVERTURE_MS });
  const code = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
  if (!FORME_DU_CODE.test(code)) throw new Error(`Aucun code de récupération lu : « ${code} »`);
  await bouton(page, "J'ai recopié mon code").click();
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  await page
    .getByLabel("Code de récupération", { exact: true })
    .fill(code, { timeout: BUDGET_OUVERTURE_MS });
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await ecran(page, "Travailler dans l'application").waitFor({ timeout: BUDGET_OUVERTURE_MS });
  // La visite est finie : l'accueil suit la réouverture, comme chez la personne qui revient.
  await page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await racine.getFileHandle("parcours.json");
    const progression = JSON.parse(await (await fichier.getFile()).text());
    const flux = await fichier.createWritable();
    await flux.write(JSON.stringify({ ...progression, etapeAtteinte: 9, visiteTerminee: true }));
    await flux.close();
  });
}

/** RECHARGE la coquille et rouvre le coffre par la phrase : mène à l'écran « Votre application ». */
async function rouvrirParLaPhrase(page) {
  const recharge = page.waitForEvent("load");
  await page.goto(`${ORIGINE_COQUILLE}/index.html`, { waitUntil: "commit" });
  await recharge;
  await page
    .getByLabel("Votre phrase", { exact: true })
    .fill(PHRASE, { timeout: BUDGET_OUVERTURE_MS });
  await bouton(page, "Ouvrir mon coffre").click();
  await ecran(page, "Votre application").waitFor({ timeout: BUDGET_OUVERTURE_MS });
}

/** DÉMARRE l'application et attend que la page de Rails soit RENDUE dans le cadre imbriqué. */
async function afficherLApplication(page) {
  await bouton(page, "Démarrer l'application").click();
  const ligne = page.locator("#cycle-etat");
  const limite = Date.now() + BUDGET_DEMARRAGE_MS;
  let dite = "";
  while (Date.now() < limite) {
    dite = (await ligne.textContent()) ?? "";
    if (dite.startsWith("cycle:application-demarree")) break;
    if (dite.includes("refuse") || dite.startsWith("cycle:sans-application")) break;
    await page.waitForTimeout(1_000);
  }
  if (!dite.startsWith("cycle:application-demarree")) {
    throw new Error(`L'application n'a pas démarré : ${dite || "aucune ligne"}`);
  }
  await page
    .frameLocator("#document-applicatif")
    .frameLocator("#application-servie")
    .locator("h1")
    .waitFor({ timeout: 300_000 });
  return Date.now();
}

/** Le relevé posé DANS la page : tout ce qu'un clic traverse, et ce qui bouge autour. */
function instrumenter(boutons) {
  const banc = { evenements: [], decalages: [], mutations: [], essai: null, suspendre: true };
  globalThis.__banc = banc;
  const nommer = (element) => {
    if (element === null || element === undefined) return null;
    return (element.id ?? "") === "" ? element.tagName : element.id;
  };
  const rectangle = (element) => {
    if (element === null) return null;
    const boite = element.getBoundingClientRect();
    return { x: boite.x, y: boite.y, l: boite.width, h: boite.height };
  };
  banc.rectangleDe = (id) => rectangle(document.getElementById(id));
  new PerformanceObserver((liste) => {
    for (const entree of liste.getEntries()) {
      banc.decalages.push({
        essai: banc.essai,
        a: entree.startTime,
        valeur: entree.value,
        gesteRecent: entree.hadRecentInput,
        sources: [...(entree.sources ?? [])].map((source) => ({
          noeud: nommer(source.node),
          avant: source.previousRect && { x: source.previousRect.x, y: source.previousRect.y },
          apres: source.currentRect && { x: source.currentRect.x, y: source.currentRect.y },
        })),
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
  for (const type of ["pointerdown", "pointerup", "click"]) {
    document.addEventListener(
      type,
      (evenement) => {
        const cible = evenement.target instanceof Element ? evenement.target : null;
        const sous = document.elementFromPoint(evenement.clientX, evenement.clientY);
        const dansUnBouton = cible === null ? null : cible.closest("button");
        banc.evenements.push({
          essai: banc.essai,
          type,
          a: performance.now(),
          x: evenement.clientX,
          y: evenement.clientY,
          cible: nommer(cible),
          bouton: nommer(dansUnBouton),
          sousLePointeur: nommer(sous),
          boutonSousLePointeur: nommer(sous === null ? null : sous.closest("button")),
          actif: nommer(document.activeElement),
          focusDuDocument: document.hasFocus(),
          rectangles: Object.fromEntries(boutons.map((id) => [id, banc.rectangleDe(id)])),
        });
        // Le geste est SUSPENDU : le banc mesure la livraison du clic, il ne verrouille rien.
        if (banc.suspendre && dansUnBouton !== null) {
          evenement.preventDefault();
          evenement.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }
  // Ce qui touche AU bouton ou à l'un de ses ancêtres : ce sont eux qui peuvent le déplacer.
  for (const id of boutons) {
    for (let noeud = document.getElementById(id); noeud !== null; noeud = noeud.parentElement) {
      const observe = noeud;
      new MutationObserver((changements) => {
        banc.mutations.push({
          essai: banc.essai,
          a: performance.now(),
          bouton: id,
          noeud: nommer(observe),
          nombre: changements.length,
          natures: [...new Set(changements.map((changement) => changement.type))],
        });
      }).observe(observe, { attributes: true, childList: true, characterData: true });
    }
  }
}

/** Le compte des battements du Worker, tel que la coquille le publie. */
function battements() {
  try {
    const rapport = JSON.parse(document.getElementById("coquille-rapport").textContent);
    return rapport.mesures?.battements?.recus ?? null;
  } catch {
    return null;
  }
}

/** Nomme l'essai en cours dans la page, pour que chaque relevé lui soit rattaché. */
async function marquer(page, nom) {
  await page.evaluate((valeur) => {
    globalThis.__banc.essai = valeur;
  }, nom);
}

/** UN essai : viser, attendre, appuyer, relâcher — et dire ce que le clic a traversé. */
async function essayer(page, { nom, id, gesteDansLeCadre, depuisLAffichageMs }) {
  await marquer(page, nom);
  if (gesteDansLeCadre) {
    await page
      .frameLocator("#document-applicatif")
      .frameLocator("#application-servie")
      .locator("body")
      .click({ timeout: 20_000 })
      .catch(() => {});
    await marquer(page, nom);
  }
  const cible = page.locator(`#${id}`);
  // Une main ne vise pas un bouton qu'elle ne voit pas : la page l'amène d'abord SOUS LES YEUX.
  // Sans cela, le banc appuie à des coordonnées hors fenêtre et perd le clic pour sa propre raison
  // (mesure du 20/09/2026, premier tour : seize « clics perdus » qui tombaient tous sur `HTML`).
  await cible.scrollIntoViewIfNeeded().catch(() => {});
  const visee = await cible.boundingBox();
  if (visee === null) return { nom, id, gesteDansLeCadre, depuisLAffichageMs, absent: true };
  const point = { x: visee.x + visee.width / 2, y: visee.y + visee.height / 2 };
  const avant = await page.evaluate(battements);
  const defilementALaVisee = await page.evaluate(() => globalThis.scrollY);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(VISEE_AVANT_APPUI_MS);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
  const releve = await page.evaluate(
    ({ valeur, bouton: identifiant }) => {
      const banc = globalThis.__banc;
      const pour = (liste) => liste.filter((entree) => entree.essai === valeur);
      return {
        evenements: pour(banc.evenements),
        decalages: pour(banc.decalages),
        mutations: pour(banc.mutations),
        rectangleAuClic: banc.rectangleDe(identifiant),
        defilement: globalThis.scrollY,
      };
    },
    { valeur: nom, bouton: id },
  );
  const apres = await page.evaluate(battements);
  const recus = releve.evenements.filter((evenement) => evenement.bouton === id);
  const clic = recus.find((evenement) => evenement.type === "click") ?? null;
  return {
    nom,
    id,
    gesteDansLeCadre,
    depuisLAffichageMs,
    visee: { x: visee.x, y: visee.y, l: visee.width, h: visee.height },
    rectangleAuClic: releve.rectangleAuClic,
    defilement: { visee: defilementALaVisee, clic: releve.defilement },
    point,
    clicPris: clic !== null,
    types: releve.evenements.map((evenement) => `${evenement.type}:${evenement.bouton ?? "-"}`),
    battements: { avant, apres },
    evenements: releve.evenements,
    decalages: releve.decalages,
    mutations: releve.mutations.length,
    decalageCumule: releve.decalages.reduce((somme, entree) => somme + entree.valeur, 0),
  };
}

/** Une SESSION : rouvrir, démarrer, instrumenter, jouer l'échelle des instants. */
async function jouerUneSession(page, { rang, gesteDansLeCadre, essais }) {
  await rouvrirParLaPhrase(page);
  const affichee = await afficherLApplication(page);
  await page.evaluate(instrumenter, BOUTONS);
  // Un bouton que l'écran n'offre pas ne se vise pas : l'écran décide, le banc le constate.
  const offerts = [];
  for (const id of BOUTONS) {
    if (await page.locator(`#${id}`).isVisible()) offerts.push(id);
  }
  if (offerts.length === 0) throw new Error("Aucun bouton de la coquille n'est offert à l'écran.");
  process.stdout.write(`  boutons offerts : ${offerts.join(", ")}\n`);
  const resultats = [];
  for (const [ordre, instant] of INSTANTS.slice(0, essais).entries()) {
    const attendre = instant - (Date.now() - affichee);
    if (attendre > 0) await page.waitForTimeout(attendre);
    const id = offerts[ordre % offerts.length];
    const essai = await essayer(page, {
      nom: `${id}|s${rang}|${instant}`,
      id,
      gesteDansLeCadre,
      depuisLAffichageMs: Date.now() - affichee,
    });
    resultats.push({ ...essai, session: rang });
    const decalage = (essai.decalageCumule ?? 0).toFixed(5);
    process.stdout.write(
      `  essai ${resultats.length} · ${id} · ${essai.depuisLAffichageMs} ms après l'affichage · ` +
        `geste dans le cadre : ${gesteDansLeCadre ? "oui" : "non"} · ` +
        `clic ${essai.clicPris ? "PRIS" : "PERDU"} · décalage ${decalage}\n`,
    );
  }
  return resultats;
}

/** LE TÉMOIN : un vrai clic, non suspendu, sur « Verrouiller mon coffre ». Il doit verrouiller. */
async function temoinDuGesteReel(page) {
  await page.evaluate(() => {
    globalThis.__banc.suspendre = false;
    globalThis.__banc.essai = "temoin";
  });
  const depart = Date.now();
  const recharge = page.waitForEvent("load", { timeout: 120_000 });
  const verrouiller = page.locator("#verrouiller-le-coffre");
  await verrouiller.scrollIntoViewIfNeeded().catch(() => {});
  const boite = await verrouiller.boundingBox();
  await page.mouse.move(boite.x + boite.width / 2, boite.y + boite.height / 2);
  await page.waitForTimeout(VISEE_AVANT_APPUI_MS);
  await page.mouse.down();
  await page.mouse.up();
  try {
    await recharge;
    await ecran(page, "Rouvrir votre coffre").waitFor({ timeout: 120_000 });
    return { verrouille: true, ms: Date.now() - depart };
  } catch (erreur) {
    return { verrouille: false, ms: Date.now() - depart, motif: erreur.message.split("\n")[0] };
  }
}

async function principal() {
  const raison = raisonDIndisponibilite();
  if (raison !== null) {
    process.stderr.write(`Banc indisponible : ${raison}\n`);
    process.exitCode = 2;
    return;
  }
  const { essais, sessions } = options(process.argv.slice(2));
  const serveurs = [
    await lever("shell", HOTE_COQUILLE, PORT_COQUILLE, ORIGINE_APPLICATION),
    await lever("app", HOTE_APPLICATION, PORT_APPLICATION),
  ];
  const profil = join(RACINE, "artifacts", `profil-banc-251-${Date.now()}`);
  mkdirSync(profil, { recursive: true });
  const contexte = await chromium.launchPersistentContext(profil, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--window-size=1280,900"],
  });
  const resultats = [];
  let temoin;
  const page = contexte.pages()[0] ?? (await contexte.newPage());
  try {
    await jusquALAccueil(page);
    for (let rang = 1; rang <= sessions; rang += 1) {
      const gesteDansLeCadre = rang % 2 === 0;
      process.stdout.write(`\n[session ${rang}] geste dans le cadre : ${gesteDansLeCadre}\n`);
      resultats.push(...(await jouerUneSession(page, { rang, gesteDansLeCadre, essais })));
    }
    temoin = await temoinDuGesteReel(page);
  } finally {
    await contexte.close().catch(() => {});
    for (const serveur of serveurs) serveur.kill();
  }
  const perdus = resultats.filter((essai) => essai.clicPris !== true);
  const rapport = {
    mesureLe: new Date().toISOString(),
    navigateur: "Chrome installé, fenêtré (channel chrome, headless false)",
    machineVirtuelle: "réelle (image de référence, v86 dans le Worker)",
    essais: resultats.length,
    perdus: perdus.length,
    temoinDuGesteReel: temoin,
    decalageMaximal: Math.max(0, ...resultats.map((essai) => essai.decalageCumule ?? 0)),
    table: resultats.map((essai) => ({
      session: essai.session,
      bouton: essai.id,
      depuisLAffichageMs: essai.depuisLAffichageMs,
      gesteDansLeCadre: essai.gesteDansLeCadre,
      clicPris: essai.clicPris === true,
      types: essai.types,
      decalageCumule: essai.decalageCumule,
      mutations: essai.mutations,
      battements: essai.battements,
      defilement: essai.defilement,
      aBouge:
        essai.rectangleAuClic !== null &&
        essai.rectangleAuClic !== undefined &&
        (Math.abs(essai.rectangleAuClic.x - essai.visee.x) > 0.5 ||
          Math.abs(essai.rectangleAuClic.y - essai.visee.y) > 0.5),
      focusDuDocument: essai.evenements?.[0]?.focusDuDocument ?? null,
      actif: essai.evenements?.[0]?.actif ?? null,
    })),
    detail: resultats,
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const chemin = join(DOSSIER_RAPPORTS, `${rapport.mesureLe.replaceAll(":", "-")}.json`);
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");
  const verdict =
    temoin?.verrouille === true
      ? `verrouillé en ${temoin.ms} ms`
      : "NON verrouillé au premier clic";
  process.stdout.write(
    `\n${resultats.length} essais, ${perdus.length} clic(s) perdu(s), ` +
      `décalage cumulé maximal ${rapport.decalageMaximal.toFixed(5)}, ` +
      `témoin du geste réel : ${verdict}\nRelevé : ${chemin}\n`,
  );
}

await principal();
