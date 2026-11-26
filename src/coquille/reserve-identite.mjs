// Les NOMS STABLES de la réserve (#299, ADR 0048 § 1) : l'URL du script du Service Worker de la coquille et
// le préfixe de ses caches. Stables, PAS irréversibles : déplacer le script orpheline les inscriptions
// existantes, qui ne seraient plus jamais mises à jour. La procédure pour les faire évoluer est écrite au
// § 11 de l'ADR. Une URL ou un préfixe changé sans cette procédure est une régression.
//
// Le script du SW est un fichier sans `import` : il écrit ces valeurs lui-même, et une épreuve les égale.

/** L'URL du script, à la RACINE : un SW ne couvre que le répertoire de son script (jamais `Service-Worker-Allowed`). */
export const URL_DU_SW = "/sw-coquille.mjs";

/** Le préfixe de cache RÉSERVÉ au produit : seul ce préfixe (et les anciens NOMMÉS) est supprimé. */
export const PREFIXE_DE_CACHE = "reserve-";

/**
 * Les anciens préfixes du produit, LISTE FERMÉE (migration, § 11). Vide : le préfixe n'a jamais changé.
 * Jamais « tout ce qui n'est pas à moi ».
 */
export const PREFIXES_ANCIENS = Object.freeze([]);
