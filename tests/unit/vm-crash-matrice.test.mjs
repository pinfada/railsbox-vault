import assert from "node:assert/strict";
import test from "node:test";

import { HARNAIS_RESILIENCE_ENV, HARNAIS_RESILIENCE_VALEUR } from "../../src/vm/crash-harness.mjs";
import { rejouerCoupure, rejouerMatrice, rejouerSansCoupure } from "../../src/vm/crash-machine.mjs";
import { VERDICTS, classerVolume, estVerdictConnu } from "../../src/vm/crash-oracle.mjs";
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
  generationsAttendues,
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

test("couper AVANT la dernière barrière laisse exactement la génération précédente", async () => {
  // `coupure-avant-barriere` coupe avant l'acquittement : les deux premières générations sont
  // validées, la troisième non. Le volume porte donc les seize premiers blocs, et l'oracle le NOMME
  // au lieu de le ranger dans « melange » comme le faisait celui de #15.
  const rapport = await rejouerCoupure(point(CRASH_KINDS.beforeBarrier, "flush", BARRIERES));
  assert.equal(rapport.verdict, "generation-2");
  assert.equal(rapport.atomique, true);
  assert.equal(rapport.classes.nouveau, 16);
  assert.equal(rapport.classes.ancien, BLOCS_SUIVIS - 16);
});

test("sans aucune faute, le scénario publie les VINGT-QUATRE blocs — témoin positif de « nouveau »", async () => {
  // L'extrême haut de la suite des générations. La matrice ne peut pas le produire — aucun genre de
  // coupure ne tombe après la troisième barrière acquittée, ce que `vm-crash-cadence.test.mjs`
  // démontre —, si bien que sans ce témoin le verdict `nouveau` ne serait jamais exercé et qu'un
  // oracle incapable de le rendre passerait inaperçu.
  const rapport = await rejouerSansCoupure();
  assert.equal(rapport.arret, null, "aucune faute n'est armée : l'écriture doit aboutir");
  assert.equal(rapport.barrieres, BARRIERES);
  assert.equal(rapport.verdict, VERDICTS.nouveau);
  assert.equal(rapport.atomique, true);
  assert.equal(rapport.classes.nouveau, BLOCS_SUIVIS);
  assert.equal(rapport.classes.ancien, 0);
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
    generations: generationsAttendues(),
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
  // Chaque point reçoit un verdict, et le total retombe sur ses pieds — verdicts intermédiaires
  // NOMMÉS par leur génération compris. Une somme qui ne retomberait pas dirait qu'un point a été
  // classé hors des états attendus sans que rien ne le signale.
  assert.equal(
    Object.values(resume.verdicts).reduce((somme, compte) => somme + compte, 0),
    12,
  );
  // C'est la mesure que #16 devait porter à 100 %. Elle y est — et pas seulement par des `ancien` :
  // un taux atteint uniquement par l'extrême bas serait satisfait par un backend qui n'écrit rien.
  assert.equal(resume.tauxAtomique, 1, `taux mesuré : ${resume.tauxAtomique}`);
  assert.equal(resume.verdicts.melange + resume.verdicts.corrompu, 0);
  assert.ok(resume.verdicts.ancien > 0, "l'extrême bas est exercé");
  assert.ok(
    resume.verdicts["generation-1"] > 0 && resume.verdicts["generation-2"] > 0,
    "les deux générations intermédiaires sont exercées",
  );
  // L'extrême HAUT, lui, est hors d'atteinte de la matrice — aucun genre de coupure ne tombe après
  // l'acquittement de la dernière barrière (`vm-crash-cadence.test.mjs`). Il est exercé par le
  // témoin positif plus haut, et ce zéro l'inscrit noir sur blanc plutôt que de le laisser deviner.
  assert.equal(resume.verdicts.nouveau, 0);

  // La répartition exacte est figée : la graine est une donnée versionnable, et un changement du
  // générateur qui passerait inaperçu rendrait « même graine, même séquence » invérifiable. Le
  // compte par CLASSE l'est aussi, `dechire: 0` et `corrompu: 0` compris : ces deux zéros sont la
  // garantie de #16, et les laisser flotter la rendrait invérifiable.
  assert.deepEqual(resume.verdicts, {
    ancien: 4,
    nouveau: 0,
    melange: 0,
    corrompu: 0,
    "generation-2": 4,
    "generation-1": 4,
  });
  assert.deepEqual(resume.classes, { ancien: 192, nouveau: 96, dechire: 0, corrompu: 0 });
  // L'oracle savait nommer QUATRE états. Deux ne suffisaient pas : un mécanisme qui acquitte une
  // génération puis la perd rendrait alors le même verdict qu'un mécanisme correct.
  assert.equal(resume.generationsAttendues, 4);

  // Le PROFIL du scénario voyage avec le taux. Il est INCHANGÉ depuis #15 sur les trois nombres qui
  // décident de la matrice — vingt-quatre écritures, trois barrières, 512 octets par bloc —, et
  // c'est ce qui rend le relevé de #16 comparable au sien.
  assert.deepEqual(resume.profil, {
    blocsSuivis: BLOCS_SUIVIS,
    tailleBloc: BLOC_OCTETS,
    ecritures: 24,
    passes: 1,
    barrieres: 3,
    barriereTousLes: BARRIERE_TOUS_LES,
  });

  // Chaque point est rejouable seul, avec sa graine et sa description.
  for (const ligne of resume.rejeu) {
    assert.equal(ligne.graine, 2026);
    assert.ok(Number.isInteger(ligne.point.occurrence));
    assert.ok(estVerdictConnu(ligne.verdict), ligne.verdict);
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
  assert.deepEqual(resume.verdicts, {
    ancien: 4,
    nouveau: 0,
    melange: 0,
    corrompu: 0,
    "generation-2": 1,
    "generation-1": 3,
  });
  assert.equal(resume.tauxAtomique, 1);
  assert.deepEqual(resume.classes, { ancien: 152, nouveau: 40, dechire: 0, corrompu: 0 });
});

test("deux autres graines rendent elles aussi 100 %, sans déchirure ni bloc non rattachable", async () => {
  // Une garantie qui ne tiendrait que sur la graine publiée n'en serait pas une. Ces deux graines
  // tirent d'autres genres de coupure à d'autres rangs — la matrice complète est dans l'ADR 0014.
  for (const [graine, attendus] of [
    [7, { ancien: 3, nouveau: 0, melange: 0, corrompu: 0, "generation-2": 2, "generation-1": 3 }],
    [
      424242,
      { ancien: 3, nouveau: 0, melange: 0, corrompu: 0, "generation-1": 3, "generation-2": 2 },
    ],
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
