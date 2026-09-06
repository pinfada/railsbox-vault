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

test("un mutant qui NE SE LIT PLUS est non applicable, jamais un mutant tué", () => {
  // Le constat de la revue de la PR #158, rejoué. Le moteur compte tout code de sortie non nul pour
  // une mise à mort ; un remplacement qui casse la syntaxe est donc tué par N'IMPORTE QUELLE
  // épreuve, y compris une qui n'approche pas la garde. Le n° 5 de la table était dans ce cas, et la
  // campagne annonçait 8/8 là où elle valait 7/8.
  //
  // C'est le pendant exact des deux gardes du moteur — « l'épreuve passait-elle AVANT ? » et
  // « l'enfant a-t-il rendu un verdict ? » — sur un troisième bord : la mutation décrit-elle encore
  // un programme ? Le témoin casse délibérément la syntaxe, et exige « non applicable ».
  const { resultats } = campagneDeMutation({
    mutations: [
      {
        ...MUTATIONS[0],
        nom: "témoin : un remplacement qui ne se lit plus",
        apres: "      etat.page.emplacements.slice(0, 1", // parenthèse jamais refermée
      },
    ],
    etiquette: "temoin-mutant-illisible",
  });
  assert.equal(
    resultats[0].tue,
    false,
    "un mutant qui ne compile pas a été compté pour un mutant tué : la campagne gonfle son score.",
  );
  assert.equal(resultats[0].applicable, false);
  assert.match(resultats[0].raison ?? "", /NE SE LIT PLUS/);
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
