// L'APPARENCE du parcours sur les trois moteurs : création, choix, restauration, feuille (#194).
//
// Les étapes 4 prête à 9, `forced-colors` et le mouvement non réduit sont dans
// `parcours-etapes.spec.mjs`, sur Chromium (revue de la PR #216, constats 2 et 3).

import { instrumenterNavigationFirefox } from "../support/navigation-firefox.mjs";
import {
  ORIGINE_A,
  PHRASE,
  RACINE,
  aucunGroupeSansNom,
  bouton,
  capturer,
  contraste,
  exigerLaSobriete,
  expect,
  ouvrir,
  surveiller,
  test,
  verifier,
} from "./outils-d-apparence.mjs";
import { writeFile } from "node:fs/promises";

/**
 * VERROUILLE et attend le NOUVEAU document : le verrouillage recharge la coquille, mais l'ancien
 * document voit le coffre verrouillé un instant avant — et y montre déjà l'écran d'après. Attendre un
 * titre ou un champ laissait l'épreuve agir dans un document condamné (#239, Firefox en CI).
 */
async function verrouillerEtRecharger(page) {
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
}

const LARGEURS = [320, 768, 1024, 1440];

for (const theme of ["light", "dark"]) {
  for (const largeur of LARGEURS) {
    test(`${theme}-${largeur} : création, choix et restauration accessibles`, async ({
      page,
      browser,
      browserName,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: largeur, height: 900 });
      await ouvrir(page);
      await aucunGroupeSansNom(page, "création");
      await verifier(page, testInfo, "creation");
      await bouton(page, "Commencer").click();
      await aucunGroupeSansNom(page, "choix");
      await verifier(page, testInfo, "choix");
      await expect(
        page.getByRole("heading", { level: 1, name: "RailsBox Vault", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#parcours-attente")).toHaveAttribute("aria-live", "polite");
      await expect(page.getByRole("alert")).toHaveCount(1);
      const couleurs = await page.locator("main").evaluate((main) => {
        const principal = getComputedStyle(main);
        const secondaire = getComputedStyle(
          document.querySelector("#parcours-ce-qui-va-se-passer"),
        );
        const champ = getComputedStyle(document.querySelector("#saisie-phrase"));
        const bouton = getComputedStyle(document.querySelector("#ouvrir-par-phrase"));
        return {
          texte: principal.color,
          fond: principal.backgroundColor,
          secondaire: secondaire.color,
          champ: champ.backgroundColor,
          bord: champ.borderColor,
          bouton: bouton.backgroundColor,
          inverse: bouton.color,
        };
      });
      const mesures = {
        texte: contraste(couleurs.texte, couleurs.fond),
        secondaire: contraste(couleurs.secondaire, couleurs.fond),
        bouton: contraste(couleurs.inverse, couleurs.bouton),
        champ: contraste(couleurs.bord, couleurs.champ),
      };
      for (const nom of ["texte", "secondaire", "bouton"])
        expect(mesures[nom], nom).toBeGreaterThanOrEqual(4.5);
      expect(mesures.champ).toBeGreaterThanOrEqual(3);
      await writeFile(
        `${RACINE}/${testInfo.project.name}-${theme}-${largeur}-contrastes.json`,
        JSON.stringify(mesures, null, 2),
      );
      // La restauration appartient à un appareil vierge, pas à la progression commencée.
      const autreAppareil = await browser.newContext({
        colorScheme: theme,
        reducedMotion: "reduce",
        viewport: { width: largeur, height: 900 },
      });
      try {
        const sobriete = await surveiller(autreAppareil);
        const restauration = await autreAppareil.newPage();
        instrumenterNavigationFirefox(restauration, {
          browserName,
          annoter: (annotation) => testInfo.annotations.push(annotation),
        });
        await restauration.goto(`${ORIGINE_A}/index.html`);
        await bouton(restauration, "J'ai déjà une sauvegarde").click();
        await verifier(restauration, testInfo, "restauration");
        exigerLaSobriete(sobriete);
      } finally {
        await autreAppareil.close();
      }
    });
  }

  test(`${theme} : feuille réelle, impression, épreuve de la feuille et refus`, async ({
    page,
    browserName,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await ouvrir(page);
    await bouton(page, "Commencer").click();
    await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await bouton(page, "Créer mon coffre").click();
    const titreCode = page.getByRole("heading", {
      name: "Recevoir votre code de récupération",
      exact: true,
    });
    await expect
      .poll(
        async () =>
          (await titreCode.isVisible()) || (await page.getByRole("alert").textContent()) !== "",
        { timeout: 60_000 },
      )
      .toBe(true);
    if (!(await titreCode.isVisible())) {
      await expect(page.getByRole("alert")).toContainText("navigateur");
      await verifier(page, testInfo, "refus-du-moteur");
      // L'écran le plus exposé de WebKit : le refus, le plus long texte d'alerte, à 320 px.
      await page.setViewportSize({ width: 320, height: 900 });
      await verifier(page, testInfo, "refus-du-moteur-320");
      return;
    }
    await verifier(page, testInfo, "annonce-du-code");
    await bouton(page, "Afficher mon code de récupération").click();
    const code = page.locator("#feuille-code");
    await expect(code).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/);
    const valeur = (await code.textContent()).trim();
    for (const largeur of LARGEURS) {
      await page.setViewportSize({ width: largeur, height: 900 });
      await verifier(page, testInfo, `feuille-${largeur}`);
    }
    await page.emulateMedia({ media: "print" });
    await expect(code).toBeVisible();
    await expect(page.locator("#parcours-consigne-feuille")).toContainText("Numéro de version");
    await expect(bouton(page, "J'ai recopié mon code")).toBeHidden();
    await capturer(page, {
      path: `${RACINE}/${testInfo.project.name}-${theme}-impression.png`,
      fullPage: true,
    });
    await page.emulateMedia({ media: "screen" });
    // #239 : la recopie n'est plus jugée dans la page ; la feuille s'éprouve en verrouillant.
    await bouton(page, "J'ai recopié mon code").click();
    await verifier(page, testInfo, "a-verrouiller");
    await verrouillerEtRecharger(page);
    const champ = page.getByLabel("Code de récupération", { exact: true });
    await expect(champ).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("load");
    expect(await page.locator("body").textContent()).not.toContain(valeur);
    await verifier(page, testInfo, "verifier-apres-verrouillage");
    await champ.fill("0000-0000-0000-0000-0000-0000-0000");
    await expect(bouton(page, "Ouvrir mon coffre avec le code")).toBeDisabled();
    await verifier(page, testInfo, "refus-de-recopie");
    await champ.fill(valeur);
    await champ.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Travailler dans l'application", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await verifier(page, testInfo, "travail-avant-boot");
    if (browserName === "firefox") {
      // L'écran le plus exposé de Firefox : l'étape 4 porte sa limite, le plus long texte d'aide.
      await page.setViewportSize({ width: 320, height: 900 });
      await verifier(page, testInfo, "travail-avant-boot-320");
    }
    await page.emulateMedia({ media: "print" });
    await expect(code).toBeHidden();
    expect(await page.locator("body").textContent()).not.toContain(valeur);
  });
}

test("la direction utilitaire est servie localement et le focus clavier reste visible", async ({
  page,
}) => {
  const tab = "Tab";
  await page.goto("/index.html");
  await expect(
    page.getByRole("heading", { name: "Créer votre coffre", exact: true }),
  ).toBeVisible();
  const style = await page.locator("main").evaluate((node) => {
    const css = getComputedStyle(node);
    return { bord: css.borderTopWidth, rayon: css.borderTopLeftRadius, ombre: css.boxShadow };
  });
  expect(style.bord).toBe("1px");
  expect(style.rayon).toBe("0px");
  expect(style.ombre).toContain("6px 6px");
  await page.keyboard.press(tab);
  await expect(page.getByRole("link", { name: "Aller au parcours" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Créer votre coffre", exact: true }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  const commencer = page.getByRole("button", { name: "Commencer", exact: true });
  await expect(commencer).toBeFocused();
  const contour = await commencer.evaluate((node) => getComputedStyle(node).outlineWidth);
  expect(parseFloat(contour)).toBeGreaterThanOrEqual(3);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Choisir comment l'ouvrir", exact: true }),
  ).toBeFocused();
});
