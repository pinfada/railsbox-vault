// Preuve BOUT EN BOUT de la RESTAURATION INTER-ORIGINE (#12, `VAULT-PORT-001`). C'est le résultat
// attendu de l'issue, en un seul enchaînement : mutation Rails sur l'origine A, export vérifiable
// (#11), CHANGEMENT D'ORIGINE réel, import sur l'origine B, boot à froid hors ligne sur B, et
// vérification Rails de l'invariant.
//
// Le changement d'origine n'est pas décoratif : OPFS est cloisonné PAR ORIGINE. `A` et `B` sont deux
// origines distinctes au sens du navigateur (`127.0.0.1:4177` et `localhost:4178`, cf.
// `playwright.e2e.config.mjs` et l'ADR 0002). Le test le PROUVE avant d'importer : le volume de A
// est introuvable dans l'OPFS de B. Tout ce que B retrouve ensuite ne peut venir que de l'archive.
//
// Le TRANSFERT de l'archive entre les deux origines est le fait du test, pas du produit : l'archive
// est téléchargée depuis A vers le système de fichiers de l'hôte (le geste utilisateur réel), puis
// remise à B par un `<input type="file">` (l'autre geste utilisateur réel). Aucun canal
// inter-origines n'est ouvert dans le produit — la CSP de la coquille l'interdit toujours.
//
// Deux règles le gouvernent, comme `tests/e2e/reprise-mutation-boot-froid.spec.mjs` :
//
//   1. il ne réussit jamais sans les artefacts : sans l'image #5 ou v86, il se déclare `skipped`
//      avec la commande à lancer ;
//   2. tout ce qu'il affirme est mesuré dans un Worker qui porte le handle OPFS exclusif et v86
//      (ADR 0002) ; la coquille — et donc ce test — ne reçoit que du JSON.
//
// Ce que le scénario prouve et ses limites sont décrits dans `docs/testing.md`.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { E2E_ORIGIN_A, E2E_ORIGIN_B } from "../../playwright.e2e.config.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_V86 = join(RACINE, "vendor", "v86", "artefacts");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** Volumes et archive, nommés pour ne heurter aucune autre suite. */
const VOLUME_A = "vault-origine-a-e2e";
const ARCHIVE = "vault-archive-inter-origine-e2e";
const VOLUME_B = "vault-origine-b-e2e";
const VOLUME_B_REFUS = "vault-origine-b-refus-e2e";

/** Budget d'un boot Rails. Généreux : l'i386 émulé démarre en dizaines de secondes. */
const BUDGET_BOOT_MS = 300_000;

