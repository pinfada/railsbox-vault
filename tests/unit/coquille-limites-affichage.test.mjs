/**
 * La RÈGLE d'affichage des limites de la version (#195), jouée comme un comportement : la fonction de
 * `src/` rend un verdict par écran. Cette épreuve ne lit AUCUN document : la campagne de mutation
 * `coquille` la rejoue dans un atelier qui ne recopie pas `docs/`, sur le code que la page exécute.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { limitesAffichees } from "../../src/coquille/limites-de-cette-version.mjs";
import { ECRANS } from "../../src/coquille/parcours.mjs";
import { ECRANS_DE_L_ENTREE } from "../../src/coquille/textes-du-parcours.mjs";

/**
 * LA RÈGLE, écrite : les limites se disent à l'écran de CRÉATION, avant que la personne crée quoi que
 * ce soit. Elles ne reviennent à aucun autre écran — ni à la réouverture, où la personne les a déjà
 * lues et où le champ de la phrase doit rester à l'écran (ADR 0043, R1-bis), ni aux neuf étapes. La
 * décision est une fonction de `src/` : la page ne fait que l'appliquer, et la campagne de mutation
 * peut la retirer.
 */
test("les limites s'affichent à la création, et à aucun autre écran, la réouverture comprise", () => {
  for (const ecranId of Object.keys(ECRANS)) {
    assert.equal(
      limitesAffichees(ecranId),
      ecranId === "creer",
      `l'écran « ${ecranId} » ${ecranId === "creer" ? "doit" : "ne doit pas"} montrer les limites`,
    );
  }
  assert.equal(limitesAffichees("rouvrir"), false);
});

test("les limites ne s'affichent que sur un écran d'entrée, et jamais sur un écran inconnu", () => {
  // Elles sont écrites DANS la promesse : un écran qui les montrerait sans la promesse ne les verrait pas.
  for (const ecranId of Object.keys(ECRANS)) {
    if (limitesAffichees(ecranId)) assert.ok(ECRANS_DE_L_ENTREE.includes(ecranId), ecranId);
  }
  for (const inconnu of [undefined, null, "", "Creer", "creer ", "inconnu"]) {
    assert.equal(limitesAffichees(inconnu), false, String(inconnu));
  }
});
