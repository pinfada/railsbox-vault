// Injecteur d'arrêts et d'écritures partielles (#15).
//
// Ce module ne coupe rien lui-même : il PLANIFIE. À partir d'une graine entière, il rend une suite
// déterministe de points de coupure sur le chemin bloc → OPFS, et sait traduire un point en plan de
// fautes pour `fault-plan.mjs`. La coupure elle-même est exécutée par le backend (le plan de fautes)
// et, sur le chemin navigateur, par un `Worker.terminate()` de la page.
//
// #15 livre l'INSTRUMENT ; #16 livrera la garantie. Rien ici ne promet qu'une coupure laisse le
// volume dans un état atomique : le rôle de ce module est de rendre la coupure REPRODUCTIBLE, pour
// que ce qu'elle laisse soit mesurable et rejouable.
//
// La graine est une DONNÉE VERSIONNABLE, comme le dit déjà l'en-tête de `fault-plan.mjs` : le
// générateur pseudo-aléatoire est écrit ici, entier, et `Math.random` n'apparaît nulle part. Deux
// exécutions de la même graine sur deux machines rendent la même séquence.

import { exigerHarnaisResilience } from "./crash-harness.mjs";
import { FAULT_KINDS, createFaultPlan } from "./fault-plan.mjs";

/**
 * Genres de coupure. Ils recouvrent les trois formes que le contrat de #15 nomme, et ils sont
 * DISJOINTS — chacun s'arme différemment et laisse une trace différente sur le support.
 */
export const CRASH_KINDS = Object.freeze({
  /** Arrêt brutal : l'opération visée et toutes les suivantes n'ont pas lieu. */
  abrupt: "arret-brutal",
  /** Écriture déchirée : une partie seulement des octets d'un bloc atteint le support. */
  torn: "ecriture-dechiree",
  /** Coupure entre écriture et barrière : les écritures ont eu lieu, la barrière jamais. */
  beforeBarrier: "coupure-avant-barriere",
});

/**
 * Opérations qu'un arrêt brutal peut viser. La BARRIÈRE en est exclue à dessein : un arrêt brutal
 * qui tombe sur une barrière porte un nom à lui, `coupure-avant-barriere`, parce que c'est le seul
 * point qui sépare une écriture ACQUITTÉE d'une écriture DURABLE. Les confondre effacerait la
 * différence même que #16 devra fermer.
 */
const OPERATIONS_ARRET = Object.freeze(["read", "write"]);

/** Générateur pseudo-aléatoire déterministe (mulberry32). 32 bits d'état, aucune dépendance. */
function generateur(graine) {
  let etat = graine | 0;
  return () => {
    etat = (etat + 0x6d2b79f5) | 0;
    let melange = Math.imul(etat ^ (etat >>> 15), 1 | etat);
    melange = (melange + Math.imul(melange ^ (melange >>> 7), 61 | melange)) ^ melange;
    return ((melange ^ (melange >>> 14)) >>> 0) / 4294967296;
  };
}

/** Entier de `[1, borne]`, tiré du générateur. */
function rang(tirer, borne) {
  return 1 + Math.floor(tirer() * borne);
}

function exigerEntierPositif(valeur, nom) {
  if (!Number.isInteger(valeur) || valeur < 1) {
    throw new RangeError(`Le profil de coupure exige ${nom} : un entier supérieur ou égal à 1.`);
  }
}

/**
 * @typedef {object} CrashPoint
 * @property {number} graine graine qui l'a produit
 * @property {number} index rang dans la séquence, à partir de 0
 * @property {string} kind une valeur de `CRASH_KINDS`
 * @property {"read" | "write" | "flush"} operation opération visée
 * @property {number} occurrence rang de cette opération, à partir de 1
 * @property {number | null} bytes octets qui atteignent le support, pour une écriture déchirée
 */

/**
 * Séquence déterministe de points de coupure.
 *
 * Le profil décrit ce que le scénario ÉMET réellement. Un point posé au-delà — une lecture dans un
 * scénario qui n'en fait aucune, une barrière n° 4 dans un scénario qui en émet trois — ne serait
 * jamais atteint, et `FaultPlan#unfired` rappelle qu'une faute jamais tirée ne prouve rien.
 *
 * @param {number} graine entier positif ou nul
 * @param {{ points: number, ecritures: number, barrieres: number, tailleBloc: number,
 *           lectures?: number }} profil
 * @returns {readonly CrashPoint[]}
 */
