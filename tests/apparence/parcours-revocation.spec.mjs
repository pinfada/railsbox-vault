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

// --- Révocation EN VOL (relecture de #308) : un état unique, un avertissement qui reste ---------------

async function revoquerSansReponse(page) {
  const retenue = await retenirLaRevocation(page);
  await jusquALEtape9(page);
  await retenue.retenir(true);
  await bouton(page, REVOQUER).click();
  await bouton(page, "Oui, révoquer les autres moyens").click();
  await expect.poll(retenue.retenues).toBe(1);
  return retenue;
}

const SORTIES = ["parcours-sans-revoquer", "parcours-retour-application", "parcours-continuer"];

/** Un `click` SYNTHÉTIQUE : ni `disabled` ni le pointeur n'y changent rien, seul le gestionnaire décide. */
const clicSynthetique = (page, ids) =>
  page.evaluate((cibles) => {
    for (const id of cibles) {
      document.getElementById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }, ids);

test("en vol : « Terminer sans révoquer » et « Revenir à mon application » sont fermés, rien n'est affirmé", async ({
  page,
}) => {
  const retenue = await revoquerSansReponse(page);
  await expect(page.locator("#parcours-sans-revoquer")).toBeDisabled();
  await expect(page.locator("#parcours-retour-application")).toBeDisabled();
  await expect(page.locator("#parcours-incertitude")).toContainText("ne peut plus être annulée");
  await clicSynthetique(page, SORTIES);
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();
  await expect(page.getByText("rien n'a été révoqué", { exact: false })).toHaveCount(0);
  await retenue.relacher();
  await expect(titre(page, "Parcours terminé")).toBeVisible({ timeout: 180_000 });
  await expect(page.locator("#parcours-retour-application")).toBeEnabled();
  await expect(page.locator("#parcours-incertitude")).toHaveText("");
});

test("en vol : une sortie PRESSÉE pendant le départ de la demande (rendu différé) n'affirme rien", async ({
  page,
}) => {
  const retenue = await retenirLaRevocation(page);
  await jusquALEtape9(page);
  await retenue.retenir(true);
  await bouton(page, REVOQUER).click();
  const oui = bouton(page, "Oui, révoquer les autres moyens");
  // Un appui est maintenu sur « Terminer sans révoquer » : `pression-du-bouton.mjs` RETIENT le rendu
  // — donc `disabled` — jusqu'au relâchement. Pendant ce temps, « Oui » part, au clavier.
  await page.locator("#parcours-sans-revoquer").scrollIntoViewIfNeeded();
  const cible = await page.locator("#parcours-sans-revoquer").boundingBox();
  await page.mouse.move(cible.x + 8, cible.y + 8);
  await page.mouse.down();
  await oui.focus();
  await page.keyboard.press("Enter");
  await expect.poll(retenue.retenues).toBe(1);
  // La demande est partie ; aucun rendu n'a posé `disabled` : le gestionnaire seul garde la sortie.
  await expect(page.locator("#parcours-sans-revoquer")).toBeEnabled();
  await page.mouse.up(); // le `click` retenu est livré maintenant
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();
  await expect(page.getByText("rien n'a été révoqué", { exact: false })).toHaveCount(0);
  await expect(page.locator("#parcours-sans-revoquer")).toBeDisabled();
  await retenue.relacher();
  await expect(titre(page, "Parcours terminé")).toBeVisible({ timeout: 180_000 });
});

test("issue incertaine : l'avertissement vit hors du bloc, survit à « Revenir à mon application » et à un autre clic, puis se lève par la réouverture du coffre", async ({
  page,
}) => {
  const retenue = await revoquerSansReponse(page);
  await retenue.refuser("VAULT_X");
  const avertissement = page.locator("#parcours-incertitude");
  await expect(avertissement).toContainText("peut-être eu lieu", { timeout: 60_000 });
  await expect(avertissement).toContainText("Rouvrez votre coffre");
  await expect(avertissement).toHaveAttribute("aria-live", "assertive");
  const regions = [
    ...(await page.getByRole("alert").allTextContents()),
    (await avertissement.textContent()) ?? "",
  ];
  for (const texte of regions) {
    expect(texte, "aucune alerte ne dit « refusée »").not.toMatch(/refus/i);
  }
  await expect(page.locator("#parcours-sans-revoquer")).toBeDisabled();
  await clicSynthetique(page, ["parcours-sans-revoquer"]);
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();

  // La navigation permise : « Revenir à mon application ». L'avertissement RESTE, visible et dans
  // l'arbre d'accessibilité, hors du bloc de la révocation (qui n'est plus à l'écran).
  await bouton(page, "Revenir à mon application").click();
  await expect(titre(page, "Travailler dans l'application")).toBeVisible();
  await expect(avertissement).toBeVisible();
  await expect(page.locator("#parcours")).toContainText("Rouvrez votre coffre");
  expect(await page.locator("#parcours").ariaSnapshot()).toContain("peut-être eu lieu");
  // Un autre geste ne l'efface pas non plus : « Continuer » ramène à l'étape 9.
  await bouton(page, "Continuer : Révoquer en urgence").click();
  await expect(titre(page, "Révoquer en urgence")).toBeVisible();
  await expect(avertissement).toBeVisible();

  // Aucune nouvelle révocation avant la vérification : le geste est fermé, rien n'est annoncé « annulé ».
  // `aria-disabled` : Playwright refuserait de cliquer ; l'événement est livré au gestionnaire.
  await bouton(page, REVOQUER).dispatchEvent("click");
  await expect(page.locator("#revocation-confirmation")).toBeHidden();
  await expect(avertissement).toContainText("peut-être eu lieu");

  // Levée : la réouverture du coffre (le document se recharge), qui est la vérification demandée.
  await page.reload();
  await expect(page.locator("#parcours-incertitude")).toBeEmpty({ timeout: 60_000 });
});

test("relecture échouée après une révocation CONFIRMÉE : le succès tient, aucun constat périmé ne garde le parcours, la reprise est dite", async ({
  page,
}) => {
  const retenue = await retenirLaRevocation(page);
  await jusquALEtape9(page);
  await retenue.echouerLInventaire("VAULT_X");
  await bouton(page, REVOQUER).click();
  await bouton(page, "Oui, révoquer les autres moyens").click();
  // Le constat d'avant (feuille éprouvée) garderait « Parcours terminé » : il est invalidé.
  await expect(titre(page, "Votre coffre doit être relu")).toBeVisible({ timeout: 180_000 });
  await expect(titre(page, "Parcours terminé")).toHaveCount(0);
  const region = page.locator("#parcours-incertitude");
  await expect(region).toContainText("La révocation a été faite");
  await expect(region).toContainText("Rouvrez votre coffre");
  await expect(region).not.toContainText("peut-être eu lieu");
  expect(await page.getByRole("alert").allTextContents()).not.toContain("Rien n'a été révoqué");
});

test("issue incertaine → rouvrir → Annuler / Échap : aucune nouvelle confirmation, jamais « Rien n'a été révoqué »", async ({
  page,
}) => {
  const retenue = await revoquerSansReponse(page);
  await retenue.refuser("VAULT_X");
  const avertissement = page.locator("#parcours-incertitude");
  await expect(avertissement).toContainText("peut-être eu lieu", { timeout: 60_000 });
  const declencheur = bouton(page, REVOQUER);
  await expect(declencheur).toHaveAttribute("aria-disabled", "true");
  for (const geste of ["clic", "echap"]) {
    if (geste === "clic") await declencheur.dispatchEvent("click");
    else await page.keyboard.press("Escape");
    await expect(page.locator("#revocation-confirmation")).toBeHidden();
    // Tout ce qu'une personne lit ou entend : l'avertissement persistant ET l'état du bloc.
    await expect(page.locator("#revocation-etat")).toContainText("Rouvrez votre coffre");
    for (const texte of [
      await avertissement.textContent(),
      await page.locator("#revocation-etat").textContent(),
      ...(await page.getByRole("alert").allTextContents()),
    ]) {
      expect(texte, `après ${geste}`).not.toMatch(/Rien n'a été révoqué|ouvre toujours/);
    }
  }
  await expect(avertissement).toContainText("peut-être eu lieu");
  expect(await retenue.retenues()).toBe(0);
});

test("issue incertaine (le Worker ne décode pas le message et meurt : aucune réponse) : « a peut-être eu lieu » partout, « refusée » nulle part, « Terminer sans révoquer » fermé", async ({
  page,
}) => {
  const retenue = await revoquerSansReponse(page);
  await retenue.relacher(true);
  await expect(page.locator("#parcours-incertitude")).toContainText("peut-être eu lieu", {
    timeout: 60_000,
  });
  const alertes = [
    ...(await page.getByRole("alert").allTextContents()),
    (await page.locator("#parcours-incertitude").textContent()) ?? "",
  ];
  const etat = await page.locator("#revocation-etat").textContent();
  const refus = await page.locator("#portabilite-refus").textContent();
  for (const texte of [...alertes, etat, refus]) {
    expect(texte, "aucune alerte ni annonce ne dit « refusée »").not.toMatch(/refus/i);
  }
  // Le Worker mort remonte l'écran de réouverture : l'étape 9 est cachée, ses gestes restent fermés.
  await expect(page.locator("#parcours-sans-revoquer")).toBeDisabled();
  await expect(page.getByText("tous vos moyens", { exact: false })).toHaveCount(0);
});
