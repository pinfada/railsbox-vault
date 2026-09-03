#!/usr/bin/env node
// Banc de mesure de l'empreinte mémoire RÉELLE du processus navigateur pendant la reprise (#67).
//
//     node tools/mesurer-memoire.mjs                    # préparation, boot à chaud, 3 reprises
//     node tools/mesurer-memoire.mjs --essais=2         # moins de reprises
//     node tools/mesurer-memoire.mjs --intervalle=1000  # échantillonnage plus fin
//     node tools/mesurer-memoire.mjs --headed           # pour regarder le guest booter
//
// ## Pourquoi cet outil existe
//
// Le relevé de bout en bout publie `memoireTasJs` : `performance.memory` de la PAGE. Or v86 et ses
// 512 Mio de RAM invitée vivent dans un Worker dédié (ADR 0002), et cette RAM est la mémoire
// linéaire d'un module WebAssembly — que le tas JS de la page ne voit pas, et que le tas JS du
// Worker lui-même ne compte pas davantage. Le budget « pic navigateur ≤ 1,5 Gio » de
// `docs/quality-attributes.md` n'était donc adossé à aucune mesure de ce qu'il borne.
//
// Ce banc mesure ce que le SYSTÈME dit du navigateur : la mémoire résidente de tous ses processus,
// échantillonnée pendant que le guest boote. C'est la grandeur du budget.
//
// ## Comment, et sur quels moteurs
//
// Deux instruments existent pour cette question, et un seul est utilisable ici.
//
//  - `performance.measureUserAgentSpecificMemory()` rendrait la ventilation par contexte, Worker
//    compris, sans quitter la page. Elle exige `crossOriginIsolated`, donc COOP + COEP. L'ADR 0010
//    a décidé que la distribution de Vault N'IMPOSE PAS cette isolation : la coquille du produit
//    n'est pas isolée, et l'activer pour mesurer donnerait le chiffre d'une configuration qui n'est
//    pas celle du produit. Ce banc ne l'active donc pas, et ne l'appelle pas.
//  - Les processus de Chromium sont énumérables par CDP (`SystemInfo.getProcessInfo`), et le
//    système sait ce que chacun occupe. C'est la voie retenue. Elle est donc **mesurable sous
//    Chromium seulement** : Firefox et WebKit n'exposent pas CDP, et Playwright ne rend pas leur
//    arbre de processus. `docs/quality-attributes.md` publie cette limite avec le chiffre.
//
// Le profil du navigateur est PERSISTANT, pour la raison de `tests/e2e/contexte-persistant.mjs` :
// dans un profil éphémère, Chromium adosse OPFS à un système de fichiers EN MÉMOIRE — un volume de
// 512 Mio y compterait dans l'empreinte mesurée, et la mesure ne dirait plus rien du produit.
//
// ## Ce que ce banc ne prouve pas
//
// Il ne prouve aucune propriété de reprise : c'est `tests/e2e/reprise-mutation-boot-froid.spec.mjs`
// qui le fait, réseau coupé et témoin négatif compris. Ici la reprise est un CHARGEMENT, choisi
// parce qu'il est celui du budget. Le banc n'est pas rattaché à `npm run check` : il dure des
// minutes, exige Docker en amont pour l'image de référence, et une mesure n'est pas une épreuve.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { relever } from "./memoire-processus.mjs";

