import assert from "node:assert/strict";
import test from "node:test";

import { HARNAIS_RESILIENCE_ENV, HARNAIS_RESILIENCE_VALEUR } from "../../src/vm/crash-harness.mjs";
import { rejouerCoupure, rejouerMatrice } from "../../src/vm/crash-machine.mjs";
import { VERDICTS, classerVolume } from "../../src/vm/crash-oracle.mjs";
import { CRASH_KINDS } from "../../src/vm/crash-plan.mjs";
import { RESILIENCE_REPORT_VERSION, resumerMatrice } from "../../src/vm/crash-report.mjs";
import {
  BARRIERES,
  BARRIERE_TOUS_LES,
  BLOC_OCTETS,
  BLOCS_SUIVIS,
  blocsAttendus,
  contenuAncien,
  contenuNouveau,
  offsetDuBloc,
} from "../../src/vm/crash-scenario.mjs";

// Ce fichier arme l'injecteur : il pose donc la variable du harnais, comme le ferait
// `npm run test:vm`. Le refus hors harnais est figé par `vm-crash-harnais.test.mjs`, dans son
// propre processus.
process.env[HARNAIS_RESILIENCE_ENV] = HARNAIS_RESILIENCE_VALEUR;

const point = (kind, operation, occurrence, bytes = null) =>
  Object.freeze({ graine: 0, index: 0, kind, operation, occurrence, bytes });

test("l'ancien et le nouveau contenu d'un bloc diffèrent OCTET PAR OCTET", () => {
  // Sans cela, un octet resté à l'ancien état pourrait coïncider avec le nouveau, et l'oracle
  // classerait « nouveau » un bloc déchiré. La propriété est vérifiée, pas supposée.
  for (let index = 0; index < BLOCS_SUIVIS; index += 1) {
    const ancien = contenuAncien(index);
    const nouveau = contenuNouveau(index);
    assert.equal(ancien.byteLength, nouveau.byteLength);
    for (let octet = 0; octet < ancien.byteLength; octet += 1) {
      assert.notEqual(ancien[octet], nouveau[octet], `bloc ${index}, octet ${octet}`);
    }
  }
});

test("deux blocs suivis distincts ne portent jamais le même contenu", () => {
  // Deux blocs identiques rendraient une écriture mal placée indétectable : elle passerait pour
  // l'écriture attendue.
  const empreintes = new Set(
    Array.from({ length: BLOCS_SUIVIS }, (_, index) => contenuNouveau(index).join(",")),
  );
  assert.equal(empreintes.size, BLOCS_SUIVIS);
});

test("couper à la toute première écriture laisse le volume à l'ancien état", async () => {
  const rapport = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 1));
  assert.equal(rapport.verdict, VERDICTS.ancien);
  assert.equal(rapport.atomique, true);
  assert.equal(rapport.classes.ancien, BLOCS_SUIVIS);
});

test("couper à la dernière barrière laisse le volume au nouvel état", async () => {
  const rapport = await rejouerCoupure(point(CRASH_KINDS.beforeBarrier, "flush", BARRIERES));
  assert.equal(rapport.verdict, VERDICTS.nouveau);
  assert.equal(rapport.atomique, true);
});

test("couper au milieu d'une génération ne publie AUCUNE de ses écritures", async () => {
  // C'est l'inversion de #15. Jusqu'à #16, ce point laissait quatre blocs au nouvel état et le reste
  // à l'ancien : `melange`, non atomique. La génération étant désormais invisible avant sa
  // validation, la coupure ne laisse que l'état d'avant.
  const rapport = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 5));
  assert.equal(rapport.verdict, VERDICTS.ancien);
  assert.equal(rapport.atomique, true);
  assert.equal(rapport.classes.ancien, BLOCS_SUIVIS);
  assert.equal(rapport.classes.nouveau, 0);
  // La coupure a bien eu lieu, et elle s'est dite : un point atomique obtenu sans coupure ne
  // prouverait rien.
  assert.equal(rapport.arret.code, "VAULT_STORAGE_HANDLE_LOST");
});

