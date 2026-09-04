/**
 * Le dérivateur `phrase` : Argon2id RFC 9106 par l'artefact WebAssembly VENDU (#22, ADR 0021).
 *
 * Ce que cette suite établit, dans cet ordre :
 *
 *  1. **l'artefact vendu calcule bien Argon2** — les trois vecteurs de la RFC 9106 (§ 5.1 Argon2d,
 *    § 5.2 Argon2i, § 5.3 Argon2id) sont rejoués OCTET POUR OCTET par le binaire du dépôt. Sans
 *    cela, tout le reste mesurerait la conformité d'une fonction inconnue à elle-même ;
 *  2. **l'empreinte de l'artefact est vérifiée AVANT instanciation** — un octet retourné dans le
 *    binaire fait tomber un refus typé, jamais un hachage silencieusement différent ;
 *  3. **le coût reste entre le plancher de la RFC et le plafond** — des paramètres publics moins
 *    chers, comme des paramètres démesurés, sont refusés, y compris quand ils viennent du fichier
 *    d'enveloppes, et CHAMP PAR CHAMP ;
 *  4. **la phrase est normalisée en NFC, et c'est écrit** — deux écritures Unicode de la même
 *    phrase rendent la même KEK, et un vecteur FIGÉ dit laquelle des quatre formes est appliquée ;
 *  4 bis. **rien du secret ne survit là où on peut le regarder** — le tas du module WebAssembly est
 *    sondé après un hachage, et la base64 de l'étiquette Argon2id doit en être absente ;
 *  5. **la dérivation ouvre une enveloppe RÉELLE**, et une mauvaise phrase rend
 *    `VAULT_ENVELOPPE_CLE_REFUSEE` — le refus de l'ENVELOPPE, pas un refus du dérivateur : un
 *    dérivateur ne sait pas, et ne peut pas savoir, qu'une phrase est fausse.
 *
 * Le coût est réel : chaque dérivation calibrée paie les 64 Mio et les trois passes de la RFC. Les
 * épreuves qui n'ont pas besoin d'une KEK vraie s'en passent, et les autres en font le moins
 * possible.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARGON2_ARTEFACT_OCTETS,
  ARGON2_ARTEFACT_SHA256,
  argon2Vendu,
} from "../../src/vm/derivation/argon2-vendu.mjs";
import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import {
  CALIBRATION_PHRASE,
  PLAFOND_ADMISSIBLE,
  PLANCHER_RFC9106,
  derivateurPhrase,
  parametresDePhrase,
} from "../../src/vm/derivation/derivateur-phrase.mjs";
import { preparerEmplacementDerive } from "../../src/vm/derivation/emplacement-derive.mjs";
import { encoderParametresPublics } from "../../src/vm/derivation/parametres-publics.mjs";
import { creerEnveloppe, ouvrirEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { identifiantDeVolume, supportDouble, suiteDOctets } from "./support-enveloppe-double.mjs";

const ARTEFACT = new Uint8Array(
  await readFile(new URL("../../vendor/argon2/argon2.wasm", import.meta.url)),
);
const VECTEURS = JSON.parse(
  await readFile(new URL("../vectors/derivation-v1.json", import.meta.url), "utf8"),
);

/** Sous Node il n'y a pas de `fetch` vers `/vendor/` : l'artefact est lu sur le disque. */
const chargerArtefact = async () => ARTEFACT;
const argon2 = () => argon2Vendu({ chargerArtefact });

const VOLUME = identifiantDeVolume(0x30);
const SEL = octetsEnHex(suiteDOctets(0x0e, 16));
const PARAMETRES = () => parametresDePhrase({ sel: SEL, ...CALIBRATION_PHRASE });

/** Un appel Argon2 minimal, employé par les épreuves qui mesurent le REFUS et non le calcul. */
const APPEL_MINIMAL = Object.freeze({
  variante: "id",
  mot: new Uint8Array(8),
  sel: new Uint8Array(16),
  memoireKio: 32,
  iterations: 1,
  parallelisme: 1,
  longueur: 32,
});

