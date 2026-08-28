// Scénario de SORTIE du MVP (#7, `VAULT-PERSIST-001`) : « retrouver une mutation Rails après
// fermeture complète ». C'est le test du niveau le plus élevé du dépôt — une vraie application Rails
// boote sur un disque OPFS, on ferme tout, on coupe le réseau, et un boot à froid la retrouve.
//
// Deux règles le gouvernent, comme `tests/vm/reference-boot.test.mjs` :
//
//   1. il ne réussit jamais sans avoir booté. Si les artefacts de l'image #5 ou de v86 sont absents,
//      il se déclare `skipped` avec la raison exacte et la commande à lancer ;
//   2. tout ce qu'il affirme est mesuré dans le navigateur, dans un Worker qui porte v86 et le
//      handle OPFS exclusif (ADR 0002). La coquille — et donc ce test — ne reçoit que du JSON.
//
// Ce que le scénario prouve et ses limites sont décrits dans `docs/testing.md`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLAFOND_CHARGE_OCTETS } from "../../src/vm/generation-store.mjs";
import { expect, test } from "./contexte-persistant.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(RACINE, "package.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_V86 = join(RACINE, "vendor", "v86", "artefacts");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** Volume applicatif de la reprise et volume témoin — nommés pour ne pas heurter les autres suites. */
const VOLUME = "vault-app-reprise-e2e";
const VOLUME_VIDE = "vault-vide-e2e";

/** Nombre de reprises à froid mesurées. L'issue en exige au moins trois. */
const REPRISES = 3;

/** Budget d'un boot Rails. Généreux : l'i386 émulé démarre en dizaines de secondes. */
const BUDGET_BOOT_MS = 300_000;
/** Budget court du témoin négatif : il ne doit PAS servir l'invariant, on borne l'attente. */
const BUDGET_TEMOIN_MS = 150_000;

/** Décrit ce qui manque pour booter, ou `null` si tout est là. */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return `manifeste absent : « npm run image:build » (puis « npm run vm:fetch »)`;
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const artefactsImage = manifeste.artifacts.map((a) => a.name);
  const absentsImage = artefactsImage.filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
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

/** Rang le plus proche : conservateur sur peu d'essais (p95 = maximum sur trois). */
function percentile(valeurs, p) {
  const triees = [...valeurs].sort((a, b) => a - b);
  const rang = Math.max(0, Math.ceil((p / 100) * triees.length) - 1);
  return triees[rang];
}

const raison = raisonDIndisponibilite();

/**
 * Hygiène tenue MÊME quand le scénario échoue (#73). Le volume applicatif pèse un demi-gigaoctet et
 * n'était retiré NULLE PART : il restait dans le profil du navigateur pour toute la suite du job, au
 * détriment des scénarios suivants — qui en écrivent chacun autant, sur deux origines pour la
 * restauration. Le témoin négatif est retiré ici aussi, plutôt qu'à la seule ligne du test.
 *
 * Un défaut de nettoyage ne doit jamais masquer l'échec qu'il suit : il est journalisé, PAS relancé —
 * mais il est aussi ATTACHÉ au rapport, faute de quoi la panne de l'hygiène ne se verrait que dans
 * un `stderr` noyé au milieu d'un job de deux heures, pendant qu'un demi-gibioctet resterait dans le
 * profil.
 */
test.afterEach(async ({ context }, testInfo) => {
  if (raison !== null) return;
  const page = await context.newPage();
  try {
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    for (const nom of [VOLUME, VOLUME_VIDE]) {
      await page.evaluate(
        (n) => globalThis.bancReprise.executer({ phase: "cleanup", volume: n }),
        nom,
      );
    }
  } catch (erreur) {
    process.stderr.write(`[hygiène] reprise : ${erreur.message}\n`);
    await testInfo.attach("hygiene-echouee.txt", {
      body: `Nettoyage de ${VOLUME} et ${VOLUME_VIDE} en échec : ${erreur.message}`,
      contentType: "text/plain",
    });
  } finally {
    await page.close();
  }
});

