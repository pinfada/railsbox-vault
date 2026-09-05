#!/usr/bin/env node
// Construit, à partir d'un commit, les DEUX arborescences publiables de l'ADR 0002 — coquille et
// territoire applicatif — et sait les vérifier.
//
//   node tools/publier.mjs                             construit depuis l'arbre de travail
//   node tools/publier.mjs --commit <ref>              construit depuis les OCTETS de ce commit
//   node tools/publier.mjs --verifier <arbre>          recalcule les empreintes et compare
//
// Ce que la construction produit, par arbre : les fichiers décidés par
// `tools/publier-arborescences.mjs`, un fichier `_headers` rendu depuis `tools/serve-headers.mjs`
// (`tools/publier-en-tetes.mjs`), et un `inventaire.json` portant l'empreinte SHA-256 de chaque
// fichier, l'empreinte de racine de l'ensemble, et le commit qui l'a produit.
//
// RETOUR ARRIÈRE — c'est le même outil, et c'est voulu. `--commit <version-précédente>` reconstruit
// l'arbre de cette version-là ; son empreinte de racine doit retrouver, au bit près, celle que la
// construction d'alors avait inscrite. Republier c'est redéposer cet arbre. La procédure est écrite
// dans `docs/release-policy.md` et éprouvée par `.github/workflows/publication.yml`.
//
// CODES DE SORTIE — ils sont le contrat de l'outil, pas un détail :
//   0  conforme
//   1  ÉCART : un fichier altéré, ajouté ou manquant, ou une empreinte de racine différente
//   2  inventaire absent, illisible, ou d'un contrat que cette version ne sait pas relire
//   3  usage invalide
//   4  source obligatoire absente : la publication n'est pas constructible
//   5  ÉPINGLAGE ROMPU : un manifeste vendu absent de l'arbre, ou un artefact servi qui ne
//      correspond pas à ce qu'il épingle. Les DEUX manifestes sont vérifiés — `vendor/v86` (ADR
//      0003) et `vendor/argon2` (ADR 0021) —, et chacun doit l'être là où son artefact est publié.
//   6  arbre INCOMPLET : une source optionnelle manque (le runtime v86). L'arbre est cohérent et
//      son inventaire est exact, mais ce n'est pas un artefact publiable. `--tolerer-incomplet`
//      ramène ce cas à un avertissement, pour les contextes — bancs, `npm run check` — qui n'ont
//      pas besoin de l'émulateur et ne prétendent pas publier.
//
// #106 n'ajoute AUCUN code à ce contrat, et deux entrées mal formées y sont rangées explicitement :
// une `--sortie` refusée et une `--commit <ref>` non résoluble sont des USAGES invalides (3). Un
// arbre construit depuis un arbre de travail SALE reste, lui, CONFORME (0) : `--verifier` l'annonce
// par un avertissement et n'en fait pas un écart. Rendre 1 confondrait « altéré après publication »
// avec « construit depuis un disque non versionné » — la première est une atteinte à l'intégrité,
// la seconde une lacune de PROVENANCE — et refuserait au passage tout arbre de développement.

import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ARBRES, EXCLUSIONS } from "./publier-arborescences.mjs";
import {
  FICHIER_HEADERS,
  ORIGINE_APPLICATION_PAR_DEFAUT,
  ORIGINE_COQUILLE_PAR_DEFAUT,
  cheminsHorsPolitiqueUniforme,
  enTetesDePublication,
  origineDeLArbre,
  rendreFichierHeaders,
} from "./publier-en-tetes.mjs";
import {
  FICHIER_INVENTAIRE,
  construireInventaire,
  empreinte,
  relever,
  verifierArbre,
} from "./publier-inventaire.mjs";
import {
  SITUATIONS_EPINGLAGE,
  ecrireManifesteEpingle,
  exigerReferenceResoluble,
  identiteDuCommit,
  materialiser,
  verifierEpinglageArgon2,
  verifierEpinglageV86,
} from "./publier-sources.mjs";
import { REPOSITORY_ROOT } from "./v86-paths.mjs";

