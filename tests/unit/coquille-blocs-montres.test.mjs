// Ce qui disparaît de l'écran n'y laisse pas de demande de révocation périmée (#265, relecture de
// #308). Épreuve de COMPORTEMENT sur `montrerLesBlocs`, la fonction que la page appelle à chaque
// rendu : la confirmation ouverte est oubliée dans le MÊME appel où son bloc est caché.

import assert from "node:assert/strict";
import { test } from "node:test";

import { montrerLesBlocs } from "../../src/coquille/blocs-montres.mjs";
import { pageFactice } from "./support-page-factice.mjs";

const RELEVE = { moyenDOuverture: "phrase", moyensProposes: ["phrase"], nombreDeCodes: 0 };

/** Une page où le bloc de la révocation porte la confirmation, parmi d'autres blocs. */
function ecran() {
  const page = pageFactice();
  page.bloc.dataset = { bloc: "revocation" };
  const autre = { dataset: { bloc: "sauvegarde" }, hidden: false };
  const doc = { querySelectorAll: () => [autre, page.bloc] };
  const rendre = (visibles, { vueComplete = false } = {}) =>
    montrerLesBlocs({
      doc,
      noeud: (id) => (id.startsWith("revo") ? page.noeud(id) : null),
      visibles,
      vueComplete,
      dire: () => {},
      releve: RELEVE,
    });
  return { page, rendre };
}

function ouvrir(page) {
  page.noeud("revocation-confirmation").hidden = false;
  page.noeud("revoquer-en-urgence").setAttribute("aria-expanded", "true");
}

test("bloc visible : la demande ouverte reste ouverte", () => {
  const { page, rendre } = ecran();
  ouvrir(page);
  rendre(["revocation", "sauvegarde"]);
  assert.equal(page.bloc.hidden, false);
  assert.equal(page.noeud("revocation-confirmation").hidden, false);
});

test("l'étape change, le bloc est caché : la demande est oubliée dans le même rendu, sans déplacer le focus", () => {
  const { page, rendre } = ecran();
  ouvrir(page);
  rendre(["sauvegarde"]);
  assert.equal(page.bloc.hidden, true);
  assert.equal(page.noeud("revocation-confirmation").hidden, true);
  assert.equal(page.noeud("revoquer-en-urgence").getAttribute("aria-expanded"), "false");
  assert.equal(page.actif, null);
});

test("le bloc réapparaît : la confirmation n'est pas rouverte, aucune demande périmée ne survit", () => {
  const { page, rendre } = ecran();
  ouvrir(page);
  rendre(["sauvegarde"]);
  rendre(["revocation"]);
  assert.equal(page.bloc.hidden, false);
  assert.equal(page.noeud("revocation-confirmation").hidden, true);
});

test("vue complète (harnais) : rien n'est caché, rien n'est oublié", () => {
  const { page, rendre } = ecran();
  ouvrir(page);
  rendre(["sauvegarde"], { vueComplete: true });
  assert.equal(page.bloc.hidden, false);
  assert.equal(page.noeud("revocation-confirmation").hidden, false);
});

test("les blocs non listés sont cachés, les listés montrés", () => {
  const { page, rendre } = ecran();
  rendre(["revocation"]);
  assert.equal(page.bloc.hidden, false);
});
