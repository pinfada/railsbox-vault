// Mesure des RESSOURCES de l'exécutant — espace disque et mémoire — à des points nommés d'une
// recette CI, ou en continu pendant une étape.
//
// Elle existe pour une raison précise (#73) : le job « Reprise MVP » écrit dans OPFS un volume de
// 512 Mio puis une archive de la même taille, sur un exécutant GitHub qui a déjà construit une image
// Docker i386 complète. Quand une écriture OPFS échoue en CI et jamais en local, la première
// question est « restait-il de la place ? » — et sans mesure, elle reste une opinion.
//
// La première mesure a réfuté la réponse évidente : le système de fichiers du dépôt gardait 83 Gio
// libres, et n'a PAS bougé pendant que les scénarios écrivaient près d'un gigaoctet dans OPFS. Les
// octets d'OPFS ne sont donc pas là. L'outil mesure désormais TOUS les points de montage
// plausibles — dont celui des fichiers temporaires, où vit le profil du navigateur — et la MÉMOIRE,
// puisqu'un profil de navigateur éphémère peut ne jamais toucher le disque.
//
// Ce que l'outil mesure et ce qu'il NE mesure pas :
//
//  - il mesure l'espace des systèmes de fichiers qui portent les chemins qu'on lui nomme, la taille
//    des répertoires d'artefacts, l'occupation de Docker et la mémoire de l'hôte ;
//  - il ne mesure PAS le quota OPFS, qui appartient au navigateur et se lit depuis le Worker par
//    `navigator.storage.estimate()` — le banc E2E le publie de son côté. Les deux sont
//    complémentaires : c'est leur DÉSACCORD qui est instructif.
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
//   node tools/mesure-espace-disque.mjs --etape pendant-e2e --suivre 5   (jusqu'à SIGTERM)

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  statfsSync,
} from "node:fs";
import { freemem, tmpdir, totalmem } from "node:os";
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
 * Points de montage à mesurer, en plus de la racine du dépôt.
 *
 * `tmpdir()` est le plus important : c'est là que Playwright dépose le profil du navigateur, donc
 * là que vivraient les octets d'OPFS s'ils vivaient sur un disque. Les autres sont les montages
 * usuels d'un exécutant Linux ; ceux qui n'existent pas s'inscrivent comme indisponibles.
 */
const MONTAGES_PAR_DEFAUT = Object.freeze([tmpdir(), "/", "/mnt", "/dev/shm", "/home/runner"]);

/**
 * Mémoire de l'hôte. Sous Linux, `/proc/meminfo` donne `MemAvailable`, qui est la seule valeur
 * honnête : `freemem()` ignore le cache réclamable et sous-estime massivement ce qui est
 * réellement disponible. Ailleurs, on se rabat sur ce que Node expose, en le disant.
 */
export function memoireDeLHote() {
  try {
    const brut = readFileSync("/proc/meminfo", "utf8");
    const lire = (clef) => {
      const trouve = new RegExp(`^${clef}:\\s+(\\d+) kB$`, "m").exec(brut);
      return trouve === null ? null : Number(trouve[1]) * 1024;
    };
    return {
      etat: "connu",
      source: "/proc/meminfo",
      totalOctets: lire("MemTotal"),
      disponibleOctets: lire("MemAvailable"),
      libreOctets: lire("MemFree"),
      cacheOctets: lire("Cached"),
      swapTotalOctets: lire("SwapTotal"),
      swapLibreOctets: lire("SwapFree"),
    };
  } catch {
    // `freemem()` n'est PAS `MemAvailable` : il exclut le cache réclamable. On ne le fait pas
    // passer pour la même chose.
    return {
      etat: "approche",
      source: "node:os",
      totalOctets: totalmem(),
      disponibleOctets: null,
      libreOctets: freemem(),
      cacheOctets: null,
      swapTotalOctets: null,
      swapLibreOctets: null,
    };
  }
}

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
  leger = false,
}) {
  if (typeof etape !== "string" || etape.trim() === "") {
    throw new TypeError("Une mesure d'espace disque doit nommer son étape.");
  }
  return {
    etape,
    mesureLe: new Date().toISOString(),
    plateforme: `${process.platform} ${process.arch}`,
    systemeDeFichiers: espaceDuSystemeDeFichiers(racine),
    // Tous les montages plausibles, dont celui des fichiers temporaires : c'est là que vit le profil
    // du navigateur, et donc là que se verraient les octets d'OPFS s'ils touchaient un disque.
    montages: MONTAGES_PAR_DEFAUT.map((chemin) => espaceDuSystemeDeFichiers(chemin)),
    memoire: memoireDeLHote(),
    // Un échantillonnage continu doit rester bon marché : parcourir des répertoires et interroger
    // Docker toutes les cinq secondes changerait la charge de la machine qu'on prétend observer.
    repertoires: leger
      ? []
      : repertoires.map((relatif) => tailleDuRepertoire(resolve(racine, relatif))),
    docker: leger ? { etat: "non-demande" } : docker ? occupationDocker() : { etat: "non-demande" },
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
  const options = {
    etape: null,
    journal: JOURNAL_PAR_DEFAUT,
    repertoires: [],
    docker: true,
    suivre: null,
  };
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
    } else if (clef === "--suivre") {
      const secondes = Number(argv[++i]);
      if (!Number.isFinite(secondes) || secondes <= 0) {
        throw new TypeError(`Intervalle de suivi invalide : ${secondes}`);
      }
      options.suivre = secondes;
    } else {
      throw new TypeError(`Argument inconnu : ${clef}`);
    }
  }
  if (options.repertoires.length === 0) options.repertoires = [...REPERTOIRES_PAR_DEFAUT];
  return options;
}

