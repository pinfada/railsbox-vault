import { expect } from "@playwright/test";

// BUDGET de la réouverture d'un volume après la mort du Worker qui le tenait (#129).
//
// Ce module n'est pas une épreuve : c'est le budget que trois épreuves de la suite VM partagent, et
// la fabrique du relevé qu'elles joignent. Il vit à côté d'elles parce qu'un budget recopié dans
// trois fichiers dérive dans deux d'entre eux.
//
// ## Pourquoi un budget, et plus une valeur figée
//
// La suite exigeait `reouverture.essais === 1`. C'était vrai par chance : jusqu'à #16, une session
// de volume ne tenait qu'UN handle exclusif, et Chromium le rendait avant que la page n'ait démarré
// le Worker suivant. Depuis #16 elle en tient un deuxième (`<volume>.gen`) et depuis #19 un
// troisième (`<volume>.temoin`) — mesure faite par `tests/unit/vm-reouverture-handles.test.mjs` —,
// et la réouverture n'aboutit que lorsque le PLUS LENT des trois a été rendu. Le run nocturne
// rougissait deux nuits sur trois avec `Received: 2`, sur un harnais qui faisait exactement ce pour
// quoi il est écrit : tolérer un refus `busy`, borner l'attente, publier son coût.
//
// Ce que la suite mesure désormais est ce qui compte vraiment : **la réouverture aboutit dans la
// borne, et son coût est publié.** Le plafond ci-dessous est un engagement sur le MOTEUR, pas une
// observation figée d'une nuit.

/**
 * Nombre d'essais au-delà duquel la réouverture cesse d'être « le moteur a une poignée de
 * millisecondes de retard » et devient une mesure à examiner.
 *
 * **Motif**, dérivé de la mesure de `tests/unit/vm-reouverture-handles.test.mjs` : une session tient
 * TROIS handles exclusifs, et un seul encore tenu suffit à rendre `busy`. Le budget accorde donc un
 * essai perdu par handle — soit, à `attenteMs` près, deux intervalles d'attente entre le premier
 * essai et le dernier admis. Au-delà, ce n'est plus le nombre de voisins qui explique le retard,
 * c'est le moteur qui met à rendre l'exclusivité plus longtemps que l'ouverture ne le suppose : le
 * remède est alors d'espacer les essais ou d'en réduire le nombre de handles, pas de relever ce
 * plafond.
 *
 * Il reste très en deçà de la borne DURE du harnais — soixante essais, trois secondes —, qui n'est
 * pas un budget mais un garde-fou : elle empêche une réouverture impossible de bloquer la suite.
 */
export const ESSAIS_MAX_REOUVERTURE = 3;

/**
 * Exige que la réouverture ait ABOUTI DANS LA BORNE, et rien de plus.
 *
 * Aucune valeur n'est figée : `essais` vaut ce que le moteur a imposé cette nuit-là. Ce qui est
 * exigé, c'est que le relevé existe, qu'il soit cohérent, et qu'il tienne dans le budget.
 *
 * @param {{ essais: number, attenteMs: number }} reouverture
 * @param {string} ou de quoi situer le point de coupure dans le message d'échec
 */
export function exigerReouvertureDansLeBudget(reouverture, ou) {
  expect(reouverture, `${ou} — la réouverture doit publier son coût`).toBeTruthy();
  expect(reouverture.essais, ou).toBeGreaterThanOrEqual(1);
  expect(reouverture.essais, ou).toBeLessThanOrEqual(ESSAIS_MAX_REOUVERTURE);
  // L'espacement des essais est publié avec eux : sans lui, `essais` ne se convertit en aucune
  // durée, et deux relevés pris sous deux espacements différents seraient comparés à tort.
  expect(reouverture.attenteMs, ou).toBeGreaterThan(0);
}

/**
 * Relevé JOINT de la réouverture : ce que chaque point a coûté, et le pire de la série.
 *
 * L'attente réellement subie est DÉRIVÉE, pas relue : `essais - 1` intervalles de `attenteMs`. Un
 * relevé qui ne publierait que le nombre d'essais laisserait le lecteur convertir lui-même.
 *
 * @param {Array<{ ou: string, reouverture: { essais: number, attenteMs: number } }>} points
 */
export function releveDeReouverture(points) {
  const lignes = points.map(({ ou, reouverture }) => ({
    ou,
    essais: reouverture.essais,
    attenteMs: reouverture.attenteMs,
    attenteSubieMs: (reouverture.essais - 1) * reouverture.attenteMs,
  }));
  return {
    budgetEssais: ESSAIS_MAX_REOUVERTURE,
    essaisMax: Math.max(...lignes.map((ligne) => ligne.essais)),
    attenteSubieMaxMs: Math.max(...lignes.map((ligne) => ligne.attenteSubieMs)),
    points: lignes,
  };
}
