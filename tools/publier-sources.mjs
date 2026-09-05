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

import { empreinteDeLAdresse, nomAdresse, nomAdresseDuManifeste } from "../src/v86-adresses.mjs";

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

/** Emplacement, dans un arbre publié, du manifeste d'épinglage v86 et des octets qu'il nomme. */
const MANIFESTE_V86 = ["vendor", "v86", "MANIFEST.json"];
const ARTEFACTS_V86 = ["vendor", "v86", "artefacts"];

/**
 * Écrit la copie du manifeste ADRESSÉE PAR SA PROPRE EMPREINTE, à côté des octets qu'elle nomme.
 *
 * Deux raisons, et la première n'est pas une commodité d'épreuve (#123).
 *
 * **Elle rend l'épinglage remontable depuis une adresse.** Une adresse d'artefact dit quels octets
 * elle sert ; elle ne dit pas QUEL épinglage les a nommés. `vendor/v86/MANIFEST.json` répond « ce
 * qui est épinglé aujourd'hui » — c'est son rôle d'indirection, et c'est pourquoi il est revalidé.
 * Cette copie-ci répond « l'épinglage qui a produit ces adresses-là », à une adresse qui ne bougera
 * plus : le retour arrière de l'ADR 0017 compare des arbres d'hier, et un arbre d'hier doit porter
 * le manifeste d'hier au bit près.
 *
 * **Elle donne à la classe immuable un octet présent dans TOUT arbre publié.** L'ADR 0023 tenait
 * cette propriété par son préfixe `/vendor/v86/`, qui embarquait le manifeste versionné ; l'amendement
 * de #123 déplace le préfixe sous `artefacts/`, absent d'un clone vierge. Sans cette copie, le
 * témoin d'en-têtes ne relèverait plus la politique immuable sur du HTTP réel à chaque
 * `npm run publier:check`, et le critère « la politique est vérifiée sur les deux origines »
 * redeviendrait déclaratif.
 *
 * @param {string} destination racine de l'arbre publié
 * @param {(contenu: Uint8Array) => string} empreinte
 * @returns {Promise<string | null>} nom du fichier écrit, ou `null` si le manifeste est absent
 */
export async function ecrireManifesteEpingle(destination, empreinte) {
  const manifeste = join(destination, ...MANIFESTE_V86);
  if (!(await existe(manifeste))) return null;
  const octets = await readFile(manifeste);
  const nom = nomAdresseDuManifeste(empreinte(octets));
  const dossier = join(destination, ...ARTEFACTS_V86);
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, nom), octets);
  return nom;
}

