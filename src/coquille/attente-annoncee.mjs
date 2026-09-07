// L'ATTENTE ANNONCÉE avant une dérivation de phrase (#162, ADR 0029).
//
// L'[ADR 0021](../../docs/decisions/0021-derivation-des-cles-de-deverrouillage.md) § « Mesures »
// se termine sur une phrase qui désigne cette tranche : « ce que la mesure appelle est un travail
// d'INTERFACE (#24) — annoncer l'attente plutôt que la subir —, pas un travail de cryptographie ».
// Ce module est cette annonce, et rien d'autre.
//
// ## Pourquoi une TABLE, et pourquoi elle est ici
//
// Une dérivation calibrée coûte 364 ms sur Chromium et 2 136 ms sur Firefox : près de six fois plus,
// pour le même travail. Une coquille qui ne dirait rien ferait vivre le même geste comme
// « instantané » ici et comme « figé » là-bas, et l'utilisateur qui attend deux secondes sans
// explication conclut à une panne. L'annonce lui donne l'ordre de grandeur AVANT qu'il le subisse.
//
// La table est celle des mesures publiées, **relue** et non recopiée : `tests/unit/coquille-
// deverrouillage.test.mjs` confronte chaque valeur au tableau de l'ADR 0021, et rougit si l'un des
// deux bouge sans l'autre. C'est ce qui empêche qu'une mesure refaite un jour laisse derrière elle
// une annonce qui ment.
//
// ## Ce que l'annonce n'est PAS
//
// Ce n'est ni une promesse, ni une barre de progression : le nombre annoncé est un ordre de
// grandeur mesuré sur UNE machine de développement, et le matériel de l'utilisateur — un téléphone
// surtout — n'est pas dans ces chiffres (ADR 0021, limite 6). La coquille le dit sous cette forme,
// et n'affiche jamais un compte à rebours qu'elle serait incapable de tenir.
//
// ## Le code et la passkey n'annoncent RIEN
//
// Ils coûtent 0 à 2 ms (ADR 0025 décision 1, ADR 0021 § Mesures). Annoncer une attente qui n'existe
// pas ferait douter d'un geste immédiat, et diluerait l'annonce qui compte. La liste est donc
// close : `MOYENS_ANNONCES` ne contient que la phrase.

/**
 * Les moteurs de la matrice #2, tels que l'ADR 0021 § « Mesures » les nomme. Les clés sont celles
 * des projets Playwright, pour qu'un relevé et une annonce parlent du même moteur.
 */
export const MOTEURS_MESURES = Object.freeze(["chromium", "firefox", "webkit"]);

/**
 * La table des mesures publiées : p50 et p95 d'une dérivation calibrée, DEUX exécutions par moteur.
 *
 * Les deux exécutions sont conservées plutôt que moyennées, parce que c'est leur ÉCART qui rend la
 * mesure crédible — « la dispersion entre les deux exécutions est inférieure à 2 % partout », dit
 * l'ADR. Une moyenne aurait effacé la seule chose qui distingue une mesure d'un chiffre.
 */
export const ATTENTE_MESUREE = Object.freeze({
  chromium: Object.freeze({ p50Ms: Object.freeze([364, 363]), p95Ms: Object.freeze([443, 446]) }),
  webkit: Object.freeze({ p50Ms: Object.freeze([329, 324]), p95Ms: Object.freeze([458, 418]) }),
  firefox: Object.freeze({
    p50Ms: Object.freeze([2141, 2136]),
    p95Ms: Object.freeze([2205, 2207]),
  }),
});

/**
 * Le moteur retenu quand aucun n'est reconnu.
 *
 * C'est le PLUS LENT, et le choix se justifie dans le seul sens qui compte : annoncer deux secondes
 * pour une attente de trois cents millisecondes fait passer un geste pour plus lent qu'il n'est,
 * ce qui déçoit dans le bon sens ; annoncer trois cents millisecondes pour deux secondes fait
 * croire à une panne. Un moteur inconnu est aussi, statistiquement, un moteur qui n'est dans aucune
 * des trois colonnes mesurées — donc un moteur sur lequel le dépôt ne sait rien.
 */
