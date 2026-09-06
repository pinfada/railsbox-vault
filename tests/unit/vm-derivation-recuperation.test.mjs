/**
 * Le MOYEN DE RÉCUPÉRATION : un code généré par le produit, rendu une fois (#147, ADR 0025).
 *
 * Ce que cette suite établit, dans cet ordre :
 *
 *  1. **le code porte 128 bits TIRÉS** — seize octets de `crypto.getRandomValues`, mesurés par le
 *    nombre d'octets tirés et non par une « force » qu'on affirmerait ;
 *  2. **sa forme est relue strictement** — vingt-six symboles Crockford pour les 128 bits, deux
 *    bits de bourrage NULS relus comme tels, deux symboles de somme de contrôle, sept groupes de
 *    quatre. Un symbole étranger, une longueur autre, un bourrage non nul sont des refus ;
 *  3. **la somme de contrôle sépare « mal recopié » de « mauvais code »** — elle est vérifiée
 *    AVANT toute dérivation, elle ne dépend que du code, et elle détecte TOUTE substitution d'un
 *    symbole et TOUTE transposition de deux symboles adjacents. Les deux propriétés sont mesurées
 *    EXHAUSTIVEMENT sur des vecteurs figés, pas sur un échantillon ;
 *  4. **la KEK est celle du modèle de référence** — HKDF-SHA-256 sur le SHA-256 des seize octets,
 *    sous le sel de l'emplacement et l'info de l'ADR 0021, sans étirement ;
 *  5. **les trois épreuves de `SEC-RECOVERY-001`** — succès (le code ouvre quand plus rien d'autre
 *    n'ouvre), révocation (le refus est celui d'une clé inconnue, indiscernable), perte définitive
 *    (le dernier emplacement ne se révoque pas, un code faux est refusé, et rien dans le produit ne
 *    conserve le code ni ne sait le régénérer) ;
 *  6. **le code est rendu UNE fois**, après que l'enveloppe a été écrite et sa barrière franchie.
 *
 * Le dérivateur `phrase` n'est pas employé ici : il paierait 64 Mio et trois passes par appel pour
 * une propriété que cette suite ne mesure pas. Un dérivateur d'épreuve déterministe tient sa place,
 * comme dans `vm-derivation-branchement.test.mjs` ; le vrai chemin de bout en bout est celui de
 * `tests/browser/deverrouillage-frontiere.spec.mjs`.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALPHABET_CROCKFORD,
  CODE_OCTETS,
  MODULE_CONTROLE,
  SYMBOLES_CONTROLE,
  SYMBOLES_DONNEES,
  SYMBOLES_PAR_GROUPE,
  SYMBOLES_TOTAL,
  decoderCode,
  encoderCode,
  normaliserSaisie,
  octetsDesSymboles,
  sommeDeControle,
  sommeDeControleValide,
  symbolesDesOctets,
  tirerCodeDeRecuperation,
} from "../../src/vm/derivation/code-de-recuperation.mjs";
import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import {
  RECUPERATION_VERSION,
  derivateurRecuperation,
  materiauDuCode,
  parametresDeRecuperation,
  tirerSelDeRecuperation,
} from "../../src/vm/derivation/derivateur-recuperation.mjs";
import { catalogueDeDerivateurs } from "../../src/vm/derivation/derivateurs.mjs";
import { preparerEmplacementDerive } from "../../src/vm/derivation/emplacement-derive.mjs";
import {
  decoderParametresPublics,
  encoderParametresPublics,
} from "../../src/vm/derivation/parametres-publics.mjs";
import {
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { TYPES_KEK, nomDuTypeKek } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { infoDeReference, okmDeReference } from "./modele-derivation.mjs";
import { identifiantDeVolume, supportDouble, suiteDOctets } from "./support-enveloppe-double.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const VECTEURS = JSON.parse(
  await readFile(new URL("../vectors/derivation-v1.json", import.meta.url), "utf8"),
);

const VOLUME = identifiantDeVolume(0x30);
const SEL = octetsEnHex(suiteDOctets(0xd0, 32));
const PARAMETRES = () => parametresDeRecuperation({ sel: SEL });

/** Seize octets déterministes : un code d'épreuve, jamais tiré, jamais un secret. */
const OCTETS_TEMOIN = () => suiteDOctets(0x20, CODE_OCTETS);

/**
 * DÉRIVATEUR d'épreuve pour l'emplacement `phrase` : il rend une KEK déterministe du geste et de
 * l'identité, sans Argon2. Cette suite mesure le moyen de RÉCUPÉRATION, pas l'étirement.
 */
