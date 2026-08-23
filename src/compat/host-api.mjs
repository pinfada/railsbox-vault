/**
 * Détection des objets d'interface exposés par l'hôte, isolée du navigateur pour être testable
 * sous Node. Extrait tel quel de `page-probe.mjs` : le comportement n'est pas encore corrigé.
 */

import { MissingCapabilityError } from "./probe-runner.mjs";

export function isConstructorLike(value) {
  return typeof value === "function";
}

export function detectPublicKeyCredential(host) {
  const api = host?.PublicKeyCredential;
  if (typeof api !== "function") {
    throw new MissingCapabilityError("PublicKeyCredential n'est pas exposé");
  }
  return "PublicKeyCredential exposé ; aucune cérémonie WebAuthn exécutée";
}

export function detectPlatformAuthenticatorPresence(host) {
  const api = host?.PublicKeyCredential;
  if (typeof api !== "function") {
    throw new MissingCapabilityError("PublicKeyCredential n'est pas exposé");
  }
  if (typeof api.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
    throw new MissingCapabilityError("isUserVerifyingPlatformAuthenticatorAvailable est absent");
  }
  return "fonction présente ; volontairement non appelée pour éviter toute cérémonie";
}