test("l'artefact vendu est celui que le manifeste épingle : taille et empreinte", async () => {
  assert.equal(ARTEFACT.byteLength, ARGON2_ARTEFACT_OCTETS);
  const empreinte = new Uint8Array(await crypto.subtle.digest("SHA-256", ARTEFACT));
  assert.equal(octetsEnHex(empreinte), ARGON2_ARTEFACT_SHA256);
});

test("les vecteurs REJOUABLES de la RFC 9106 le sont par l'artefact vendu", async () => {
  const moteur = argon2();
  assert.equal(VECTEURS.argon2Rfc9106.length, 3, "la RFC 9106 en publie trois : d, i et id");
  const rejoues = VECTEURS.argon2Rfc9106.filter((cas) => cas.rejoue);
  assert.equal(rejoues.length, 2, "Argon2d et Argon2id sont rejoués ; Argon2i porte son motif");
  for (const cas of rejoues) {
    const obtenu = await moteur.hacher({
      variante: cas.variante,
      mot: hexEnOctets(cas.motDePasseHex),
      sel: hexEnOctets(cas.selHex),
      secret: hexEnOctets(cas.secretHex),
      donneesAssociees: hexEnOctets(cas.donneesAssocieesHex),
      memoireKio: cas.memoireKio,
      iterations: cas.iterations,
      parallelisme: cas.parallelisme,
      longueur: cas.longueur,
    });
    assert.equal(
      octetsEnHex(obtenu),
      cas.empreinteHex,
      `RFC 9106 § ${cas.section} (Argon2${cas.variante})`,
    );
  }
});

test("le vecteur NON rejoué porte son motif, et sa variante est refusée par le moteur", async () => {
  const ecarte = VECTEURS.argon2Rfc9106.filter((cas) => !cas.rejoue);
  assert.equal(ecarte.length, 1);
  assert.equal(ecarte[0].variante, "i");
  assert.match(
    ecarte[0].motif,
    /14,9 s/,
    "un vecteur écarté sans mesure écrite serait un vecteur passé sous silence",
  );
  // Le moteur REFUSE la variante plutôt que de la servir lentement : un chemin qui gèle l'onglet
  // vaut moins qu'un refus, et l'écart est mesuré, pas soupçonné.
  await assert.rejects(
    () => argon2().hacher({ ...APPEL_MINIMAL, variante: "i" }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.argon2Indisponible),
  );
});

/**
 * Capture l'instance WebAssembly que le moteur instancie, pour pouvoir SONDER son tas.
 *
 * Le moteur ne rend que `hacher` — c'est délibéré, son tas n'est l'affaire de personne. La sonde
 * passe donc par le seul point de passage obligé, `WebAssembly.instantiate`, et le rend intact.
 */
async function avecTasCapture(geste) {
  const original = WebAssembly.instantiate;
  let instance = null;
  WebAssembly.instantiate = async (...parametres) => {
    const produit = await original.apply(WebAssembly, parametres);
    instance = produit.instance ?? produit;
    return produit;
  };
  try {
    const rendu = await geste();
    return { rendu, tas: new Uint8Array(instance.exports.c.buffer) };
  } finally {
    WebAssembly.instantiate = original;
  }
}

/** Cherche une suite d'octets ASCII dans un tas. `Buffer.indexOf` évite un balayage en JavaScript. */
function contientTexte(octets, texte) {
  const vue = Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength);
  return vue.indexOf(texte, 0, "latin1") !== -1;
}

/** La base64 sans remplissage, celle qu'`argon2_encode_string` écrit dans la chaîne PHC. */
function base64SansRemplissage(octets) {
  return btoa(String.fromCharCode(...octets)).replace(/=+$/, "");
}

