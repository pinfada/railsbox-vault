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
  return cheminSansDetour(chemin);
}

/** Les ENCODAGES d'un séparateur ou d'un point : un détour écrit autrement reste un détour. */
const ENCODAGES_DE_DETOUR = /%(?:2f|5c|2e)/i;

/**
 * Un chemin ABSOLU de la même origine, qui ne peut plus en devenir un autre, ou `null`.
 *
 * Une garde qui ne regarde que le DÉBUT d'un chemin (`//`, `\`) est contournée par ce que la
 * normalisation d'une URL fera ensuite de son MILIEU : `/..//evil.test/` commence bien par une
 * seule barre, et se normalise pourtant en `//evil.test/` — une URL relative au schéma, c'est-à-dire
 * une autre origine (revue de sécurité de la PR #203, constat 4). La règle est donc posée sur la
 * partie CHEMIN entière, avant toute normalisation, et elle refuse ce qui pourrait en changer :
 *
 *  - un chemin qui ne commence pas par `/` ;
 *  - une barre inversée, n'importe où — certains analyseurs la lisent comme `/` ;
 *  - un segment VIDE (`//`), un segment `.` ou `..` — ce sont eux que la normalisation replie ;
 *  - un séparateur ou un point ENCODÉS (`%2F`, `%5C`, `%2E`) — la même chose, écrite autrement ;
 *  - un caractère de contrôle ou une ESPACE, n'importe où, requête comprise : c'est une seconde
 *    ligne dans la requête HTTP que le pont série composera, et le pont refuse l'espace lui-même
 *    (`serial-bridge.py`) — l'admettre ici rendrait un refus MUET là où un refus typé est promis.
 *
 * La REQUÊTE (`?…`) n'est pas repliée par la normalisation : elle n'est soumise qu'à la dernière
 * règle, et `?retour=%2Fnotes` reste admis.
 *
 * @param {unknown} valeur
 * @returns {string | null}
 */
export function cheminSansDetour(valeur) {
  if (typeof valeur !== "string" || valeur.length === 0) return null;
  for (let index = 0; index < valeur.length; index += 1) {
    const code = valeur.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  const fin = valeur.search(/[?#]/);
  const chemin = fin === -1 ? valeur : valeur.slice(0, fin);
  if (!chemin.startsWith("/")) return null;
  if (chemin.includes("\\")) return null;
  if (ENCODAGES_DE_DETOUR.test(chemin)) return null;
  const segments = chemin.slice(1).split("/");
  // Le DERNIER segment peut être vide : `/notes/` est un chemin. Aucun autre.
  for (let rang = 0; rang < segments.length; rang += 1) {
    const segment = segments[rang];
    if (segment === "." || segment === "..") return null;
    if (segment === "" && rang !== segments.length - 1) return null;
  }
  return valeur;
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