function derivateurDePhraseDEpreuve() {
  return {
    type: TYPES_KEK.phrase,
    deriver: async ({ identite, geste }) => {
      const materiau = new TextEncoder().encode(
        `phrase|${geste?.phrase}|${identite.identifiantVolume}|${identite.identifiantEmplacement}`,
      );
      const base = new Uint8Array(await crypto.subtle.digest("SHA-256", materiau));
      return crypto.subtle.importKey("raw", base, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    },
  };
}

/**
 * Pose une enveloppe ouverte par une PHRASE, et rend de quoi la rouvrir.
 *
 * C'est l'état de départ des trois épreuves de `SEC-RECOVERY-001` : un volume qui n'a qu'un seul
 * moyen, celui que l'utilisateur va perdre.
 */
async function enveloppeSousPhrase(phrase = "la phrase de depart") {
  const support = supportDouble();
  const dek = suiteDOctets(0x40, 32);
  const derivateur = derivateurDePhraseDEpreuve();
  const parametres = suiteDOctets(0x11, 24);
  const prepare = await preparerEmplacementDerive({
    identifiantVolume: VOLUME,
    derivateur,
    parametres,
    geste: { phrase },
  });
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek: prepare.kek,
    typeKek: TYPES_KEK.phrase,
    parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });
  const rouvrirLaPhrase = () =>
    derivateur.deriver({
      parametres,
      identite: {
        identifiantVolume: VOLUME,
        identifiantEmplacement: prepare.identifiantEmplacement,
      },
      geste: { phrase },
    });
  return { support, dek, identifiantEmplacement: prepare.identifiantEmplacement, rouvrirLaPhrase };
}

/** Dérive la KEK d'un code sous l'identité d'un emplacement de récupération déjà posé. */
function kekDuCode(code, parametres, identifiantEmplacement) {
  return derivateurRecuperation().deriver({
    parametres,
    identite: { identifiantVolume: VOLUME, identifiantEmplacement },
    geste: { code },
  });
}

