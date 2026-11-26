// Les épreuves des OUTILS d'apparence eux-mêmes (#290). Axe 4.14 classe en `incomplete`, et non en
// `violations`, une région défilante dont le contenu n'est focalisable que par programme
// (`tabindex="-1"`) : dequelabs/axe-core#5364. `verifier` ne lit que `violations` ; sans durcissement,
// l'exigence `scrollable-region-focusable` (wcag2a) s'affaiblirait en silence.
//
// Les fixtures sont des littéraux fixes : aucun HTML n'est assemblé par interpolation.

import { poserLeRejetDansLeWorker } from "../support/rejet-opfs-worker.mjs";
import { expect, ouvrir, test, verifier } from "./outils-d-apparence.mjs";

const FIXTURE_NON_ATTEIGNABLE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Fixture</h1><div id="zone" tabindex="-1" style="height:40px;overflow:auto"><p tabindex="-1">Ligne 1</p><p tabindex="-1">Ligne 2</p><p>Ligne 3</p><p>Ligne 4</p></div></main></body></html>`;

const FIXTURE_ATTEIGNABLE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Fixture</h1><div id="zone" tabindex="-1" style="height:40px;overflow:auto"><p>Ligne 1</p><button>Action</button><p>Ligne 3</p><p>Ligne 4</p></div></main></body></html>`;

test("une région défilante dont le contenu n'est focalisable que par programme échoue la vérification", async ({
  page,
}, testInfo) => {
  await page.setContent(FIXTURE_NON_ATTEIGNABLE);
  await expect(verifier(page, testInfo, "region-non-atteignable")).rejects.toThrow(
    "accessibilité : region-non-atteignable",
  );
});

// Axe 4.14 (#5359) range en `incomplete`, avec `messageKey` = `emptyValue`, un champ de saisie VIDE dont le
// contraste échouerait une fois une valeur saisie. `verifier` ne le lisait pas non plus.
const FIXTURE_CHAMP_VIDE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Fixture</h1><label for="nom">Nom</label><input id="nom" type="text" value="" style="color:#d0d0d0;background:#ffffff;border:1px solid #000"></main></body></html>`;

// Axe 4.14 range aussi en `incomplete`, avec `messageKey` = `bgImage`, un texte sur fond image : ce cas n'est
// pas un échec et doit le rester, sinon les vraies pages tomberaient.
const FIXTURE_FOND_IMAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Fixture</h1><p style="color:#444;background:url('data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==') no-repeat;padding:20px">Texte sur fond image</p></main></body></html>`;

test("un champ de saisie vide à contraste insuffisant échoue la vérification (incomplete emptyValue)", async ({
  page,
}, testInfo) => {
  await page.setContent(FIXTURE_CHAMP_VIDE);
  await expect(verifier(page, testInfo, "champ-vide-contraste")).rejects.toThrow(
    "accessibilité : champ-vide-contraste",
  );
});

test("un texte sur fond image, incomplet pour axe (bgImage), ne fait pas échouer la vérification", async ({
  page,
}, testInfo) => {
  await page.setContent(FIXTURE_FOND_IMAGE);
  await verifier(page, testInfo, "fond-image");
});

test("une région défilante dont le contenu est atteignable au clavier passe la vérification", async ({
  page,
}, testInfo) => {
  await page.setContent(FIXTURE_ATTEIGNABLE);
  await verifier(page, testInfo, "region-atteignable");
});

// Aucune SORTIE SILENCIEUSE (revue complète de la PR #305). Sur Chromium et Firefox, un écran « le
// stockage ne répond pas » n'est JAMAIS un résultat acceptable pour une épreuve qui attend l'écran de
// création : `ouvrir` ÉCHOUE. Le contexte WebKit éphémère, où ce rejet est mesuré, est déclaré par la
// fixture (le projet), jamais par ce que la page affiche — et il a ses propres épreuves.
test("sur Chromium et Firefox, un écran « stockage inaccessible » FAIT ÉCHOUER l'ouverture", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit éphémère : le rejet d'getDirectory() est mesuré (docs/compatibility.md) ; l'écran inaccessible a ses épreuves",
  );
  await poserLeRejetDansLeWorker(context, { rejeter: true });
  await expect(ouvrir(page)).rejects.toThrow();
});
