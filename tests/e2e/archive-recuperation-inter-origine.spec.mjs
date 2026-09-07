// Preuve BOUT EN BOUT de la TRANCHE 3 de #23 (#149, `SEC-RECOVERY-001`, `VAULT-PORT-001`).
//
// C'est le scénario de fermeture de la Definition of Ready, en un seul enchaînement : un volume
// CHIFFRÉ portant un moyen de récupération sur l'origine A, exporté, transporté, restauré sur
// l'origine B, OUVERT PAR LE CODE, complété d'une phrase secrète, puis booté par Rails jusqu'à
// l'invariant.
//
// Avant l'ADR 0027, la dernière étape était impossible : l'archive portait le fichier du volume
// sans la capacité de l'ouvrir (ADR 0020, décision 6), et un volume chiffré restauré ailleurs était
// un volume que personne n'ouvrait. Ce fichier est ce qui rend la révision vérifiable.
//
// Ce qui distingue ce scénario de `restauration-inter-origine.spec.mjs`, qui reste : celui-là
// prouve la restauration d'un volume et la reprise de son invariant, sous la clé de HARNAIS ;
// celui-ci prouve que la CAPACITÉ D'OUVRIR voyage, et que la clé de harnais n'est jamais présentée
// sur B. Les deux origines sont réelles au sens du navigateur, et OPFS est cloisonné par origine :
// tout ce que B retrouve ne peut venir que de l'archive.
//
// Deux règles le gouvernent, comme les autres scénarios de `tests/e2e/` :
//
//   1. il ne réussit jamais sans les artefacts : sans l'image #5 ou v86, il se déclare `skipped`
//      avec la commande à lancer ;
//   2. tout ce qu'il affirme est mesuré dans un Worker qui porte le handle OPFS exclusif et v86
//      (ADR 0002) ; la coquille — et donc ce test — ne reçoit que du JSON.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { MANIFEST_FORMAT_VERSION } from "../../src/vm/volume-manifest.mjs";
import { tailleDeFichier } from "../../src/vm/volume-chiffre-format.mjs";
import { PAGE_OCTETS } from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";

import { E2E_ORIGIN_A, E2E_ORIGIN_B } from "../../playwright.e2e.config.mjs";
import { adressesServiesV86, artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADRESSES_V86 = adressesServiesV86();
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");

/** Volumes et archive, nommés pour ne heurter aucune autre suite. */
const VOLUME_A = "vault-recuperation-a-e2e";
const ARCHIVE = "vault-archive-recuperation-e2e";
const VOLUME_B = "vault-recuperation-b-e2e";

/** Budget d'un boot Rails. Généreux : l'i386 émulé démarre en dizaines de secondes. */
const BUDGET_BOOT_MS = 300_000;

/** La phrase que l'utilisateur se redonne sur l'appareil neuf. Publique : c'est une épreuve. */
const PHRASE_NEUVE = "chaise longue au bord du gave 41";

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
 * Hygiène des DEUX origines, tenue même quand le scénario échoue : chaque volume pèse un demi-
 * gigaoctet, et un échec en plein milieu en laisserait plusieurs dans les profils de navigateur.
 */
test.afterEach(async ({ context }) => {
  if (raison !== null) return;
  for (const [origine, noms] of [
    [E2E_ORIGIN_A, [VOLUME_A, ARCHIVE]],
    [E2E_ORIGIN_B, [VOLUME_B]],
  ]) {
    const page = await context.newPage();
    try {
      await page.goto(`${origine}/vm/reference.html`, { waitUntil: "load" });
      await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
        timeout: 20_000,
      });
      for (const nom of noms) {
        await page.evaluate(
          (n) => globalThis.bancReprise.executer({ phase: "cleanup", volume: n }),
          nom,
        );
      }
    } catch (erreur) {
      process.stderr.write(`[hygiène] ${origine} : ${erreur.message}\n`);
    } finally {
      await page.close();
    }
  }
});

