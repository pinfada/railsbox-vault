#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes de la révocation d'urgence et de l'effacement de la page libre
// (#148, #156, ADR 0026).
//
//     node tools/muter-gardes-revocation-urgence.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs` : recopie du dépôt dans un atelier
// temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, épreuve jouée SANS mutation d'abord, arrêt
// sans verdict compté NON CONCLUANT. Ce fichier ne tient que sa TABLE.
//
// ## Une garde a demandé une épreuve qu'aucune assertion d'état ne pouvait porter
//
// « La seconde barrière est franchie » n'est mesurable par AUCUNE assertion sur les octets : le
// double de support de `tests/unit/support-enveloppe-double.mjs` modélise la VISIBILITÉ des
// écritures, pas leur DURABILITÉ, et sa barrière est un geste sans effet. Retirer `await
// support.barriere()` de l'effacement ne change donc pas un octet du fichier, et toute épreuve
// écrite sur l'état d'après aurait laissé ce mutant vivant.
//
// Ce qui le tue est le COMPTE DES GESTES : la matrice de coupures relève que la révocation en porte
// exactement quatre — écrire la page neuve, barrière, effacer l'ancienne, barrière — et un
// effacement sans barrière n'en porte plus que trois. C'est le second service d'une campagne de
// mutation : elle ne dit pas seulement « il manque une épreuve », elle dit parfois « la seule
// épreuve possible n'est pas celle que vous alliez écrire ».
//
// ## Ce que la campagne ne peut PAS mesurer, et il faut le dire
//
// Que la barrière franchie fasse réellement DURER les octets sur le disque. Aucune épreuve de ce
// dépôt ne coupe le courant ; ce que le produit tient sur ce point est ce que le moteur promet de
// `FileSystemSyncAccessHandle.flush`, et l'ADR 0026 l'écrit comme une limite plutôt que comme une
// preuve.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const ENVELOPPE = "src/vm/enveloppe-de-cle.mjs";
const ETAT = "src/vm/enveloppe/etat-de-lenveloppe.mjs";

const EPREUVE = "tests/unit/vm-enveloppe-revocation-urgence.test.mjs";
const MATRICE = "tests/unit/vm-enveloppe-coupures.test.mjs";
const RECUPERATION = "tests/unit/vm-derivation-recuperation.test.mjs";

/**
 * Les gardes de #148, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "l'emplacement conservé est celui que la KEK a OUVERT",
    garde: "revoquerToutSauf — le filtre sur `etat.identifiantEmplacement`",
    fichier: ENVELOPPE,
    avant:
      "      etat.page.emplacements.filter(\n" +
      "        (existant) => existant.identifiantEmplacement === etat.identifiantEmplacement,\n" +
      "      ),",
    apres: "      etat.page.emplacements.slice(0, 1),",
    epreuves: [EPREUVE],
  },
  {
    nom: "l'effacement vient APRÈS la barrière qui publie",
    garde: "muter — l'ordre de `publier` et de `effacerLaPageLiberee`",
    fichier: ENVELOPPE,
    avant:
      "  await publier(support, etat.pageLibre, octets);\n" +
      "  if (retire) await effacerLaPageLiberee(support, etat.index);",
    apres:
      "  if (retire) await effacerLaPageLiberee(support, etat.index);\n" +
      "  await publier(support, etat.pageLibre, octets);",
    epreuves: [MATRICE],
  },
  {
    nom: "l'effacement porte sur la page ENTIÈRE, remplissage compris",
    garde: "effacerLaPageLiberee — la largeur des zéros",
    fichier: ETAT,
    avant: "  await support.ecrire(offsetDePage(index), new Uint8Array(PAGE_OCTETS));",
    apres: "  await support.ecrire(offsetDePage(index), new Uint8Array(108));",
    epreuves: [EPREUVE],
  },
  {
    nom: "la SECONDE barrière est franchie",
    garde: "effacerLaPageLiberee — le `flush` qui suit l'effacement",
    fichier: ETAT,
    avant:
      "  await support.ecrire(offsetDePage(index), new Uint8Array(PAGE_OCTETS));\n" +
      "  await support.barriere();",
    apres: "  await support.ecrire(offsetDePage(index), new Uint8Array(PAGE_OCTETS));",
    epreuves: [MATRICE],
  },
  {
    nom: "un SEUL emplacement est ADMIS, jamais refusé",
    garde: "revoquerToutSauf — l'absence de refus sur une enveloppe déjà réduite",
    fichier: ENVELOPPE,
    avant: "    transformer: async (etat) =>\n      etat.page.emplacements.filter(",
    apres:
      "    transformer: async (etat) => {\n" +
      "      if (etat.page.emplacements.length === 1) {\n" +
      "        throw dernierEmplacement({ volume: identifiantVolume });\n" +
      "      }\n" +
      "      return etat.page.emplacements.filter(",
    epreuves: [EPREUVE],
  },
  {
    nom: "une RÉVOCATION efface la page libérée",
    garde: "revoquerEmplacement — `retire: true`",
    fichier: ENVELOPPE,
    avant:
      "    aleas,\n    retire: true,\n    transformer: async (etat) => {\n      const emplacements = etat.page.emplacements;",
    apres:
      "    aleas,\n    retire: false,\n    transformer: async (etat) => {\n      const emplacements = etat.page.emplacements;",
    epreuves: [EPREUVE, RECUPERATION],
  },
  {
    nom: "un REMPLACEMENT efface la page libérée : lui aussi RETIRE une clé",
    garde: "remplacerEmplacement — `retire: true`",
    fichier: ENVELOPPE,
    avant: "    // geste qui ne retire rien pendant une mutation entière.\n    retire: true,",
    apres: "    // geste qui ne retire rien pendant une mutation entière.\n    retire: false,",
    epreuves: [EPREUVE],
  },
  {
    nom: "un AJOUT n'efface RIEN : la règle est « tout RETRAIT efface »",
    garde: "ajouterEmplacement — l'absence de `retire`",
    fichier: ENVELOPPE,
    avant:
      "    identifiantVolume,\n    kek,\n    aleas,\n    transformer: async (etat, sources) => {\n" +
      "      if (etat.page.emplacements.length >= EMPLACEMENTS_MAX) {",
    apres:
      "    identifiantVolume,\n    kek,\n    aleas,\n    retire: true,\n    transformer: async (etat, sources) => {\n" +
      "      if (etat.page.emplacements.length >= EMPLACEMENTS_MAX) {",
    epreuves: [EPREUVE],
  },
]);

function principal() {
  const { resultats } = campagneDeMutation({
    mutations: MUTATIONS,
    etiquette: "revocation-urgence",
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ resultats }, null, 2));
  } else {
    for (const resultat of resultats) {
      console.log(`${resultat.tue ? "TUÉ    " : "SURVIT "} ${resultat.nom} — ${resultat.garde}`);
      if (resultat.raison !== null) console.log(`         ${resultat.raison}`);
    }
    const survivants = resultats.filter((resultat) => !resultat.tue).length;
    console.log(`\n${resultats.length - survivants}/${resultats.length} mutants tués.`);
  }
  process.exit(resultats.some((resultat) => !resultat.tue) ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
