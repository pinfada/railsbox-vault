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
//
// **Après régénération, passer `npm run format`** : `JSON.stringify` éclate les courts tableaux que
// Prettier recolle, et `npm run check` contrôle le formatage du dépôt entier, fichiers de vecteurs
// compris. Les OCTETS ne changent pas pour autant — seule leur mise en page bouge.

import { writeFileSync } from "node:fs";

import { hexEnOctets, octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";

const DESTINATION = new URL("../tests/vectors/instantane-v2.json", import.meta.url);

/** Clé de TEST, publique, sans entropie. Jamais un secret : 0x00 à 0x1f. */
const CLE_DE_TEST = Uint8Array.from({ length: 32 }, (_, index) => index);

const ALGORITHME = "aes-256-gcm";
const DOMAINE = "railsbox-vault/instantane-de-reprise/v1/liaison";
const FORMAT_INSTANTANE = 2;
const MARQUEUR = "564c54534e503032"; // "VLTSNP02"

/**
 * L'étiquette du SCHÉMA de dérivation par domaine (ADR 0033, décision 3), posée ICI à la main.
 *
 * Depuis #182, une capture n'est plus scellée sous la DEK : elle l'est sous une clé du domaine
 * `instantane`, à USAGE UNIQUE, tirée d'un sel de trente-deux octets écrit en clair dans l'en-tête.
 * Ce producteur redérive donc la clé lui-même, par HKDF-SHA-256 sur la DEK publiée, sans importer
 * une ligne de `src/vm/derivation/` : c'est ce qui fait de ces vecteurs un second avis.
 */
const ETIQUETTE_SCHEMA_DE_DOMAINE = "railsbox-vault/derivation-de-domaine/v1";
const DOMAINE_INSTANTANE = "instantane";
const SEL_OCTETS = 32;
const EN_TETE_OCTETS = 184;

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

/** L'INFO que HKDF reçoit pour le domaine `instantane`, posée champ par champ (ADR 0033, déc. 3). */
function infoDeDomaine(volume) {
  return joindre([
    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),
    chainePrefixee(DOMAINE_INSTANTANE),
    chainePrefixee(volume),
    grosBoutiste(FORMAT_INSTANTANE, 4),
    chainePrefixee(ALGORITHME),
  ]);
}

/** Sel DÉTERMINISTE d'un cas : `octet i = (i * 17 + graine) mod 256`. Le produit, lui, le TIRE. */
function selDeMesure(graine) {
  return Uint8Array.from({ length: SEL_OCTETS }, (_, index) => (index * 17 + graine) % 256);
}

/** La clé du domaine `instantane` de ce volume, redérivée à la main par HKDF-SHA-256. */
async function cleDuDomaine(volume, sel) {
  const base = await crypto.subtle.importKey("raw", CLE_DE_TEST, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: sel, info: infoDeDomaine(volume) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** L'en-tête, posé depuis la table de l'ADR 0024, décision 2. Chaque champ à son offset écrit. */
function enTete(liaison, nonce, etiquette, sel) {
  const octets = new Uint8Array(EN_TETE_OCTETS);
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
  octets.set(sel, 148);
  // 180..184 : réserve, laissée à zéro.
  return octets;
}

// ------------------------------------------------------------------------------ les cas

const VOLUME_A = "0123456789abcdef0123456789abcdef";
const VOLUME_B = "fedcba9876543210fedcba9876543210";

const CAS = [
  {
    nom: "capture nominale d'un volume applicatif",
    couvre: ["volume", "sequence", "generation", "region", "image", "longueur"],
    graineDeSel: 16,
    nonce: nonceDeMesure(0xa0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 4,
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
    graineDeSel: 32,
    nonce: nonceDeMesure(0xb0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 4,
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
    graineDeSel: 48,
    nonce: nonceDeMesure(0xc0),
    liaison: {
      volume: VOLUME_B,
      formatVolume: 4,
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
    graineDeSel: 64,
    nonce: nonceDeMesure(0xd0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 4,
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
    graineDeSel: 80,
    nonce: nonceDeMesure(0xe0),
    liaison: {
      volume: VOLUME_A,
      formatVolume: 4,
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
  const cas = [];
  for (const modele of CAS) {
    const sel = selDeMesure(modele.graineDeSel);
    const cle = await cleDuDomaine(modele.liaison.volume, sel);
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
      sel: octetsEnHex(sel),
      info: octetsEnHex(infoDeDomaine(modele.liaison.volume)),
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
      enTete: octetsEnHex(enTete(modele.liaison, modele.nonce, etiquette, sel)),
      chiffre: octetsEnHex(chiffre),
      etiquette: octetsEnHex(etiquette),
    });
  }

  const vecteurs = {
    specification: "railsbox-vault/instantane-de-reprise/v2",
    adr: "docs/decisions/0024-instantane-de-reprise.md",
    produitPar: "tools/figer-vecteurs-instantane.mjs",
    avertissement:
      "Ces octets sont un CONTRAT. Les régénérer n'est pas une correction : c'est un changement de format persistant, qui exige une version et un ADR.",
    algorithme: ALGORITHME,
    domaine: DOMAINE,
    formatInstantane: FORMAT_INSTANTANE,
    derivation: {
      etiquetteDuSchema: ETIQUETTE_SCHEMA_DE_DOMAINE,
      domaine: DOMAINE_INSTANTANE,
      regime: "usage-unique",
      selOctets: SEL_OCTETS,
      note: "La clé de chaque capture DESCEND de la DEK par HKDF-SHA-256, sel tiré, info à champs préfixés (ADR 0033). La DEK, elle, ne chiffre plus rien.",
    },
    disposition: {
      enTeteOctets: EN_TETE_OCTETS,
      marqueOctets: 8,
      marqueurEnTete: MARQUEUR,
      marqueurComplet: "564c54534e504631",
    },
    cle: {
      role: "clé MAÎTRESSE (DEK) de TEST, publique et sans entropie — elle ne chiffre rien, elle dérive",
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
