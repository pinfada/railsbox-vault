import assert from "node:assert/strict";
import test from "node:test";
import { ECRANS } from "../../src/coquille/textes-du-parcours.mjs";

import {
  CLASSEMENT_DES_CONDUITES,
  CLASSES_DE_CONDUITE,
  conduiteHumaine,
} from "../../src/coquille/conduites-du-parcours.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "../../src/coquille/refus-de-coquille.mjs";

for (const code of [
  CODES_REFUS_COQUILLE.coffreAnterieur,
  CODES_REFUS_COQUILLE.disqueDUnAutreCoffre,
]) {
  test(`${code} : conserver les données est la conduite, jamais effacer pour mettre à jour`, () => {
    for (const texte of [messageDeRefus(code), conduiteHumaine(code)]) {
      assert.match(texte, /N'effacez pas les données de ce site/);
      assert.match(texte, /sauvegarde/);
      assert.match(texte, /autre (navigateur|appareil)/);
      assert.doesNotMatch(texte, /supprimez-le|repartir de zéro|effacez les données/);
    }
    assert.equal(CLASSEMENT_DES_CONDUITES[code], CLASSES_DE_CONDUITE.autre);
  });
}

test("l'accueil annonce le statut expérimental et les conditions de protection", () => {
  assert.match(ECRANS.creer.ceQuiVaSePasser, /expérimentale/);
  assert.match(ECRANS.creer.ceQuiVaSePasser, /données d'essai/);
  assert.match(ECRANS.creer.ceQuiVaSePasser, /navigateur et de la version/);
  assert.doesNotMatch(ECRANS.creer.ceQuiVaSePasser, /Personne d'autre/);
});
