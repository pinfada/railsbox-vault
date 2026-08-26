import assert from "node:assert/strict";
import test from "node:test";

import { planifierCoupures } from "../../src/vm/crash-plan.mjs";
import {
  BARRIERE_TOUS_LES,
  BLOCS_SUIVIS,
  BLOC_OCTETS,
  ECRITURES,
  PASSES,
  profilDuScenario,
} from "../../src/vm/crash-scenario.mjs";

// Pourquoi le scénario de coupure suit huit blocs réécrits trois fois, et non vingt-quatre blocs
// distincts comme en #15 (#16, ADR 0014).
//
// Ce fichier ne mesure aucun backend. Il calcule, sur la matrice de coupures RÉELLE, ce qu'un
// mécanisme de génération PARFAIT laisserait sur le support — un mécanisme qui rendrait visible
// toute génération dont la barrière est acquittée, et rien d'autre. C'est la borne SUPÉRIEURE de ce
// que #16 peut atteindre, quel que soit son mécanisme.
//
// Le résultat est net : avec la cadence de #15, cette borne vaut 50 % sur la graine 2026 et 37,5 %
// sur deux autres. Le « 100 % sur la même matrice » demandé par #16 y était donc INATTEIGNABLE — non
// par faiblesse du mécanisme, mais parce que `SEC-DURABLE-001` oblige à publier les générations
// intermédiaires, que l'oracle de #15 ne sait nommer ni « ancien » ni « nouveau ».
//
// Ce constat ne change PAS l'oracle : le juge reste identique, et il reste sévère. C'est la charge
// de travail mesurée qui change, de façon à ce que toute génération validée soit l'un des deux états
// que l'oracle sait juger. Le profil remis à `planifierCoupures` — vingt-quatre écritures, trois
// barrières, des blocs de 512 octets — reste le même, et la matrice avec lui.

const GRAINES = [2026, 7, 424242];
const POINTS = 8;

/**
 * Ce qu'un mécanisme de génération PARFAIT laisse, pour un point de coupure donné.
 *
 * @param {object} point
 * @param {(rang: number) => number} blocDe bloc touché par la n-ième écriture, à partir de 1
 * @param {number} blocs nombre de blocs suivis
 */
function verdictIdeal(point, blocDe, blocs) {
  const nouveau = new Array(blocs).fill(false);
  const enCours = new Set();
  for (let rang = 1; rang <= ECRITURES; rang += 1) {
    // Une coupure sur une écriture — brutale ou déchirée — interrompt la génération en cours. Un
    // mécanisme parfait ne la publie jamais.
    if (point.operation === "write" && point.occurrence === rang) break;
    enCours.add(blocDe(rang));
    if (rang % BARRIERE_TOUS_LES !== 0) continue;
    // Coupure AVANT l'acquittement : la génération en cours est écartée, elle aussi.
    if (point.operation === "flush" && point.occurrence === rang / BARRIERE_TOUS_LES) break;
    for (const bloc of enCours) nouveau[bloc] = true;
    enCours.clear();
  }
  const compte = nouveau.filter(Boolean).length;
  if (compte === 0) return "ancien";
  if (compte === blocs) return "nouveau";
  return "melange";
}

function tauxIdeal(graine, blocDe, blocs) {
  const points = planifierCoupures(graine, profilDuScenario(POINTS));
  const verdicts = points.map((point) => verdictIdeal(point, blocDe, blocs));
  return {
    taux: verdicts.filter((verdict) => verdict !== "melange").length / verdicts.length,
    verdicts,
  };
}

const CADENCE_15 = (rang) => rang - 1;
const CADENCE_16 = (rang) => (rang - 1) % BLOCS_SUIVIS;

test("la cadence de #15 rendait 100 % inatteignable, quel que soit le mécanisme", () => {
  // Vingt-quatre blocs DISTINCTS, une barrière tous les huit : les générations 1 et 2 ne touchent
  // qu'un tiers puis deux tiers du volume, et un oracle qui ne connaît que deux états les classe
  // `melange`. Ces bornes sont un CALCUL, pas une observation : aucun backend n'est en jeu ici.
  const bornes = Object.fromEntries(
    GRAINES.map((graine) => [graine, tauxIdeal(graine, CADENCE_15, ECRITURES).taux]),
  );
  assert.deepEqual(bornes, { 2026: 0.5, 7: 0.375, 424242: 0.375 });
  for (const graine of GRAINES) {
    assert.ok(bornes[graine] < 1, `graine ${graine} : la borne supérieure reste sous 100 %`);
  }
});

test("la cadence retenue atteint 100 % sur les trois graines, sans jamais rendre le test creux", () => {
  for (const graine of GRAINES) {
    const { taux, verdicts } = tauxIdeal(graine, CADENCE_16, BLOCS_SUIVIS);
    assert.equal(taux, 1, `graine ${graine} : ${verdicts.join(",")}`);
    // Et surtout : les DEUX issues sont exercées. Une matrice qui ne rendrait que « ancien » serait
    // satisfaite par un backend qui n'écrit rien du tout — c'est-à-dire par une preuve creuse.
    assert.ok(verdicts.includes("ancien"), `graine ${graine} : aucun point ne rend l'ancien état`);
    assert.ok(
      verdicts.includes("nouveau"),
      `graine ${graine} : aucun point ne rend le nouvel état`,
    );
  }
});

test("le profil remis au planificateur est identique à celui de #15 : la matrice ne bouge pas", () => {
  // Les quatre nombres qui décident de la matrice. S'ils changeaient, le relevé de #16 ne serait
  // plus comparable à celui de #15, et la comparaison avant/après ne vaudrait rien.
  assert.deepEqual(profilDuScenario(POINTS), {
    points: POINTS,
    lectures: 0,
    ecritures: 24,
    barrieres: 3,
    tailleBloc: 512,
  });
  assert.equal(ECRITURES, BLOCS_SUIVIS * PASSES);
  assert.equal(BLOC_OCTETS, 512);

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
