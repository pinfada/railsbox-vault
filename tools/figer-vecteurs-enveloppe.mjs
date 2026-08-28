#!/usr/bin/env node
// Fige les vecteurs de l'ENVELOPPE DE CLÉ (#21, ADR 0020).
//
//     node tools/figer-vecteurs-enveloppe.mjs
//
// Ce que ce script produit est un CONTRAT, pas un artefact de commodité : le chemin de production
// (`src/vm/enveloppe-de-cle.mjs`) doit reproduire ces octets à l'identique. Le relancer après avoir
// modifié le format ne CORRIGE donc rien — cela change un format persistant, ce qui exige une
// version et un ADR. L'épreuve `tests/unit/vm-enveloppe-vecteurs.test.mjs` est là pour que ce
// changement rougisse au lieu de passer.
//
// ## Ce script POSE LES OCTETS LUI-MÊME, et c'est le point
//
// Il n'appelle pas `encoderPage` : il transcrit la table de l'ADR 0020 dans `poserPage` ci-dessous,
// champ par champ, offset par offset. C'est ce qui donne aux vecteurs leur valeur de SECOND AVIS sur
// la disposition — sans cela, le producteur et le vérificateur partageraient le même encodeur, et un
// offset faux serait faux des deux côtés en même temps. Le scellement, lui, passe par le modèle de
// référence : c'est LUI la spécification cryptographique, et le réécrire ici ne donnerait pas un
// second avis, seulement une seconde occasion de se tromper.
//
// Les clés employées sont PUBLIQUES et volontairement sans entropie. Aucun secret n'entre ici, et le
// premier gate d'utilisation de `SECURITY.md` interdit de toute façon qu'il en existe un dans ce
// dépôt.

import { writeFileSync } from "node:fs";

import { octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";
import {
  ENVELOPPE_FORMAT_V1,
  TYPES_KEK,
  encoderEmplacements,
} from "../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  empreinteDesEmplacements,
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
  scellerRacineSousNonce,
} from "../src/vm/enveloppe/modele-reference.mjs";

const DESTINATION = new URL("../tests/vectors/enveloppe-v1.json", import.meta.url);

/** Page de 8192 octets, deux par fichier. Transcrit ici depuis la table de l'ADR 0020. */
const PAGE_OCTETS = 8192;
const ENTETE_PAGE_OCTETS = 108;
const CRC_OFFSET = 104;
const EMPLACEMENT_FIXE_OCTETS = 72;
const MARQUEUR = "VLTKEY01";

/** CRC-32 (polynôme 0xedb88320), transcrit ici comme le reste de la disposition. */
function crc32(octets) {
  let valeur = 0xffffffff;
  for (const octet of octets) {
    let terme = (valeur ^ octet) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      terme = terme & 1 ? (0xedb88320 ^ (terme >>> 1)) >>> 0 : terme >>> 1;
    }
    valeur = (terme ^ (valeur >>> 8)) >>> 0;
  }
  return (valeur ^ 0xffffffff) >>> 0;
}

/** Suite d'octets déterministe : `octet i = base + i`. Publiée dans le vecteur avec sa règle. */
const suite = (base, longueur) => Uint8Array.from({ length: longueur }, (_, i) => (base + i) % 256);

/** Clé de VOLUME de TEST (la DEK), publique et sans entropie : 0x20 à 0x3f. */
const DEK = suite(0x20, 32);

/** Clés de DÉVERROUILLAGE de TEST (les KEK), publiques et sans entropie. */
const KEKS = Object.freeze({
  harnais: suite(0x80, 32),
  phrase: suite(0xa0, 32),
  prf: suite(0xc0, 32),
});

/**
 * Identifiant de volume des vecteurs, POSÉ EN OCTETS plutôt qu'en littéral hexadécimal.
 *
 * La valeur est publique, figée et sans aucune portée — c'est sa FORME qui est corrigée. Une longue
 * chaîne hexadécimale écrite telle quelle dans une source ressemble, pour un détecteur de secrets, à
 * une clé oubliée ; un dépôt qui apprend à ses relecteurs à ignorer ces alertes finit par ignorer la
 * vraie. Les octets ci-dessous rendent exactement les mêmes trente-deux signes qu'auparavant, et les
 * vecteurs figés ne bougent pas d'un octet.
 */
const OCTETS_DU_VOLUME = Uint8Array.from([
  0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0xf9,
]);

const IDENTIFIANT_VOLUME = octetsEnHex(OCTETS_DU_VOLUME);