export const CODES = Object.freeze({
  conforme: 0,
  ecart: 1,
  inventaireIllisible: 2,
  usage: 3,
  sourceAbsente: 4,
  epinglageRompu: 5,
  incomplet: 6,
});

const SORTIE_PAR_DEFAUT = "artifacts/publication";

/** Répertoires que la construction écrit sous `--sortie` — et donc EFFACE avant de les réécrire. */
const NOMS_DARBRES = Object.freeze(ARBRES.map(({ nom }) => nom));

/** Ce que la construction efface, tel qu'un refus doit le nommer à l'opérateur. */
const EFFACES = NOMS_DARBRES.map((nom) => `<sortie>/${nom}`).join(" et ");

/**
 * Chemin RÉEL d'un chemin qui n'existe pas encore : le premier ancêtre existant est résolu par
 * `realpath`, et ce qui le suit lui est raccroché tel quel.
 *
 * `realpath` refuse un chemin absent, et une sortie de publication est le plus souvent absente —
 * c'est même le cas nominal. Résoudre l'ancêtre suffit : ce qui décide de l'endroit où le `rm -rf`
 * frappera, ce sont les liens déjà posés sur le disque, pas les répertoires qu'il créera lui-même.
 */
async function cheminReel(chemin) {
  let ancetre = chemin;
  for (;;) {
    try {
      return join(await realpath(ancetre), relative(ancetre, chemin));
    } catch (erreur) {
      if (erreur.code !== "ENOENT") throw erreur;
      const parent = dirname(ancetre);
      // Une racine de volume qui n'existe pas : rien à résoudre, le chemin demandé fait foi.
      if (parent === ancetre) return chemin;
      ancetre = parent;
    }
  }
}

/**
 * **OÙ** la sortie a le droit d'être : STRICTEMENT sous la racine du dépôt, chemin RÉEL à l'appui.
 *
 * L'outil produit un artefact de construction de ce dépôt ; tous ses usages documentés visent
 * `artifacts/`, que `.gitignore` couvre. Effacer ailleurs, c'est effacer là où ni git ni la revue
 * ne verront le dommage. Un opérateur qui veut déposer l'arbre ailleurs le COPIE après coup : c'est
 * un geste qui laisse une trace, contrairement à un `rm -rf` implicite.
 *
 * La comparaison porte sur les chemins réels des DEUX côtés, et c'est le correctif de la revue de
 * #106 : `relative()` est purement lexical, si bien qu'une jonction — ou un lien symbolique —
 * posée sous `artifacts/` et pointant hors du dépôt lui paraissait interne. Le `rm -rf` qui suit,
 * lui, traverse le lien : le message « ne le fait que là où git rend le dommage visible » était
 * alors faux, et c'est cette phrase que la garde doit rendre vraie. Le cadrage ne change pas pour
 * autant — voir `exigerSortieUtilisable`.
 *
 * @param {string} sortie chemin absolu déjà résolu
 * @param {string} racine racine du dépôt
 * @throws {Error} usage invalide (code 3)
 */
async function exigerSortieSousLaRacine(sortie, racine) {
  const interne = relative(await cheminReel(racine), await cheminReel(sortie));
  if (interne === "") {
    throw new Error(
      `Sortie refusée : ${sortie} est la racine du dépôt elle-même. La construction y sèmerait les ` +
        `répertoires ${NOMS_DARBRES.join(" et ")} au milieu des sources ; visez un répertoire qui ` +
        `lui soit dédié, sous ${SORTIE_PAR_DEFAUT.split("/")[0]}/.`,
    );
  }
  // `startsWith("..")` refusait `..donnees`, qui est un répertoire du dépôt, avec un message
  // affirmant le contraire. Seul un SEGMENT `..` sort de la racine.
  if (interne === ".." || interne.startsWith(`..${sep}`) || isAbsolute(interne)) {
    throw new Error(
      `Sortie refusée : ${sortie} est hors de la racine du dépôt (${racine}) — chemin réel, liens ` +
        `de répertoire résolus. La construction efface ${EFFACES} avant de les réécrire, et ne le ` +
        `fait que là où git rend le dommage visible.`,
    );
  }
}

