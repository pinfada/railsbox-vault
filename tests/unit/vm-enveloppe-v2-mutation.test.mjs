import assert from "node:assert/strict";
import test from "node:test";

import { campagneDeMutation } from "../../tools/moteur-de-mutation.mjs";
import { MUTATIONS } from "../../tools/muter-gardes-enveloppe-v2.mjs";

// ÉPREUVE DE MUTATION des gardes de la PAGE D'ENVELOPPE v2 et de la CLÔTURE PAR RACINE (#182, T2b).
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cette épreuve RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, et
// vérifie qu'elle rougit. Un mutant qui SURVIT est un trou de la preuve.
//
// **Pourquoi cette campagne-ci plus que d'autres.** La tranche touche la SERRURE d'un volume, et sa
// Definition of Ready le dit sans détour : « perdre une enveloppe, c'est perdre le volume ». Une
// migration de page qui perdrait un emplacement, un sel qui cesserait d'être tiré, une page v1
// forgée qui reprendrait l'autorité : aucun de ces trois défauts ne se signale à l'exécution
// ordinaire, et les trois coûtent le coffre. La mutation est la seule façon de savoir, avant qu'un
// relecteur ne le trouve, si les épreuves les couvrent vraiment.
//
// Elle est lente — une recopie du dépôt, puis une douzaine de processus `node --test` — et c'est le
// prix d'une mutation qui n'est pas simulée. La table vit dans l'outil, pas ici : ce fichier ne fait
// que constater.

const campagne = campagneDeMutation({ mutations: MUTATIONS, etiquette: "enveloppe-v2" });

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

test("la table couvre les NEUF endroits où la tranche T2b se joue", () => {
  // Un compte de mutants ne dit rien de leur RÉPARTITION : quatorze mutations sur la même ligne
  // feraient un score parfait et ne mesureraient qu'une garde. Ce contrôle relit les FICHIERS visés,
  // et ils se lisent comme le chemin de la tranche : ce qui TIRE le sel et migre la page, ce qui
  // juge quelle page fait autorité, ce qui décode une page, ce qui CLÔT par une racine, ce qui
  // écrit hors transaction, ce qui décide de tenir le magasin, ce qui exporte un v3, ce qui
  // RÉSERVE dans la racine la place du témoin qui la suit — et le CLIQUET, seul « source » de cette
  // table qui soit lui-même une épreuve.
  const fichiers = [...new Set(MUTATIONS.map((mutation) => mutation.fichier))].sort();
  assert.deepEqual(fichiers, [
    "src/vm/enveloppe-de-cle.mjs",
    "src/vm/enveloppe/etat-de-lenveloppe.mjs",
    "src/vm/enveloppe/fichier-enveloppe.mjs",
    "src/vm/export-du-fichier.mjs",
    "src/vm/generation-racine.mjs",
    "src/vm/generation-store.mjs",
    "src/vm/opfs-block-backend.mjs",
    "src/vm/opfs-volume-ouverture.mjs",
    "tests/unit/vm-cliquet-anti-dek.test.mjs",
  ]);
});

test("le CLIQUET est muté par CHACUN de ses motifs, et pas par un seul", () => {
  // La revue de la PR #186 avait trouvé un cliquet dont un seul des deux mutants était vu ; celle de
  // la PR #187 en a trouvé deux de plus qui passaient — le réexport ALIASÉ de la porte et la liaison
  // locale d'`importKey`. Chaque motif du cliquet est donc muté SÉPARÉMENT : retirer l'un doit
  // suffire à faire rougir « le cliquet MORD », sans quoi un autre le couvrirait et la mesure serait
  // creuse.
  const surLeCliquet = MUTATIONS.filter(
    (mutation) => mutation.fichier === "tests/unit/vm-cliquet-anti-dek.test.mjs",
  );
  assert.equal(surLeCliquet.length, 4, "quatre motifs, quatre mutants");
  assert.deepEqual(
    [...new Set(surLeCliquet.flatMap((mutation) => mutation.epreuves))],
    ["tests/unit/vm-cliquet-anti-dek.test.mjs"],
    "l'épreuve qui doit rougir est la sienne : une garde d'inspection se mesure sur elle-même",
  );
  assert.deepEqual(
    surLeCliquet.map((mutation) => mutation.garde).sort(),
    [
      "vm-cliquet-anti-dek — `propagerParReexportEnBloc`",
      "vm-cliquet-anti-dek — `rendus.size > 0` dans `gestesDuModule`",
      "vm-cliquet-anti-dek — la conduite conservatrice de `referencesAImportKey`",
      "vm-cliquet-anti-dek — la propagation des noms APPRIS dans `aliasDeLaPorte`",
    ],
    "les quatre motifs sont : suivre les alias, en faire des portes, suivre le réexport en bloc, et " +
      "traiter une référence opaque comme un geste",
  );
});
