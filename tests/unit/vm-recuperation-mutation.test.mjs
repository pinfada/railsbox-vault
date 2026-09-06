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