/** L'emplacement de récupération d'une enveloppe, tel que l'inventaire PUBLIC le montre. */
async function emplacementDeRecuperation(support) {
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  return inventaire.emplacements.find(
    (emplacement) => emplacement.typeKek === TYPES_KEK.recuperation,
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Les 128 bits TIRÉS, et la forme rendue.
// ---------------------------------------------------------------------------------------------

test("le code tire EXACTEMENT seize octets, et chacun d'eux varie", () => {
  assert.equal(CODE_OCTETS, 16, "128 bits, et le nombre est celui des octets TIRÉS.");
  const tirages = Array.from({ length: 64 }, () => tirerCodeDeRecuperation());
  for (const tirage of tirages) {
    assert.ok(tirage instanceof Uint8Array);
    assert.equal(tirage.byteLength, CODE_OCTETS, "un tirage plus court est un code plus faible.");
  }
  // Un tirage qui ne remplirait que la moitié du tampon laisserait des octets constants : la
  // longueur seule ne le dirait pas. Chaque rang doit prendre au moins deux valeurs sur 64 tirages
  // — la probabilité d'un faux rouge est celle de 64 tirages tombant sur le même octet, 256^-63.
  for (let rang = 0; rang < CODE_OCTETS; rang += 1) {
    const valeurs = new Set(tirages.map((tirage) => tirage[rang]));
    assert.ok(valeurs.size > 1, `l'octet de rang ${rang} ne varie pas : il n'est pas tiré.`);
  }
});

test("le code rendu fait vingt-huit symboles Crockford, en sept groupes de quatre", () => {
  assert.equal(ALPHABET_CROCKFORD, "0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  assert.equal(ALPHABET_CROCKFORD.length, 32);
  for (const absent of ["I", "L", "O", "U"]) {
    assert.ok(
      !ALPHABET_CROCKFORD.includes(absent),
      `« ${absent} » se confond à l'œil avec un autre signe : Crockford l'écarte.`,
    );
  }
  assert.equal(SYMBOLES_DONNEES, 26);
  assert.equal(SYMBOLES_CONTROLE, 2);
  assert.equal(SYMBOLES_TOTAL, SYMBOLES_DONNEES + SYMBOLES_CONTROLE);

  const rendu = encoderCode(OCTETS_TEMOIN());
  assert.match(rendu, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
  assert.equal(rendu.replaceAll("-", "").length, SYMBOLES_TOTAL);
  assert.equal(rendu.split("-").length, SYMBOLES_TOTAL / SYMBOLES_PAR_GROUPE);
});

test("aller-retour : encoder puis décoder rend les MÊMES seize octets", () => {
  for (let tour = 0; tour < 200; tour += 1) {
    const octets = tirerCodeDeRecuperation();
    assert.deepEqual(decoderCode(encoderCode(octets)), octets);
  }
});

test("les deux bits de bourrage sont NULS, et un bourrage non nul est refusé", () => {
  const symboles = symbolesDesOctets(OCTETS_TEMOIN());
  assert.equal(symboles.length, SYMBOLES_DONNEES);
  // Vingt-six symboles de cinq bits portent 130 bits ; les 128 du code en laissent deux, à zéro.
  assert.equal(symboles.at(-1) % 4, 0, "le dernier symbole porte les deux bits de bourrage.");

  const bourres = [...symboles];
  bourres[SYMBOLES_DONNEES - 1] += 1;
  assert.throws(
    () => octetsDesSymboles(bourres),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.codeMalRecopie),
    "un bourrage non nul décrit un code qui n'est pas de ce produit : refusé, jamais rogné.",
  );
});

// ---------------------------------------------------------------------------------------------
// 2. La somme de contrôle : exhaustive, et vérifiée AVANT toute dérivation.
// ---------------------------------------------------------------------------------------------

/** Les vingt-huit symboles d'un code, somme de contrôle comprise. */
function symbolesComplets(octets) {
  const donnees = symbolesDesOctets(octets);
  return [...donnees, ...sommeDeControle(donnees)];
}

test("la somme de contrôle détecte TOUTE substitution d'un symbole, exhaustivement", () => {
  for (const cas of VECTEURS.recuperation.codes) {
    const symboles = symbolesComplets(hexEnOctets(cas.octetsHex));
    assert.ok(sommeDeControleValide(symboles), `le vecteur « ${cas.nom} » doit être valide.`);
    let mesurees = 0;
    for (let rang = 0; rang < SYMBOLES_TOTAL; rang += 1) {
      for (let valeur = 0; valeur < ALPHABET_CROCKFORD.length; valeur += 1) {
        if (valeur === symboles[rang]) continue;
        const mute = [...symboles];
        mute[rang] = valeur;
        assert.ok(
          !sommeDeControleValide(mute),
          `substitution non détectée au rang ${rang} (${symboles[rang]} → ${valeur}).`,
        );
        mesurees += 1;
      }
    }
    assert.equal(mesurees, SYMBOLES_TOTAL * (ALPHABET_CROCKFORD.length - 1));
  }
});

test("la somme de contrôle détecte TOUTE transposition de deux symboles adjacents", () => {
  let mesurees = 0;
  for (const cas of VECTEURS.recuperation.codes) {
    const symboles = symbolesComplets(hexEnOctets(cas.octetsHex));
    for (let rang = 0; rang < SYMBOLES_TOTAL - 1; rang += 1) {
      // Deux symboles ÉGAUX échangés ne sont pas une erreur : la chaîne ne change pas, il n'y a
      // donc rien à détecter. Les vecteurs « seize octets nuls » et « seize octets à 0xff » sont
      // là pour cela : leurs symboles de données sont tous égaux, et ils montrent que le cas
      // dégénéré est écarté plutôt qu'ignoré.
      if (symboles[rang] === symboles[rang + 1]) continue;
      const mute = [...symboles];
      [mute[rang], mute[rang + 1]] = [mute[rang + 1], mute[rang]];
      assert.ok(
        !sommeDeControleValide(mute),
        `transposition non détectée au rang ${rang} du vecteur « ${cas.nom} ».`,
      );
      mesurees += 1;
    }
  }
  // Un balayage à vide passerait toujours : le compte est ce qui dit que l'épreuve a mordu.
  assert.ok(mesurees >= 25, `seulement ${mesurees} transpositions mesurées sur tous les vecteurs.`);
});

test("le module de la somme de contrôle est PUR : il ne connaît ni volume ni enveloppe", async () => {
  // Un oracle serait une somme qui dépend de ce qu'on cherche à ouvrir : elle dirait à qui essaie
  // des codes lequel mérite d'être essayé encore. Celle-ci est une fonction du code SEUL, et
  // l'inspection de source le tient plutôt que l'affirmation.
  const source = await readFile(
    path.join(REPO_ROOT, "src/vm/derivation/code-de-recuperation.mjs"),
    "utf8",
  );
  const imports = [...source.matchAll(/^\s*import[^\n]*?from\s+["']([^"']+)["']/gm)].map(
    (occurrence) => occurrence[1],
  );
  assert.deepEqual(
    imports,
    ["./derivation-errors.mjs"],
    "ce module ne doit importer que ses refus : ni enveloppe, ni volume, ni WebCrypto.",
  );
  assert.equal(MODULE_CONTROLE, 1021, "le module premier de la somme de contrôle est écrit ici.");
});

test("un code mal recopié est un refus DISTINCT d'un mauvais code", () => {
  const juste = encoderCode(OCTETS_TEMOIN());
  const dernierAutre = juste.at(-1) === "0" ? "1" : "0";
  const malRecopie = [
    ["un symbole retiré", juste.slice(0, -1)],
    ["un symbole en trop", `${juste}Z`],
    ["un symbole étranger", `${juste.slice(0, -1)}!`],
    ["une lettre hors alphabet Crockford", `${juste.slice(0, -1)}U`],
    ["une somme de contrôle fausse", `${juste.slice(0, -1)}${dernierAutre}`],
    ["rien du tout", ""],
    ["ce n'est pas une chaîne", null],
  ];
  for (const [nom, saisie] of malRecopie) {
    assert.throws(
      () => decoderCode(saisie),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.codeMalRecopie),
      `« ${nom} » aurait dû être refusé comme mal recopié`,
    );
  }
  // Un AUTRE code, parfaitement formé : sa somme de contrôle est juste, et c'est l'ENVELOPPE qui
  // tranchera. Le dérivateur ne sait pas, et ne peut pas savoir, qu'un code est faux.
  assert.doesNotThrow(() => decoderCode(encoderCode(suiteDOctets(0x77, CODE_OCTETS))));
});

test("une somme de contrôle fausse est refusée AVANT toute dérivation, jamais par l'enveloppe", async () => {
  const juste = encoderCode(OCTETS_TEMOIN());
  const faux = `${juste.slice(0, -1)}${juste.at(-1) === "0" ? "1" : "0"}`;
  await assert.rejects(
    () => kekDuCode(faux, PARAMETRES(), "7071727374757677"),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.codeMalRecopie),
    "le refus est celui du CODE, pas celui de l'enveloppe : aucune KEK n'a été fabriquée.",
  );
  // Témoin : le même chemin, sous un code bien formé, rend bien une clé.
  assert.ok(await kekDuCode(juste, PARAMETRES(), "7071727374757677"));
});

// ---------------------------------------------------------------------------------------------
// 3. La saisie humaine : NFC, majuscules, séparateurs, repli Crockford.
// ---------------------------------------------------------------------------------------------

test("la saisie humaine — minuscules, espaces, o pour 0, l pour 1 — rend le MÊME code", () => {
  const cas = VECTEURS.recuperation.saisies;
  assert.ok(cas.acceptees.length >= 3, "il faut au moins trois formes de saisie figées.");
  for (const forme of cas.acceptees) {
    assert.equal(
      octetsEnHex(decoderCode(String.fromCodePoint(...forme.pointsSaisis))),
      cas.octetsHex,
      `la forme « ${forme.nom} » ne rend pas les mêmes octets`,
    );
  }
});

test("un chiffre pleine chasse, que la NFC ne replie pas, est REFUSÉ", () => {
  for (const forme of VECTEURS.recuperation.saisies.refusees) {
    assert.throws(
      () => decoderCode(String.fromCodePoint(...forme.pointsSaisis)),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.codeMalRecopie),
      `la forme « ${forme.nom} » aurait dû être refusée`,
    );
  }
  // Le vecteur figé dit LAQUELLE des quatre formes de normalisation est appliquée : NFKC replierait
  // la pleine chasse en un chiffre ordinaire, c'est-à-dire accepterait un code que NFC refuse.
  assert.equal(VECTEURS.recuperation.saisies.forme, "NFC");
});

