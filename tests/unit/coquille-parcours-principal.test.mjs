// UN bouton principal visible par écran du parcours (#266 M1).
//
// La table `PRINCIPAL_DE_L_ECRAN` désigne le principal ; ce test vérifie, écran par écran, qu'il est
// un bouton du document, porté par un bloc que l'écran MONTRE. Un écran sans principal l'assume en
// figurant dans `SANS_PRINCIPAL`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ECRANS, PRINCIPAL_DE_L_ECRAN } from "../../src/coquille/textes-du-parcours.mjs";

const PAGE = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

/** Les écrans qui n'offrent AUCUN geste principal, et pourquoi. */
const SANS_PRINCIPAL = Object.freeze({
  chargement: "rien à faire : la page vérifie l'appareil",
  refuse: "le message dit quoi faire hors de la page",
  "travailler-sans-application": "la limite de Firefox : le geste est d'ouvrir un autre navigateur",
});

/** Le bloc (`data-bloc`) qui contient le bouton, ou `null` s'il est hors de tout bloc. */
function blocDuBouton(id) {
  const position = PAGE.indexOf(`id="${id}"`);
  if (position < 0) return undefined;
  const avant = PAGE.slice(0, position);
  const ouvertures = [...avant.matchAll(/<div data-bloc="([^"]+)"/g)];
  for (const ouverture of ouvertures.reverse()) {
    const fermetures = avant.slice(ouverture.index).match(/<\/div>/g)?.length ?? 0;
    const internes = avant.slice(ouverture.index + 1).match(/<div[\s>]/g)?.length ?? 0;
    if (fermetures <= internes) return ouverture[1];
  }
  return null;
}

for (const ecranId of Object.keys(ECRANS)) {
  test(`l'écran « ${ecranId} » a exactement un bouton principal visible, ou l'assume`, () => {
    const principal = PRINCIPAL_DE_L_ECRAN[ecranId];
    if (principal === undefined) {
      assert.ok(ecranId in SANS_PRINCIPAL, `l'écran ${ecranId} n'a aucun principal désigné`);
      return;
    }
    assert.equal(typeof principal, "string", "un seul identifiant, donc un seul principal");
    const bloc = blocDuBouton(principal);
    assert.notEqual(bloc, undefined, `#${principal} n'existe pas dans index.html`);
    if (bloc === null) return;
    assert.ok(
      ECRANS[ecranId].blocs.includes(bloc),
      `#${principal} est dans le bloc « ${bloc} », que l'écran ${ecranId} ne montre pas`,
    );
  });
}