/**
 * Ce que `--sortie` a le droit de faire effacer.
 *
 * `construireArbre` commence par `rm(<sortie>/<arbre>, { recursive: true, force: true })`. Le rayon
 * réel de ce geste est étroit — il ne vise que des répertoires nommés `coquille` et `application` —
 * mais il est dirigé par une chaîne de la ligne de commande, et rien ne le bornait (#106, L2).
 *
 * Deux gardes, et chacune répond à une question différente :
 *
 *  1. **OÙ** — `exigerSortieSousLaRacine`, ci-dessus ;
 *  2. **QUOI** — le répertoire doit être absent, vide, ou ne contenir que des arbres de
 *     publication. La garde ne cherche pas à reconnaître une publication PRÉCÉDENTE au fichier
 *     `inventaire.json` près : une construction interrompue en laisse un arbre partiel qui n'en a
 *     pas encore, et refuser de le réécrire ferait d'un échec passager un échec collant. Ce qu'elle
 *     établit est plus simple et suffit : ce répertoire n'appartient qu'à la publication.
 *
 * Ce n'est pas une frontière de confiance du produit — l'outil s'exécute déjà avec les droits de
 * qui le lance, et `SECURITY.md` n'a rien à en dire. C'est une garde d'ERGONOMIE contre la faute de
 * frappe, au même titre que le refus d'une référence git illisible. Résoudre le chemin réel ne
 * l'élève pas au rang de frontière de confiance : elle ne résiste pas à un lien posé ENTRE la
 * vérification et l'effacement, et elle n'a pas à le faire. Elle rend seulement vrai ce que son
 * refus affirme.
 *
 * @param {string} sortie chemin absolu déjà résolu
 * @param {string} [racine] racine du dépôt
 * @throws {Error} usage invalide (code 3)
 */
export async function exigerSortieUtilisable(sortie, racine = REPOSITORY_ROOT) {
  await exigerSortieSousLaRacine(sortie, racine);

  let entrees;
  try {
    entrees = await readdir(sortie);
  } catch (erreur) {
    if (erreur.code === "ENOENT") return;
    throw new Error(
      `Sortie refusée : ${sortie} n'est pas un répertoire lisible (${erreur.code}).`,
      {
        cause: erreur,
      },
    );
  }
  const intrus = entrees.filter((entree) => !NOMS_DARBRES.includes(entree));
  if (intrus.length > 0) {
    throw new Error(
      `Sortie refusée : ${sortie} contient des entrées que la publication n'a pas produites — ` +
        `${intrus.join(", ")}. Visez un répertoire vide, absent, ou celui d'une publication ` +
        `précédente.`,
    );
  }
}

/**
 * Ce que l'inventaire dit de la PROVENANCE de ses octets — et pourquoi ce n'est pas un écart.
 *
 * `construireInventaire` inscrit `commit.arbreDeTravailPropre`, et `--verifier` ne le relisait pas
 * (#106, L3) : un arbre bâti depuis un disque modifié était déclaré conforme sans que rien ne le
 * signale, alors que l'inventaire portait l'information.
 *
 * L'avertissement vaut aussi sous `--commit`, et ce n'est pas un excès de zèle : même quand les
 * octets des sources viennent de `git show`, deux choses viennent toujours du disque — les sources
 * hors git (`vendor/v86/artefacts`, épinglées par empreinte) et les OUTILS qui rendent l'arbre,
 * `tools/publier-en-tetes.mjs` en tête. Un `_headers` produit par un outil modifié et non versionné
 * est exactement ce qu'un vérificateur doit refuser de taire.
 *
 * @param {{ commit?: { empreinte?: string | null, arbreDeTravailPropre?: boolean } }} inventaire
 * @returns {{ avertissement: boolean, ligne: string }}
 */
