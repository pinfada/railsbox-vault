// Les épreuves des OUTILS d'apparence eux-mêmes (#290). Axe 4.14 classe en `incomplete`, et non en
// `violations`, une région défilante dont le contenu n'est focalisable que par programme
// (`tabindex="-1"`) : dequelabs/axe-core#5364. `verifier` ne lit que `violations` ; sans durcissement,
// l'exigence `scrollable-region-focusable` (wcag2a) s'affaiblirait en silence.

import { expect, test, verifier } from "./outils-d-apparence.mjs";

const page_ = (corps) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fixture</title></head>` +
  `<body><main><h1>Fixture</h1>${corps}</main></body></html>`;

test("une région défilante dont le contenu n'est focalisable que par programme échoue la vérification", async ({
  page,
}, testInfo) => {
  await page.setContent(
    page_(
      `<div id="zone" tabindex="-1" style="height:40px;overflow:auto">` +
        `<p tabindex="-1">Ligne 1</p><p tabindex="-1">Ligne 2</p><p>Ligne 3</p><p>Ligne 4</p></div>`,
    ),
  );
  await expect(verifier(page, testInfo, "region-non-atteignable")).rejects.toThrow(
    "accessibilité : region-non-atteignable",
  );
});

test("une région défilante dont le contenu est atteignable au clavier passe la vérification", async ({
  page,
}, testInfo) => {
  await page.setContent(
    page_(
      `<div id="zone" tabindex="-1" style="height:40px;overflow:auto">` +
        `<p>Ligne 1</p><button>Action</button><p>Ligne 3</p><p>Ligne 4</p></div>`,
    ),
  );
  await verifier(page, testInfo, "region-atteignable");
});