export function planifierCoupures(graine, profil) {
  if (!Number.isInteger(graine) || graine < 0) {
    throw new RangeError(`Graine invalide : ${graine}. Un entier positif ou nul est exigé.`);
  }
  const { points, ecritures, barrieres, tailleBloc, lectures = 0 } = profil ?? {};
  exigerEntierPositif(points, "points");
  exigerEntierPositif(ecritures, "écritures");
  exigerEntierPositif(barrieres, "barrières");
  exigerEntierPositif(tailleBloc, "tailleBloc");
  if (!Number.isInteger(lectures) || lectures < 0) {
    throw new RangeError("Le profil de coupure exige lectures : un entier positif ou nul.");
  }

  const tirer = generateur(graine);
  const genres = Object.values(CRASH_KINDS);
  const operationsArret = OPERATIONS_ARRET.filter((operation) =>
    operation === "read" ? lectures > 0 : true,
  );

  const suite = [];
  for (let index = 0; index < points; index += 1) {
    const kind = genres[Math.floor(tirer() * genres.length)];
    suite.push(Object.freeze(tracerPoint({ graine, index, kind, tirer, operationsArret, profil })));
  }
  return Object.freeze(suite);
}

/** Détaille un point une fois son genre tiré. Séparé pour rester sous la barre des 50 lignes. */
function tracerPoint({ graine, index, kind, tirer, operationsArret, profil }) {
  const { ecritures, barrieres, tailleBloc, lectures = 0 } = profil;

  if (kind === CRASH_KINDS.beforeBarrier) {
    return {
      graine,
      index,
      kind,
      operation: "flush",
      occurrence: rang(tirer, barrieres),
      bytes: null,
    };
  }
  if (kind === CRASH_KINDS.torn) {
    // Ni 0 ni le bloc entier : le premier laisserait le bloc INTACT, le second COMPLET. Dans les
    // deux cas rien ne serait déchiré, et le point ne mesurerait rien.
    return {
      graine,
      index,
      kind,
      operation: "write",
      occurrence: rang(tirer, ecritures),
      bytes: rang(tirer, tailleBloc - 1),
    };
  }
  const operation = operationsArret[Math.floor(tirer() * operationsArret.length)];
  const borne = operation === "read" ? lectures : ecritures;
  return { graine, index, kind, operation, occurrence: rang(tirer, borne), bytes: null };
}

/**
 * Traduit un point de coupure en spécifications de `fault-plan.mjs`. Aucune nouvelle sorte de faute
 * n'est inventée : les quatre du plan existant suffisent, et c'est bien le même code de backend qui
 * exécute la panne.
 *
 * @param {CrashPoint} point
 * @returns {import("./fault-plan.mjs").FaultSpec[]}
 */
export function pointEnFautes(point) {
  const { kind, operation, occurrence, bytes } = point ?? {};
  if (kind === CRASH_KINDS.torn) {
    return [{ kind: FAULT_KINDS.partialWrite, operation: "write", occurrence, bytes }];
  }
  if (kind === CRASH_KINDS.abrupt || kind === CRASH_KINDS.beforeBarrier) {
    // `lost-handle` est exactement la sémantique d'un arrêt brutal vu du backend : l'opération
    // visée n'a pas lieu, et plus aucune ne sera acceptée. Le support ne répond plus.
    return [{ kind: FAULT_KINDS.lostHandle, operation, occurrence }];
  }
  throw new Error(`Genre de coupure inconnu : ${kind}`);
}

/**
 * Arme l'injecteur : rend le `FaultPlan` qui exécutera le point. C'est l'unique porte, et elle est
 * GARDÉE — voir `crash-harness.mjs`. Aucun chemin du produit ne l'ouvre.
 *
 * @param {CrashPoint} point
 * @param {{ jeton?: string }} [options] jeton du harnais, exigé dans un Worker de navigateur
 */
export function armerInjecteur(point, { jeton } = {}) {
  exigerHarnaisResilience({ jeton });
  return createFaultPlan(pointEnFautes(point));
}

/** Description courte et stable d'un point, pour un compte rendu ou un message d'échec. */
export function decrirePoint(point) {
  const octets =
    point.bytes === null || point.bytes === undefined ? "" : ` (${point.bytes} octets)`;
  return `graine ${point.graine}, point ${point.index} : ${point.kind} sur ${point.operation}#${point.occurrence}${octets}`;
}