export function provenanceDeLInventaire(inventaire) {
  const commit = inventaire.commit ?? {};
  if (commit.arbreDeTravailPropre === true) {
    return { avertissement: false, ligne: "Arbre de travail propre à la construction." };
  }
  if (commit.empreinte === null || commit.empreinte === undefined) {
    return {
      avertissement: true,
      ligne:
        "AVERTISSEMENT : provenance INCONNUE. L'inventaire ne porte aucune empreinte de commit — " +
        "l'arbre a été construit hors d'un dépôt git. Ses empreintes sont exactes ; l'origine de " +
        "ses octets n'est établie par rien.",
    };
  }
  return {
    avertissement: true,
    ligne:
      "AVERTISSEMENT : arbre construit depuis un dépôt dont l'ARBRE DE TRAVAIL n'était pas propre. " +
      "Les empreintes sont conformes — l'arbre est bien ce que son inventaire décrit — mais des " +
      "modifications non versionnées ont pu entrer dans ses octets : les sources hors git et les " +
      "outils qui l'ont rendu viennent du disque, y compris sous --commit. Ce n'est pas un écart : " +
      "le code de sortie reste 0.",
  };
}

function lireOption(argv, nom, defaut = null) {
  const index = argv.indexOf(`--${nom}`);
  if (index < 0) return defaut;
  const valeur = argv[index + 1];
  if (valeur === undefined || valeur.startsWith("--")) {
    throw new Error(`L'option --${nom} attend une valeur.`);
  }
  return valeur;
}

/**
 * Un arbre est un BANC dès qu'une de ses deux origines n'est pas `https:`.
 *
 * Le critère est volontairement grossier : il n'essaie pas de deviner l'intention, il constate
 * qu'une origine de production est nécessairement un contexte sécurisé. `http://localhost:4194`,
 * qu'emploie `npm run publier:check`, tombe donc du bon côté sans qu'aucun drapeau ne soit à poser.
 */
export function estUnBanc({ origineCoquille, origineApplication }) {
  return [origineCoquille, origineApplication].some((origine) => {
    try {
      return new URL(origine).protocol !== "https:";
    } catch {
      return true;
    }
  });
}

async function ecrireInventaire(destination, inventaire) {
  await writeFile(
    join(destination, FICHIER_INVENTAIRE),
    `${JSON.stringify(inventaire, null, 2)}\n`,
    "utf8",
  );
}

/** Refuse un arbre dont un chemin recevrait du serveur de test une politique autre que la racine. */
async function exigerPolitiqueUniforme(arbre, destination, options) {
  const chemins = (await relever(destination)).map(({ chemin }) => chemin);
  const dissidents = cheminsHorsPolitiqueUniforme(arbre.nom, chemins, options);
  if (dissidents.length === 0) return;
  throw new Error(
    `Le fichier ${FICHIER_HEADERS} annoncerait une politique uniforme que ces chemins ne ` +
      `reçoivent pas de \`tools/serve-headers.mjs\` : ${dissidents.join(", ")}.`,
  );
}

async function construireArbre(arbre, options) {
  const destination = join(options.sortie, arbre.nom);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const absentes = await materialiser({
    racine: REPOSITORY_ROOT,
    reference: options.reference,
    sources: arbre.sources,
    destination,
  });
  if (arbre.placeTenante) {
    await writeFile(join(destination, arbre.placeTenante.vers), arbre.placeTenante.contenu, "utf8");
  }
  // La copie du manifeste ADRESSÉE PAR SON EMPREINTE, écrite avant l'inventaire pour y entrer
  // comme tout autre octet servi (#123). Elle donne à la classe immuable un membre présent dans
  // TOUT arbre publié, y compris quand `vendor/v86/artefacts/` est absent d'un clone vierge, et
  // elle rend l'épinglage remontable depuis une adresse d'artefact. Voir `ecrireManifesteEpingle`.
  await ecrireManifesteEpingle(destination, empreinte);
  await writeFile(
    join(destination, FICHIER_HEADERS),
    rendreFichierHeaders(arbre.nom, options),
    "utf8",
  );
  await exigerPolitiqueUniforme(arbre, destination, options);

  const epinglage = await fusionnerEpinglages(destination, empreinte, epinglagesAttendus(arbre));
  const inventaire = await construireInventaire({
    arbre: arbre.nom,
    role: arbre.role,
    racine: destination,
    origine: origineDeLArbre(arbre.nom, options),
    commit: options.commit,
    complet: absentes.length === 0,
    banc: options.banc,
    absentes,
    enTetes: enTetesDePublication(arbre.nom, options),
    exclusions: arbre.nom === "coquille" ? EXCLUSIONS : [],
  });
  // Le champ portait le nom `epinglageV86` quand un seul artefact était vendu. Deux le sont depuis
  // #22, et un nom qui n'en désigne qu'un enverrait chercher le défaut au mauvais endroit.
  inventaire.epinglage = epinglage;
  await ecrireInventaire(destination, inventaire);
  return { destination, inventaire, absentes, epinglage };
}

