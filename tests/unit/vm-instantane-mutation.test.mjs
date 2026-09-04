import assert from "node:assert/strict";
import test from "node:test";

import { MUTATIONS, campagneDeMutation } from "../../tools/muter-gardes-instantane.mjs";

// ÉPREUVE DE MUTATION des gardes de l'instantané (#65, ADR 0024).
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cette épreuve RETIRE
// réellement chaque garde du fichier source, relance l'épreuve qui devrait la couvrir, et vérifie
// qu'elle rougit. Un mutant qui SURVIT est un trou de la preuve.
//
// Elle est lente — une recopie du dépôt, puis une douzaine de processus `node --test` — et c'est le
// prix d'une mutation qui n'est pas simulée. La table vit dans l'outil, pas ici : ce fichier ne fait
// que constater.
//
// La mutation a lieu dans une COPIE temporaire, et jamais dans `src/` : les fichiers d'épreuve de
// `npm run test:unit` s'exécutent en parallèle, et une garde retirée dans le dépôt serait vue par
// les épreuves voisines. Le défaut a été trouvé par exécution — la campagne rendait « 11/11 tués »
// lancée seule et « 11 survivants » sous `test:unit`.

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
  // Le défaut que la revue a trouvé : la campagne comptait TUÉ tout code de sortie non nul, y
  // compris celui d'un « node --test » à qui l'on donne un fichier qui n'existe pas. Une table qui
  // se périme — un fichier renommé, une épreuve déplacée — se serait donc mise à rendre 11/11 en ne
  // mesurant plus rien. Un mutant n'est tué que si l'épreuve PASSAIT avant la mutation.
  const { resultats } = campagneDeMutation({
    mutations: [{ ...MUTATIONS[0], epreuves: ["tests/unit/epreuve-qui-nexiste-pas.test.mjs"] }],
  });
  assert.equal(resultats[0].tue, false, "une épreuve absente ne tue rien");
  assert.match(resultats[0].raison ?? "", /base|absente|avant la mutation/i);
});

test("la table couvre les gardes que l'ADR 0024 nomme, et les deux de la quiescence", () => {
  const noms = MUTATIONS.map((mutation) => mutation.nom).join(" | ");
  for (const attendu of [
    "identifiant de volume",
    "séquence",
    "génération",
    "FORMAT DE VOLUME",
    "réserve de l'en-tête",
    "empreinte de région",
    "empreinte d'image",
    "marque de complétude",
    "sceau",
    "quiescence",
    "retrait",
    "voisinage",
  ]) {
    assert.ok(noms.includes(attendu), `aucune mutation ne vise « ${attendu} »`);
  }
});