const RACINE = resolve(import.meta.dirname, "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_V86 = join(RACINE, "vendor", "v86", "artefacts");
const DOSSIER_RAPPORT = join(RACINE, "reports", "memoire");
const DOSSIER_PROFIL = join(RACINE, "test-results", "memoire", "profil-navigateur");

/** Volume nommé pour ce banc seul : il ne doit heurter aucune suite. */
const VOLUME = "vault-app-memoire-banc";

const ARGS = process.argv.slice(2);
const drapeau = (nom) => ARGS.includes(`--${nom}`);
const nombre = (nom, defaut) => {
  const trouve = ARGS.find((arg) => arg.startsWith(`--${nom}=`));
  return trouve === undefined ? defaut : Number(trouve.slice(nom.length + 3));
};

const ESSAIS = nombre("essais", 3);
const INTERVALLE_MS = nombre("intervalle", 1000);
const PORT = nombre("port", 4188);
const HOTE = "127.0.0.1";
const ORIGINE = `http://${HOTE}:${PORT}`;
const BUDGET_BOOT_MS = 300_000;

const MIO = 1024 * 1024;
const enMio = (octets) => (octets === null ? null : Number((octets / MIO).toFixed(1)));

/** Décrit ce qui manque pour booter, ou `null` si tout est là. Même contrat que le scénario E2E. */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((a) => a.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image de référence absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  const absentsV86 = ["libv86.mjs", "v86.wasm"].filter(
    (nom) => !existsSync(join(DOSSIER_V86, nom)),
  );
  if (absentsV86.length > 0) {
    return `artefacts v86 absents (${absentsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

/** Lance la coquille du dépôt sur son propre port et attend qu'elle réponde. */
async function demarrerServeur() {
  const serveur = spawn(
    process.execPath,
    ["tools/serve.mjs", "--role", "shell", "--host", HOTE, "--port", String(PORT)],
    { cwd: RACINE, stdio: ["ignore", "ignore", "inherit"] },
  );
  const echeance = Date.now() + 30_000;
  for (;;) {
    try {
      const reponse = await fetch(`${ORIGINE}/vm/reference.html`, { cache: "no-store" });
      if (reponse.ok) return serveur;
    } catch {
      /* le serveur n'écoute pas encore */
    }
    if (Date.now() > echeance) {
      serveur.kill();
      throw new Error(`La coquille n'a pas répondu sur ${ORIGINE} en 30 s.`);
    }
    await new Promise((suite) => setTimeout(suite, 200));
  }
}

/**
 * Échantillonneur : relève en continu l'empreinte de TOUS les processus du navigateur, et range
 * chaque relevé sous la phase en cours.
 *
 * L'arbre de processus est redemandé à chaque relevé, jamais mémorisé : Chromium ouvre et ferme des
 * processus de rendu au fil des pages, et une liste figée manquerait précisément celui qui porte le
 * Worker de la reprise en cours.
 */
class Echantillonneur {
  #nav;
  #arrete = false;
  #phase = "base";
  #series = new Map();

  constructor(nav) {
    this.#nav = nav;
  }

  phase(nom) {
    this.#phase = nom;
    if (!this.#series.has(nom)) this.#series.set(nom, []);
  }

  async #unReleve() {
    const { processInfo } = await this.#nav.send("SystemInfo.getProcessInfo");
    const parPid = relever(processInfo.map((p) => p.id));
    let resident = 0;
    let prive = 0;
    let priveConnu = true;
    let plusGros = { type: null, residentOctets: 0 };
    for (const { id, type } of processInfo) {
      const releve = parPid.get(id);
      if (releve === undefined) continue;
      resident += releve.residentOctets;
      if (releve.priveOctets === null) priveConnu = false;
      else prive += releve.priveOctets;
      if (releve.residentOctets > plusGros.residentOctets) {
        plusGros = { type, residentOctets: releve.residentOctets };
      }
    }
    return {
      instant: Date.now(),
      processus: processInfo.length,
      residentOctets: resident,
      priveOctets: priveConnu ? prive : null,
      plusGrosProcessus: plusGros,
    };
  }

