#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes de l'instantané de reprise (#65, ADR 0024).
//
//     node tools/muter-gardes-instantane.mjs [--json]
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Cet outil RETIRE
// réellement chaque garde du fichier source, relance l'épreuve qui devrait la couvrir, puis restaure
// le fichier. Un mutant qui SURVIT est un trou de la preuve, pas une bonne nouvelle.
//
// ## Pourquoi une mutation TEXTUELLE, et pas un mandataire
//
// `vm-crash-mutation.test.mjs` mute par `Proxy`, et c'est le bon outil là-bas : la garde qu'il
// attaque est un COMPORTEMENT du magasin — « valider sans sceller » —, remplaçable de l'extérieur.
// Les gardes de #65 sont des CONDITIONS à l'intérieur de fonctions pures : `if (declare !== present)`,
// `if (!marqueCompleteEcrite(marque))`. Aucun mandataire ne les atteint. Les retirer du texte est la
// seule mutation qui décrive vraiment « cette garde n'existe pas ».
//
// ## La mutation a lieu sur une COPIE, jamais sur le dépôt
//
// Muter les sources du dépôt en place aurait deux défauts, et le second est le grave :
//
//  1. un processus interrompu au mauvais moment laisserait une garde retirée dans « src/ » ;
//  2. « npm run test:unit » exécute les fichiers d'épreuve EN PARALLÈLE, chacun dans son processus.
//     Une mutation appliquée dans « src/ » serait visible par les épreuves voisines qui importent
//     le même module au même instant, et cette campagne ferait alors rougir des épreuves
//     étrangères, au hasard de l'ordonnancement.
//
// Le défaut a été trouvé PAR EXÉCUTION : la campagne rendait « 11/11 tués » lancée seule et
// « 11 survivants » sous « test:unit ». « src/ », « tests/ » et « tools/ » sont donc recopiés dans
// un répertoire temporaire, et c'est LÀ que la mutation vit. Le dépôt n'est jamais touché.
//
// ## Le NODE_TEST_CONTEXT du parent est retiré de l'enfant
//
// C'est l'autre moitié du même défaut, et elle mérite d'être écrite : le lanceur d'épreuves de Node
// pose « NODE_TEST_CONTEXT » dans l'environnement, et un « node --test » qui en hérite se croit
// sous-processus d'un lanceur — il rapporte à son parent et sort avec le code 0. Un mutant vivant
// devenait alors indiscernable d'un mutant tué.
//
// ## Ce que la première campagne a trouvé
//
// Un mutant a SURVÉCU au premier passage : le contrôle « la taille du fichier vaut celle que
// l'en-tête déclare » de `lireInstantane`. Il n'a pas été couvert par un test de plus — il a été
// RETIRÉ, parce qu'aucun état atteignable ne le distinguait de la marque de complétude. C'est le
// service qu'on attend d'une campagne de mutation : elle ne dit pas seulement « il manque une
// épreuve », elle dit parfois « il y a une garde de trop ». La raison est écrite à l'endroit exact
// où le contrôle vivait.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../", import.meta.url));

const CONDUITE = "src/vm/instantane-de-reprise.mjs";
const FICHIER = "src/vm/instantane/fichier-instantane.mjs";
const MODELE = "src/vm/instantane/modele-reference.mjs";
const ADAPTATEUR = "src/vm/v86-buffer-adapter.mjs";
const VOISINS = "src/vm/opfs-sync-access.mjs";

const EPREUVE_CONDUITE = "tests/unit/vm-instantane-conduite.test.mjs";
const EPREUVE_QUIESCENCE = "tests/unit/vm-adaptateur-quiescence.test.mjs";
const EPREUVE_VOISIN = "tests/unit/vm-instantane-voisin.test.mjs";
const EPREUVE_MODELE = "tests/unit/vm-instantane-modele.test.mjs";
const EPREUVE_FICHIER = "tests/unit/vm-instantane-fichier.test.mjs";

