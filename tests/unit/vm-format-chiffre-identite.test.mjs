import assert from "node:assert/strict";
import test from "node:test";

import { CRYPTO_ERROR_CODES, isCryptoError } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import {
  ALGORITHME,
  BUDGET_SCELLEMENTS_PAR_CLE,
  GENERATION_MAX,
  IDENTIFIANT_VOLUME_OCTETS,
  LIMITE_NIST_INVOCATIONS,
  NONCE_OCTETS,
  RANG_MAX,
  encoderEnteteRacine,
  encoderIdentiteBloc,
  identifiantVolumeEnTexte,
  tirerNonce,
  verifierBudgetDeCle,
  verifierRangsCroissants,
} from "../../src/vm/format-chiffre/identite-logique.mjs";
import { chainePrefixee, concatener, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";

// Nonce, identité logique et bornes (#17, ADR 0015).
//
// Le nonce est TIRÉ AU HASARD, et c'est une correction imposée par une revue : la version
// précédente le dérivait de (génération, rang) en affirmant qu'« une reprise ouvre une génération
// neuve ». `tests/unit/vm-format-chiffre-reprise.test.mjs` rejoue la réfutation sur le magasin réel.
// Ce fichier-ci éprouve ce qui reste vérifiable SANS état : que le tirage ne dérive de rien, que les
// bornes sont refusées plutôt que rebouclées, et que l'encodage de l'identité est injectif.

test("le nonce fait douze octets et ne dérive de RIEN", () => {
  const premier = tirerNonce();
  assert.equal(premier.byteLength, NONCE_OCTETS);
  assert.equal(premier instanceof Uint8Array, true);

  // La propriété qui compte, et celle que la version dérivée n'avait pas : deux tirages successifs
  // sous des paramètres IDENTIQUES — il n'y a d'ailleurs aucun paramètre — diffèrent.
  assert.notEqual(octetsEnHex(premier), octetsEnHex(tirerNonce()));
});

test("aucune collision de nonce sur un espace représentatif de tirages", () => {
  // Quatre mille tirages : la probabilité de collision y est majorée par 4096² / 2^97, soit environ
  // 2^-73. Une collision ici ne serait pas de la malchance, ce serait un générateur cassé.
  const vus = new Set();
  for (let index = 0; index < 4096; index += 1) vus.add(octetsEnHex(tirerNonce()));
  assert.equal(vus.size, 4096);
});

test("le budget de scellements par clé est PLUS SERRÉ que le plafond de NIST, et dit pourquoi", () => {
  assert.equal(LIMITE_NIST_INVOCATIONS, 2 ** 32, "le plafond du § 8.3 est publié tel quel");
  assert.equal(BUDGET_SCELLEMENTS_PAR_CLE, 2 ** 31, "le dépôt retient la moitié");
  assert.ok(
    BUDGET_SCELLEMENTS_PAR_CLE < LIMITE_NIST_INVOCATIONS,
    "le compteur cumulé peut RECULER par retour arrière du support : la marge est délibérée",
  );
  assert.equal(verifierBudgetDeCle(BUDGET_SCELLEMENTS_PAR_CLE - 1), BUDGET_SCELLEMENTS_PAR_CLE - 1);

  for (const atteint of [BUDGET_SCELLEMENTS_PAR_CLE, BUDGET_SCELLEMENTS_PAR_CLE + 1]) {
    assert.throws(
      () => verifierBudgetDeCle(atteint),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.keyBudget),
      `${atteint} scellements doivent être refusés sous cette clé`,
    );
  }
});

test("les bornes des champs d'identité sont refusées avant de reboucler en silence", () => {
  const base = {
    volume: "v",
    formatVersion: 3,
    generation: 1,
    rang: 0,
    adresse: 0,
    longueur: 512,
  };
  assert.ok(
    encoderIdentiteBloc({ ...base, generation: GENERATION_MAX, rang: RANG_MAX }).byteLength > 0,
  );

  for (const hors of [
    { ...base, generation: GENERATION_MAX + 1 },
    { ...base, rang: RANG_MAX + 1 },
    { ...base, generation: -1 },
    { ...base, volume: "" },
  ]) {
    assert.throws(
      () => encoderIdentiteBloc(hors),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.malformed),
      `${JSON.stringify({ generation: hors.generation, rang: hors.rang, volume: hors.volume })} doit être refusé`,
    );
  }
});

test("l'encodage de l'identité d'un bloc est injectif : chaque champ déplace les octets", () => {
  const base = {
    volume: "volume-a",
    formatVersion: 3,
    generation: 12,
    rang: 5,
    adresse: 4096,
    longueur: 512,
  };
  const rendus = new Set([octetsEnHex(encoderIdentiteBloc(base))]);

  for (const variante of [
    { ...base, volume: "volume-b" },
    { ...base, formatVersion: 4 },
    { ...base, generation: 13 },
    { ...base, rang: 6 },
    { ...base, adresse: 4608 },
    { ...base, longueur: 256 },
  ]) {
    const rendu = octetsEnHex(encoderIdentiteBloc(variante));
    assert.equal(rendus.has(rendu), false, `${JSON.stringify(variante)} doit changer les octets`);
    rendus.add(rendu);
  }
});

