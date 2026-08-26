// Garde d'armement de l'injecteur d'arrêts (#15).
//
// L'injecteur fabrique des pannes : handle perdu, écriture tronquée, barrière qui n'aboutit pas.
// C'est un instrument de mesure, et un instrument de mesure ne doit jamais pouvoir s'armer en
// dehors de son harnais. `SECURITY.md` décrit déjà ce mécanisme pour le drapeau `--worker-src-blob`
// de `tools/serve.mjs` : le drapeau existe, il est REFUSÉ AU DÉMARRAGE si le processus ne porte pas
// la variable du harnais, et le refus est figé par une épreuve unitaire. La même règle vaut ici.
//
// Deux contextes, deux clés, et elles ne se remplacent pas l'une l'autre :
//
//  - **sous Node** (`npm run check`), la variable d'environnement du harnais est exigée. Un jeton
//    passé en argument ne la rachète pas, sinon la garde du processus serait contournable par un
//    appel ;
//  - **dans un Worker de navigateur**, il n'y a pas d'environnement de processus. La garde exige
//    alors le JETON exact, que seule la page de résilience du harnais transmet. C'est une garde
//    plus faible que la variable — un appelant de la même origine peut la nommer — et elle est
//    donnée pour ce qu'elle est : elle interdit l'armement ACCIDENTEL et rend l'intention
//    explicite ; elle ne prétend pas résister à un appelant décidé qui vit déjà dans le Worker.
//
// Ce que la garde protège tient en une phrase : aucun chemin du produit n'arme l'injecteur. Ni
// `public/vm/banc.mjs`, ni le Worker runtime hors scénario de résilience, ni un lancement de
// service ne transmettent l'une ou l'autre clé.

/** Variable d'environnement exigée du harnais de résilience, sous Node. */
export const HARNAIS_RESILIENCE_ENV = "VAULT_HARNAIS_RESILIENCE";

/** Valeur exacte attendue. Une valeur approchante n'ouvre rien. */
export const HARNAIS_RESILIENCE_VALEUR = "mesure-arrets";

/** Jeton exigé d'un Worker de navigateur, faute d'environnement de processus. */
export const HARNAIS_RESILIENCE_JETON = "vault/harnais-resilience/mesure-arrets";

const REFUS =
  `L'injecteur d'arrêts de #15 ne s'arme que dans le harnais de résilience. Sous Node, le ` +
  `processus doit porter ${HARNAIS_RESILIENCE_ENV}=${HARNAIS_RESILIENCE_VALEUR} ; dans un Worker ` +
  `de navigateur, l'appel doit présenter le jeton du harnais. Aucun chemin du produit ne les ` +
  `transmet : un armement ici serait une injection de panne en exploitation.`;

/**
 * Refuse l'armement hors harnais. Bruyamment : une garde qui rendrait `false` finirait par être
 * ignorée par un appelant pressé.
 *
 * @param {{ jeton?: string }} [options] `jeton` n'est lu que hors processus Node.
 * @throws {Error} si le contexte n'est pas celui du harnais
 */
export function exigerHarnaisResilience({ jeton } = {}) {
  const environnement = globalThis.process?.env;
  if (environnement) {
    if (environnement[HARNAIS_RESILIENCE_ENV] === HARNAIS_RESILIENCE_VALEUR) return;
    throw new Error(REFUS);
  }
  if (jeton === HARNAIS_RESILIENCE_JETON) return;
  throw new Error(REFUS);
}
