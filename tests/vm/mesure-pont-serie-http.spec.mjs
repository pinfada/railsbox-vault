// LA MESURE qui précède la décision (#192) : ce que coûte une page Rails réelle à travers le pont
// série `@VLT1`, moteur par moteur.
//
// L'ordre est imposé par l'issue et il n'est pas décoratif : le mécanisme qui sert l'application
// dans le cadre — Service Worker sur l'origine applicative, shim dans le document, réseau virtuel
// v86 — est une décision d'ADR, et deux des trois candidats paient exactement le coût mesuré ici.
// Le troisième le remplace. Écrire la table AVANT de choisir est la seule façon d'instruire la
// décision contre un fait plutôt que contre une intuition.
//
// Ce que cette suite publie : `reports/mesures/pont-serie-http-<moteur>.json`, sans seuil. Elle ne
// fait rougir que sur ce qui rendrait la mesure MENSONGÈRE — une page qui n'est pas une page, un
// actif servi sous le mauvais type, un cookie de session perdu —, jamais sur une durée.
//
// ## Ce que la mesure a rendu, moteur par moteur — l'ÉCART est déclaré, pas tu
//
//  - **Chromium : mesuré.** Le relevé est publié, et l'ADR 0038 s'appuie sur lui ;
//  - **Firefox : PAS mesuré, et l'épreuve le dit au lieu de passer au vert.** Rails n'a jamais
//    répondu à `/vault/health` dans le guest sous Firefox, deux fois, sous deux budgets : cinq
//    minutes (« dernière erreur : le pont a refusé la requête : application-injoignable (code 7) »)
//    puis quinze (« dernière erreur : aucune réponse à GET /vault/health en 5000 ms »). Le pont
//    série RÉPOND dans le premier cas — donc le guest tourne et Python vit — mais Puma n'écoute
//    jamais, et le pont finit par se taire. C'est cohérent avec la position déjà écrite de ce dépôt
//    (`playwright.vm.config.mjs` : « Chromium porte TOUTE la suite ; Firefox et WebKit ne portent
//    que le TÉMOIN de démarrage »), et ce n'est PAS un défaut du relais : rien de ce que #192 livre
//    n'a été exécuté sous ce moteur, puisque le boot n'y aboutit pas. La cause exacte — lenteur du
//    JIT WebAssembly sous Firefox, ordonnancement, ou tout autre chose — n'est pas établie par cette
//    tranche, et l'affirmer serait deviner ;
//  - **WebKit : IMPOSSIBLE**, et c'est un fait mesuré ailleurs — il n'expose pas l'OPFS sous
//    Playwright (`VAULT_STORAGE_UNSUPPORTED`), donc aucun volume ne s'y ouvre et aucun guest n'y
//    boote sur un disque.
//
// Le taire ferait passer une impossibilité pour un oubli ; le skip ci-dessous NOMME sa cause.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  REPOSITORY_ROOT,
  adressesServiesV86,
  artefactsV86Absents,
} from "../../tools/v86-paths.mjs";

