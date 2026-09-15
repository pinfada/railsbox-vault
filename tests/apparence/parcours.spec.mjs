import { expect, test } from "../support/test.mjs";
import { instrumenterNavigationFirefox } from "../support/navigation-firefox.mjs";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";

const LARGEURS = [320, 768, 1024, 1440];
const RACINE = "reports/apparence";
const PHRASE = "une phrase publique pour les captures du parcours utilitaire";

function contraste(a, b) {
  const luminance = (rgb) => {
    const composantes = rgb
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return composantes[0] * 0.2126 + composantes[1] * 0.7152 + composantes[2] * 0.0722;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

async function verifier(page, testInfo, nom) {
  const resultats = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  await mkdir(RACINE, { recursive: true });
  const prefixe = `${testInfo.project.name}-${testInfo.title.replaceAll(/[^a-z0-9-]/gi, "-")}-${nom}`;
  await writeFile(
    `${RACINE}/${prefixe}-axe.json`,
    JSON.stringify({ violations: resultats.violations, incomplete: resultats.incomplete }, null, 2),
  );
  expect(resultats.violations, `accessibilité : ${nom}`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
  await page.screenshot({ path: `${RACINE}/${prefixe}.png`, fullPage: true });
}

async function ouvrir(page) {
  await page.goto("/index.html");
  await expect(
    page.getByRole("heading", { name: "Créer votre coffre", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#parcours-attente-annoncee")).not.toHaveText(/calibration/, {
    timeout: 60_000,
  });
}

for (const theme of ["light", "dark"]) {
  for (const largeur of LARGEURS) {
    test(`${theme}-${largeur} : création, choix et restauration accessibles`, async ({
      page,
      browser,
      browserName,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const origines = [];
      page.context().on("request", (request) => origines.push(new URL(request.url()).origin));
      await page.setViewportSize({ width: largeur, height: 900 });
      await ouvrir(page);
      await verifier(page, testInfo, "creation");
      await page.getByRole("button", { name: "Commencer", exact: true }).click();
      await verifier(page, testInfo, "choix");
      expect(
        origines.every((origine) =>
          ["http://127.0.0.1:4205", "http://localhost:4206"].includes(origine),
        ),
      ).toBe(true);
      await expect(
        page.getByRole("heading", { level: 1, name: "RailsBox Vault", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#parcours-attente")).toHaveAttribute("aria-live", "polite");
      await expect(page.getByRole("alert")).toHaveCount(1);
      await page.context().setOffline(true);
      await page.screenshot({
        path: `${RACINE}/${testInfo.project.name}-${theme}-${largeur}-hors-ligne.png`,
        fullPage: true,
      });
      await page.context().setOffline(false);
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
        const restauration = await autreAppareil.newPage();
        instrumenterNavigationFirefox(restauration, {
          browserName,
          annoter: (annotation) => testInfo.annotations.push(annotation),
        });
        await restauration.goto("http://127.0.0.1:4205/index.html");
        await restauration
          .getByRole("button", { name: "J'ai déjà une sauvegarde", exact: true })
          .click();
        await verifier(restauration, testInfo, "restauration");
      } finally {
        await autreAppareil.close();
      }
    });
  }

  test(`${theme} : feuille réelle, impression, confirmation et refus`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await ouvrir(page);
    await page.getByRole("button", { name: "Commencer", exact: true }).click();
    await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await page.getByRole("button", { name: "Créer mon coffre", exact: true }).click();
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
      return;
    }
    await verifier(page, testInfo, "annonce-du-code");
    await page
      .getByRole("button", { name: "Afficher mon code de récupération", exact: true })
      .click();
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
    await expect(
      page.getByRole("button", { name: "J'ai recopié mon code", exact: true }),
    ).toBeHidden();
    await page.screenshot({
      path: `${RACINE}/${testInfo.project.name}-${theme}-impression.png`,
      fullPage: true,
    });
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: "J'ai recopié mon code", exact: true }).click();
    await verifier(page, testInfo, "confirmation");
    await page
      .getByLabel("Code recopié depuis votre feuille", { exact: true })
      .fill("0000-0000-0000-0000-0000-0000-0000");
    await page.getByRole("button", { name: "Confirmer mon code", exact: true }).click();
    await expect(page.getByRole("alert")).not.toBeEmpty();
    await verifier(page, testInfo, "refus-de-recopie");
    await page.getByLabel("Code recopié depuis votre feuille", { exact: true }).fill(valeur);
    await page.getByLabel("Code recopié depuis votre feuille", { exact: true }).press("Enter");
    await expect(
      page.getByRole("heading", { name: "Travailler dans l'application", exact: true }),
    ).toBeVisible();
    await verifier(page, testInfo, "travail-avant-boot");
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
