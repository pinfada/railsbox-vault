#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du moyen de récupération (#147, ADR 0025).
//
//     node tools/muter-gardes-recuperation.mjs [--json]
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cet outil RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, puis
// restaure. Un mutant qui SURVIT est un trou de la preuve, pas une bonne nouvelle.
//
// Le moteur vit dans `tools/moteur-de-mutation.mjs` depuis #148 : recopie du dépôt dans un atelier
// temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, épreuve jouée SANS mutation d'abord. Les
// raisons sont écrites là-bas ; ce fichier ne tient que sa TABLE, parce que ce sont les gardes qui
// changent, pas la méthode.
//
// ## UNE garde a eu besoin d'un vecteur pour devenir mortelle, et c'est la NFC
//
// Au premier passage, treize mutants sur quatorze sont morts et **la NFC a survécu**. Ce n'était
// pas une garde inutile : c'était une garde qu'aucune épreuve n'atteignait, pour une raison qui
// vaut d'être écrite — l'alphabet base 32 ne porte AUCUN caractère composable, si bien que
// normaliser ou non ne change rien d'observable sur les saisies que le dépôt éprouvait.
//
// Le vecteur du signe KELVIN (U+212A) la rend mesurable : sa décomposition canonique est un
// SINGLETON vers `K`, donc les quatre formes de normalisation le ramènent dans l'alphabet, et une
// saisie qui ne normaliserait pas du tout le refuserait. La mutation meurt depuis.
//
// C'est le second service d'une campagne de mutation : elle ne dit pas seulement « il manque une
// épreuve », elle dit parfois « l'épreuve que vous avez écrite ne touche pas la garde ».
//
// Le vecteur du « é » posé à la place d'un `0`, lui, n'a tué personne : le vecteur du chiffre
// PLEINE CHASSE le faisait déjà, par la même construction. Il reste parce qu'il sépare deux motifs
// de refus distincts — un signe sans AUCUNE correspondance Unicode, et un signe que seules les
// formes de compatibilité ramèneraient —, et qu'un vecteur qui ne tue pas aujourd'hui documente
// tout de même ce que le produit refuse.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const CODE = "src/vm/derivation/code-de-recuperation.mjs";
const DERIVATEUR = "src/vm/derivation/derivateur-recuperation.mjs";
const MOYEN = "src/vm/moyen-de-recuperation.mjs";
const PARAMETRES = "src/vm/derivation/parametres-publics.mjs";
const IDENTITE = "src/vm/enveloppe/identite-enveloppe.mjs";

const EPREUVE = "tests/unit/vm-derivation-recuperation.test.mjs";
const EPREUVE_TYPE = "tests/unit/vm-enveloppe-type-inconnu.test.mjs";

