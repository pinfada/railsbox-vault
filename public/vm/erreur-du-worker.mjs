// Le message d'une erreur NON RATTRAPÉE d'un Worker de banc (#243).
//
// Un `ErrorEvent` de Worker ne porte pas toujours de message : quand le Worker meurt sans exception
// lisible — mémoire épuisée, processus tué —, `event.message` vaut `undefined`, et les bancs
// publiaient « Erreur du Worker runtime : undefined ». Le relevé de CI ne disait alors rien de la
// cause. Ce module rend un message qui dit toujours quelque chose.
//
// Module SANS DOM ni import : les bancs de `public/vm/` et de `public/spike/` le chargent, et
// `tests/unit/erreur-du-worker.test.mjs` sous Node.

/**
 * @param {string} nom le Worker, tel que le banc le nomme (« runtime », « OPFS »…)
 * @param {{ type?: string, message?: unknown, filename?: unknown, lineno?: unknown, colno?: unknown }
 *   | null | undefined} event l'événement `error` reçu du Worker
 * @returns {string}
 */
export function messageDErreurDuWorker(nom, event) {
  const message = typeof event?.message === "string" ? event.message.trim() : "";
  if (message === "") {
    return (
      `Erreur du Worker ${nom} : erreur du Worker sans message (mort du Worker, mémoire ?)` +
      ` — événement « ${event?.type || "inconnu"} »`
    );
  }
  return `Erreur du Worker ${nom} : ${message}${localisation(event)}`;
}

/** ` (fichier:ligne:colonne)` quand l'événement nomme un fichier, sinon une chaîne vide. */
function localisation(event) {
  if (typeof event?.filename !== "string" || event.filename === "") return "";
  const position = [event.lineno, event.colno].filter((valeur) => Number.isInteger(valeur));
  return ` (${[event.filename, ...position].join(":")})`;
}
