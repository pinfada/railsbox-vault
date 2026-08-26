import assert from "node:assert/strict";
import test from "node:test";

import { CLASSES, VERDICTS, classerVolume } from "../../src/vm/crash-oracle.mjs";

// L'oracle est une fonction PURE : il reçoit ce qui a été relu du support et ce qui était attendu,
// et il classe. Les octets observés sont donc fabriqués ici, ce qui est la seule façon d'exercer
// les quatre classes — un support réel ne produit pas une corruption à la demande. Le même oracle
// est ensuite appliqué à des relectures RÉELLES par `vm-crash-matrice.test.mjs` (backend OPFS sur
// le double) et par `tests/vm/resilience-arrets.spec.mjs` (OPFS de Chromium).
//
// L'oracle est le JUGE de #16 : c'est lui qui dira si la garantie d'atomicité tient. Un défaut de
// l'oracle qui SURESTIME le taux atomique est donc plus grave qu'un faux négatif, et plusieurs des
// épreuves ci-dessous sont là pour cela seul.

const TAILLE = 8;
const ancien = (n) => Uint8Array.from({ length: TAILLE }, (_, i) => (10 + n + i) % 256);
const nouveau = (n) => Uint8Array.from({ length: TAILLE }, (_, i) => (200 + n + i) % 256);

function bloc(index, observe) {
  return { index, offset: index * TAILLE, ancien: ancien(index), nouveau: nouveau(index), observe };
}

/** Bloc déchiré : la moitié basse porte le nouvel état, la moitié haute l'ancien. */
function dechire(index) {
  const octets = new Uint8Array(TAILLE);
  octets.set(nouveau(index).subarray(0, 4), 0);
  octets.set(ancien(index).subarray(4), 4);
  return octets;
}

/** Classement d'octets seuls : le journal n'est pas en jeu, et l'appelant doit le DIRE. */
const classerOctetsSeuls = (blocs) => classerVolume({ blocs, sansJournal: true });

test("un volume entièrement relu à l'ancien état est classé « ancien », sans raison à donner", () => {
  const rapport = classerOctetsSeuls([bloc(0, ancien(0)), bloc(1, ancien(1))]);
  assert.equal(rapport.verdict, VERDICTS.ancien);
  assert.equal(rapport.raison, null);
  assert.equal(rapport.atomique, true);
  assert.deepEqual(rapport.classes, { ancien: 2, nouveau: 0, dechire: 0, corrompu: 0 });
});

test("un volume entièrement relu au nouvel état est classé « nouveau »", () => {
  const rapport = classerOctetsSeuls([bloc(0, nouveau(0)), bloc(1, nouveau(1))]);
  assert.equal(rapport.verdict, VERDICTS.nouveau);
  assert.equal(rapport.atomique, true);
});

test("des blocs anciens et nouveaux qui cohabitent donnent « melange », qui n'est PAS atomique", () => {
  const rapport = classerOctetsSeuls([bloc(0, nouveau(0)), bloc(1, ancien(1))]);
  assert.equal(rapport.verdict, VERDICTS.melange);
  assert.equal(rapport.atomique, false);
  assert.match(rapport.raison, /cohabitent/);
  assert.deepEqual(rapport.classes, { ancien: 1, nouveau: 1, dechire: 0, corrompu: 0 });
});

test("un bloc dont une partie seulement porte le nouvel état est « dechire »", () => {
  const rapport = classerOctetsSeuls([bloc(0, dechire(0)), bloc(1, ancien(1))]);
  assert.equal(rapport.blocs[0].classe, CLASSES.dechire);
  assert.equal(rapport.classes.dechire, 1);
  // Un bloc déchiré n'est NI l'ancien état NI le nouveau : au niveau du volume il rejoint
  // « corrompu ». Le compte par classe conserve la distinction, elle n'est pas perdue.
  assert.equal(rapport.verdict, VERDICTS.corrompu);
  assert.equal(rapport.atomique, false);
  assert.match(rapport.raison, /déchiré/);
});

test("un bloc que l'oracle ne sait rattacher à rien est « corrompu » AVEC diagnostic, jamais ignoré", () => {
  const etranger = new Uint8Array(TAILLE).fill(0x5a);
  const rapport = classerOctetsSeuls([bloc(0, etranger)]);
  assert.equal(rapport.blocs[0].classe, CLASSES.corrompu);
  assert.equal(rapport.verdict, VERDICTS.corrompu);
  assert.ok(rapport.blocs[0].diagnostic, "un bloc corrompu doit porter un diagnostic");
  assert.match(rapport.blocs[0].diagnostic, /octet/);
});

test("une écriture acquittée PUIS franchie par une barrière, absente du support, est une corruption", () => {
  // C'est la promesse `SEC-DURABLE-001` lue à l'envers : le journal dit que l'écriture a été
  // acquittée et qu'une barrière l'a suivie ; le support rend pourtant l'ancien état. Classer cela
  // « ancien » serait un succès silencieux.
  const journal = [
    { seq: 0, operation: "write", offset: 0, length: TAILLE },
    { seq: 1, operation: "flush", barrier: 0 },
    { seq: 2, operation: "flush-ack", barrier: 0 },
  ];
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0))], journal });
  assert.equal(rapport.blocs[0].acquitte, true);
  assert.equal(rapport.blocs[0].durable, true);
  assert.equal(rapport.blocs[0].classe, CLASSES.corrompu);
  assert.match(rapport.blocs[0].diagnostic, /barrière/i);
});

