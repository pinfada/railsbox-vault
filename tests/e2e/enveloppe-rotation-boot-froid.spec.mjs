// Scénario de BOUT EN BOUT de l'enveloppe de clé (#21, ADR 0020 ; `SEC-KEY-001`).
//
// Il enchaîne exactement ce que le contrat de #21 demande, et rien d'autre :
//
//   1. un volume applicatif est préparé, puis son enveloppe est CRÉÉE autour de sa clé de volume ;
//   2. le navigateur est ENTIÈREMENT fermé — page, Worker, handles OPFS, contexte persistant ;
//   3. une réouverture par la CLÉ DE DÉVERROUILLAGE boote Rails et lui fait écrire une mutation ;
//   4. le navigateur est de nouveau fermé, et la clé de déverrouillage est REMPLACÉE ;
//   5. un boot À FROID par la clé NEUVE retrouve la mutation ;
//   6. l'ANCIENNE clé est refusée, par le code du refus de clé — et un volume dont l'enveloppe a été
//      retirée est refusé par « aucune enveloppe », qui n'est pas le même refus.
//
// Deux règles le gouvernent, comme les autres scénarios de ce répertoire :
//
//   1. il ne réussit jamais sans avoir booté. Si les artefacts de l'image #5 ou de v86 sont absents,
//      il se déclare `skipped` avec la raison exacte et la commande à lancer ;
//   2. tout ce qu'il affirme est mesuré dans le navigateur, dans un Worker qui porte v86 et le
//      handle OPFS exclusif (ADR 0002). La coquille — et donc ce test — ne reçoit que du JSON, et
//      jamais une clé.
//
// Ce qu'il ne prouve PAS, et qui est écrit plutôt que laissé à deviner : les clés de déverrouillage
// viennent du HARNAIS, sous jeton, comme la clé de volume depuis #18. Ce scénario mesure l'enveloppe
// et sa rotation, pas la façon dont un humain obtient sa clé — c'est #22.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { expect, test } from "./contexte-persistant.mjs";
import { adressesServiesV86, artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Adresses HTTP des artefacts v86, DÉRIVÉES de leur manifeste (#123).
 *
 * Elles nomment leur empreinte : un chemin écrit en dur ici rendrait un 404 dès la
 * prochaine montée de version de l'émulateur, et l'épreuve accuserait le banc.
 */
const ADRESSES_V86 = adressesServiesV86();
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");

/** Volume propre à ce scénario : deux suites ne partagent jamais un volume d'un demi-gigaoctet. */
const VOLUME = "vault-app-enveloppe-e2e";

const BUDGET_BOOT_MS = 300_000;

/** Décrit ce qui manque pour booter, ou `null` si tout est là. */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return `manifeste absent : « npm run image:build » (puis « npm run vm:fetch »)`;
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absentsImage = manifeste.artifacts
    .map((a) => a.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absentsImage.length > 0) {
    return `artefacts de l'image #5 absents (${absentsImage.join(", ")}) : « npm run image:build »`;
  }
  const absentsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (absentsV86.length > 0) {
    return `artefacts v86 absents (${absentsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

/**
 * Hygiène tenue MÊME quand le scénario échoue. Le volume applicatif pèse un demi-gigaoctet, et le
 * laisser dans le profil pénaliserait les scénarios suivants. Un défaut de nettoyage est journalisé
 * et ATTACHÉ, jamais relancé : il ne doit pas masquer l'échec qu'il suit.
 */
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
    process.stderr.write(`[hygiène] enveloppe : ${erreur.message}\n`);
    await testInfo.attach("hygiene-echouee.txt", {
      body: `Nettoyage de ${VOLUME} en échec : ${erreur.message}`,
      contentType: "text/plain",
    });
  } finally {
    await page.close();
  }
});

test("une clé de déverrouillage ouvre un volume Rails à froid, sa rotation aussi, et l'ancienne est refusée", async ({
  context,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  test.setTimeout(1_500_000);

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
      lib: ADRESSES_V86.get("libv86.mjs"),
      wasm: ADRESSES_V86.get("v86.wasm"),
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

  /**
   * Ouvre une page NEUVE de la coquille. Fermer la page ferme aussi son Worker et rend le handle
   * OPFS : c'est le « fermer page + Worker + handles » que le scénario exige entre chaque étape.
   */
  async function nouvellePage() {
    const page = await context.newPage();
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return page;
  }

  /** Exécute UNE phase dans un Worker neuf, puis referme tout. */
  async function phase(payload) {
    const page = await nouvellePage();
    try {
      return await page.evaluate((p) => globalThis.bancReprise.executer(p), payload);
    } finally {
      await page.close();
    }
  }

  // 1. Volume NEUF, puis son enveloppe autour de la clé sous laquelle il vient d'être scellé.
  const prepare = await phase({
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes: disqueApp.byteSize,
    appDiskUrl: `/artifacts/reference-image/${manifeste.boot.hdb}`,
    manifest: descripteurManifeste,
  });
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    disqueApp.byteSize,
  );

  const creee = await phase({ phase: "enveloppe-creer", volume: VOLUME });
  await testInfo.attach("enveloppe-creee.json", {
    body: JSON.stringify(creee, null, 2),
    contentType: "application/json",
  });
  expect(creee.version).toBe(1);
  expect(creee.enveloppe).toBe(`${VOLUME}.cles`);

  // 2. Boot À CHAUD par la CLÉ DE DÉVERROUILLAGE. Le Worker n'a plus le jeton pour cette phase : il
  //    ouvre l'enveloppe, développe la clé, boote, puis l'efface.
  const live = await phase({ ...configBoot, phase: "live", deverrouillerPar: "initiale" });
  await testInfo.attach("live-par-kek.json", {
    body: JSON.stringify(live, null, 2),
    contentType: "application/json",
  });
  expect(live.enveloppe, "le boot n'est pas passé par l'enveloppe").toEqual({
    kek: "initiale",
    version: 1,
  });
  expect(live.failures, "aucune panne de support absorbée").toEqual([]);
  expect(live.conforming, "invariant Rails conforme à chaud").toBe(true);
  expect(live.observedRecordId).toBe(contrat.record.id);
  expect(live.counts.write, "Rails a écrit des blocs dans OPFS").toBeGreaterThan(0);
  expect(live.counts.flush, "une barrière fsync a atteint OPFS").toBeGreaterThan(0);

  // 3. Le navigateur a été entièrement refermé entre chaque phase. On REMPLACE la clé.
  const remplacee = await phase({
    phase: "enveloppe-remplacer",
    volume: VOLUME,
    emplacement: creee.identifiantEmplacement,
  });
  await testInfo.attach("enveloppe-remplacee.json", {
    body: JSON.stringify(remplacee, null, 2),
    contentType: "application/json",
  });
  expect(remplacee.version, "le compteur de version n'a pas avancé").toBe(2);
  expect(remplacee.nombreEmplacements).toBe(1);

  // 4. Boot À FROID par la clé NEUVE : la mutation Rails est retrouvée.
  const resume = await phase({ ...configBoot, phase: "resume", deverrouillerPar: "rotation" });
  await testInfo.attach("resume-par-nouvelle-kek.json", {
    body: JSON.stringify(resume, null, 2),
    contentType: "application/json",
  });
  expect(resume.enveloppe).toEqual({ kek: "rotation", version: 2 });
  expect(resume.conforming, "la mutation Rails n'a pas survécu à la rotation de clé").toBe(true);
  expect(resume.observedRecordId).toBe(contrat.record.id);
  expect(resume.observedAttachmentSha256).toBe(contrat.attachment.sha256);

  // 5. L'ANCIENNE clé est refusée, et la neuve ouvre toujours — le témoin positif est dans le même
  //    couple d'assertions, sur le même fichier.
  const ancienne = await phase({ phase: "enveloppe-ouvrir", volume: VOLUME, kek: "initiale" });
  const neuve = await phase({ phase: "enveloppe-ouvrir", volume: VOLUME, kek: "rotation" });
  await testInfo.attach("refus-de-l-ancienne.json", {
    body: JSON.stringify({ ancienne, neuve }, null, 2),
    contentType: "application/json",
  });
  expect(ancienne.ouverte, "l'ancienne clé ouvre encore après son remplacement").toBe(false);
  expect(ancienne.code).toBe(ENVELOPPE_ERROR_CODES.cleRefusee);
  expect(neuve.ouverte, "témoin positif : la clé neuve ouvre").toBe(true);
  expect(neuve.version).toBe(2);
  expect(neuve.emplacements).toBe(1);

  // 6. Enveloppe RETIRÉE : le refus change de nature, et c'est le point 5 du contrat de #21.
  const retiree = await phase({ phase: "enveloppe-retirer", volume: VOLUME });
  expect(retiree.retire).toBe(true);
  const sansEnveloppe = await phase({
    phase: "enveloppe-ouvrir",
    volume: VOLUME,
    kek: "rotation",
  });
  expect(sansEnveloppe.code, "« aucune enveloppe » et « clé invalide » se confondent").toBe(
    ENVELOPPE_ERROR_CODES.absente,
  );
  expect(sansEnveloppe.refusDeCle).toBe(false);
});
