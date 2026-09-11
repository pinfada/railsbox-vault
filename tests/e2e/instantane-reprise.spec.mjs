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
//    session reprise ne redémarre pas Rails, donc elle n'ACQUITTE aucune barrière et ne VALIDE
//    aucune génération — ce que le scénario CONSTATE au lieu de le supposer. Restaurer un état
//    mémoire ne touche pas le volume, et c'est ce qu'« un instantané n'est jamais une source de
//    vérité » veut dire.
//
// **L'encadrement a CHANGÉ le 11 septembre 2026, et c'est #152.** Il portait sur `counts.write === 0`
// — « le guest n'a émis aucune écriture ». Trois occurrences ont réfuté cette borne sans que rien de
// promis ait cassé : un noyau repris écrit à sa guise (journal ext4, cache de pages rejoué, horloge
// rattrapée), et `counts.write` compte des APPELS du guest, pas des mutations de l'état validé. La
// borne est désormais sur les grandeurs que le protocole tient — barrière acquittée, génération
// validée, empreintes du fichier et du clair — et `counts.write` est PUBLIÉ comme mesure sans seuil.
// Motif complet dans l'ADR 0024 (note du 11 septembre 2026) et dans `docs/testing.md`.
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
import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
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
  chronologie,
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "instantane-reprise.spec.mjs");
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
  chronologie.etape("préparation", { octets: prepare.bytesWritten });

  // 2. Boot à chaud qui CAPTURE. La capture a lieu après l'invariant, au point de contrôle.
  const capturant = await phase({ ...configBoot, phase: "live-capturer" });
  chronologie.etape("boot à chaud qui capture", {
    santeMs: capturant.healthMilliseconds,
    instantaneOctets: capturant.capture?.octets ?? null,
    motifDeRefus: capturant.capture?.motif ?? null,
  });
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
  chronologie.etape("réouverture par instantané", {
    utilise: reprise.usedSnapshot,
    motifDeRejet: reprise.instantane?.motif ?? null,
    santeMs: reprise.healthMilliseconds,
    ecrituresDuGuest: reprise.counts?.write ?? 0,
    barrieresAcquittees: reprise.counts?.["flush-ack"] ?? 0,
    octetsValides: reprise.generation?.valideeMaxOctets ?? null,
  });
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
  const apresReprise = await phase({ phase: "inspect-volume", volume: VOLUME });

  // ÉQUIVALENCE BYTE-À-BYTE DU CLAIR DU VOLUME, et ce qui l'ENCADRE (#152).
  //
  // **L'assertion « `counts.write === 0` » a été RETIRÉE d'ici, et il faut dire pourquoi.** Elle
  // encadrait l'équivalence par « une session reprise ne redémarre pas Rails, donc n'écrit rien ».
  // La première moitié est vraie ; la seconde ne l'est pas, et trois runs l'ont montré —
  // 34283481251 et 34395610743 (tentatives 1) ont relevé `counts.write = 21`, exactement 21 les
  // deux fois, sur un code qui ne touchait pas ce scénario. Ce que ce compteur compte, ce sont les
  // APPELS D'ÉCRITURE du guest interceptés par le pont, et un noyau Linux repris en produit à sa
  // guise : le rejeu du cache de pages, une minuterie de journal ext4, l'horloge que v86 rattrape
  // depuis le CMOS de l'hôte (limite 4 de l'ADR 0024). Aucun de ces gestes n'est borné à zéro par
  // construction, et aucun ne change ce que l'ADR 0024 promet.
  //
  // Ce que l'ADR promet est l'ÉTAT VALIDÉ, et c'est lui qui est éprouvé ici, par trois grandeurs
  // qui, elles, sont bornées par le protocole et non par la chance :
  //
  //   a. AUCUNE BARRIÈRE ACQUITTÉE, donc aucune génération validée. « La génération validée
  //      n'avance qu'à une barrière ACQUITTÉE du guest » (ADR 0024, décision 4) : sans barrière, la
  //      garde de génération de la réouverture suivante ne peut pas bouger, quoi que le guest ait
  //      demandé au pont ;
  //   b. RIEN DE SCELLÉ : la plus grande génération validée de la session vaut zéro octet ;
  //   c. et l'ÉTAT VALIDÉ LUI-MÊME est identique à l'octet, fichier ET clair — la mesure qui ferme
  //      la question, puisqu'un secteur rangé se verrait là.
  //
  // `counts.write` reste MESURÉ et PUBLIÉ dans le relevé, sans seuil : une grandeur qu'on cesse de
  // borner et qu'on cesse de publier est une grandeur qu'on cesse de voir.
  expect(
    reprise.counts["flush-ack"] ?? 0,
    "une session reprise n'ACQUITTE aucune barrière : rien ne peut donc être validé",
  ).toBe(0);
  expect(
    reprise.generation.valideeMaxOctets,
    "et rien n'a été scellé : la plus grande génération validée de la session est nulle",
  ).toBe(0);
  expect(
    clairApresReprise.digestClair,
    "le CLAIR du volume est identique, octet pour octet, avant et après la reprise",
  ).toBe(clairApresCapture.digestClair);
  expect(
    clairApresReprise.digest,
    "et le FICHIER lui-même n'a pas bougé non plus : aucun secteur rescellé",
  ).toBe(clairApresCapture.digest);
  // Le JOURNAL DE GÉNÉRATION, troisième voisin du volume, est MESURÉ ici et PUBLIÉ — jamais
  // confronté, et il faut dire pourquoi. Sa taille APRÈS la session ne dit pas ce que la session a
  // validé : `close()` tronque le journal à sa zone d'enregistrements, si bien qu'il rend 8 192
  // octets quoi qu'il ait porté — mesuré à 8 192 avant comme après une session ayant DÉPOSÉ
  // 143 924 octets. Une assertion dessus éprouverait la troncature de la fermeture, pas l'invariant.
  // Ce que l'ADR 0024 promet est ailleurs — l'état VALIDÉ —, et le volume lui-même, mesuré à
  // l'octet juste au-dessus, est le seul endroit où il vit.

  // 5. Un boot COMPLET sur le même volume : Rails redémarre, écrit et franchit des barrières.
  //    C'est la mutation qui périme l'instantané — la génération avance, la région change.
  const mutant = await phase({ ...configBoot, phase: "live" });
  chronologie.etape("boot complet qui périme l'instantané", {
    santeMs: mutant.healthMilliseconds,
    ecrituresDuGuest: mutant.counts?.write ?? 0,
    barrieresAcquittees: mutant.counts?.["flush-ack"] ?? 0,
  });
  await testInfo.attach("live-mutant.json", {
    body: JSON.stringify(mutant, null, 2),
    contentType: "application/json",
  });
  expect(mutant.conforming, "le boot qui mute est conforme").toBe(true);
  expect(mutant.counts.write, "Rails a écrit dans le volume").toBeGreaterThan(0);
  expect(mutant.counts["flush-ack"], "et au moins une barrière a été acquittée").toBeGreaterThan(0);

  // 6. La réouverture suivante doit ÉCARTER l'instantané, le RETIRER, et booter à froid.
  const froid = await phase({ ...configBoot, phase: "resume-instantane" });
  chronologie.etape("réouverture qui ÉCARTE l'instantané", {
    utilise: froid.usedSnapshot,
    motifDeRejet: froid.instantane?.motif ?? null,
    santeMs: froid.healthMilliseconds,
  });
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
      // **MESURE SANS SEUIL** (#152). `ecrituresDuGuest` compte les APPELS d'écriture qu'un noyau
      // Linux repris adresse au pont — rejeu du cache de pages, minuterie de journal ext4, horloge
      // rattrapée. Il vaut 0 la plupart du temps et 21 sur les occurrences des 8 et 9 septembre
      // 2026 ; il n'est plus borné par une assertion parce qu'il ne mesure pas ce que l'ADR 0024
      // promet. Ce qui est ASSERTÉ vit trois champs plus bas : `barrieresAcquittees` et
      // `octetsValides`, tous deux nuls, plus l'égalité des deux empreintes.
      ecrituresDuGuest: reprise.counts.write ?? 0,
      operationsAta: reprise.counts.ata ?? 0,
      barrieresAcquittees: reprise.counts["flush-ack"] ?? 0,
      octetsDeposes: reprise.generation.deposeeMaxOctets,
      octetsValides: reprise.generation.valideeMaxOctets,
      journalDeGenerationOctets: {
        apresCapture: apresCapture.generationJournalSize,
        apresReprise: apresReprise.generationJournalSize,
      },
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
