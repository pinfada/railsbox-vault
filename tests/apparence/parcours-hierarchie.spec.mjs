// La HIÉRARCHIE de la page, sur les trois moteurs (#266 M3, B2-4) : ce qu'on fait se lit avant ce qu'on
// pourrait savoir, aucun texte ne descend sous 13 px, et un conseil qui change ne déplace pas le bouton
// que la main vise. Aucun coffre n'est créé ici : les écrans 1 et 2 suffisent.

import { PHRASE, bouton, expect, ouvrir, test, titre } from "./outils-d-apparence.mjs";

const LARGEURS = [320, 360, 1280];

const taille = (page, selecteur) =>
  page
    .locator(selecteur)
    .first()
    .evaluate((noeud) => {
      const style = getComputedStyle(noeud);
      return {
        px: parseFloat(style.fontSize),
        poids: Number(style.fontWeight),
        majuscules: style.textTransform,
        couleur: style.color,
      };
    });

for (const largeur of LARGEURS) {
  test(`${largeur} px : l'action se lit avant l'explication, et rien ne descend sous 13 px (M3)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: largeur, height: 900 });
    await ouvrir(page);
    const rang = await taille(page, "#parcours-rang");
    expect(rang.px, "« Étape x sur 9 »").toBeGreaterThanOrEqual(13);
    const explication = await taille(page, "#parcours-ce-qui-va-se-passer");
    const action = await taille(page, "#parcours-attendu");
    expect(explication.px, "l'explication se lit sans effort").toBeGreaterThanOrEqual(16);
    expect(action.px, "l'action domine l'explication").toBeGreaterThanOrEqual(18);
    expect(action.px).toBeGreaterThan(explication.px);
    expect(action.poids, "l'action est appuyée").toBeGreaterThanOrEqual(500);
    expect(action.couleur, "l'action n'est pas grisée comme l'explication").not.toBe(
      explication.couleur,
    );
    await bouton(page, "Commencer").click();
    await expect(titre(page, "Choisir comment l'ouvrir")).toBeVisible();
    const libelle = await taille(page, "label[for='saisie-phrase']");
    expect(libelle.px, "le libellé du champ").toBeGreaterThanOrEqual(14);
    expect(libelle.majuscules, "pas de libellé en capitales").toBe("none");
    const conseil = await taille(page, "#phrase-conseil");
    expect(conseil.px, "le conseil ne domine pas l'explication").toBeLessThanOrEqual(
      (await taille(page, "#parcours-ce-qui-va-se-passer")).px,
    );
  });

  test(`${largeur} px : « Créer mon coffre » ne bouge pas quand le conseil change (B2-4)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: largeur, height: 900 });
    await ouvrir(page);
    await bouton(page, "Commencer").click();
    await expect(titre(page, "Choisir comment l'ouvrir")).toBeVisible();
    const champ = page.getByLabel("Votre phrase", { exact: true });
    const y = async () => Math.round((await bouton(page, "Créer mon coffre").boundingBox()).y);
    const depart = await y();
    const phrasesTypiques = [
      "trop court",
      "douze car-",
      PHRASE,
      `${PHRASE} ${PHRASE} ${PHRASE}`,
      "aaaaaaaaaaaaaaaaaaaa",
      "",
    ];
    for (const phrase of phrasesTypiques) {
      await champ.fill(phrase);
      // Le conseil se pose en direct : on laisse la page se poser avant de mesurer.
      await page.waitForTimeout(250);
      expect(await y(), `bouton après « ${phrase.slice(0, 20)} »`).toBe(depart);
    }
  });
}