/** Décrit ce qui manque, ou `null` si tout est là. Le boot à froid exige image #5 ET v86. */
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
  const absentsV86 = ["libv86.mjs", "v86.wasm"].filter(
    (nom) => !existsSync(join(DOSSIER_V86, nom)),
  );
  if (absentsV86.length > 0) {
    return `artefacts v86 absents (${absentsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

/** Copie l'archive en retournant UN bit d'un octet de contenu : le témoin négatif du transfert. */
async function copieAlteree(chemin, cible) {
  await copyFile(chemin, cible);
  const fichier = await open(cible, "r+");
  try {
    const taille = (await fichier.stat()).size;
    const position = taille - 100;
    const octet = Buffer.alloc(1);
    await fichier.read(octet, 0, 1, position);
    octet[0] ^= 0x01;
    await fichier.write(octet, 0, 1, position);
  } finally {
    await fichier.close();
  }
}

const raison = raisonDIndisponibilite();

test("un volume exporté depuis une origine est restauré, booté à froid et vérifié par Rails depuis une AUTRE origine", async ({
  context,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  test.setTimeout(1_500_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  const appDiskBytes = disqueApp.byteSize;
  const appDiskUrl = `/artifacts/reference-image/${manifeste.boot.hdb}`;

  const descripteurManifeste = {
    runtime: { version: paquet.version, artifact: null },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const attentes = { app: { id: contrat.application.id } };

  const runtime = {
    lib: "/vendor/v86/artefacts/libv86.mjs",
    wasm: "/vendor/v86/artefacts/v86.wasm",
    bios: `/artifacts/reference-image/${manifeste.boot.bios}`,
    vgaBios: `/artifacts/reference-image/${manifeste.boot.vgaBios}`,
    kernel: `/artifacts/reference-image/${manifeste.boot.kernel}`,
    initrd: `/artifacts/reference-image/${manifeste.boot.initrd}`,
    rootfs: `/artifacts/reference-image/${manifeste.boot.hda}`,
  };
  const configBoot = {
    cmdline: manifeste.boot.cmdline,
    memoryBytes: manifeste.boot.memoryMiB * 1024 * 1024,
    runtime,
    expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
    bootTimeoutMs: BUDGET_BOOT_MS,
  };

  /** Ouvre une page NEUVE sur l'origine demandée et instrumente ses requêtes. */
  async function nouvellePage(origine) {
    const page = await context.newPage();
    const requetes = [];
    page.on("request", (r) => requetes.push(r.url()));
    await page.goto(`${origine}/vm/reference.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return { page, requetes };
  }

  const courir = (page, payload) =>
    page.evaluate((p) => globalThis.bancReprise.executer(p), payload);

  /**
   * Remet une archive de l'hôte à l'origine visitée par le geste utilisateur réel : un
   * `<input type="file">`. Le fichier ne transite par aucun canal inter-origines ; c'est le test —
   * et, en production, l'utilisateur — qui le transporte.
   */
  async function importer(page, chemin, payload) {
    await page.setInputFiles("#archive-entrante", chemin);
    return page.evaluate((p) => globalThis.bancReprise.executerAvecFichier(p), payload);
  }

  // === ORIGINE A ================================================================================
  // 1. Le disque applicatif de l'image #5 — qui porte l'invariant durable écrit par Rails via
  //    `bin/vault-fixture` — est écrit dans un volume OPFS de A, en flux.
  let session = await nouvellePage(E2E_ORIGIN_A);
  const prepare = await courir(session.page, {
    phase: "prepare",
    volume: VOLUME_A,
    appDiskBytes,
    appDiskUrl,
  });
  await session.page.close();
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    appDiskBytes,
  );

  // 2. MUTATION RAILS sur A : Rails boote sur ce volume, y écrit, et ses barrières atteignent OPFS.
  session = await nouvellePage(E2E_ORIGIN_A);
  const live = await courir(session.page, { ...configBoot, phase: "live", volume: VOLUME_A });
  await session.page.close();
  expect(live.failures, "aucune panne de support absorbée sur A").toEqual([]);
  expect(live.conforming, "invariant conforme à chaud sur A").toBe(true);
  expect(live.counts.write, "Rails a écrit des blocs dans l'OPFS de A").toBeGreaterThan(0);
  expect(live.counts["flush-ack"], "chaque barrière est acquittée sur A").toBe(live.counts.flush);

  // 3. EXPORT vérifiable (#11) du volume de A vers une archive de l'OPFS de A.
  session = await nouvellePage(E2E_ORIGIN_A);
  const exporte = await courir(session.page, {
    phase: "export",
    volume: VOLUME_A,
    archive: ARCHIVE,
    manifest: descripteurManifeste,
  });
  const digestOrigineA = await courir(session.page, {
    phase: "digest-volume",
    volume: VOLUME_A,
  });
  await session.page.close();
  expect(exporte.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(digestOrigineA.digest, "l'archive empreinte bien le volume de A").toBe(exporte.digest);

  // 4. TRANSFERT — le fait du test, pas du produit : téléchargement de l'archive vers l'hôte.
  session = await nouvellePage(E2E_ORIGIN_A);
  const cheminArchive = testInfo.outputPath("volume-origine-a.rbvault");
  const [telechargement] = await Promise.all([
    session.page.waitForEvent("download"),
    session.page.evaluate((nom) => globalThis.bancReprise.telecharger(nom), ARCHIVE),
  ]);
  await telechargement.saveAs(cheminArchive);
  await session.page.close();
  expect(statSync(cheminArchive).size, "l'archive transférée est complète").toBe(
    exporte.archiveLength,
  );

  // === ORIGINE B ================================================================================
  // 5. ISOLATION : l'OPFS de B ignore tout de A. Sans cette preuve, l'import ne prouverait rien.
  session = await nouvellePage(E2E_ORIGIN_B);
  const avantImport = await courir(session.page, { phase: "inspect-volume", volume: VOLUME_A });
  const archiveSurB = await courir(session.page, { phase: "inspect-volume", volume: ARCHIVE });
  const cibleAvant = await courir(session.page, { phase: "inspect-volume", volume: VOLUME_B });
  await session.page.close();
  expect(avantImport.present, "le volume de A est absent de l'OPFS de B").toBe(false);
  expect(archiveSurB.present, "l'archive de A est absente de l'OPFS de B").toBe(false);
  expect(cibleAvant.present, "la cible de restauration n'existe pas encore sur B").toBe(false);

  // 6. IMPORT sur B : l'archive est vérifiée AVANT toute mutation, restaurée en flux, re-vérifiée,
  //    et son manifeste n'est inscrit qu'ensuite.
  session = await nouvellePage(E2E_ORIGIN_B);
  const importe = await importer(session.page, cheminArchive, {
    phase: "import",
    volume: VOLUME_B,
    expectations: attentes,
  });
  await session.page.close();
  await testInfo.attach("import.json", {
    body: JSON.stringify(importe, null, 2),
    contentType: "application/json",
  });
  expect(importe.ok, `restauration en échec : ${importe.error?.message ?? ""}`).toBe(true);
  expect(importe.restored).toBe(true);
  // Le volume restauré sur B est byte-exact avec celui exporté depuis A.
  expect(importe.contentDigest).toBe(exporte.digest);
  expect(importe.verifiedDigest).toBe(exporte.digest);
  expect(importe.volumeSize).toBe(appDiskBytes);
  // Surmémoire bornée : aucune lecture ni écriture ne demande tout le volume d'un coup.
  expect(importe.maxSourceReadBytes).toBeLessThanOrEqual(importe.blockBytes);
  expect(importe.maxTargetWriteBytes).toBeLessThanOrEqual(importe.blockBytes);
  expect(importe.blockBytes).toBeLessThanOrEqual(64 * 1024 * 1024);

  session = await nouvellePage(E2E_ORIGIN_B);
  const cibleApres = await courir(session.page, { phase: "inspect-volume", volume: VOLUME_B });
  const digestOrigineB = await courir(session.page, { phase: "digest-volume", volume: VOLUME_B });
  await session.page.close();
  expect(cibleApres.present).toBe(true);
  expect(cibleApres.size).toBe(appDiskBytes);
  expect(cibleApres.manifestPresent, "le volume restauré porte son manifeste").toBe(true);
  expect(digestOrigineB.digest, "le volume de B est byte-exact avec celui de A").toBe(
    exporte.digest,
  );

  // 7. BOOT À FROID HORS LIGNE sur B, depuis le volume restauré, sans aucun snapshot.
  session = await nouvellePage(E2E_ORIGIN_B);
  const arm = await courir(session.page, { ...configBoot, phase: "resume-arm", volume: VOLUME_B });
  expect(arm.ready).toBe(true);
  await context.setOffline(true);
  const controleReseau = await session.page.evaluate(() =>
    fetch("/vm/reference.html", { cache: "no-store" })
      .then(() => "en-ligne")
      .catch((e) => `hors-ligne:${e.name}`),
  );
  let reprise;
  try {
    reprise = await courir(session.page, { phase: "resume-fire" });
  } finally {
    await context.setOffline(false);
  }
  // La donnée retrouvée sur B ne traverse pas le réseau : le disque applicatif n'est jamais
  // retéléchargé, et toute requête de la page reste sur l'origine B.
  expect(session.requetes.some((u) => u.includes(manifeste.boot.hdb))).toBe(false);
  for (const url of session.requetes) {
    expect(url.startsWith(E2E_ORIGIN_B), `requête inattendue hors de l'origine B : ${url}`).toBe(
      true,
    );
  }
  await session.page.close();
  await testInfo.attach("reprise-origine-b.json", {
    body: JSON.stringify(reprise, null, 2),
    contentType: "application/json",
  });
  expect(controleReseau, "le réseau était bien coupé pendant la reprise").toMatch(/^hors-ligne/);
  expect(reprise.online, "le boot à froid a tourné réseau coupé").toBe(false);
  expect(reprise.usedSnapshot, "aucun instantané mémoire").toBe(false);
  // VÉRIFICATION RAILS : l'invariant et sa pièce jointe ActiveStorage sont retrouvés sur B.
  expect(reprise.conforming, "invariant conforme après restauration inter-origine").toBe(true);
  expect(reprise.observedRecordId).toBe(contrat.record.id);
  expect(reprise.observedAttachmentSha256).toBe(contrat.attachment.sha256);

  // 8. TÉMOIN NÉGATIF — archive altérée : refus typé, et RIEN n'est écrit sur la cible.
  const cheminAltere = testInfo.outputPath("volume-origine-a-altere.rbvault");
  await copieAlteree(cheminArchive, cheminAltere);
  session = await nouvellePage(E2E_ORIGIN_B);
  const refusAltere = await importer(session.page, cheminAltere, {
    phase: "import",
    volume: VOLUME_B_REFUS,
    expectations: attentes,
  });
  const cibleRefusee = await courir(session.page, {
    phase: "inspect-volume",
    volume: VOLUME_B_REFUS,
  });
  await session.page.close();
  expect(refusAltere.ok, "une archive altérée ne doit jamais se restaurer").toBe(false);
  expect(refusAltere.error?.code).toBe("VAULT_ARCHIVE_DIGEST_MISMATCH");
  expect(cibleRefusee.present, "rien n'est écrit quand la vérification échoue").toBe(false);

  // 9. TÉMOIN NÉGATIF — cible non vide sans consentement : refus typé, volume restauré intact.
  session = await nouvellePage(E2E_ORIGIN_B);
  const refusOccupe = await importer(session.page, cheminArchive, {
    phase: "import",
    volume: VOLUME_B,
    expectations: attentes,
  });
  const cibleIntacte = await courir(session.page, { phase: "inspect-volume", volume: VOLUME_B });
  const digestIntact = await courir(session.page, { phase: "digest-volume", volume: VOLUME_B });
  await session.page.close();
  expect(refusOccupe.ok).toBe(false);
  expect(refusOccupe.error?.code).toBe("VAULT_IMPORT_TARGET_NOT_EMPTY");
  expect(cibleIntacte.manifestPresent, "le volume valide garde son manifeste").toBe(true);
  expect(digestIntact.digest, "le volume valide n'a pas été touché").toBe(exporte.digest);

  // 10. Hygiène : retirer volumes et archive des DEUX origines.
  session = await nouvellePage(E2E_ORIGIN_A);
  for (const nom of [VOLUME_A, ARCHIVE]) {
    await courir(session.page, { phase: "cleanup", volume: nom }).catch(() => {});
  }
  await session.page.close();
  session = await nouvellePage(E2E_ORIGIN_B);
  for (const nom of [VOLUME_B, `${VOLUME_B}.manifest`, VOLUME_B_REFUS]) {
    await courir(session.page, { phase: "cleanup", volume: nom }).catch(() => {});
  }
  await session.page.close();

  // Mesures publiées.
  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    origines: { export: E2E_ORIGIN_A, restauration: E2E_ORIGIN_B },
    volumeOctets: appDiskBytes,
    archive: { octets: exporte.archiveLength, digest: exporte.digest },
    isolation: {
      volumeDeAVuDepuisB: avantImport.present,
      archiveDeAVueDepuisB: archiveSurB.present,
    },
    restauration: {
      digestVerifie: importe.verifiedDigest,
      blocOctets: importe.blockBytes,
      plusGrandeLectureArchive: importe.maxSourceReadBytes,
      plusGrandeEcritureVolume: importe.maxTargetWriteBytes,
      budget: importe.budget,
      dureeMs: importe.durationMs ?? null,
    },
    bootFroidSurB: {
      healthMs: reprise.healthMilliseconds,
      horsLigne: reprise.online === false,
      sansInstantane: reprise.usedSnapshot === false,
      invariant: reprise.invariantStatus,
    },
    refus: { archiveAlteree: refusAltere.error, cibleNonVide: refusOccupe.error },
    surmemoireMaxOctets: 64 * 1024 * 1024,
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "restauration-inter-origine.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("restauration-inter-origine.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});