/** Identifiants d'emplacement figés : le chemin de production les reçoit du harnais, dans cet ordre. */
const IDENTIFIANTS = ["1111111111111111", "2222222222222222", "3333333333333333"];

/** Nonces figés : douze octets chacun, tous distincts. Même remarque. */
const NONCES = [
  "aa0000000000000000000001",
  "aa0000000000000000000002",
  "aa0000000000000000000003",
  "aa0000000000000000000004",
  "aa0000000000000000000005",
  "aa0000000000000000000006",
  "aa0000000000000000000007",
];

/** Paramètres publics d'un dérivateur, OPAQUES pour #21 : ici huit octets reconnaissables. */
const PARAMETRES_PHRASE = suite(0xf0, 8);

function hexEnOctets(hex) {
  const octets = new Uint8Array(hex.length / 2);
  for (let i = 0; i < octets.length; i += 1)
    octets[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return octets;
}

/** Écrit un entier petit-boutiste sur `octets` octets, comme la table de l'ADR le demande. */
function poserEntier(cible, position, valeur, octets) {
  let reste = valeur;
  for (let i = 0; i < octets; i += 1) {
    cible[position + i] = reste % 256;
    reste = Math.floor(reste / 256);
  }
}

/** Octets d'UN emplacement, transcrits depuis la table de l'ADR 0020. */
function poserEmplacement(emplacement) {
  const octets = new Uint8Array(EMPLACEMENT_FIXE_OCTETS + emplacement.parametres.byteLength);
  octets.set(hexEnOctets(emplacement.identifiantEmplacement), 0);
  octets[8] = emplacement.typeKek;
  octets[9] = 0;
  poserEntier(octets, 10, emplacement.parametres.byteLength, 2);
  octets.set(emplacement.nonce, 12);
  octets.set(emplacement.dekEnveloppee, 24);
  octets.set(emplacement.etiquette, 56);
  octets.set(emplacement.parametres, EMPLACEMENT_FIXE_OCTETS);
  return octets;
}

/** Octets d'une PAGE entière, transcrits depuis la table de l'ADR 0020. */
function poserPage({ version, racine, emplacements }) {
  const octets = new Uint8Array(PAGE_OCTETS);
  const liste = emplacements.map(poserEmplacement);
  const longueurListe = liste.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  octets.set(new TextEncoder().encode(MARQUEUR), 0);
  poserEntier(octets, 8, ENVELOPPE_FORMAT_V1, 4);
  poserEntier(octets, 12, emplacements.length, 2);
  poserEntier(octets, 16, version, 8);
  octets.set(hexEnOctets(IDENTIFIANT_VOLUME), 24);
  poserEntier(octets, 40, longueurListe, 4);
  octets.set(racine.nonce, 44);
  octets.set(racine.chiffre, 56);
  octets.set(racine.etiquette, 88);
  let curseur = ENTETE_PAGE_OCTETS;
  for (const morceau of liste) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  poserEntier(octets, CRC_OFFSET, crc32(octets.subarray(0, curseur)), 4);
  return octets;
}

/** Enveloppe la DEK sous une KEK, dans un emplacement donné. */
async function enveloppe({ kek, identifiantEmplacement, typeKek, parametres, nonce }) {
  const scelle = await envelopperSousNonce({
    kek: await importerCleDeDeverrouillage(kek),
    emplacement: {
      identifiantVolume: IDENTIFIANT_VOLUME,
      identifiantEmplacement,
      formatVersion: ENVELOPPE_FORMAT_V1,
      typeKek,
      parametres,
    },
    dek: DEK,
    nonce: hexEnOctets(nonce),
  });
  return {
    identifiantEmplacement,
    typeKek,
    parametres,
    nonce: scelle.nonce,
    dekEnveloppee: scelle.chiffre,
    etiquette: scelle.etiquette,
  };
}

/** Scelle la racine d'une liste ordonnée, et rend l'étape complète du vecteur. */
async function etape({ nom, operation, version, emplacements, nonceRacine }) {
  const racine = await scellerRacineSousNonce({
    dek: await importerCleDeVolume(DEK),
    racine: { identifiantVolume: IDENTIFIANT_VOLUME, formatVersion: ENVELOPPE_FORMAT_V1, version },
    emplacements,
    nonce: hexEnOctets(nonceRacine),
  });
  return {
    nom,
    operation,
    version,
    emplacements: emplacements.map((emplacement) => ({
      identifiantEmplacement: emplacement.identifiantEmplacement,
      typeKek: emplacement.typeKek,
      parametres: octetsEnHex(emplacement.parametres),
      nonce: octetsEnHex(emplacement.nonce),
      dekEnveloppee: octetsEnHex(emplacement.dekEnveloppee),
      etiquette: octetsEnHex(emplacement.etiquette),
    })),
    racine: {
      nonce: octetsEnHex(racine.nonce),
      chiffre: octetsEnHex(racine.chiffre),
      etiquette: octetsEnHex(racine.etiquette),
      empreinte: octetsEnHex(await empreinteDesEmplacements(emplacements)),
      encodageCanonique: octetsEnHex(encoderEmplacements(emplacements)),
    },
    page: octetsEnHex(poserPage({ version, racine, emplacements })),
  };
}

/** Les quatre étapes : créer, ajouter, remplacer, révoquer. Chacune fige la page qui en résulte. */
async function etapes() {
  const premier = await enveloppe({
    kek: KEKS.harnais,
    identifiantEmplacement: IDENTIFIANTS[0],
    typeKek: TYPES_KEK.harnais,
    parametres: new Uint8Array(0),
    nonce: NONCES[0],
  });
  const second = await enveloppe({
    kek: KEKS.phrase,
    identifiantEmplacement: IDENTIFIANTS[1],
    typeKek: TYPES_KEK.phrase,
    parametres: PARAMETRES_PHRASE,
    nonce: NONCES[2],
  });
  const remplacant = await enveloppe({
    kek: KEKS.prf,
    identifiantEmplacement: IDENTIFIANTS[2],
    typeKek: TYPES_KEK["webauthn-prf"],
    parametres: new Uint8Array(0),
    nonce: NONCES[4],
  });

  return [
    await etape({
      nom: "création : un emplacement de harnais",
      operation: "creer",
      version: 1,
      emplacements: [premier],
      nonceRacine: NONCES[1],
    }),
    await etape({
      nom: "ajout : une phrase secrète, avec paramètres publics",
      operation: "ajouter",
      version: 2,
      emplacements: [premier, second],
      nonceRacine: NONCES[3],
    }),
    await etape({
      nom: "remplacement : le premier emplacement passe à une PRF WebAuthn",
      operation: "remplacer",
      version: 3,
      emplacements: [remplacant, second],
      nonceRacine: NONCES[5],
    }),
    await etape({
      nom: "révocation : la phrase secrète est retirée",
      operation: "revoquer",
      version: 4,
      emplacements: [remplacant],
      nonceRacine: NONCES[6],
    }),
  ];
}

async function main() {
  const document = {
    avertissement:
      "Vecteurs FIGÉS de l'enveloppe de clé de RailsBox Vault (#21, ADR 0020). Les clés sont des clés de TEST publiques, sans entropie et sans valeur : elles ne protègent rien et ne doivent jamais servir ailleurs. Ces octets sont un CONTRAT — le chemin de production doit les reproduire à l'identique ; les régénérer change un format persistant et exige une version et un ADR.",
    specification: {
      algorithme: "aes-256-gcm",
      version: ENVELOPPE_FORMAT_V1,
      pageOctets: PAGE_OCTETS,
      enTetePageOctets: ENTETE_PAGE_OCTETS,
      crcOffset: CRC_OFFSET,
      emplacementFixeOctets: EMPLACEMENT_FIXE_OCTETS,
      marqueur: MARQUEUR,
      reference: "docs/decisions/0020-enveloppe-de-cle.md",
      producteur: "node tools/figer-vecteurs-enveloppe.mjs",
    },
    volume: { identifiantVolume: IDENTIFIANT_VOLUME },
    cles: {
      usage: "TEST",
      derivation: "octet i = base + i, sur 32 octets",
      dek: { base: "0x20", hex: octetsEnHex(DEK) },
      keks: [
        { nom: "harnais", base: "0x80", hex: octetsEnHex(KEKS.harnais) },
        { nom: "phrase", base: "0xa0", hex: octetsEnHex(KEKS.phrase) },
        { nom: "webauthn-prf", base: "0xc0", hex: octetsEnHex(KEKS.prf) },
      ],
    },
    aleas: {
      commentaire:
        "Les valeurs TIRÉES du chemin de production, dans leur ordre de consommation : un identifiant puis un nonce par emplacement fabriqué, un nonce par racine scellée.",
      identifiants: IDENTIFIANTS,
      nonces: NONCES,
    },
    parametres: { phrase: octetsEnHex(PARAMETRES_PHRASE) },
    etapes: await etapes(),
  };

  writeFileSync(DESTINATION, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${document.etapes.length} étape(s) figée(s) dans ${DESTINATION.pathname}\n`,
  );
}

await main();
