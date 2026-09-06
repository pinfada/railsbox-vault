#!/usr/bin/env node
// Fige les vecteurs de l'ARCHIVE V2 et de son enveloppe de récupération (#149, ADR 0027).
//
//     node tools/figer-vecteurs-archive.mjs
//
// Ce que ce script produit est un CONTRAT, pas un artefact de commodité : le chemin de production
// (`src/vm/volume-export.mjs`, `src/vm/enveloppe-de-recuperation.mjs`) doit reproduire ces octets à
// l'identique. Le relancer après avoir modifié le format ne CORRIGE donc rien — cela change un
// format persistant, ce qui exige une version et un ADR. `tests/unit/vm-archive-vecteurs.test.mjs`
// est là pour que ce changement rougisse au lieu de passer.
//
// ## Ce script POSE LES OCTETS DU CONTENEUR LUI-MÊME, et c'est le point
//
// Il n'appelle NI `writeArchive`, NI `encoderPage` : il transcrit la disposition de l'ADR 0027 —
// préambule, longueur d'en-tête, offsets des sections — et la table de page de l'ADR 0020, champ
// par champ. C'est ce qui donne aux vecteurs leur valeur de SECOND AVIS ; sans cela, le producteur
// et le vérificateur partageraient le même encodeur, et un offset faux serait faux des deux côtés
// en même temps.
//
// Deux choses ne sont PAS retranscrites, et il faut dire pourquoi :
//
//  - **le SCELLEMENT** passe par `enveloppe/modele-reference.mjs`. C'est LUI la spécification
//    cryptographique de l'ADR 0020 ; le réécrire ici ne donnerait pas un second avis, seulement une
//    seconde occasion de se tromper. C'est déjà le choix de `figer-vecteurs-enveloppe.mjs` ;
//  - **le MANIFESTE** passe par `createManifest` de #10. Ce vecteur fige la disposition de
//    l'ARCHIVE, pas l'encodage du manifeste, qui a ses propres épreuves ; le recopier ici
//    dupliquerait un contrat déjà tenu ailleurs et le ferait diverger au premier champ ajouté.
//
// Les clés employées sont PUBLIQUES et volontairement sans entropie. Aucun secret n'entre ici.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";
import { ENVELOPPE_FORMAT_V1, TYPES_KEK } from "../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
  scellerRacineSousNonce,
} from "../src/vm/enveloppe/modele-reference.mjs";
import { createManifest } from "../src/vm/volume-manifest.mjs";
import { tailleDeFichier } from "../src/vm/volume-chiffre-format.mjs";

const DESTINATION = new URL("../tests/vectors/archive-v2.json", import.meta.url);

// ---------------------------------------------------------------------------------------------
// La disposition, transcrite depuis l'ADR 0027 et l'ADR 0020. Rien n'est importé du chemin d'archive.
// ---------------------------------------------------------------------------------------------

const MARQUEUR_ARCHIVE = "RBVAULT1";
const PREAMBULE_OCTETS = 12;
const MARQUEUR_EN_TETE = "railsbox-vault/volume-archive";
const VERSION_ARCHIVE = 2;

const MARQUEUR_ENVELOPPE = "VLTKEY01";
const PAGE_OCTETS = 8192;
const ENTETE_PAGE_OCTETS = 108;
const CRC_OFFSET = 104;
const EMPLACEMENT_FIXE_OCTETS = 72;

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

/** Clés de DÉVERROUILLAGE de TEST : le harnais, et celle qu'un code de récupération dériverait. */
const KEK_HARNAIS = suite(0x80, 32);
const KEK_RECUPERATION = suite(0xd0, 32);

/**
 * Identifiant de volume du vecteur, POSÉ EN OCTETS plutôt qu'en littéral hexadécimal : une longue
 * chaîne hexadécimale écrite telle quelle ressemble, pour un détecteur de secrets, à une clé
 * oubliée, et un dépôt qui apprend à ignorer ces alertes finit par ignorer la vraie.
 */
