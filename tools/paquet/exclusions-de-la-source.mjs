// CE QUI ENTRE dans un paquet applicatif, et ce qui n'y entre jamais (#236, revue de sécurité, 1).
//
// ## Le défaut que ce module ferme
//
// La fabrication avait DEUX listes, et elles étaient exactement complémentaires : le balayage de
// secrets IGNORAIT `.git/`, `node_modules/`, `vendor/`, `log/`, `tmp/` et `var/` ; la copie du
// Dockerfile les PRENAIT. Tout ce que le balayage ne regardait pas était donc précisément ce qui
// partait dans l'image — l'historique Git d'une application tierce, anciennes clés comprises, servi
// sous une adresse publique à tout visiteur. La revue l'a reproduit au `debugfs`.
//
// Une SEULE liste décide désormais, et c'est celle-ci : la fabrication construit un arbre filtré à
// partir d'elle, le balayage de secrets parcourt CET arbre, et c'est lui — et rien d'autre — que le
// contexte de construction nommé apporte à Docker. Ce qui n'entre pas ne peut pas fuir ; ce qui
// entre est examiné.
//
// ## Et ce que git ignore
//
// Quand la source est un dépôt git, la fabrication lui demande la liste de ses fichiers SUIVIS et
// NON IGNORÉS (`git ls-files`), puis applique encore cette liste-ci : un `.env` ignoré par git ne
// peut alors pas entrer, même s'il ne correspondait à aucun motif. Les deux se renforcent, aucune ne
// remplace l'autre — une source qui n'est pas un dépôt git reste couverte par les motifs.

/**
 * Ce qui n'entre JAMAIS dans un paquet.
 *
 * Chaque entrée est un SEGMENT de chemin : elle exclut le fichier ou le répertoire de ce nom, où
 * qu'il se trouve dans l'arbre. Un `node_modules` imbriqué est aussi inutile dans l'image qu'un
 * `node_modules` à la racine, et un `.git` de sous-module est aussi dangereux que celui du dépôt.
 */
export const MOTIFS_EXCLUS = Object.freeze([
  // L'HISTORIQUE : il porte tout ce que l'application a un jour commité, y compris ce qu'elle a
  // retiré depuis — une clé maîtresse supprimée reste dans ses objets.
  ".git",
  ".gitignore",
  ".gitattributes",
  ".github",
  ".svn",
  ".hg",
  // Les DÉPENDANCES : réinstallées dans l'image par `bundle install`, pour la bonne plateforme.
  // Celles de la source sont au mieux inutiles (amd64), au pire une divergence silencieuse.
  "node_modules",
  "vendor",
  ".bundle",
  // Ce qui est PRODUIT par une exécution : journaux, caches, état. Le guest les recrée, et ils
  // portent souvent des jetons de session, des requêtes et des chemins de la machine d'origine.
  "log",
  "tmp",
  "var",
  "coverage",
  ".yarn",
  ".cache",
  // Les enveloppes de développement, qui ne décrivent pas l'application mais la machine.
  ".idea",
  ".vscode",
  ".DS_Store",
  "Thumbs.db",
  // Les artefacts du dépôt Vault lui-même, quand la source EST `apps/reference`.
  "artifacts",
  "reports",
  "test-results",
]);

const EXCLUS = new Set(MOTIFS_EXCLUS);

/**
 * Vrai si ce chemin relatif ne doit pas entrer dans le paquet.
 *
 * Les séparateurs sont normalisés : la source peut être lue sous Windows, et `log\\production.log`
 * est le même fichier que `log/production.log`.
 *
 * @param {string} chemin chemin RELATIF à la racine de la source
 */
export function cheminExclu(chemin) {
  const segments = String(chemin).replaceAll("\\", "/").split("/");
  return segments.some((segment) => EXCLUS.has(segment));
}

/**
 * Filtre une liste de chemins : ce qui reste est EXACTEMENT ce qui entrera dans l'image.
 *
 * @param {string[]} chemins
 * @returns {string[]}
 */
export function fichiersRetenus(chemins) {
  return chemins.filter((chemin) => !cheminExclu(chemin));
}