  async boucler() {
    while (!this.#arrete) {
      try {
        const releve = await this.#unReleve();
        this.#series.get(this.#phase)?.push(releve);
      } catch {
        // Une session CDP fermée sous la sonde n'est pas une panne de la mesure : on s'arrête.
        if (this.#arrete) break;
      }
      await new Promise((suite) => setTimeout(suite, INTERVALLE_MS));
    }
  }

  arreter() {
    this.#arrete = true;
  }

  /** Agrégats par phase : pic, moyenne, nombre de relevés. Le pic est la grandeur du budget. */
  agregats() {
    const resume = {};
    for (const [phase, releves] of this.#series) {
      if (releves.length === 0) continue;
      const residents = releves.map((r) => r.residentOctets);
      const prives = releves.map((r) => r.priveOctets).filter((v) => v !== null);
      const pic = Math.max(...residents);
      resume[phase] = {
        releves: releves.length,
        residentPicOctets: pic,
        residentMoyenOctets: Math.round(residents.reduce((a, b) => a + b, 0) / residents.length),
        privePicOctets: prives.length === releves.length ? Math.max(...prives) : null,
        plusGrosProcessusAuPic:
          releves.find((r) => r.residentOctets === pic)?.plusGrosProcessus ?? null,
        processusMax: Math.max(...releves.map((r) => r.processus)),
      };
    }
    return resume;
  }
}

/** Ouvre une page NEUVE de la coquille et attend que le banc de reprise y soit prêt. */
async function nouvellePage(contexte) {
  const page = await contexte.newPage();
  await page.goto(`${ORIGINE}/vm/reference.html`, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, { timeout: 20_000 });
  return page;
}

/**
 * Tas JS de la page ET de chaque Worker, relevés au même instant.
 *
 * C'est la CONTRE-MESURE du banc : elle montre, sur la même exécution, ce que `memoireTasJs`
 * publiait et de combien il manquait la cible. `performance.memory` n'existe que sous Chromium ; les
 * autres moteurs rendent `null`, et non zéro.
 */
async function tasJs(page) {
  const lire = () =>
    globalThis.performance.memory
      ? {
          usedJSHeapSize: globalThis.performance.memory.usedJSHeapSize,
          totalJSHeapSize: globalThis.performance.memory.totalJSHeapSize,
        }
      : null;
  const workers = await Promise.all(page.workers().map((w) => w.evaluate(lire).catch(() => null)));
  return { page: await page.evaluate(lire).catch(() => null), workers };
}

/** Une reprise à froid complète, mesurée : page neuve, acquisition du runtime, boot à froid. */
async function uneReprise(contexte, echantillonneur, configBoot, rang) {
  echantillonneur.phase(`reprise-${rang}`);
  const page = await nouvellePage(contexte);
  const courir = (p) => page.evaluate((x) => globalThis.bancReprise.executer(x), p);
  const arm = await courir({ ...configBoot, phase: "resume-arm" });
  if (arm.ready !== true) throw new Error(`reprise ${rang} : runtime non acquis`);
  const resume = await courir({ phase: "resume-fire" });
  const heaps = await tasJs(page);
  await page.close();
  return {
    rang,
    conforming: resume.conforming,
    usedSnapshot: resume.usedSnapshot,
    healthMs: resume.healthMilliseconds,
    tasJs: heaps,
  };
}

/** Étendue relative d'une série, en pourcentage du plus petit : la dispersion publiée. */
function dispersion(valeurs) {
  if (valeurs.length < 2) return null;
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);
  return { minOctets: min, maxOctets: max, etendueRelative: Number((max / min - 1).toFixed(4)) };
}

/** Construit la configuration de boot depuis le manifeste de l'image et le contrat applicatif. */
function configurationDeBoot() {
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const manifest = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  return {
    manifeste,
    appDiskBytes: disqueApp.byteSize,
    appDiskUrl: `/artifacts/reference-image/${manifeste.boot.hdb}`,
    manifest,
    configBoot: {
      volume: VOLUME,
      cmdline: manifeste.boot.cmdline,
      memoryBytes: manifeste.boot.memoryMiB * 1024 * 1024,
      runtime: {
        lib: "/vendor/v86/artefacts/libv86.mjs",
        wasm: "/vendor/v86/artefacts/v86.wasm",
        bios: `/artifacts/reference-image/${manifeste.boot.bios}`,
        vgaBios: `/artifacts/reference-image/${manifeste.boot.vgaBios}`,
        kernel: `/artifacts/reference-image/${manifeste.boot.kernel}`,
        initrd: `/artifacts/reference-image/${manifeste.boot.initrd}`,
        rootfs: `/artifacts/reference-image/${manifeste.boot.hda}`,
      },
      manifest,
      expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
      bootTimeoutMs: BUDGET_BOOT_MS,
    },
  };
}

/** Enchaîne préparation, boot à chaud et reprises, l'échantillonneur tournant en parallèle. */
async function mesurer(contexte, echantillonneur, plan) {
  const { appDiskBytes, appDiskUrl, manifest, configBoot } = plan;

  echantillonneur.phase("preparation");
  let page = await nouvellePage(contexte);
  await page.evaluate((p) => globalThis.bancReprise.executer(p), {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes,
    appDiskUrl,
    manifest,
  });
  await page.close();

  echantillonneur.phase("boot-a-chaud");
  page = await nouvellePage(contexte);
  const live = await page.evaluate((p) => globalThis.bancReprise.executer(p), {
    ...configBoot,
    phase: "live",
  });
  const tasJsLive = await tasJs(page);
  await page.close();

  const reprises = [];
  for (let rang = 1; rang <= ESSAIS; rang += 1) {
    reprises.push(await uneReprise(contexte, echantillonneur, configBoot, rang));
  }

  echantillonneur.phase("nettoyage");
  page = await nouvellePage(contexte);
  await page
    .evaluate((n) => globalThis.bancReprise.executer({ phase: "cleanup", volume: n }), VOLUME)
    .catch(() => {});
  await page.close();

  return {
    live: { conforming: live.conforming, healthMs: live.healthMilliseconds },
    tasJsLive,
    reprises,
  };
}