/**
 * Les épinglages qu'un arbre DOIT porter, déduits de ses sources — un par artefact vendu.
 *
 * Un épinglage ne se vérifie que là où son artefact est publié. L'origine applicative n'en porte
 * aucun (ADR 0002) : lui répondre « manifeste absent » ferait passer une propriété pour un défaut.
 * La déduction est faite artefact par artefact, et c'est le sujet : elle était faite sur la seule
 * présence de `vendor/v86`, si bien que l'épinglage d'Argon2id ne serait pas vérifié du tout sur un
 * arbre qui le porterait sans porter v86.
 */
export function epinglagesAttendus(arbre) {
  return {
    v86: arbre.sources.some(({ depuis }) => depuis.startsWith("vendor/v86")),
    argon2: arbre.sources.some(({ depuis }) => depuis.startsWith("vendor/argon2")),
  };
}

/**
 * Les épinglages ATTENDUS d'un arbre publié, fondus en un seul verdict.
 *
 * v86 (ADR 0003) et Argon2id (ADR 0021) sont vendus pour des raisons différentes et vérifiés de la
 * même façon. Les fondre ici plutôt que d'ajouter un champ par artefact à l'inventaire garde une
 * seule règle de sortie — mais la fusion doit être une CONJONCTION, et elle ne l'était pas :
 * `v86.verifie || argon2.verifie` laissait un manifeste Argon2 absent passer pour « épinglage
 * conforme » dès que celui de v86 était vérifié, et `v86.motif ?? argon2.motif` perdait le second
 * motif en route. Chaque épinglage attendu doit être vérifié, et chaque motif est remonté.
 *
 * `rupture` sépare les deux natures d'échec. Un manifeste absent ou une empreinte qui ne correspond
 * pas est une RUPTURE, et l'arbre est refusé. Des artefacts absents sont une INCOMPLÉTUDE — ceux de
 * v86 ne sont pas versionnés —, et c'est le verdict de l'inventaire qui la porte, avec sa
 * tolérance. Voir `SITUATIONS_EPINGLAGE`.
 */
export async function fusionnerEpinglages(racine, empreinte, attendus) {
  const verdicts = [];
  if (attendus.v86) verdicts.push(["v86", await verifierEpinglageV86(racine, empreinte)]);
  if (attendus.argon2) verdicts.push(["argon2", await verifierEpinglageArgon2(racine, empreinte)]);
  const manquants = verdicts.filter(([, verdict]) => !verdict.verifie);
  const ecarts = verdicts.flatMap(([nom, verdict]) =>
    verdict.ecarts.map((ecart) => ({ ...ecart, epinglage: nom })),
  );
  return {
    attendus: verdicts.length,
    verifie: verdicts.length > 0 && manquants.length === 0,
    motif:
      manquants.length === 0
        ? null
        : manquants.map(([nom, verdict]) => `${nom} : ${verdict.motif}`).join(" ; "),
    ecarts,
    rupture:
      ecarts.length > 0 ||
      manquants.some(([, verdict]) => verdict.situation !== SITUATIONS_EPINGLAGE.artefactsAbsents),
  };
}