/**
 * Relit `vendor/v86/MANIFEST.json` dans l'arbre publié et confronte les octets servis sous le
 * préfixe IMMUABLE à ce qu'il épingle.
 *
 * C'est la moitié « runtime identifié et vérifié » de `SEC-UPDATE-001` appliquée à la PUBLICATION :
 * l'invariant l'exige avant d'ouvrir un volume en écriture, et il n'a de sens que si les octets du
 * runtime servis au navigateur sont bien ceux que l'ADR 0003 a épinglés. La vérification est faite
 * ici, sur l'arbre publié, et non dans le dépôt — c'est l'arbre qui part chez l'hébergeur.
 *
 * ## Ce que #123 y ajoute, et pourquoi c'est ce qui autorise `immutable`
 *
 * Depuis l'amendement de l'ADR 0023, `/vendor/v86/artefacts/*` est servi
 * `public, max-age=31536000, immutable` : « ces octets ne changeront jamais à cette URL ». Une
 * promesse d'un an SANS révocation ne se tient pas sur une intention, elle se MESURE, et elle se
 * mesure ici, sur l'arbre qui part. Trois passes, dont chacune ferme un mode de panne distinct :
 *
 *  1. **chaque artefact DÉCLARÉ est servi à son adresse dérivée, et à son empreinte PLEINE.** Un
 *     artefact manquant est un 404 chez l'hébergeur ; une empreinte qui ne correspond pas est une
 *     substitution ;
 *  2. **chaque fichier PRÉSENT nomme sa propre empreinte**, recalculée sur ses octets. C'est le
 *     cliquet propre à `immutable` : un fichier renommé pour porter l'adresse d'un autre — main
 *     humaine, déploiement partiel, copie interrompue — serait servi un an sous une adresse qui ne
 *     le décrit pas. La vérification est faite dans le sens qui compte : des OCTETS vers le nom ;
 *  3. **rien n'est là sans être déclaré.** C'est le correctif de la revue de #103, et #123 le durcit
 *     plutôt qu'il ne l'assouplit : `vendor/v86/artefacts/` est ignoré par git et peuplé par
 *     `npm run vm:fetch`, et un fichier oublié là par un poste de développement partirait
 *     désormais chez l'hébergeur pour UN AN de cache partagé sans révocation, au lieu de
 *     vingt-quatre heures. Le seul fichier admis en plus des artefacts est la copie du manifeste
 *     adressée par son empreinte, écrite par `ecrireManifesteEpingle` et confrontée au manifeste
 *     servi à l'adresse stable.
 *
 * Ce qui n'y est pas déclaré est un ÉCART — code 5, publication refusée — et non un fichier
 * discrètement écarté de la copie : un retrait silencieux ferait disparaître la trace de ce qui
 * traînait sur le disque du poste qui publie, quand c'est précisément ce qu'un exploitant doit voir.
 *
 * @param {string} destination racine de l'arbre publié
 * @param {(contenu: Uint8Array) => string} empreinte
 */
export async function verifierEpinglageV86(destination, empreinte) {
  const manifeste = join(destination, ...MANIFESTE_V86);
  if (!(await existe(manifeste))) {
    return {
      verifie: false,
      situation: SITUATIONS_EPINGLAGE.manifesteAbsent,
      motif: "manifeste absent",
      ecarts: [],
    };
  }
  const dossier = join(destination, ...ARTEFACTS_V86);
  if (!(await existe(dossier))) {
    return {
      verifie: false,
      situation: SITUATIONS_EPINGLAGE.artefactsAbsents,
      motif: "artefacts absents de l'arbre publié",
      ecarts: [],
    };
  }

  const octetsDuManifeste = await readFile(manifeste);
  const declares = JSON.parse(octetsDuManifeste.toString("utf8")).artifacts;
  const adressesDesArtefacts = new Map(
    declares.map((artefact) => [nomAdresse(artefact.name, artefact.sha256), artefact.sha256]),
  );
  const empreinteDuManifeste = empreinte(octetsDuManifeste);
  const attendus = new Map(adressesDesArtefacts).set(
    nomAdresseDuManifeste(empreinteDuManifeste),
    empreinteDuManifeste,
  );

  const presents = await readdir(dossier);
  // Les octets SERVIS sont confrontés dans tous les cas, y compris quand le runtime manque : un
  // fichier qui traîne sous le préfixe immuable est un écart même dans un arbre incomplet.
  const ecarts = await ecartsDesOctetsServis(dossier, presents, attendus, empreinte);
  const manquants = ecartsDesAdressesAttendues(adressesDesArtefacts, presents);

  // AUCUN artefact déclaré n'est là : c'est le clone vierge, pas une publication rompue.
  //
  // Le répertoire, lui, existe désormais toujours — `ecrireManifesteEpingle` y dépose la copie du
  // manifeste (#123) —, si bien que « le répertoire n'existe pas » a cessé d'être le signe de
  // l'incomplétude. C'est le CONTENU qui le dit maintenant. Confondre les deux ferait rendre le
  // code 5 « épinglage rompu » à tout `npm run check` lancé sans `npm run vm:fetch`, là où
  // l'inventaire porte déjà le verdict d'incomplétude et sa tolérance.
  if (manquants.length === declares.length && declares.length > 0) {
    return {
      verifie: false,
      situation: SITUATIONS_EPINGLAGE.artefactsAbsents,
      motif: "artefacts absents de l'arbre publié",
      ecarts,
    };
  }
  return {
    verifie: true,
    situation: SITUATIONS_EPINGLAGE.verifie,
    motif: null,
    ecarts: [...manquants, ...ecarts],
  };
}

