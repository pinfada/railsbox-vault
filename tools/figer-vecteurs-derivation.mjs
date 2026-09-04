#!/usr/bin/env node
// FIGE les vecteurs de la dérivation des clés de déverrouillage (#22, ADR 0021).
//
//     node tools/figer-vecteurs-derivation.mjs
//
// Il écrit `tests/vectors/derivation-v1.json`, que `tests/unit/vm-derivation-*.test.mjs` relit.
//
// ## Il POSE les octets, il ne les demande pas au produit
//
// C'est la règle des figeurs de ce dépôt (ADR 0015, ADR 0020) et elle est la seule chose qui donne
// un sens à la confrontation : un outil qui appellerait `encoderInfoDerivation` pour écrire ce que
// `encoderInfoDerivation` doit rendre publierait la tautologie « le produit est d'accord avec
// lui-même ». Les encodages ci-dessous sont donc réécrits À LA MAIN, entier par entier, chaîne par
// chaîne — c'est fastidieux, et c'est le travail.
//
// ## Les trois vecteurs d'Argon2 ne sont PAS calculés ici
//
// Ils sont RECOPIÉS de la RFC 9106 (§ 5.1 Argon2d, § 5.2 Argon2i, § 5.3 Argon2id). Les calculer
// avec l'artefact vendu reviendrait à figer ce que l'artefact rend, c'est-à-dire à ne rien
// vérifier ; l'épreuve confronte l'artefact à la RFC, dans ce sens-là et pas dans l'autre.
//
// Les trois emploient un SECRET et des DONNÉES ASSOCIÉES, ce qu'aucune autre publication de
// vecteurs Argon2 ne fait. C'est ce qui a décidé du choix de l'artefact vendu : une implémentation
// qui n'exposerait ni l'un ni l'autre ne pourrait pas rejouer la RFC, et le dépôt aurait dû se
// contenter de vecteurs de seconde main.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SORTIE = fileURLToPath(new URL("../tests/vectors/derivation-v1.json", import.meta.url));

/** Hexadécimal minuscule d'une suite d'octets, posé sans passer par le produit. */
function hex(octets) {
  return [...octets].map((octet) => octet.toString(16).padStart(2, "0")).join("");
}

/** Une suite d'octets déterministe : `longueur` octets à partir de `base`. */
function suite(base, longueur) {
  return Uint8Array.from({ length: longueur }, (_, index) => (base + index) % 256);
}

