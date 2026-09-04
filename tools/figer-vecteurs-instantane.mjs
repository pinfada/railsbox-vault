#!/usr/bin/env node
// Fige les vecteurs de l'INSTANTANÉ DE REPRISE (#65, ADR 0024).
//
//     node tools/figer-vecteurs-instantane.mjs
//
// Ce script est un SECOND AVIS, pas une commodité : il pose les octets de l'en-tête et des données
// associées LUI-MÊME, depuis la table de l'ADR 0024, sans appeler `encoderEnTete` ni
// `encoderLiaison`. Si le chemin de production et ce producteur divergent d'un octet,
// `tests/unit/vm-instantane-vecteurs.test.mjs` rougit — ce qui est exactement le service attendu.
//
// Ce qu'il PARTAGE avec le chemin de production, et il faut le dire : WebCrypto. Les vecteurs
// prouvent la DISPOSITION et les DONNÉES ASSOCIÉES, pas la primitive AES-GCM du moteur.
//
// Relancer ce script après avoir modifié le format ne CORRIGE rien : cela change un format
// persistant, ce qui exige une version et un ADR.
//
// La clé employée est PUBLIQUE et sans entropie (0x00 à 0x1f) : la même que celle des vecteurs de
// l'ADR 0015, pour qu'un relecteur n'ait qu'une clé de test à connaître.

import { writeFileSync } from "node:fs";

import { hexEnOctets, octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";
import { importerCleDeVolume } from "../src/vm/instantane/modele-reference.mjs";

const DESTINATION = new URL("../tests/vectors/instantane-v1.json", import.meta.url);

/** Clé de TEST, publique, sans entropie. Jamais un secret : 0x00 à 0x1f. */
const CLE_DE_TEST = Uint8Array.from({ length: 32 }, (_, index) => index);

const ALGORITHME = "aes-256-gcm";
const DOMAINE = "railsbox-vault/instantane-de-reprise/v1/liaison";
const FORMAT_INSTANTANE = 1;
const MARQUEUR = "564c54534e503031"; // "VLTSNP01"

/** Contenu déterministe, publié avec sa règle : `octet i = (i * 11 + graine) mod 256`. */
function etatDeMesure(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 11 + graine) % 256);
}

/** Empreinte déterministe de 32 octets : `octet i = (i * facteur + decalage) mod 256`. */
function empreinte(facteur, decalage) {
  return Uint8Array.from({ length: 32 }, (_, index) => (index * facteur + decalage) % 256);
}

function nonceDeMesure(base) {
  return Uint8Array.from({ length: 12 }, (_, index) => (base + index) % 256);
}

// --------------------------------------------------------------- encodeurs POSÉS À LA MAIN