/** Passe 1 — chaque adresse dérivée du manifeste est-elle servie ? */
function ecartsDesAdressesAttendues(attendus, presents) {
  const servis = new Set(presents);
  return [...attendus.keys()]
    .filter((nom) => !servis.has(nom))
    .map((nom) => ({ artefact: nom, motif: "absent de l'arbre publié" }));
}

/**
 * Passes 2 et 3 — chaque octet servi sous le préfixe immuable est-il DÉCLARÉ, et ses octets
 * correspondent-ils à l'empreinte que son adresse annonce ?
 *
 * L'ordre des deux questions n'est pas indifférent. « Déclaré » vient d'abord parce que c'est la
 * propriété de l'ADR 0003 : le manifeste est la seule liste de ce qui a le droit d'être là, et un
 * intrus doit être NOMMÉ comme tel, pas diagnostiqué par un défaut de forme de son nom. La forme du
 * nom entre tout de même dans le motif quand elle manque : elle dit ce qui rend l'intrus dangereux
 * ici, à savoir qu'il serait servi un an sans que son adresse décrive ses octets.
 *
 * Vient ensuite l'empreinte, RECALCULÉE sur les octets. Pour un fichier déclaré, son nom dérive de
 * l'empreinte épinglée : la comparaison tient donc les deux promesses à la fois — celle
 * d'`immutable`, « ces octets-là à cette adresse-là », et celle de l'ADR 0003, « ces octets-là et
 * pas d'autres ».
 */
async function ecartsDesOctetsServis(dossier, presents, attendus, empreinte) {
  const ecarts = [];
  for (const nom of presents) {
    const epinglee = attendus.get(nom);
    if (epinglee === undefined) {
      ecarts.push({ artefact: nom, motif: motifDeLIntrus(nom) });
      continue;
    }
    const mesure = empreinte(await readFile(join(dossier, nom)));
    if (mesure !== epinglee) {
      ecarts.push({ artefact: nom, motif: "empreinte", attendu: epinglee, mesure });
    }
  }
  return ecarts;
}

/** Ce qui rend un fichier non déclaré dangereux SOUS CE PRÉFIXE-LÀ, et pas ailleurs. */
function motifDeLIntrus(nom) {
  const consequence =
    "servi sous la règle /vendor/v86/artefacts/*, donc avec un cache partagé d'un an et " +
    "`immutable` — sans révocation possible";
  return empreinteDeLAdresse(nom) === null
    ? `non déclaré dans vendor/v86/MANIFEST.json et ne nommant même pas son empreinte — ${consequence} ` +
        `sur une adresse qui ne décrit pas ses octets (ADR 0003, ADR 0023 amendé par #123)`
    : `non déclaré dans vendor/v86/MANIFEST.json — ${consequence}, sans empreinte épinglée ` +
        `(ADR 0003, ADR 0023 amendé par #123)`;
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
    // Pas d'exhaustivité ici, et c'est le pendant de ce que #123 durcit sur v86 : ce répertoire est
    // la racine vendue elle-même, qui porte le manifeste et les licences par construction, et il
    // relève de la classe `coquille` (`no-cache`). Ce qui est épinglé est le binaire ; ce qui
    // l'entoure est lisible, revalidé, et révocable. Argon2id N'EST PAS adressé par empreinte : il
    // est chargé à chaque déverrouillage par un module de `src/vm/` qui nomme son empreinte en
    // dur, et le déplacer demanderait de rouvrir l'ADR 0021 — hors du périmètre de #123.
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
  const ecarts = await ecartsDesDeclares(declares, dossier, new Set(presents), empreinte);
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
