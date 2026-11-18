/**
 * Les ÉTATS DE FRAÎCHEUR de la réserve (#299, ADR 0048 § 8) : une fonction pure, qui dit ce qui a été
 * OBSERVÉ, jamais plus. Priorité : le fait connu avant l'incertitude.
 *
 * Gardes éprouvées : 24 (une attente MUETTE n'est jamais « prête »), 25 (une version plus ancienne ou
 * différente n'est jamais « plus récente »), et l'effet de chaque état sur le portail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ETATS_DE_FRAICHEUR as E, etatDeFraicheur } from "../../src/coquille/reserve-fraicheur.mjs";

const COURANTE = 5;
const base = { maj: "ok", attente: null, sequenceCourante: COURANTE };
const attente = (surcharges = {}) => ({
  sequence: 6,
  plancher: 0,
  retrait: false,
  muet: false,
  ...surcharges,
});

test("les sept états et le nominal existent, avec un identifiant et un texte qui dit ce qui a été observé", () => {
  assert.deepEqual(Object.keys(E).sort(), [
    "ATTENTE_MUETTE",
    "EN_COURS",
    "MISE_A_JOUR_PRETE",
    "NON_VERIFIABLE",
    "REVOCATION_CONNUE",
    "VERIFICATION_ECHOUEE",
    "VERIFIEE",
    "VERSION_DIFFERENTE",
  ]);
  const ids = new Set(Object.values(E).map((etat) => etat.id));
  assert.equal(ids.size, 8, "huit identifiants distincts");
  for (const etat of Object.values(E)) assert.ok(etat.texte.length > 20, etat.id);
});

test("1 · un Worker en attente IDENTIFIÉ au plancher supérieur à la séquence courante : révocation connue, le portail REFUSE", () => {
  const etat = etatDeFraicheur({ ...base, attente: attente({ plancher: COURANTE + 1 }) });
  assert.equal(etat, E.REVOCATION_CONNUE);
  assert.equal(etat.effet, "refuse");
  assert.equal(etat.cause, "plancher");
  assert.match(etat.texte, /retirée par son éditeur/);
  assert.match(etat.texte, /Fermez toutes les fenêtres du coffre, puis rouvrez-le/);
});

test("1 · un script de RETRAIT en attente : révocation connue, cause `retrait`", () => {
  const etat = etatDeFraicheur({ ...base, attente: attente({ retrait: true, sequence: 0 }) });
  assert.equal(etat, E.REVOCATION_CONNUE);
  assert.equal(etat.cause, "retrait");
});

test("un plancher ÉGAL à la séquence courante n'est pas une révocation (seul le supérieur l'est)", () => {
  assert.notEqual(
    etatDeFraicheur({ ...base, attente: attente({ plancher: COURANTE }) }),
    E.REVOCATION_CONNUE,
  );
});

test("2 · une attente MUETTE n'est PAS « prête » : non vérifiable, jamais « plus récente » (garde 24)", () => {
  const etat = etatDeFraicheur({ ...base, attente: { muet: true } });
  assert.equal(etat, E.ATTENTE_MUETTE);
  assert.equal(etat.effet, "autorise");
  assert.match(etat.texte, /n'a pas pu être identifiée/);
  assert.match(etat.texte, /Impossible de savoir si cette version a été retirée/);
  assert.doesNotMatch(etat.texte, /plus récente/);
});

test("3 · attente identifiée, séquence supérieure, plancher ≤ courante : mise à jour prête, annoncée par l'éditeur", () => {
  const etat = etatDeFraicheur({ ...base, attente: attente({ sequence: 6, plancher: COURANTE }) });
  assert.equal(etat, E.MISE_A_JOUR_PRETE);
  assert.equal(etat.effet, "autorise");
  assert.match(etat.texte, /L'éditeur annonce une version plus récente/);
});

test("4 · une version EN ATTENTE de séquence égale ou inférieure n'est JAMAIS « plus récente » (garde 25)", () => {
  for (const sequence of [COURANTE, COURANTE - 1, 1, 0]) {
    const etat = etatDeFraicheur({ ...base, attente: attente({ sequence }) });
    assert.equal(etat, E.VERSION_DIFFERENTE, `séquence ${sequence}`);
    assert.equal(etat.effet, "autorise");
    assert.doesNotMatch(
      etat.texte.replace("n'est pas plus récente", ""),
      /plus récente/,
      `séquence ${sequence}`,
    );
    assert.match(etat.texte, /à vérifier auprès de l'éditeur/);
  }
});

test("5 · une version différente apparue dont l'installation a été REJETÉE : vérification échouée", () => {
  assert.equal(etatDeFraicheur({ ...base, maj: "rejetee" }), E.VERIFICATION_ECHOUEE);
});

test("6 · `update()` rejetée (réseau, 4xx, 5xx), délai dépassé ou non tentée : version courante non vérifiable, jamais « à jour »", () => {
  for (const maj of ["echec", "delai", "non-tentee"]) {
    const etat = etatDeFraicheur({ ...base, maj });
    assert.equal(etat, E.NON_VERIFIABLE, maj);
    assert.equal(etat.effet, "autorise");
    assert.doesNotMatch(etat.texte, /à jour|vérifiée/);
  }
});

test("7 · une vérification non réglée : en cours, le portail attend (borné)", () => {
  assert.equal(etatDeFraicheur({ ...base, maj: "en-cours" }), E.EN_COURS);
  assert.equal(E.EN_COURS.effet, "attend");
});

test("nominal · `update()` résolue, rien de nouveau, rien de rejeté : version vérifiée (preuve non signée)", () => {
  const etat = etatDeFraicheur(base);
  assert.equal(etat, E.VERIFIEE);
  assert.match(etat.texte, /preuve non signée/);
});

test("PRIORITÉ : le fait connu avant l'incertitude — une révocation l'emporte sur un échec de mise à jour, l'attente muette sur la vérification échouée", () => {
  assert.equal(
    etatDeFraicheur({
      maj: "echec",
      attente: attente({ plancher: 9 }),
      sequenceCourante: COURANTE,
    }),
    E.REVOCATION_CONNUE,
  );
  assert.equal(
    etatDeFraicheur({ maj: "rejetee", attente: { muet: true }, sequenceCourante: COURANTE }),
    E.ATTENTE_MUETTE,
  );
  assert.equal(
    etatDeFraicheur({
      maj: "echec",
      attente: attente({ sequence: 6 }),
      sequenceCourante: COURANTE,
    }),
    E.MISE_A_JOUR_PRETE,
  );
  assert.equal(
    etatDeFraicheur({ maj: "en-cours", attente: null, sequenceCourante: COURANTE }),
    E.EN_COURS,
  );
});

test("seul l'état 1 refuse ; les autres autorisent ou attendent", () => {
  const refus = Object.values(E).filter((etat) => etat.effet === "refuse");
  assert.deepEqual(refus, [E.REVOCATION_CONNUE]);
});
