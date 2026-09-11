import assert from "node:assert/strict";
import test from "node:test";

import { campagneDeMutation } from "../../tools/moteur-de-mutation.mjs";
import { MUTATIONS } from "../../tools/muter-gardes-hierarchie-de-cles.mjs";

// ÉPREUVE DE MUTATION des gardes de la HIÉRARCHIE DE CLÉS et du format v4 (#182, ADR 0033, 0035).
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cette épreuve RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, et
// vérifie qu'elle rougit. Un mutant qui SURVIT est un trou de la preuve.
//
// **Pourquoi cette campagne-ci plus que d'autres.** La revue externe du 10 septembre 2026 n'a pas
// trouvé un bogue : elle a trouvé une PROMESSE que rien ne tenait. Le § 4.5 affirmait compter
// « toutes les invocations sous une clé » et comptait par instance de scellement. Cette tranche
// remplace cette promesse par d'autres — « chaque domaine a sa clé », « une session qui ne peut pas
// publier ses compteurs ne scelle pas », « une coupure de la migration ne coûte que la suite en
// vol » —, et rien ne dit d'avance qu'elles seront mieux tenues. La mutation est la seule façon de
// le savoir avant qu'un relecteur ne le trouve.
//
// Elle est lente — une recopie du dépôt, puis une vingtaine de processus `node --test` — et c'est le
// prix d'une mutation qui n'est pas simulée. La table vit dans l'outil, pas ici : ce fichier ne fait
// que constater.

const campagne = campagneDeMutation({ mutations: MUTATIONS, etiquette: "hierarchie-de-cles" });

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

test("la table couvre les NEUF modules où la hiérarchie et la v4 se jouent", () => {
  // Un compte de mutants ne dit rien de leur RÉPARTITION : dix mutations sur la même ligne feraient
  // un score parfait et ne mesureraient qu'une garde. Ce contrôle relit les FICHIERS visés, et ils
  // se lisent comme le chemin de la tranche : ce qui DÉRIVE une clé, ce qui l'assemble pour un
  // volume, ce qui scelle sous elle, ce que la racine authentifie, ce que le journal en écrit, ce
  // que la migration en fait, ce que la chaîne en fait, et l'endroit où la moitié tenue de la règle
  // de clôture vit — le REPORT des compteurs d'une racine écartée.
  const fichiers = [...new Set(MUTATIONS.map((mutation) => mutation.fichier))].sort();
  assert.deepEqual(fichiers, [
    "src/vm/derivation/cle-de-domaine.mjs",
    "src/vm/derivation/hierarchie-de-volume.mjs",
    "src/vm/format-chiffre/identite-logique.mjs",
    "src/vm/format-chiffre/modele-reference.mjs",
    "src/vm/generation-format.mjs",
    "src/vm/migration-v4.mjs",
    "src/vm/opfs-racine-initiale.mjs",
    "src/vm/scellement.mjs",
    "src/vm/volume-migration.mjs",
  ]);
});
