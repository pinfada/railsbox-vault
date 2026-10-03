// LE PREMIER CLIC sur l'entrée, et la saisie qui ne déplace rien (#266 Q1, S2).
//
// Recette du 2-3/10/2026 dans Chrome : au premier écran, « Commencer » n'avait pas son style
// principal avant une première interaction, et le premier clic restait sans effet. À l'étape 3, la
// ligne « Code complet » apparaissait pendant la saisie et faisait descendre le bouton juste avant le
// clic. Ces épreuves cliquent UNE fois, et mesurent le bouton entre la dernière frappe et le clic.

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const DELAI = 90_000;
const PHRASE = "marqueur-de-phrase-du-parcours-266-une-phrase-assez-longue";
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });

test.describe("le rendu initial et la saisie (#266 Q1, S2)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Défaut relevé dans Chrome");

  test("un SEUL clic sur « Commencer », juste après le chargement, mène à l'écran suivant", async ({
    page,
  }) => {
    await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
    const commencer = bouton(page, "Commencer");
    await expect(commencer).toBeVisible({ timeout: DELAI });
    // L'état final est rendu AVANT toute interaction : le bouton principal est déjà marqué.
    await expect(commencer).toHaveAttribute("data-principal", "");
    await commencer.click();
    await expect(page.getByLabel("Votre phrase", { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test("un SEUL clic sur « J'ai déjà une sauvegarde » mène à l'écran suivant", async ({ page }) => {
    await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
    const sauvegarde = bouton(page, "J'ai déjà une sauvegarde");
    await expect(sauvegarde).toBeVisible({ timeout: DELAI });
    await sauvegarde.click();
    await expect(ecran(page, "Créer votre coffre")).toBeHidden({ timeout: 5_000 });
  });

  test("taper le code ne déplace pas « Ouvrir mon coffre avec le code » avant le clic", async ({
    page,
  }) => {
    await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
    await bouton(page, "Commencer").click({ timeout: DELAI });
    await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await bouton(page, "Créer mon coffre").click();
    await bouton(page, "Afficher mon code de récupération").click({ timeout: DELAI });
    const code = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
    await bouton(page, "J'ai recopié mon code").click();
    // #266 M1 : « Verrouiller » est LE principal, y compris sous le pointeur ; « Revoir » ne l'est pas.
    const verrouiller = bouton(page, "Verrouiller mon coffre");
    await expect(verrouiller).toHaveAttribute("data-principal", "");
    await expect(bouton(page, "Revoir mon code")).not.toHaveAttribute("data-principal");
    await verrouiller.hover();
    const fond = (l) => l.evaluate((b) => getComputedStyle(b).backgroundColor);
    expect(await fond(verrouiller)).not.toBe(await fond(bouton(page, "Revoir mon code")));
    const recharge = page.waitForEvent("load");
    await verrouiller.click();
    await recharge;
    const champ = page.getByLabel("Code de récupération", { exact: true });
    await expect(champ).toBeVisible({ timeout: DELAI });
    const ouvrir = bouton(page, "Ouvrir mon coffre avec le code");
    const avant = await ouvrir.boundingBox();
    await champ.pressSequentially(code.replaceAll("-", ""));
    await expect(page.locator("#parcours-code-lu")).not.toHaveText("");
    const apres = await ouvrir.boundingBox();
    expect(apres).toEqual(avant);
    await ouvrir.click();
    await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  });
});
