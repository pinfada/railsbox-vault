// Coût de la boucle d'ordonnancement de Vault sur l'IMAGE DE RÉFÉRENCE (#74).
//
// La question : remplacer la boucle du moteur par celle de Vault ralentit-il l'émulateur ? Un seul
// essai par bras ne peut pas y répondre — la machine de développement fait varier un boot de Rails
// i386 de plus de 15 % d'un essai à l'autre. Ce harnais applique donc le protocole du spike #41 :
//
//   1. le volume applicatif est préparé UNE fois et réutilisé par les dix boots : les deux bras
//      lisent et écrivent le même disque, dans le même état de départ ;
//   2. les essais sont ENTRELACÉS — native, Vault, native, Vault… — de sorte qu'une dérive de la
//      machine (thermique, ramasse-miettes, autre processus) frappe les deux bras également ;
//   3. chaque boot part d'une PAGE NEUVE, donc d'un Worker neuf et de handles OPFS rendus ;
//   4. le relevé publie, par essai, la durée jusqu'à `/vault/health`, les écritures OPFS, le
//      compteur de tours et la boucle réellement en place.
//
// Ce fichier MESURE. Il n'affirme que ce sans quoi la mesure ne voudrait rien dire : que chaque bras
// a bien tourné sur la boucle annoncée, et que chaque boot a réellement rendu l'invariant. Le
// verdict « dans le bruit » ou « écart supérieur au bruit » est CALCULÉ et publié ; il ne fait pas
// échouer la suite, parce qu'un écart est un fait à décider, pas une régression de code à bloquer.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../e2e/contexte-persistant.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_V86 = join(RACINE, "vendor", "v86", "artefacts");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "rythme");

const VOLUME = "vault-app-rythme";

/** Essais par bras. Cinq est ce que le protocole de #74 demande ; dix boots au total. */
const ESSAIS_PAR_BRAS = 5;
const BUDGET_BOOT_MS = 300_000;