test("l'étiquette Argon2 n'est jamais ENCODÉE : sa base64 ne survit pas dans le tas WebAssembly", async () => {
  // Ce que cette épreuve mesure est une SURVIE, pas une propriété d'algorithme. Le module de
  // référence sait écrire une chaîne PHC — « $argon2id$v=19$m=…$<sel>$<étiquette> » — dans un
  // tampon que l'appelant lui fournit, et cette étiquette-là EST le matériau remis à HKDF, en
  // base64. Ce tampon n'était pas mis à zéro : la base64 restait dans le tas du module, qui est un
  // singleton dont la mémoire vit aussi longtemps que le Worker, jusqu'à ce qu'un allocataire
  // suivant repasse dessus. Le remède n'est pas de l'effacer mieux, c'est de ne PAS le demander :
  // l'implémentation de référence teste `if (encoded && encodedlen)`, et un pointeur NUL lui fait
  // sauter tout l'encodage. Le produit n'a jamais eu l'emploi de cette chaîne.
  const moteur = argon2();
  const { rendu, tas } = await avecTasCapture(() => moteur.hacher(APPEL_MINIMAL));
  const base64 = base64SansRemplissage(rendu);

  // TÉMOIN : la sonde sait trouver ce qu'elle cherche. Une sonde cassée passerait sans lui.
  assert.ok(
    contientTexte(new TextEncoder().encode(`préfixe${base64}suffixe`), base64),
    "la sonde ne retrouve pas la base64 dans un tampon qui la contient : elle ne prouve rien",
  );
  assert.equal(
    contientTexte(tas, base64),
    false,
    "la base64 de l'étiquette Argon2id — le matériau remis à HKDF — est restée dans le tas du module",
  );
});

test("un artefact dont l'empreinte diffère d'un bit est REFUSÉ avant d'être instancié", async () => {
  const altere = ARTEFACT.slice();
  altere[altere.byteLength - 1] ^= 0x01;
  const moteur = argon2Vendu({ chargerArtefact: async () => altere });
  await assert.rejects(
    () => moteur.hacher(APPEL_MINIMAL),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.argon2Indisponible),
  );
  // Témoin : le MÊME appel passe sur l'artefact intact. Sans lui, un refus systématique suffirait.
  assert.ok(await argon2().hacher(APPEL_MINIMAL));
});

test("un artefact TRONQUÉ est refusé en NOMMANT la taille, pas seulement l'empreinte", async () => {
  // Ajoutée par la campagne de mutation : retirer le contrôle de taille ne tuait rien, puisqu'un
  // artefact plus court a de toute façon une autre empreinte. Ce que ce contrôle achète n'est donc
  // pas une sécurité de plus — c'est un DIAGNOSTIC : « il en manque des octets » envoie vérifier un
  // déploiement, « l'empreinte ne correspond pas » envoie soupçonner une substitution.
  const tronque = ARTEFACT.slice(0, ARTEFACT.byteLength - 16);
  const moteur = argon2Vendu({ chargerArtefact: async () => tronque });
  await assert.rejects(
    () => moteur.hacher(APPEL_MINIMAL),
    (erreur) =>
      isDerivationError(erreur, DERIVATION_ERROR_CODES.argon2Indisponible) &&
      erreur.context.attendu === ARGON2_ARTEFACT_OCTETS &&
      erreur.context.mesure === tronque.byteLength,
  );
});

test("un artefact absent rend un refus TYPÉ, jamais un repli sur une dérivation moins chère", async () => {
  const moteur = argon2Vendu({
    chargerArtefact: async () => {
      throw new Error("404");
    },
  });
  await assert.rejects(
    () => moteur.hacher(APPEL_MINIMAL),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.argon2Indisponible),
  );
});

test("la calibration retenue ne descend jamais sous le plancher de la RFC 9106", () => {
  assert.ok(CALIBRATION_PHRASE.memoireKio >= PLANCHER_RFC9106.memoireKio);
  assert.ok(CALIBRATION_PHRASE.iterations >= PLANCHER_RFC9106.iterations);
  assert.ok(CALIBRATION_PHRASE.parallelisme >= PLANCHER_RFC9106.parallelisme);
  // Le plancher EST la deuxième option recommandée par la RFC 9106 § 4 : 64 Mio, trois passes,
  // quatre voies. Le dépôt ne s'invente pas un plancher plus bas au motif d'aller plus vite.
  assert.deepEqual(
    {
      memoireKio: PLANCHER_RFC9106.memoireKio,
      iterations: PLANCHER_RFC9106.iterations,
      parallelisme: PLANCHER_RFC9106.parallelisme,
      version: PLANCHER_RFC9106.version,
    },
    { memoireKio: 65536, iterations: 3, parallelisme: 4, version: 0x13 },
  );
});

