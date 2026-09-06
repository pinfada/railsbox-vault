import { expect, test } from "@playwright/test";

import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// FRONTIÈRE de l'enveloppe de clé, sur les trois moteurs (#21, ADR 0020 ; `SEC-ORIGIN-001`).
//
// Ce que cette suite établit, et qui ne se démontre pas sous Node :
//
//  1. l'enveloppe fonctionne sur l'OPFS RÉEL, dans un Worker dédié — créer, ouvrir par clé de
//     déverrouillage, RELIRE un secteur connu du volume sous la clé développée, remplacer la clé,
//     rouvrir par la neuve, refuser l'ancienne ;
//  2. la PAGE n'obtient pas de handle sur le fichier d'enveloppes. Elle reçoit
//     `VAULT_STORAGE_UNSUPPORTED`, exactement comme sur le volume depuis #6 ;
//  3. **rien de ce qui franchit le port ne contient une clé.** Ce point est le cœur de la tranche,
//     et il est mesuré plutôt qu'affirmé : l'épreuve FOUILLE tout ce que le Worker a rendu depuis
//     le chargement de la page, à la recherche des octets des clés de TEST. Un `postMessage` qui
//     emporterait la clé de volume — par un rapport trop bavard, par une erreur qui recopierait son
//     contexte — ferait rougir cette assertion.
//
// Elle tourne sur les trois moteurs de la matrice #2, comme les frontières de CSP et
// d'applications : une frontière de stockage ne s'applique pas de la même façon d'un moteur à
// l'autre, et la mesurer sur le seul moteur par défaut publierait une garantie que les deux autres
// ne tiennent peut-être pas.
//
// Sur un moteur sans OPFS synchrone dans un Worker — WebKit, que `docs/compatibility.md` classe
// déjà « refusé (OPFS absent) » — la suite n'est pas ignorée : elle EXIGE un refus typé. Un
// plantage non typé, ou pire un succès, la ferait échouer.

/** Les clés de TEST, telles que `src/vm/cle-de-volume.mjs` les distribue sous jeton. */
const CLES_DE_TEST = {
  volume: octetsEnHex(suite(0x00)),
  deverrouillageInitiale: octetsEnHex(suite(0x80)),
  deverrouillageRotation: octetsEnHex(suite(0xa0)),
  deverrouillageTierce: octetsEnHex(suite(0xc0)),
};

function suite(base) {
  return Uint8Array.from({ length: 32 }, (_, index) => (base + index) % 256);
}

function octetsEnHex(octets) {
  let rendu = "";
  for (const octet of octets) rendu += octet.toString(16).padStart(2, "0");
  return rendu;
}

