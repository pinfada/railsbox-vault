// Preuve BOUT EN BOUT des MIGRATIONS DE FORMAT et du REFUS DE DOWNGRADE (#13, `VAULT-COMPAT-001`).
// C'est le résultat attendu de l'issue en un seul enchaînement, sur un vrai volume OPFS de 512 Mio
// et une vraie application Rails :
//
//   1. un volume au format v1 — celui que ce runtime sait encore LIRE mais plus ÉCRIRE — est
//      refusé au boot par `VAULT_MANIFEST_MIGRATION_REQUIRED` ;
//   2. la migration sans preuve de sauvegarde est refusée (`VAULT_MIGRATION_BACKUP_REQUIRED`) ;
//   3. une sauvegarde est exportée (#11), puis la migration est INTERROMPUE juste après la
//      révocation du manifeste : le boot suivant est refusé par `VAULT_MANIFEST_UNIDENTIFIED` ;
//   4. la REPRISE aboutit, sans redemander la sauvegarde — le journal porte la preuve retenue ;
//   5. un BOOT À FROID HORS LIGNE retrouve l'invariant Rails, à l'octet près : la migration n'a
//      touché aucun octet du volume ;
//   6. un runtime « ancien », qui ne connaît que le format 1, refuse le volume migré à
//      l'OUVERTURE EN ÉCRITURE (`VAULT_MANIFEST_FORMAT_TOO_NEW`). Le refus en LECTURE existe aussi,
//      mais il est prouvé en unitaire : ce scénario n'exerce que `openVolumeForWrite`.
//
// Deux règles le gouvernent, comme les autres scénarios de `tests/e2e/` :
//
//   1. il ne réussit jamais sans les artefacts : sans l'image #5 ou v86, il se déclare `skipped`
//      avec la commande à lancer ;
//   2. tout ce qu'il affirme est mesuré dans un Worker qui porte le handle OPFS exclusif et v86
//      (ADR 0002) ; la coquille — et donc ce test — ne reçoit que du JSON.
//
// LIMITE assumée, dite ici et dans `docs/testing.md` : le runtime « ancien » du point 6 n'est pas un
// ancien binaire installé, mais le runtime courant à qui l'on DÉCLARE une plage de formats plus
// étroite (`supportedFormat`). Le test prouve que la règle de compatibilité refuse ; il ne prouve
// pas le comportement d'une version publiée antérieurement, qu'aucune release n'a encore produite.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { E2E_ORIGIN_A } from "../../playwright.e2e.config.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_V86 = join(RACINE, "vendor", "v86", "artefacts");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** Volume et archive de sauvegarde, nommés pour ne heurter aucune autre suite. */
const VOLUME = "vault-migration-e2e";
const SAUVEGARDE = "vault-migration-sauvegarde-e2e";

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

const raison = raisonDIndisponibilite();

/**
 * Hygiène tenue même quand le scénario échoue : le volume pèse un demi-gigaoctet et son archive
 * autant. Un défaut de nettoyage ne doit jamais masquer l'échec qu'il suit : il est journalisé.
 */
