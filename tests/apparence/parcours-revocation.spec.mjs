// La RÉVOCATION D'URGENCE se confirme en deux temps, et « Terminer sans révoquer » la précède (#265).
// Chromium seul, coquille réelle sans machine virtuelle (le Worker de confiance est le vrai).
//
// Chaque épreuve est née rouge, sur `main`, avant le changement : le clic seul révoquait.

import {
  bouton,
  compterLesRevocations,
  expect,
  jusquALEtape9,
  retenirLaRevocation,
  test,
  titre,
  verifierAux,
} from "./outils-d-apparence.mjs";

const REVOQUER = "Révoquer tous les autres moyens d'ouvrir ce coffre";

async function jusquALaConfirmation(page) {
  const revocations = await compterLesRevocations(page);
  await jusquALEtape9(page);
  return revocations;
}

test("un seul clic sur « Révoquer… » ne révoque rien : la confirmation s'ouvre, « Annuler » a le focus et la lit", async ({
  page,
}, testInfo) => {
  const revocations = await jusquALaConfirmation(page);
  await bouton(page, REVOQUER).click();
  const confirmation = page.locator("#revocation-confirmation");
  await expect(confirmation).toBeVisible();
  await expect(page.locator("#portabilite-etat")).toHaveText("portabilite:au-repos");
  expect(await revocations(), "aucun message de révocation après un clic").toBe(0);
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();

  // Le focus est sur le geste sûr, et l'annonce dit l'irréversible, ce qui part et ce qui reste.
  const annuler = bouton(page, "Annuler");
  await expect(annuler).toBeFocused();
  await expect(annuler).toHaveAccessibleDescription(/irréversible/);
  await expect(annuler).toHaveAccessibleDescription(/ne fonctionneront plus|ne fonctionnera plus/);
  await expect(annuler).toHaveAccessibleDescription(/sauvegardes déjà faites/);
  await expect(page.getByRole("group", { name: /Confirmer la révocation/ })).toBeVisible();
  await expect(page.locator(`button:has-text("${REVOQUER}")`)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await verifierAux(page, testInfo, "etape-9-confirmation", [360, 1280]);
  expect(await revocations()).toBe(0);
});

test("« Annuler » (ou Échap) referme, rend le focus, dit que rien n'a été révoqué, et n'appelle jamais le Worker", async ({
  page,
}) => {
  const revocations = await jusquALaConfirmation(page);
  for (const geste of ["clic", "echap"]) {
    await bouton(page, REVOQUER).click();
    await expect(page.locator("#revocation-confirmation")).toBeVisible();
    if (geste === "clic") await bouton(page, "Annuler").click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("#revocation-confirmation")).toBeHidden();
    await expect(bouton(page, REVOQUER)).toBeFocused();
    await expect(bouton(page, REVOQUER)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#revocation-etat")).toHaveText(/Rien n'a été révoqué/);
    expect(await revocations(), `après ${geste}`).toBe(0);
  }
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();
});

test("« Terminer sans révoquer » précède « Révoquer » : à l'écran, au DOM et à la tabulation, sans `order`", async ({
  page,
}) => {
  await jusquALaConfirmation(page);
  const sans = bouton(page, "Terminer sans révoquer");
  const revoquer = bouton(page, REVOQUER);
  const [yAvant, yApres] = [await sans.boundingBox(), await revoquer.boundingBox()].map((b) => b.y);
  expect(yAvant, "visuellement : « Terminer » au-dessus").toBeLessThan(yApres);
  await sans.focus();
  await page.keyboard.press("Tab");
  await expect(revoquer, "Tab : « Terminer » puis « Révoquer »").toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sans).toBeFocused();
  const ordres = await page.evaluate(() =>
    [...document.querySelectorAll("#portabilite > *")].map((n) => getComputedStyle(n).order),
  );
  expect(new Set(ordres), "aucun `order` ne remet l'écran en ordre").toEqual(new Set(["0"]));
});