function decrireArbre({ destination, inventaire, absentes, epinglage }) {
  const lignes = [
    `Arbre « ${inventaire.arbre} » → ${destination}`,
    `  origine        ${inventaire.origine}`,
    `  fichiers       ${inventaire.fichiers.length}`,
    `  racine         ${inventaire.empreinteDeRacine}`,
    `  complet        ${inventaire.complet ? "oui" : "NON"}`,
  ];
  if (inventaire.banc)
    lignes.push("  banc           oui (origine non https : arbre non publiable)");
  // `verifie` dit que chaque épinglage attendu a PU être vérifié ; `rupture` dit qu'un écart a été
  // trouvé. Les confondre faisait imprimer « conforme » juste au-dessus de la liste des écarts —
  // et c'est cette ligne-là que lit un opérateur qui parcourt un journal (constat 7 de la revue).
  if (epinglage.verifie && !epinglage.rupture) {
    lignes.push("  épinglage      conforme aux MANIFEST vendus");
  } else if (epinglage.attendus > 0) {
    lignes.push(
      `  épinglage      ${epinglage.rupture ? "ROMPU" : "non vérifié"} (${epinglage.motif ?? "écarts"})`,
    );
  }
  for (const ecart of epinglage.ecarts) {
    lignes.push(`    ${ecart.epinglage}/${ecart.artefact} : ${ecart.motif}`);
  }
  for (const absente of absentes) {
    lignes.push(`  absente        ${absente} (npm run vm:fetch la récupère)`);
  }
  return lignes.join("\n");
}

function decrireCommit(commit, reference) {
  const lignes = [`Commit publié : ${commit.empreinte ?? "inconnu"} (${commit.reference})`];
  if (reference === null && !commit.arbreDeTravailPropre) {
    lignes.push(
      "AVERTISSEMENT : construction depuis l'ARBRE DE TRAVAIL, qui n'est pas propre. L'inventaire " +
        "décrit le disque, pas le commit nommé. Utilisez --commit <ref> pour publier des octets " +
        "versionnés.",
    );
  }
  return lignes.join("\n");
}

/** Verdict d'incomplétude, commun à la construction et à la vérification. */
function verdictIncomplet(tolere) {
  if (tolere) {
    process.stdout.write(
      "\nArbre INCOMPLET (--tolerer-incomplet) : un artefact de runtime manque, l'inventaire le " +
        "déclare. Ce n'est pas un artefact publiable.\n",
    );
    return CODES.conforme;
  }
  process.stderr.write(
    "\nPublication INCOMPLÈTE : un artefact de runtime manque. `npm run vm:fetch` le récupère ; " +
      "`--tolerer-incomplet` ramène ce refus à un avertissement pour un banc.\n",
  );
  return CODES.incomplet;
}

/**
 * Décrit une rupture d'épinglage en NOMMANT l'arbre, l'artefact vendu et le motif.
 *
 * « un artefact v86 servi ne correspond pas à son manifeste » était le seul message rendu, alors
 * que deux artefacts sont vendus depuis #22 : il envoyait chercher le défaut au mauvais endroit.
 */
function decrireRuptures(resultats) {
  const lignes = [];
  for (const { inventaire, epinglage } of resultats) {
    if (epinglage.motif !== null) lignes.push(`  ${inventaire.arbre} : ${epinglage.motif}`);
    for (const ecart of epinglage.ecarts) {
      lignes.push(`  ${inventaire.arbre} — ${ecart.epinglage}/${ecart.artefact} : ${ecart.motif}`);
      // Le mot « empreinte » seul ne distingue pas une substitution d'un téléchargement
      // interrompu ; les deux valeurs le font en une ligne, et l'écart les PORTE déjà — c'était
      // `decrireEcarts` qui savait les rendre, pas celui-ci (constat 8 de la revue de sécurité).
      if (ecart.attendu !== undefined) lignes.push(`      attendu ${ecart.attendu}`);
      if (ecart.mesure !== undefined) lignes.push(`      mesuré  ${ecart.mesure}`);
    }
    lignes.push(...remedeProbable(epinglage));
  }
  return lignes.join("\n");
}