/** Résumé d'une ligne, pour le journal de la recette. */
function resumer(mesure) {
  const gio = (octets) => (octets === null ? "?" : (octets / 1024 ** 3).toFixed(2));
  const fs = mesure.systemeDeFichiers;
  const disque =
    fs.etat === "connu"
      ? `${gio(fs.disponibleOctets)} Gio disponibles sur ${gio(fs.totalOctets)} Gio`
      : `espace indisponible (${fs.raison})`;
  const memoire = `mémoire ${gio(mesure.memoire.disponibleOctets)} / ${gio(mesure.memoire.totalOctets)} Gio`;
  return `${disque} ; ${memoire}`;
}

/**
 * ÉCHANTILLONNAGE CONTINU, jusqu'à ce qu'on nous arrête. Il sert à voir une ressource s'épuiser
 * PENDANT une étape : une mesure avant et une après ne disent rien d'un pic au milieu.
 *
 * Il ne s'arrête pas tout seul et n'a pas de durée maximale : c'est l'étape qui l'encadre et le
 * termine. Sans cela, un suivi qui expirerait avant la fin des scénarios laisserait un trou
 * précisément là où l'on cherche.
 */
function suivre(options) {
  const journal = resolve(RACINE, options.journal);
  process.stdout.write(
    `[espace-disque] suivi de « ${options.etape} » toutes les ${options.suivre} s → ${journal}\n`,
  );
  const minuteur = setInterval(() => {
    inscrire(mesurer({ ...options, leger: true }), options.journal);
  }, options.suivre * 1000);

  // Sortie propre sur signal, avec une dernière ligne si l'on nous en laisse le temps. C'est un
  // BONUS, pas une garantie : le signal n'est pas toujours interceptable — vérifié le 26/08/2026,
  // `kill` depuis Git Bash sous Windows termine le processus sans que ce gestionnaire s'exécute.
  // La mesure d'après-scénarios sur laquelle on compte est l'étape `if: always()` de la recette, et
  // l'échantillon le plus proche d'un échec est de toute façon à moins d'un intervalle de celui-ci.
  const arreter = () => {
    clearInterval(minuteur);
    inscrire(mesurer({ ...options, etape: `${options.etape}-fin`, leger: true }), options.journal);
    process.exit(0);
  };
  process.on("SIGTERM", arreter);
  process.on("SIGINT", arreter);
}

function principal(argv) {
  const options = lireArguments(argv);
  if (options.etape === null) {
    throw new TypeError(
      "Usage : node tools/mesure-espace-disque.mjs --etape <nom> [--repertoire r] [--suivre s]",
    );
  }
  if (options.suivre !== null) {
    inscrire(
      mesurer({ ...options, etape: `${options.etape}-debut`, leger: true }),
      options.journal,
    );
    suivre(options);
    return;
  }
  const mesure = mesurer(options);
  const chemin = inscrire(mesure, options.journal);
  process.stdout.write(`[espace-disque] ${mesure.etape} : ${resumer(mesure)} → ${chemin}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  principal(process.argv.slice(2));
}