/**
 * Les gardes, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard. C'est la même exigence que celle d'un `sed` de revue.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "écart d'identifiant de volume",
    garde: "confronterLiaison — champ « volume »",
    fichier: CONDUITE,
    avant: "  if (declaree.volume !== presente.volume) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "écart de version de FORMAT DE VOLUME",
    garde: "confronterLiaison — champ « formatVolume »",
    fichier: CONDUITE,
    avant: "  if (declaree.formatVolume !== presente.formatVolume) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "réserve de l'en-tête : quatre octets de canal libre",
    garde: "decoderEnTete — la réserve est nulle",
    fichier: FICHIER,
    avant: "  if (octets.subarray(OFFSET.reserve, EN_TETE_OCTETS).some((octet) => octet !== 0)) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_FICHIER],
  },
  {
    nom: "séquence : un RECUL du journal passerait",
    garde: "confronterLiaison — la séquence ne recule pas",
    fichier: CONDUITE,
    avant: "  if (presente.sequence < declaree.sequence) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "écart de génération validée",
    garde: "confronterLiaison — champ « generation »",
    fichier: CONDUITE,
    avant: "  if (declaree.generation !== presente.generation) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "écart d'empreinte de région",
    garde: "confronterLiaison — champ « empreinteRegion »",
    fichier: CONDUITE,
    avant: '    ["empreinteRegion", declaree.empreinteRegion, presente.empreinteRegion],\n',
    apres: "",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "écart d'empreinte d'image de référence",
    garde: "confronterLiaison — champ « empreinteImage »",
    fichier: CONDUITE,
    avant: '    ["empreinteImage", declaree.empreinteImage, presente.empreinteImage],\n',
    apres: "",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "marque de complétude",
    garde: "marqueCompleteEcrite — le motif exact",
    fichier: FICHIER,
    avant:
      "  return (\n    octets instanceof Uint8Array &&\n    octets.byteLength === MARQUE_OCTETS &&\n    MARQUEUR_COMPLET.every((attendu, index) => octets[index] === attendu)\n  );",
    apres: "  return true;",
    epreuves: [EPREUVE_CONDUITE, EPREUVE_FICHIER],
  },
  {
    nom: "sceau du corps : des zéros au lieu d'un refus",
    garde: "ouvrirInstantane — le refus de l'étiquette",
    fichier: MODELE,
    avant: '    if (erreur?.name !== "OperationError") throw erreur;\n    throw sceauRefuse({',
    apres:
      '    if (erreur?.name !== "OperationError") throw erreur;\n    return new Uint8Array(exigee.longueurEtat);\n    // eslint-disable-next-line no-unreachable\n    throw sceauRefuse({',
    epreuves: [EPREUVE_MODELE, EPREUVE_CONDUITE],
  },
  {
    nom: "quiescence : l'E/S passe pendant la capture",
    garde: "creerQuiescence.refuser",
    fichier: ADAPTATEUR,
    avant: "    refuser(source, contexte) {\n      if (!actif) return false;",
    apres:
      "    refuser(source, contexte) {\n      if (!actif) return false;\n      if (actif) return false;",
    epreuves: [EPREUVE_QUIESCENCE],
  },
  {
    nom: "quiescence : une E/S en vol n'empêche plus la capture",
    garde: "creerQuiescence.etablir — le contrôle de inFlight",
    fichier: ADAPTATEUR,
    avant: "      if (inFlight > 0) {",
    apres: "      if (false && inFlight > 0) {",
    epreuves: [EPREUVE_QUIESCENCE],
  },
  {
    nom: "retrait : l'instantané écarté reste sur le support",
    garde: "retirerSansMasquer",
    fichier: CONDUITE,
    avant: "    await support.retirer();",
    apres: "    await Promise.resolve();",
    epreuves: [EPREUVE_CONDUITE],
  },
  {
    nom: "voisinage : l'instantané ne part plus avec le volume",
    garde: "voisinsDunVolume — le suffixe d'instantané",
    fichier: VOISINS,
    avant: "    INSTANTANE_SIDECAR_SUFFIX,\n  ].map((suffixe) => `${nom}${suffixe}`);",
    apres: "  ].map((suffixe) => `${nom}${suffixe}`);",
    epreuves: [EPREUVE_VOISIN],
  },
]);

/** Ce que la copie emporte : le code, les épreuves, et les outils que celles-ci importent. */
const RECOPIES = ["src", "tests", "tools", "package.json"];

/** Recopie le dépôt utile dans un répertoire temporaire, et rend son chemin. */
function copierLeDepot() {
  const atelier = mkdtempSync(join(tmpdir(), "vault-mutation-"));
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
 *
 * Le code est rendu tel quel — jamais réduit à un booléen — parce qu'il porte trois états et non
 * deux : `0` (l'épreuve passe), un entier non nul (elle rougit), et `null` (l'enfant a été tué par
 * un signal, ou n'a pas démarré). Confondre le troisième avec le deuxième ferait passer une panne
 * de campagne pour un mutant tué.
 */
function rejouer(atelier, epreuves) {
  const environnement = { ...process.env };
  delete environnement.NODE_TEST_CONTEXT;
  const resultat = spawnSync(process.execPath, ["--test", "--test-timeout=20000", ...epreuves], {
    cwd: atelier,
    encoding: "utf8",
    env: environnement,
  });
  return resultat.status;
}

/**
 * Applique une mutation dans l'atelier, rejoue, remet le fichier d'origine.
 *
 * **L'épreuve est d'abord jouée SANS mutation**, et c'est la garde que la revue a exigée : sans
 * elle, la campagne comptait TUÉ tout code de sortie non nul, y compris celui d'un `node --test` à
 * qui l'on donne un fichier qui n'existe pas. Une table qui se périme — un fichier renommé, une
 * épreuve déplacée — se serait donc mise à rendre « tous tués » en ne mesurant plus rien. Un mutant
 * n'est tué que si l'épreuve **passait** avant qu'on le pose.
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
        raison:
          "l'enfant a été tué ou n'a pas démarré sous mutation : la campagne n'a rien mesuré.",
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
    console.log(`
${resultats.length - survivants}/${resultats.length} mutants tués.`);
  }
  process.exit(resultats.some((resultat) => !resultat.tue) ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