/**
 * Le geste qui débloque, quand la forme des écarts le désigne sans ambiguïté (constat 3).
 *
 * TOUS les artefacts déclarés absents ET des non-déclarés présents : c'est la signature d'un disque
 * resté sur un AUTRE épinglage — le cas ordinaire d'un `--commit <ancien>` lancé depuis un poste à
 * jour, puisque `vendor/v86/artefacts/` vient toujours de l'arbre de travail alors que le manifeste
 * est lu au commit demandé. Le refus est CORRECT, et c'est même la propriété que l'amendement de
 * l'ADR 0017 revendique ; ce qui manquait est le remède, qu'un exploitant en incident ne doit pas
 * avoir à déduire d'une liste d'écarts.
 */
function remedeProbable(epinglage) {
  const absents = epinglage.ecarts.filter(({ motif }) => motif.startsWith("absent"));
  const intrus = epinglage.ecarts.filter(({ motif }) => motif.startsWith("non déclaré"));
  if (absents.length === 0 || intrus.length === 0) return [];
  return [
    "",
    "  Cause probable : le disque est resté sur un AUTRE épinglage. `vendor/v86/artefacts/` n'est",
    "  pas versionné et vient toujours de l'arbre de travail, y compris sous --commit ; le",
    "  manifeste, lui, est lu au commit demandé. Remède, dans cet ordre :",
    "",
    "    git checkout <ref> -- vendor/v86/MANIFEST.json",
    "    npm run vm:fetch          # récupère les adresses de <ref>, élague celles d'aujourd'hui",
    "    node tools/publier.mjs --commit <ref> --sortie <dir>",
    "",
    "  La procédure complète est dans docs/release-policy.md, § « Retour arrière ».",
  ];
}

async function construire(options) {
  const resultats = [];
  for (const arbre of ARBRES) resultats.push(await construireArbre(arbre, options));
  process.stdout.write(`${decrireCommit(options.commit, options.reference)}\n`);
  for (const resultat of resultats) process.stdout.write(`${decrireArbre(resultat)}\n`);

  const rompus = resultats.filter(({ epinglage }) => epinglage.rupture);
  if (rompus.length > 0) {
    process.stderr.write(`\nÉPINGLAGE ROMPU :\n${decrireRuptures(rompus)}\n`);
    return CODES.epinglageRompu;
  }
  if (resultats.some(({ inventaire }) => !inventaire.complet)) {
    return verdictIncomplet(options.tolererIncomplet);
  }
  process.stdout.write("\nPublication complète.\n");
  return CODES.conforme;
}

function decrireEcarts(ecarts) {
  const lignes = [];
  for (const { chemin, attendu, mesure } of ecarts.alteres) {
    lignes.push(`  ALTÉRÉ    ${chemin}`);
    lignes.push(`            attendu ${attendu.sha256} (${attendu.octets} o)`);
    lignes.push(`            mesuré  ${mesure.sha256} (${mesure.octets} o)`);
  }
  for (const chemin of ecarts.ajoutes) lignes.push(`  AJOUTÉ    ${chemin}`);
  for (const chemin of ecarts.manquants) lignes.push(`  MANQUANT  ${chemin}`);
  if (ecarts.racineMesuree !== ecarts.racineAttendue) {
    lignes.push(`  RACINE    attendue ${ecarts.racineAttendue}`);
    lignes.push(`            mesurée  ${ecarts.racineMesuree}`);
  }
  return lignes.join("\n");
}

