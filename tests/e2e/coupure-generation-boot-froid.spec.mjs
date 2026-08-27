// Preuve BOUT EN BOUT de la génération transactionnelle (#16, ADR 0014).
//
// Une vraie application Rails boote sur un disque OPFS et le mute. La page est FERMÉE pendant que le
// guest écrit, ce qui tue son Worker avec le handle exclusif — sans fermeture propre, sans barrière,
// et donc en laissant une génération en cours. Le boot à froid suivant doit :
//
//   1. ouvrir le volume, c'est-à-dire ne PAS le refuser ;
//   2. DIRE ce que la récupération a fait — génération écartée, rejouée, ou rien en attente ;
//   3. servir un invariant Rails CONFORME, que l'état retenu soit celui d'avant ou celui d'après.
//
// Ce que ce scénario ne prouve pas, et le dit : la coupure est une mort de Worker, pas une mort de
// processus ni une coupure de courant. Le cache d'écriture du navigateur et celui du système
// survivent. C'est la limite que #15 avait inscrite, et #16 ne la lève pas.
//
// Le VOLUME est distinct de celui de `reprise-mutation-boot-froid.spec.mjs` : deux scénarios qui
// partageraient un demi-gibioctet de volume OPFS deviendraient dépendants de leur ordre.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLAFOND_CHARGE_OCTETS, TAMPON_RELECTURE_OCTETS } from "../../src/vm/generation-store.mjs";
import { expect, test } from "./contexte-persistant.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_V86 = join(RACINE, "vendor", "v86", "artefacts");

const VOLUME = "vault-app-coupure-e2e";
const BUDGET_BOOT_MS = 300_000;

