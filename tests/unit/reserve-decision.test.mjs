/**
 * La DÉCISION PURE du portail (#299, ADR 0048 § 7, étape 4) : ce qu'elle nomme, dans l'ordre. Elle ne SUFFIT
 * pas (la dernière garde relit l'état partagé dans le même tour), mais elle est la voix du refus : le code et la
 * cause viennent d'ici. Les gardes 21 (vérification, poignée de séquence, révocation, SW muet) y sont éprouvées
 * directement, sur la fonction de production.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { decider } from "../../src/coquille/reserve-decision.mjs";
import { ETATS_DE_FRAICHEUR as E } from "../../src/coquille/reserve-fraicheur.mjs";

const SEQ = 5;
const sain = () => ({
  sequencePage: SEQ,
  identite: { sequence: SEQ, plancher: 0, retrait: false },
  verification: { ok: true, manquants: [], alteres: [] },
  fraicheur: E.VERIFIEE,
  causeDeRevocation: null,
  controleurChange: false,
});
const refus = (surcharges) => decider({ ...sain(), ...surcharges });

test("tout est sain : autorisé, sans code ni cause", () => {
  assert.deepEqual(decider(sain()), { autorise: true, code: null, cause: null });
});

test("un SW muet (identité absente, vérification absente) : RESERVE_ABSENTE (silence-du-sw)", () => {
  for (const surcharges of [
    { identite: null },
    { identite: undefined },
    { verification: null },
    { verification: undefined },
  ]) {
    const d = refus(surcharges);
    assert.equal(d.autorise, false);
    assert.equal(d.code, C.reserveAbsente);
    assert.equal(d.cause, "silence-du-sw");
  }
});

test("un script de retrait actif : RESERVE_PERIMEE (retrait)", () => {
  const d = refus({ identite: { sequence: 0, plancher: 0, retrait: true } });
  assert.deepEqual([d.code, d.cause], [C.reservePerimee, "retrait"]);
});

test("un contrôleur changé : RESERVE_DIVERGENTE (controleur-change)", () => {
  const d = refus({ controleurChange: true });
  assert.deepEqual([d.code, d.cause], [C.reserveDivergente, "controleur-change"]);
});

test("une séquence du contrôleur différente de celle de la page : RESERVE_DIVERGENTE (sequence), dans les deux sens", () => {
  for (const sequence of [SEQ - 1, SEQ + 1]) {
    const d = refus({ identite: { sequence, plancher: 0, retrait: false } });
    assert.deepEqual([d.code, d.cause], [C.reserveDivergente, "sequence"], String(sequence));
  }
});

test("un contrôleur ACTIF au plancher supérieur à la séquence de la page : RESERVE_PERIMEE (plancher) ; égal, non", () => {
  const d = refus({ identite: { sequence: SEQ, plancher: SEQ + 1, retrait: false } });
  assert.deepEqual([d.code, d.cause], [C.reservePerimee, "plancher"]);
  assert.equal(
    refus({ identite: { sequence: SEQ, plancher: SEQ, retrait: false } }).autorise,
    true,
  );
});

test("entrées manquantes : RESERVE_INCOMPLETE avec le détail ; altérées : RESERVE_ALTEREE avec le détail", () => {
  const manquantes = refus({ verification: { manquants: ["/a.mjs"], alteres: [] } });
  assert.deepEqual(
    [manquantes.code, manquantes.cause, manquantes.detail],
    [C.reserveIncomplete, "entrees-manquantes", ["/a.mjs"]],
  );
  const alterees = refus({ verification: { manquants: [], alteres: ["/b.mjs"] } });
  assert.deepEqual(
    [alterees.code, alterees.cause, alterees.detail],
    [C.reserveAlteree, "entrees-alterees", ["/b.mjs"]],
  );
});

test("une révocation CONNUE (état de fraîcheur) : RESERVE_PERIMEE avec sa cause ; sans cause fournie, `plancher`", () => {
  const retrait = refus({ fraicheur: E.REVOCATION_CONNUE, causeDeRevocation: "retrait" });
  assert.deepEqual([retrait.code, retrait.cause], [C.reservePerimee, "retrait"]);
  const plancher = refus({ fraicheur: E.REVOCATION_CONNUE, causeDeRevocation: null });
  assert.deepEqual([plancher.code, plancher.cause], [C.reservePerimee, "plancher"]);
  // Les autres états n'empêchent rien : « jamais plus que ce qui a été observé ».
  for (const etat of Object.values(E).filter((e) => e !== E.REVOCATION_CONNUE)) {
    assert.equal(refus({ fraicheur: etat }).autorise, true, etat.id);
  }
});

test("PRIORITÉ des refus : silence, retrait, contrôleur, séquence, plancher, manquantes, altérées, révocation", () => {
  const tout = {
    identite: { sequence: SEQ + 1, plancher: SEQ + 9, retrait: false },
    verification: { manquants: ["/a"], alteres: ["/b"] },
    fraicheur: E.REVOCATION_CONNUE,
    controleurChange: true,
  };
  assert.equal(refus(tout).cause, "controleur-change");
  assert.equal(refus({ ...tout, controleurChange: false }).cause, "sequence");
  assert.equal(
    refus({
      ...tout,
      controleurChange: false,
      identite: { sequence: SEQ, plancher: SEQ + 9, retrait: false },
    }).cause,
    "plancher",
  );
  assert.equal(
    refus({ ...tout, controleurChange: false, identite: sain().identite }).cause,
    "entrees-manquantes",
  );
  assert.equal(
    refus({
      ...tout,
      controleurChange: false,
      identite: sain().identite,
      verification: { manquants: [], alteres: ["/b"] },
    }).cause,
    "entrees-alterees",
  );
});
