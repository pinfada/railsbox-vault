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