/** Décrit ce qui manque pour booter, ou `null` si tout est là. */
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
  const absentsV86 = ["libv86.mjs", "v86.wasm"].filter((n) => !existsSync(join(DOSSIER_V86, n)));
  if (absentsV86.length > 0) {
    return `artefacts v86 absents (${absentsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

/** Hygiène tenue MÊME quand le scénario échoue : le volume applicatif pèse un demi-gibioctet. */
test.afterEach(async ({ context }) => {
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
    process.stderr.write(`[hygiène] coupure : ${erreur.message}\n`);
  } finally {
    await page.close();
  }
});

test("une coupure pendant une mutation Rails laisse un volume qui reboote et dit d'où il repart", async ({
  context,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  test.setTimeout(1_500_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);

  const runtime = {
    lib: "/vendor/v86/artefacts/libv86.mjs",
    wasm: "/vendor/v86/artefacts/v86.wasm",
    bios: `/artifacts/reference-image/${manifeste.boot.bios}`,
    vgaBios: `/artifacts/reference-image/${manifeste.boot.vgaBios}`,
    kernel: `/artifacts/reference-image/${manifeste.boot.kernel}`,
    initrd: `/artifacts/reference-image/${manifeste.boot.initrd}`,
    rootfs: `/artifacts/reference-image/${manifeste.boot.hda}`,
  };
  const descripteurManifeste = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const configBoot = {
    volume: VOLUME,
    cmdline: manifeste.boot.cmdline,
    memoryBytes: manifeste.boot.memoryMiB * 1024 * 1024,
    runtime,
    manifest: descripteurManifeste,
    expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
    bootTimeoutMs: BUDGET_BOOT_MS,
  };

  async function nouvellePage() {
    const page = await context.newPage();
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return page;
  }

  const courir = (page, payload) =>
    page.evaluate((p) => globalThis.bancReprise.executer(p), payload);

  // 1. Volume NEUF, disque applicatif écrit dans OPFS, manifeste inscrit en dernier.
  let page = await nouvellePage();
  const prepare = await courir(page, {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes: disqueApp.byteSize,
    appDiskUrl: `/artifacts/reference-image/${manifeste.boot.hdb}`,
    manifest: descripteurManifeste,
  });
  await page.close();
  expect(prepare.bytesWritten).toBe(disqueApp.byteSize);

  // 2. BOOT COUPÉ. La phase annonce l'instant où le guest a écrit ET acquitté une barrière ; la page
  //    est fermée là, ce qui tue le Worker avec son handle exclusif — sans `close()`, sans barrière.
  page = await nouvellePage();
  await page.evaluate((p) => globalThis.bancReprise.lancer(p), {
    ...configBoot,
    phase: "live-couper",
  });
  const mutation = await page.evaluate(() => globalThis.bancReprise.attendreMutation(), null, {
    timeout: BUDGET_BOOT_MS,
  });
  await testInfo.attach("mutation-avant-coupure.json", {
    body: JSON.stringify(mutation, null, 2),
    contentType: "application/json",
  });
  // La coupure PORTE sur quelque chose : le guest a réellement muté le volume, et au moins une
  // barrière a été acquittée. Couper avant, ce serait mesurer un volume jamais touché.
  expect(mutation.counts.write, "le guest a écrit avant la coupure").toBeGreaterThanOrEqual(8);
  expect(mutation.counts["flush-ack"], "une barrière a été acquittée").toBeGreaterThanOrEqual(1);
  await page.close();

  // 3. BOOT À FROID. Le volume s'ouvre, la récupération DIT ce qu'elle a fait, et Rails est conforme.
  page = await nouvellePage();
  const froid = await courir(page, { ...configBoot, phase: "live" });
  await page.close();
  await testInfo.attach("boot-apres-coupure.json", {
    body: JSON.stringify(froid, null, 2),
    contentType: "application/json",
  });

  // Le volume n'a pas été refusé : ni manifeste perdu, ni génération jugée corrompue.
  expect(froid.failures, "aucune panne de support absorbée").toEqual([]);

  // La récupération s'est EXPRIMÉE, et le protocole DÉTERMINE ce qu'elle devait dire. Accepter les
  // trois états — c'est-à-dire l'intégralité de `GENERATION_ETATS` — serait une tautologie : la
  // ligne passerait quoi que fasse le mécanisme. Ici la coupure suit au moins une barrière ACQUITTÉE
  // (contrôlé plus haut) et la charge déposée reste très en deçà du seuil de rangement, si bien que
  // la dernière génération validée est forcément encore dans le journal : elle doit être REJOUÉE.
  expect(froid.recuperation, "la récupération est publiée").not.toBeNull();
  expect(froid.recuperation.etat).toBe("rejouee");
  expect(froid.recuperation.generation).toBeGreaterThanOrEqual(1);
  expect(froid.recuperation.enregistrementsRejoues).toBeGreaterThan(0);
  // Et la génération NON validée que la coupure a laissée derrière elle est écartée, comptée.
  expect(froid.recuperation.octetsEcartes).toBeGreaterThan(0);

  // #91 — la RÉCUPÉRATION dit aussi ce qu'elle a coûté, sur un vrai Rails et un vrai OPFS.
  //
  // `octetsRejoues` est la taille de la génération que Rails avait validée au moment de la coupure :
  // c'est le seul chiffre du dépôt qui mesure une génération RÉELLE, et il est publié pour que le
  // plafond de charge cesse d'être calibré sur une analogie (ADR 0014, § Limites).
  //
  // `surmemoireMaxOctets` borne ce que la récupération a tenu en mémoire. Avant #91, elle lisait la
  // charge d'un seul tenant ; la borne est ici vérifiée là où elle compte — sur le support réel.
  expect(froid.recuperation.octetsRejoues).toBeGreaterThan(0);
  expect(froid.recuperation.surmemoireMaxOctets).toBeGreaterThan(0);
  expect(froid.recuperation.surmemoireMaxOctets).toBeLessThanOrEqual(TAMPON_RELECTURE_OCTETS);

  // Et ce que le guest a présenté au journal PENDANT le boot à froid, confronté au plafond. C'est la
  // charge DÉPOSÉE que `PLAFOND_CHARGE_OCTETS` borne — tout ce qui s'accumule depuis un point de
  // contrôle, barrière ou pas —, et non la seule génération validée. La première ligne garantit que
  // le relevé a eu lieu : sans elle, un `null` rendrait la seconde vraie sans rien mesurer.
  expect(froid.generation.deposeeMaxOctets, "relevé effectué").not.toBeNull();
  expect(froid.generation.deposeeMaxOctets, "charge sous le plafond").toBeLessThan(
    PLAFOND_CHARGE_OCTETS,
  );

  // Relevé publié : c'est la seule mesure du dépôt sur ce que l'image de référence demande
  // RÉELLEMENT entre deux barrières (#91, ADR 0014 § Limites).
  await testInfo.attach("generation-mesuree.json", {
    body: JSON.stringify(
      {
        mesureLe: new Date().toISOString(),
        scenario: "coupure pendant une mutation Rails, puis boot à froid",
        avantCoupure: { ecritures: mutation.counts.write, barrieres: mutation.counts["flush-ack"] },
        rejoueeAuBootFroid: froid.recuperation.octetsRejoues,
        ecarteeAuBootFroid: froid.recuperation.octetsEcartes,
        // Pendant le boot à froid : ce que le plafond borne, puis la plus grande génération scellée.
        deposeeMaxOctets: froid.generation.deposeeMaxOctets,
        valideeMaxOctets: froid.generation.valideeMaxOctets,
        surmemoireRecuperationOctets: froid.recuperation.surmemoireMaxOctets,
        plafondOctets: PLAFOND_CHARGE_OCTETS,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // Et l'invariant Rails tient, quel que soit l'état retenu. C'est la promesse de #16 lue par
  // l'application : « ancien ou nouveau », jamais un mélange que SQLite refuserait de monter.
  expect(froid.conforming, "invariant Rails conforme après la coupure").toBe(true);
  expect(froid.observedRecordId).toBe(contrat.record.id);
  expect(froid.observedAttachmentSha256).toBe(contrat.attachment.sha256);
  expect(froid.counts.write, "le boot à froid écrit à son tour").toBeGreaterThan(0);
});