const OCTETS_DU_VOLUME = Uint8Array.from([
  0xc0, 0xd1, 0xe2, 0xf3, 0x04, 0x15, 0x26, 0x37, 0x48, 0x59, 0x6a, 0x7b, 0x8c, 0x9d, 0xae, 0xbf,
]);
const IDENTIFIANT_VOLUME = octetsEnHex(OCTETS_DU_VOLUME);

/** Identifiants d'emplacement figés, dans l'ordre où le chemin de production les reçoit. */
const IDENTIFIANTS = { harnais: "4444444444444444", recuperation: "5555555555555555" };

/** Nonces figés : douze octets chacun, tous distincts. */
const NONCES = {
  harnais: "bb0000000000000000000001",
  racineV1: "bb0000000000000000000002",
  recuperation: "bb0000000000000000000003",
  racineV2: "bb0000000000000000000004",
  racineEmbarquee: "bb0000000000000000000005",
};

/**
 * Paramètres publics de l'emplacement de type 4, OPAQUES pour l'ADR 0020 et donc pour l'archive.
 *
 * Ce ne sont PAS les paramètres qu'un vrai moyen de récupération porte — ceux-là sont figés par
 * `tests/vectors/derivation-v1.json` (ADR 0025), et les redonner ici dupliquerait un contrat déjà
 * tenu. Ce vecteur fige le CONTENEUR ; l'opacité de ce champ est précisément ce que l'ADR 0020
 * décide, et l'employer telle quelle est la façon de la relire.
 */
const PARAMETRES_RECUPERATION = suite(0xe0, 40);

/** Taille logique du volume synthétique : quatre secteurs. Le contenu n'a pas à être ouvrable. */
const TAILLE_LOGIQUE = 2048;
const FORMAT_VOLUME = 3;

/** Contenu synthétique et déterministe. L'archive porte des octets ; elle ne les interprète pas. */
const CONTENU = Uint8Array.from(
  { length: tailleDeFichier({ formatVersion: FORMAT_VOLUME, tailleLogique: TAILLE_LOGIQUE }) },
  (_, index) => (index * 7 + 13) % 256,
);

const encodeur = new TextEncoder();

