// D'où la coquille tire l'ORIGINE APPLICATIVE qu'elle encadre, et qu'elle exige (#161, ADR 0028).
//
// La coquille doit connaître cette origine pour deux gestes, et ils ne se valent pas : elle
// l'emploie pour CRÉER le cadre, ce qui est une commodité, et pour COMPARER `event.origin` à
// l'annonce reçue, ce qui est une frontière. La seconde interdit qu'elle soit devinable ou
// fournie par le message lui-même — une origine annoncée par celui qu'on vérifie ne vérifie rien.
//
// Elle n'est donc ni lue d'un message, ni lue d'un stockage, ni prise dans l'URL : elle est
// DÉRIVÉE de l'origine de la coquille par une règle écrite ici, la même dans la page, dans le
// serveur de test et dans la suite unitaire.
//
// ## La règle, et son exception locale
//
// **Règle générale** : l'origine applicative est celle de la coquille, hôte préfixé de `app.`.
// C'est le schéma de l'ADR 0002 (`https://vault.exemple` / `https://app.vault.exemple`) et celui
// que l'ADR 0018 généralise à N applications (`a.app.vault.exemple`, `b.app…`).
//
// **Exception déclarée** : en local, `127.0.0.1` n'a pas de sous-domaine. Le dépôt obtient depuis
// le spike #35 sa seconde origine par le couple `127.0.0.1` / `localhost`, qui désignent la même
// interface de bouclage tout en formant deux origines distinctes au sens du navigateur, et tous
// deux restent des contextes sécurisés. La règle locale reprend ce couple et prend le port
// SUIVANT : c'est exactement la disposition de `tools/serve.mjs` (4173/4174) et celle de
// `npm run publier:check` (4193/4194).
//
// Une origine que ni la règle ni l'exception ne savent traduire rend `null`. La coquille n'invente
// alors aucun cadre et le dit dans son état : encadrer une origine devinée reviendrait à choisir
// soi-même celui qu'on va croire.

/** Hôte local de la coquille, et son pendant applicatif. Deux origines, une seule interface. */
export const HOTE_LOCAL_COQUILLE = "127.0.0.1";
export const HOTE_LOCAL_APPLICATION = "localhost";

/** Préfixe d'hôte de l'origine applicative, sur un domaine propre (ADR 0002, ADR 0018). */
export const PREFIXE_APPLICATIF = "app.";

/**
 * Dérive l'origine applicative de l'origine de la coquille.
 *
 * @param {string} origineCoquille origine sérialisée, telle que `location.origin` la rend
 * @returns {string | null} l'origine applicative, ou `null` si la règle ne sait pas conclure
 */
export function origineApplicativeDe(origineCoquille) {
  let url;
  try {
    url = new URL(origineCoquille);
  } catch {
    return null;
  }
  if (url.hostname === HOTE_LOCAL_COQUILLE) return origineLocale(url);
  // Une origine applicative ne se dérive pas d'une origine applicative : `app.app.…` serait le
  // signe qu'on encadre le territoire du guest depuis le territoire du guest.
  if (url.hostname.startsWith(PREFIXE_APPLICATIF)) return null;
  // Un hôte sans point est un nom de machine, pas un domaine : lui préfixer `app.` fabriquerait
  // une origine qu'aucun DNS ne résout, et la coquille encadrerait une adresse morte.
  if (!url.hostname.includes(".")) return null;
  return `${url.protocol}//${PREFIXE_APPLICATIF}${url.host}`;
}

/**
 * Le couple local : `localhost` sur le port suivant. Le port est celui de l'origine, faute de quoi
 * les deux serveurs de `tools/serve.mjs` se disputeraient la même socket.
 *
 * @param {URL} url
 */
function origineLocale(url) {
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port >= 65535) return null;
  return `${url.protocol}//${HOTE_LOCAL_APPLICATION}:${port + 1}`;
}

/**
 * Chemin du document applicatif encadré par défaut.
 *
 * Le chemin est une donnée du PRODUIT et non une commodité d'épreuve : en production, ce que la
 * coquille encadre est ce que l'utilisateur demande à l'application — `/commandes/42` aussi bien
 * que `/`. Ce qui n'est jamais un paramètre, c'est l'ORIGINE : elle vient de la règle ci-dessus.
 */
export const CHEMIN_APPLICATIF_PAR_DEFAUT = "/document-applicatif.html";

/**
 * Vérifie qu'un chemin demandé est un chemin, et rien d'autre.
 *
 * Le seul danger d'un chemin fourni est qu'il cesse d'en être un : `//exemple.test/` est une URL
 * relative au SCHÉMA, et `https://exemple.test/` une URL absolue. L'une comme l'autre déplaceraient
 * l'origine encadrée, c'est-à-dire la frontière. La CSP `frame-src` les refuserait ensuite, mais
 * une frontière qui ne tient que par la seconde ligne de défense n'est pas une frontière.
 *
 * @param {unknown} chemin
 * @returns {string | null} le chemin, ou `null` s'il n'en est pas un
 */
export function cheminApplicatifAdmis(chemin) {
  if (typeof chemin !== "string" || chemin.length === 0) return null;
  if (!chemin.startsWith("/")) return null;
  if (chemin.startsWith("//")) return null;
  if (chemin.includes("\\")) return null;
  return chemin;
}

/**
 * URL du document applicatif à encadrer.
 *
 * @param {string} origineCoquille
 * @param {unknown} [cheminDemande]
 * @returns {{ origineApplicative: string, url: string } | null}
 */
export function cadreApplicatif(origineCoquille, cheminDemande = null) {
  const origineApplicative = origineApplicativeDe(origineCoquille);
  if (origineApplicative === null) return null;
  const chemin = cheminApplicatifAdmis(cheminDemande) ?? CHEMIN_APPLICATIF_PAR_DEFAUT;
  return { origineApplicative, url: `${origineApplicative}${chemin}` };
}
