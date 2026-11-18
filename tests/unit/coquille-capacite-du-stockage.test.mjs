import assert from "node:assert/strict";
import test from "node:test";

import {
  ETATS_DE_CAPACITE as E,
  apresLaSonde,
  capaciteInitiale,
  etatPublie,
  peutOuvrir,
  refusDeCapacite,
  reessayable,
} from "../../src/coquille/capacite-du-stockage.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";

// La CAPACITÉ du stockage vue par le Worker de confiance : une petite MACHINE explicite (#231, revue de
// la PR #305). `inconnu` → `disponible` | `indetermine` | `absent` | `panne:<code>`. Seules les
// transitions écrites ci-dessous existent ; toute autre LÈVE. Avant elle, un booléen retombait à faux sur
// la première panne et figeait la reprise : « trois UnknownError, puis un QuotaExceededError » rendait
// `VAULT_STORAGE_UNSUPPORTED`, et plus aucune sonde ne partait.

const QUOTA = STORAGE_ERROR_CODES.quotaExceeded;
const atteignable = { verdict: "atteignable" };
const absente = { verdict: "absente" };
const indetermine = { verdict: "indetermine" };
const panne = (code) => ({ verdict: "panne", code });

test("l'état initial : inconnu quand l'API existe, absent quand elle manque", () => {
  assert.equal(capaciteInitiale({ apiPresente: true }).etat, E.inconnu);
  assert.equal(capaciteInitiale({ apiPresente: false }).etat, E.absent);
});

test("les transitions ÉCRITES depuis `inconnu`, `indetermine` et `panne`", () => {
  for (const depart of [capaciteInitiale({ apiPresente: true })]) {
    assert.equal(apresLaSonde(depart, atteignable).etat, E.disponible);
    assert.equal(apresLaSonde(depart, absente).etat, E.absent);
    assert.equal(apresLaSonde(depart, indetermine).etat, E.indetermine);
    assert.deepEqual(apresLaSonde(depart, panne(QUOTA)), { etat: E.panne, code: QUOTA });
  }
  const enIndetermine = apresLaSonde(capaciteInitiale({ apiPresente: true }), indetermine);
  const enPanne = apresLaSonde(capaciteInitiale({ apiPresente: true }), panne(QUOTA));
  for (const depart of [enIndetermine, enPanne]) {
    assert.equal(apresLaSonde(depart, atteignable).etat, E.disponible, "reprise");
    assert.equal(apresLaSonde(depart, indetermine).etat, E.indetermine);
    assert.equal(apresLaSonde(depart, absente).etat, E.absent);
    assert.deepEqual(
      apresLaSonde(depart, panne(STORAGE_ERROR_CODES.supportFailure)),
      { etat: E.panne, code: STORAGE_ERROR_CODES.supportFailure },
      "une panne au réessai porte SON code précis",
    );
  }
});

test("la séquence du constat : UnknownError ×3, puis QuotaExceededError, puis réussite", () => {
  let capacite = capaciteInitiale({ apiPresente: true });
  capacite = apresLaSonde(capacite, indetermine);
  assert.equal(capacite.etat, E.indetermine);
  capacite = apresLaSonde(capacite, panne(QUOTA));
  assert.equal(capacite.etat, E.panne);
  assert.equal(reessayable(capacite), true, "une panne reste RÉESSAYABLE");
  assert.equal(refusDeCapacite(capacite).code, QUOTA);
  assert.notEqual(refusDeCapacite(capacite).code, STORAGE_ERROR_CODES.unsupported);
  capacite = apresLaSonde(capacite, atteignable);
  assert.equal(peutOuvrir(capacite), true);
});

test("les transitions ABSENTES lèvent : `absent` est terminal, `disponible` n'est pas resondé", () => {
  const absent = capaciteInitiale({ apiPresente: false });
  for (const evenement of [atteignable, absente, indetermine, panne(QUOTA)]) {
    assert.throws(() => apresLaSonde(absent, evenement), /transition/i);
  }
  const disponible = apresLaSonde(capaciteInitiale({ apiPresente: true }), atteignable);
  for (const evenement of [atteignable, absente, indetermine, panne(QUOTA)]) {
    assert.throws(() => apresLaSonde(disponible, evenement), /transition/i);
  }
  const inconnu = capaciteInitiale({ apiPresente: true });
  assert.throws(() => apresLaSonde(inconnu, { verdict: "autre" }), /verdict/i);
  assert.throws(() => apresLaSonde(inconnu, { verdict: "panne" }), /code/i);
});

test("seule la capacité `disponible` ouvre ; seules `indetermine` et `panne` se réessaient", () => {
  const parEtat = {
    [E.inconnu]: capaciteInitiale({ apiPresente: true }),
    [E.disponible]: apresLaSonde(capaciteInitiale({ apiPresente: true }), atteignable),
    [E.indetermine]: apresLaSonde(capaciteInitiale({ apiPresente: true }), indetermine),
    [E.absent]: capaciteInitiale({ apiPresente: false }),
    [E.panne]: apresLaSonde(capaciteInitiale({ apiPresente: true }), panne(QUOTA)),
  };
  for (const [etat, capacite] of Object.entries(parEtat)) {
    assert.equal(peutOuvrir(capacite), etat === E.disponible, etat);
    assert.equal(reessayable(capacite), etat === E.indetermine || etat === E.panne, etat);
  }
});

test("`UNSUPPORTED` n'est rendu que pour une absence ÉTABLIE ; chaque état dit son refus", () => {
  const refus = (capacite) => refusDeCapacite(capacite)?.code ?? null;
  assert.equal(refus(capaciteInitiale({ apiPresente: false })), STORAGE_ERROR_CODES.unsupported);
  assert.equal(
    refus(apresLaSonde(capaciteInitiale({ apiPresente: true }), absente)),
    STORAGE_ERROR_CODES.unsupported,
  );
  assert.equal(
    refus(apresLaSonde(capaciteInitiale({ apiPresente: true }), indetermine)),
    STORAGE_ERROR_CODES.indeterminate,
  );
  assert.equal(refus(apresLaSonde(capaciteInitiale({ apiPresente: true }), panne(QUOTA))), QUOTA);
  assert.equal(refus(apresLaSonde(capaciteInitiale({ apiPresente: true }), atteignable)), null);
  assert.equal(refus(capaciteInitiale({ apiPresente: true })), null);
  for (const evenement of [indetermine, panne(QUOTA)]) {
    const message = refusDeCapacite(
      apresLaSonde(capaciteInitiale({ apiPresente: true }), evenement),
    ).message;
    assert.match(message, /inaccessible pour l'instant|plein|quota/i);
    assert.doesNotMatch(message, /n'offre pas/);
  }
});

test("l'état publié : verrouille / indetermine (indéterminé ET panne) / indisponible", () => {
  const depart = capaciteInitiale({ apiPresente: true });
  assert.equal(etatPublie(apresLaSonde(depart, atteignable)), ETATS_DU_VOLUME.verrouille);
  assert.equal(etatPublie(apresLaSonde(depart, indetermine)), ETATS_DU_VOLUME.indetermine);
  assert.equal(etatPublie(apresLaSonde(depart, panne(QUOTA))), ETATS_DU_VOLUME.indetermine);
  assert.equal(etatPublie(apresLaSonde(depart, absente)), ETATS_DU_VOLUME.indisponible);
  assert.equal(etatPublie(capaciteInitiale({ apiPresente: false })), ETATS_DU_VOLUME.indisponible);
});
