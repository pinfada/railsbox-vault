import { expect, test } from "@playwright/test";

import { BUDGET_DIAGNOSTIC_CODES } from "../../src/vm/storage-budget.mjs";

// Preuve de niveau NAVIGATEUR de la couche budget de stockage (#9, `VAULT-PERSIST-001`). Elle exécute
// la vraie couche budget contre le VRAI `navigator.storage`, dans la page — la couche budget ne touche
// aucun handle exclusif et n'a donc pas besoin d'un Worker dédié.
//
// Seules les branches RÉELLEMENT atteignables sont vérifiées ici : estimation réelle, demande de
// persistance réelle, réservation réelle, et le rendu accessible d'un diagnostic dans un vrai DOM. Les
// branches d'absence (API manquante) et de saturation (vrai quota dépassé) sont prouvées, elles, par
// les doubles déterministes de `tests/unit/vm-storage-budget.test.mjs` : les provoquer réellement
// exigerait de dégrader le moteur ou de remplir le disque, ce qui ne prouverait rien de plus.

async function ouvrirBanc(page) {
  await page.goto("/vm/budget.html");
  await expect(page.locator("#etat")).toHaveText("Banc budget prêt.");
}

test("measure rend un état exploitable du vrai navigator.storage", async ({ page }, testInfo) => {
  await ouvrirBanc(page);
  const mesure = await page.evaluate(() => globalThis.bancBudget.mesurer());
  await testInfo.attach("budget-mesure.json", {
    body: JSON.stringify(mesure, null, 2),
    contentType: "application/json",
  });

  if (testInfo.project.name === "chromium") {
    // Chromium est le moteur du contrôle obligatoire : `estimate()` y existe et rend des octets.
    expect(mesure.state).toBe("known");
    expect(mesure.quotaIsNumber).toBe(true);
    expect(mesure.available).toBeGreaterThanOrEqual(0);
  }

  // Sur tout moteur : un état inconnu ne se dégrade JAMAIS en zéro capacité.
  if (mesure.state === "unknown") {
    expect(mesure.available).toBeNull();
    expect(mesure.diagnosticCode).toBe(BUDGET_DIAGNOSTIC_CODES.estimateUnavailable);
  } else {
    expect(mesure.state).toBe("known");
  }
});

test("requestPersistence ne promet jamais la durabilité sur un refus", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const issue = await page.evaluate(() => globalThis.bancBudget.persister());
  await testInfo.attach("budget-persistance.json", {
    body: JSON.stringify(issue, null, 2),
    contentType: "application/json",
  });

  // L'invariant central, quel que soit le verdict réel du moteur sans geste utilisateur :
  // seule une persistance accordée ou déjà acquise est durable ; un refus n'est jamais durable.
  expect(["granted", "already", "denied", "unsupported"]).toContain(issue.state);
  if (issue.state === "denied") {
    expect(issue.durable).toBe(false);
    expect(issue.diagnosticCode).toBe(BUDGET_DIAGNOSTIC_CODES.persistDenied);
  }
  if (issue.state === "unsupported") {
    expect(issue.durable).toBe(false);
  }
  if (issue.durable === true) {
    expect(["granted", "already"]).toContain(issue.state);
  }
});

test("reserve avertit AVANT mutation quand le besoin dépasse l'espace, avec un role=status", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  // Un besoin volontairement absurde : sur estimation connue, il force l'avertissement d'espace bas
  // sans toucher au stockage. Sur estimation inconnue, le verdict reste indéterminé, pas insuffisant.
  const verdict = await page.evaluate(() =>
    globalThis.bancBudget.reserver(Number.MAX_SAFE_INTEGER),
  );
  await testInfo.attach("budget-reservation.json", {
    body: JSON.stringify(verdict, null, 2),
    contentType: "application/json",
  });

  if (verdict.state === "known") {
    expect(verdict.sufficient).toBe(false);
    expect(verdict.diagnosticCode).toBe(BUDGET_DIAGNOSTIC_CODES.spaceLow);
    // Le message accessible est réellement rendu dans le DOM, en région polie.
    expect(verdict.rendu.domRole).toBe("status");
    expect(verdict.rendu.text.length).toBeGreaterThan(0);
  } else {
    expect(verdict.sufficient).toBeNull();
    expect(verdict.diagnosticCode).toBe(BUDGET_DIAGNOSTIC_CODES.estimateUnavailable);
  }
});

test("un quota dépassé rend un diagnostic role=alert, volume préservé, sans fuite de contenu", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const resultat = await page.evaluate(() => globalThis.bancBudget.classerQuota());
  await testInfo.attach("budget-quota.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  expect(resultat.code).toBe(BUDGET_DIAGNOSTIC_CODES.quotaExceeded);
  expect(resultat.severity).toBe("error");
  expect(resultat.volumeReset).toBe(false);
  expect(resultat.priorDataReadable).toBe(true);
  expect(resultat.leaksContent).toBe(false);
  // Une erreur interrompt : la région vivante rendue porte bien `role="alert"`.
  expect(resultat.rendu.domRole).toBe("alert");
});
