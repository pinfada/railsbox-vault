import assert from "node:assert/strict";
import test from "node:test";

import { CRYPTO_ERROR_CODES, isCryptoError } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import {
  ALGORITHME,
  BUDGET_SCELLEMENTS_PAR_CLE,
  DOMAINE_BLOC,
  DOMAINE_RACINE,
  GENERATION_MAX,
  NONCE_OCTETS,
  RANG_MAX,
  construireNonce,
  encoderEnteteRacine,
  encoderIdentiteBloc,
  verifierBudgetDeCle,
} from "../../src/vm/format-chiffre/identite-logique.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";

// Construction du NONCE et encodage de l'IDENTITÉ LOGIQUE (#17, ADR 0015).
//
// Ces épreuves portent sur la seule propriété dont la violation est CATASTROPHIQUE plutôt que
// simplement gênante : deux scellements distincts sous une même clé ne doivent jamais partager un
// nonce. Sous AES-GCM, réutiliser un nonce livre le XOR des deux clairs ET la clé d'authentification
// H, donc la capacité de forger des étiquettes (NIST SP 800-38D, annexe A ; attaque dite « forbidden
// attack » de Joux). L'unicité n'est donc pas ici une propriété souhaitable : c'est la condition de
// toutes les autres.
//
// Le piège propre à ce dépôt est nommé dans l'ADR 0014 : le journal de génération admet qu'un MÊME
// bloc soit réécrit plusieurs fois DANS UNE MÊME GÉNÉRATION. Un nonce construit sur (génération,
// adresse) se répéterait donc sur des clairs différents. C'est pourquoi le nonce porte le RANG de
// l'entrée dans le journal, et non l'adresse — l'adresse, elle, est authentifiée par les données
// associées, où l'unicité n'est pas exigée.

/** Espace énuméré : quatre générations consécutives, 256 entrées chacune. */
const GENERATIONS = [0, 1, 2, 3];
const ENTREES_PAR_GENERATION = 256;

/** Huit adresses seulement, pour que chaque bloc soit RÉÉCRIT 32 fois dans une même génération. */
const ADRESSES_DISTINCTES = 8;

function adresseDuRang(rang) {
  return (rang % ADRESSES_DISTINCTES) * 512;
}

test("le nonce fait douze octets et sépare les domaines bloc et racine", () => {
  const bloc = construireNonce({ domaine: DOMAINE_BLOC, generation: 7, rang: 3 });
  const racine = construireNonce({ domaine: DOMAINE_RACINE, generation: 7, rang: 3 });

  assert.equal(bloc.byteLength, NONCE_OCTETS);
  assert.equal(racine.byteLength, NONCE_OCTETS);
  assert.notEqual(octetsEnHex(bloc), octetsEnHex(racine));
  assert.equal(bloc[0], DOMAINE_BLOC);
  assert.equal(racine[0], DOMAINE_RACINE);
});

test("aucune collision de nonce sur un espace représentatif de réécritures et de générations", () => {
  const vus = new Map();
  let attendus = 0;

  for (const generation of GENERATIONS) {
    for (let rang = 0; rang < ENTREES_PAR_GENERATION; rang += 1) {
      // L'adresse VARIE peu et se répète : c'est exactement le cas que l'ADR 0014 autorise.
      const nonce = octetsEnHex(construireNonce({ domaine: DOMAINE_BLOC, generation, rang }));
      const cle = `${generation}/${rang}/${adresseDuRang(rang)}`;
      assert.equal(vus.has(nonce), false, `nonce déjà employé par ${vus.get(nonce)} pour ${cle}`);
      vus.set(nonce, cle);
      attendus += 1;
    }
    // La racine de chaque génération partage la clé : son nonce doit être hors de l'espace des blocs.
    const nonceRacine = octetsEnHex(
      construireNonce({ domaine: DOMAINE_RACINE, generation, rang: generation }),
    );
    assert.equal(
      vus.has(nonceRacine),
      false,
      `la racine de la génération ${generation} collisionne`,
    );
    vus.set(nonceRacine, `racine/${generation}`);
    attendus += 1;
  }

  assert.equal(vus.size, attendus);
  assert.equal(attendus, GENERATIONS.length * (ENTREES_PAR_GENERATION + 1));
});

test("deux adresses voisines au même rang produisent le MÊME nonce : le rang porte l'unicité", () => {
  // Ce n'est pas un défaut, c'est le contrat, et il doit être visible plutôt que supposé : le nonce
  // ne dépend PAS de l'adresse. L'unicité repose donc entièrement sur l'unicité du rang au sein
  // d'une génération — obligation de l'appelant (#18), rendue falsifiable par `scellerRacine`, qui
  // refuse une liste d'entrées dont les rangs ne croissent pas strictement.
  const a = construireNonce({ domaine: DOMAINE_BLOC, generation: 4, rang: 11 });
  const b = construireNonce({ domaine: DOMAINE_BLOC, generation: 4, rang: 11 });
  assert.equal(octetsEnHex(a), octetsEnHex(b));
});

test("les bornes des champs du nonce sont refusées avant de reboucler en silence", () => {
  assert.equal(
    construireNonce({ domaine: DOMAINE_BLOC, generation: GENERATION_MAX, rang: RANG_MAX })
      .byteLength,
    NONCE_OCTETS,
  );

  for (const hors of [
    { domaine: DOMAINE_BLOC, generation: GENERATION_MAX + 1, rang: 0 },
    { domaine: DOMAINE_BLOC, generation: 0, rang: RANG_MAX + 1 },
    { domaine: DOMAINE_BLOC, generation: -1, rang: 0 },
    { domaine: 0x03, generation: 0, rang: 0 },
  ]) {
    assert.throws(
      () => construireNonce(hors),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.malformed),
      `${JSON.stringify(hors)} doit être refusé, jamais tronqué`,
    );
  }
});

test("le budget de scellements par clé refuse AVANT la limite de NIST SP 800-38D", () => {
  assert.equal(BUDGET_SCELLEMENTS_PAR_CLE, 2 ** 32);
  assert.equal(verifierBudgetDeCle(BUDGET_SCELLEMENTS_PAR_CLE - 1), BUDGET_SCELLEMENTS_PAR_CLE - 1);

  for (const atteint of [BUDGET_SCELLEMENTS_PAR_CLE, BUDGET_SCELLEMENTS_PAR_CLE + 1]) {
    assert.throws(
      () => verifierBudgetDeCle(atteint),
      (erreur) => isCryptoError(erreur, CRYPTO_ERROR_CODES.keyBudget),
      `${atteint} scellements doivent être refusés sous cette clé`,
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
  const reference = octetsEnHex(encoderIdentiteBloc(base));

  const variantes = [
    { ...base, volume: "volume-b" },
    { ...base, formatVersion: 4 },
    { ...base, generation: 13 },
    { ...base, rang: 6 },
    { ...base, adresse: 4608 },
    { ...base, longueur: 256 },
  ];
  const rendus = new Set([reference]);
  for (const variante of variantes) {
    const rendu = octetsEnHex(encoderIdentiteBloc(variante));
    assert.equal(rendus.has(rendu), false, `${JSON.stringify(variante)} doit changer les octets`);
    rendus.add(rendu);
  }
});

test("les champs de longueur variable sont préfixés : aucune ambiguïté de concaténation", () => {
  // Le piège classique d'une concaténation non préfixée : deux identités distinctes rendant la même
  // chaîne d'octets. Ici les identifiants « ab » + « c » et « a » + « bc » doivent diverger.
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

test("l'étiquette de domaine et l'algorithme sont dans les données associées", () => {
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
