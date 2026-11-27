// Les VOIES DE SORTIE que l'application hostile tente (#341, ADR 0052), et ce que chacune doit
// montrer au témoin.
//
// Ce module est partagé par la page hostile (qui tente) et par l'épreuve (qui compte). Il ne touche à
// aucune API de navigateur : Node l'importe tel quel.
//
// Chaque voie porte le CHEMIN que l'origine tierce relève quand elle aboutit — `/fuite/<nom>` —, et
// la raison pour laquelle elle doit être fermée :
//
//  - `csp` : seule la politique du cadre la ferme. Le TÉMOIN (même page, même sandbox, sans la
//    politique) doit la voir aboutir ; sans cela, l'épreuve rouge ne prouverait rien ;
//  - `sandbox` : la sandbox de la coquille la ferme déjà (`allow-popups` et `allow-top-navigation`
//    ne sont pas accordés, ADR 0038). Elle est TENTÉE quand même, et l'épreuve exige qu'elle reste
//    fermée dans les deux montages : une sandbox élargie demain rouvrirait la voie, et la politique
//    du cadre n'y peut rien ;
//  - `aucune` : un RÉSIDUEL CONNU, que ni la politique ni la sandbox ne ferment (ADR 0052, limites).
//    Il est tenté et son issue est publiée par l'épreuve, sans être exigée : une exigence rouge en
//    permanence ne dirait plus rien, une absence de tentative cacherait le trou.

export const FERMEE_PAR = Object.freeze({ csp: "csp", sandbox: "sandbox", aucune: "aucune" });

export const VOIES_DE_SORTIE = Object.freeze([
  { nom: "fetch", fermeePar: FERMEE_PAR.csp },
  { nom: "xhr", fermeePar: FERMEE_PAR.csp },
  { nom: "image", fermeePar: FERMEE_PAR.csp },
  { nom: "script", fermeePar: FERMEE_PAR.csp },
  { nom: "feuille", fermeePar: FERMEE_PAR.csp },
  { nom: "formulaire", fermeePar: FERMEE_PAR.csp },
  { nom: "websocket", fermeePar: FERMEE_PAR.csp },
  { nom: "beacon", fermeePar: FERMEE_PAR.csp },
  { nom: "eventsource", fermeePar: FERMEE_PAR.csp },
  { nom: "cadre", fermeePar: FERMEE_PAR.csp },
  { nom: "worker", fermeePar: FERMEE_PAR.csp },
  { nom: "cadre-vierge", fermeePar: FERMEE_PAR.csp },
  { nom: "parent-fetch", fermeePar: FERMEE_PAR.csp },
  { nom: "parent-image", fermeePar: FERMEE_PAR.csp },
  { nom: "navigation-du-cadre", fermeePar: FERMEE_PAR.csp },
  // Le Service Worker du cadre désinscrit, puis un document de l'hébergeur emprunté (ADR 0052).
  { nom: "desinscription", fermeePar: FERMEE_PAR.csp },
  { nom: "fenetre", fermeePar: FERMEE_PAR.sandbox },
  { nom: "navigation-du-sommet", fermeePar: FERMEE_PAR.sandbox },
]);

/**
 * Le préfixe des requêtes que l'application adresse à SA PROPRE origine, et que la politique doit
 * laisser passer : `fetch`, image, formulaire.
 */
export const VOIE_INTERNE = "/interne/";
// Le FORMULAIRE interne a sa propre page (`formulaire-interne.html`) : sous `frame-src 'none'`, il ne
// peut plus viser un cadre-puits, et un formulaire ordinaire navigue le cadre lui-même.
export const VOIES_INTERNES = Object.freeze(["fetch", "image"]);

/** Le préfixe que l'origine tierce relève. */
export const PREFIXE_DE_FUITE = "/fuite/";

/** L'URL qu'une voie vise sur l'origine tierce. */
export function urlDeFuite(origineTierce, nom, schema = null) {
  const url = new URL(`${PREFIXE_DE_FUITE}${nom}`, origineTierce);
  if (schema !== null) url.protocol = schema;
  return url.href;
}