test("une écriture déchirée n'atteint plus le volume : plus aucun bloc n'est déchiré", async () => {
  // L'état le plus intéressant de #15 — celui qu'aucune relecture ne rattrape — est celui que #16
  // supprime. Les octets déchirés existent toujours, mais dans le journal de génération, et la
  // génération n'est jamais validée. Le volume, lui, n'est pas entamé.
  const rapport = await rejouerCoupure(point(CRASH_KINDS.torn, "write", 5, 192));
  assert.equal(rapport.arret.code, "VAULT_STORAGE_PARTIAL_WRITE");
  assert.equal(rapport.classes.dechire, 0);
  assert.equal(rapport.classes.corrompu, 0);
  assert.equal(rapport.verdict, VERDICTS.ancien);
  assert.equal(rapport.atomique, true);
});

test("la règle SEC-DURABLE se déclenche sur un rapport RÉEL dont le journal est trafiqué", async () => {
  // Témoin négatif exigé par la revue de #88 (HIGH-3). La règle « acquitté + barriéré rendant
  // l'ancien état = corrompu » ne se déclenche sur aucun point de la matrice — c'est une bonne
  // nouvelle, pas une preuve qu'elle marche. Ici la RELECTURE est réelle : le backend a vraiment
  // coupé à la cinquième écriture, et le bloc 3 est vraiment resté à l'ancien état. Seul le
  // journal est trafiqué, pour prétendre que ce bloc-là avait été écrit puis barriéré.
  //
  // La règle compte plus depuis #16, pas moins : le mécanisme rend maintenant TOUS les points
  // atomiques, et une règle SEC-DURABLE devenue inerte ferait passer une perte d'écriture acquittée
  // pour une mise au rebut légitime — c'est-à-dire pour un succès.
  const resultat = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 5));
  assert.equal(resultat.verdict, VERDICTS.ancien, "le verdict réel, avec le vrai journal");
  assert.equal(resultat.classes.corrompu, 0);

  const journalTrafique = [
    { seq: 0, operation: "write", offset: offsetDuBloc(3), length: BLOC_OCTETS },
    { seq: 1, operation: "flush", barrier: 0 },
    { seq: 2, operation: "flush-ack", barrier: 0 },
  ];
  const rejuge = classerVolume({
    blocs: blocsAttendus(resultat.relecture),
    journal: journalTrafique,
  });

  const bloc = rejuge.blocs.find((candidat) => candidat.index === 3);
  assert.equal(bloc.durable, true);
  assert.equal(bloc.classe, "corrompu");
  assert.match(bloc.diagnostic, /barrière/i);
  assert.equal(rejuge.verdict, VERDICTS.corrompu);
  assert.equal(rejuge.atomique, false, "un volume qui viole SEC-DURABLE-001 n'est jamais atomique");
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

