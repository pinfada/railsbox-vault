// Inventaire d'empreintes d'un arbre publié, et sa vérification.
//
// `docs/release-policy.md` exige d'une version publiable un « inventaire des artefacts et
// empreintes de contenu ». Ce module le produit et sait le relire. Il fait DEUX choses et pas une
// troisième :
//
//  - il énumère chaque octet servi, avec sa taille et son empreinte SHA-256 ;
//  - il lie cet ensemble à une EMPREINTE DE RACINE, calculée sur la liste canonique, elle-même liée
//    à l'empreinte du commit qui l'a produit.
//
// Ce qu'il ne fait pas, et qu'il ne faut pas lui prêter : il ne SIGNE rien. Un adversaire qui peut
// réécrire un fichier de l'arbre peut réécrire l'inventaire qui l'accompagne, et la vérification
// locale n'y verra rien. L'empreinte de racine n'a de valeur que **comparée hors bande** à celle
// qu'a publiée la construction — c'est pourquoi `publication.yml` l'imprime dans son journal et la
// dépose comme artefact séparé. La signature des artefacts reste réservée par
// `docs/release-policy.md` (« dès que la chaîne de publication existe ») et l'ADR 0017 dit
// pourquoi #45 ne la livre pas.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** Identité de format de l'inventaire, sur le modèle de `vendor/v86/MANIFEST.json`. */
export const CONTRAT_INVENTAIRE = Object.freeze({
  id: "railsbox-vault-publication",
  version: 1,
});

/** Nom du fichier d'inventaire à la racine d'un arbre publié. */
export const FICHIER_INVENTAIRE = "inventaire.json";

/**
 * Fichiers qu'un arbre porte mais que l'inventaire ne peut pas couvrir, et pourquoi.
 *
 * L'inventaire ne peut pas contenir sa propre empreinte : la calculer changerait le fichier dont
 * elle est l'empreinte. Il est donc énuméré ici plutôt que passé sous silence — un lecteur qui
 * compte les fichiers d'un arbre et ceux de son inventaire doit trouver l'écart expliqué.
 */
export const HORS_INVENTAIRE = Object.freeze([FICHIER_INVENTAIRE]);

/** @param {Uint8Array | string} contenu */
export function empreinte(contenu) {
  return createHash("sha256").update(contenu).digest("hex");
}

/**
 * Empreinte de racine : une empreinte de la LISTE, pas des octets.
 *
 * Elle est calculée sur une forme canonique — un enregistrement par ligne, `chemin<TAB>octets<TAB>
 * empreinte`, trié par chemin — de sorte que deux inventaires du même contenu la rendent identique
 * quel que soit l'ordre de parcours du système de fichiers. Un fichier RENOMMÉ la change, un
 * fichier ajouté aussi : c'est ce qui distingue une empreinte de racine d'une simple somme des
 * empreintes.
 *
 * @param {readonly { chemin: string, octets: number, sha256: string }[]} fichiers
 */
export function empreinteDeRacine(fichiers) {
  const canonique = [...fichiers]
    .sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0))
    .map(({ chemin, octets, sha256 }) => `${chemin}\t${octets}\t${sha256}`)
    .join("\n");
  return empreinte(`${canonique}\n`);
}

/**
 * Relève récursivement les fichiers d'un répertoire, chemins relatifs à séparateurs `/`.
 *
 * @param {string} racine
 * @param {readonly string[]} [ignores] chemins relatifs à ne pas relever
 */
export async function relever(racine, ignores = HORS_INVENTAIRE) {
  const aIgnorer = new Set(ignores);
  const releve = [];
  const entrees = await readdir(racine, { recursive: true, withFileTypes: true });
  for (const entree of entrees) {
    if (!entree.isFile()) continue;
    const absolu = join(entree.parentPath ?? entree.path, entree.name);
    const chemin = relative(racine, absolu).replaceAll("\\", "/");
    if (aIgnorer.has(chemin)) continue;
    const contenu = await readFile(absolu);
    releve.push({ chemin, octets: contenu.byteLength, sha256: empreinte(contenu) });
  }
  return releve.sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
}