/**
 * Les mutations de COÛT qu'aucun des deux côtés ne doit accepter, prises UNE À LA FOIS.
 *
 * Une à la fois, et c'est le sujet. L'épreuve de lecture mettait les trois champs hors bornes d'un
 * seul coup : retirer `parallelisme` ou `iterations` de la liste que parcourt la garde la laissait
 * verte, puisque `memoireKio` suffisait à faire tomber le refus. Chaque champ porte donc sa propre
 * mutation, des deux côtés, et le plafond comme le plancher.
 */
const COUTS_HORS_BORNES = Object.freeze([
  ["moins de mémoire", { memoireKio: PLANCHER_RFC9106.memoireKio - 1024 }],
  ["moins d'itérations", { iterations: PLANCHER_RFC9106.iterations - 1 }],
  ["moins de voies", { parallelisme: PLANCHER_RFC9106.parallelisme - 1 }],
  ["plus de mémoire que le plafond", { memoireKio: PLAFOND_ADMISSIBLE.memoireKio + 1024 }],
  ["plus d'itérations que le plafond", { iterations: PLAFOND_ADMISSIBLE.iterations + 1 }],
  ["plus de voies que le plafond", { parallelisme: PLAFOND_ADMISSIBLE.parallelisme + 1 }],
]);

/**
 * Les paramètres calibrés, avec un SEL de huit octets — un encodage que l'écriture refuse de
 * produire, et qu'il faut donc poser à la main pour éprouver le côté LECTURE.
 */
function parametresAuSelCourt() {
  const complets = PARAMETRES();
  const fin = complets.byteLength;
  const court = new Uint8Array(fin - 8);
  court.set(complets.subarray(0, fin - 18), 0);
  court.set(Uint8Array.of(0, 8), fin - 18);
  court.set(complets.subarray(fin - 16, fin - 8), fin - 16);
  return court;
}

test("des paramètres publics hors des bornes sont refusés à l'ÉCRITURE, les calibrés passent", () => {
  assert.ok(PARAMETRES() instanceof Uint8Array);
  for (const [nom, mutation] of [
    ...COUTS_HORS_BORNES,
    ["sel trop court", { sel: octetsEnHex(suiteDOctets(0x0e, 8)) }],
  ]) {
    assert.throws(
      () => parametresDePhrase({ sel: SEL, ...CALIBRATION_PHRASE, ...mutation }),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
      `« ${nom} » aurait dû être refusé`,
    );
  }
});

test("des paramètres hors des bornes lus dans le fichier sont refusés AVANT toute dérivation", async () => {
  // Ajoutée par la campagne de mutation : le plancher n'était éprouvé qu'à l'ÉCRITURE, si bien que
  // retirer sa vérification à la LECTURE ne tuait rien. C'est pourtant le côté qui compte : ces
  // octets viennent d'un fichier, et l'attaque que l'ADR 0020 nomme est exactement celle-là — un
  // adversaire qui ramène le coût à rien, laisse l'utilisateur taper la même phrase, et garde une
  // copie du volume qu'il cassera hors ligne pour trois fois rien. Le PLAFOND ferme l'attaque
  // symétrique, qui n'était pas fermée : le même adversaire écrit un coût démesuré et le Worker de
  // confiance part calculer pendant des heures à chaque tentative de déverrouillage.
  const derivateur = derivateurPhrase({ argon2: argon2() });
  const identite = { identifiantVolume: VOLUME, identifiantEmplacement: "7071727374757677" };
  const geste = { phrase: "peu importe" };
  const mutes = [
    ...COUTS_HORS_BORNES.map(([nom, mutation]) => [
      nom,
      encoderParametresPublics(TYPES_KEK.phrase, {
        version: 0x13,
        variante: 2,
        ...CALIBRATION_PHRASE,
        ...mutation,
        sel: SEL,
      }),
    ]),
    ["sel trop court", parametresAuSelCourt()],
  ];
  for (const [nom, parametres] of mutes) {
    await assert.rejects(
      () => derivateur.deriver({ parametres, identite, geste }),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
      `« ${nom} », lu dans le fichier, aurait dû être refusé`,
    );
  }
  // Témoin : les MÊMES octets, au coût calibré, se dérivent bien. Le refus porte sur le coût, pas
  // sur l'encodage.
  assert.ok(await derivateur.deriver({ parametres: PARAMETRES(), identite, geste }));
});

