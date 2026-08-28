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
//   5  artefact v86 servi qui ne correspond pas à son épinglage (`vendor/v86/MANIFEST.json`)
//   6  arbre INCOMPLET : une source optionnelle manque (le runtime v86). L'arbre est cohérent et
//      son inventaire est exact, mais ce n'est pas un artefact publiable. `--tolerer-incomplet`
//      ramène ce cas à un avertissement, pour les contextes — bancs, `npm run check` — qui n'ont
//      pas besoin de l'émulateur et ne prétendent pas publier.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

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
import { identiteDuCommit, materialiser, verifierEpinglageV86 } from "./publier-sources.mjs";
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
  await writeFile(
    join(destination, FICHIER_HEADERS),
    rendreFichierHeaders(arbre.nom, options),
    "utf8",
  );
  await exigerPolitiqueUniforme(arbre, destination, options);

  // L'épinglage ne se vérifie que là où un runtime est publié. L'origine applicative n'en porte
  // aucun (ADR 0002) : lui répondre « manifeste absent » ferait passer une propriété pour un défaut.
  const porteLeRuntime = arbre.sources.some(({ depuis }) => depuis.startsWith("vendor/v86"));
  const epinglage = porteLeRuntime
    ? await verifierEpinglageV86(destination, empreinte)
    : { verifie: false, motif: null, ecarts: [] };
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
  inventaire.epinglageV86 = epinglage;
  await ecrireInventaire(destination, inventaire);
  return { destination, inventaire, absentes, epinglage };
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
  if (epinglage.verifie) {
    lignes.push(
      `  épinglage v86  ${epinglage.ecarts.length === 0 ? "conforme au MANIFEST" : "ROMPU"}`,
    );
    for (const ecart of epinglage.ecarts) lignes.push(`    ${ecart.artefact} : ${ecart.motif}`);
  } else if (epinglage.motif !== null) {
    lignes.push(`  épinglage v86  non vérifié (${epinglage.motif})`);
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

async function construire(options) {
  const resultats = [];
  for (const arbre of ARBRES) resultats.push(await construireArbre(arbre, options));
  process.stdout.write(`${decrireCommit(options.commit, options.reference)}\n`);
  for (const resultat of resultats) process.stdout.write(`${decrireArbre(resultat)}\n`);

  if (resultats.some(({ epinglage }) => epinglage.ecarts.length > 0)) {
    process.stderr.write(
      "\nÉPINGLAGE ROMPU : un artefact v86 servi ne correspond pas à `vendor/v86/MANIFEST.json`.\n",
    );
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
  if (!ecarts.conforme) {
    process.stderr.write(`ÉCARTS :\n${decrireEcarts(ecarts)}\n`);
    return CODES.ecart;
  }

  const epinglage = await verifierEpinglageV86(racine, empreinte);
  if (epinglage.ecarts.length > 0) {
    process.stderr.write(
      `ÉPINGLAGE ROMPU :\n${epinglage.ecarts.map((e) => `  ${e.artefact} : ${e.motif}`).join("\n")}\n`,
    );
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

  const reference = lireOption(argv, "commit");
  const origineCoquille = lireOption(argv, "origine-coquille", ORIGINE_COQUILLE_PAR_DEFAUT);
  const origineApplication = lireOption(
    argv,
    "origine-application",
    ORIGINE_APPLICATION_PAR_DEFAUT,
  );
  return construire({
    sortie: resolve(lireOption(argv, "sortie", join(REPOSITORY_ROOT, SORTIE_PAR_DEFAUT))),
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
