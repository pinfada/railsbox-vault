// Mesure de l'ESPACE DISQUE de l'exécutant, à des points nommés d'une recette CI.
//
// Elle existe pour une raison précise (#73) : le job « Reprise MVP » écrit dans OPFS un volume de
// 512 Mio puis une archive de la même taille, sur un exécutant GitHub qui a déjà construit une image
// Docker i386 complète. Quand une écriture OPFS échoue en CI et jamais en local, la première
// question est « restait-il de la place ? » — et sans mesure, elle reste une opinion.
//
// Ce que l'outil mesure et ce qu'il NE mesure pas :
//
//  - il mesure l'espace du SYSTÈME DE FICHIERS qui porte un chemin donné (par défaut le dépôt), et
//    la taille des répertoires d'artefacts qu'on lui nomme ;
//  - il ne mesure PAS le quota OPFS, qui appartient au navigateur et se lit depuis le Worker par
//    `navigator.storage.estimate()` — le banc E2E le publie de son côté.
//
// Chaque appel AJOUTE une ligne JSON au journal (JSONL) : un fichier lisible par un humain et par
// un outil, dont l'ordre des lignes est celui de la recette. Aucun appel n'écrase les précédents.
//
// L'outil ne fait jamais échouer la recette : une mesure indisponible s'inscrit comme telle. Il
// mesure, il ne juge pas — un seuil franchi doit se voir dans le journal, pas provoquer une panne
// qui masquerait la panne cherchée.
//
// Usage :
//   node tools/mesure-espace-disque.mjs --etape depart
//   node tools/mesure-espace-disque.mjs --etape apres-image-build --repertoire artifacts
//   node tools/mesure-espace-disque.mjs --etape fin --journal reports/e2e/espace-disque.jsonl

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Journal par défaut : dans `reports/`, qui est déjà archivé en artefact par la recette. */
export const JOURNAL_PAR_DEFAUT = join("reports", "e2e", "espace-disque.jsonl");

/** Répertoires dont la taille éclaire l'empreinte du job, quand ils existent. */
const REPERTOIRES_PAR_DEFAUT = Object.freeze([
  join("artifacts"),
  join("vendor", "v86", "artefacts"),
]);

/**
 * Espace du système de fichiers portant `chemin`. Rend un état NOMMÉ plutôt qu'une exception : une
 * mesure impossible est une information, pas une panne de la recette.
 * @param {string} chemin
 */
export function espaceDuSystemeDeFichiers(chemin) {
  try {
    const { bsize, blocks, bfree, bavail } = statfsSync(chemin);
    return {
      etat: "connu",
      chemin,
      totalOctets: bsize * blocks,
      libreOctets: bsize * bfree,
      // `bavail` est ce qui reste à un utilisateur NON privilégié : c'est le chiffre que verra le
      // navigateur, pas `bfree` qui inclut la réserve du superutilisateur.
      disponibleOctets: bsize * bavail,
    };
  } catch (cause) {
    return { etat: "indisponible", chemin, raison: cause.message };
  }
}

/** Taille cumulée d'un répertoire, ou l'état « absent ». Ne suit aucun lien symbolique. */
export function tailleDuRepertoire(chemin) {
  let total = 0;
  let fichiers = 0;
  const pile = [chemin];
  try {
    statSync(chemin);
  } catch {
    return { etat: "absent", chemin };
  }
  while (pile.length > 0) {
    const courant = pile.pop();
    let entrees;
    try {
      entrees = readdirSync(courant, { withFileTypes: true });
    } catch (cause) {
      return { etat: "partiel", chemin, octets: total, fichiers, raison: cause.message };
    }
    for (const entree of entrees) {
      const complet = join(courant, entree.name);
      if (entree.isDirectory()) {
        pile.push(complet);
      } else if (entree.isFile()) {
        try {
          total += statSync(complet).size;
          fichiers += 1;
        } catch {
          // Un fichier disparu entre le listage et la mesure ne rend pas la mesure fausse : il
          // n'occupe plus rien. On l'ignore sans prétendre l'avoir compté.
        }
      }
    }
  }
  return { etat: "connu", chemin, octets: total, fichiers };
}