test("une variante autre qu'Argon2id, lue dans le fichier, est refusée", async () => {
  const argon2d = encoderParametresPublics(TYPES_KEK.phrase, {
    version: 0x13,
    variante: 0,
    ...CALIBRATION_PHRASE,
    sel: SEL,
  });
  await assert.rejects(
    () =>
      derivateurPhrase({ argon2: argon2() }).deriver({
        parametres: argon2d,
        identite: { identifiantVolume: VOLUME, identifiantEmplacement: "7071727374757677" },
        geste: { phrase: "peu importe" },
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
  );
});

test("une phrase vide, ou qui n'est pas une chaîne, est refusée par un code distinct", async () => {
  const derivateur = derivateurPhrase({ argon2: argon2() });
  const identite = { identifiantVolume: VOLUME, identifiantEmplacement: "7071727374757677" };
  for (const phrase of ["", "   ", null, undefined, 42]) {
    await assert.rejects(
      () => derivateur.deriver({ parametres: PARAMETRES(), identite, geste: { phrase } }),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.phraseRefusee),
      `la phrase ${JSON.stringify(phrase)} aurait dû être refusée`,
    );
  }
});

test("la NFC est APPLIQUÉE : deux écritures Unicode de la même phrase rendent la même KEK", async () => {
  const derivateur = derivateurPhrase({ argon2: argon2() });
  const identite = { identifiantVolume: VOLUME, identifiantEmplacement: "7071727374757677" };
  // « é » précomposé (U+00E9) à l'enregistrement, décomposé (U+0065 U+0301) au déverrouillage.
  const composee = "phrase de déverrouillage";
  const decomposee = "phrase de déverrouillage";
  assert.notEqual(composee, decomposee, "les deux écritures sont déjà identiques : rien à mesurer");
  assert.equal(composee.normalize("NFC"), decomposee.normalize("NFC"));

  const premiere = await derivateur.deriver({
    parametres: PARAMETRES(),
    identite,
    geste: { phrase: composee },
  });
  const seconde = await derivateur.deriver({
    parametres: PARAMETRES(),
    identite,
    geste: { phrase: decomposee },
  });

  // Les deux KEK sont non extractibles : leur égalité se mesure en scellant sous l'une et en
  // ouvrant sous l'autre, jamais en comparant des octets que WebCrypto ne rend pas.
  const nonce = suiteDOctets(0x77, 12);
  const clair = new TextEncoder().encode("NFC");
  const scelle = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, premiere, clair);
  const ouvert = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, seconde, scelle);
  assert.deepEqual(new Uint8Array(ouvert), clair);
});

