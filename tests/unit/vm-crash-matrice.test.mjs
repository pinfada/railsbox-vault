import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNAIS_RESILIENCE_ENV,
  HARNAIS_RESILIENCE_VALEUR,
} from "../../src/vm/crash-harness.mjs";
import { rejouerCoupure, rejouerMatrice } from "../../src/vm/crash-machine.mjs";
import { VERDICTS } from "../../src/vm/crash-oracle.mjs";
import { CRASH_KINDS } from "../../src/vm/crash-plan.mjs";
import { RESILIENCE_REPORT_VERSION, resumerMatrice } from "../../src/vm/crash-report.mjs";
import { BARRIERE_TOUS_LES, BLOCS_SUIVIS } from "../../src/vm/crash-scenario.mjs";

// Ce fichier arme l'injecteur : il pose donc la variable du harnais, comme le ferait
// `npm run test:vm`. Le refus hors harnais est figé par `vm-crash-harnais.test.mjs`, dans son
// propre processus.
process.env[HARNAIS_RESILIENCE_ENV] = HARNAIS_RESILIENCE_VALEUR;

const point = (kind, operation, occurrence, bytes = null) =>
  Object.freeze({ graine: 0, index: 0, kind, operation, occurrence, bytes });

test("couper à la toute première écriture laisse le volume à l'ancien état", async () => {
  const rapport = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 1));
  assert.equal(rapport.verdict, VERDICTS.ancien);
  assert.equal(rapport.atomique, true);
  assert.equal(rapport.classes.ancien, BLOCS_SUIVIS);
});

test("couper à la dernière barrière laisse le volume au nouvel état", async () => {
  const barrieres = Math.ceil(BLOCS_SUIVIS / BARRIERE_TOUS_LES);
  const rapport = await rejouerCoupure(point(CRASH_KINDS.beforeBarrier, "flush", barrieres));
  assert.equal(rapport.verdict, VERDICTS.nouveau);
  assert.equal(rapport.atomique, true);
});

test("couper au milieu des écritures laisse anciens et nouveaux blocs cohabiter", async () => {
  const rapport = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 5));
  assert.equal(rapport.verdict, VERDICTS.melange);
  assert.equal(rapport.atomique, false);
  assert.equal(rapport.classes.nouveau, 4);
  assert.equal(rapport.classes.ancien, BLOCS_SUIVIS - 4);
});

test("une écriture déchirée laisse un bloc qui n'est ni l'ancien ni le nouveau", async () => {
  const rapport = await rejouerCoupure(point(CRASH_KINDS.torn, "write", 5, 192));
  assert.equal(rapport.classes.dechire, 1);
  assert.equal(rapport.verdict, VERDICTS.corrompu);
  assert.equal(rapport.atomique, false);
  const abime = rapport.blocs.find((b) => b.classe === "dechire");
  assert.equal(abime.index, 4);
});

test("la coupure est bien ATTEINTE : une faute programmée jamais tirée ne prouverait rien", async () => {
  const rapport = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 5));
  assert.equal(rapport.fautesNonTirees.length, 0);
  assert.equal(rapport.fautesTirees.length, 1);
  assert.ok(rapport.arret, "l'écriture doit s'être arrêtée sur une erreur typée");
  assert.equal(rapport.arret.code, "VAULT_STORAGE_HANDLE_LOST");
});

test("une matrice rejouée avec la même graine rend exactement le même compte rendu", async () => {
  const premiere = await rejouerMatrice(2026, { points: 8 });
  const seconde = await rejouerMatrice(2026, { points: 8 });
  assert.deepEqual(
    premiere.map((r) => [r.point, r.verdict, r.classes]),
    seconde.map((r) => [r.point, r.verdict, r.classes]),
  );
});

test("une matrice publie son taux « ancien ou nouveau », et il n'est pas de 100 %", async () => {
  const resultats = await rejouerMatrice(2026, { points: 12 });
  const resume = resumerMatrice({ graine: 2026, resultats });

  assert.equal(resume.version, RESILIENCE_REPORT_VERSION);
  assert.equal(resume.graine, 2026);
  assert.equal(resume.pointsRejoues, 12);
  assert.equal(
    resume.verdicts.ancien + resume.verdicts.nouveau + resume.verdicts.melange + resume.verdicts.corrompu,
    12,
  );
  // C'est la mesure que #16 devra porter à 100 %. Aujourd'hui elle ne l'est pas, et l'affirmer
  // serait la seule façon de rendre ce test creux.
  assert.ok(resume.tauxAtomique < 1, `taux mesuré : ${resume.tauxAtomique}`);
  assert.ok(resume.verdicts.melange + resume.verdicts.corrompu > 0);

  // Chaque point est rejouable seul, avec sa graine et sa description.
  for (const ligne of resume.rejeu) {
    assert.equal(ligne.graine, 2026);
    assert.ok(Number.isInteger(ligne.point.occurrence));
    assert.ok(Object.values(VERDICTS).includes(ligne.verdict));
  }
});