async function verifier(racine, { tolererIncomplet }) {
  let resultat;
  try {
    resultat = await verifierArbre(racine);
  } catch (erreur) {
    process.stderr.write(`Inventaire illisible dans ${racine} : ${erreur.message}\n`);
    return CODES.inventaireIllisible;
  }
  const { inventaire, ecarts } = resultat;
  process.stdout.write(
    `Arbre « ${inventaire.arbre} » — ${inventaire.fichiers.length} fichiers, origine ` +
      `${inventaire.origine}, commit ${inventaire.commit.empreinte ?? "inconnu"}` +
      `${inventaire.banc ? " [BANC]" : ""}\n`,
  );
  const provenance = provenanceDeLInventaire(inventaire);
  // L'avertissement part sur la sortie d'ERREUR : c'est un diagnostic, pas un résultat, et il doit
  // survivre à un `> journal.txt` qui ne garde que le verdict.
  (provenance.avertissement ? process.stderr : process.stdout).write(`${provenance.ligne}\n`);
  if (!ecarts.conforme) {
    process.stderr.write(`ÉCARTS :\n${decrireEcarts(ecarts)}\n`);
    return CODES.ecart;
  }

  // L'arbre vérifié dit son nom ; la décision de publication dit quels épinglages ce nom doit
  // porter. Un nom que cette version ne connaît pas n'en attend aucun : elle ne sait pas de quoi
  // cet arbre est fait, et l'inventer serait pire que se taire.
  const decide = ARBRES.find(({ nom }) => nom === inventaire.arbre);
  const epinglage = await fusionnerEpinglages(
    racine,
    empreinte,
    decide === undefined ? { v86: false, argon2: false } : epinglagesAttendus(decide),
  );
  if (epinglage.rupture) {
    process.stderr.write(`ÉPINGLAGE ROMPU :\n${decrireRuptures([{ inventaire, epinglage }])}\n`);
    return CODES.epinglageRompu;
  }
  process.stdout.write(`Empreintes conformes. Racine ${ecarts.racineMesuree}\n`);
  // `complet: false` n'est PAS un écart d'empreintes : l'arbre est exactement ce que son inventaire
  // décrit. C'est en revanche un arbre qu'on ne doit pas déployer, et rendre 0 ici laisserait une
  // chaîne de publication conclure « conforme » sur un runtime absent.
  if (inventaire.complet === false) return verdictIncomplet(tolererIncomplet);
  return CODES.conforme;
}

const AIDE = `node tools/publier.mjs [--commit <ref>] [--sortie <dir>] [--tolerer-incomplet]
                      [--origine-coquille <url>] [--origine-application <url>]
node tools/publier.mjs --verifier <arbre> [--tolerer-incomplet]
`;

async function principal(argv) {
  if (argv.includes("--aide") || argv.includes("-h")) {
    process.stdout.write(AIDE);
    return CODES.conforme;
  }

  const tolererIncomplet = argv.includes("--tolerer-incomplet");
  const aVerifier = lireOption(argv, "verifier");
  if (aVerifier !== null) return verifier(resolve(aVerifier), { tolererIncomplet });

  // Les deux entrées destructrices sont validées AVANT que quoi que ce soit ne soit effacé : une
  // référence illisible ne doit pas emporter la publication précédente au passage (#106).
  const sortie = resolve(lireOption(argv, "sortie", join(REPOSITORY_ROOT, SORTIE_PAR_DEFAUT)));
  await exigerSortieUtilisable(sortie);
  const reference = lireOption(argv, "commit");
  if (reference !== null) exigerReferenceResoluble(REPOSITORY_ROOT, reference);

  const origineCoquille = lireOption(argv, "origine-coquille", ORIGINE_COQUILLE_PAR_DEFAUT);
  const origineApplication = lireOption(
    argv,
    "origine-application",
    ORIGINE_APPLICATION_PAR_DEFAUT,
  );
  return construire({
    sortie,
    reference,
    commit: identiteDuCommit(REPOSITORY_ROOT, reference ?? "HEAD"),
    origineCoquille,
    origineApplication,
    banc: estUnBanc({ origineCoquille, origineApplication }),
    tolererIncomplet,
  });
}

// Exécutable ET importable : la suite unitaire importe les constantes sans déclencher de
// construction. La comparaison porte sur le nom de fichier plutôt que sur l'URL, `file://` n'ayant
// pas la même forme selon la plateforme.
if (basename(process.argv[1] ?? "") === "publier.mjs") {
  try {
    process.exitCode = await principal(process.argv.slice(2));
  } catch (erreur) {
    process.stderr.write(`${erreur.message}\n`);
    process.exitCode = erreur.sourceAbsente ? CODES.sourceAbsente : CODES.usage;
  }
}