test("normaliserSaisie rend les valeurs de symbole, et refuse tout signe étranger", () => {
  const symboles = normaliserSaisie(encoderCode(OCTETS_TEMOIN()));
  assert.equal(symboles.length, SYMBOLES_TOTAL);
  for (const valeur of symboles) {
    assert.ok(Number.isInteger(valeur) && valeur >= 0 && valeur < 32);
  }
  assert.throws(
    () => normaliserSaisie("0000-0000-0000-0000-0000-0000-000é"),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.codeMalRecopie),
  );
});

// ---------------------------------------------------------------------------------------------
// 4. Le type 4, ses paramètres publics, et la KEK.
// ---------------------------------------------------------------------------------------------

test("le type « recuperation » vaut 4, et il porte un nom", () => {
  assert.equal(TYPES_KEK.recuperation, 4);
  assert.equal(nomDuTypeKek(4), "recuperation");
});

test("les paramètres publics du type 4 sont ceux du vecteur figé, et se relisent", () => {
  const cas = VECTEURS.parametres.find((entree) => entree.type === "recuperation");
  assert.ok(cas, "le vecteur des paramètres de récupération manque.");
  const octets = encoderParametresPublics(TYPES_KEK.recuperation, cas.valeurs);
  assert.equal(octetsEnHex(octets), cas.octetsHex);
  assert.deepEqual(decoderParametresPublics(TYPES_KEK.recuperation, octets), cas.valeurs);
  assert.equal(cas.valeurs.version, RECUPERATION_VERSION);
  assert.equal(cas.valeurs.sel.length, 64, "le sel HKDF fait trente-deux octets.");
});

