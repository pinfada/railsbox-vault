// Injection déterministe de fautes. `docs/architecture.md` classe l'injection d'erreurs parmi les
// exigences du backend, et `docs/quality-attributes.md` demande que 100 % des points de coupure
// donnent « ancien état, nouvel état ou erreur explicite ». Un plan de fautes est donc une donnée
// versionnable, pas un `Math.random()` : la même graine rejoue la même panne.

export const FAULT_KINDS = Object.freeze({
  /** La lecture rend moins d'octets que demandé. */
  shortRead: "short-read",
  /** L'écriture n'accepte qu'une partie des octets. */
  partialWrite: "partial-write",
  /** La barrière de durabilité échoue. */
  flushFailure: "flush-failure",
  /** Le handle exclusif disparaît : toute opération ultérieure échoue. */
  lostHandle: "lost-handle",
});

const OPERATIONS = Object.freeze(["read", "write", "flush"]);
const KIND_OPERATION = Object.freeze({
  [FAULT_KINDS.shortRead]: "read",
  [FAULT_KINDS.partialWrite]: "write",
  [FAULT_KINDS.flushFailure]: "flush",
  [FAULT_KINDS.lostHandle]: null,
});

/**
 * @typedef {object} FaultSpec
 * @property {string} kind une valeur de `FAULT_KINDS`
 * @property {string} operation `"read" | "write" | "flush"` : opération qui déclenche la faute
 * @property {number} occurrence rang de l'opération concernée, à partir de 1
 * @property {number} [bytes] octets réellement traités pour une lecture courte ou une écriture
 *                            partielle ; par défaut la moitié inférieure, arrondie au bloc.
 */

function validate(spec) {
  if (!Object.values(FAULT_KINDS).includes(spec.kind)) {
    throw new Error(`Type de faute inconnu : ${spec.kind}`);
  }
  if (!OPERATIONS.includes(spec.operation)) {
    throw new Error(`Opération de faute inconnue : ${spec.operation}`);
  }
  const expected = KIND_OPERATION[spec.kind];
  if (expected !== null && expected !== spec.operation) {
    throw new Error(
      `La faute ${spec.kind} ne s'applique qu'à l'opération ${expected}, pas ${spec.operation}.`,
    );
  }
  if (!Number.isInteger(spec.occurrence) || spec.occurrence < 1) {
    throw new Error("Le rang d'occurrence d'une faute est un entier supérieur ou égal à 1.");
  }
  if (spec.bytes !== undefined && (!Number.isInteger(spec.bytes) || spec.bytes < 0)) {
    throw new Error("Le nombre d'octets d'une faute est un entier positif ou nul.");
  }
}

/**
 * Plan de fautes déterministe. Chaque appel à `consume` incrémente le compteur de son opération et
 * rend la faute programmée pour ce rang exact, ou `null`.
 */
export class FaultPlan {
  #specs;
  #counters = { read: 0, write: 0, flush: 0 };
  #fired = [];

  /** @param {readonly FaultSpec[]} specs */
  constructor(specs = []) {
    for (const spec of specs) validate(spec);
    const seen = new Set();
    for (const spec of specs) {
      const key = `${spec.operation}#${spec.occurrence}`;
      if (seen.has(key)) {
        throw new Error(`Deux fautes visent ${key} : le plan serait ambigu.`);
      }
      seen.add(key);
    }
    this.#specs = specs.map((spec) => Object.freeze({ ...spec }));
  }

  /** @param {"read" | "write" | "flush"} operation */
  consume(operation) {
    if (!OPERATIONS.includes(operation)) {
      throw new Error(`Opération inconnue : ${operation}`);
    }
    this.#counters[operation] += 1;
    const occurrence = this.#counters[operation];
    const spec = this.#specs.find(
      (candidate) => candidate.operation === operation && candidate.occurrence === occurrence,
    );
    if (spec) this.#fired.push(Object.freeze({ ...spec, at: occurrence }));
    return spec ?? null;
  }

  /** Fautes réellement déclenchées, dans l'ordre. */
  fired() {
    return Object.freeze([...this.#fired]);
  }

  /** Fautes programmées jamais atteintes : une faute non déclenchée ne prouve rien. */
  unfired() {
    return this.#specs.filter(
      (spec) =>
        !this.#fired.some((fired) => fired.kind === spec.kind && fired.at === spec.occurrence),
    );
  }
}

/** Construit un plan vide ou à partir de spécifications. */
export function createFaultPlan(specs = []) {
  return new FaultPlan(specs);
}
