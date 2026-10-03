// Les textes ne promettent que ce qui est vrai (#266 Q2, Q3, Q4 ; #242 point 4).

import assert from "node:assert/strict";
import { test } from "node:test";

import { nomDuFichierDeSauvegarde } from "../../src/coquille/gestes-de-portabilite.mjs";
import { ECRANS, MESSAGES } from "../../src/coquille/textes-du-parcours.mjs";

test("Q3 : un coffre sans passkey n'entend jamais parler de passkey", () => {
  for (const moyen of ["phrase", "recuperation"]) {
    const texte = MESSAGES.avertissementDeRevocation(moyen, ["phrase", "recuperation"]);
    assert.doesNotMatch(texte, /passkey/, texte);
  }
  assert.match(
    MESSAGES.avertissementDeRevocation("recuperation", ["phrase", "recuperation"]),
    /Votre phrase ne fonctionnera plus sur ce coffre/,
  );
  assert.match(
    MESSAGES.avertissementDeRevocation("phrase", ["phrase", "recuperation"]),
    /Vos codes de récupération ne fonctionneront plus : votre feuille/,
  );
});

test("Q3 : un coffre qui a une passkey la nomme", () => {
  const texte = MESSAGES.avertissementDeRevocation("recuperation", [
    "phrase",
    "webauthn-prf",
    "recuperation",
  ]);
  assert.match(texte, /Votre phrase et votre passkey ne fonctionneront plus/);
});

test("Q3 : « Terminer sans révoquer » ne nomme aucun moyen absent", () => {
  assert.doesNotMatch(Object.values(ECRANS["termine-sans-revoquer"]).join(" "), /passkey/);
});

test("Q2 : la sauvegarde ne promet pas un nom exact, et le nom proposé est daté", () => {
  assert.doesNotMatch(MESSAGES.sauvegardePrete, /coffre\.rbvault/);
  assert.equal(nomDuFichierDeSauvegarde(new Date(2026, 9, 3)), "coffre-2026-10-03.rbvault");
});

test("Q4 : l'écran de l'application après la visite n'annonce pas l'installation comme certaine", () => {
  assert.doesNotMatch(ECRANS.accueil.attente, /^Le premier démarrage installe/);
  assert.match(ECRANS.accueil.attente, /moins de trente secondes/);
});
