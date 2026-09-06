import assert from "node:assert/strict";
import test from "node:test";

import { campagneDeMutation } from "../../tools/moteur-de-mutation.mjs";
import { MUTATIONS } from "../../tools/muter-gardes-revocation-urgence.mjs";

// ÉPREUVE DE MUTATION des gardes de la révocation d'urgence (#148, #156, ADR 0026).
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cette épreuve RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, et
// vérifie qu'elle rougit. Un mutant qui SURVIT est un trou de la preuve.
//
// Elle est lente — une recopie du dépôt, puis une vingtaine de processus `node --test` — et c'est le
// prix d'une mutation qui n'est pas simulée. La table vit dans l'outil, pas ici : ce fichier ne fait
// que constater. Les trois règles du moteur (mutation dans une COPIE, épreuve verte AVANT la
// mutation, arrêt sans verdict compté NON CONCLUANT) sont éprouvées une fois pour toutes dans
// `vm-recuperation-mutation.test.mjs` ; les rejouer ici doublerait un quart d'heure de CI pour
// remesurer le même moteur.

const campagne = campagneDeMutation({ mutations: MUTATIONS, etiquette: "revocation-urgence" });

test("chaque mutation décrit une garde qui existe VRAIMENT dans le source", () => {
  const inapplicables = campagne.resultats
    .filter((resultat) => !resultat.applicable)
    .map((resultat) => `${resultat.nom} : ${resultat.raison}`);
  assert.deepEqual(
    inapplicables,
    [],
    "Une mutation qui ne s'applique pas ne mesure rien : elle passerait pour tuée alors qu'elle n'a rien retiré.",
  );
});

test("AUCUN mutant ne survit : chaque garde retirée fait rougir sa preuve", () => {
  const survivants = campagne.resultats
    .filter((resultat) => !resultat.tue)
    .map((resultat) => `${resultat.nom} — ${resultat.garde}`);
  assert.deepEqual(
    survivants,
    [],
    "Ces gardes peuvent être retirées sans qu'aucune épreuve ne rougisse : ce sont des trous de la preuve, pas des gardes.",
  );
});

test("la table couvre les décisions que l'ADR 0026 nomme, une par une", () => {
  // Le cliquet : une décision écrite dans l'ADR sans garde mutée est une décision que rien ne tient.
  const noms = MUTATIONS.map((mutation) => mutation.nom).join(" | ");
  for (const attendu of [
    /conservé est celui que la KEK a OUVERT/,
    /APRÈS la barrière/,
    /page ENTIÈRE/,
    /SECONDE barrière/,
    /SEUL emplacement est ADMIS/,
    /RÉVOCATION efface/,
    /REMPLACEMENT efface/,
    /AJOUT n'efface RIEN/,
  ]) {
    assert.match(noms, attendu, `aucune mutation ne porte sur « ${attendu.source} ».`);
  }
});