test("un volume chiffré exporté avec son moyen de récupération s'OUVRE PAR LE CODE sur une autre origine, et Rails y reprend", async ({
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "archive-recuperation-inter-origine.spec.mjs");
  test.setTimeout(1_800_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  const appDiskBytes = disqueApp.byteSize;
  const fichierAttendu = tailleDeFichier({
    formatVersion: MANIFEST_FORMAT_VERSION,
    tailleLogique: appDiskBytes,
  });
  const appDiskUrl = `/artifacts/reference-image/${manifeste.boot.hdb}`;

  const descripteurManifeste = {
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
  };
  const attentes = { app: { id: contrat.application.id } };
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
    manifest: descripteurManifeste,
    expected: { recordId: contrat.record.id, attachmentSha256: contrat.attachment.sha256 },
    bootTimeoutMs: BUDGET_BOOT_MS,
  };

  async function nouvellePage(origine) {
    const page = await context.newPage();
    await page.goto(`${origine}/vm/reference.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return page;
  }
  const courir = (page, payload) =>
    page.evaluate((p) => globalThis.bancReprise.executer(p), payload);
  async function importer(page, chemin, payload) {
    await page.setInputFiles("#archive-entrante", chemin);
    return page.evaluate((p) => globalThis.bancReprise.executerAvecFichier(p), payload);
  }

  // === ORIGINE A ================================================================================
  // 1. Le volume CHIFFRÉ est posé depuis l'image #5, son enveloppe est créée sous la clé du
  //    harnais, et un MOYEN DE RÉCUPÉRATION y est ajouté. Le code est rendu UNE fois.
  let page = await nouvellePage(E2E_ORIGIN_A);
  const prepare = await courir(page, {
    phase: "prepare",
    volume: VOLUME_A,
    appDiskBytes,
    appDiskUrl,
    manifest: descripteurManifeste,
  });
  const enveloppe = await courir(page, { phase: "enveloppe-creer", volume: VOLUME_A });
  const moyen = await courir(page, { phase: "recuperation-creer", volume: VOLUME_A });
  await page.close();
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    appDiskBytes,
  );
  expect(enveloppe.version).toBe(1);
  expect(moyen.typeKek, "le moyen de récupération est bien un emplacement de type 4").toBe(
    TYPES_KEK.recuperation,
  );
  expect(moyen.version, "la pose du moyen fait avancer la version de l'enveloppe").toBe(2);
  const CODE = moyen.code;
  expect(CODE, "le banc rend le code une fois, comme le produit").toMatch(
    /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/,
  );

  // 2. MUTATION RAILS sur A, sur un volume ouvert PAR L'ENVELOPPE — pas par le jeton du harnais.
  page = await nouvellePage(E2E_ORIGIN_A);
  const live = await courir(page, {
    ...configBoot,
    phase: "live",
    volume: VOLUME_A,
    deverrouillerPar: "initiale",
  });
  await page.close();
  expect(live.failures, "aucune panne de support absorbée sur A").toEqual([]);
  expect(live.conforming, "invariant conforme à chaud sur A").toBe(true);
  expect(live.counts.write, "Rails a écrit des blocs dans l'OPFS de A").toBeGreaterThan(0);

  // 3. EXPORT qui EMPORTE l'enveloppe de récupération (ADR 0027, décision 2).
  page = await nouvellePage(E2E_ORIGIN_A);
  const exporte = await courir(page, {
    phase: "export",
    volume: VOLUME_A,
    archive: ARCHIVE,
    manifest: descripteurManifeste,
    emporterLaRecuperation: true,
  });
  await page.close();
  expect(exporte.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(exporte.enveloppe, "l'archive emporte une enveloppe").not.toBeNull();
  expect(exporte.enveloppe.length, "et cette enveloppe est UNE page de 8192 octets").toBe(
    PAGE_OCTETS,
  );
  expect(exporte.enveloppe.slots, "qui ne porte qu'un emplacement").toBe(1);
  expect(exporte.enveloppe.envelopeVersion, "à la version COURANTE de l'enveloppe").toBe(
    moyen.version,
  );
  // La MESURE que la tranche annonce : une archive v2 coûte exactement une page de plus.
  expect(exporte.archiveLength, "taille de l'archive = 12 + H + N + R, avec R = 8192").toBe(
    12 + exporte.headerLength + exporte.contentLength + PAGE_OCTETS,
  );

  // 4. TRANSFERT — le fait du test, pas du produit : l'archive descend sur le disque de l'hôte.
  page = await nouvellePage(E2E_ORIGIN_A);
  const cheminArchive = testInfo.outputPath("volume-avec-recuperation.rbvault");
  const [telechargement] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate((nom) => globalThis.bancReprise.telecharger(nom), ARCHIVE),
  ]);
  await telechargement.saveAs(cheminArchive);
  expect(await page.evaluate(() => globalThis.bancReprise.libererArchive())).toBe(true);
  await page.close();
  expect(statSync(cheminArchive).size, "l'archive transférée est complète").toBe(
    exporte.archiveLength,
  );

  // SONDE — le CODE ne quitte pas l'appareil avec l'archive. C'est la propriété qui reste de la
  // décision 6 de l'ADR 0020, et elle se mesure ici sur les octets réels qui traversent l'hôte.
  const octetsDeLArchive = readFileSync(cheminArchive);
  for (const forme of [CODE, CODE.replaceAll("-", ""), CODE.toLowerCase()]) {
    expect(
      octetsDeLArchive.includes(Buffer.from(forme, "utf8")),
      `le code de récupération est dans l'archive sous la forme « ${forme} »`,
    ).toBe(false);
  }

  // === ORIGINE B ================================================================================
  // 5. ISOLATION : l'OPFS de B ignore tout de A. Sans cette preuve, l'import ne prouverait rien.
  page = await nouvellePage(E2E_ORIGIN_B);
  const avantImport = await courir(page, { phase: "inspect-volume", volume: VOLUME_A });
  const cibleAvant = await courir(page, { phase: "inspect-volume", volume: VOLUME_B });
  await page.close();
  expect(avantImport.present, "le volume de A est absent de l'OPFS de B").toBe(false);
  expect(cibleAvant.present, "la cible de restauration n'existe pas encore sur B").toBe(false);

  // 6. TÉMOIN NÉGATIF de l'ANCRE — une feuille qui note une version PLUS RÉCENTE que l'archive
  //    exige un consentement nommé, et refuse avant toute mutation (ADR 0027, décision 3).
  page = await nouvellePage(E2E_ORIGIN_B);
  const refusAncre = await importer(page, cheminArchive, {
    phase: "import",
    volume: VOLUME_B,
    expectations: attentes,
    versionMinimale: exporte.enveloppe.envelopeVersion + 1,
  });
  const cibleApresRefus = await courir(page, { phase: "inspect-volume", volume: VOLUME_B });
  await page.close();
  expect(refusAncre.ok, "une sauvegarde antérieure à la feuille ne passe pas en silence").toBe(
    false,
  );
  expect(refusAncre.error?.code).toBe("VAULT_IMPORT_CONSENTEMENT_REQUIS");
  expect(cibleApresRefus.present, "et rien n'est écrit sur la cible").toBe(false);

  // 7. IMPORT — l'archive est vérifiée AVANT toute mutation, le contenu restauré et relu, PUIS
  //    l'enveloppe posée, PUIS le manifeste inscrit.
  page = await nouvellePage(E2E_ORIGIN_B);
  const importe = await importer(page, cheminArchive, {
    phase: "import",
    volume: VOLUME_B,
    expectations: attentes,
  });
  const cibleApres = await courir(page, { phase: "inspect-volume", volume: VOLUME_B });
  await page.close();
  await testInfo.attach("import.json", {
    body: JSON.stringify(importe, null, 2),
    contentType: "application/json",
  });
  expect(importe.ok, `restauration en échec : ${importe.error?.message ?? ""}`).toBe(true);
  expect(importe.contentDigest).toBe(exporte.digest);
  expect(importe.verifiedDigest).toBe(exporte.digest);
  expect(importe.volumeSize).toBe(fichierAttendu);
  expect(importe.enveloppe, "le volume restauré a reçu son enveloppe").not.toBeNull();
  expect(importe.enveloppe.digest).toBe(exporte.enveloppe.digest);
  expect(
    importe.nouvelleReference,
    "la version restaurée devient la référence à re-noter sur la feuille",
  ).toBe(exporte.enveloppe.envelopeVersion);
  expect(cibleApres.manifestPresent, "le volume restauré porte son manifeste").toBe(true);

  // 8. L'OUVERTURE PAR LE CODE. C'est la phrase de la tranche, exécutée sur une origine qui n'a
  //    jamais vu la clé de harnais.
  page = await nouvellePage(E2E_ORIGIN_B);
  const parLeCode = await courir(page, {
    phase: "recuperation-ouvrir",
    volume: VOLUME_B,
    code: CODE,
  });
  // Et l'ANCRE mord aussi ICI : sous une feuille plus récente, la même page est refusée.
  const sousLaFeuille = await courir(page, {
    phase: "recuperation-ouvrir",
    volume: VOLUME_B,
    code: CODE,
    versionMinimale: parLeCode.version + 1,
  });
  const sonde = await courir(page, { phase: "sonde-du-code", volume: VOLUME_B, code: CODE });
  await page.close();
  expect(parLeCode.ouverte, `le code n'ouvre pas : ${parLeCode.message ?? ""}`).toBe(true);
  expect(parLeCode.version).toBe(exporte.enveloppe.envelopeVersion);
  expect(sousLaFeuille.ouverte).toBe(false);
  expect(sousLaFeuille.code).toBe("VAULT_ENVELOPPE_REJEU");
  // SONDE DE NON-PERSISTANCE : le code n'a été déposé dans aucun fichier de l'origine B.
  expect(sonde.trouves, "le code de récupération s'est déposé sur le support").toEqual([]);
  expect(
    sonde.examines.filter((entree) => entree.present).length,
    "la sonde doit avoir vraiment lu des fichiers, sans quoi son verdict ne dit rien",
  ).toBeGreaterThanOrEqual(2);

  // 9. L'utilisateur SE REDONNE UN MOYEN QUOTIDIEN : une phrase secrète, ajoutée en présentant la
  //    KEK du code. C'est le cycle de #147, joué sur l'appareil neuf.
  page = await nouvellePage(E2E_ORIGIN_B);
  const phrase = await courir(page, {
    phase: "recuperation-ajouter-phrase",
    volume: VOLUME_B,
    code: CODE,
    phrase: PHRASE_NEUVE,
  });
  await page.close();
  expect(phrase.version, "l'ajout fait avancer la version de l'enveloppe restaurée").toBe(
    parLeCode.version + 1,
  );
  expect(
    [...phrase.emplacements].sort(),
    "l'enveloppe porte désormais le code ET la phrase",
  ).toEqual([TYPES_KEK.phrase, TYPES_KEK.recuperation].sort());

  // 10. BOOT RAILS sur B, sur le volume restauré, ouvert PAR LE CODE. L'invariant est retrouvé.
  page = await nouvellePage(E2E_ORIGIN_B);
  const reprise = await courir(page, {
    ...configBoot,
    phase: "resume",
    volume: VOLUME_B,
    deverrouillerParCode: CODE,
  });
  await page.close();
  await testInfo.attach("reprise-par-le-code.json", {
    body: JSON.stringify(reprise, null, 2),
    contentType: "application/json",
  });
  expect(reprise.failures, "aucune panne de support sur B").toEqual([]);
  expect(reprise.usedSnapshot, "aucun instantané mémoire").toBe(false);
  expect(reprise.conforming, "invariant conforme après ouverture par le CODE").toBe(true);
  expect(reprise.observedRecordId).toBe(contrat.record.id);
  expect(reprise.observedAttachmentSha256).toBe(contrat.attachment.sha256);
  expect(
    reprise.enveloppe?.kek,
    "le volume a bien été ouvert par le code, et non par une clé de harnais",
  ).toBe("code-de-recuperation");

  await testInfo.attach("mesures-archive-recuperation.json", {
    body: JSON.stringify(
      {
        mesureLe: new Date().toISOString(),
        origines: { export: E2E_ORIGIN_A, restauration: E2E_ORIGIN_B },
        archive: {
          octets: exporte.archiveLength,
          enTeteOctets: exporte.headerLength,
          contenuOctets: exporte.contentLength,
          recuperationOctets: exporte.enveloppe.length,
          empreinteDeLEnveloppe: exporte.enveloppe.digest,
        },
        enveloppe: {
          versionEmportee: exporte.enveloppe.envelopeVersion,
          versionApresPhrase: phrase.version,
        },
        sondeDuCode: sonde,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
