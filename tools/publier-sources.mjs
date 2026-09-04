// D'où viennent les octets publiés : de l'arbre de travail, ou d'un COMMIT.
//
// La distinction n'est pas cosmétique, et c'est la procédure de RETOUR ARRIÈRE qui l'exige. Un
// outil qui recopierait toujours l'arbre de travail en se contentant d'inscrire un identifiant de
// commit dans l'inventaire produirait, pour `--commit <version-précédente>`, un arbre portant les
// octets d'AUJOURD'HUI sous l'étiquette d'HIER. Le rollback consisterait alors à republier la
// version défaillante en lui donnant le nom de la précédente.
//
// `--commit` lit donc réellement l'objet git. La seule exception est nommée et bornée : les
// artefacts v86 ne sont pas versionnés (`vendor/v86/artefacts/`, ignoré par git). Ils viennent
// toujours de l'arbre de travail — mais ils sont épinglés par empreinte dans
// `vendor/v86/MANIFEST.json`, lui-même lu au commit demandé, et `npm run vm:check` refuse une
// empreinte qui ne correspond pas. Leur provenance est donc vérifiable autrement.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Sources non versionnées, toujours lues dans l'arbre de travail même sous `--commit`. */
export const HORS_GIT = Object.freeze(["vendor/v86/artefacts"]);

function git(racine, ...args) {
  return execFileSync("git", args, { cwd: racine, encoding: "utf8" }).trim();
}

/** Identité du commit publié. Sans dépôt git, l'identité est déclarée absente, jamais devinée. */
export function identiteDuCommit(racine, reference) {
  try {
    return {
      reference,
      empreinte: git(racine, "rev-parse", reference),
      date: git(racine, "show", "-s", "--format=%cI", reference),
      arbreGit: git(racine, "rev-parse", `${reference}^{tree}`),
      arbreDeTravailPropre: git(racine, "status", "--porcelain").length === 0,
    };
  } catch {
    return {
      reference,
      empreinte: null,
      date: null,
      arbreGit: null,
      arbreDeTravailPropre: false,
    };
  }
}

/**
 * Refuse une référence git que le dépôt ne résout pas, en la NOMMANT.
 *
 * Sans ce refus, la première commande à buter dessus est `git ls-tree`, et son échec remonte sous
 * la forme d'un `Command failed: git ls-tree -r --name-only -z <ref> -- <chemin>` suivi du texte de
 * git. Le lecteur y voit un défaut de l'outil là où il n'a qu'une faute de frappe.
 *
 * C'est un USAGE invalide — code 3 —, pas une source absente — code 4. La distinction n'est pas
 * bureaucratique : rien ne manque, c'est la DEMANDE qui est illisible, et le geste attendu est de
 * corriger la ligne de commande, pas de chercher un fichier sur un disque.
 *
 * @throws {Error & { referenceInvalide: true }}
 */
export function exigerReferenceResoluble(racine, reference) {
  try {
    git(racine, "rev-parse", "--verify", "--quiet", `${reference}^{commit}`);
  } catch {
    const erreur = new Error(
      `Référence git inconnue : « ${reference} ». Le dépôt ne la résout pas — vérifiez le nom de ` +
        `commit, de branche ou d'étiquette demandé à --commit.`,
    );
    erreur.referenceInvalide = true;
    throw erreur;
  }
}

/**
 * Deux absences, deux gestes opposés, et l'outil doit dire laquelle il constate.
 *
 * Une source absente de l'ARBRE DE TRAVAIL est un fichier à replacer sur le disque. Une source
 * absente AU COMMIT est autre chose : la référence est valide, son arbre est lisible, et ce qui
 * manque n'a jamais existé à cet endroit de l'histoire. Aucun fichier ne la ramènera ; c'est la
 * publication de cette version-là qui n'est pas constructible par la liste de sources
 * d'aujourd'hui. Le code de sortie reste 4 dans les deux cas — la publication n'est pas
 * constructible —, seule la cause change, et c'est elle qui décide de la suite.
 */
function sourceObligatoireAbsente(source, reference) {
  const erreur = new Error(
    reference === null
      ? `Source obligatoire absente de l'ARBRE DE TRAVAIL : ${source.depuis}. Le chemin n'existe ` +
          `pas sur le disque.`
      : `Source obligatoire absente au commit ${reference} : ${source.depuis}. La référence est ` +
          `valide et son arbre est lisible : cette source n'existait pas encore à ce commit, ou ` +
          `elle y portait un autre chemin. Rien ne manque sur le disque — c'est cette version-là ` +
          `qui n'est pas constructible par les sources décidées aujourd'hui ` +
          `(tools/publier-arborescences.mjs).`,
  );
  erreur.sourceAbsente = true;
  erreur.motif = reference === null ? "absenteDeLArbreDeTravail" : "absenteAuCommit";
  return erreur;
}