/** Tableau lisible en sortie de banc : une ligne par phase, en mébioctets. */
function afficher(agregats, mesures) {
  process.stdout.write("\nEmpreinte du navigateur, par phase (Mio) :\n");
  process.stdout.write("  phase             relevés    pic     moyen    privé au pic\n");
  for (const [phase, a] of Object.entries(agregats)) {
    process.stdout.write(
      `  ${phase.padEnd(18)}${String(a.releves).padStart(5)}` +
        `${String(enMio(a.residentPicOctets)).padStart(9)}` +
        `${String(enMio(a.residentMoyenOctets)).padStart(9)}` +
        `${String(enMio(a.privePicOctets)).padStart(14)}\n`,
    );
  }
  const heap = mesures.reprises.at(-1)?.tasJs?.page?.usedJSHeapSize ?? null;
  process.stdout.write(
    `\n  Pour comparaison, le tas JS de la PAGE en fin de reprise : ${enMio(heap)} Mio.\n`,
  );
}

async function principal() {
  const raison = raisonDIndisponibilite();
  if (raison !== null) {
    process.stderr.write(`Banc mémoire indisponible — ${raison}\n`);
    process.exit(1);
  }

  const plan = configurationDeBoot();
  const serveur = await demarrerServeur();
  mkdirSync(DOSSIER_PROFIL, { recursive: true });
  const contexte = await chromium.launchPersistentContext(DOSSIER_PROFIL, {
    headless: !drapeau("headed"),
  });
  const nav = await contexte.browser().newBrowserCDPSession();
  const echantillonneur = new Echantillonneur(nav);
  const boucle = echantillonneur.boucler();

  let mesures;
  try {
    // Un relevé de base AVANT toute charge : sans lui, le pic ne se distingue pas du coût fixe
    // d'un Chromium au repos, qui est loin d'être nul.
    echantillonneur.phase("base");
    const vide = await contexte.newPage();
    await vide.goto(`${ORIGINE}/vm/index.html`, { waitUntil: "load" });
    await new Promise((suite) => setTimeout(suite, 3 * INTERVALLE_MS));
    await vide.close();

    mesures = await mesurer(contexte, echantillonneur, plan);
  } finally {
    echantillonneur.arreter();
    await boucle;
    await contexte.close();
    serveur.kill();
  }

  const agregats = echantillonneur.agregats();
  const picsDeReprise = Object.entries(agregats)
    .filter(([phase]) => phase.startsWith("reprise-"))
    .map(([, a]) => a.residentPicOctets);

  const rapport = {
    mesureLe: new Date().toISOString(),
    environnement: {
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
      navigateur: `chromium ${chromium.name()} ${contexte.browser()?.version?.() ?? ""}`.trim(),
      isolationCrossOrigin: false,
      intervalleMs: INTERVALLE_MS,
    },
    instrument: {
      empreinte: "CDP SystemInfo.getProcessInfo + mémoire résidente du système, par processus",
      contreMesure: "performance.memory de la page et de chaque Worker (Chromium uniquement)",
      nonUtilise:
        "performance.measureUserAgentSpecificMemory() — exige crossOriginIsolated, que l'ADR 0010 n'impose pas",
    },
    scenario: {
      volume: VOLUME,
      reprises: ESSAIS,
      memoireVmOctets: plan.configBoot.memoryBytes,
      disqueAppOctets: plan.appDiskBytes,
    },
    parPhase: agregats,
    dispersionDesPicsDeReprise: dispersion(picsDeReprise),
    budgetOctets: { prototype: 1.5 * 1024 * MIO, mvp: 1.2 * 1024 * MIO },
    resultats: mesures,
  };

  mkdirSync(DOSSIER_RAPPORT, { recursive: true });
  const chemin = join(DOSSIER_RAPPORT, "mesures-memoire.json");
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`);
  afficher(agregats, mesures);
  process.stdout.write(`\nRapport : ${chemin}\n`);
}

await principal();