test.afterEach(async ({ context }) => {
  if (raison !== null) return;
  const page = await context.newPage();
  try {
    await page.goto(`${E2E_ORIGIN_A}/vm/reference.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    for (const nom of [VOLUME, SAUVEGARDE]) {
      await page.evaluate(
        (n) => globalThis.bancReprise.executer({ phase: "cleanup", volume: n }),
        nom,
      );
    }
  } catch (erreur) {
    process.stderr.write(`[hygiène] ${erreur.message}\n`);
  } finally {
    await page.close();
  }
});

test("un volume d'un format antérieur est migré, sa migration interrompue reprend, et une ancienne version le refuse", async ({
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

  /** Descripteur d'un volume au format ANTÉRIEUR : c'est lui qu'il faudra migrer. */
  const descripteurV1 = {
    formatVersion: 1,
    runtime: { version: paquet.version, artifact: null },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  /** Descripteur au format COURANT : celui que la migration doit finir par inscrire. */
  const descripteurCourant = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };

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
    manifest: descripteurCourant,
    expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
    bootTimeoutMs: BUDGET_BOOT_MS,
  };

  async function nouvellePage() {
    const page = await context.newPage();
    const requetes = [];
    page.on("request", (r) => requetes.push(r.url()));
    await page.goto(`${E2E_ORIGIN_A}/vm/reference.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return { page, requetes };
  }

  const courir = (page, payload) =>
    page.evaluate((p) => globalThis.bancReprise.executer(p), payload);

  /** Lance une phase attendue en ÉCHEC et rend le message d'erreur, code typé compris. */
  async function courirEnEchec(page, payload) {
    try {
      await courir(page, payload);
    } catch (erreur) {
      return erreur.message;
    }
    return null;
  }

  // 1. Un volume au format ANTÉRIEUR (v1), préparé depuis le disque applicatif de l'image #5.
  let session = await nouvellePage();
  const prepare = await courir(session.page, {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes,
    appDiskUrl,
    manifest: descripteurV1,
  });
  const avantMigration = await courir(session.page, { phase: "digest-volume", volume: VOLUME });
  await session.page.close();
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    appDiskBytes,
  );
  expect(prepare.formatVersion, "le volume porte bien un manifeste v1").toBe(1);

  // 2. TÉMOIN — un format antérieur est LISIBLE mais pas INSCRIPTIBLE : le boot est refusé.
  session = await nouvellePage();
  const refusMigrationRequise = await courirEnEchec(session.page, {
    ...configBoot,
    phase: "resume",
    volume: VOLUME,
  });
  await session.page.close();
  expect(
    refusMigrationRequise,
    "un volume d'un format antérieur ne s'ouvre jamais en écriture",
  ).toMatch(/VAULT_MANIFEST_MIGRATION_REQUIRED/);

  // 3. TÉMOIN — migrer sans preuve de sauvegarde ni consentement nommé est refusé, et la cible
  //    n'est même pas ouverte.
  session = await nouvellePage();
  const refusSansSauvegarde = await courir(session.page, {
    phase: "migrate",
    volume: VOLUME,
    manifest: descripteurCourant,
  });
  const apresRefus = await courir(session.page, { phase: "inspect-volume", volume: VOLUME });
  await session.page.close();
  expect(refusSansSauvegarde.ok).toBe(false);
  expect(refusSansSauvegarde.error?.code).toBe("VAULT_MIGRATION_BACKUP_REQUIRED");
  expect(apresRefus.manifestPresent, "le manifeste v1 est intact").toBe(true);
  expect(apresRefus.migrationJournalPresent, "aucun journal n'a été inscrit").toBe(false);

  // 4. SAUVEGARDE — l'export vérifiable de #11, exigé avant une migration (docs/release-policy.md).
  session = await nouvellePage();
  const sauvegarde = await courir(session.page, {
    phase: "export",
    volume: VOLUME,
    archive: SAUVEGARDE,
    manifest: descripteurV1,
  });
  await session.page.close();
  expect(sauvegarde.digest).toBe(avantMigration.digest);

  // 5. MIGRATION INTERROMPUE, juste après la révocation du manifeste. C'est l'état qu'un onglet
  //    fermé, un quota atteint ou un support perdu laisserait derrière lui.
  session = await nouvellePage();
  const interrompue = await courir(session.page, {
    phase: "migrate",
    volume: VOLUME,
    manifest: descripteurCourant,
    backupArchive: SAUVEGARDE,
    interruptAfter: "revoke",
  });
  const apresInterruption = await courir(session.page, {
    phase: "inspect-volume",
    volume: VOLUME,
  });
  await session.page.close();
  expect(interrompue.ok, "une migration interrompue ne se déclare jamais réussie").toBe(false);
  expect(apresInterruption.manifestPresent, "le volume n'est plus identifié").toBe(false);
  expect(apresInterruption.migrationJournalPresent, "le journal de reprise subsiste").toBe(true);

  // 6. TÉMOIN — le boot suivant est refusé avant même que v86 ne démarre.
  session = await nouvellePage();
  const refusNonIdentifie = await courirEnEchec(session.page, {
    ...configBoot,
    phase: "resume",
    volume: VOLUME,
  });
  await session.page.close();
  expect(
    refusNonIdentifie,
    "une migration interrompue ne passe jamais pour un volume valide",
  ).toMatch(/VAULT_MANIFEST_UNIDENTIFIED/);

  // 7. REPRISE — sans preuve de sauvegarde : le journal porte celle qui a été retenue.
  session = await nouvellePage();
  const reprise = await courir(session.page, {
    phase: "migrate",
    volume: VOLUME,
    manifest: descripteurCourant,
  });
  const apresReprise = await courir(session.page, { phase: "inspect-volume", volume: VOLUME });
  const apresMigration = await courir(session.page, { phase: "digest-volume", volume: VOLUME });
  await session.page.close();
  await testInfo.attach("migration.json", {
    body: JSON.stringify(reprise, null, 2),
    contentType: "application/json",
  });
  expect(reprise.ok, `reprise en échec : ${reprise.error?.message ?? ""}`).toBe(true);
  expect(reprise.migrated).toBe(true);
  expect(reprise.resumed, "la reprise repart du journal, pas de zéro").toBe(true);
  expect(reprise.fromVersion).toBe(1);
  expect(reprise.toVersion).toBe(2);
  expect(reprise.evidence.kind, "la preuve retenue est la sauvegarde vérifiée").toBe(
    "sauvegarde-verifiee",
  );
  expect(apresReprise.manifestPresent, "le volume est de nouveau identifié").toBe(true);
  expect(apresReprise.migrationJournalPresent, "le journal est retiré en dernier geste").toBe(
    false,
  );
  expect(apresMigration.digest, "la migration n'a touché aucun octet du volume").toBe(
    avantMigration.digest,
  );

  // 8. BOOT À FROID HORS LIGNE sur le volume migré : Rails retrouve son invariant.
  session = await nouvellePage();
  const arm = await courir(session.page, { ...configBoot, phase: "resume-arm", volume: VOLUME });
  expect(arm.ready).toBe(true);
  await context.setOffline(true);
  const controleReseau = await session.page.evaluate(() =>
    fetch("/vm/reference.html", { cache: "no-store" })
      .then(() => "en-ligne")
      .catch((e) => `hors-ligne:${e.name}`),
  );
  let bootApresMigration;
  try {
    bootApresMigration = await courir(session.page, { phase: "resume-fire" });
  } finally {
    await context.setOffline(false);
  }
  expect(session.requetes.some((u) => u.includes(manifeste.boot.hdb))).toBe(false);
  await session.page.close();
  await testInfo.attach("boot-apres-migration.json", {
    body: JSON.stringify(bootApresMigration, null, 2),
    contentType: "application/json",
  });
  expect(controleReseau, "le réseau était bien coupé pendant le boot").toMatch(/^hors-ligne/);
  expect(bootApresMigration.online, "le boot à froid a tourné réseau coupé").toBe(false);
  expect(bootApresMigration.usedSnapshot, "aucun instantané mémoire").toBe(false);
  expect(bootApresMigration.failures, "aucune panne de support absorbée").toEqual([]);
  expect(bootApresMigration.conforming, "invariant conforme après migration").toBe(true);
  expect(bootApresMigration.observedRecordId).toBe(contrat.record.id);
  expect(bootApresMigration.observedAttachmentSha256).toBe(contrat.attachment.sha256);

  // 9. TÉMOIN — REFUS DE DOWNGRADE. Un runtime qui ne connaît que le format 1 refuse le volume
  //    migré à l'ouverture EN ÉCRITURE — c'est ce que cette phase exerce, et rien de plus. Le refus
  //    en LECTURE est prouvé par `tests/unit/vm-volume-manifest.test.mjs`. La « vieille version »
  //    est simulée par ses ATTENTES (`supportedFormat`), pas par un binaire antérieur : voir la
  //    limite en tête de fichier.
  session = await nouvellePage();
  const refusAncienRuntime = await courirEnEchec(session.page, {
    ...configBoot,
    phase: "resume",
    volume: VOLUME,
    manifest: { ...descripteurCourant, supportedFormat: { current: 1, minReadable: 1 } },
  });
  await session.page.close();
  expect(
    refusAncienRuntime,
    "un runtime plus ancien ne doit jamais écrire sur un volume v2",
  ).toMatch(/VAULT_MANIFEST_FORMAT_TOO_NEW/);

  // Mesures publiées.
  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    volumeOctets: appDiskBytes,
    formats: { avant: 1, apres: 2 },
    empreinteVolume: {
      avantMigration: avantMigration.digest,
      apresMigration: apresMigration.digest,
    },
    sauvegarde: { octets: sauvegarde.archiveLength, digest: sauvegarde.digest },
    migration: {
      reprise: reprise.resumed,
      preuve: reprise.evidence,
      dureeMs: reprise.durationMs ?? null,
    },
    refus: {
      formatAnterieurAuBoot: refusMigrationRequise,
      sansSauvegarde: refusSansSauvegarde.error,
      apresInterruption: refusNonIdentifie,
      runtimeAncien: refusAncienRuntime,
    },
    bootApresMigration: {
      healthMs: bootApresMigration.healthMilliseconds,
      horsLigne: bootApresMigration.online === false,
      sansInstantane: bootApresMigration.usedSnapshot === false,
      invariant: bootApresMigration.invariantStatus,
    },
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "migration-volume-versionne.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("migration-volume-versionne.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});
