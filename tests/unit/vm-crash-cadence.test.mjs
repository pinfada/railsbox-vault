import assert from "node:assert/strict";
import test from "node:test";

import { planifierCoupures } from "../../src/vm/crash-plan.mjs";
import {
  BARRIERES,
  BARRIERE_TOUS_LES,
  BLOCS_SUIVIS,
  BLOC_OCTETS,
  ECRITURES,
  generationsAttendues,
  profilDuScenario,
} from "../../src/vm/crash-scenario.mjs";

// Ce que la MATRICE de coupures peut et ne peut pas produire (#16).
//
// Ce fichier ne mesure aucun backend : il calcule, sur la matrice RÉELLE, quelle génération chaque
// point laisse validée. C'est la borne de ce que la mesure peut exercer, et elle doit être connue
// avant de lire un taux — un relevé qui n'exercerait qu'un seul verdict serait satisfait par un
// mécanisme dégénéré.
//
// Une contrainte en sort, et elle est structurelle : le verdict `nouveau` — les vingt-quatre blocs
// publiés — est INATTEIGNABLE par la matrice. La génération 3 n'est validée qu'à l'acquittement de
// la troisième barrière, qui suit la vingt-quatrième écriture ; or les trois genres de coupure de
// `crash-plan.mjs` tombent tous AVANT cet acquittement. Ajouter un genre « après barrière »
// changerait le nombre de genres, donc la suite pseudo-aléatoire, donc la matrice entière — ce que
// la comparaison avec #15 interdit. L'extrême haut est donc exercé par un TÉMOIN POSITIF, dans
// `vm-crash-matrice.test.mjs` : le scénario sans aucune faute doit rendre `nouveau`.

const GRAINES = [2026, 7, 424242];
const POINTS = 8;

/**
 * Rang de la dernière génération VALIDÉE quand la coupure tombe sur `point`. Dérivé du seul
 * scénario : quelles écritures ont eu lieu, quelles barrières ont été acquittées.
 */
function generationValidee(point) {
  let rang = 0;
  for (let ecriture = 1; ecriture <= ECRITURES; ecriture += 1) {
    // Une coupure sur une écriture — brutale ou déchirée — interrompt la génération en cours.
    if (point.operation === "write" && point.occurrence === ecriture) break;
    if (ecriture % BARRIERE_TOUS_LES !== 0) continue;
    const barriere = ecriture / BARRIERE_TOUS_LES;
    // Coupure AVANT l'acquittement : la génération en cours est écartée elle aussi.
    if (point.operation === "flush" && point.occurrence === barriere) break;
    rang = barriere;
  }
  return rang;
}

const rangsDe = (graine, points) =>
  planifierCoupures(graine, profilDuScenario(points)).map(generationValidee);

test("la suite des générations attendues est celle du scénario, et elle croît strictement", () => {
  assert.deepEqual(generationsAttendues(), [
    [],
    Array.from({ length: 8 }, (_, i) => i),
    Array.from({ length: 16 }, (_, i) => i),
    Array.from({ length: 24 }, (_, i) => i),
  ]);
  assert.equal(generationsAttendues().length, BARRIERES + 1);
  assert.equal(BLOCS_SUIVIS, 24);
  assert.equal(BLOC_OCTETS, 512);
});

test("la matrice exerce l'extrême bas et DEUX générations intermédiaires, sur les trois graines", () => {
  for (const graine of GRAINES) {
    const rangs = rangsDe(graine, POINTS);
    assert.ok(
      rangs.includes(0),
      `graine ${graine} : aucun point ne laisse le volume à l'ancien état`,
    );
    assert.ok(rangs.includes(1), `graine ${graine} : aucun point ne laisse la génération 1`);
    assert.ok(rangs.includes(2), `graine ${graine} : aucun point ne laisse la génération 2`);
  }
});

test("le verdict « nouveau » est INATTEIGNABLE par la matrice, et c'est démontré, pas supposé", () => {
  // Si un jour un genre de coupure postérieur à la dernière barrière était ajouté, cette épreuve
  // rougirait — et c'est ce qu'on veut : le témoin positif de `vm-crash-matrice.test.mjs` ne serait
  // alors plus le seul moyen d'exercer l'extrême haut, et le relevé devrait le dire.
  for (const graine of GRAINES) {
    for (const points of [8, 12]) {
      const rangs = rangsDe(graine, points);
      assert.ok(
        !rangs.includes(BARRIERES),
        `graine ${graine}, ${points} points : un point atteint la génération ${BARRIERES} (${rangs.join(",")})`,
      );
    }
  }
});

test("le profil remis au planificateur est celui de #15 : la matrice ne bouge pas", () => {
  assert.deepEqual(profilDuScenario(POINTS), {
    points: POINTS,
    lectures: 0,
    ecritures: 24,
    barrieres: 3,
    tailleBloc: 512,
  });

  const attendue = [
    "ecriture-dechiree/write#8",
    "ecriture-dechiree/write#4",
    "coupure-avant-barriere/flush#3",
    "arret-brutal/write#2",
    "ecriture-dechiree/write#10",
    "arret-brutal/write#10",
    "coupure-avant-barriere/flush#2",
    "arret-brutal/write#7",
  ];
  assert.deepEqual(
    planifierCoupures(2026, profilDuScenario(POINTS)).map(
      (point) => `${point.kind}/${point.operation}#${point.occurrence}`,
    ),
    attendue,
    "la matrice de la graine 2026 est celle que docs/quality-attributes.md publie depuis #15",
  );
});
