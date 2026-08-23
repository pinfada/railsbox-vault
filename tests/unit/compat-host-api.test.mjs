import assert from "node:assert/strict";
import test from "node:test";

import {
  detectPlatformAuthenticatorPresence,
  detectPublicKeyCredential,
  isConstructorLike,
} from "../../src/compat/host-api.mjs";
import { measureCapability } from "../../src/compat/probe-runner.mjs";

/** Forme observée sous Playwright WebKit 26.5 : l'objet d'interface n'est pas une fonction. */
const WEBKIT_HOST = Object.freeze({
  PublicKeyCredential: Object.freeze({
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false),
  }),
});

/** Forme observée sous Chromium et Firefox : l'objet d'interface est un constructeur. */
function chromiumHost() {
  class PublicKeyCredential {}
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
  return { PublicKeyCredential };
}

test("isConstructorLike accepte une fonction comme un objet d'interface non nul", () => {
  assert.equal(
    isConstructorLike(function Interface() {}),
    true,
  );
  assert.equal(isConstructorLike({}), true);
  assert.equal(isConstructorLike(null), false);
  assert.equal(isConstructorLike(undefined), false);
  assert.equal(isConstructorLike("PublicKeyCredential"), false);
  assert.equal(isConstructorLike(0), false);
});

test("PublicKeyCredential exposé comme objet hôte est détecté comme présent", () => {
  const detail = detectPublicKeyCredential(WEBKIT_HOST);

  assert.match(detail, /PublicKeyCredential/);
  assert.match(detail, /objet/);
});

test("PublicKeyCredential exposé comme constructeur est détecté comme présent", () => {
  const detail = detectPublicKeyCredential(chromiumHost());

  assert.match(detail, /fonction/);
});

test("PublicKeyCredential réellement absent reste une capacité non supportée", () => {
  assert.throws(() => detectPublicKeyCredential({}), /n'est pas exposé/);
  assert.throws(() => detectPublicKeyCredential({ PublicKeyCredential: null }), /n'est pas exposé/);
  assert.throws(() => detectPublicKeyCredential(undefined), /n'est pas exposé/);
});

test("la présence de l'authentificateur de plateforme est détectée sur un objet hôte", () => {
  const detail = detectPlatformAuthenticatorPresence(WEBKIT_HOST);

  assert.match(detail, /isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(detail, /non appelée/);
});

test("la présence de l'authentificateur de plateforme est détectée sur un constructeur", () => {
  assert.match(
    detectPlatformAuthenticatorPresence(chromiumHost()),
    /isUserVerifyingPlatformAuthenticatorAvailable/,
  );
});

test("un PublicKeyCredential sans isUserVerifyingPlatformAuthenticatorAvailable est non supporté", () => {
  assert.throws(
    () => detectPlatformAuthenticatorPresence({ PublicKeyCredential: {} }),
    /isUserVerifyingPlatformAuthenticatorAvailable/,
  );
});

test("un hôte de type WebKit produit le verdict supported, pas unsupported", async () => {
  const credential = await measureCapability({
    id: "publicKeyCredential",
    context: "page",
    run: async () => detectPublicKeyCredential(WEBKIT_HOST),
  });
  const authenticator = await measureCapability({
    id: "platformAuthenticatorPresence",
    context: "page",
    run: async () => detectPlatformAuthenticatorPresence(WEBKIT_HOST),
  });

  assert.equal(credential.verdict, "supported");
  assert.equal(authenticator.verdict, "supported");
});
