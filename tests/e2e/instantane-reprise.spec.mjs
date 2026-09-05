// REPRISE PAR INSTANTANÉ, de bout en bout (#65, ADR 0024).
//
// Le scénario enchaîne les deux chemins et les CONFRONTE :
//
//   1. profil et volume NEUFS, disque applicatif écrit dans OPFS ;
//   2. boot à chaud qui CAPTURE un instantané au point de contrôle de sa fermeture ;
//   3. fermeture complète — page, Worker, handles ;
//   4. réouverture PAR INSTANTANÉ : Rails repart de la mémoire capturée, et l'invariant SQLite
//      (ADR 0004) est relu ;
//   5. un boot COMPLET sur le même volume : Rails écrit et franchit des barrières, la génération
//      avance et la région change — l'instantané devient périmé ;
//   6. réouverture suivante : l'instantané est ÉCARTÉ, RETIRÉ, et le boot à froid s'exécute — et
//      l'invariant est relu une quatrième fois.
//
// **Pourquoi l'invalidation vient d'un BOOT et non d'une requête** : l'application de référence a
// exactement deux routes, `health` et `invariant`, toutes deux en lecture (ADR 0004). La seule
// mutation Rails que cette fixture sache produire est celle qu'un DÉMARRAGE écrit — journaux, base
// SQLite, fichiers temporaires —, et c'est déjà ce que `reprise-mutation-boot-froid.spec.mjs`
// appelle une mutation. Une session reprise par instantané, elle, ne redémarre pas Rails : elle ne
// mute donc presque rien, et c'est une PROPRIÉTÉ de la reprise, pas un manque du scénario.
//
// **Ce que le scénario compare byte-à-byte**, et il compare DEUX choses :
//
//  - le VERDICT ENTIER de l'invariant applicatif rendu par Rails, entre les trois boots. Il porte
//    l'identifiant de l'enregistrement et le SHA-256 de la pièce jointe de 4096 octets — une
//    empreinte byte-exacte de ce que le volume a rendu ;
//  - le CLAIR DU VOLUME avant et après la reprise. L'égalité vaut parce qu'elle est ENCADRÉE : une
//    session reprise ne redémarre pas Rails, donc n'écrit rien — ce que le scénario CONSTATE
//    (`counts.write === 0`) au lieu de le supposer. Restaurer un état mémoire ne touche pas le
//    volume, et c'est ce qu'« un instantané n'est jamais une source de vérité » veut dire.
//
// **Ce qu'il ne compare PAS** : le clair du volume entre DEUX BOOTS COMPLETS. Il ne peut pas — un
// boot Rails réel écrit ses journaux, ses fichiers temporaires et son journal SQLite à chaque
// démarrage, si bien que deux boots partant du même volume en laissent deux états différents, sans
// que l'instantané y soit pour rien. La limite est écrite dans `docs/quality-attributes.md` plutôt
// que gommée par une assertion qui ne mesurerait rien.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INSTANTANE_ERROR_CODES } from "../../src/vm/instantane/instantane-errors.mjs";
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
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** Volume de ce scénario. Nommé à part : il ne doit heurter aucune autre suite. */
const VOLUME = "vault-app-instantane-e2e";

const BUDGET_BOOT_MS = 300_000;

/**
 * Plancher d'un VRAI boot à froid, en millisecondes.
 *
 * Il ne sert pas à mesurer : il sert à ce qu'un boot à froid ne puisse pas passer pour une reprise,
 * ni l'inverse. Le relevé Node du 4 septembre donne 86 s de boot à froid contre 1,5 s de reprise :
 * dix secondes séparent les deux chemins de plus d'un ordre de grandeur, des deux côtés.
 */
const PLANCHER_BOOT_FROID_MS = 10_000;

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

/** Hygiène tenue MÊME quand le scénario échoue : le volume pèse un demi-gibioctet, l'instantané 250 Mio. */
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
    process.stderr.write(`[hygiène] instantané : ${erreur.message}\n`);
    await testInfo.attach("hygiene-echouee.txt", {
      body: `Nettoyage de ${VOLUME} en échec : ${erreur.message}`,
      contentType: "text/plain",
    });
  } finally {
    await page.close();
  }
});

