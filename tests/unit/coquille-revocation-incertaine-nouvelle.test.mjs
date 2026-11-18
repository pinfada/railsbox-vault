// Relecture de la PR #308 (REFUSÉ aefe2d1), point 1 : une NOUVELLE annulation ne contredit pas une
// révocation incertaine. Choix : pendant `incertaine`, aucune nouvelle révocation n'est offerte avant
// la vérification (réouverture du coffre) — il n'y a donc pas de nouvelle confirmation à annuler.
//
// Chaque épreuve est née rouge, avant le correctif.

import assert from "node:assert/strict";
import { test } from "node:test";

import { creerEtatDeRevocation } from "../../src/coquille/etat-de-la-revocation.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { MESSAGES } from "../../src/coquille/textes-du-parcours.mjs";
import { pageFactice } from "./support-page-factice.mjs";

const apres = () => new Promise((rendre) => setTimeout(rendre, 0));

function monter(revocation = creerEtatDeRevocation()) {
  const page = pageFactice();
  const envoyes = [];
  let finir = null;
  brancherLesGestesDePortabilite({
    revocation,
    racine: page.racine,
    demander: (type) => {
      if (type !== "revoquerEnUrgence") return Promise.resolve({});
      envoyes.push(type);
      return new Promise((rendre, refuser) => {
        finir = { rendre, refuser };
      });
    },
    rapport: {},
    publier: () => {},
    enregistrer: () => {},
  });
  return { page, revocation, envois: () => envoyes.length, finir: () => finir };
}

/** Une révocation partie, dont l'issue est INCERTAINE. */
async function incertaine() {
  const m = monter();
  m.page.noeud("revoquer-en-urgence").click();
  m.page.noeud("revoquer-confirmer").click();
  await apres();
  m.finir().refuser({ code: CODES_REFUS_COQUILLE.workerMort });
  await apres();
  assert.equal(m.revocation.phase(), "incertaine");
  return m;
}

test("incertaine → rouvrir : la confirmation ne s'ouvre pas ; la raison est dite", async () => {
  const m = await incertaine();
  m.page.noeud("revoquer-en-urgence").click();
  await apres();
  assert.equal(
    m.page.noeud("revocation-confirmation").hidden,
    true,
    "aucune nouvelle confirmation",
  );
  const dit = m.page.noeud("revocation-etat").textContent;
  assert.equal(dit, MESSAGES.revocationAVerifier);
  assert.match(dit, /peut-être eu lieu/);
  assert.match(dit, /Rouvrez votre coffre/);
});

test("incertaine → rouvrir → Annuler / Échap : jamais « Rien n'a été révoqué », aucun message de plus", async () => {
  const m = await incertaine();
  m.page.noeud("revoquer-en-urgence").click();
  // « Annuler » et Échap n'ont rien à annuler : la confirmation n'existe pas.
  m.page.noeud("revoquer-annuler").emettre("click");
  m.page.noeud("revocation-confirmation").emettre("keydown", { key: "Escape" });
  await apres();
  for (const id of ["revocation-etat", "parcours-incertitude", "portabilite-refus"]) {
    assert.doesNotMatch(m.page.noeud(id).textContent, /Rien n'a été révoqué|ouvre toujours/, id);
  }
  assert.equal(m.page.noeud("parcours-incertitude").textContent, MESSAGES.revocationIncertaine);
  assert.equal(m.envois(), 1, "aucun second message");
});

test("incertaine : le geste se dit fermé (aria-disabled), un clic synthétique ne l'ouvre pas non plus", async () => {
  const m = await incertaine();
  assert.equal(m.page.noeud("revoquer-en-urgence").getAttribute("aria-disabled"), "true");
  m.page.noeud("revoquer-en-urgence").emettre("click");
  m.page.noeud("revoquer-confirmer").emettre("click");
  await apres();
  assert.equal(m.page.noeud("revocation-confirmation").hidden, true);
  assert.equal(m.envois(), 1);
});

test("après la vérification (réouverture : un état neuf), la révocation s'offre de nouveau et s'annule honnêtement", async () => {
  const m = monter(creerEtatDeRevocation());
  m.page.noeud("revoquer-en-urgence").click();
  assert.equal(m.page.noeud("revocation-confirmation").hidden, false);
  m.page.noeud("revoquer-annuler").click();
  assert.equal(m.page.noeud("revocation-etat").textContent, MESSAGES.revocationAnnulee);
});
