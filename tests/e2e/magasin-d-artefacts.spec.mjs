// LA PREUVE de D1 (#247) : le magasin d'artefacts SERT le rootfs et le paquet au démarrage suivant.
//
// Sur le modèle de `reprise-mutation-boot-froid.spec.mjs` : une vraie application Rails boote dans
// un Worker, et tout ce que l'épreuve affirme est mesuré dans le navigateur. Les requêtes vers
// `/artifacts/reference-image/` sont COMPTÉES par la page : un démarrage servi par le magasin n'en
// émet aucune vers le rootfs ni vers le paquet. Une seconde épreuve vide `vault-artefacts` et
// constate le retéléchargement — le magasin est un cache, jamais une condition du boot.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { adressesServiesV86, artefactsV86Absents } from "../../tools/v86-paths.mjs";
import { graineDuManifeste, runtimeDuManifeste } from "../support/image-de-reference.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

const VOLUME = "vault-app-magasin-e2e";
const BUDGET_BOOT_MS = 300_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return `manifeste absent : « npm run image:build » (puis « npm run vm:fetch »)`;
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((a) => a.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image #5 absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  const absentsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (absentsV86.length > 0) {
    return `artefacts v86 absents (${absentsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

test.afterEach(async ({ context }, testInfo) => {
  if (raison !== null) return;
  const page = await context.newPage();
  try {
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    await page.evaluate(
      (n) => globalThis.bancReprise.executer({ phase: "cleanup", volume: n }),
      VOLUME,
    );
  } catch (erreur) {
    await testInfo.attach("hygiene-echouee.txt", {
      body: `Nettoyage de ${VOLUME} en échec : ${erreur.message}`,
      contentType: "text/plain",
    });
  } finally {
    await page.close();
  }
});

/** Le banc, le contrat de l'image et les deux adresses que le magasin doit épargner. */
function preparerLeBanc() {
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const graine = graineDuManifeste(manifeste);
  const runtime = runtimeDuManifeste(manifeste, adressesServiesV86());
  const manifest = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  return {
    graine,
    manifest,
    contrat,
    adressesDuDisque: [runtime.disqueSysteme.rootfs.url, runtime.disqueSysteme.paquet.url],
    configBoot: {
      volume: VOLUME,
      cmdline: manifeste.boot.cmdline,
      memoryBytes: manifeste.boot.memoryMiB * 1024 * 1024,
      runtime,
      manifest,
      expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
      bootTimeoutMs: BUDGET_BOOT_MS,
    },
  };
}

async function nouvellePage(context) {
  const page = await context.newPage();
  const requetes = [];
  page.on("request", (r) => requetes.push(new URL(r.url()).pathname));
  await page.goto("/vm/reference.html", { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
    timeout: 20_000,
  });
  return { page, requetes };
}

const courir = (page, payload) => page.evaluate((p) => globalThis.bancReprise.executer(p), payload);

/** Prépare le volume puis le PREMIER démarrage : celui-ci télécharge et range au magasin. */
async function premierDemarrage(context, banc) {
  let session = await nouvellePage(context);
  await courir(session.page, {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes: banc.graine.appDiskBytes,
    appDiskUrl: banc.graine.appDiskUrl,
    manifest: banc.manifest,
  });
  await session.page.close();
  session = await nouvellePage(context);
  const live = await courir(session.page, { ...banc.configBoot, phase: "live" });
  await session.page.close();
  expect(live.conforming, "le premier démarrage répond").toBe(true);
  const telecharges = session.requetes.filter((u) => banc.adressesDuDisque.includes(u));
  expect(telecharges.length, "le premier démarrage télécharge le disque").toBeGreaterThan(0);
  return live;
}

/** Un démarrage sur une page NEUVE (verrouillage puis réouverture) : requêtes et durée d'acquisition. */
async function redemarrer(context, banc) {
  const session = await nouvellePage(context);
  const debut = Date.now();
  const arm = await courir(session.page, { ...banc.configBoot, phase: "resume-arm" });
  const acquisitionMs = Date.now() - debut;
  const boot = await courir(session.page, { phase: "resume-fire" });
  await session.page.close();
  return {
    acquisitionMs,
    transferredBytes: arm.transferredBytes,
    requetesDuDisque: session.requetes.filter((u) => banc.adressesDuDisque.includes(u)),
    boot,
  };
}

function publier(nom, mesures) {
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(join(DOSSIER_RAPPORTS, nom), `${JSON.stringify(mesures, null, 2)}\n`, "utf8");
}

test("le démarrage suivant est servi par le magasin : aucune requête vers le rootfs ni le paquet", async ({
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "magasin-d-artefacts.spec.mjs");
  test.setTimeout(1_200_000);
  const banc = preparerLeBanc();

  const live = await premierDemarrage(context, banc);
  const suivant = await redemarrer(context, banc);

  expect(suivant.requetesDuDisque, "0 requête vers le rootfs et le paquet").toEqual([]);
  expect(suivant.boot.conforming, "l'application répond, servie par le magasin").toBe(true);
  expect(suivant.boot.observedRecordId).toBe(banc.contrat.record.id);

  const mesures = {
    mesureLe: new Date().toISOString(),
    navigateur: testInfo.project.name,
    premierDemarrage: { transfereOctets: live.transferredBytes },
    demarrageServi: {
      acquisitionMs: suivant.acquisitionMs,
      transfereOctets: suivant.transferredBytes,
      healthMs: suivant.boot.healthMilliseconds,
    },
  };
  publier("magasin-d-artefacts.json", mesures);
  await testInfo.attach("magasin-d-artefacts.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});

test("un magasin vidé n'empêche rien : le disque est retéléchargé et l'application répond", async ({
  context,
}) => {
  exigerLesPrealables(raison, "magasin-d-artefacts.spec.mjs");
  test.setTimeout(1_200_000);
  const banc = preparerLeBanc();

  await premierDemarrage(context, banc);
  const page = await context.newPage();
  await page.goto("/vm/reference.html", { waitUntil: "load" });
  await page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    await racine.removeEntry("vault-artefacts", { recursive: true });
  });
  await page.close();

  const suivant = await redemarrer(context, banc);
  expect(suivant.requetesDuDisque.length, "le disque est retéléchargé").toBeGreaterThan(0);
  expect(suivant.boot.conforming, "l'application répond après le retéléchargement").toBe(true);
});