test("une phrase juste ouvre l'enveloppe, une fausse rend VAULT_ENVELOPPE_CLE_REFUSEE", async () => {
  const derivateur = derivateurPhrase({ argon2: argon2() });
  const support = supportDouble();
  const dek = suiteDOctets(0x40, 32);
  const phrase = "correcte cheval batterie agrafe";

  const prepare = await preparerEmplacementDerive({
    identifiantVolume: VOLUME,
    derivateur,
    parametres: PARAMETRES(),
    geste: { phrase },
  });
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek: prepare.kek,
    typeKek: TYPES_KEK.phrase,
    parametres: prepare.parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });

  const identite = {
    identifiantVolume: VOLUME,
    identifiantEmplacement: prepare.identifiantEmplacement,
  };
  const juste = await derivateur.deriver({ parametres: PARAMETRES(), identite, geste: { phrase } });
  const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: juste });
  assert.deepEqual(ouverte.dek, dek, "la DEK développée n'est pas celle qui a été enveloppée");

  const fausse = await derivateur.deriver({
    parametres: PARAMETRES(),
    identite,
    geste: { phrase: `${phrase}s` },
  });
  await assert.rejects(
    () => ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: fausse }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
    "une mauvaise phrase doit rendre le refus de l'ENVELOPPE, pas un refus du dérivateur",
  );
});

/** Un double d'Argon2 qui JOURNALISE ses appels : ce qui se mesure ici est l'ordre, pas le calcul. */
function argon2Journalise() {
  const journal = [];
  return {
    journal,
    hacher: async (appel) => {
      // La copie est prise ici : `derivateurPhrase` efface `appel.mot` dès que la clé existe.
      journal.push({ ...appel, mot: Uint8Array.from(appel.mot) });
      return new Uint8Array(32);
    },
  };
}

test("le vecteur NFC est REJOUÉ : la phrase normalisée est celle qui est FIGÉE", async () => {
  // L'épreuve voisine — « deux écritures Unicode rendent la même KEK » — passe à l'identique sous
  // NFC, NFD, NFKC et NFKD : les quatre font converger deux écritures d'un « é ». Elle ne fige donc
  // AUCUNE forme. Ce vecteur-ci en fige une, sur une phrase portant une ligature (U+FB01) et un
  // caractère pleine chasse (U+FF21) : NFKC et NFKD les défont, c'est-à-dire qu'elles changent le
  // secret, et un coffre fermé avant un tel changement ne se rouvrirait plus.
  const cas = VECTEURS.nfc;
  const saisie = String.fromCodePoint(...cas.pointsSaisis);
  const argon2Double = argon2Journalise();
  const identite = { identifiantVolume: VOLUME, identifiantEmplacement: "7071727374757677" };

  await derivateurPhrase({ argon2: argon2Double }).deriver({
    parametres: PARAMETRES(),
    identite,
    geste: { phrase: saisie },
  });

  const mot = argon2Double.journal[0].mot;
  assert.equal(octetsEnHex(mot), cas.phraseNfcHex, "les octets étirés ne sont pas la forme figée");
  const empreinte = new Uint8Array(await crypto.subtle.digest("SHA-256", mot));
  assert.equal(octetsEnHex(empreinte), cas.empreinteHex);
  assert.equal(saisie.normalize("NFC"), String.fromCodePoint(...cas.pointsNfc));

  // Ce qui rend le vecteur DISCRIMINANT : une compatibilité rendrait d'autres octets. Sans cette
  // ligne, un vecteur figé sur une phrase ASCII ne contraindrait rien.
  for (const forme of ["NFKC", "NFKD"]) {
    assert.notEqual(
      octetsEnHex(new TextEncoder().encode(saisie.normalize(forme))),
      cas.phraseNfcHex,
      `${forme} rend les mêmes octets que NFC : ce vecteur ne fige aucune forme`,
    );
  }
});

test("une identité malformée refuse AVANT de payer un étirement de phrase", async () => {
  // L'identifiant vient du MANIFESTE, donc d'un fichier. Tant que son refus tombait après Argon2,
  // il tombait sur un étirement déjà calculé — et que personne n'effaçait ensuite, puisque le
  // `finally` du dérivateur ne couvre que la phrase.
  const argon2Double = argon2Journalise();
  await assert.rejects(() =>
    derivateurPhrase({ argon2: argon2Double }).deriver({
      parametres: PARAMETRES(),
      identite: {
        identifiantVolume: "pas-un-identifiant",
        identifiantEmplacement: "7071727374757677",
      },
      geste: { phrase: "peu importe" },
    }),
  );
  assert.deepEqual(argon2Double.journal, [], "un étirement a été payé pour rien");
});
