// Les textes ne promettent que ce qui est vrai (#266 Q2, Q3, Q4 ; #242 point 4).

import assert from "node:assert/strict";
import { test } from "node:test";

import { nomDuFichierDeSauvegarde } from "../../src/coquille/gestes-de-portabilite.mjs";
import { texteDeSauvegardePrete } from "../../src/coquille/accueil-de-la-mise-a-jour.mjs";
import {
  CHAMP_DE_LA_TAILLE,
  tailleDeSauvegardeDuMessage,
} from "../../src/coquille/contrat-de-messages.mjs";
import { enMegaoctets } from "../../src/coquille/taille-en-clair.mjs";
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

test("#269 : la sauvegarde dit sa taille avant et après le geste, sans jargon", () => {
  const disque = 547 * 1024 * 1024;
  const avant = MESSAGES.sauvegardeAnnoncee(disque);
  assert.match(avant, /Votre sauvegarde fera environ 547 Mo\./);
  assert.match(avant, /clé USB ou un dossier synchronisé, plutôt qu'une pièce jointe de courriel/);
  const apres = MESSAGES.sauvegardeEnregistree(disque);
  assert.match(apres, /^Sauvegarde de 547 Mo enregistrée dans votre dossier de téléchargements/);
  assert.match(apres, /commence par « coffre- » suivi de la date/);
  for (const texte of [avant, apres]) assert.doesNotMatch(texte, /octet|Mio|AES|GCM|archive/i);
  assert.equal(enMegaoctets(1), 1, "jamais « 0 Mo »");
});

test("#269 : la sauvegarde prête garde sa forme sans chiffre quand la taille est inconnue", () => {
  assert.equal(texteDeSauvegardePrete(false), MESSAGES.sauvegardePrete);
  assert.equal(texteDeSauvegardePrete(false, 0), MESSAGES.sauvegardePrete);
  assert.equal(
    texteDeSauvegardePrete(false, 3 * 1024 * 1024),
    MESSAGES.sauvegardeEnregistree(3 * 1024 * 1024),
  );
  assert.ok(texteDeSauvegardePrete(true, 1024 * 1024).endsWith(MESSAGES.redemarrerApresSauvegarde));
});

test("#269 : seul un entier positif vaut annonce de taille dans la réponse d'inventaire", () => {
  assert.equal(tailleDeSauvegardeDuMessage({ [CHAMP_DE_LA_TAILLE]: 573_000_000 }), 573_000_000);
  for (const faux of [undefined, null, 0, -1, 1.5, "573", Number.NaN]) {
    assert.equal(tailleDeSauvegardeDuMessage({ [CHAMP_DE_LA_TAILLE]: faux }), null, String(faux));
  }
  assert.equal(tailleDeSauvegardeDuMessage(null), null);
});