test("une matrice publie son taux « ancien ou nouveau », et il vaut 100 %", async () => {
  const resultats = await rejouerMatrice(2026, { points: 12 });
  const resume = resumerMatrice({ graine: 2026, resultats });

  assert.equal(resume.version, RESILIENCE_REPORT_VERSION);
  assert.equal(resume.graine, 2026);
  assert.equal(resume.pointsRejoues, 12);
  assert.equal(
    resume.verdicts.ancien +
      resume.verdicts.nouveau +
      resume.verdicts.melange +
      resume.verdicts.corrompu,
    12,
  );
  // C'est la mesure que #16 devait porter à 100 %. Elle y est — et les deux issues sont exercées :
  // un taux atteint uniquement par des « ancien » serait satisfait par un backend qui n'écrit rien.
  assert.equal(resume.tauxAtomique, 1, `taux mesuré : ${resume.tauxAtomique}`);
  assert.equal(resume.verdicts.melange + resume.verdicts.corrompu, 0);
  assert.ok(resume.verdicts.ancien > 0 && resume.verdicts.nouveau > 0);

  // La répartition exacte est figée : la graine est une donnée versionnable, et un changement du
  // générateur qui passerait inaperçu rendrait « même graine, même séquence » invérifiable. Le
  // compte par CLASSE l'est aussi, `dechire: 0` et `corrompu: 0` compris : ces deux zéros sont la
  // garantie de #16, et les laisser flotter la rendrait invérifiable.
  assert.deepEqual(resume.verdicts, { ancien: 4, nouveau: 8, melange: 0, corrompu: 0 });
  assert.deepEqual(resume.classes, { ancien: 32, nouveau: 64, dechire: 0, corrompu: 0 });

  // Le PROFIL du scénario voyage avec le taux. Il est INCHANGÉ depuis #15 sur les trois nombres qui
  // décident de la matrice — vingt-quatre écritures, trois barrières, 512 octets par bloc —, et
  // c'est ce qui rend le relevé de #16 comparable au sien.
  assert.deepEqual(resume.profil, {
    blocsSuivis: BLOCS_SUIVIS,
    tailleBloc: BLOC_OCTETS,
    ecritures: 24,
    passes: 3,
    barrieres: 3,
    barriereTousLes: BARRIERE_TOUS_LES,
  });

  // Chaque point est rejouable seul, avec sa graine et sa description.
  for (const ligne of resume.rejeu) {
    assert.equal(ligne.graine, 2026);
    assert.ok(Number.isInteger(ligne.point.occurrence));
    assert.ok(Object.values(VERDICTS).includes(ligne.verdict));
  }
});

test("la même graine et le même nombre de points donnent la même répartition que la VM", async () => {
  // `docs/quality-attributes.md` publie le relevé de huit points sur OPFS réel. Le même relevé sur le
  // double calibré doit donner la même chose : si les deux supports divergeaient, le chiffre publié
  // ne dirait plus si l'écart vient du support ou de l'instrument.
  const resume = resumerMatrice({
    graine: 2026,
    resultats: await rejouerMatrice(2026, { points: 8 }),
    support: "double calibré (Node)",
  });
  assert.deepEqual(resume.verdicts, { ancien: 4, nouveau: 4, melange: 0, corrompu: 0 });
  assert.equal(resume.tauxAtomique, 1);
  assert.deepEqual(resume.classes, { ancien: 32, nouveau: 32, dechire: 0, corrompu: 0 });
});

test("deux autres graines rendent elles aussi 100 %, sans déchirure ni bloc non rattachable", async () => {
  // Une garantie qui ne tiendrait que sur la graine publiée n'en serait pas une. Ces deux graines
  // tirent d'autres genres de coupure à d'autres rangs — la matrice complète est dans l'ADR 0014.
  for (const [graine, attendus] of [
    [7, { ancien: 3, nouveau: 5, melange: 0, corrompu: 0 }],
    [424242, { ancien: 3, nouveau: 5, melange: 0, corrompu: 0 }],
  ]) {
    const resume = resumerMatrice({
      graine,
      resultats: await rejouerMatrice(graine, { points: 8 }),
      support: "double calibré (Node)",
    });
    assert.deepEqual(resume.verdicts, attendus, `graine ${graine}`);
    assert.equal(resume.tauxAtomique, 1, `graine ${graine}`);
    assert.equal(resume.classes.dechire, 0, `graine ${graine}`);
    assert.equal(resume.classes.corrompu, 0, `graine ${graine}`);
  }
});

test("le nombre d'entrées de journal consultées est publié pour chaque point", async () => {
  // Sans ce chiffre, un journal cessant d'être relayé rendrait la règle SEC-DURABLE inerte tout en
  // faisant MONTER le taux atomique — une amélioration apparente qui serait une perte de mesure.
  const rapport = await rejouerCoupure(point(CRASH_KINDS.abrupt, "write", 5));
  assert.equal(rapport.journalConsulte, true);
  assert.ok(rapport.entreesJournal > 0, "le journal de la session coupée n'est pas vide");
});