const ADRESSES_V86 = adressesServiesV86();
const CHEMIN_MANIFESTE = join(REPOSITORY_ROOT, "tools", "build-reference-image", "manifest.json");
const CHEMIN_CONTRAT = join(REPOSITORY_ROOT, "apps", "reference", "vault-invariant.json");
const CHEMIN_PACKAGE = join(REPOSITORY_ROOT, "package.json");
const DOSSIER_IMAGE = join(REPOSITORY_ROOT, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(REPOSITORY_ROOT, "reports", "mesures");

/** Volume propre à cette mesure : elle ne partage son support avec aucune autre suite. */
const VOLUME = "vault-app-mesure-relais";

/** Budget d'un boot Rails sur i386 émulé. Généreux : le boot mesuré tient en ~150 s sur Chromium. */
const BUDGET_BOOT_MS = 300_000;

/**
 * Les moteurs où la mesure NE PEUT PAS être prise, et la cause de chacun, mot pour mot.
 *
 * Elle est nommée ici plutôt que laissée à un `testMatch` de la configuration : un moteur absent
 * d'une liste de projets se lit comme un oubli, un moteur qui S'IGNORE EN DISANT POURQUOI se lit
 * comme un fait. C'est la forme que ce dépôt emploie déjà pour WebKit dans le cycle de vie.
 */
const MOTEURS_SANS_MESURE = Object.freeze({
  firefox:
    "Firefox : Rails n'a jamais répondu à /vault/health dans le guest, deux fois, sous deux " +
    "budgets (300 s : « le pont a refusé la requête : application-injoignable (code 7) » ; 900 s : " +
    "« aucune réponse à GET /vault/health en 5000 ms »). Le pont série répond d'abord puis se tait ; " +
    "Puma n'écoute jamais. Mesuré le 12 septembre 2026, cause non établie par #192.",
  webkit:
    "WebKit : aucun OPFS sous Playwright (VAULT_STORAGE_UNSUPPORTED) — aucun volume ne s'ouvre, " +
    "donc aucun guest ne boote sur un disque.",
});

/** Décrit ce qui manque pour mesurer, ou `null` si tout est là. */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image #5 absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

test("une page Rails réelle, ses actifs, sa session et son formulaire, mesurés à travers le pont série", async ({
  page,
}, testInfo) => {
  if (raison !== null) {
    // La mesure NOMME ce qui lui manque plutôt que de s'ignorer en silence : un relevé absent doit
    // se lire comme une absence, jamais comme un zéro.
    test.skip(true, raison);
  }
  const sansMesure = MOTEURS_SANS_MESURE[testInfo.project.name];
  if (sansMesure !== undefined) test.skip(true, sansMesure);
  const budgetBootMs = BUDGET_BOOT_MS;
  testInfo.setTimeout(budgetBootMs + 900_000);

  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));
  const paquet = JSON.parse(readFileSync(CHEMIN_PACKAGE, "utf8"));
  const disqueApp = manifeste.artifacts.find((artefact) => artefact.name === manifeste.boot.hdb);

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
    bootTimeoutMs: budgetBootMs,
  };

  await page.goto("/vm/reference.html", { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.bancReprise !== undefined, null, { timeout: 30_000 });
  const courir = (charge) => page.evaluate((c) => globalThis.bancReprise.executer(c), charge);

  // Hygiène : un volume laissé par une mesure précédente fausserait le compte de notes.
  await courir({ phase: "cleanup", volume: VOLUME }).catch(() => {});
  await courir({
    phase: "prepare",
    volume: VOLUME,
    appDiskBytes: disqueApp.byteSize,
    appDiskUrl: `/artifacts/reference-image/${manifeste.boot.hdb}`,
    manifest: descripteurManifeste,
  });

  const rapport = await courir({ ...configBoot, phase: "mesure-relais" });
  const mesure = rapport.relais;

  const releve = {
    moteur: testInfo.project.name,
    mesureLe: new Date().toISOString(),
    navigateur: await page.evaluate(() => navigator.userAgent),
    bootMs: rapport.bootMilliseconds,
    santeMs: rapport.healthMilliseconds,
    relais: mesure,
  };
  await mkdir(DOSSIER_RAPPORTS, { recursive: true });
  const fichier = join(DOSSIER_RAPPORTS, `pont-serie-http-${testInfo.project.name}.json`);
  await writeFile(fichier, `${JSON.stringify(releve, null, 2)}\n`, "utf8");
  await testInfo.attach("pont-serie-http.json", {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });

  // Ce qui rendrait la MESURE mensongère, et rien d'autre : une durée n'est jamais jugée ici.
  expect(mesure.premierePage.statut, "la page d'accueil répond 200").toBe(200);
  expect(mesure.premierePage.typeDeContenu, "elle est servie en HTML").toContain("text/html");
  expect(
    mesure.premierePage.octetsRecus,
    "une page d'accueil vide ne mesurerait rien",
  ).toBeGreaterThan(500);
  expect(
    mesure.actifsEnSerie.map(({ statut }) => statut),
    "les trois sous-ressources sont servies",
  ).toEqual([200, 200, 200]);
  expect(mesure.actifsEnSerie.map(({ typeDeContenu }) => typeDeContenu)).toEqual([
    expect.stringContaining("text/css"),
    expect.stringContaining("javascript"),
    expect.stringContaining("image/png"),
  ]);
  expect(mesure.sessionRails.cookiePose, "Rails a posé un cookie de session").toBe(true);
  expect(mesure.sessionRails.jetonAntiCsrfTrouve, "le formulaire porte son jeton").toBe(true);
  expect(
    mesure.sessionRails.vuesRelues,
    "le compteur de vues a AVANCÉ : le cookie a fait l'aller-retour",
  ).toBeGreaterThan(1);
  expect(mesure.soumission.statut, "la soumission rend une redirection 303").toBe(303);
  expect(mesure.pageApresRedirection.statut, "la redirection mène à la note créée").toBe(200);

  // Le relevé est ÉCRIT sur la sortie standard : une mesure qui ne vit que dans un fichier
  // d'artefacts n'est pas lue, et c'est elle qui doit instruire l'ADR.
  process.stdout.write(
    `\n[mesure ${testInfo.project.name}] première page ${mesure.premierePage.millisecondes} ms ` +
      `(${mesure.premierePage.octetsRecus} o) · actifs en série ` +
      `${mesure.actifsEnSerie.map((a) => `${a.millisecondes} ms`).join(" + ")} · ` +
      `les mêmes en parallèle ${mesure.actifsEnParallele.totalMs} ms · ` +
      `page suivante ${mesure.pageSuivante.millisecondes} ms · ` +
      `soumission ${mesure.soumission.millisecondes} ms · ` +
      `redirection suivie ${mesure.pageApresRedirection.millisecondes} ms · ` +
      `total ${mesure.total.requetes} requêtes, ${mesure.total.octetsRecus} o, ` +
      `${mesure.total.millisecondes} ms\n`,
  );

  await courir({ phase: "cleanup", volume: VOLUME }).catch(() => {});
});
