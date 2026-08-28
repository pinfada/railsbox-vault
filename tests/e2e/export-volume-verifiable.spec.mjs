// Preuve BOUT EN BOUT de l'export vérifiable (#11, `VAULT-PORT-001`). Une donnée Rails vit sur un
// volume OPFS réel (le disque applicatif de l'image #5, qui porte l'invariant durable créé par
// `bin/vault-fixture`) ; on l'EXPORTE en flux vers une archive OPFS, puis on la VÉRIFIE — empreinte
// de contenu recalculée, manifeste validé par #10 — et l'on éprouve les REFUS typés sur une archive
// altérée puis tronquée.
//
// Deux règles le gouvernent, comme `tests/e2e/reprise-mutation-boot-froid.spec.mjs` :
//
//   1. il ne réussit jamais sans les artefacts : sans l'image #5, il se déclare `skipped` avec la
//      commande à lancer ;
//   2. tout ce qu'il affirme est mesuré dans un Worker qui porte le handle OPFS exclusif (ADR 0002) ;
//      la coquille — et donc ce test — ne reçoit que du JSON.
//
// Ce que le scénario prouve et ses limites sont décrits dans `docs/testing.md`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "./contexte-persistant.mjs";
import { MANIFEST_FORMAT_VERSION } from "../../src/vm/volume-manifest.mjs";
import { tailleDeFichier } from "../../src/vm/volume-chiffre-format.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** Volume applicatif à exporter et fichier d'archive — nommés pour ne pas heurter les autres suites. */
const VOLUME = "vault-export-e2e";
const ARCHIVE = "vault-archive-e2e";

/** Budget d'écriture puis d'export/vérification d'un disque de 512 Mio dans OPFS. Généreux. */
const BUDGET_MS = 600_000;