test("une écriture acquittée mais JAMAIS franchie par une barrière peut légitimement être perdue", () => {
  const journal = [{ seq: 0, operation: "write", offset: 0, length: TAILLE }];
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0))], journal });
  assert.equal(rapport.blocs[0].acquitte, true);
  assert.equal(rapport.blocs[0].durable, false);
  assert.equal(rapport.blocs[0].classe, CLASSES.ancien);
  assert.equal(rapport.verdict, VERDICTS.ancien);
});

test("une écriture barriérée reste durable même si une écriture POSTÉRIEURE ne l'est pas", () => {
  // Contre-exemple de la revue de #88 (HIGH-2). Le régime de #16 est précisément celui-ci : une
  // génération écrit, franchit une barrière, puis RÉÉCRIT le même bloc (journal, copie) sans
  // barrière. Ne regarder que la DERNIÈRE écriture ferait disparaître la version acquittée ET
  // barriérée, et l'oracle classerait « ancien » — donc atomique — un volume où `SEC-DURABLE-001`
  // ne tient pas.
  const journal = [
    { seq: 0, operation: "write", offset: 0, length: TAILLE },
    { seq: 1, operation: "flush", barrier: 0 },
    { seq: 2, operation: "flush-ack", barrier: 0 },
    { seq: 3, operation: "write", offset: 0, length: TAILLE },
  ];
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0))], journal });
  assert.equal(rapport.blocs[0].durable, true, "une barrière franchie ne se dé-franchit pas");
  assert.equal(rapport.blocs[0].classe, CLASSES.corrompu);
  assert.equal(rapport.atomique, false);
});

test("une écriture postérieure à la dernière barrière, et elle seule, n'est pas durable", () => {
  // Le témoin inverse : sans écriture antérieure à un acquittement, rien n'est durable. Sans lui,
  // « durable » pourrait devenir toujours vrai dès qu'une barrière existe quelque part.
  const journal = [
    { seq: 0, operation: "flush", barrier: 0 },
    { seq: 1, operation: "flush-ack", barrier: 0 },
    { seq: 2, operation: "write", offset: 0, length: TAILLE },
  ];
  const rapport = classerVolume({ blocs: [bloc(0, ancien(0))], journal });
  assert.equal(rapport.blocs[0].acquitte, true);
  assert.equal(rapport.blocs[0].durable, false);
  assert.equal(rapport.blocs[0].classe, CLASSES.ancien);
});

test("un bloc dont l'ancien et le nouveau partagent UN SEUL octet est refusé, avec son indice", () => {
  // Contre-exemple de la revue de #88 (HIGH-1). Avec ancien [7,7,9,9] et nouveau [7,7,1,1], un
  // support qui n'a écrit que les deux premiers octets du nouvel état rend [7,7,9,9] : identique à
  // l'ancien état, donc classé « ancien » et compté ATOMIQUE, alors que c'est une déchirure. La
  // discernabilité octet par octet — que le scénario de #15 garantit — devient une PRÉCONDITION de
  // l'instrument, vérifiée à chaque appel plutôt que supposée.
  const ancienPartage = Uint8Array.from([7, 7, 9, 9]);
  const nouveauPartage = Uint8Array.from([7, 7, 1, 1]);
  assert.throws(
    () =>
      classerVolume({
        blocs: [
          { index: 0, offset: 0, ancien: ancienPartage, nouveau: nouveauPartage, observe: ancienPartage },
        ],
        sansJournal: true,
      }),
    /octet 0/,
  );
});

test("l'oracle refuse un bloc dont l'ancien et le nouveau contenu sont identiques", () => {
  // Il ne saurait pas les distinguer : le classer « ancien » ou « nouveau » serait un tirage au sort
  // présenté comme une mesure.
  assert.throws(
    () =>
      classerOctetsSeuls([
        { index: 0, offset: 0, ancien: ancien(0), nouveau: ancien(0), observe: ancien(0) },
      ]),
    /octet 0/,
  );
});

test("des longueurs incohérentes sont refusées, jamais complétées", () => {
  assert.throws(
    () =>
      classerOctetsSeuls([
        { index: 0, offset: 0, ancien: ancien(0), nouveau: nouveau(0), observe: new Uint8Array(4) },
      ]),
    /longueur/i,
  );
  assert.throws(() => classerOctetsSeuls([]), /aucun bloc/i);
});

test("classer sans journal doit être DIT : l'oublier est refusé, pas toléré", () => {
  // Contre-exemple de la revue de #88 (HIGH-3). `runResilienceClasser` avait `journal = []` par
  // défaut : un refactor qui aurait cessé de relayer le journal du Worker mort aurait désactivé la
  // règle `SEC-DURABLE-001` en SILENCE, et fait MONTER le taux atomique.
  assert.throws(() => classerVolume({ blocs: [bloc(0, ancien(0))] }), /journal/i);
  assert.throws(
    () => classerVolume({ blocs: [bloc(0, ancien(0))], sansJournal: true, journal: [] }),
    /journal/i,
  );
});

test("le rapport publie s'il a consulté un journal, et combien d'entrées", () => {
  const journal = [{ seq: 0, operation: "write", offset: 0, length: TAILLE }];
  const avec = classerVolume({ blocs: [bloc(0, nouveau(0))], journal });
  assert.equal(avec.journalConsulte, true);
  assert.equal(avec.entreesJournal, 1);

  const sans = classerOctetsSeuls([bloc(0, nouveau(0))]);
  assert.equal(sans.journalConsulte, false);
  assert.equal(sans.entreesJournal, 0);
  // Sans journal, « acquitté » et « durable » ne sont pas FAUX : ils sont INCONNUS. Les rendre
  // faux laisserait croire que la question a été posée.
  assert.equal(sans.blocs[0].acquitte, null);
  assert.equal(sans.blocs[0].durable, null);
});