test("un instantané rend Rails en une fraction du boot à froid, puis est écarté dès qu'il périme", async ({
  context,
}, testInfo) => {
  test.skip(raison !== null, raison ?? "");
  test.setTimeout(1_500_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((a) => a.name === manifeste.boot.hdb);

  const runtime = {
    lib: ADRESSES_V86.get("libv86.mjs"),
    wasm: ADRESSES_V86.get("v86.wasm"),
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

  /** Ouvre une page NEUVE. La fermer ferme son Worker et rend le handle OPFS. */
  async function nouvellePage() {
    const page = await context.newPage();
    await page.goto("/vm/reference.html", { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, {
      timeout: 20_000,
    });
    return page;
  }

  /** Exécute UNE phase dans un Worker NEUF, puis ferme tout. C'est la fermeture complète du scénario. */
  async function phase(payload) {
    const page = await nouvellePage();
    try {
      return await page.evaluate((p) => globalThis.bancReprise.executer(p), payload);
    } finally {
      await page.close();
    }
  }

  // 1. Profil et volume NEUFS.
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

  // 2. Boot à chaud qui CAPTURE. La capture a lieu après l'invariant, au point de contrôle.
  const capturant = await phase({ ...configBoot, phase: "live-capturer" });
  await testInfo.attach("live-capturer.json", {
    body: JSON.stringify(capturant, null, 2),
    contentType: "application/json",
  });
  expect(capturant.failures, "aucune panne de support absorbée").toEqual([]);
  expect(capturant.conforming, "invariant conforme au boot qui capture").toBe(true);
  expect(capturant.capture, "une capture a bien été tentée").not.toBeNull();
  expect(capturant.capture.motif, "la capture n'a pas de motif de refus").toBeNull();
  expect(capturant.capture.capture, "la capture a abouti").toBe(true);
  expect(capturant.capture.violations, "aucune E/S pendant la quiescence").toBe(0);
  expect(capturant.capture.octets, "l'instantané pèse quelque chose").toBeGreaterThan(1_000_000);

  // 3. Le voisin est là, et le volume aussi.
  const apresCapture = await phase({ phase: "inspect-volume", volume: VOLUME });
  expect(apresCapture.instantanePresent, "le voisin « .instantane » est écrit").toBe(true);
  expect(apresCapture.instantaneSize).toBe(capturant.capture.octets);
  const clairApresCapture = await phase({ phase: "digest-volume", volume: VOLUME });

  // 4. RÉOUVERTURE PAR INSTANTANÉ, dans un Worker neuf, après fermeture complète.
  const reprise = await phase({ ...configBoot, phase: "resume-instantane" });
  await testInfo.attach("resume-instantane.json", {
    body: JSON.stringify(reprise, null, 2),
    contentType: "application/json",
  });
  expect(reprise.instantane.motif, "l'instantané n'a été écarté par aucun motif").toBeNull();
  expect(reprise.usedSnapshot, "la reprise est bien passée par l'instantané").toBe(true);
  expect(reprise.failures, "aucune panne de support pendant la reprise").toEqual([]);
  expect(reprise.conforming, "invariant conforme après restauration").toBe(true);
  expect(
    reprise.healthMilliseconds,
    "une reprise par instantané n'est pas un boot à froid déguisé",
  ).toBeLessThan(PLANCHER_BOOT_FROID_MS);

  // ÉQUIVALENCE : le verdict ENTIER de l'invariant, byte-à-byte entre les deux chemins.
  expect(reprise.invariantVerdict, "l'invariant SQLite est IDENTIQUE des deux côtés").toEqual(
    capturant.invariantVerdict,
  );
  expect(reprise.observedRecordId).toBe(contrat.record.id);
  expect(reprise.observedAttachmentSha256).toBe(contrat.attachment.sha256);

  const clairApresReprise = await phase({ phase: "digest-volume", volume: VOLUME });

  // ÉQUIVALENCE BYTE-À-BYTE DU CLAIR DU VOLUME. Elle vaut parce qu'elle est ENCADRÉE : une session
  // reprise par instantané ne redémarre pas Rails, donc n'écrit rien — ce que l'assertion suivante
  // constate plutôt que de le supposer. Sous cette condition, le clair du volume relu par la lecture
  // autorisée est le MÊME, octet pour octet, avant et après la reprise : la restauration d'un état
  // mémoire ne touche pas le volume, et c'est exactement ce qu'un « instantané qui n'est jamais une
  // source de vérité » doit vouloir dire.
  expect(reprise.counts.write ?? 0, "une session reprise n'écrit rien dans le volume").toBe(0);
  expect(
    clairApresReprise.digestClair,
    "le CLAIR du volume est identique, octet pour octet, avant et après la reprise",
  ).toBe(clairApresCapture.digestClair);
  expect(
    clairApresReprise.digest,
    "et le FICHIER lui-même n'a pas bougé non plus : aucun secteur rescellé",
  ).toBe(clairApresCapture.digest);

  // 5. Un boot COMPLET sur le même volume : Rails redémarre, écrit et franchit des barrières.
  //    C'est la mutation qui périme l'instantané — la génération avance, la région change.
  const mutant = await phase({ ...configBoot, phase: "live" });
  await testInfo.attach("live-mutant.json", {
    body: JSON.stringify(mutant, null, 2),
    contentType: "application/json",
  });
  expect(mutant.conforming, "le boot qui mute est conforme").toBe(true);
  expect(mutant.counts.write, "Rails a écrit dans le volume").toBeGreaterThan(0);
  expect(mutant.counts["flush-ack"], "et au moins une barrière a été acquittée").toBeGreaterThan(0);

  // 6. La réouverture suivante doit ÉCARTER l'instantané, le RETIRER, et booter à froid.
  const froid = await phase({ ...configBoot, phase: "resume-instantane" });
  await testInfo.attach("resume-froid.json", {
    body: JSON.stringify(froid, null, 2),
    contentType: "application/json",
  });
  expect(froid.usedSnapshot, "un instantané périmé n'est JAMAIS utilisé").toBe(false);
  // Le motif est celui d'une ÉCRITURE, pas celui d'un recul : la GÉNÉRATION a avancé si Rails a
  // franchi une barrière pendant la session précédente, l'EMPREINTE DE RÉGION a changé si un point
  // de contrôle a rangé quoi que ce soit — et la génération est confrontée la première. La séquence,
  // elle, n'écarte QUE si elle recule (ADR 0024, décision 4) : elle avance à chaque ouverture, y
  // compris celles qui ne font que relire le volume.
  expect(
    [INSTANTANE_ERROR_CODES.ecartGeneration, INSTANTANE_ERROR_CODES.ecartRegion],
    "et le motif est nommé, pas tu",
  ).toContain(froid.instantane.motif);
  expect(
    froid.healthMilliseconds,
    "l'instantané écarté, c'est un vrai boot à froid qui s'exécute",
  ).toBeGreaterThan(PLANCHER_BOOT_FROID_MS);
  expect(froid.conforming, "les données sont là après le boot à froid").toBe(true);
  expect(froid.invariantVerdict, "l'invariant survit aux deux chemins").toEqual(
    capturant.invariantVerdict,
  );

  // 6. Le fichier a bien été RETIRÉ : écarter sans retirer laisserait 250 Mio de RAM invitée d'une
  //    session révolue à côté d'un volume qui a avancé.
  const apresRejet = await phase({ phase: "inspect-volume", volume: VOLUME });
  expect(apresRejet.instantanePresent, "un instantané écarté est RETIRÉ du support").toBe(false);

  const rapport = {
    mesureLe: new Date().toISOString(),
    volume: VOLUME,
    instantane: {
      octets: capturant.capture.octets,
      etatV86Octets: capturant.capture.etatV86Octets,
      deltaRootfsOctets: capturant.capture.deltaRootfsOctets,
      captureMs: capturant.capture.millisecondes,
      ouvertureMs: reprise.instantane.millisecondes,
      sequenceCapturee: capturant.capture.sequence,
      generationCapturee: capturant.capture.generation,
      empreinteRegionCapturee: capturant.capture.empreinteRegion,
      empreinteRegionALaReprise: reprise.instantane.empreinteRegion,
    },
    reprise: {
      santeMs: reprise.healthMilliseconds,
      bootMs: reprise.bootMilliseconds,
      usedSnapshot: reprise.usedSnapshot,
      // Ce que la session REPRISE a écrit : Rails ne redémarre pas, donc il ne mute presque rien.
      // Publié pour que la propriété se lise, plutôt que d'être supposée.
      ecrituresDuGuest: reprise.counts.write ?? 0,
      barrieresAcquittees: reprise.counts["flush-ack"] ?? 0,
    },
    bootMutant: {
      santeMs: mutant.healthMilliseconds,
      ecrituresDuGuest: mutant.counts.write,
      barrieresAcquittees: mutant.counts["flush-ack"],
    },
    bootFroid: {
      santeMs: froid.healthMilliseconds,
      motifDuRejet: froid.instantane.motif,
    },
    // PUBLIÉES, jamais comparées entre elles : un boot Rails réel écrit à chaque démarrage, et deux
    // chemins ne peuvent pas laisser le même clair. Voir l'en-tête de ce fichier.
    clairDuVolume: {
      apresCapture: clairApresCapture.digestClair,
      apresReprise: clairApresReprise.digestClair,
    },
    equivalenceInvariant: {
      capturant: capturant.invariantVerdict,
      reprise: reprise.invariantVerdict,
      bootFroid: froid.invariantVerdict,
    },
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "instantane-reprise.json"),
    `${JSON.stringify(rapport, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("instantane-reprise.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });
});