test("le décodeur des paramètres de récupération REFUSE plutôt que de compléter", () => {
  const octets = PARAMETRES();
  const avecQueue = new Uint8Array(octets.byteLength + 1);
  avecQueue.set(octets, 0);
  const parametresDUnePhrase = encoderParametresPublics(
    TYPES_KEK.phrase,
    VECTEURS.parametres.find((entree) => entree.type === "phrase").valeurs,
  );
  for (const [nom, mutes] of [
    ["une queue", avecQueue],
    ["une troncature", octets.subarray(0, octets.byteLength - 1)],
    ["l'encodage d'un AUTRE dérivateur", parametresDUnePhrase],
  ]) {
    assert.throws(
      () => decoderParametresPublics(TYPES_KEK.recuperation, mutes),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
      `« ${nom} » aurait dû être refusé`,
    );
  }
});

test("un sel de mauvaise largeur, ou une version inconnue, est refusé à la LECTURE", async () => {
  const identite = { identifiantVolume: VOLUME, identifiantEmplacement: "7071727374757677" };
  const geste = { code: encoderCode(OCTETS_TEMOIN()) };
  const versionInconnue = encoderParametresPublics(TYPES_KEK.recuperation, {
    version: RECUPERATION_VERSION + 1,
    sel: SEL,
  });
  await assert.rejects(
    () => derivateurRecuperation().deriver({ parametres: versionInconnue, identite, geste }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
    "ces octets viennent d'un fichier : une version qu'on ne sait pas lire n'est jamais devinée.",
  );
  assert.throws(
    () => parametresDeRecuperation({ sel: octetsEnHex(suiteDOctets(0xd0, 16)) }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
    "un sel de seize octets n'est pas le sel de trente-deux que ce type exige.",
  );
  // Et à la LECTURE, ce qui est le côté qui compte : ces octets viennent d'un fichier, et
  // l'encodeur du produit ne peut pas les fabriquer. Ils sont donc POSÉS à la main, comme le fait
  // `vm-derivation-phrase.test.mjs` pour son sel court. Sans cette épreuve, un adversaire qui écrit
  // `<volume>.cles` y mettrait un sel de seize octets et la garde ne dirait rien.
  await assert.rejects(
    () =>
      derivateurRecuperation().deriver({
        parametres: parametresAuSelCourt(),
        identite,
        geste,
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
    "un sel court LU DANS LE FICHIER aurait dû être refusé",
  );
});

/**
 * Les paramètres publics d'un emplacement de récupération dont le SEL ne fait que seize octets.
 *
 * Ils sont écrits à la main : étiquette de domaine préfixée de sa longueur, version sur un octet,
 * longueur du sel sur deux, puis le sel. Le produit refuse de les encoder, et c'est le point.
 */
function parametresAuSelCourt() {
  const etiquette = new TextEncoder().encode("railsbox-vault/derivation/v1/recuperation");
  const sel = suiteDOctets(0xd0, 16);
  const octets = new Uint8Array(2 + etiquette.byteLength + 1 + 2 + sel.byteLength);
  const vue = new DataView(octets.buffer);
  vue.setUint16(0, etiquette.byteLength, false);
  octets.set(etiquette, 2);
  octets[2 + etiquette.byteLength] = RECUPERATION_VERSION;
  vue.setUint16(3 + etiquette.byteLength, sel.byteLength, false);
  octets.set(sel, 5 + etiquette.byteLength);
  return octets;
}

test("le matériau remis à HKDF est le SHA-256 des seize octets, et les octets sont effacés", async () => {
  const octets = OCTETS_TEMOIN();
  const attendu = new Uint8Array(await crypto.subtle.digest("SHA-256", OCTETS_TEMOIN()));
  const materiau = await materiauDuCode(octets);
  assert.deepEqual(materiau, attendu);
  assert.equal(materiau.byteLength, 32, "la garde de largeur de `deriverKek` n'est pas affaiblie.");
  assert.ok(
    octets.every((octet) => octet === 0),
    "les seize octets du code doivent être effacés dès que le matériau existe.",
  );
});

test("la KEK du code est celle du modèle : scellée sous l'une, ouverte sous l'autre", async () => {
  const support = supportDouble();
  const dek = suiteDOctets(0x50, 32);
  const identifiantEmplacement = "8081828384858687";
  const kek = await kekDuCode(encoderCode(OCTETS_TEMOIN()), PARAMETRES(), identifiantEmplacement);
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek,
    typeKek: TYPES_KEK.recuperation,
    parametres: PARAMETRES(),
    identifiantEmplacement,
  });

  // Le MODÈLE refait les mêmes octets à la main : SHA-256 du code, puis HKDF sous le sel de
  // l'emplacement et l'info de l'ADR 0021. Il a le droit de voir les octets ; le produit ne l'a pas.
  const okm = await okmDeReference({
    materiau: new Uint8Array(await crypto.subtle.digest("SHA-256", OCTETS_TEMOIN())),
    sel: hexEnOctets(SEL),
    info: infoDeReference({ identifiantVolume: VOLUME, identifiantEmplacement, version: 1 }),
  });
  const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: okm });
  assert.deepEqual(ouverte.dek, dek, "la clé du modèle n'ouvre pas ce que le produit a fermé.");
});