/**
 * Construit l'inventaire d'un arbre déjà écrit sur le disque.
 *
 * @param {{ arbre: string, racine: string, commit: object, origine: string,
 *           enTetes: Record<string, string>, exclusions: readonly object[],
 *           complet: boolean, absentes: readonly string[], role: string }} description
 */
export async function construireInventaire(description) {
  const fichiers = await relever(description.racine);
  return {
    contrat: CONTRAT_INVENTAIRE,
    arbre: description.arbre,
    role: description.role,
    origine: description.origine,
    commit: description.commit,
    complet: description.complet,
    // Un arbre construit pour un BANC — origines de test, `http:` — n'est pas un artefact
    // publiable, et il ne doit pas pouvoir être pris pour tel. `npm run publier:check` en produit
    // un à chaque exécution ; sans cette marque, un `artifacts/` traîné d'une session à l'autre
    // ressemblerait trait pour trait à une publication.
    banc: description.banc,
    absentes: [...description.absentes],
    enTetes: description.enTetes,
    horsInventaire: [...HORS_INVENTAIRE],
    exclusions: description.exclusions.map(({ prefixe, motif }) => ({ prefixe, motif })),
    empreinteDeRacine: empreinteDeRacine(fichiers),
    fichiers,
  };
}

/**
 * Confronte un inventaire à un relevé du disque.
 *
 * Les trois écarts sont rendus SÉPARÉMENT parce qu'ils ne se diagnostiquent pas de la même façon :
 * un fichier `altere` est une publication corrompue ou une reconstruction non reproductible ; un
 * fichier `ajoute` est une surface qui n'a pas été décidée — le cas que `docs/release-policy.md`
 * vise en exigeant l'exclusion des bancs ; un fichier `manquant` est un déploiement incomplet.
 *
 * @param {{ fichiers: readonly { chemin: string, octets: number, sha256: string }[] }} inventaire
 * @param {readonly { chemin: string, octets: number, sha256: string }[]} releve
 */
export function comparer(inventaire, releve) {
  const attendus = new Map(inventaire.fichiers.map((entree) => [entree.chemin, entree]));
  const mesures = new Map(releve.map((entree) => [entree.chemin, entree]));

  const alteres = [];
  const manquants = [];
  for (const [chemin, attendu] of attendus) {
    const mesure = mesures.get(chemin);
    if (mesure === undefined) {
      manquants.push(chemin);
    } else if (mesure.sha256 !== attendu.sha256 || mesure.octets !== attendu.octets) {
      alteres.push({
        chemin,
        attendu: { octets: attendu.octets, sha256: attendu.sha256 },
        mesure: { octets: mesure.octets, sha256: mesure.sha256 },
      });
    }
  }

  const ajoutes = [...mesures.keys()].filter((chemin) => !attendus.has(chemin)).sort();

  const racineMesuree = empreinteDeRacine(releve);
  return {
    alteres,
    ajoutes,
    manquants: manquants.sort(),
    racineAttendue: inventaire.empreinteDeRacine,
    racineMesuree,
    conforme:
      alteres.length === 0 &&
      ajoutes.length === 0 &&
      manquants.length === 0 &&
      racineMesuree === inventaire.empreinteDeRacine,
  };
}

/**
 * Vérifie un arbre publié à partir de l'inventaire qu'il porte.
 *
 * @param {string} racine
 */
export async function verifierArbre(racine) {
  const brut = await readFile(join(racine, FICHIER_INVENTAIRE), "utf8");
  const inventaire = JSON.parse(brut);
  if (inventaire?.contrat?.id !== CONTRAT_INVENTAIRE.id) {
    throw new Error(
      `Inventaire d'un autre contrat : ${inventaire?.contrat?.id ?? "aucun"} au lieu de ${CONTRAT_INVENTAIRE.id}.`,
    );
  }
  if (inventaire.contrat.version !== CONTRAT_INVENTAIRE.version) {
    throw new Error(
      `Version d'inventaire non gérée : ${inventaire.contrat.version} au lieu de ${CONTRAT_INVENTAIRE.version}.`,
    );
  }
  return { inventaire, ecarts: comparer(inventaire, await relever(racine)) };
}