/** Entier gros-boutiste sur `largeur` octets, écrit à la main. */
function entier(valeur, largeur) {
  const octets = new Uint8Array(largeur);
  let reste = valeur;
  for (let index = largeur - 1; index >= 0; index -= 1) {
    octets[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  if (reste !== 0) throw new RangeError(`${valeur} ne tient pas sur ${largeur} octets.`);
  return octets;
}

/** Chaîne UTF-8 précédée de sa longueur sur deux octets. */
function prefixee(texte) {
  const utf8 = new TextEncoder().encode(texte);
  return coller([entier(utf8.byteLength, 2), utf8]);
}

function coller(morceaux) {
  let total = 0;
  for (const morceau of morceaux) total += morceau.byteLength;
  const rendu = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of morceaux) {
    rendu.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return rendu;
}

function octetsDeHex(texte) {
  const octets = new Uint8Array(texte.length / 2);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(texte.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}

const VOLUME_A = hex(suite(0x30, 16));
const VOLUME_B = hex(suite(0x31, 16));
const EMPLACEMENT_A = hex(suite(0x70, 8));
const EMPLACEMENT_B = hex(suite(0x71, 8));

/** L'INFO d'HKDF, écrite à la main : étiquette, volume, emplacement, version. */
function info({ identifiantVolume, identifiantEmplacement, version }) {
  return coller([
    prefixee("railsbox-vault/derivation/v1/kek"),
    prefixee(identifiantVolume),
    prefixee(identifiantEmplacement),
    entier(version, 4),
  ]);
}

const CAS_INFO = [
  {
    nom: "volume A, emplacement A, version 1",
    identifiantVolume: VOLUME_A,
    identifiantEmplacement: EMPLACEMENT_A,
    version: 1,
  },
  {
    nom: "volume A, emplacement B, version 1",
    identifiantVolume: VOLUME_A,
    identifiantEmplacement: EMPLACEMENT_B,
    version: 1,
  },
  {
    nom: "volume B, emplacement A, version 1",
    identifiantVolume: VOLUME_B,
    identifiantEmplacement: EMPLACEMENT_A,
    version: 1,
  },
  {
    nom: "volume A, emplacement A, version 2",
    identifiantVolume: VOLUME_A,
    identifiantEmplacement: EMPLACEMENT_A,
    version: 2,
  },
];

/** Paramètres publics du dérivateur `phrase`, posés à la main. */
function parametresPhrase({ version, variante, memoireKio, iterations, parallelisme, sel }) {
  return coller([
    prefixee("railsbox-vault/derivation/v1/phrase"),
    entier(version, 1),
    entier(variante, 1),
    entier(memoireKio, 4),
    entier(iterations, 4),
    entier(parallelisme, 4),
    entier(sel.length / 2, 2),
    octetsDeHex(sel),
  ]);
}

/** Paramètres publics du dérivateur `webauthn-prf`, posés à la main. */
function parametresPrf({ rpId, identifiantCredential, sel }) {
  return coller([
    prefixee("railsbox-vault/derivation/v1/webauthn-prf"),
    prefixee(rpId),
    entier(identifiantCredential.length / 2, 2),
    octetsDeHex(identifiantCredential),
    entier(sel.length / 2, 2),
    octetsDeHex(sel),
  ]);
}

const VALEURS_PHRASE = Object.freeze({
  version: 0x13,
  variante: 2,
  memoireKio: 65536,
  iterations: 3,
  parallelisme: 4,
  sel: hex(suite(0x0e, 16)),
});

const VALEURS_PRF = Object.freeze({
  rpId: "localhost",
  identifiantCredential: hex(suite(0x90, 20)),
  sel: hex(suite(0xa0, 32)),
});

/** HKDF-SHA-256 tel que la RFC 5869 le définit, par WebCrypto. Ici le modèle EST la primitive. */
async function okm({ materiau, sel, infoOctets }) {
  const base = await crypto.subtle.importKey("raw", materiau, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: sel, info: infoOctets },
      base,
      256,
    ),
  );
}

const CAS_HKDF = [
  {
    nom: "matériau 0x5a, sel 0x0e, info du volume A",
    materiau: suite(0x5a, 32),
    sel: suite(0x0e, 16),
  },
  {
    nom: "matériau 0xc0, sel 0xa0, info du volume A",
    materiau: suite(0xc0, 32),
    sel: suite(0xa0, 32),
  },
  {
    nom: "matériau nul, sel vide, info du volume A",
    materiau: new Uint8Array(32),
    sel: new Uint8Array(0),
  },
];

/**
 * Les trois vecteurs de la RFC 9106, recopiés. Mêmes entrées pour les trois — mot de passe de 32
 * octets à 0x01, sel de 16 à 0x02, secret de 8 à 0x03, données associées de 12 à 0x04, m = 32 Kio,
 * t = 3, p = 4, étiquette de 32 octets, version 0x13 — et trois étiquettes distinctes.
 */
const ARGON2_RFC9106 = [
  {
    section: "5.1",
    variante: "d",
    rejoue: true,
    motif: null,
    empreinteHex: "512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb",
  },
  {
    section: "5.2",
    variante: "i",
    rejoue: false,
    motif:
      "L'artefact vendu calcule Argon2i JUSTE mais à un coût pathologique : 14,9 s mesurées pour " +
      "m = 32 Kio, t = 1, p = 1, là où Argon2id coûte 2 ms sur les mêmes paramètres. Le vecteur de " +
      "la RFC (t = 3, p = 4) ne rend pas la main dans un budget d'épreuve. La variante n'est pas " +
      "servie par src/vm/derivation/argon2-vendu.mjs, et le produit n'emploie qu'Argon2id.",
    empreinteHex: "c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8",
  },
  {
    section: "5.3",
    variante: "id",
    rejoue: true,
    motif: null,
    empreinteHex: "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
  },
].map((cas) => ({
  ...cas,
  motDePasseHex: hex(new Uint8Array(32).fill(0x01)),
  selHex: hex(new Uint8Array(16).fill(0x02)),
  secretHex: hex(new Uint8Array(8).fill(0x03)),
  donneesAssocieesHex: hex(new Uint8Array(12).fill(0x04)),
  memoireKio: 32,
  iterations: 3,
  parallelisme: 4,
  longueur: 32,
}));

/**
 * Le vecteur de NORMALISATION, posé POINT DE CODE PAR POINT DE CODE.
 *
 * Sans lui, rien ne fige la forme choisie. L'épreuve existante — « deux écritures Unicode rendent
 * la même KEK » — passe à l'identique sous NFC, NFD, NFKC et NFKD : toutes quatre font converger
 * les deux écritures d'un « é ». Ce qui les SÉPARE est ailleurs, et il faut des caractères qui le
 * montrent :
 *
 *  - `é` en deux points de code (U+0065 U+0301) à la SAISIE, un seul (U+00E9) en NFC : c'est ce
 *    que la normalisation doit faire, et les quatre formes le font ;
 *  - `ﬁ` (U+FB01, ligature de compatibilité) : NFC et NFD la LAISSENT, NFKC et NFKD la défont en
 *    « fi » — c'est-à-dire qu'elles changent le secret ;
 *  - `Ａ` (U+FF21, pleine chasse) : même chose, NFKC et NFKD le ramènent à « A ».
 *
 * Choisir NFKC transformerait donc une phrase en une AUTRE phrase, sans le dire, et un coffre
 * fermé avant le changement ne se rouvrirait plus. Les deux suites de points ci-dessous sont
 * écrites à la main ; aucune n'est obtenue en appelant `normalize`, faute de quoi le vecteur
 * suivrait le produit au lieu de le contraindre.
 */
const PHRASE_NFC = Object.freeze({
  nom: "« café ﬁn Ａlpha » : é décomposé à la saisie, ligature et pleine chasse préservées",
  // c a f e ◌́ ␣ ﬁ n ␣ Ａ l p h a
  pointsSaisis: Object.freeze([
    0x63, 0x61, 0x66, 0x65, 0x0301, 0x20, 0xfb01, 0x6e, 0x20, 0xff21, 0x6c, 0x70, 0x68, 0x61,
  ]),
  // c a f é ␣ ﬁ n ␣ Ａ l p h a
  pointsNfc: Object.freeze([
    0x63, 0x61, 0x66, 0x00e9, 0x20, 0xfb01, 0x6e, 0x20, 0xff21, 0x6c, 0x70, 0x68, 0x61,
  ]),
});

/** Les octets UTF-8 d'une suite de points de code, et leur empreinte SHA-256. */
async function vecteurDeNormalisation({ nom, pointsSaisis, pointsNfc }) {
  const octets = new TextEncoder().encode(String.fromCodePoint(...pointsNfc));
  const empreinte = new Uint8Array(await crypto.subtle.digest("SHA-256", octets));
  return {
    nom,
    forme: "NFC",
    pointsSaisis: [...pointsSaisis],
    pointsNfc: [...pointsNfc],
    phraseNfcHex: hex(octets),
    empreinteHex: hex(empreinte),
  };
}

async function document() {
  const infos = CAS_INFO.map(({ nom, ...entree }) => ({ nom, entree, infoHex: hex(info(entree)) }));
  const infoDuVolumeA = info(CAS_INFO[0]);
  const hkdf = [];
  for (const cas of CAS_HKDF) {
    hkdf.push({
      nom: cas.nom,
      materiauHex: hex(cas.materiau),
      selHex: hex(cas.sel),
      infoHex: hex(infoDuVolumeA),
      okmHex: hex(await okm({ materiau: cas.materiau, sel: cas.sel, infoOctets: infoDuVolumeA })),
    });
  }
  return {
    contrat: { id: "railsbox-vault-derivation", version: 1 },
    note:
      "Vecteurs figés de l'ADR 0021. Les encodages sont POSÉS par tools/figer-vecteurs-derivation.mjs, " +
      "sans appeler les encodeurs du produit ; les trois étiquettes Argon2 sont recopiées de la RFC 9106.",
    info: infos,
    hkdf,
    parametres: [
      {
        nom: "phrase, calibration retenue",
        type: "phrase",
        valeurs: VALEURS_PHRASE,
        octetsHex: hex(parametresPhrase(VALEURS_PHRASE)),
      },
      {
        nom: "webauthn-prf, créance de vingt octets",
        type: "webauthn-prf",
        valeurs: VALEURS_PRF,
        octetsHex: hex(parametresPrf(VALEURS_PRF)),
      },
    ],
    nfc: await vecteurDeNormalisation(PHRASE_NFC),
    argon2Rfc9106: ARGON2_RFC9106,
  };
}

await writeFile(SORTIE, `${JSON.stringify(await document(), null, 2)}\n`, "utf8");
process.stdout.write(`Vecteurs de dérivation écrits dans ${SORTIE}\n`);
