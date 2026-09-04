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
 * La confrontation va dans les DEUX SENS, et le second est le correctif de la revue de #103. Le
 * premier — chaque artefact déclaré est là, et à la bonne empreinte — ne dit rien de ce qui est là
 * SANS être déclaré. Or `vendor/v86/artefacts/` est ignoré par git et peuplé par
 * `npm run vm:fetch` ; `tools/publier-arborescences.mjs` le copie en bloc ; et depuis l'ADR 0023 la
 * classe de cache `epinglage-v86` est accordée par EMPLACEMENT — tout ce qui relève de
 * `/vendor/v86/` reçoit `public, max-age=86400`. Un fichier oublié là par un poste de
 * développement partait donc chez l'hébergeur avec vingt-quatre heures de cache PARTAGÉ et sans
 * révocation possible, là où il recevait `no-store` avant #103.
 *
 * L'ADR 0003 dit ce qui a le droit d'être dans ce répertoire : les artefacts du manifeste, et rien
 * d'autre. Ce qui n'y est pas déclaré est donc un ÉCART — code 5, publication refusée — et non un
 * fichier discrètement écarté de la copie : un retrait silencieux ferait disparaître la trace de
 * ce qui traînait sur le disque du poste qui publie, quand c'est précisément ce qu'un exploitant
 * doit voir.
 *
 * @param {string} destination racine de l'arbre publié
 * @param {(contenu: Uint8Array) => string} empreinte
 */
export function verifierEpinglageV86(destination, empreinte) {
  return verifierEpinglage(destination, empreinte, {
    manifeste: ["vendor", "v86", "MANIFEST.json"],
    artefacts: ["vendor", "v86", "artefacts"],
  });
}

/**
 * Même vérification, sur l'artefact **Argon2id** vendu par #22 (ADR 0021).
 *
 * Elle est nécessaire pour la raison qui rend celle de v86 nécessaire, avec un cran de plus : cet
 * artefact étire un SECRET UTILISATEUR. Un binaire substitué en chemin — dans l'arbre publié, chez
 * l'hébergeur, dans un cache — pourrait rendre une étiquette prévisible sans que rien ne le dise, et
 * la phrase de chacun ouvrirait alors un coffre que l'adversaire ouvre aussi.
 *
 * Deux vérifications indépendantes couvrent le même octet à deux moments, et aucune ne remplace
 * l'autre : celle-ci, sur l'arbre publié, avant qu'il ne parte ; et celle de
 * `src/vm/derivation/argon2-vendu.mjs`, dans le navigateur, avant d'instancier le module.
 *
 * **CE QUE LA SECONDE NE COUVRE PAS, et il faut le nommer.** L'empreinte attendue par le navigateur
 * est un littéral d'un module servi par la MÊME origine, depuis le MÊME arbre. Un hébergeur
 * compromis — ou quiconque peut réécrire l'arbre servi — remplace le binaire ET le littéral du même
 * geste, et la vérification passe. Elle n'est donc pas une défense contre l'hébergeur : celle-là
 * est ici, sur l'arbre construit à partir d'un commit, avant qu'il ne parte.
 *
 * Ce que la vérification du navigateur couvre est un chemin ISOLÉ : un cache qui garde une version
 * d'un binaire à côté d'un module d'une autre, un proxy ou un intermédiaire qui touche le `.wasm`
 * sans toucher au `.mjs`, un déploiement partiel qui n'a poussé qu'une moitié de l'arbre. Ce sont
 * les incidents qu'on rencontre, et elle les transforme en refus visible plutôt qu'en étiquette
 * silencieusement fausse.
 */
export function verifierEpinglageArgon2(destination, empreinte) {
  return verifierEpinglage(destination, empreinte, {
    manifeste: ["vendor", "argon2", "MANIFEST.json"],
    artefacts: ["vendor", "argon2"],
  });
}

/**
 * Les trois issues d'une vérification d'épinglage, et elles ne se diagnostiquent PAS pareil.
 *
 * Un manifeste absent est un DÉFAUT : les deux manifestes vendus sont versionnés, et leur absence
 * de l'arbre publié veut dire que la décision de publication et l'arbre ne parlent plus du même
 * dépôt. Des artefacts absents sont une INCOMPLÉTUDE : ceux de v86 ne sont pas versionnés
 * (`npm run vm:fetch` les récupère), et l'inventaire porte déjà ce verdict-là. Les confondre
 * ferait passer l'un des deux pour l'autre — un défaut toléré par `--tolerer-incomplet`, ou un
 * clone vierge refusé comme une substitution.
 */
export const SITUATIONS_EPINGLAGE = Object.freeze({
  verifie: "verifie",
  manifesteAbsent: "manifeste-absent",
  artefactsAbsents: "artefacts-absents",
});

/** Le geste commun : relire un manifeste vendu et confronter ses artefacts à leurs empreintes. */
async function verifierEpinglage(destination, empreinte, { manifeste: chemin, artefacts }) {
  const manifeste = join(destination, ...chemin);
  if (!(await existe(manifeste))) {
    return {
      verifie: false,
      situation: SITUATIONS_EPINGLAGE.manifesteAbsent,
      motif: "manifeste absent",
      ecarts: [],
    };
  }
  const dossier = join(destination, ...artefacts);
  if (!(await existe(dossier))) {
    return {
      verifie: false,
      situation: SITUATIONS_EPINGLAGE.artefactsAbsents,
      motif: "artefacts absents de l'arbre publié",
      ecarts: [],
    };
  }

  const declares = JSON.parse(await readFile(manifeste, "utf8")).artifacts;
  const presents = await readdir(dossier);
  const ecarts = [
    ...(await ecartsDesDeclares(declares, dossier, new Set(presents), empreinte)),
    ...ecartsDesNonDeclares(declares, presents),
  ];
  return { verifie: true, situation: SITUATIONS_EPINGLAGE.verifie, motif: null, ecarts };
}

/** Chaque artefact DÉCLARÉ est-il publié, et à l'empreinte que l'ADR 0003 lui épingle ? */
async function ecartsDesDeclares(declares, dossier, presents, empreinte) {
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
  return ecarts;
}

/** Chaque fichier PUBLIÉ sous `artefacts/` est-il déclaré ? Sinon, il est servi sans épinglage. */
function ecartsDesNonDeclares(declares, presents) {
  const noms = new Set(declares.map(({ name }) => name));
  return presents
    .filter((present) => !noms.has(present))
    .map((present) => ({
      artefact: present,
      motif:
        "non déclaré dans vendor/v86/MANIFEST.json — servi sous la règle /vendor/v86/*, donc avec " +
        "un cache partagé de 24 h, sans empreinte épinglée (ADR 0003, ADR 0023)",
    }));
}
