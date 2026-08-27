import assert from "node:assert/strict";
import test from "node:test";

import { HARNAIS_RESILIENCE_ENV, HARNAIS_RESILIENCE_VALEUR } from "../../src/vm/crash-harness.mjs";
import { rejouerMatrice } from "../../src/vm/crash-machine.mjs";
import { VERDICTS } from "../../src/vm/crash-oracle.mjs";
import { resumerMatrice } from "../../src/vm/crash-report.mjs";

// ÉPREUVE DE MUTATION de la mesure de #16.
//
// Une matrice à 100 % ne prouve rien tant qu'on n'a pas montré qu'elle sait descendre. Ce fichier
// remplace le magasin de générations par un MUTANT qui viole `SEC-DURABLE-001` de la façon la plus
// coûteuse à détecter : il acquitte au guest les générations 2 et 3 — la barrière du support est
// bien franchie, le guest reçoit son `flush-ack` — mais il ne les SCELLE jamais. À la réouverture,
// seule la génération 1 est rejouée ; les deux suivantes, pourtant acquittées, ont disparu.
//
// C'est exactement la mutation par laquelle la revue de #16 a démontré que la cadence précédente —
// huit blocs réécrits trois fois avec le MÊME contenu — rendait la preuve creuse : les générations 2
// et 3 n'y publiaient rien de neuf, le volume final était identique, et la matrice restait à 100 %.
//
// Avec vingt-quatre blocs distincts et un oracle qui connaît la suite des générations attendues, la
// mutation DOIT rougir. Ce fichier le vérifie, et il vérifie aussi la limite exacte de ce que
// l'épreuve peut détecter : sur un point coupé AVANT la première barrière, aucune génération n'a
// jamais été acquittée, et le mutant est alors indiscernable d'un magasin correct. Ce n'est pas un
// trou de l'oracle : c'est qu'il n'y a rien à trahir.

process.env[HARNAIS_RESILIENCE_ENV] = HARNAIS_RESILIENCE_VALEUR;

const GRAINES = [2026, 7, 424242];
const POINTS = 8;

/**
 * Magasin MUTANT : il n'honore que la première validation. Les suivantes franchissent bien la
 * barrière du support — le guest ne voit aucune erreur — mais ne scellent rien.
 */
function perdreApresLaPremiereGeneration(magasin) {
  let validations = 0;
  return new Proxy(magasin, {
    get(cible, propriete) {
      // Le récepteur est la CIBLE, pas le proxy : un accesseur du magasin lit des champs privés, et
      // les lui faire lire à travers le proxy lèverait au lieu de mesurer.
      if (propriete !== "valider") {
        const valeur = Reflect.get(cible, propriete, cible);
        return typeof valeur === "function" ? valeur.bind(cible) : valeur;
      }
      return async () => {
        validations += 1;
        if (validations === 1) return cible.valider();
        // Acquitté sans être scellé : la trahison exacte que l'oracle doit voir.
        return cible.generationValidee;
      };
    },
  });
}

test("le mutant qui perd les générations acquittées fait CHUTER la matrice", async () => {
  for (const graine of GRAINES) {
    const sain = resumerMatrice({
      graine,
      resultats: await rejouerMatrice(graine, { points: POINTS }),
    });
    const mutant = resumerMatrice({
      graine,
      resultats: await rejouerMatrice(graine, {
        points: POINTS,
        muterMagasin: perdreApresLaPremiereGeneration,
      }),
    });

    assert.equal(sain.tauxAtomique, 1, `graine ${graine} : le magasin sain doit rendre 100 %`);
    assert.ok(
      mutant.tauxAtomique < sain.tauxAtomique,
      `graine ${graine} : le mutant doit être VU — taux ${mutant.tauxAtomique} contre ${sain.tauxAtomique}`,
    );
    assert.ok(
      mutant.verdicts.corrompu > 0,
      `graine ${graine} : une écriture acquittée puis perdue est une CORRUPTION, pas une mise au rebut`,
    );
  }
});

test("le mutant est vu sur TOUS les points qu'il trahit, et sur eux seuls", async () => {
  // La borne exacte de l'épreuve, dite plutôt que subie. Ce mutant honore la PREMIÈRE validation :
  // il ne trahit donc que les points ayant acquitté au moins DEUX barrières. Sur les autres, il n'a
  // rien promis qu'il n'ait tenu, et il rend le même verdict que le magasin sain — ce n'est pas un
  // trou de l'oracle, c'est qu'il n'y a rien à voir. C'est aussi pourquoi le taux du mutant ne peut
  // pas tomber à zéro sur cette matrice.
  const sains = await rejouerMatrice(2026, { points: POINTS });
  const mutants = await rejouerMatrice(2026, {
    points: POINTS,
    muterMagasin: perdreApresLaPremiereGeneration,
  });

  let trahisons = 0;
  for (const [rang, mutant] of mutants.entries()) {
    const sain = sains[rang];
    const point = mutant.point;
    const ou = `${point.kind} sur ${point.operation}#${point.occurrence}`;
    assert.equal(sain.barrieres, mutant.barrieres, `${ou} : même nombre de barrières acquittées`);

    if (mutant.barrieres < 2) {
      assert.equal(mutant.verdict, sain.verdict, `${ou} : aucune génération n'a été trahie`);
      continue;
    }
    trahisons += 1;
    assert.equal(
      mutant.verdict,
      VERDICTS.corrompu,
      `${ou} : ${mutant.barrieres} barrières acquittées, seule la première scellée`,
    );
    assert.ok(sain.atomique, `${ou} : le magasin sain, lui, reste atomique`);
    const trahis = mutant.blocs.filter(
      (bloc) => bloc.durable === true && bloc.classe === "corrompu",
    );
    assert.ok(trahis.length > 0, `${ou} : la règle SEC-DURABLE doit nommer les blocs trahis`);
    assert.match(trahis[0].diagnostic, /barrière/i);
  }
  assert.ok(
    trahisons > 0,
    "la matrice doit contenir au moins un point à deux barrières acquittées",
  );
});

test("un magasin qui perd la PREMIÈRE génération est vu lui aussi", async () => {
  // Témoin symétrique : si seule la mutation « après la première » était détectée, l'épreuve
  // pourrait tenir à un détail de la suite des générations attendues plutôt qu'à la règle.
  const tout = (magasin) =>
    new Proxy(magasin, {
      get(cible, propriete) {
        if (propriete !== "valider") {
          const valeur = Reflect.get(cible, propriete, cible);
          return typeof valeur === "function" ? valeur.bind(cible) : valeur;
        }
        return async () => cible.generationValidee;
      },
    });

  const resume = resumerMatrice({
    graine: 2026,
    resultats: await rejouerMatrice(2026, { points: POINTS, muterMagasin: tout }),
  });
  assert.ok(resume.tauxAtomique < 1, `taux ${resume.tauxAtomique}`);
  assert.ok(resume.verdicts.corrompu > 0);
});