/**
 * Occupation de Docker, quand Docker est présent. C'est la part la plus lourde et la plus opaque de
 * la recette : l'image de référence est construite sous i386, en plusieurs étages.
 */
export function occupationDocker() {
  try {
    const brut = execFileSync("docker", ["system", "df", "--format", "{{json .}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    const lignes = brut
      .split("\n")
      .map((ligne) => ligne.trim())
      .filter((ligne) => ligne !== "")
      .map((ligne) => {
        try {
          return JSON.parse(ligne);
        } catch {
          return { brut: ligne };
        }
      });
    return { etat: "connu", lignes };
  } catch (cause) {
    return { etat: "indisponible", raison: cause.message };
  }
}

/**
 * Construit la mesure d'une étape. Séparée de l'écriture pour être vérifiable sous test sans
 * toucher au disque de sortie.
 * @param {{ etape: string, racine?: string, repertoires?: string[], docker?: boolean }} options
 */
export function mesurer({
  etape,
  racine = RACINE,
  repertoires = REPERTOIRES_PAR_DEFAUT,
  docker = true,
}) {
  if (typeof etape !== "string" || etape.trim() === "") {
    throw new TypeError("Une mesure d'espace disque doit nommer son étape.");
  }
  return {
    etape,
    mesureLe: new Date().toISOString(),
    plateforme: `${process.platform} ${process.arch}`,
    systemeDeFichiers: espaceDuSystemeDeFichiers(racine),
    repertoires: repertoires.map((relatif) => tailleDuRepertoire(resolve(racine, relatif))),
    docker: docker ? occupationDocker() : { etat: "non-demande" },
  };
}

/** Ajoute une mesure au journal JSONL, en créant son répertoire au besoin. */
export function inscrire(mesure, journal) {
  const chemin = resolve(RACINE, journal);
  mkdirSync(dirname(chemin), { recursive: true });
  appendFileSync(chemin, `${JSON.stringify(mesure)}\n`, "utf8");
  return chemin;
}

/** Lecture d'arguments `--clef valeur`, avec `--repertoire` répétable. */
export function lireArguments(argv) {
  const options = { etape: null, journal: JOURNAL_PAR_DEFAUT, repertoires: [], docker: true };
  for (let i = 0; i < argv.length; i += 1) {
    const clef = argv[i];
    if (clef === "--sans-docker") {
      options.docker = false;
    } else if (clef === "--etape") {
      options.etape = argv[++i];
    } else if (clef === "--journal") {
      options.journal = argv[++i];
    } else if (clef === "--repertoire") {
      options.repertoires.push(argv[++i]);
    } else {
      throw new TypeError(`Argument inconnu : ${clef}`);
    }
  }
  if (options.repertoires.length === 0) options.repertoires = [...REPERTOIRES_PAR_DEFAUT];
  return options;
}

function principal(argv) {
  const options = lireArguments(argv);
  if (options.etape === null) {
    throw new TypeError(
      "Usage : node tools/mesure-espace-disque.mjs --etape <nom> [--repertoire r]",
    );
  }
  const mesure = mesurer(options);
  const chemin = inscrire(mesure, options.journal);
  const fs = mesure.systemeDeFichiers;
  const gio = (octets) => (octets / 1024 ** 3).toFixed(2);
  const resume =
    fs.etat === "connu"
      ? `${gio(fs.disponibleOctets)} Gio disponibles sur ${gio(fs.totalOctets)} Gio`
      : `espace indisponible (${fs.raison})`;
  process.stdout.write(`[espace-disque] ${mesure.etape} : ${resume} → ${chemin}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  principal(process.argv.slice(2));
}
