import assert from "node:assert/strict";
import test from "node:test";

import { MUTATIONS, campagneDeMutation } from "../../tools/muter-gardes-recuperation.mjs";

// ÉPREUVE DE MUTATION des gardes du moyen de récupération (#147, ADR 0025).
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cette épreuve RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, et
// vérifie qu'elle rougit. Un mutant qui SURVIT est un trou de la preuve.
//
// Elle est lente — une recopie du dépôt, puis une trentaine de processus `node --test` — et c'est le
// prix d'une mutation qui n'est pas simulée. La table vit dans l'outil, pas ici : ce fichier ne fait
// que constater. La mutation a lieu dans une COPIE temporaire, jamais dans `src/`, pour la raison
// que #65 a trouvée par exécution : les fichiers d'épreuve de `npm run test:unit` s'exécutent en
// parallèle, et une garde retirée dans le dépôt serait vue par les épreuves voisines.

const campagne = campagneDeMutation();

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

test("une épreuve ABSENTE ne passe pas pour un mutant tué", () => {
  // La garde que la revue de #65 a exigée, rejouée ici : la campagne comptait TUÉ tout code de
  // sortie non nul, y compris celui d'un `node --test` à qui l'on donne un fichier qui n'existe
  // pas. Un mutant n'est tué que si l'épreuve PASSAIT avant qu'on le pose.
  const { resultats } = campagneDeMutation({
    mutations: [{ ...MUTATIONS[0], epreuves: ["tests/unit/epreuve-qui-nexiste-pas.test.mjs"] }],
  });
  assert.equal(resultats[0].tue, false, "une épreuve absente ne tue rien");
  assert.match(resultats[0].raison ?? "", /avant la mutation/i);
});

test("un enfant qui S'ARRÊTE sans verdict est NON CONCLUANT, jamais un mutant tué", () => {
  // La faute que la CI a trouvée, et qu'aucune relecture n'avait vue. Sous un mutant, une épreuve
  // confrontait deux tableaux de 65 536 entrées : la construction du diff par `assert` atteignait
  // 4,2 Go et faisait tuer le processus — et la campagne comptait le mutant « tué », alors qu'AUCUNE
  // assertion n'avait rendu de verdict. C'est le pendant exact de la garde de #65 (« un mutant n'est
  // tué que si l'épreuve PASSAIT avant qu'on le pose »), sur l'autre bord.
  //
  // Le témoin rejoue le MÉCANISME exact plutôt qu'un arrêt quelconque : l'enfant épuise son tas
  // avant qu'aucune assertion n'ait rendu son verdict. Un `process.kill` ferait l'affaire sur un
  // système à signaux, mais Windows n'en a pas — il rendrait un code de sortie ordinaire, et
  // l'épreuve mesurerait alors la plate-forme plutôt que la garde.
  const { resultats } = campagneDeMutation({
    mutations: [
      {
        nom: "témoin : un enfant qui épuise son tas sans juger",
        garde: "aucune — cette mutation existe pour mordre la campagne elle-même",
        fichier: "tests/unit/vm-derivation-recuperation.test.mjs",
        avant: 'import assert from "node:assert/strict";',
        apres:
          'import assert from "node:assert/strict";\n' +
          "const gouffre = [];\n" +
          "for (;;) gouffre.push(new Array(1e6).fill(gouffre.length));",
        epreuves: [MUTATIONS[0].epreuves[0]],
      },
    ],
  });
  assert.equal(
    resultats[0].tue,
    false,
    "un enfant arrêté sans verdict a été compté pour un mutant tué : la campagne ne mesure plus rien.",
  );
  assert.match(resultats[0].raison ?? "", /NON CONCLUANT/);
});

test("la table couvre les gardes que l'ADR 0025 nomme, une par une", () => {
  const noms = MUTATIONS.map((mutation) => mutation.nom).join(" | ");
  for (const attendu of [
    "seize octets réellement TIRÉS",
    "bourrage",
    "somme de contrôle est vérifiée AVANT",
    "alphabet",
    "repli de Crockford",
    "NFC",
    "signe étranger",
    "séparateurs",
    "version du moyen",
    "sel HKDF",
    "materiauDuCode",
    "type de clé INCONNU",
    "effacés dès que le MATÉRIAU",
    "effacés dès que la KEK",
    "barrière franchie AVANT le rendu",
    "rendu QU'UNE fois",
  ]) {
    assert.ok(noms.includes(attendu), `aucune mutation ne vise « ${attendu} »`);
  }
});
