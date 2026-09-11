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
// **Étendu par #182, et non dupliqué.** La chaîne va désormais jusqu'à la v4 : le même scénario
// traverse trois pas au lieu de deux, dont DEUX destructifs — v2 → v3 déplace la charge et la scelle
// sous la DEK, v3 → v4 rescelle chaque secteur sous une clé DÉRIVÉE. Le contrat qu'il éprouve est
// inchangé et il est plus exigeant : le fichier ne ressemble plus du tout à celui de départ, et le
// CLAIR, lui, doit sortir identique à l'octet de la traversée entière.
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

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { MANIFEST_FORMAT_VERSION } from "../../src/vm/volume-manifest.mjs";
import { FORMAT_VOLUME_V3, tailleDeFichier } from "../../src/vm/volume-chiffre-format.mjs";

import { PLAFOND_CHARGE_OCTETS } from "../../src/vm/generation-store.mjs";
import { E2E_ORIGIN_A } from "../../playwright.e2e.config.mjs";
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
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** Volume et archive de sauvegarde, nommés pour ne heurter aucune autre suite. */
const VOLUME = "vault-migration-e2e";
const SAUVEGARDE = "vault-migration-sauvegarde-e2e";

/** Le PALIER v3 travaille sur ses propres fichiers : deux scénarios ne partagent jamais un volume. */
const VOLUME_V3 = "vault-palier-v3-e2e";
const SAUVEGARDE_V1_DU_V3 = "vault-palier-v3-sauvegarde-v1-e2e";
const ARCHIVE_DU_V3 = "vault-palier-v3-archive-e2e";

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
  const absentsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
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
    for (const nom of [VOLUME, SAUVEGARDE, VOLUME_V3, SAUVEGARDE_V1_DU_V3, ARCHIVE_DU_V3]) {
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
  chronologie,
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "migration-volume-versionne.spec.mjs");
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
    lib: ADRESSES_V86.get("libv86.mjs"),
    wasm: ADRESSES_V86.get("v86.wasm"),
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
  chronologie.etape("préparation du volume v1", {
    octets: prepare.bytesWritten,
    formatVersion: prepare.formatVersion,
    empreinteAvantMigration: avantMigration.digest,
  });

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

  // 6 bis. SECONDE INTERRUPTION, celle-ci AU MILIEU DE LA CONVERSION.
  //
  //    Les points d'interruption précédents coupent avant que la conversion ne touche un octet :
  //    ils éprouvent le protocole de l'ADR 0011, pas le geste qui réécrit le volume. La revue de
  //    #110 a relevé que « reprise » qualifiait donc un cas où rien n'était converti — une
  //    migration intégrale d'un volume intact, présentée comme une reprise. Ici le fichier est déjà
  //    agrandi, la charge déplacée, une partie des secteurs scellée et le reste en clair.
  session = await nouvellePage();
  const coupeeEnConversion = await courir(session.page, {
    phase: "migrate",
    volume: VOLUME,
    manifest: descripteurCourant,
    interruptAfter: "conversion",
  });
  const apresConversionCoupee = await courir(session.page, {
    phase: "inspect-volume",
    volume: VOLUME,
  });
  await session.page.close();
  expect(coupeeEnConversion.ok, "une conversion coupée ne se déclare jamais réussie").toBe(false);
  expect(apresConversionCoupee.manifestPresent, "le volume reste non identifié").toBe(false);
  expect(apresConversionCoupee.migrationJournalPresent, "le journal subsiste").toBe(true);
  expect(
    apresConversionCoupee.size,
    "le FICHIER est déjà agrandi de sa région : la conversion avait bien commencé",
  ).toBe(tailleDeFichier({ formatVersion: MANIFEST_FORMAT_VERSION, tailleLogique: appDiskBytes }));
  chronologie.etape("conversion COUPÉE", {
    manifestePresent: apresConversionCoupee.manifestPresent,
    journalPresent: apresConversionCoupee.migrationJournalPresent,
    tailleDuFichier: apresConversionCoupee.size,
  });

  // 7. REPRISE — sans preuve de sauvegarde : le journal porte celle qui a été retenue. Elle repart
  //    donc d'une conversion RÉELLEMENT commencée, et non d'un volume intact.
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
  expect(reprise.toVersion).toBe(MANIFEST_FORMAT_VERSION);
  expect(reprise.steps.length, "un PAS à la fois : v1 → v2, v2 → v3, puis v3 → v4").toBe(
    MANIFEST_FORMAT_VERSION - 1,
  );
  // **La chaîne compte DEUX pas destructifs depuis #182**, et c'est ce que ce scénario éprouve de
  // bout en bout : v2 → v3 déplace la charge et la scelle sous la DEK, v3 → v4 rescelle chaque
  // secteur sous une clé DÉRIVÉE. La coupure du point 6 tombe dans l'un des deux ; la reprise
  // traverse les deux, et le clair doit survivre à la traversée entière.
  expect(
    reprise.steps.filter((etape) => etape.destructive).length,
    "deux pas RÉÉCRIVENT le volume, et chacun exige la sauvegarde vérifiée",
  ).toBe(2);
  expect(reprise.evidence.kind, "la preuve retenue est la sauvegarde vérifiée").toBe(
    "sauvegarde-verifiee",
  );
  expect(apresReprise.manifestPresent, "le volume est de nouveau identifié").toBe(true);
  expect(apresReprise.migrationJournalPresent, "le journal est retiré en dernier geste").toBe(
    false,
  );
  // **Ce que les migrations DESTRUCTIVES changent, et que les manifestes ne changeaient pas.** Les
  // premières réécrivaient un manifeste, et l'épreuve pouvait affirmer « aucun octet du volume n'a
  // bougé ». v2 → v3 réécrit TOUT — le fichier grandit de sa région d'authentification et chaque
  // secteur est scellé — et v3 → v4 rescelle chaque secteur sous une AUTRE clé. Ce qui doit être
  // conservé n'est donc plus le fichier, c'est le CLAIR — et le dire ainsi est une preuve plus
  // forte, pas plus faible. La géométrie, elle, est la même en v3 et en v4 : la taille du fichier
  // après la chaîne entière est celle que la v3 imposait déjà.
  expect(apresMigration.size, "le fichier a grandi de sa région d'authentification").toBe(
    tailleDeFichier({ formatVersion: MANIFEST_FORMAT_VERSION, tailleLogique: appDiskBytes }),
  );
  expect(apresMigration.digest, "le FICHIER a changé : il est désormais chiffré").not.toBe(
    avantMigration.digest,
  );
  expect(apresMigration.digestClair, "et le CLAIR est celui d'avant la migration, à l'octet").toBe(
    avantMigration.digest,
  );
  // La CHRONOLOGIE porte ici le compte rendu de migration et les DEUX empreintes du volume migré :
  // c'est ce qui manquait à l'instruction de #165, où l'artefact du run rouge ne disait rien de
  // l'état du volume au moment où le boot suivant a échoué.
  chronologie.etape("reprise de la migration", {
    repriseDuJournal: reprise.resumed,
    deVersion: reprise.fromVersion,
    versVersion: reprise.toVersion,
    pas: reprise.steps.map(
      (etape) => `${etape.from}→${etape.to}${etape.destructive ? " (destructif)" : ""}`,
    ),
    preuveRetenue: reprise.evidence?.kind ?? null,
    empreinteDuFichier: apresMigration.digest,
    empreinteDuClair: apresMigration.digestClair,
    clairIdentiqueAvantMigration: apresMigration.digestClair === avantMigration.digest,
  });

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
  // DATÉE AVANT le boot, et c'est tout l'intérêt : un boot qui n'aboutit jamais — le mode de #165 —
  // ne laisserait aucune trace si la chronologie n'était écrite qu'après lui. Cette ligne-ci dit que
  // le runtime était armé, le réseau coupé, et le volume dans l'état que l'étape précédente décrit.
  chronologie.etape("boot à froid ARMÉ, réseau coupé", {
    arme: arm.ready,
    reseau: controleReseau,
    budgetBootMs: BUDGET_BOOT_MS,
    empreinteDuVolume: apresMigration.digest,
  });
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
  chronologie.etape("boot à froid ABOUTI sur le volume migré", {
    santeMs: bootApresMigration.healthMilliseconds,
    conforming: bootApresMigration.conforming,
    instantaneUtilise: bootApresMigration.usedSnapshot,
  });
  expect(controleReseau, "le réseau était bien coupé pendant le boot").toMatch(/^hors-ligne/);
  expect(bootApresMigration.online, "le boot à froid a tourné réseau coupé").toBe(false);
  expect(bootApresMigration.usedSnapshot, "aucun instantané mémoire").toBe(false);
  expect(bootApresMigration.failures, "aucune panne de support absorbée").toEqual([]);
  expect(bootApresMigration.conforming, "invariant conforme après migration").toBe(true);
  // #91 — la charge que le guest a présentée au journal sur le volume MIGRÉ, confrontée au plafond.
  // C'est la charge DÉPOSÉE que `PLAFOND_CHARGE_OCTETS` borne, pas la génération validée : `deposer`
  // refuse dès que ce qui s'est accumulé depuis le dernier point de contrôle dépasse le plafond,
  // qu'une barrière soit passée ou non. La première ligne garantit que le relevé a eu lieu ; sans
  // elle, un `null` rendrait la seconde vraie sans rien mesurer.
  expect(bootApresMigration.generation.deposeeMaxOctets, "relevé effectué").not.toBeNull();
  expect(
    bootApresMigration.generation.deposeeMaxOctets,
    "charge sous le plafond après migration",
  ).toBeLessThan(PLAFOND_CHARGE_OCTETS);
  // #181 — LA RACINE INITIALE DE LA MIGRATION, constatée sur le vrai support. La migration l'a
  // écrite avant d'inscrire son manifeste ; ce boot-ci n'a donc rien à écrire de plus et rien à
  // autoriser : une racine fait autorité, la fraîcheur est vérifiée, aucun engagement n'est
  // consulté. Sans cette assertion, la moitié « migration » de la règle « aucun volume légitime
  // n'est sans racine » ne serait mesurée nulle part sur un OPFS réel (revue de format de la
  // PR #184, constat 3).
  expect(bootApresMigration.recuperation, "le rapport d'ouverture est publié").not.toBeNull();
  expect(
    bootApresMigration.recuperation.racineInitiale,
    "la migration a déjà daté : ce boot n'écrit aucune racine",
  ).toBe(false);
  expect(
    bootApresMigration.recuperation.motifDeLaRacine,
    "aucune autorisation n'a été demandée",
  ).toBeNull();
  expect(
    bootApresMigration.recuperation.voisinIgnore,
    "aucun voisin d'engagement n'a jamais existé sur ce volume",
  ).toBe(false);
  expect(
    bootApresMigration.recuperation.fraicheurRegion,
    "la région d'authentification concorde avec ce que la racine de migration scelle",
  ).toBe("verifiee");
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
    formats: { avant: 1, apres: MANIFEST_FORMAT_VERSION },
    empreinteVolume: {
      // Le FICHIER change — la migration v2 → v3 réécrit tout —, et c'est le CLAIR qui est conservé.
      avantMigration: avantMigration.digest,
      apresMigration: apresMigration.digest,
      clairApresMigration: apresMigration.digestClair,
    },
    sauvegarde: { octets: sauvegarde.archiveLength, digest: sauvegarde.digest },
    migration: {
      reprise: reprise.resumed,
      preuve: reprise.evidence,
      // DEUX durées, parce qu'elles ne disent pas la même chose : la tentative coupée à
      // mi-conversion a déplacé la charge et scellé la moitié des secteurs ; la reprise relit chaque
      // secteur pour savoir lequel est déjà converti, puis finit le reste.
      dureeCoupeeMs: coupeeEnConversion.durationMs ?? null,
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
    // #91 — ce que le guest a demandé au journal sur le volume MIGRÉ. `deposee` est la grandeur que
    // le plafond borne ; `validee` est la plus grande génération scellée par une barrière.
    generation: {
      deposeeMaxOctets: bootApresMigration.generation.deposeeMaxOctets,
      valideeMaxOctets: bootApresMigration.generation.valideeMaxOctets,
      plafondOctets: PLAFOND_CHARGE_OCTETS,
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

test("PALIER v3 — un volume v3 RÉEL est SAUVEGARDÉ par le runtime v4, puis migré, et Rails relit son clair", async ({
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "migration-volume-versionne.spec.mjs");

  // **Ce que ce scénario ajoute, et pourquoi le précédent ne le couvrait pas.** La chaîne
  // v1 → v2 → v3 → v4 s'y joue en UNE session : son palier v3 n'est qu'un état intermédiaire, il
  // n'a jamais de manifeste inscrit, jamais de journal de naissance, et personne ne le présente
  // jamais à un runtime v4 comme point de départ. La revue de la PR #186 l'a dit en une phrase qui
  // vaut pour tous les paliers : **une chaîne éprouvée de bout en bout ne prouve rien de chacun de
  // ses paliers pris comme point de départ.**
  //
  // Or c'est exactement la situation d'un utilisateur : son volume EST un v3, il l'a depuis des
  // mois, et le premier geste que la politique de version lui impose est une SAUVEGARDE VÉRIFIÉE
  // (ADR 0011). Avant la tranche T2b, le runtime v4 ne savait pas en produire une — l'export
  // ouvrait tout volume par l'ouvreur v4, qui refuse un en-tête v3. **Un v3 n'était donc migrable
  // qu'à condition de détenir déjà une archive faite par le runtime précédent.** C'est le
  // livrable 0 de la tranche, et c'est ce que ce scénario mesure sur un vrai volume OPFS de
  // 512 Mio, avec une vraie application Rails au bout.
  //
  // **Ce que ce scénario NE fait PAS, et il faut le dire ici.** Il n'ÉCRIT pas dans le volume
  // pendant qu'il est en v3, parce que ce runtime n'a aucun chemin d'écriture v3 : un v3 n'est
  // jamais produit que par migration, et `openOpfsVolume` refuse son en-tête. Le rejeu d'une
  // charge ACQUITTÉE restée dans le journal d'un v3 — la partie du livrable qui dépend de cette
  // écriture — est donc mesuré en UNITAIRE, sur un v3 également réel :
  // `tests/unit/vm-migration-source-v3.test.mjs` › « l'archive d'un v3 se RESTAURE et se migre ».
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  const appDiskBytes = disqueApp.byteSize;
  const appDiskUrl = `/artifacts/reference-image/${manifeste.boot.hdb}`;

  const descripteurV1 = {
    formatVersion: 1,
    runtime: { version: paquet.version, artifact: null },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  /**
   * Le descripteur d'un volume qui EST en v3 : c'est lui que l'export doit savoir ouvrir.
   *
   * `minWriter` y est EXIGÉ, là où le descripteur v1 s'en passe : le manifeste de format 3 déclare
   * le plus ancien écrivain admis plutôt que de le laisser deviner (ADR 0009). Une archive de v3
   * sans lui est refusée à la composition, et c'est bien ce qu'on veut.
   */
  const descripteurV3 = {
    formatVersion: FORMAT_VOLUME_V3,
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const descripteurCourant = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const configBoot = {
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
    manifest: descripteurCourant,
    expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
    bootTimeoutMs: BUDGET_BOOT_MS,
  };

  async function nouvellePage() {
    const page = await context.newPage();
    await page.goto(`${E2E_ORIGIN_A}/vm/reference.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return page;
  }
  const courir = (page, payload) =>
    page.evaluate((p) => globalThis.bancReprise.executer(p), payload);
  async function courirEnEchec(page, payload) {
    try {
      await courir(page, payload);
    } catch (erreur) {
      return erreur.message;
    }
    return null;
  }

  // 1. UN VOLUME v1, puis sa sauvegarde — le chemin ordinaire, joué jusqu'au palier seulement.
  let page = await nouvellePage();
  await courir(page, {
    phase: "prepare",
    volume: VOLUME_V3,
    appDiskBytes,
    appDiskUrl,
    manifest: descripteurV1,
  });
  const clairInitial = await courir(page, { phase: "digest-volume", volume: VOLUME_V3 });
  await courir(page, {
    phase: "export",
    volume: VOLUME_V3,
    archive: SAUVEGARDE_V1_DU_V3,
    manifest: descripteurV1,
  });
  await page.close();

  // 2. LA CHAÎNE S'ARRÊTE À v3. `toVersion` borne la migration au palier : le volume porte alors un
  //    manifeste v3 INSCRIT, un en-tête `VLTVOL03`, une région scellée et un journal de naissance.
  //    C'est un v3 en service, pas un état de passage.
  page = await nouvellePage();
  const versV3 = await courir(page, {
    phase: "migrate",
    volume: VOLUME_V3,
    manifest: descripteurCourant,
    backupArchive: SAUVEGARDE_V1_DU_V3,
    toVersion: FORMAT_VOLUME_V3,
  });
  const auPalier = await courir(page, { phase: "inspect-volume", volume: VOLUME_V3 });
  await page.close();
  expect(versV3.ok, `la migration vers le palier a échoué : ${versV3.error?.message ?? ""}`).toBe(
    true,
  );
  expect(versV3.toVersion, "la chaîne s'arrête à la version demandée").toBe(FORMAT_VOLUME_V3);
  expect(versV3.steps.length, "deux pas : v1 → v2, puis v2 → v3").toBe(FORMAT_VOLUME_V3 - 1);
  expect(auPalier.manifestPresent, "le v3 porte un manifeste INSCRIT").toBe(true);
  expect(
    auPalier.migrationJournalPresent,
    "la migration est finie : aucun journal ne subsiste",
  ).toBe(false);
  // Que le manifeste inscrit dise bien TROIS est prouvé au point 5, et par le produit lui-même : la
  // migration suivante rend `fromVersion` en le LISANT. Le constater ici demanderait une phase
  // d'inspection qui ne sert qu'à cela.
  expect(auPalier.generationJournalPresent, "un v3 légitime porte une racine, donc un .gen").toBe(
    true,
  );

  // 3. TÉMOIN — ce v3 ne s'ouvre PAS en écriture : c'est la raison d'être du livrable. Sans une
  //    sauvegarde, l'utilisateur est au point mort.
  page = await nouvellePage();
  const refusDuBootV3 = await courirEnEchec(page, {
    ...configBoot,
    phase: "resume",
    volume: VOLUME_V3,
  });
  await page.close();
  expect(refusDuBootV3, "un v3 ne s'ouvre pas en écriture sous le runtime v4").toMatch(
    /VAULT_MANIFEST_MIGRATION_REQUIRED/,
  );

  // 4. LIVRABLE 0 — LE RUNTIME v4 SAUVEGARDE CE v3. C'est le geste qui n'existait pas : l'export
  //    passe par le lecteur de la migration, seul chemin du dépôt qui sache ouvrir un v3.
  page = await nouvellePage();
  const debutExport = Date.now();
  const archiveDuV3 = await courir(page, {
    phase: "export",
    volume: VOLUME_V3,
    archive: ARCHIVE_DU_V3,
    manifest: descripteurV3,
  });
  const dureeExportMs = Date.now() - debutExport;
  const verification = await courir(page, {
    phase: "verify-export",
    archive: ARCHIVE_DU_V3,
    manifest: descripteurV3,
  });
  await page.close();
  expect(archiveDuV3.digest, "l'archive d'un v3 porte le FICHIER v3, pas un clair").not.toBe(
    clairInitial.digest,
  );
  expect(verification.ok, `l'archive du v3 ne se vérifie pas : ${verification.error ?? ""}`).toBe(
    true,
  );

  // 5. MIGRATION v3 → v4, avec cette archive-là pour preuve. C'est la boucle qui se referme : la
  //    sauvegarde qu'exige le pas destructif a été produite par le runtime qui l'exige.
  page = await nouvellePage();
  const versV4 = await courir(page, {
    phase: "migrate",
    volume: VOLUME_V3,
    manifest: descripteurCourant,
    backupArchive: ARCHIVE_DU_V3,
  });
  const apresV4 = await courir(page, { phase: "digest-volume", volume: VOLUME_V3 });
  await page.close();
  expect(versV4.ok, `la migration v3 → v4 a échoué : ${versV4.error?.message ?? ""}`).toBe(true);
  expect(versV4.fromVersion, "elle part bien du palier v3").toBe(FORMAT_VOLUME_V3);
  expect(versV4.toVersion).toBe(MANIFEST_FORMAT_VERSION);
  expect(versV4.steps.length, "un seul pas restait").toBe(1);
  expect(versV4.evidence.kind, "et sa preuve est l'archive faite par le runtime v4").toBe(
    "sauvegarde-verifiee",
  );
  expect(apresV4.digestClair, "le CLAIR a traversé les trois pas sans changer d'un octet").toBe(
    clairInitial.digest,
  );

  // 6. BOOT À FROID — Rails retrouve son invariant sur le volume qui a fait tout le trajet.
  page = await nouvellePage();
  const arm = await courir(page, { ...configBoot, phase: "resume-arm", volume: VOLUME_V3 });
  expect(arm.ready).toBe(true);
  await context.setOffline(true);
  let bootFinal;
  try {
    bootFinal = await courir(page, { phase: "resume-fire" });
  } finally {
    await context.setOffline(false);
  }
  await page.close();
  expect(bootFinal.online, "le boot a tourné réseau coupé").toBe(false);
  expect(bootFinal.conforming, "invariant Rails conforme après le trajet v1 → v3 → v4").toBe(true);
  expect(bootFinal.observedRecordId).toBe(contrat.record.id);
  expect(bootFinal.observedAttachmentSha256).toBe(contrat.attachment.sha256);

  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    volumeOctets: appDiskBytes,
    palier: {
      versV3DureeMs: versV3.durationMs ?? null,
      exportDuV3DureeMs: dureeExportMs,
      archiveOctets: archiveDuV3.archiveLength,
      versV4DureeMs: versV4.durationMs ?? null,
      bootMs: bootFinal.healthMilliseconds,
    },
    refusDuBootV3,
    clair: { avant: clairInitial.digest, apres: apresV4.digestClair },
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "migration-palier-v3.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("migration-palier-v3.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});
