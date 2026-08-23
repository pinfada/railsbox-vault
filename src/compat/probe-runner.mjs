/**
 * Exécuteur de mesures de la sonde de capacités.
 *
 * Chaque mesure produit un enregistrement typé `{ id, context, verdict, detail }`. Aucune mesure
 * ne peut réussir silencieusement : une capacité absente lève `MissingCapabilityError`, une
 * capacité refusée lève `DeniedCapabilityError`, et toute autre exception devient le verdict
 * `error` accompagné du nom de l'exception. Les détails sont tronqués et aplatis afin de rester
 * lisibles dans un rapport JSON.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DETAIL_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 200;

export class MissingCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "MissingCapabilityError";
  }
}

export class DeniedCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeniedCapabilityError";
  }
}

export class ProbeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeTimeoutError";
  }
}

/** Aplatit, nettoie des caractères de contrôle et tronque un détail destiné au rapport. */
export function condenseDetail(text, maxLength = MAX_DETAIL_LENGTH) {
  const flattened = String(text).replace(/\p{C}/gu, " ").replace(/\s+/gu, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

export function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(message)), timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** Requalifie en refus explicite les rejets d'autorisation émis par le navigateur. */
export function deniedIfRefused(error) {
  const refusals = new Set(["NotAllowedError", "SecurityError"]);
  if (error instanceof DeniedCapabilityError || !refusals.has(error?.name)) {
    return error;
  }
  return new DeniedCapabilityError(`${error.name} : ${error.message}`);
}

function verdictForError(error) {
  if (error instanceof MissingCapabilityError) return "unsupported";
  if (error instanceof DeniedCapabilityError) return "denied";
  return "error";
}

function detailForError(error) {
  if (error instanceof MissingCapabilityError || error instanceof DeniedCapabilityError) {
    return condenseDetail(error.message);
  }
  const name = error?.name ?? "Error";
  const message = condenseDetail(error?.message ?? String(error), MAX_MESSAGE_LENGTH);
  return condenseDetail(`${name} : ${message}`);
}

export async function measureCapability({ id, context, run, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    const detail = await withTimeout(
      Promise.resolve().then(run),
      timeoutMs,
      `délai de ${timeoutMs} ms dépassé pendant la mesure`,
    );
    return {
      id,
      context,
      verdict: "supported",
      detail: condenseDetail(detail ?? "mesure réussie sans détail complémentaire"),
    };
  } catch (error) {
    return { id, context, verdict: verdictForError(error), detail: detailForError(error) };
  }
}

/** Enregistrement d'une capacité qu'il a été impossible de mesurer, jamais un faux succès. */
export function unmeasuredCapability(id, context, detail) {
  return { id, context, verdict: "error", detail: condenseDetail(detail) };
}
