// Contrôle préalable du runtime (#52). Il répond à UNE question avant que v86 ne soit construit :
// cet environnement peut-il faire battre l'émulateur ? Et, si non, POURQUOI — par un code de
// `runtime-errors.mjs`, jamais par un silence ni par un repli.
//
// Tout ce qu'il observe lui est INJECTÉ. C'est ce qui le rend vérifiable sous Node, sans navigateur
// et sans CSP : les cas « marqueur d'URL absent », « `scheduler.postTask` absent », « Worker
// imbriqué muet » et « WebAssembly refusé » sont des combinaisons d'entrées, pas des accidents à
// reproduire.

import { schedulingUnavailable, wasmRefused, workerRefused } from "./runtime-errors.mjs";

/**
 * Marqueur que v86 cherche dans `location.href` pour retenir `scheduler.postTask`. Le test amont
 * est une recherche de SOUS-CHAÎNE sur l'URL entière, pas la lecture d'un paramètre de requête.
 */
export const MARQUEUR_ORDONNANCEMENT = "use-scheduling-api";

export const CHEMINS_ORDONNANCEMENT = Object.freeze({
  postTask: "scheduler.postTask",
  workerBlob: "worker-imbrique-blob",
});

/**
 * Chemin d'ordonnancement que v86 retiendra, déduit des MÊMES conditions que son module — lesquelles
 * sont évaluées une seule fois, à l'import de `libv86.mjs`, et ne sont plus révisées ensuite :
 *
 *   scheduler.postTask est une fonction ET location.href contient « use-scheduling-api »
 *     → boucle `scheduler.postTask`
 *   sinon, Worker existe → Worker imbriqué créé depuis une URL `blob:`
 *
 * @param {{ href: string, scheduler?: { postTask?: unknown } | null }} contexte
 */
export function cheminOrdonnancement({ href, scheduler }) {
  const postTaskDisponible = typeof scheduler?.postTask === "function";
  const marqueurPresent = href.includes(MARQUEUR_ORDONNANCEMENT);
  if (postTaskDisponible && marqueurPresent) return CHEMINS_ORDONNANCEMENT.postTask;
  return CHEMINS_ORDONNANCEMENT.workerBlob;
}

/** Pourquoi la boucle `scheduler.postTask` n'a pas été retenue. Les deux raisons sont distinctes. */
function raisonDuRepli({ scheduler }) {
  if (typeof scheduler?.postTask !== "function") {
    return "« scheduler.postTask » est absent de ce moteur";
  }
  return `l'URL du contexte ne contient pas « ${MARQUEUR_ORDONNANCEMENT} »`;
}

/**
 * Contrôle préalable complet. Rend `null` quand l'environnement peut faire battre l'émulateur, et
 * une `RuntimeError` sinon. Il ne lève pas : l'appelant décide s'il refuse ou s'il rapporte.
 *
 * @param {{
 *   href: string,
 *   scheduler?: { postTask?: unknown } | null,
 *   instancierWasm: () => Promise<unknown>,
 *   sonderWorkerBlob: () => Promise<string>,
 *   workerDisponible?: boolean,
 * }} environnement
 *   `sonderWorkerBlob` rend « vivant » quand un Worker créé depuis une URL `blob:` a répondu, et
 *   toute autre chaîne pour décrire ce qui a été observé à sa place.
 * @returns {Promise<import("./runtime-errors.mjs").RuntimeError | null>}
 */
export async function controlerRuntime({
  href,
  scheduler,
  instancierWasm,
  sonderWorkerBlob,
  workerDisponible = true,
}) {
  // WebAssembly d'abord : c'est la condition la plus basse, et son refus rendrait toute mesure
  // d'ordonnancement sans objet.
  try {
    await instancierWasm();
  } catch (erreur) {
    return wasmRefused(`${erreur.name}: ${erreur.message}`.slice(0, 200));
  }

  if (cheminOrdonnancement({ href, scheduler }) === CHEMINS_ORDONNANCEMENT.postTask) return null;

  const raison = raisonDuRepli({ href, scheduler });
  if (!workerDisponible) {
    return schedulingUnavailable({
      raison,
      observation: "« Worker » n'existe pas dans ce contexte",
    });
  }

  // La seule observation fiable du refus : le SIGNE DE VIE. Sous `worker-src 'self'`, Chromium ne
  // lève aucune exception à la construction d'un Worker `blob:` — il rend un objet qui ne fait rien.
  // Un `try/catch` conclurait donc « autorisé » sur un Worker mort.
  const observation = await sonderWorkerBlob();
  if (observation === "vivant") return null;
  return workerRefused({ raison, observation });
}
