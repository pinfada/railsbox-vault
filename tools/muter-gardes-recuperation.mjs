#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du moyen de récupération (#147, ADR 0025).
//
//     node tools/muter-gardes-recuperation.mjs [--json]
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cet outil RETIRE
// réellement chaque garde neuve du fichier source, relance l'épreuve qui devrait la couvrir, puis
// restaure. Un mutant qui SURVIT est un trou de la preuve, pas une bonne nouvelle.
//
// Le moteur est celui de `tools/muter-gardes-instantane.mjs` (#65, ADR 0024) : recopie du dépôt
// dans un atelier temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, épreuve jouée SANS mutation
// d'abord. Les trois raisons sont écrites là-bas et valent ici mot pour mot ; ce fichier ne
// redéfinit que sa TABLE, parce que ce sont les gardes qui changent, pas la méthode.
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

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../", import.meta.url));

const CODE = "src/vm/derivation/code-de-recuperation.mjs";
const DERIVATEUR = "src/vm/derivation/derivateur-recuperation.mjs";
const MOYEN = "src/vm/moyen-de-recuperation.mjs";
const PARAMETRES = "src/vm/derivation/parametres-publics.mjs";

const EPREUVE = "tests/unit/vm-derivation-recuperation.test.mjs";

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
    garde: "ALPHABET_CROCKFORD",
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
    avant: "    const valeur = replie.length === 1 ? ALPHABET_CROCKFORD.indexOf(replie) : -1;",
    apres:
      "    const valeur =\n" +
      "      replie.length === 1 ? Math.max(0, ALPHABET_CROCKFORD.indexOf(replie)) : 0;",
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
    nom: "la version du moyen est relue STRICTEMENT",
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
    nom: "le code n'est rendu QU'UNE fois",
    garde: "porteurDuCode — la chaîne relâchée au premier rendu",
    fichier: MOYEN,
    avant: "      restant = null;",
    apres: "      restant = valeur;",
    epreuves: [EPREUVE],
  },
]);

/** Ce que la copie emporte : le code, les épreuves, les vecteurs et les outils qu'elles importent. */
const RECOPIES = ["src", "tests", "tools", "public", "package.json"];

/** Recopie le dépôt utile dans un répertoire temporaire, et rend son chemin. */
function copierLeDepot() {
  const atelier = mkdtempSync(join(tmpdir(), "vault-mutation-recuperation-"));
  for (const entree of RECOPIES) {
    cpSync(join(RACINE, entree), join(atelier, entree), { recursive: true });
  }
  return atelier;
}

/**
 * Rejoue des épreuves DANS l'atelier, et rend le CODE DE SORTIE observé.
 *
 * `NODE_TEST_CONTEXT` est retiré de l'environnement de l'enfant : hérité, il ferait sortir un
 * `node --test` avec le code 0 quoi qu'il arrive, et un mutant vivant passerait pour mort.
 */
function rejouer(atelier, epreuves) {
  const environnement = { ...process.env };
  delete environnement.NODE_TEST_CONTEXT;
  const resultat = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...epreuves], {
    cwd: atelier,
    encoding: "utf8",
    env: environnement,
  });
  return resultat.status;
}

/**
 * Applique une mutation dans l'atelier, rejoue, remet le fichier d'origine.
 *
 * L'épreuve est d'abord jouée SANS mutation : un mutant n'est tué que si l'épreuve PASSAIT avant
 * qu'on le pose. C'est la garde que la revue de #65 a exigée, et elle vaut ici pour la même raison.
 */
function eprouver(atelier, mutation) {
  const chemin = join(atelier, mutation.fichier);
  const original = readFileSync(chemin, "utf8");
  const identite = { nom: mutation.nom, garde: mutation.garde };
  const occurrences = original.split(mutation.avant).length - 1;
  if (occurrences !== 1) {
    return {
      ...identite,
      applicable: false,
      tue: false,
      raison: `le texte à retirer apparaît ${occurrences} fois dans ${mutation.fichier} — la mutation ne décrit pas ce qu'elle croit décrire.`,
    };
  }

  const base = rejouer(atelier, mutation.epreuves);
  if (base !== 0) {
    return {
      ...identite,
      applicable: false,
      tue: false,
      raison: `l'épreuve ne passe pas AVANT la mutation (code ${base === null ? "null — enfant tué ou non démarré" : base}) : elle ne peut rien mesurer.`,
    };
  }

  try {
    writeFileSync(chemin, original.replace(mutation.avant, mutation.apres), "utf8");
    const mute = rejouer(atelier, mutation.epreuves);
    if (mute === null) {
      return {
        ...identite,
        applicable: true,
        tue: false,
        raison: "l'enfant a été tué ou n'a pas démarré sous mutation : rien n'a été mesuré.",
      };
    }
    return { ...identite, applicable: true, tue: mute !== 0, raison: null };
  } finally {
    writeFileSync(chemin, original, "utf8");
  }
}

/** Rejoue toute la campagne. Exportée pour que l'épreuve la fasse tourner sans dupliquer la table. */
export function campagneDeMutation({ mutations = MUTATIONS } = {}) {
  const atelier = copierLeDepot();
  try {
    return { resultats: mutations.map((mutation) => eprouver(atelier, mutation)) };
  } finally {
    rmSync(atelier, { recursive: true, force: true });
  }
}

function principal() {
  const { resultats } = campagneDeMutation();
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