/** Entier gros-boutiste sur `octets` octets, comme les données associées de l'ADR 0015. */
function grosBoutiste(valeur, octets) {
  const rendu = new Uint8Array(octets);
  let reste = valeur;
  for (let index = octets - 1; index >= 0; index -= 1) {
    rendu[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  return rendu;
}

/** Entier petit-boutiste sur `octets` octets, comme l'en-tête sur le support. */
function petitBoutiste(valeur, octets) {
  const rendu = new Uint8Array(octets);
  let reste = valeur;
  for (let index = 0; index < octets; index += 1) {
    rendu[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  return rendu;
}

function chainePrefixee(texte) {
  const utf8 = new TextEncoder().encode(texte);
  return joindre([grosBoutiste(utf8.byteLength, 2), utf8]);
}

function joindre(morceaux) {
  const total = morceaux.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  const rendu = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of morceaux) {
    rendu.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return rendu;
}

/** Les données associées, posées depuis la table de l'ADR 0024, décision 3. */
function donneesAssociees(liaison) {
  return joindre([
    chainePrefixee(DOMAINE),
    chainePrefixee(ALGORITHME),
    grosBoutiste(FORMAT_INSTANTANE, 4),
    grosBoutiste(liaison.formatVolume, 4),
    chainePrefixee(liaison.volume),
    grosBoutiste(liaison.sequence, 8),
    grosBoutiste(liaison.generation, 8),
    liaison.empreinteRegion,
    liaison.empreinteImage,
    grosBoutiste(liaison.longueurEtat, 8),
  ]);
}

/** L'en-tête, posé depuis la table de l'ADR 0024, décision 2. Chaque champ à son offset écrit. */
function enTete(liaison, nonce, etiquette) {
  const octets = new Uint8Array(152);
  octets.set(hexEnOctets(MARQUEUR), 0);
  octets.set(petitBoutiste(FORMAT_INSTANTANE, 4), 8);
  octets.set(petitBoutiste(liaison.formatVolume, 4), 12);
  octets.set(hexEnOctets(liaison.volume), 16);
  octets.set(petitBoutiste(liaison.sequence, 8), 32);
  octets.set(petitBoutiste(liaison.generation, 8), 40);
  octets.set(petitBoutiste(liaison.longueurEtat, 8), 48);
  octets.set(liaison.empreinteRegion, 56);
  octets.set(liaison.empreinteImage, 88);
  octets.set(nonce, 120);
  octets.set(etiquette, 132);
  // 148..152 : réserve, laissée à zéro.
  return octets;
}

// ------------------------------------------------------------------------------ les cas

const VOLUME_A = "0123456789abcdef0123456789abcdef";
const VOLUME_B = "fedcba9876543210fedcba9876543210";

const CAS = [
  {
    nom: "capture nominale d'un volume applicatif",
    couvre: ["volume", "sequence", "generation", "region", "image", "longueur"],
    scellementsCumules: 0,
    nonce: nonceDeMesure(0xa0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 3,
      sequence: 42,
      generation: 17,
      empreinteRegion: empreinte(3, 1),
      empreinteImage: empreinte(5, 7),
      longueurEtat: 4096,
    },
    etat: etatDeMesure(4096, 0),
  },
  {
    nom: "même volume, séquence et génération suivantes",
    couvre: ["sequence", "generation"],
    scellementsCumules: 1,
    nonce: nonceDeMesure(0xb0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 3,
      sequence: 43,
      generation: 18,
      empreinteRegion: empreinte(3, 1),
      empreinteImage: empreinte(5, 7),
      longueurEtat: 4096,
    },
    etat: etatDeMesure(4096, 0),
  },
  {
    nom: "même état, AUTRE volume",
    couvre: ["volume"],
    scellementsCumules: 2,
    nonce: nonceDeMesure(0xc0),
    liaison: {
      volume: VOLUME_B,
      formatVolume: 3,
      sequence: 42,
      generation: 17,
      empreinteRegion: empreinte(3, 1),
      empreinteImage: empreinte(5, 7),
      longueurEtat: 4096,
    },
    etat: etatDeMesure(4096, 0),
  },
  {
    nom: "même volume, AUTRE région et AUTRE image de référence",
    couvre: ["region", "image"],
    scellementsCumules: 3,
    nonce: nonceDeMesure(0xd0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 3,
      sequence: 42,
      generation: 17,
      empreinteRegion: empreinte(7, 11),
      empreinteImage: empreinte(13, 3),
      longueurEtat: 4096,
    },
    etat: etatDeMesure(4096, 0),
  },
  {
    nom: "état d'un seul secteur : la longueur entre dans les données associées",
    couvre: ["longueur"],
    scellementsCumules: 4,
    nonce: nonceDeMesure(0xe0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 3,
      sequence: 42,
      generation: 17,
      empreinteRegion: empreinte(3, 1),
      empreinteImage: empreinte(5, 7),
      longueurEtat: 512,
    },
    etat: etatDeMesure(512, 0),
  },
];

async function principal() {
  const cle = await importerCleDeVolume(CLE_DE_TEST);
  const cas = [];
  for (const modele of CAS) {
    const associees = donneesAssociees(modele.liaison);
    const brut = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: modele.nonce, additionalData: associees, tagLength: 128 },
        cle,
        modele.etat,
      ),
    );
    const chiffre = brut.slice(0, brut.byteLength - 16);
    const etiquette = brut.slice(brut.byteLength - 16);
    cas.push({
      nom: modele.nom,
      couvre: modele.couvre,
      scellementsCumules: modele.scellementsCumules,
      liaison: {
        volume: modele.liaison.volume,
        formatInstantane: FORMAT_INSTANTANE,
        formatVolume: modele.liaison.formatVolume,
        sequence: modele.liaison.sequence,
        generation: modele.liaison.generation,
        empreinteRegion: octetsEnHex(modele.liaison.empreinteRegion),
        empreinteImage: octetsEnHex(modele.liaison.empreinteImage),
        longueurEtat: modele.liaison.longueurEtat,
      },
      etat: octetsEnHex(modele.etat),
      nonce: octetsEnHex(modele.nonce),
      donneesAssociees: octetsEnHex(associees),
      enTete: octetsEnHex(enTete(modele.liaison, modele.nonce, etiquette)),
      chiffre: octetsEnHex(chiffre),
      etiquette: octetsEnHex(etiquette),
    });
  }

  const vecteurs = {
    specification: "railsbox-vault/instantane-de-reprise/v1",
    adr: "docs/decisions/0024-instantane-de-reprise.md",
    produitPar: "tools/figer-vecteurs-instantane.mjs",
    avertissement:
      "Ces octets sont un CONTRAT. Les régénérer n'est pas une correction : c'est un changement de format persistant, qui exige une version et un ADR.",
    algorithme: ALGORITHME,
    domaine: DOMAINE,
    formatInstantane: FORMAT_INSTANTANE,
    disposition: {
      enTeteOctets: 152,
      marqueOctets: 8,
      marqueurEnTete: MARQUEUR,
      marqueurComplet: "564c54534e504631",
    },
    cle: {
      role: "clé de volume de TEST, publique et sans entropie",
      hex: octetsEnHex(CLE_DE_TEST),
    },
    cas,
  };

  writeFileSync(DESTINATION, `${JSON.stringify(vecteurs, null, 2)}\n`, "utf8");
  console.log(`${cas.length} cas figés dans ${DESTINATION.pathname}`);
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