test("le PRÉFIXE DE LONGUEUR est ce qui rend l'encodage injectif : sans lui, deux identités collisionnent", () => {
  // Épreuve par MUTATION plutôt que par affirmation. Le même encodage, privé de ses préfixes de
  // longueur, confond deux identités distinctes : le domaine perd un caractère au profit du volume.
  // C'est le défaut exact que le préfixe interdit, et le montrer vaut mieux que l'annoncer.
  const encoder = new TextEncoder();
  const sansPrefixe = (gauche, droite) =>
    octetsEnHex(concatener(encoder.encode(gauche), encoder.encode(droite)));
  const avecPrefixe = (gauche, droite) =>
    octetsEnHex(concatener(chainePrefixee(gauche), chainePrefixee(droite)));

  assert.equal(
    sansPrefixe("ab", "c"),
    sansPrefixe("a", "bc"),
    "témoin de la mutation : sans préfixe, deux champs distincts rendent les MÊMES octets",
  );
  assert.notEqual(
    avecPrefixe("ab", "c"),
    avecPrefixe("a", "bc"),
    "avec préfixe, les deux se séparent — c'est ce que l'encodage réel emploie",
  );

  const gauche = encoderIdentiteBloc({
    volume: "ab",
    formatVersion: 3,
    generation: 1,
    rang: 0,
    adresse: 0,
    longueur: 512,
  });
  const droite = encoderIdentiteBloc({
    volume: "a",
    formatVersion: 3,
    generation: 1,
    rang: 0,
    adresse: 0,
    longueur: 512,
  });
  assert.notEqual(octetsEnHex(gauche), octetsEnHex(droite));
  assert.notEqual(gauche.byteLength, droite.byteLength);
});

test("l'étiquette de domaine et l'algorithme sont dans les données associées, jamais dans le nonce", () => {
  const identite = encoderIdentiteBloc({
    volume: "v",
    formatVersion: 3,
    generation: 1,
    rang: 0,
    adresse: 0,
    longueur: 512,
  });
  const entete = encoderEnteteRacine({
    volume: "v",
    formatVersion: 3,
    sequence: 1,
    generation: 1,
    tailleVolume: 16384,
    nombreEntrees: 1,
    longueurCharge: 512,
    scellementsCumules: 2,
  });

  const texte = new TextDecoder().decode(identite);
  const texteRacine = new TextDecoder().decode(entete);
  assert.ok(texte.includes(ALGORITHME), "l'algorithme doit être lié au sceau (agilité)");
  assert.ok(texteRacine.includes(ALGORITHME));
  assert.ok(texte.includes("bloc"), "le domaine doit distinguer un bloc d'une racine");
  assert.ok(texteRacine.includes("racine"));
  assert.notEqual(octetsEnHex(identite), octetsEnHex(entete));
});

test("les rangs d'une génération doivent croître STRICTEMENT : l'ordre est une propriété", () => {
  const entree = (rang) => ({
    adresse: rang * 512,
    longueur: 512,
    rang,
    etiquette: new Uint8Array(16),
  });
  assert.equal(verifierRangsCroissants([entree(0), entree(1), entree(2)]).length, 3);
  assert.equal(verifierRangsCroissants([]).length, 0);

  for (const suite of [
    [entree(0), entree(0)],
    [entree(1), entree(0)],
    [entree(0), entree(2), entree(1)],
  ]) {
    assert.throws(
      () => verifierRangsCroissants(suite),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.orderInvalid),
      `${suite.map((e) => e.rang).join(",")} doit être refusé`,
    );
  }
});

test("la conversion de l'identifiant de volume est FIXÉE : seize octets vers trente-deux caractères", () => {
  // Sans cette règle, #18 ne pourrait pas reproduire les vecteurs : le disque porte seize octets
  // bruts, les données associées portent une chaîne, et deux conventions donneraient deux
  // étiquettes différentes pour le MÊME volume.
  const octets = Uint8Array.from({ length: IDENTIFIANT_VOLUME_OCTETS }, (_, index) => index * 17);
  const texte = identifiantVolumeEnTexte(octets);
  assert.equal(texte.length, IDENTIFIANT_VOLUME_OCTETS * 2);
  assert.equal(texte, texte.toLowerCase());
  assert.equal(texte, "00112233445566778899aabbccddeeff");

  for (const longueur of [0, 8, 15, 17]) {
    assert.throws(
      () => identifiantVolumeEnTexte(new Uint8Array(longueur)),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.malformed),
      `un identifiant de ${longueur} octets doit être refusé`,
    );
  }
});