function hexEnOctets(hex) {
  const octets = new Uint8Array(hex.length / 2);
  for (let i = 0; i < octets.length; i += 1) {
    octets[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return octets;
}

/** SHA-256 en hexadécimal minuscule, par `node:crypto`. */
const empreinte = (octets) => createHash("sha256").update(octets).digest("hex");

/** Écrit un entier petit-boutiste sur `octets` octets, comme la table de l'ADR 0020 le demande. */
function poserEntierLE(cible, position, valeur, octets) {
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
  poserEntierLE(octets, 10, emplacement.parametres.byteLength, 2);
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
  octets.set(encodeur.encode(MARQUEUR_ENVELOPPE), 0);
  poserEntierLE(octets, 8, ENVELOPPE_FORMAT_V1, 4);
  poserEntierLE(octets, 12, emplacements.length, 2);
  poserEntierLE(octets, 16, version, 8);
  octets.set(hexEnOctets(IDENTIFIANT_VOLUME), 24);
  poserEntierLE(octets, 40, longueurListe, 4);
  octets.set(racine.nonce, 44);
  octets.set(racine.chiffre, 56);
  octets.set(racine.etiquette, 88);
  let curseur = ENTETE_PAGE_OCTETS;
  for (const morceau of liste) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  poserEntierLE(octets, CRC_OFFSET, crc32(octets.subarray(0, curseur)), 4);
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

/** Scelle une racine sur une liste ordonnée, et rend la page qui en résulte. */
async function pageScellee({ version, emplacements, nonceRacine }) {
  const racine = await scellerRacineSousNonce({
    dek: await importerCleDeVolume(DEK),
    racine: { identifiantVolume: IDENTIFIANT_VOLUME, formatVersion: ENVELOPPE_FORMAT_V1, version },
    emplacements,
    nonce: hexEnOctets(nonceRacine),
  });
  return { racine, octets: poserPage({ version, racine, emplacements }) };
}

/**
 * Les trois pages du vecteur : l'enveloppe complète telle que le volume la porte (v1 puis v2), et
 * la page EMBARQUÉE — la même version 2, filtrée aux seuls emplacements de type 4, RESCELLÉE.
 *
 * Publier les trois est ce qui rend le filtrage vérifiable : sans la page complète, on ne pourrait
 * pas voir que l'emplacement de harnais est resté dehors.
 */
async function pages() {
  const harnais = await enveloppe({
    kek: KEK_HARNAIS,
    identifiantEmplacement: IDENTIFIANTS.harnais,
    typeKek: TYPES_KEK.harnais,
    parametres: new Uint8Array(0),
    nonce: NONCES.harnais,
  });
  const recuperation = await enveloppe({
    kek: KEK_RECUPERATION,
    identifiantEmplacement: IDENTIFIANTS.recuperation,
    typeKek: TYPES_KEK.recuperation,
    parametres: PARAMETRES_RECUPERATION,
    nonce: NONCES.recuperation,
  });

  const creation = await pageScellee({
    version: 1,
    emplacements: [harnais],
    nonceRacine: NONCES.racineV1,
  });
  const complete = await pageScellee({
    version: 2,
    emplacements: [harnais, recuperation],
    nonceRacine: NONCES.racineV2,
  });
  const embarquee = await pageScellee({
    version: 2,
    emplacements: [recuperation],
    nonceRacine: NONCES.racineEmbarquee,
  });
  return { creation, complete, embarquee };
}

/**
 * Pose l'ARCHIVE entière : préambule, en-tête JSON, contenu, section de récupération.
 *
 * L'ordre des champs de l'en-tête est celui que l'ADR 0027 fixe — `magic`, `archiveFormatVersion`,
 * `content`, `recovery`, `manifest` — et il compte : l'archive est comparée OCTET POUR OCTET, et
 * `JSON.stringify` suit l'ordre d'insertion.
 */
function poserArchive({ manifeste, digestContenu, page }) {
  const enTete = {
    magic: MARQUEUR_EN_TETE,
    archiveFormatVersion: VERSION_ARCHIVE,
    content: {
      algorithm: manifeste.identity.algorithm,
      digest: digestContenu,
      length: CONTENU.byteLength,
      consistency: { kind: "handle-exclusif", detail: "vecteur figé de l'ADR 0027" },
    },
    recovery: {
      length: page.byteLength,
      digest: empreinte(page),
      envelopeVersion: 2,
      slots: 1,
    },
    manifest: manifeste,
  };
  const octetsEnTete = encodeur.encode(JSON.stringify(enTete));
  const archive = new Uint8Array(
    PREAMBULE_OCTETS + octetsEnTete.byteLength + CONTENU.byteLength + page.byteLength,
  );
  archive.set(encodeur.encode(MARQUEUR_ARCHIVE), 0);
  new DataView(archive.buffer).setUint32(8, octetsEnTete.byteLength, false);
  archive.set(octetsEnTete, PREAMBULE_OCTETS);
  archive.set(CONTENU, PREAMBULE_OCTETS + octetsEnTete.byteLength);
  archive.set(page, PREAMBULE_OCTETS + octetsEnTete.byteLength + CONTENU.byteLength);
  return { enTete, octetsEnTete, archive };
}

async function main() {
  const trois = await pages();
  const digestContenu = empreinte(CONTENU);
  const manifeste = createManifest({
    formatVersion: FORMAT_VOLUME,
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app: { id: "railsbox-vault-reference", version: "1.0.0" },
    volumeSize: TAILLE_LOGIQUE,
    identity: { algorithm: "sha-256", digest: digestContenu },
    volume: { id: IDENTIFIANT_VOLUME, algorithm: "aes-256-gcm" },
  });
  const pose = poserArchive({ manifeste, digestContenu, page: trois.embarquee.octets });

  const document = {
    avertissement:
      "Vecteurs FIGÉS de l'archive v2 de RailsBox Vault (#149, ADR 0027). Les clés sont des clés de TEST publiques, sans entropie et sans valeur : elles ne protègent rien et ne doivent jamais servir ailleurs. Ces octets sont un CONTRAT — le chemin de production doit les reproduire à l'identique ; les régénérer change un format persistant et exige une version et un ADR.",
    specification: {
      versionArchive: VERSION_ARCHIVE,
      marqueurArchive: MARQUEUR_ARCHIVE,
      marqueurEnTete: MARQUEUR_EN_TETE,
      preambuleOctets: PREAMBULE_OCTETS,
      disposition:
        "[marqueur 8][longueur d'en-tête uint32 BE 4][en-tête JSON H][contenu N][récupération R]",
      versionEnveloppe: ENVELOPPE_FORMAT_V1,
      pageOctets: PAGE_OCTETS,
      marqueurEnveloppe: MARQUEUR_ENVELOPPE,
      typeEmbarque: TYPES_KEK.recuperation,
      reference: "docs/decisions/0027-archive-et-ancre-de-version.md",
      producteur: "node tools/figer-vecteurs-archive.mjs",
    },
    volume: {
      identifiantVolume: IDENTIFIANT_VOLUME,
      formatVersion: FORMAT_VOLUME,
      tailleLogique: TAILLE_LOGIQUE,
      tailleFichier: CONTENU.byteLength,
      motifDuContenu: "octet i = (i * 7 + 13) mod 256",
    },
    cles: {
      usage: "TEST",
      derivation: "octet i = base + i, sur 32 octets",
      dek: { base: "0x20", hex: octetsEnHex(DEK) },
      keks: [
        { nom: "harnais", base: "0x80", hex: octetsEnHex(KEK_HARNAIS) },
        { nom: "recuperation", base: "0xd0", hex: octetsEnHex(KEK_RECUPERATION) },
      ],
    },
    aleas: {
      commentaire:
        "Les valeurs TIRÉES du chemin de production, dans leur ordre de consommation : un identifiant puis un nonce par emplacement fabriqué, un nonce par racine scellée. La racine EMBARQUÉE en consomme un de plus : la page de l'archive est rescellée sur la liste filtrée.",
      identifiants: IDENTIFIANTS,
      nonces: NONCES,
      parametresRecuperation: octetsEnHex(PARAMETRES_RECUPERATION),
    },
    enveloppe: {
      creation: { version: 1, emplacements: 1, page: octetsEnHex(trois.creation.octets) },
      complete: {
        version: 2,
        emplacements: 2,
        commentaire: "ce que le volume porte : le harnais ET le moyen de récupération",
        page: octetsEnHex(trois.complete.octets),
      },
      embarquee: {
        version: 2,
        emplacements: 1,
        commentaire:
          "ce que l'archive emporte : la MÊME version, filtrée aux seuls emplacements de type 4, racine RESCELLÉE sur la liste filtrée",
        empreinte: empreinte(trois.embarquee.octets),
        page: octetsEnHex(trois.embarquee.octets),
      },
    },
    archive: {
      enTete: pose.enTete,
      longueurEnTete: pose.octetsEnTete.byteLength,
      offsetDuContenu: PREAMBULE_OCTETS + pose.octetsEnTete.byteLength,
      offsetDeLaRecuperation: PREAMBULE_OCTETS + pose.octetsEnTete.byteLength + CONTENU.byteLength,
      longueurTotale: pose.archive.byteLength,
      empreinteDuContenu: digestContenu,
      hex: octetsEnHex(pose.archive),
    },
  };

  writeFileSync(DESTINATION, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Archive v2 de ${pose.archive.byteLength} octets figée dans ${DESTINATION.pathname}\n`,
  );
}

await main();
