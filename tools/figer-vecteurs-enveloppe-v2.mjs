#!/usr/bin/env node
// Fige les vecteurs de la PAGE D'ENVELOPPE **v2** et de la page de RÉCUPÉRATION (#182, T2b ;
// ADR 0020, ADR 0027, ADR 0033).
//
//     node tools/figer-vecteurs-enveloppe-v2.mjs
//
// Ce que ce script produit est un CONTRAT, pas un artefact de commodité : le chemin de production
// doit reproduire ces octets à l'identique. Le relancer après avoir modifié le format ne CORRIGE
// donc rien — cela change un format persistant, ce qui exige une version et un ADR. L'épreuve
// `tests/unit/vm-enveloppe-v2-vecteurs.test.mjs` est là pour que ce changement rougisse.
//
// ## Pourquoi un second fichier plutôt qu'une étape de plus dans le premier
//
// `figer-vecteurs-enveloppe.mjs` fige les pages **v1**, que le produit n'écrit plus. Ces octets sont
// désormais des vecteurs de MIGRATION, et la meilleure garantie qu'ils ne bougeront pas est que
// l'outil qui les produit ne soit plus touché. Celui-ci vit à côté, il produit le format COURANT,
// et le jour où une v3 de page arrivera, la même règle s'appliquera.
//
// ## Il POSE LES OCTETS LUI-MÊME, et il DÉRIVE LA CLÉ LUI-MÊME
//
// Deux transcriptions indépendantes, jamais une (ADR 0021, décision 2) :
//
//  - la DISPOSITION est transcrite depuis la table de l'ADR 0020 telle que la v2 l'amende — `poserPage`
//    ci-dessous —, et non obtenue par `encoderPage`. Sans cela, le producteur et le vérificateur
//    partageraient le même encodeur et un offset faux le serait des deux côtés à la fois ;
//  - la DÉRIVATION passe par `node:crypto` directement — `deriveBits` puis `importKey` —, et non par
//    `deriverCleDeDomaine`. C'est ce qui permet de PUBLIER les trente-deux octets de la clé dérivée :
//    le produit, lui, ne les fait jamais exister, et c'est une propriété qu'on garde.
//
// Le SCELLEMENT, lui, passe par le modèle de référence de l'ADR 0020 : c'est LUI la spécification
// cryptographique, et le réécrire ici ne donnerait pas un second avis, seulement une seconde
// occasion de se tromper.
//
// Les clés employées sont PUBLIQUES et volontairement sans entropie.

import { webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";

import { octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";
import {
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  TYPES_KEK,
  encoderEmplacements,
} from "../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  empreinteDesEmplacements,
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  scellerRacineSousNonce,
} from "../src/vm/enveloppe/modele-reference.mjs";

const DESTINATION = new URL("../tests/vectors/enveloppe-v2.json", import.meta.url);

/** Disposition d'une page v2, transcrite depuis la table de l'ADR 0020 amendée par #182. */
const PAGE_OCTETS = 8192;
const ENTETE_PAGE_OCTETS = 140;
const DOMAINE_OFFSET = 14;
const SEL_OFFSET = 104;
const SEL_OCTETS = 32;
const CRC_OFFSET = 136;
const EMPLACEMENT_FIXE_OCTETS = 72;
const MARQUEUR = "VLTKEY01";

/** L'étiquette du SCHÉMA de dérivation, transcrite depuis l'ADR 0033, décision 3. */
const ETIQUETTE_SCHEMA = "railsbox-vault/derivation-de-domaine/v1";
const ALGORITHME = "aes-256-gcm";

/** Les deux domaines qui scellent une racine de page, et l'octet que l'en-tête leur donne. */
const DOMAINES_DE_PAGE = Object.freeze([
  { nom: "enveloppe", octet: 1, versionDeFormat: 2 },
  { nom: "recuperation", octet: 2, versionDeFormat: 2 },
]);

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
const KEKS = Object.freeze({ harnais: suite(0x80, 32), recuperation: suite(0xd0, 32) });

/** Identifiant de volume des vecteurs, posé EN OCTETS plutôt qu'en littéral hexadécimal. */
const OCTETS_DU_VOLUME = Uint8Array.from([
  0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0xf9,
]);
const IDENTIFIANT_VOLUME = octetsEnHex(OCTETS_DU_VOLUME);

/** Identifiants d'emplacement figés, dans l'ordre où le harnais les rend. */
const IDENTIFIANTS = ["4141414141414141", "5252525252525252"];

/** Nonces figés : douze octets chacun, tous distincts. */
const NONCES = Object.freeze({
  harnais: "cc0000000000000000000001",
  recuperation: "cc0000000000000000000002",
  racineEnveloppe: "cc0000000000000000000003",
  racineRecuperation: "cc0000000000000000000004",
});

/** SELS figés : trente-deux octets chacun. Le produit les TIRE ; le harnais les fixe. */
const SELS = Object.freeze({
  enveloppe: octetsEnHex(suite(0x60, SEL_OCTETS)),
  recuperation: octetsEnHex(suite(0x90, SEL_OCTETS)),
});

/** Paramètres publics du moyen de récupération, OPAQUES pour l'enveloppe : ici huit octets. */
const PARAMETRES_RECUPERATION = suite(0xe0, 8);

function hexEnOctets(hex) {
  const octets = new Uint8Array(hex.length / 2);
  for (let i = 0; i < octets.length; i += 1) {
    octets[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
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

/** Champ PRÉFIXÉ DE SA LONGUEUR sur deux octets GROS-BOUTISTES (ADR 0033, décision 3). */
function chainePrefixee(texte) {
  const octets = new TextEncoder().encode(texte);
  const morceau = new Uint8Array(2 + octets.byteLength);
  morceau[0] = (octets.byteLength >> 8) & 0xff;
  morceau[1] = octets.byteLength & 0xff;
  morceau.set(octets, 2);
  return morceau;
}

/** Entier sur quatre octets GROS-BOUTISTES. */
function entierBe(valeur, longueur) {
  const octets = new Uint8Array(longueur);
  let reste = valeur;
  for (let index = longueur - 1; index >= 0; index -= 1) {
    octets[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  return octets;
}

function concatener(morceaux) {
  const total = morceaux.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  const octets = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of morceaux) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return octets;
}

/** L'INFO que HKDF reçoit pour un domaine, transcrite depuis l'ADR 0033, décision 3. */
function infoDeDomaine(domaine, versionDeFormat) {
  return concatener([
    chainePrefixee(ETIQUETTE_SCHEMA),
    chainePrefixee(domaine),
    chainePrefixee(IDENTIFIANT_VOLUME),
    entierBe(versionDeFormat, 4),
    chainePrefixee(ALGORITHME),
  ]);
}

/**
 * DÉRIVE la clé d'un domaine et rend ses OCTETS avec la clé importée.
 *
 * Le produit ne fait jamais exister ces octets — `deriveKey` les garde du côté du moteur. Ici on les
 * publie, et c'est la raison d'être d'un vecteur : un relecteur doit pouvoir refaire HKDF avec sa
 * propre bibliothèque et comparer trente-deux octets.
 */
async function deriverPourLeVecteur({ domaine, versionDeFormat, sel }) {
  const info = infoDeDomaine(domaine, versionDeFormat);
  const materiau = await webcrypto.subtle.importKey("raw", DEK, "HKDF", false, ["deriveBits"]);
  const brut = new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: hexEnOctets(sel), info },
      materiau,
      256,
    ),
  );
  const cle = await webcrypto.subtle.importKey("raw", brut, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { info, octets: brut, cle };
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

/** Octets d'une PAGE v2 entière, transcrits depuis la table amendée par #182. */
function poserPage({ version, racine, emplacements, sel, domaine }) {
  const octets = new Uint8Array(PAGE_OCTETS);
  const liste = emplacements.map(poserEmplacement);
  const longueurListe = liste.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  octets.set(new TextEncoder().encode(MARQUEUR), 0);
  poserEntier(octets, 8, ENVELOPPE_FORMAT_V2, 4);
  poserEntier(octets, 12, emplacements.length, 2);
  octets[DOMAINE_OFFSET] = domaine;
  poserEntier(octets, 16, version, 8);
  octets.set(hexEnOctets(IDENTIFIANT_VOLUME), 24);
  poserEntier(octets, 40, longueurListe, 4);
  octets.set(racine.nonce, 44);
  octets.set(racine.chiffre, 56);
  octets.set(racine.etiquette, 88);
  octets.set(hexEnOctets(sel), SEL_OFFSET);
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
      formatVersion: EMPLACEMENT_FORMAT_V1,
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

/** Une PAGE figée : sa clé dérivée, sa racine, ses emplacements et ses octets. */
async function pageFigee({ domaine, version, emplacements, sel, nonceRacine }) {
  const derivee = await deriverPourLeVecteur({
    domaine: domaine.nom,
    versionDeFormat: domaine.versionDeFormat,
    sel,
  });
  const racine = await scellerRacineSousNonce({
    cleDeRacine: derivee.cle,
    racine: { identifiantVolume: IDENTIFIANT_VOLUME, formatVersion: ENVELOPPE_FORMAT_V2, version },
    emplacements,
    nonce: hexEnOctets(nonceRacine),
  });
  return {
    domaine: domaine.nom,
    octetDeDomaine: domaine.octet,
    versionDeFormatDuDomaine: domaine.versionDeFormat,
    sel,
    info: octetsEnHex(derivee.info),
    cleDerivee: octetsEnHex(derivee.octets),
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
    page: octetsEnHex(poserPage({ version, racine, emplacements, sel, domaine: domaine.octet })),
  };
}

/**
 * Les DEUX pages : celle de `<volume>.cles`, et celle qu'une archive emporte.
 *
 * La seconde est la PREMIÈRE FILTRÉE : elle ne porte que l'emplacement de type 4, comme l'ADR 0027
 * l'impose, et elle porte la MÊME version — c'est elle que l'ancre de la décision 3 compare à la
 * feuille de récupération. C'est le filtrage lui-même qui est figé : les deux pages diffèrent.
 */
async function pages() {
  const harnais = await enveloppe({
    kek: KEKS.harnais,
    identifiantEmplacement: IDENTIFIANTS[0],
    typeKek: TYPES_KEK.harnais,
    parametres: new Uint8Array(0),
    nonce: NONCES.harnais,
  });
  const recuperation = await enveloppe({
    kek: KEKS.recuperation,
    identifiantEmplacement: IDENTIFIANTS[1],
    typeKek: TYPES_KEK.recuperation,
    parametres: PARAMETRES_RECUPERATION,
    nonce: NONCES.recuperation,
  });

  return {
    complete: await pageFigee({
      domaine: DOMAINES_DE_PAGE[0],
      version: 2,
      emplacements: [harnais, recuperation],
      sel: SELS.enveloppe,
      nonceRacine: NONCES.racineEnveloppe,
    }),
    embarquee: await pageFigee({
      domaine: DOMAINES_DE_PAGE[1],
      version: 2,
      emplacements: [recuperation],
      sel: SELS.recuperation,
      nonceRacine: NONCES.racineRecuperation,
    }),
  };
}

async function main() {
  const document = {
    avertissement:
      "Vecteurs FIGÉS de la page d'enveloppe v2 de RailsBox Vault (#182, ADR 0020, ADR 0027, ADR 0033). Les clés sont des clés de TEST publiques, sans entropie et sans valeur : elles ne protègent rien et ne doivent jamais servir ailleurs. Ces octets sont un CONTRAT — le chemin de production doit les reproduire à l'identique ; les régénérer change un format persistant et exige une version et un ADR.",
    specification: {
      algorithme: ALGORITHME,
      version: ENVELOPPE_FORMAT_V2,
      pageOctets: PAGE_OCTETS,
      enTetePageOctets: ENTETE_PAGE_OCTETS,
      domaineOffset: DOMAINE_OFFSET,
      selOffset: SEL_OFFSET,
      selOctets: SEL_OCTETS,
      crcOffset: CRC_OFFSET,
      emplacementFixeOctets: EMPLACEMENT_FIXE_OCTETS,
      emplacementFormatVersion: EMPLACEMENT_FORMAT_V1,
      marqueur: MARQUEUR,
      etiquetteDuSchemaDeDerivation: ETIQUETTE_SCHEMA,
      references: [
        "docs/decisions/0020-enveloppe-de-cle.md",
        "docs/decisions/0027-archive-et-ancre-de-version.md",
        "docs/decisions/0033-hierarchie-de-cles-derivees-par-domaine.md",
        "docs/decisions/0036-page-d-enveloppe-v2-et-budgets-exhaustifs.md",
      ],
      producteur: "node tools/figer-vecteurs-enveloppe-v2.mjs",
    },
    volume: { identifiantVolume: IDENTIFIANT_VOLUME },
    cles: {
      usage: "TEST",
      derivation: "octet i = base + i, sur 32 octets",
      dek: { base: "0x20", hex: octetsEnHex(DEK) },
      keks: [
        { nom: "harnais", base: "0x80", hex: octetsEnHex(KEKS.harnais) },
        { nom: "recuperation", base: "0xd0", hex: octetsEnHex(KEKS.recuperation) },
      ],
    },
    aleas: {
      commentaire:
        "Les valeurs TIRÉES du chemin de production, dans leur ordre de consommation : un identifiant, un nonce et — depuis la v2 — un SEL de trente-deux octets par page scellée. Le sel porte l'unicité de la clé de racine ; l'info porte la séparation des domaines.",
      identifiants: IDENTIFIANTS,
      nonces: NONCES,
      sels: SELS,
      parametresRecuperation: octetsEnHex(PARAMETRES_RECUPERATION),
    },
    pages: await pages(),
  };

  writeFileSync(DESTINATION, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(`2 page(s) v2 figée(s) dans ${DESTINATION.pathname}\n`);
}

await main();