/**
 * Les gardes, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire
 * que la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter
 * une au hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "seize octets réellement TIRÉS",
    garde: "tirerCodeDeRecuperation — la largeur du tirage",
    fichier: CODE,
    avant: "  return crypto.getRandomValues(new Uint8Array(CODE_OCTETS));",
    apres:
      "  const tire = new Uint8Array(CODE_OCTETS);\n" +
      "  crypto.getRandomValues(tire.subarray(0, CODE_OCTETS / 2));\n" +
      "  return tire;",
    epreuves: [EPREUVE],
  },
  {
    nom: "les deux bits de bourrage sont RELUS",
    garde: "octetsDesSymboles — le bourrage nul",
    fichier: CODE,
    avant: "  if ((tampon & 0b11) !== 0) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "la somme de contrôle est vérifiée AVANT toute dérivation",
    garde: "decoderCode — sommeDeControleValide",
    fichier: CODE,
    avant: "  if (!sommeDeControleValide(symboles)) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "l'alphabet écarte I, L, O et U",
    garde: "ALPHABET_CROCKFORD, et la table close qui en dérive",
    fichier: CODE,
    avant: 'export const ALPHABET_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";',
    apres: 'export const ALPHABET_CROCKFORD = "0123456789ABCDEFGHIJKMNPQRSTVWXY";',
    epreuves: [EPREUVE],
  },
  {
    nom: "le repli de Crockford ramène « O » sur « 0 »",
    garde: "REPLIS",
    fichier: CODE,
    avant: '  ["O", "0"],\n',
    apres: "",
    epreuves: [EPREUVE],
  },
  {
    nom: "la NFC est appliquée à la saisie",
    garde: 'normaliserSaisie — normalize("NFC")',
    fichier: CODE,
    avant: '  for (const signe of texte.normalize("NFC")) {',
    apres: "  for (const signe of texte) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "un signe étranger est REFUSÉ, jamais replié par défaut",
    garde: "normaliserSaisie — le refus d'un signe hors alphabet",
    fichier: CODE,
    avant: "    const valeur = SIGNES_ACCEPTES.get(point);",
    apres: "    const valeur = SIGNES_ACCEPTES.get(point) ?? 0;",
    epreuves: [EPREUVE],
  },
  {
    nom: "les séparateurs sont RETIRÉS, tiret compris",
    garde: "SEPARATEURS",
    fichier: CODE,
    avant:
      "const SEPARATEURS = new Set([0x2d, 0x2013, 0x2014, 0x20, 0xa0, 0x202f, 0x09, 0x0a, 0x0d]);",
    apres: "const SEPARATEURS = new Set([0x2013, 0x2014, 0x20, 0xa0, 0x202f, 0x09, 0x0a, 0x0d]);",
    epreuves: [EPREUVE],
  },
  {
    nom: "la version du moyen est JUGÉE avant toute dérivation",
    garde: "exigerLaVersion",
    fichier: DERIVATEUR,
    avant: "  if (version !== RECUPERATION_VERSION) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "la largeur du sel HKDF est relue dans le FICHIER",
    garde: "decoderRecuperation — SEL_RECUPERATION_OCTETS",
    fichier: PARAMETRES,
    avant: "  if (largeur !== SEL_RECUPERATION_OCTETS) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "les seize octets sont effacés dès que le MATÉRIAU existe",
    garde: "materiauDuCode — effacer",
    fichier: DERIVATEUR,
    avant: "  } finally {\n    effacer(octets);\n  }",
    apres: "  } finally {\n    void octets;\n  }",
    epreuves: [EPREUVE],
  },
  {
    nom: "les seize octets TIRÉS sont effacés dès que la KEK existe",
    garde: "creerMoyenDeRecuperation — effacer",
    fichier: MOYEN,
    avant: "  } finally {\n    effacer(octets);\n  }",
    apres: "  } finally {\n    void octets;\n  }",
    epreuves: [EPREUVE],
  },
  {
    nom: "l'enveloppe est écrite et sa barrière franchie AVANT le rendu",
    garde: "creerMoyenDeRecuperation — l'attente de ajouterEmplacement",
    fichier: MOYEN,
    avant: "  const pose = await ajouterEmplacement({",
    apres: "  const pose = { version: 2 };\n  void ajouterEmplacement({",
    epreuves: [EPREUVE],
  },
  {
    nom: "un type de clé INCONNU reste lisible (garde de lecture, pas d'écriture)",
    garde: "exigerOctetDeTypeKek — la borne du CHAMP, et non la liste des types réservés",
    fichier: IDENTITE,
    avant: "  if (!Number.isSafeInteger(typeKek) || typeKek < 0 || typeKek > 0xff) {",
    apres: "  if (nomDuTypeKek(typeKek) === null) {",
    epreuves: [EPREUVE_TYPE],
  },
  {
    nom: "la largeur des seize octets est exigée par materiauDuCode",
    garde: "materiauDuCode — la largeur du code élargi",
    fichier: DERIVATEUR,
    avant: "  if (!(octets instanceof Uint8Array) || octets.byteLength !== CODE_OCTETS) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE],
  },
  {
    nom: "le code n'est rendu QU'UNE fois",
    garde: "porteurDuCode — la chaîne relâchée au premier rendu",
    fichier: MOYEN,
    avant: "      restant = null;",
    apres: "      restant = valeur;",
    epreuves: [EPREUVE],
  },
]);

function principal() {
  const { resultats } = campagneDeMutation({ mutations: MUTATIONS, etiquette: "recuperation" });
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