/** Décrit ce qui manque pour exporter, ou `null` si tout est là. Seule l'image #5 est requise (pas v86). */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return `manifeste absent : « npm run image:build »`;
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const disque = manifeste.boot.hdb;
  if (!existsSync(join(DOSSIER_IMAGE, disque))) {
    return `disque applicatif de l'image #5 absent (${disque}) : « npm run image:build »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

/**
 * Hygiène tenue MÊME quand le scénario échoue (#73). Le volume et son archive pèsent un demi-
 * gigaoctet chacun ; jusqu'ici ils n'étaient retirés qu'à la dernière ligne du test, si bien qu'un
 * échec en plein milieu laissait un gigaoctet dans le profil du navigateur pour toute la suite du
 * job — et faisait tomber les scénarios suivants pour une raison qui n'était pas la leur.
 *
 * C'est le même crochet que `restauration-inter-origine.spec.mjs` et
 * `migration-volume-versionne.spec.mjs`. Un défaut de nettoyage ne doit jamais masquer l'échec
 * qu'il suit : il est journalisé, PAS relancé — mais il est aussi ATTACHÉ au rapport, faute de quoi
 * la panne de l'hygiène ne se verrait que dans un `stderr` noyé au milieu d'un job de deux heures,
 * pendant qu'un gibioctet resterait dans le profil.
 */
test.afterEach(async ({ context }, testInfo) => {
  if (raison !== null) return;
  const page = await context.newPage();
  try {
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    for (const nom of [VOLUME, ARCHIVE]) {
      await page.evaluate(
        (n) => globalThis.bancReprise.executer({ phase: "cleanup", volume: n }),
        nom,
      );
    }
  } catch (erreur) {
    process.stderr.write(`[hygiène] export : ${erreur.message}\n`);
    await testInfo.attach("hygiene-echouee.txt", {
      body: `Nettoyage de ${VOLUME} et ${ARCHIVE} en échec : ${erreur.message}`,
      contentType: "text/plain",
    });
  } finally {
    await page.close();
  }
});

test("un volume OPFS est exporté en archive vérifiable, et une archive altérée ou tronquée est refusée", async ({
  context,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  test.setTimeout(BUDGET_MS);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  const appDiskBytes = disqueApp.byteSize;
  // Taille du FICHIER que ce volume occupe au format courant : c'est elle que l'archive porte.
  const fichierAttendu = tailleDeFichier({
    formatVersion: MANIFEST_FORMAT_VERSION,
    tailleLogique: appDiskBytes,
  });
  const appDiskUrl = `/artifacts/reference-image/${manifeste.boot.hdb}`;

  const manifestDescriptor = {
    // `minWriter` est exigé par le format v2 (#13) : le volume DÉCLARE le plus ancien runtime
    // autorisé à l'écrire. Le banc déclare la version en cours, le choix le plus strict.
    runtime: { version: paquet.version, artifact: null, minWriter: paquet.version },
    app: { id: contrat.application.id, version: contrat.application.version },
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

  // 1. Donnée Rails sur OPFS : le disque applicatif de #5 (invariant compris) est écrit en flux.
  let page = await nouvellePage();
  const prepare = await courir(page, {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes,
    appDiskUrl,
    manifest: manifestDescriptor,
  });
  await page.close();
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    appDiskBytes,
  );

  // 2. EXPORT en flux vers une archive OPFS distincte.
  page = await nouvellePage();
  const exporte = await courir(page, {
    phase: "export",
    volume: VOLUME,
    archive: ARCHIVE,
    manifest: manifestDescriptor,
  });
  await page.close();
  await testInfo.attach("export.json", {
    body: JSON.stringify(exporte, null, 2),
    contentType: "application/json",
  });

  // L'empreinte de contenu est calculée et inscrite dans le manifeste (#10 : identity.digest).
  expect(exporte.digest, "une empreinte de contenu est calculée").toMatch(/^[0-9a-f]{64}$/);
  expect(exporte.manifestDigest, "l'empreinte est inscrite dans le manifeste").toBe(exporte.digest);
  // Le contenu d'une archive est le FICHIER du volume, pas sa taille logique : en v3 il porte en
  // plus l'en-tête et la région d'authentification (ADR 0016, décision 7). L'attendu est DÉRIVÉ du
  // format, jamais relevé de ce que l'export a rendu — sinon l'épreuve se contenterait de répéter
  // ce que le produit affirme.
  expect(exporte.contentLength).toBe(fichierAttendu);
  // Point cohérent déclaré : lecture via le handle exclusif de #6.
  expect(exporte.consistency.kind).toBe("handle-exclusif");
  // Archive ≤ 2× la taille logique (docs/quality-attributes.md).
  expect(exporte.archiveLength, "archive ≤ 2× la taille logique").toBeLessThanOrEqual(
    2 * appDiskBytes,
  );
  expect(exporte.headerLength, "en-tête de quelques centaines d'octets").toBeLessThan(2048);
  // Surmémoire de streaming bornée (≤ 64 Mio) : la plus grande lecture ne dépasse pas le bloc de 4 Mio.
  expect(exporte.maxBlockBytes, "aucune lecture ne demande tout le volume").toBeLessThanOrEqual(
    exporte.blockBytes,
  );
  expect(exporte.blockBytes).toBeLessThanOrEqual(64 * 1024 * 1024);

  // 3. VÉRIFICATION : empreinte recalculée = empreinte inscrite, manifeste valide.
  page = await nouvellePage();
  const verifie = await courir(page, { phase: "verify-export", archive: ARCHIVE, mutate: "none" });
  await page.close();
  expect(verifie.ok, `vérification en échec : ${verifie.error?.message ?? ""}`).toBe(true);
  expect(verifie.error).toBeNull();
  // L'empreinte recalculée depuis l'archive = celle calculée à l'export = celle du manifeste : la
  // copie est byte-exacte, donc l'invariant écrit par Rails est capturé fidèlement.
  expect(verifie.contentDigest).toBe(exporte.digest);
  expect(verifie.manifestDigest).toBe(exporte.digest);
  expect(verifie.contentLength).toBe(fichierAttendu);
  expect(verifie.maxBlockBytes, "vérification aussi bornée en mémoire").toBeLessThanOrEqual(
    exporte.blockBytes,
  );

  // 4. Archive ALTÉRÉE : un octet de contenu retourné → refus typé, jamais un succès silencieux.
  page = await nouvellePage();
  const altere = await courir(page, { phase: "verify-export", archive: ARCHIVE, mutate: "tamper" });
  await page.close();
  expect(altere.ok, "une archive altérée ne doit jamais se vérifier").toBe(false);
  expect(altere.error?.code).toBe("VAULT_ARCHIVE_DIGEST_MISMATCH");

  // 5. Archive TRONQUÉE : réexport (l'altération précédente a corrompu le fichier), puis troncature.
  page = await nouvellePage();
  await courir(page, {
    phase: "export",
    volume: VOLUME,
    archive: ARCHIVE,
    manifest: manifestDescriptor,
  });
  await page.close();

  page = await nouvellePage();
  const tronque = await courir(page, {
    phase: "verify-export",
    archive: ARCHIVE,
    mutate: "truncate",
  });
  await page.close();
  expect(tronque.ok, "une archive tronquée ne doit jamais se vérifier").toBe(false);
  expect(tronque.error?.code).toBe("VAULT_ARCHIVE_TRUNCATED");

  // L'hygiène est tenue par le crochet `afterEach` : un échec en cours de scénario ne doit pas
  // laisser un gigaoctet derrière lui (#73).

  // Mesures publiées.
  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    volumeOctets: appDiskBytes,
    // CRÉATION du volume v3, sur OPFS RÉEL et à 512 Mio. Les deux durées sont séparées parce
    // qu'elles ne disent pas la même chose : le scellement initial est le coût du FORMAT — « un
    // secteur jamais écrit n'existe pas en v3 », donc l'ouverture d'un volume neuf scelle tous ses
    // secteurs —, le versement est celui du disque. `docs/quality-attributes.md` les reprend telles
    // quelles. Ce ne sont pas des assertions : un seuil posé sans mesure opposable serait une
    // promesse, pas un budget.
    creation: {
      scellementMs: prepare.sealMs ?? null,
      versementMs: prepare.fillMs ?? null,
    },
    // Budget de stockage encadrant l'export (#73). Il n'est pas une assertion : il est la mesure qui
    // permet de dire, après coup, s'il restait de la place — au lieu de le supposer.
    stockage: exporte.storage,
    archive: {
      octets: exporte.archiveLength,
      enteteOctets: exporte.headerLength,
      ratioSurLogique: Number((exporte.archiveLength / appDiskBytes).toFixed(4)),
      digest: exporte.digest,
      coherence: exporte.consistency,
    },
    surmemoire: {
      blocOctets: exporte.blockBytes,
      plusGrandeLectureExport: exporte.maxBlockBytes,
      plusGrandeLectureVerification: verifie.maxBlockBytes,
      budgetOctets: 64 * 1024 * 1024,
    },
    refus: { altere: altere.error, tronque: tronque.error },
    cible: { archiveMaxRatio: 2, surmemoireMaxOctets: 64 * 1024 * 1024 },
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "export-verifiable.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("export-verifiable.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});
