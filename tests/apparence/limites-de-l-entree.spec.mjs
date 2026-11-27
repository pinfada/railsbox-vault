// Les LIMITES de cette version, sur l'écran d'entrée, sur les trois moteurs (#195, étape 4 du 26/11/2026).
//
// L'épreuve unitaire (`coquille-limites-de-l-entree.test.mjs`) tient les textes ; celle-ci tient ce que la
// PERSONNE voit : sept limites lisibles dès l'écran de création, un lien de détail, rien qui masque le
// geste principal, et aucun défaut d'accessibilité ni de mise en forme ajouté. Aucun coffre n'est créé.

import { LIMITES } from "../../src/coquille/limites-de-cette-version.mjs";
import {
  RAISON_WEBKIT_EPHEMERE,
  bouton,
  expect,
  ouvrir,
  test,
  titre,
  verifierAux,
} from "./outils-d-apparence.mjs";

for (const largeur of [320, 1024]) {
  test(`${largeur} px : l'écran d'entrée dit ce que cette version ne promet pas`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(browserName === "webkit", RAISON_WEBKIT_EPHEMERE);
    await page.setViewportSize({ width: largeur, height: 900 });
    await ouvrir(page);

    const section = page.locator("#limites");
    await expect(section).toBeVisible();
    await expect(
      section.getByRole("heading", { level: 2, name: LIMITES.titre, exact: true }),
    ).toBeVisible();
    const items = section.locator("li");
    await expect(items).toHaveCount(LIMITES.limites.length);
    for (const [rang, { titre: intitule, texte }] of LIMITES.limites.entries()) {
      await expect(items.nth(rang)).toBeVisible();
      await expect(items.nth(rang)).toContainText(intitule);
      await expect(items.nth(rang)).toContainText(texte);
    }
    const lien = section.getByRole("link", { name: LIMITES.detail.libelle, exact: true });
    await expect(lien).toHaveAttribute("href", LIMITES.detail.lien);
    await expect(lien).toHaveAttribute("rel", /noopener/);

    // Rien ne se cache derrière un repli, et le geste principal reste atteignable.
    expect(await section.locator("details").count()).toBe(0);
    await expect(bouton(page, "Commencer")).toBeVisible();

    // Les épreuves d'accessibilité et d'apparence de l'écran de création restent vertes avec la section.
    await verifierAux(page, testInfo, "limites-entree", [largeur]);

    // Elles ne parlent qu'à l'entrée : l'étape suivante n'en porte plus.
    await bouton(page, "Commencer").click();
    await expect(titre(page, "Choisir comment l'ouvrir")).toBeVisible();
    await expect(section).toBeHidden();
  });
}