export const MOTEUR_PAR_DEFAUT = "firefox";

/** Les moyens de déverrouillage qui ANNONCENT une attente. La liste est close, et courte. */
export const MOYENS_ANNONCES = Object.freeze(["phrase"]);

/**
 * Le moteur PROBABLE, d'après la chaîne d'agent utilisateur.
 *
 * L'ordre des essais est le sujet : Firefox porte « Gecko » et rien d'autre, WebKit porte
 * « Safari » sans « Chrome », et Chromium porte les deux. Tester Chromium en dernier ferait
 * reconnaître tout Chromium comme un WebKit — c'est l'erreur classique de cette détection, et elle
 * ferait annoncer 329 ms là où il en faut 364.
 *
 * Rien de sensible ne dépend de ce verdict : il ne choisit qu'un NOMBRE à afficher. Se tromper
 * annonce une attente approximative ; cela n'ouvre ni ne ferme rien.
 *
 * @param {string | null | undefined} agent
 * @returns {string} un moteur de `MOTEURS_MESURES`, `MOTEUR_PAR_DEFAUT` à défaut
 */
export function moteurProbable(agent) {
  if (typeof agent !== "string") return MOTEUR_PAR_DEFAUT;
  if (agent.includes("Firefox/") || agent.includes("Gecko/")) return "firefox";
  if (agent.includes("Chrome/") || agent.includes("Chromium/") || agent.includes("Edg/")) {
    return "chromium";
  }
  if (agent.includes("Safari/") || agent.includes("AppleWebKit/")) return "webkit";
  return MOTEUR_PAR_DEFAUT;
}

/** Arrondi d'affichage : au dixième de seconde au-delà d'une seconde, à la centaine en deçà. */
function ordreDeGrandeur(millisecondes) {
  if (millisecondes >= 1000) return `environ ${(millisecondes / 1000).toFixed(1)} seconde(s)`;
  return `environ ${Math.round(millisecondes / 100) * 100} millisecondes`;
}

/**
 * L'ANNONCE à faire avant de dériver, pour un moyen et un moteur donnés.
 *
 * Elle rend `null` — et non une phrase vide — quand le moyen n'annonce rien : la coquille distingue
 * ainsi « rien à annoncer » de « annonce vide », et ne peut pas afficher un paragraphe muet.
 *
 * Le nombre retenu est le **p95 le plus haut des deux exécutions**, pas le p50 : ce qu'on annonce
 * est ce que l'utilisateur risque d'attendre, pas ce qu'il attendra la moitié du temps. Une
 * médiane annoncée est fausse une fois sur deux, et toujours dans le sens qui déçoit.
 *
 * @param {{ moyen: string, moteur?: string }} appel
 * @returns {{ moteur: string, attenteMs: number, texte: string } | null}
 */
export function annonceDAttente({ moyen, moteur = MOTEUR_PAR_DEFAUT }) {
  if (!MOYENS_ANNONCES.includes(moyen)) return null;
  const mesure = ATTENTE_MESUREE[moteur] ?? ATTENTE_MESUREE[MOTEUR_PAR_DEFAUT];
  const retenu = ATTENTE_MESUREE[moteur] === undefined ? MOTEUR_PAR_DEFAUT : moteur;
  const attenteMs = Math.max(...mesure.p95Ms);
  return Object.freeze({
    moteur: retenu,
    attenteMs,
    texte:
      `Le déverrouillage par phrase calcule une clé volontairement coûteuse : comptez ` +
      `${ordreDeGrandeur(attenteMs)} sur ce navigateur. C'est un ordre de grandeur mesuré sur une ` +
      `machine de développement, pas une promesse : votre appareil peut être plus lent. Cette ` +
      `attente est le prix du coffre — elle est la même pour qui essaierait vos phrases une à une.`,
  });
}

/** Ce que la coquille affiche PENDANT la dérivation. Un état, pas un compte à rebours. */
export const TEXTE_EN_COURS =
  "Dérivation en cours… Ne fermez pas cet onglet ; l'onglet peut sembler figé le temps du calcul.";