/** Les deux bras, dans l'ordre où le premier tour les visite. */
const BRAS = ["native", "vault"];

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absentsImage = manifeste.artifacts
    .map((a) => a.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absentsImage.length > 0) {
    return `artefacts de l'image #5 absents (${absentsImage.join(", ")}) : « npm run image:build »`;
  }
  const absentsV86 = ["libv86.mjs", "v86.wasm"].filter(
    (nom) => !existsSync(join(DOSSIER_V86, nom)),
  );
  if (absentsV86.length > 0) {
    return `artefacts v86 absents (${absentsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

/** Rang le plus proche — conservateur sur cinq essais : p95 y vaut le maximum. */
function percentile(valeurs, p) {
  const triees = [...valeurs].sort((a, b) => a - b);
  return triees[Math.max(0, Math.ceil((p / 100) * triees.length) - 1)];
}

const arrondi = (valeur) => Number(valeur.toFixed(1));

/** Statistiques d'un bras : ce qui est publié, et rien de dérivé qu'on ne puisse recalculer. */
function statistiques(essais) {
  const durees = essais.map((e) => e.healthMs);
  const min = Math.min(...durees);
  const max = Math.max(...durees);
  return {
    essais: durees,
    p50: percentile(durees, 50),
    p95: percentile(durees, 95),
    min,
    max,
    etendueMs: max - min,
    etenduePourCent: arrondi(((max - min) / min) * 100),
    moyenne: Math.round(durees.reduce((total, d) => total + d, 0) / durees.length),
    ecrituresOpfs: essais.map((e) => e.ecrituresOpfs),
    ticksParSeconde: essais.map((e) => e.ticksParSeconde),
  };
}

/**
 * Verdict du protocole, énoncé par la commande qui a demandé cette mesure : l'écart de p50 entre les
 * deux bras est-il plus grand que l'étendue observée À L'INTÉRIEUR d'une série ? Si oui, l'écart
 * n'est pas explicable par le bruit de cette machine et doit être nommé ; sinon, il ne l'est pas.
 */
function verdict(native, vault) {
  const ecartMs = vault.p50 - native.p50;
  const bruitMs = Math.max(native.etendueMs, vault.etendueMs);
  return {
    ecartP50Ms: ecartMs,
    ecartP50PourCent: arrondi((ecartMs / native.p50) * 100),
    bruitMs,
    bruitPourCent: Math.max(native.etenduePourCent, vault.etenduePourCent),
    regle: "|p50(vault) − p50(native)| > max(étendue intra-série) ⇒ écart supérieur au bruit",
    conclusion:
      Math.abs(ecartMs) > bruitMs ? "écart supérieur au bruit" : "dans le bruit de cette machine",
  };
}

const raison = raisonDIndisponibilite();

test("coût de la boucle de Vault sur l'image de référence : cinq essais par bras, entrelacés", async ({
  context,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  testInfo.setTimeout(3_600_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  const descripteurManifeste = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const configBoot = {
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
    manifest: descripteurManifeste,
    expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
    bootTimeoutMs: BUDGET_BOOT_MS,
  };

  /** Ouvre une page neuve du banc sur le bras demandé. Fermer la page ferme son Worker. */
  async function ouvrir(bras) {
    const page = await context.newPage();
    const suffixe = bras === "native" ? "?boucle=native" : "";
    await page.goto(`/vm/reference.html${suffixe}`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    // Le banc dit quelle boucle il a demandée : sans ce contrôle, une faute de frappe dans l'URL
    // ferait mesurer deux fois le même bras et produirait un « dans le bruit » sans valeur.
    expect(await page.evaluate(() => globalThis.bancReprise.boucle)).toBe(bras);
    return page;
  }

  async function phase(page, payload) {
    return page.evaluate((p) => globalThis.bancReprise.executer(p), payload);
  }

  // 1. Le volume est préparé UNE fois. Les dix boots qui suivent partent du même disque.
  const preparation = await ouvrir("vault");
  const prepare = await phase(preparation, {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes: disqueApp.byteSize,
    appDiskUrl: `/artifacts/reference-image/${manifeste.boot.hdb}`,
    manifest: descripteurManifeste,
  });
  await preparation.close();
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    disqueApp.byteSize,
  );

  // 2. Dix boots entrelacés. L'ordre alterne à chaque tour : native, Vault, native, Vault…
  const essais = [];
  for (let tour = 1; tour <= ESSAIS_PAR_BRAS; tour += 1) {
    for (const bras of BRAS) {
      const page = await ouvrir(bras);
      let rapport;
      try {
        rapport = await phase(page, { ...configBoot, phase: "live" });
      } finally {
        await page.close();
      }
      essais.push({
        tour,
        bras,
        healthMs: rapport.healthMilliseconds,
        bootMs: rapport.bootMilliseconds,
        ecrituresOpfs: rapport.counts.write ?? 0,
        barrieres: rapport.counts.flush ?? 0,
        barrieresAcquittees: rapport.counts["flush-ack"] ?? 0,
        ticks: rapport.rythme?.ticks ?? null,
        ticksParSeconde: rapport.rythme?.ticksParSeconde ?? null,
        boucleOrdonnancement: rapport.boucleOrdonnancement,
        conforming: rapport.conforming,
        observationsRuntime: rapport.observationsRuntime,
        failures: rapport.failures,
      });
    }
  }

  const parBras = Object.fromEntries(
    BRAS.map((bras) => [bras, statistiques(essais.filter((e) => e.bras === bras))]),
  );
  const mesures = {
    mesureLe: new Date().toISOString(),
    protocole: {
      essaisParBras: ESSAIS_PAR_BRAS,
      entrelacement: "native, vault, native, vault…",
      volumePrepareUneFois: true,
      phase: "live",
      pageNeuveParEssai: true,
    },
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
      memoireVmOctets: configBoot.memoryBytes,
      disqueAppOctets: disqueApp.byteSize,
    },
    essais,
    parBras,
    verdict: verdict(parBras.native, parBras.vault),
  };

  const corps = `${JSON.stringify(mesures, null, 2)}\n`;
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(join(DOSSIER_RAPPORTS, "boucle-ordonnancement.json"), corps, "utf8");
  await testInfo.attach("boucle-ordonnancement.json", {
    body: corps,
    contentType: "application/json",
  });

  // Anti-vacuité : les deux bras ont réellement tourné sur la boucle annoncée. Sans ces deux
  // exigences, une bascule inopérante rendrait dix essais identiques et un verdict trompeur.
  for (const essai of essais.filter((e) => e.bras === "vault")) {
    expect(essai.boucleOrdonnancement?.source, `essai vault ${essai.tour}`).toMatch(/^vault/);
    expect(essai.boucleOrdonnancement.appels, `essai vault ${essai.tour}`).toBeGreaterThan(0);
  }
  for (const essai of essais.filter((e) => e.bras === "native")) {
    expect(essai.boucleOrdonnancement, `essai native ${essai.tour}`).toBeNull();
  }

  // Et chaque boot a réellement abouti : une mesure de durée sur un boot qui n'a rien rendu ne
  // mesurerait qu'un délai de garde.
  for (const essai of essais) {
    expect(essai.conforming, `invariant de l'essai ${essai.bras} ${essai.tour}`).toBe(true);
    expect(essai.failures, `pannes de support ${essai.bras} ${essai.tour}`).toEqual([]);
    expect(essai.barrieresAcquittees).toBe(essai.barrieres);
  }
  expect(essais.filter((e) => e.bras === "native")).toHaveLength(ESSAIS_PAR_BRAS);
  expect(essais.filter((e) => e.bras === "vault")).toHaveLength(ESSAIS_PAR_BRAS);
});

// Hygiène : le volume pèse un demi-gibioctet, et il est retiré avec le PROFIL. Le contexte de ce
// harnais est un profil persistant créé dans `test-results/rythme` par test
// (`tests/e2e/contexte-persistant.mjs`), que Playwright efface au début de chaque exécution — et
// c'est là que vit l'OPFS. Un nettoyage par un contexte neuf viserait un autre profil, donc un autre
// OPFS : il ne retirerait rien et le laisserait croire.