test("une mutation Rails et sa pièce jointe survivent à la fermeture complète et à un boot à froid hors ligne", async ({
  context,
  baseURL,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  test.setTimeout(1_500_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);
  const appDiskBytes = disqueApp.byteSize;
  const appDiskUrl = `/artifacts/reference-image/${manifeste.boot.hdb}`;

  const runtime = {
    lib: "/vendor/v86/artefacts/libv86.mjs",
    wasm: "/vendor/v86/artefacts/v86.wasm",
    bios: `/artifacts/reference-image/${manifeste.boot.bios}`,
    vgaBios: `/artifacts/reference-image/${manifeste.boot.vgaBios}`,
    kernel: `/artifacts/reference-image/${manifeste.boot.kernel}`,
    initrd: `/artifacts/reference-image/${manifeste.boot.initrd}`,
    rootfs: `/artifacts/reference-image/${manifeste.boot.hda}`,
  };
  // Identités portées par le manifeste du volume (#10). Depuis #12, un volume ne s'ouvre en écriture
  // que s'il porte un manifeste compatible (`SEC-UPDATE-001`) : la préparation l'inscrit, et chaque
  // boot le vérifie.
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const descripteurManifeste = {
    // `minWriter` est exigé par le format v2 (#13) : le volume DÉCLARE le plus ancien runtime
    // autorisé à l'écrire. Le banc déclare la version en cours, le choix le plus strict.
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

  /** Ouvre une page NEUVE de la coquille et instrumente ses requêtes. Fermer la page ferme aussi
   * son Worker et rend le handle OPFS : c'est le « fermer page + Worker + handles » de l'issue. */
  async function nouvellePage() {
    const page = await context.newPage();
    const requetes = [];
    page.on("request", (r) => requetes.push(r.url()));
    const erreurs = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return { page, requetes, erreurs };
  }

  const courir = (page, payload) =>
    page.evaluate((p) => globalThis.bancReprise.executer(p), payload);

  // 1. Profil et volume NEUFS : le disque applicatif de #5 est écrit dans OPFS, en flux.
  let session = await nouvellePage();
  const prepare = await courir(session.page, {
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes,
    appDiskUrl,
    manifest: descripteurManifeste,
  });
  await session.page.close();
  expect(prepare.bytesWritten, "le disque applicatif entier est écrit dans OPFS").toBe(
    appDiskBytes,
  );

  // 2. Boot À CHAUD : Rails démarre sur le disque OPFS et y écrit ; ses barrières atteignent OPFS.
  session = await nouvellePage();
  const live = await courir(session.page, { ...configBoot, phase: "live" });
  await session.page.close();
  await testInfo.attach("live.json", {
    body: JSON.stringify(live, null, 2),
    contentType: "application/json",
  });
  expect(live.failures, "aucune panne de support absorbée").toEqual([]);
  expect(live.conforming, "invariant conforme à chaud").toBe(true);
  expect(live.observedRecordId).toBe(contrat.record.id);
  expect(live.observedAttachmentSha256).toBe(contrat.attachment.sha256);
  // Des écritures de Rails ont réellement atteint OPFS...
  expect(live.counts.write, "Rails a écrit des blocs dans OPFS").toBeGreaterThan(0);
  // ...et au moins une barrière de durabilité a été acquittée APRÈS le flush OPFS (#14) : c'est
  // cette barrière — pas les écritures non flushées — qui garantit la persistance (`SEC-DURABLE-001`).
  expect(live.counts.flush, "une barrière fsync a atteint OPFS").toBeGreaterThan(0);
  expect(live.counts["flush-ack"], "chaque barrière est acquittée").toBe(live.counts.flush);
  // La boucle d'ordonnancement qui a fait tourner CE boot est celle de Vault, et v86 l'a bien
  // empruntée (#74). Sans cette exigence, la mesure de reprise pourrait être publiée sur une
  // horloge et le produit tourner sur une autre.
  expect(live.boucleOrdonnancement.source, "boucle d'ordonnancement de Vault").toMatch(/^vault/);
  expect(live.boucleOrdonnancement.appels, "v86 emprunte la boucle posée").toBeGreaterThan(0);

  // 3. Reprises À FROID, hors ligne, depuis le MÊME volume OPFS. Au moins trois.
  const reprises = [];
  let derniereMemoire = null;
  for (let essai = 0; essai < REPRISES; essai += 1) {
    session = await nouvellePage();

    // `resume-arm` acquiert le runtime PENDANT que la page est en ligne.
    const arm = await courir(session.page, { ...configBoot, phase: "resume-arm" });
    expect(arm.ready).toBe(true);

    // On COUPE LE RÉSEAU, puis on vérifie qu'il l'est vraiment : une requête sortante doit échouer.
    await context.setOffline(true);
    const controleReseau = await session.page.evaluate(() =>
      fetch("/vm/reference.html", { cache: "no-store" })
        .then(() => "en-ligne")
        .catch((e) => `hors-ligne:${e.name}`),
    );

    let resume;
    try {
      // `resume-fire` boote à froid et vérifie l'invariant SANS aucun accès réseau (runtime en
      // mémoire, disque applicatif dans OPFS).
      resume = await courir(session.page, { phase: "resume-fire" });
      derniereMemoire = await session.page.evaluate(() => globalThis.bancReprise.memoire());
    } finally {
      await context.setOffline(false);
    }

    // Preuve d'absence de RÉSEAU dans la reprise : le disque applicatif n'est jamais retéléchargé,
    // et toute requête de la page reste sur la coquille locale (l'application installée).
    expect(session.requetes.some((u) => u.includes(manifeste.boot.hdb))).toBe(false);
    for (const url of session.requetes) {
      expect(url.startsWith(baseURL), `requête inattendue hors coquille : ${url}`).toBe(true);
    }
    await session.page.close();

    expect(controleReseau, "le réseau était bien coupé pendant la reprise").toMatch(/^hors-ligne/);
    expect(resume.conforming, `reprise ${essai + 1} conforme`).toBe(true);
    expect(resume.online, "le boot à froid a tourné réseau coupé").toBe(false);
    // Preuve d'absence de SNAPSHOT : aucun instantané mémoire n'est chargé, le boot est complet.
    expect(resume.usedSnapshot).toBe(false);
    expect(resume.healthMilliseconds, "un vrai boot à froid, pas une restauration").toBeGreaterThan(
      10_000,
    );
    // Preuve de persistance byte-exacte : la pièce jointe ActiveStorage (4096 octets, digest connu)
    // écrite par Rails et rendue durable est retrouvée à l'identique après le boot à froid.
    expect(resume.observedRecordId).toBe(contrat.record.id);
    expect(resume.observedAttachmentSha256).toBe(contrat.attachment.sha256);
    reprises.push(resume);
  }

  // 4. Témoin négatif : un volume OPFS VIDE ne peut PAS rendre l'invariant. La reprise dépend donc
  //    du CONTENU d'OPFS, non du réseau ni de l'artefact resservi.
  session = await nouvellePage();
  // Le volume témoin est IDENTIFIÉ comme les autres — manifeste voisin compris — mais VIDE. Sans
  // cela, le boot serait refusé pour absence de manifeste (#12) et le témoin ne dirait plus rien
  // du contenu d'OPFS, qui est pourtant ce qu'il doit prouver.
  await courir(session.page, {
    phase: "prepare-empty",
    volume: VOLUME_VIDE,
    appDiskBytes,
    manifest: descripteurManifeste,
  });
  let echecTemoin = null;
  try {
    await courir(session.page, {
      ...configBoot,
      phase: "resume",
      volume: VOLUME_VIDE,
      bootTimeoutMs: BUDGET_TEMOIN_MS,
    });
  } catch (erreur) {
    echecTemoin = erreur.message;
  }
  await courir(session.page, { phase: "cleanup", volume: VOLUME_VIDE }).catch(() => {});
  await session.page.close();
  expect(echecTemoin, "un volume OPFS vide ne doit jamais rendre l'invariant").not.toBeNull();

  // #91 — LA DEMANDE RÉELLE DU GUEST, boot à chaud et reprises à froid.
  //
  // C'est `deposeeMaxOctets` qui est confronté au plafond, et pas la plus grande génération validée :
  // `deposer` refuse quand la charge DÉPOSÉE depuis le dernier point de contrôle dépasse le plafond,
  // barrière ou pas. La distinction se mesure sur ce boot même — Rails y écrit des dizaines de fois
  // pour une seule barrière, si bien que la charge présentée au plafond dépasse de loin la plus
  // grande génération scellée. Asserter la seconde reviendrait à garder la mauvaise grandeur.
  //
  // La première ligne vérifie que le relevé a EU LIEU : un `null` — volume ouvert sans magasin de
  // génération — rendrait la seconde vraie sans rien mesurer.
  for (const [rang, boot] of [live, ...reprises].entries()) {
    expect(boot.generation.deposeeMaxOctets, `boot ${rang} — relevé effectué`).not.toBeNull();
    expect(boot.generation.valideeMaxOctets, `boot ${rang} — relevé effectué`).not.toBeNull();
    // LA PROPRIÉTÉ : aucun boot de l'image de référence n'approche le plafond. Le jour où cette
    // ligne rougit, c'est `VAULT_STORAGE_GENERATION_OVERFLOW` qui attend le guest — système de
    // fichiers en lecture seule — et le plafond qui doit être revu.
    expect(boot.generation.deposeeMaxOctets, `boot ${rang} — charge sous le plafond`).toBeLessThan(
      PLAFOND_CHARGE_OCTETS,
    );
  }

  // #19 — LA FRAÎCHEUR, de bout en bout (ADR 0019).
  //
  // Chaque REPRISE à froid rouvre un volume qu'un point de contrôle a rangé, donc un volume dont la
  // dernière racine scelle une empreinte de sa région d'authentification. Cette empreinte est
  // confrontée à la région relue AVANT que le moindre secteur ne soit lu — avant que Rails ne monte
  // quoi que ce soit. Ces deux lignes établissent que le contrôle a bien EU LIEU sur le vrai
  // support, avec une vraie application : `verifiee` n'est pas `migree`, et surtout pas
  // `non-fournie`.
  //
  // Le boot À CHAUD est exclu, et il faut dire pourquoi : le volume vient d'être versé depuis
  // l'image de référence par le chemin NON transactionnel, si bien qu'aucune racine ne fait encore
  // autorité à son ouverture. Il n'y a alors rien à confronter, et le rapport le dit
  // (`sans-racine`) au lieu de prétendre une vérification.
  for (const [rang, boot] of reprises.entries()) {
    expect(boot.recuperation, `reprise ${rang} — rapport d'ouverture publié`).not.toBeNull();
    expect(boot.recuperation.fraicheurRegion, `reprise ${rang} — région confrontée`).toBe(
      "verifiee",
    );
    // Et le TÉMOIN a bien été écrit par le boot précédent puis relu par celui-ci : sans lui, le
    // plancher de séquence d'une reprise à froid serait `null`, et le rejeu ne serait plus refusé
    // qu'à l'intérieur d'une session.
    expect(
      boot.recuperation.temoinSequence,
      `reprise ${rang} — témoin de séquence relu`,
    ).toBeGreaterThan(0);
  }

  // Mesures publiées (docs/quality-attributes.md : cible reprise p95 ≤ 60 s).
  const reprisesMs = reprises.map((r) => r.healthMilliseconds);
  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    scenario: {
      reprises: REPRISES,
      volumeOctets: reprises[0]?.volumeBytes ?? null,
      disqueAppOctets: appDiskBytes,
      runtimeTransfereOctets: live.transferredBytes,
      memoireVmOctets: configBoot.memoryBytes,
    },
    live: {
      healthMs: live.healthMilliseconds,
      ecrituresOpfs: live.counts.write,
      barrieres: live.counts.flush,
      barrieresAcquittees: live.counts["flush-ack"],
      timeline: live.timeline,
      rythme: live.rythme,
      boucleOrdonnancement: live.boucleOrdonnancement,
    },
    repriseMs: {
      essais: reprisesMs,
      p50: percentile(reprisesMs, 50),
      p95: percentile(reprisesMs, 95),
    },
    // Décomposition du temps de reprise (#60) : où passent les secondes, essai par essai. Chaque
    // durée est réellement observée ; un jalon non atteint reste `null` plutôt qu'inventé.
    repriseTimeline: reprises.map((r) => r.timeline),
    // Rythme de la boucle d'ordonnancement de v86, essai par essai. Publié parce que remplacer
    // cette boucle (#74) change le rythme de TOUT l'émulateur : sans cette colonne, une reprise
    // plus lente ne se distinguerait pas d'un guest qui a eu davantage à faire.
    repriseRythme: reprises.map((r) => r.rythme),
    repriseBoucle: reprises.map((r) => r.boucleOrdonnancement),
    memoireTasJs: derniereMemoire,
    // LA PLUS GRANDE GÉNÉRATION que l'image de référence produit, en octets — boot à chaud puis
    // chaque reprise à froid. C'est la mesure qui manquait pour calibrer `PLAFOND_CHARGE_OCTETS` sur
    // la demande RÉELLE du guest au lieu du seul budget de récupération (#91, ADR 0014 § Limites).
    generation: {
      // Ce que le plafond borne : la charge déposée depuis un point de contrôle, barrière ou pas.
      deposeeMaxOctets: {
        live: live.generation.deposeeMaxOctets,
        reprises: reprises.map((r) => r.generation.deposeeMaxOctets),
      },
      // La plus grande GÉNÉRATION, c'est-à-dire ce qu'une barrière a scellé. Publiée à côté parce
      // que l'écart entre les deux dit à quelle fréquence Rails franchit réellement une barrière.
      valideeMaxOctets: {
        live: live.generation.valideeMaxOctets,
        reprises: reprises.map((r) => r.generation.valideeMaxOctets),
      },
      plafondOctets: PLAFOND_CHARGE_OCTETS,
    },
    cible: { repriseP95Ms: 60_000 },
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "reprise-boot-froid.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("reprise-boot-froid.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });

  // La cible de 60 s est un gate documenté : un dépassement n'échoue pas ici (il exigera un ADR),
  // mais l'absence totale de mesure, elle, serait un échec.
  expect(reprisesMs.length).toBe(REPRISES);
});
