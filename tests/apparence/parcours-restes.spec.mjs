// Les RESTES du parcours, sur la coquille réelle sans machine virtuelle — Chromium seul (#266 m7, B2-4,
// B2-7). Chaque épreuve est née rouge, sur `main`, avant le correctif.

import {
  LONG,
  PHRASE,
  afficherLeCode,
  bouton,
  eprouverLaFeuille,
  expect,
  jusquAuTravail,
  test,
  titre,
  verrouillerEtRecharger,
} from "./outils-d-apparence.mjs";

test("m7 : avant tout démarrage, la carte de l'étape 4 reste à la largeur des autres écrans", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await jusquAuTravail(page);
  await expect(titre(page, "Travailler dans l'application")).toBeVisible();
  const carte = await page.locator("main").boundingBox();
  expect(carte.width, "la moitié droite d'une carte de 1024 px serait vide").toBeLessThanOrEqual(
    520,
  );
});

for (const largeur of [360, 1280]) {
  test(`B2-4 (${largeur} px) : « Ouvrir mon coffre avec le code » ne bouge pas, code incomplet, faux ou juste`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: largeur, height: 900 });
    const { code } = await afficherLeCode(page);
    await bouton(page, "J'ai recopié mon code").click();
    await verrouillerEtRecharger(page);
    const champ = page.getByLabel("Code de récupération", { exact: true });
    await expect(champ).toBeVisible({ timeout: 60_000 });
    const ouvrir = bouton(page, "Ouvrir mon coffre avec le code");
    const y = async () => Math.round((await ouvrir.boundingBox()).y);
    const depart = await y();
    const faux = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    for (const saisie of [code.slice(0, 20), faux, code, "", faux]) {
      await champ.fill(saisie);
      await page.waitForTimeout(250);
      expect(await y(), `bouton après « ${saisie.slice(0, 8)}… »`).toBe(depart);
    }
  });
}

test("B2-7 : un numéro de feuille qui n'en est pas un se dit au champ, avant le clic", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  const feuille = await afficherLeCode(page);
  await eprouverLaFeuille(page, feuille.code);
  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await verrouillerEtRecharger(page);
  await expect(titre(page, "Rouvrir votre coffre")).toBeVisible(LONG);
  const ancre = page.getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", {
    exact: true,
  });
  // La phrase, tapée dans le champ du numéro : l'erreur que la recette a vue.
  await ancre.fill(PHRASE);
  await expect(ancre).toHaveAttribute("aria-invalid", "true");
  const decrit = (await ancre.getAttribute("aria-describedby")) ?? "";
  expect(decrit).not.toBe("");
  const message = page.locator(`#${decrit.split(" ")[0]}`);
  await expect(message).toBeVisible();
  await expect(message).toContainText("numéro de feuille");
  await expect(message).toContainText("nombre");
  await expect(message).not.toContainText("version");
  // Corrigé, le message s'efface et le champ n'est plus marqué.
  await ancre.fill("2");
  await expect(ancre).not.toHaveAttribute("aria-invalid", "true");
  await expect(message).toBeHidden();
  // Vide : un choix, pas une erreur.
  await ancre.fill("");
  await expect(ancre).not.toHaveAttribute("aria-invalid", "true");
});
