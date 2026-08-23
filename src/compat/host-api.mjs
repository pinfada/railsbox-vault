/**
 * Détection des objets d'interface exposés par l'hôte, isolée du navigateur pour rester testable
 * sous Node.
 *
 * Un objet d'interface n'est pas toujours une fonction. WebKit expose `PublicKeyCredential` comme
 * un objet ordinaire : le tester avec `typeof === "function"` produit un faux négatif et publie une
 * capacité absente alors qu'elle est présente. La règle retenue distingue donc :
 *
 * - un **objet d'interface** (`Worker`, `SharedArrayBuffer`, `PublicKeyCredential`…) : accepté s'il
 *   est une fonction **ou** un objet non nul, puis réellement utilisé par la mesure ;
 * - une **méthode** (`navigator.storage.estimate`, `navigator.locks.request`…) : elle doit être
 *   appelable, donc `typeof === "function"` reste la bonne vérification.
 */

import { MissingCapabilityError } from "./probe-runner.mjs";

/** Vrai si la valeur peut être un objet d'interface exposé par l'hôte. */
export function isConstructorLike(value) {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

function describeShape(value) {
  return typeof value === "function" ? "fonction" : "objet";
}

function requirePublicKeyCredential(host) {
  const api = host?.PublicKeyCredential;
  if (!isConstructorLike(api)) {
    throw new MissingCapabilityError(`PublicKeyCredential n'est pas exposé (typeof ${typeof api})`);
  }
  return api;
}

export function detectPublicKeyCredential(host) {
  const api = requirePublicKeyCredential(host);
  return `PublicKeyCredential exposé comme ${describeShape(api)} ; aucune cérémonie WebAuthn exécutée`;
}

export function detectPlatformAuthenticatorPresence(host) {
  const api = requirePublicKeyCredential(host);
  if (typeof api.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
    throw new MissingCapabilityError(
      "isUserVerifyingPlatformAuthenticatorAvailable n'est pas appelable",
    );
  }
  return "isUserVerifyingPlatformAuthenticatorAvailable présente ; volontairement non appelée pour éviter toute cérémonie";
}