async function existe(chemin) {
  try {
    await stat(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Recopie une source depuis l'arbre de travail. */
async function depuisArbreDeTravail(racine, source, destination) {
  const origine = join(racine, source.depuis);
  if (!(await existe(origine))) return false;
  const cible = join(destination, source.vers);
  await mkdir(join(cible, ".."), { recursive: true });
  await cp(origine, cible, { recursive: true });
  return true;
}

/** Fichiers d'un chemin (fichier ou répertoire) tels qu'ils existent au commit demandé. */
function fichiersAuCommit(racine, reference, chemin) {
  const sortie = git(racine, "ls-tree", "-r", "--name-only", "-z", reference, "--", chemin);
  return sortie.split("\0").filter(Boolean);
}

/** Recopie une source depuis un commit. Les octets viennent de `git show`, pas du disque. */
async function depuisCommit(racine, reference, source, destination) {
  const fichiers = fichiersAuCommit(racine, reference, source.depuis);
  if (fichiers.length === 0) return false;
  for (const fichier of fichiers) {
    const relatif = fichier === source.depuis ? "" : relative(source.depuis, fichier);
    const cible = join(destination, source.vers, relatif).replaceAll("\\", "/");
    await mkdir(join(cible, ".."), { recursive: true });
    await writeFile(
      cible,
      execFileSync("git", ["show", `${reference}:${fichier}`], {
        cwd: racine,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
  }
  return true;
}

/**
 * Matérialise les sources d'un arbre et rend la liste des sources OPTIONNELLES absentes.
 *
 * La référence est résolue AVANT toute copie : une référence illisible est un refus, jamais un
 * arbre tronqué (#106).
 *
 * @param {{ racine: string, reference: string | null, sources: readonly object[],
 *           destination: string }} demande
 * @throws {Error & { referenceInvalide: true }} si la référence n'est pas résoluble
 * @throws {Error & { sourceAbsente: true, motif: string }} si une source obligatoire manque
 */
export async function materialiser({ racine, reference, sources, destination }) {
  if (reference !== null) exigerReferenceResoluble(racine, reference);
  const absentes = [];
  for (const source of sources) {
    const versionne = reference !== null && !HORS_GIT.includes(source.depuis);
    const trouvee = versionne
      ? await depuisCommit(racine, reference, source, destination)
      : await depuisArbreDeTravail(racine, source, destination);
    if (trouvee) continue;
    if (!source.optionnel) throw sourceObligatoireAbsente(source, versionne ? reference : null);
    absentes.push(source.depuis);
  }
  return absentes;
}

/**
 * Relit `vendor/v86/MANIFEST.json` dans l'arbre publié et confronte les artefacts copiés à leurs
 * empreintes épinglées.
 *
 * C'est la moitié « runtime identifié et vérifié » de `SEC-UPDATE-001` appliquée à la PUBLICATION :
 * l'invariant l'exige avant d'ouvrir un volume en écriture, et il n'a de sens que si les octets du
 * runtime servis au navigateur sont bien ceux que l'ADR 0003 a épinglés. La vérification est faite
 * ici, sur l'arbre publié, et non dans le dépôt — c'est l'arbre qui part chez l'hébergeur.
 *
 * @param {string} destination racine de l'arbre publié
 * @param {(contenu: Uint8Array) => string} empreinte
 */
export async function verifierEpinglageV86(destination, empreinte) {
  const manifeste = join(destination, "vendor", "v86", "MANIFEST.json");
  if (!(await existe(manifeste))) return { verifie: false, motif: "manifeste absent", ecarts: [] };
  const dossier = join(destination, "vendor", "v86", "artefacts");
  if (!(await existe(dossier))) {
    return { verifie: false, motif: "artefacts absents de l'arbre publié", ecarts: [] };
  }

  const declares = JSON.parse(await readFile(manifeste, "utf8")).artifacts;
  const presents = new Set(await readdir(dossier));
  const ecarts = [];
  for (const artefact of declares) {
    if (!presents.has(artefact.name)) {
      ecarts.push({ artefact: artefact.name, motif: "absent de l'arbre publié" });
      continue;
    }
    const mesure = empreinte(await readFile(join(dossier, artefact.name)));
    if (mesure !== artefact.sha256) {
      ecarts.push({
        artefact: artefact.name,
        motif: "empreinte",
        attendu: artefact.sha256,
        mesure,
      });
    }
  }
  return { verifie: true, motif: null, ecarts };
}
