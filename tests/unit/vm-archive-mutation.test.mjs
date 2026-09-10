import assert from "node:assert/strict";
import test from "node:test";

import { campagneDeMutation } from "../../tools/moteur-de-mutation.mjs";
import { MUTATIONS } from "../../tools/muter-gardes-archive-recuperation.mjs";

// ÉPREUVE DE MUTATION des gardes de l'archive v3, de son ENGAGEMENT et de l'ancre de version
// (#181, ADR 0033 ; #149, ADR 0027).
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cette épreuve RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, et
// vérifie qu'elle rougit. Un mutant qui SURVIT est un trou de la preuve.
//
// Ce qu'elle garde tient en une phrase : l'ADR 0027 RÉVISE une décision de sécurité, et ce qui la
// sépare d'un renoncement tient en quelques lignes — le filtre des types, l'empreinte de la section,
// la confrontation de l'en-tête à la page, l'ordre des deux derniers gestes, le consentement, et la
// transmission de la feuille. Ces lignes-là ne doivent pas pouvoir disparaître en silence.
//
// Elle est lente — une recopie du dépôt, puis une vingtaine de processus `node --test` — et c'est le
// prix d'une mutation qui n'est pas simulée. La table vit dans l'outil, pas ici : ce fichier ne fait
// que constater. La mutation a lieu dans une COPIE temporaire, jamais dans `src/`, parce que les
// fichiers d'épreuve de `npm run test:unit` s'exécutent en parallèle et qu'une garde retirée dans le
// dépôt serait vue par les épreuves voisines.

const campagne = campagneDeMutation({ mutations: MUTATIONS, etiquette: "archive-recuperation" });

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

test("la table couvre les DIX modules où la révision et l'engagement se jouent", () => {
  // Un compte de mutants ne dit rien de leur RÉPARTITION : dix mutations sur la même ligne feraient
  // un score parfait et ne mesureraient qu'une garde. Ce contrôle relit les FICHIERS visés — les
  // cinq endroits où la révision de la décision 6 se joue (#149), et les cinq où l'ENGAGEMENT de
  // #181 vit : ce qu'il scelle, sous quelle clé, ce que l'ouverture en fait, ce qu'un volume sans
  // racine devient, et ce qui autorise la création à écrire sa racine.
  const fichiers = [...new Set(MUTATIONS.map((mutation) => mutation.fichier))].sort();
  assert.deepEqual(fichiers, [
    "src/vm/archive-engagement.mjs",
    "src/vm/archive-recuperation.mjs",
    "src/vm/derivation/cle-de-domaine.mjs",
    "src/vm/enveloppe-de-recuperation.mjs",
    "src/vm/generation-recuperation.mjs",
    "src/vm/opfs-racine-initiale.mjs",
    "src/vm/opfs-volume-ouverture.mjs",
    "src/vm/ouverture-par-enveloppe.mjs",
    "src/vm/volume-export.mjs",
    "src/vm/volume-import.mjs",
  ]);
});