test("la KEK est NON EXTRACTIBLE, et deux emplacements du même code n'en rendent pas une seule", async () => {
  const code = encoderCode(OCTETS_TEMOIN());
  const premiere = await kekDuCode(code, PARAMETRES(), "8081828384858687");
  const seconde = await kekDuCode(code, PARAMETRES(), "9091929394959697");
  assert.equal(premiere.extractable, false);
  assert.equal(premiere.algorithm.name, "AES-GCM");
  assert.equal(premiere.algorithm.length, 256);
  await assert.rejects(() => crypto.subtle.exportKey("raw", premiere));

  const support = supportDouble();
  const dek = suiteDOctets(0x60, 32);
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek: premiere,
    typeKek: TYPES_KEK.recuperation,
    parametres: PARAMETRES(),
    identifiantEmplacement: "8081828384858687",
  });
  await assert.rejects(
    () => ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: seconde }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );
});

test("le catalogue sert le type 4, et un type qu'il ne sert pas reste un refus typé", () => {
  const catalogue = catalogueDeDerivateurs({
    [TYPES_KEK.recuperation]: derivateurRecuperation(),
  });
  assert.equal(catalogue.pour(TYPES_KEK.recuperation).type, TYPES_KEK.recuperation);
  assert.throws(
    () => catalogue.pour(TYPES_KEK.phrase),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.typeInconnu),
  );
});

// ---------------------------------------------------------------------------------------------
// 5. `SEC-RECOVERY-001` — succès, révocation, perte définitive.
// ---------------------------------------------------------------------------------------------