/** Les mêmes octets, en décimal séparé par des virgules : la forme d'un tableau sérialisé en JSON. */
function octetsEnJson(hex) {
  const octets = [];
  for (let index = 0; index < hex.length; index += 2) {
    octets.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return octets.join(",");
}

function codeDuRefus(error) {
  const trouve = String(error?.message ?? "").match(/VAULT_[A-Z_]+/);
  return trouve ? trouve[0] : null;
}

async function ouvrirBanc(page) {
  await page.goto("/vm/enveloppe.html");
  await expect(page.locator("#etat")).toHaveText("Worker d'enveloppe prêt.");
}

function executer(page, payload) {
  return page.evaluate((options) => globalThis.bancEnveloppe.executer(options), payload);
}

async function executerOuRefus(page, payload) {
  try {
    return { report: await executer(page, payload), code: null };
  } catch (error) {
    return { report: null, code: codeDuRefus(error) };
  }
}

/** Ouvre le banc et mesure ce que le moteur offre au Worker. */
async function contexte(page, testInfo) {
  await ouvrirBanc(page);
  const capacite = await executer(page, { scenario: "capacite" });
  await testInfo.attach(`enveloppe-capacite-${testInfo.project.name}.json`, {
    body: JSON.stringify(capacite, null, 2),
    contentType: "application/json",
  });
  const porte =
    capacite.workerGetDirectory === "function" &&
    capacite.workerCreateSyncAccessHandle === "function" &&
    capacite.openCode === null;
  return { capacite, porte };
}

test("le cycle complet d'une enveloppe tient sur l'OPFS réel, ou le moteur le refuse typé", async ({
  page,
}, testInfo) => {
  const { capacite, porte } = await contexte(page, testInfo);

  if (testInfo.project.name.endsWith("chromium")) {
    // Chromium est le moteur du contrôle obligatoire : perdre la capacité doit bloquer une PR.
    expect(capacite.workerGetDirectory).toBe("function");
    expect(capacite.openCode).toBeNull();
  }

  const { report, code } = await executerOuRefus(page, { scenario: "cycle" });
  await testInfo.attach(`enveloppe-cycle-${testInfo.project.name}.json`, {
    body: JSON.stringify({ porte, report, code }, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }

  expect(report.versionApresCreation).toBe(1);
  expect(report.ouvertureParKek).toBe(1);
  expect(report.volumeRelu, "la clé développée n'ouvre pas le volume qu'elle protège").toBe(true);
  expect(report.versionApresRotation).toBe(2);
  expect(report.relueApresRotation, "après rotation, la clé de volume n'est plus la même").toBe(
    true,
  );
  expect(report.refusDeLAncienne).toBe(ENVELOPPE_ERROR_CODES.cleRefusee);
  expect(report.emplacements).toBe(1);
});

test("la révocation d'urgence réduit trois emplacements à UN sur l'OPFS réel, ou le moteur le refuse typé", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  const { report, code } = await executerOuRefus(page, { scenario: "revocation-urgence" });
  await testInfo.attach(`enveloppe-revocation-urgence-${testInfo.project.name}.json`, {
    body: JSON.stringify({ porte, report, code }, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }

  expect(report.emplacementsAvant).toBe(3);
  expect(report.typesAvant).toEqual([1, 3, 4]);
  expect(report.emplacementsApres).toBe(1);
  // UNE version consommée pour DEUX emplacements retirés : c'est la promesse de #148, et deux
  // révocations successives en auraient consommé deux.
  expect(report.versionsConsommees).toBe(1);
  expect(report.conserveeOuvre, "la clé que l'on tient n'ouvre plus l'enveloppe réduite").toBe(
    true,
  );
  expect(
    report.conserveeEstLePremierDAvant,
    "l'emplacement conservé n'est pas celui que la clé initiale avait posé",
  ).toBe(true);
  expect(
    report.conserveeEstUnDesTrois,
    "la clé présentée ouvre un emplacement qui n'était pas dans l'enveloppe d'avant",
  ).toBe(true);
  expect(report.volumeRelu, "la clé développée n'ouvre plus le volume qu'elle protège").toBe(true);
  expect(report.refusDesRetirees).toEqual([report.refusAttendu, report.refusAttendu]);
  // #156 sur le système de fichiers du moteur : la page libérée est effacée, une seule page porte
  // encore des octets.
  expect(report.pagesNonNulles, "la page libérée porte encore des octets").toBe(1);
});

test("le coût de l'effacement de la page libre est MESURÉ sur l'OPFS réel, pas estimé", async ({
  page,
}, testInfo) => {
  // Le surcoût de #156 est une écriture de 8192 octets et une barrière par révocation. L'ADR 0026 le
  // publie, et il est relevé ici plutôt que déduit d'un banc en mémoire : c'est le disque qui décide.
  const { porte } = await contexte(page, testInfo);
  const { report, code } = await executerOuRefus(page, { scenario: "cout-effacement" });
  await testInfo.attach(`enveloppe-cout-effacement-${testInfo.project.name}.json`, {
    body: JSON.stringify({ porte, report, code }, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }

  expect(report.tours).toBeGreaterThanOrEqual(30);
  expect(report.octetsParTour).toBe(8192);
  expect(report.enveloppeIntacte, "le banc a écrit sur la page qui faisait autorité").toBe(true);
  expect(report.p50).toBeGreaterThan(0);
  expect(report.p95).toBeGreaterThanOrEqual(report.p50);
  // Aucun seuil de performance n'est imposé : le chiffre est PUBLIÉ, pas gardé. Un plafond mesuré
  // sur la machine d'un contributeur ferait rougir la CI d'un autre sans rien dire du produit.
});

test("un volume sans enveloppe est refusé par « aucune enveloppe », pas par « clé invalide »", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  const { report, code } = await executerOuRefus(page, { scenario: "sans-enveloppe" });

  if (!porte) {
    expect(code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }
  expect(report.code).toBe(ENVELOPPE_ERROR_CODES.absente);
  expect(report.distinctDuRefusDeCle).toBe(true);
});

test("la PAGE n'obtient aucun handle sur le fichier d'enveloppes", async ({ page }, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  await executerOuRefus(page, { scenario: "cycle" });

  const sonde = await page.evaluate(
    (nom) => globalThis.bancEnveloppe.sondePage(nom),
    "banc-enveloppe.cles",
  );
  await testInfo.attach(`enveloppe-sonde-page-${testInfo.project.name}.json`, {
    body: JSON.stringify(sonde, null, 2),
    contentType: "application/json",
  });

  expect(sonde.ouvert, "la page a ouvert le fichier de clés en accès exclusif").toBe(false);
  expect(sonde.code).toBe(STORAGE_ERROR_CODES.unsupported);
  // Le témoin qui empêche cette épreuve d'être vraie pour de mauvaises raisons : dans un moteur qui
  // porte OPFS, la page VOIT bien l'API — elle est simplement refusée par la garde du Worker dédié.
  if (porte) expect(sonde.getDirectory).toBe("function");
});

test("AUCUNE clé ne franchit le port : le relevé des réponses est fouillé", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  await executerOuRefus(page, { scenario: "cycle" });
  await executerOuRefus(page, { scenario: "sans-enveloppe" });

  const franchi = await page.evaluate(() => globalThis.bancEnveloppe.toutCeQuiAFranchiLePort());
  await testInfo.attach(`enveloppe-port-${testInfo.project.name}.txt`, {
    body: `${franchi.length} caractère(s) rendus par le Worker`,
    contentType: "text/plain",
  });

  expect(
    franchi.length,
    "le Worker n'a rien rendu : la fouille ne mesurerait rien",
  ).toBeGreaterThan(0);
  for (const [nom, hex] of Object.entries(CLES_DE_TEST)) {
    expect(franchi.includes(hex), `la clé « ${nom} » franchit le port en hexadécimal`).toBe(false);
    expect(
      franchi.includes(octetsEnJson(hex)),
      `la clé « ${nom} » franchit le port en tableau d'octets`,
    ).toBe(false);
  }
  // Témoin de la fouille elle-même : sans lui, une recherche qui ne trouve jamais rien pourrait
  // n'être qu'une recherche cassée. Le rapport du cycle contient bien quelque chose de reconnaissable.
  if (porte) expect(franchi).toContain("banc-enveloppe.cles");
});