test("« Oui, révoquer » est le second geste : un message, une révocation, et l'écran suit", async ({
  page,
}) => {
  const revocations = await jusquALaConfirmation(page);
  await bouton(page, REVOQUER).click();
  await bouton(page, "Oui, révoquer les autres moyens").click();
  await expect(titre(page, "Parcours terminé")).toBeVisible({ timeout: 180_000 });
  expect(await revocations()).toBe(1);
});

test("une demande de révocation ne survit pas à l'étape qui l'a faite : à l'accueil, elle est fermée", async ({
  page,
}) => {
  const revocations = await jusquALaConfirmation(page);
  await bouton(page, REVOQUER).click();
  await expect(page.locator("#revocation-confirmation")).toBeVisible();
  await bouton(page, "Terminer sans révoquer").click();
  await expect(titre(page, "Parcours terminé, rien n'a été révoqué")).toBeVisible();
  await bouton(page, "Revenir à mon application").click();
  await expect(titre(page, "Votre application")).toBeVisible();
  await expect(bouton(page, REVOQUER)).toBeVisible();
  await expect(page.locator("#revocation-confirmation")).toBeHidden();
  await expect(bouton(page, REVOQUER)).toHaveAttribute("aria-expanded", "false");
  expect(await revocations()).toBe(0);
});

// --- Révocation EN VOL (relecture de #308) : la sortie est fermée, rien n'est affirmé ------------------

async function revoquerSansReponse(page) {
  const retenue = await retenirLaRevocation(page);
  await jusquALEtape9(page);
  await retenue.retenir(true);
  await bouton(page, REVOQUER).click();
  await bouton(page, "Oui, révoquer les autres moyens").click();
  await expect.poll(retenue.retenues).toBe(1);
  return retenue;
}

/** Tout ce qu'une personne ou un lecteur d'écran lirait : alertes, état, noms et descriptions. */
async function toutLeTexteDit(page) {
  const alertes = await page.getByRole("alert").allTextContents();
  const etat = await page.locator("#revocation-etat").textContent();
  const refus = await page.locator("#portabilite-refus").textContent();
  const declencheur = page.getByRole("button", { name: REVOQUER, exact: true });
  const description = await declencheur.evaluate((n) => n.getAttribute("aria-describedby") ?? "");
  return { alertes, etat, refus, description };
}

test("en vol : « Terminer sans révoquer » et « Revenir à mon application » sont fermés, rien n'est affirmé", async ({
  page,
}) => {
  const retenue = await revoquerSansReponse(page);
  const sans = bouton(page, "Terminer sans révoquer");
  const retour = bouton(page, "Revenir à mon application");
  await expect(sans).toBeDisabled();
  await expect(retour).toBeDisabled();
  await expect(page.locator("#revocation-etat")).toContainText("ne peut plus être annulée");
  // Un clic forcé ou la touche Entrée ne quittent pas l'étape ni ne disent « rien n'a été révoqué ».
  await sans.click({ force: true }).catch(() => {});
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();
  await expect(page.getByText("rien n'a été révoqué", { exact: false })).toHaveCount(0);
  await retenue.relacher();
  await expect(titre(page, "Parcours terminé")).toBeVisible({ timeout: 180_000 });
  await expect(retour).toBeEnabled();
});

test("issue incertaine (le Worker ne décode pas le message et meurt : aucune réponse) : « a peut-être eu lieu » partout, « refusée » nulle part, « Terminer sans révoquer » fermé", async ({
  page,
}) => {
  const retenue = await revoquerSansReponse(page);
  await retenue.relacher(true);
  await expect(page.getByRole("alert")).toContainText("peut-être eu lieu", { timeout: 60_000 });
  const dit = await toutLeTexteDit(page);
  for (const texte of [...dit.alertes, dit.etat, dit.refus]) {
    expect(texte, "aucune alerte ni annonce ne dit « refusée »").not.toMatch(/refus/i);
  }
  await expect(page.locator("#revocation-etat")).toContainText("peut-être eu lieu");
  await expect(bouton(page, "Terminer sans révoquer")).toBeDisabled();
  await expect(bouton(page, "Revenir à mon application")).toBeEnabled();
  await expect(bouton(page, REVOQUER)).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("tous vos moyens", { exact: false })).toHaveCount(0);
});