test("SUCCÈS : le code ouvre une enveloppe dont l'emplacement `phrase` a été révoqué", async () => {
  const depart = await enveloppeSousPhrase();
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  const code = moyen.rendre();

  await revoquerEmplacement({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
    identifiantEmplacement: depart.identifiantEmplacement,
  });

  const inventaire = await inventorierEnveloppe({
    support: depart.support,
    identifiantVolume: VOLUME,
  });
  assert.equal(inventaire.emplacements.length, 1);
  assert.equal(inventaire.emplacements[0].typeKek, TYPES_KEK.recuperation);

  // La phrase n'ouvre plus rien : c'est bien le moyen de récupération qui porte le volume.
  await assert.rejects(
    async () =>
      ouvrirEnveloppe({
        support: depart.support,
        identifiantVolume: VOLUME,
        kek: await depart.rouvrirLaPhrase(),
      }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );

  // Le code est saisi sous une forme HUMAINE : minuscules, espaces au lieu des tirets, « o » et
  // « l » pour les chiffres qu'ils imitent. C'est ce qu'on retape d'une feuille de papier.
  const humaine = code.toLowerCase().replaceAll("-", " ").replaceAll("0", "o").replaceAll("1", "l");
  const kek = await kekDuCode(
    humaine,
    inventaire.emplacements[0].parametres,
    inventaire.emplacements[0].identifiantEmplacement,
  );
  const ouverte = await ouvrirEnveloppe({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek,
  });
  assert.deepEqual(ouverte.dek, depart.dek, "le code n'a pas développé la clé de volume.");
});

test("RÉVOCATION : l'emplacement de récupération révoqué rend le MÊME refus qu'une clé inconnue", async () => {
  const depart = await enveloppeSousPhrase();
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  const code = moyen.rendre();
  const pose = await emplacementDeRecuperation(depart.support);
  const kek = await kekDuCode(code, pose.parametres, pose.identifiantEmplacement);

  await revoquerEmplacement({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
    identifiantEmplacement: pose.identifiantEmplacement,
  });

  const refusDe = (cle) =>
    ouvrirEnveloppe({ support: depart.support, identifiantVolume: VOLUME, kek: cle }).then(
      () => null,
      (erreur) => erreur,
    );
  const inconnue = await crypto.subtle.importKey(
    "raw",
    suiteDOctets(0xee, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const refusRevoquee = await refusDe(kek);
  const refusInconnue = await refusDe(inconnue);
  assert.ok(isEnveloppeError(refusRevoquee, ENVELOPPE_ERROR_CODES.cleRefusee));
  assert.equal(refusRevoquee.code, refusInconnue.code);
  assert.equal(refusRevoquee.message, refusInconnue.message);
});

test("RÉVOCATION : aucun octet de l'emplacement de récupération retiré ne subsiste", async () => {
  const depart = await enveloppeSousPhrase();
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  moyen.rendre();
  const pose = await emplacementDeRecuperation(depart.support);
  const empreinteDesParametres = octetsEnHex(pose.parametres);

  await revoquerEmplacement({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
    identifiantEmplacement: pose.identifiantEmplacement,
  });

  // La règle de remplissage de l'ADR 0020 porte sur la page PUBLIÉE : elle est réécrite entière,
  // remplissage à zéro compris. L'épreuve la rejoue sur le type 4.
  const courante = await inventorierEnveloppe({
    support: depart.support,
    identifiantVolume: VOLUME,
  });
  assert.equal(courante.emplacements.length, 1);
  assert.equal(courante.emplacements[0].typeKek, TYPES_KEK.phrase);
  assert.ok(
    !courante.emplacements.some(
      (emplacement) => octetsEnHex(emplacement.parametres) === empreinteDesParametres,
    ),
    "les paramètres de l'emplacement retiré subsistent dans la page courante.",
  );
});

test("PERTE DÉFINITIVE : révoquer le DERNIER emplacement, celui de récupération, est refusé", async () => {
  const depart = await enveloppeSousPhrase();
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  const code = moyen.rendre();
  const pose = await emplacementDeRecuperation(depart.support);
  const kek = await kekDuCode(code, pose.parametres, pose.identifiantEmplacement);

  await revoquerEmplacement({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
    identifiantEmplacement: depart.identifiantEmplacement,
  });
  await assert.rejects(
    () =>
      revoquerEmplacement({
        support: depart.support,
        identifiantVolume: VOLUME,
        kek,
        identifiantEmplacement: pose.identifiantEmplacement,
      }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.dernierEmplacement),
    "perdre un volume ne doit jamais être le résultat d'un seul geste réussi.",
  );
});

test("PERTE DÉFINITIVE : un code faux à somme JUSTE est refusé par l'enveloppe, sans indice", async () => {
  const depart = await enveloppeSousPhrase();
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  moyen.rendre();
  const pose = await emplacementDeRecuperation(depart.support);
  // Un AUTRE code, tiré comme le vrai : sa somme de contrôle est juste, sa KEK est fausse. Le
  // produit ne dit pas « ce code n'est pas le bon » — il dit ce qu'il dirait d'une clé inconnue.
  const kek = await kekDuCode(
    encoderCode(tirerCodeDeRecuperation()),
    pose.parametres,
    pose.identifiantEmplacement,
  );
  await assert.rejects(
    () => ouvrirEnveloppe({ support: depart.support, identifiantVolume: VOLUME, kek }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );
});

test("PERTE DÉFINITIVE : aucun module du produit ne conserve le code ni ne sait le régénérer", async () => {
  // Inspection de source, à la manière de `dossier-de-revue.test.mjs` : ce qui n'est relu par rien
  // finit toujours par devenir faux. Deux propriétés, et la seconde est la garde d'avenir.
  const modules = [
    "src/vm/derivation/code-de-recuperation.mjs",
    "src/vm/derivation/derivateur-recuperation.mjs",
    "src/vm/moyen-de-recuperation.mjs",
  ];
  const PERSISTANCES = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches",
    "document.cookie",
    "createSyncAccessHandle",
    "getDirectory",
  ];
  for (const relatif of modules) {
    const source = await readFile(path.join(REPO_ROOT, relatif), "utf8");
    for (const persistance of PERSISTANCES) {
      assert.ok(
        !source.includes(persistance),
        `${relatif} mentionne « ${persistance} » : le code n'est écrit nulle part.`,
      );
    }
  }

  // Qui IMPORTE le module du code ? Exactement les trois modules attendus. Un importateur de plus
  // est un endroit de plus où le code pourrait vivre, et cette épreuve le NOMME avant la revue.
  //
  // Le troisième est le BANC de déverrouillage, et il est là pour ce qu'il est : il fabrique un
  // code afin de l'éprouver de bout en bout sur l'OPFS réel. Il ne l'écrit nulle part, et c'est la
  // sonde de `tests/browser/deverrouillage-frontiere.spec.mjs` qui le mesure plutôt que cette
  // liste. La liste, elle, dit qu'aucun QUATRIÈME endroit n'est apparu en silence.
  const importateurs = [];
  const parcourir = async (repertoire) => {
    for (const entree of await readdir(repertoire, { withFileTypes: true })) {
      const complet = path.join(repertoire, entree.name);
      if (entree.isDirectory()) {
        await parcourir(complet);
        continue;
      }
      if (!entree.name.endsWith(".mjs")) continue;
      const source = await readFile(complet, "utf8");
      if (source.includes("code-de-recuperation.mjs")) {
        importateurs.push(path.relative(REPO_ROOT, complet).replaceAll("\\", "/"));
      }
    }
  };
  await parcourir(path.join(REPO_ROOT, "src"));
  await parcourir(path.join(REPO_ROOT, "public", "vm"));
  assert.deepEqual(importateurs.sort(), [
    "public/vm/deverrouillage-worker.mjs",
    "src/vm/derivation/derivateur-recuperation.mjs",
    "src/vm/moyen-de-recuperation.mjs",
  ]);
});

// ---------------------------------------------------------------------------------------------
// 6. Le rendu unique, et l'ordre écriture-avant-rendu.
// ---------------------------------------------------------------------------------------------

test("le code est rendu UNE fois : un second appel rend un refus typé, jamais la chaîne", async () => {
  const depart = await enveloppeSousPhrase();
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  const premier = moyen.rendre();
  assert.equal(premier.replaceAll("-", "").length, SYMBOLES_TOTAL);
  for (let tour = 0; tour < 3; tour += 1) {
    assert.throws(
      () => moyen.rendre(),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.codeDejaRendu),
      "un second appel rend un refus, jamais la chaîne.",
    );
  }
  // Et l'objet lui-même ne porte plus la chaîne : elle n'est ni un champ, ni sérialisable.
  assert.ok(!JSON.stringify(moyen).includes(premier.slice(0, 4)));
});

test("l'enveloppe est écrite et sa BARRIÈRE franchie avant que le code ne soit rendu", async () => {
  const depart = await enveloppeSousPhrase();
  const avant = depart.support.gestes;
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  // DEUX gestes durables ont eu lieu — l'écriture de la page libre, puis la barrière qui la publie
  // (ADR 0020) — et ils ont eu lieu AVANT que `rendre` n'existe : le porteur du code est fabriqué à
  // partir de ce que l'ajout a rendu, il ne peut donc pas exister avant lui. L'ordre inverse
  // donnerait un code qui n'ouvre rien, et c'est le sinistre que cette tranche doit empêcher.
  assert.equal(depart.support.gestes - avant, 2, "une écriture, puis une barrière.");
  assert.equal(moyen.version, 2);
  assert.equal(moyen.typeKek, TYPES_KEK.recuperation);
  const inventaire = await inventorierEnveloppe({
    support: depart.support,
    identifiantVolume: VOLUME,
  });
  assert.equal(inventaire.version, 2);
  assert.equal(inventaire.emplacements.length, 2);
  assert.equal(typeof moyen.rendre(), "string");
});

test("une coupure AVANT la barrière ne rend aucun code, et laisse l'enveloppe d'origine", async () => {
  const depart = await enveloppeSousPhrase();
  const octets = await depart.support.lire(0, (await depart.support.etat()).taille);
  // Le geste 1 est l'écriture de la page libre, le geste 2 est la barrière : couper avant celle-ci
  // est exactement la coupure que la décision 3 de l'ADR 0025 nomme.
  const coupe = supportDouble({ octets, couperAvant: 2 });
  await assert.rejects(
    async () =>
      creerMoyenDeRecuperation({
        support: coupe,
        identifiantVolume: VOLUME,
        kek: await depart.rouvrirLaPhrase(),
      }),
    /Coupure simulée/,
    "une coupure doit interrompre le geste, jamais rendre un code à moitié posé.",
  );
  // L'enveloppe d'origine reste ouvrable par la phrase : une coupure ne perd rien.
  const intacte = supportDouble({ octets });
  const ouverte = await ouvrirEnveloppe({
    support: intacte,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
  });
  assert.deepEqual(ouverte.dek, depart.dek);
});

test("les seize octets tirés sont EFFACÉS dès que la KEK existe", async () => {
  const depart = await enveloppeSousPhrase();
  const tampon = suiteDOctets(0x20, CODE_OCTETS);
  const moyen = await creerMoyenDeRecuperation({
    support: depart.support,
    identifiantVolume: VOLUME,
    kek: await depart.rouvrirLaPhrase(),
    tirerCode: () => tampon,
  });
  assert.ok(
    tampon.every((octet) => octet === 0),
    "le tampon des seize octets tirés doit être mis à zéro dès que la clé existe.",
  );
  // La CHAÎNE, elle, ne s'efface pas : c'est une `string` JavaScript, immuable et copiée par le
  // moteur. L'ADR 0025 l'écrit « impossible », comme l'ADR 0021 le dit de la phrase.
  assert.equal(moyen.rendre(), encoderCode(suiteDOctets(0x20, CODE_OCTETS)));
});

test("le sel d'un emplacement de récupération est TIRÉ, et fait trente-deux octets", () => {
  const sels = Array.from({ length: 16 }, () => tirerSelDeRecuperation());
  for (const sel of sels) assert.match(sel, /^[0-9a-f]{64}$/);
  assert.equal(new Set(sels).size, sels.length, "deux emplacements ne partagent pas un sel.");
});
