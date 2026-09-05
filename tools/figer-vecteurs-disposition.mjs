#!/usr/bin/env node
// Fige les vecteurs de DISPOSITION du format de volume v3 (#20, ADR 0016 et 0019).
//
//     node tools/figer-vecteurs-disposition.mjs
//
// Les vecteurs de l'ADR 0015 (`tests/vectors/format-chiffre-v1.json`) figent ce que le MODÈLE
// produit : des blocs et des racines, en mémoire, sans disposition. Ce qu'un relecteur externe doit
// pouvoir vérifier va plus loin — il doit pouvoir dire OÙ chaque octet vit sur le disque. Ce script
// fige donc les trois objets que l'ADR 0015 ne portait pas, et l'en-tête et la racine qui les
// encadrent : un ENREGISTREMENT de journal complet, la RÉGION d'authentification d'un petit volume
// avec son empreinte, et un TÉMOIN de séquence.
//
// **Ils sont produits par le CHEMIN DE PRODUCTION**, jamais écrits à la main : `Scellement`,
// `encoderSceau`, `encoderRacine`, `scellerFraicheur`, `scellerTemoin` et `encoderEnTeteV3` sont
// exactement ceux que le Worker exécute. Un vecteur écrit à la main ne prouverait que la patience de
// celui qui l'a écrit.
//
// Le nonce est TIRÉ à chaque scellement, comme partout ailleurs dans ce format : la reproductibilité
// ne vient pas d'un nonce déterministe — l'ADR 0015 explique longuement pourquoi il n'y en a pas —,
// elle vient du fait que les octets produits sont FIGÉS ici une fois pour toutes. Relancer ce script
// après avoir modifié le format ne CORRIGE donc rien : cela change un format persistant, ce qui
// exige une version et un ADR. `tests/unit/dossier-de-revue.test.mjs` et
// `tools/verifier-vecteurs.mjs` sont là pour que ce changement se voie.
//
// ## LE DIFF DE CE FICHIER N'EST PAS LA PREUVE, et il faut le dire
//
// Une revue l'a mesuré : sur les 155 champs feuilles du document, **37 bougent à chaque
// régénération** — tous les nonces, donc tous les chiffrés, toutes les étiquettes, l'empreinte de
// région, le témoin et la racine. Un changement de FOND — l'étiquette de domaine d'un enregistrement,
// par exemple — y est donc indiscernable du bruit, et un relecteur qui lirait le diff pour vérifier
// que les secteurs du volume n'ont pas bougé ne le verrait pas.
//
// **Ce qui prouve, c'est `node tools/verifier-vecteurs.mjs`** : il réimplémente les encodages depuis
// `docs/format-de-volume-v3.md`, sans importer une ligne du produit, épingle en dur le format de
// journal attendu, exige que les données associées d'un enregistrement diffèrent de celles du
// secteur homologue, et rejoue le constat #143 en contrôle vert. Et `format-chiffre-v1.json` — les
// vecteurs du MODÈLE, qui portent les blocs et les racines — n'est pas régénéré par ce script : son
// intégrité se lit, elle, directement au diff.
//
// **Pourquoi pas une source de nonces déterministe ici**, qui rendrait le diff lisible : parce que
// `src/vm/scellement.mjs` garde cette porte par un jeton, et que `tests/unit/harnais-portes.test.mjs`
// tient la liste de ses APPELANTS VIDE — c'est la propriété elle-même, pas une commodité. Inscrire un
// outil dans cette liste échangerait une propriété de sécurité contre un confort de relecture, pour
// un gain que la revue elle-même a qualifié de faible puisque la preuve est ailleurs. Un relecteur
// qui veut voir le seul changement de fond compare les DONNÉES ASSOCIÉES, que le vérificateur
// recalcule, et non les chiffrés.
// La clé employée est PUBLIQUE et volontairement sans entropie (0x00 à 0x1f) : c'est celle du
// harnais et celle des vecteurs de l'ADR 0015, sans quoi les deux documents ne parleraient pas du
// même volume.

import { writeFileSync } from "node:fs";

import { CLE_DE_TEST } from "../src/vm/cle-de-volume.mjs";
import { octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";
import {
  FRAICHEUR_OCTETS,
  RANG_EMPREINTE_REGION,
  RANG_TEMOIN,
  TEMOIN_FORMAT,
  TEMOIN_OCTETS,
  empreinteDeRegion,
  scellerFraicheur,
  scellerTemoin,
} from "../src/vm/generation-fraicheur.mjs";
import {
  ENTETE_OCTETS,
  GENERATION_FORMAT,
  RACINE_ENTETE_OCTETS,
  RACINE_ENTETE_V2_OCTETS,
  RACINE_OCTETS,
  SURCOUT_ENREGISTREMENT,
  encoderEnteteEnregistrement,
  encoderRacine,
} from "../src/vm/generation-format.mjs";
import { RANG_SECTEUR_DE_VOLUME, Scellement } from "../src/vm/scellement.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  SCEAU_OCTETS,
  SCELLEMENT_COMPLET_OFFSET,
  dispositionV3,
  encoderEnTeteV3,
  encoderSceau,
  identifiantVolumeEnOctets,
} from "../src/vm/volume-chiffre-format.mjs";

const DESTINATION = new URL("../tests/vectors/disposition-v3.json", import.meta.url);

/**
 * Volume de vecteur : QUATRE secteurs logiques.
 *
 * Quatre plutôt qu'un, pour que la région porte plus d'un sceau et que l'ordre des sceaux se lise ;
 * quatre plutôt que mille, pour que le document reste lisible d'un bout à l'autre. La région d'un
 * volume de quatre secteurs occupe 4 × 34 = 136 octets sur les 512 qu'elle réserve : le REMBOURRAGE
 * de la région entre donc dans l'empreinte, et c'est exactement le détail qu'une réimplémentation
 * rate en premier.
 */
const TAILLE_LOGIQUE = 4 * 512;

/** Identifiant de volume du vecteur. Une DONNÉE du contrat, publiée en clair comme la clé. */
const IDENTIFIANT_VOLUME = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** Séquence et génération du vecteur. Petites, pour que les octets se lisent à l'œil. */
const SEQUENCE = 7;
const GENERATION = 3;

/** La même règle de contenu que les vecteurs de l'ADR 0015 : `octet i = (i × 7 + 13 + graine) % 256`. */
function contenu(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 7 + 13 + graine) % 256);
}

/**
 * Les enregistrements de journal figés.
 *
 * Deux, et le second n'est pas là pour faire nombre : il est NON ALIGNÉ sur un secteur, ce qui est
 * l'état ordinaire d'une écriture du guest et le cas qu'un lecteur de journal doit savoir traverser
 * — la longueur du chiffré suit celle du clair, et le pas d'un enregistrement à l'autre s'en déduit.
 */
const ENREGISTREMENTS = [
  {
    nom: "enregistrement aligné : un secteur entier à l'adresse 0",
    rang: 0,
    offset: 0,
    longueur: 512,
    graine: 11,
  },
  {
    nom: "enregistrement NON aligné : 100 octets à l'adresse 1536",
    rang: 1,
    offset: 1536,
    longueur: 100,
    graine: 12,
  },
];

/** Les secteurs du volume, scellés par le point de contrôle. Un par secteur logique. */
const SECTEURS = [0, 512, 1024, 1536].map((adresse, index) => ({
  adresse,
  graine: 20 + index,
}));

async function main() {
  const disposition = dispositionV3(TAILLE_LOGIQUE);
  const scellement = await Scellement.ouvrir({
    volume: IDENTIFIANT_VOLUME,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
    scellementsCumules: 0,
  });

  // --- Les enregistrements du journal -------------------------------------------------------
  const enregistrements = [];
  for (const modele of ENREGISTREMENTS) {
    const clair = contenu(modele.longueur, modele.graine);
    const identite = {
      generation: GENERATION,
      rang: modele.rang,
      adresse: modele.offset,
      longueur: modele.longueur,
    };
    // `scellerEnregistrement`, et non `scellerBloc` : un enregistrement du journal porte sa propre
    // étiquette de domaine depuis le constat #143, et c'est exactement ce que ces vecteurs figent.
    const scelle = await scellement.scellerEnregistrement(identite, clair);
    const entete = encoderEnteteEnregistrement({
      offset: modele.offset,
      longueur: modele.longueur,
    });
    const sceau = encoderSceau({
      nonce: scelle.nonce,
      etiquette: scelle.etiquette,
      generation: GENERATION,
    });
    const octets = new Uint8Array(ENTETE_OCTETS + SCEAU_OCTETS + modele.longueur);
    octets.set(entete, 0);
    octets.set(sceau, ENTETE_OCTETS);
    octets.set(scelle.chiffre, ENTETE_OCTETS + SCEAU_OCTETS);
    enregistrements.push({
      nom: modele.nom,
      identite: { ...identite, volume: IDENTIFIANT_VOLUME, formatVersion: FORMAT_VOLUME_V3 },
      clair: { longueur: modele.longueur, graine: modele.graine, hex: octetsEnHex(clair) },
      attendu: {
        enteteHex: octetsEnHex(entete),
        sceauHex: octetsEnHex(sceau),
        nonce: octetsEnHex(scelle.nonce),
        etiquette: octetsEnHex(scelle.etiquette),
        chiffre: octetsEnHex(scelle.chiffre),
        octetsHex: octetsEnHex(octets),
      },
    });
  }

  // --- La région d'authentification ----------------------------------------------------------
  // Elle est construite exactement comme le point de contrôle la construit : un sceau par secteur
  // logique, dans l'ordre des adresses, et le reste de la région à ZÉRO. Le rembourrage entre dans
  // l'empreinte comme le reste.
  const region = new Uint8Array(disposition.regionOctets);
  const secteurs = [];
  for (const modele of SECTEURS) {
    const clair = contenu(512, modele.graine);
    const identite = {
      generation: GENERATION,
      rang: RANG_SECTEUR_DE_VOLUME,
      adresse: modele.adresse,
      longueur: 512,
    };
    const scelle = await scellement.scellerBloc(identite, clair);
    const sceau = encoderSceau({
      nonce: scelle.nonce,
      etiquette: scelle.etiquette,
      generation: GENERATION,
    });
    region.set(sceau, (modele.adresse / 512) * SCEAU_OCTETS);
    secteurs.push({
      adresse: modele.adresse,
      identite: { ...identite, volume: IDENTIFIANT_VOLUME, formatVersion: FORMAT_VOLUME_V3 },
      clair: { longueur: 512, graine: modele.graine, hex: octetsEnHex(clair) },
      attendu: {
        sceauHex: octetsEnHex(sceau),
        nonce: octetsEnHex(scelle.nonce),
        etiquette: octetsEnHex(scelle.etiquette),
        chiffre: octetsEnHex(scelle.chiffre),
      },
    });
  }

  const empreinte = await empreinteDeRegion({
    lireRegion: async (offset, longueur) =>
      region.slice(offset - disposition.regionOffset, offset - disposition.regionOffset + longueur),
    volume: IDENTIFIANT_VOLUME,
    regionOffset: disposition.regionOffset,
    regionOctets: disposition.regionOctets,
  });
  const fraicheur = await scellerFraicheur(scellement, GENERATION, empreinte);

  // --- La racine v3 --------------------------------------------------------------------------
  const entrees = enregistrements.map((enregistrement) => ({
    adresse: enregistrement.identite.adresse,
    longueur: enregistrement.identite.longueur,
    rang: enregistrement.identite.rang,
    etiquette: hex(enregistrement.attendu.etiquette),
  }));
  const scelleRacine = await scellement.scellerRacine(
    { sequence: SEQUENCE, generation: GENERATION, tailleVolume: TAILLE_LOGIQUE },
    entrees,
    { sequencePrecedente: null },
  );
  const racine = encoderRacine({
    sequence: SEQUENCE,
    generation: GENERATION,
    tailleVolume: TAILLE_LOGIQUE,
    nombreEntrees: scelleRacine.entete.nombreEntrees,
    longueurCharge: scelleRacine.entete.longueurCharge,
    identifiantVolume: identifiantVolumeEnOctets(IDENTIFIANT_VOLUME),
    scellementsCumules: scelleRacine.entete.scellementsCumules,
    nonce: scelleRacine.nonce,
    chiffre: scelleRacine.chiffre,
    etiquette: scelleRacine.etiquette,
    fraicheur,
  });

  // --- Le témoin -----------------------------------------------------------------------------
  const temoin = await scellerTemoin(scellement, {
    sequence: SEQUENCE,
    generation: GENERATION,
    fraicheurActive: true,
  });

  // --- L'en-tête v3 --------------------------------------------------------------------------
  const enTete = encoderEnTeteV3({
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT_VOLUME,
    scellementComplet: true,
  });

  const document = {
    avertissement:
      "Vecteurs FIGÉS de la DISPOSITION du format de volume v3 (#20, ADR 0016 et 0019). La clé est " +
      "une clé de TEST publique, sans entropie et sans valeur : elle ne protège rien et ne doit " +
      "jamais servir ailleurs. Ces octets sont un CONTRAT — les régénérer change un format " +
      "persistant et exige une version et un ADR. Ils complètent tests/vectors/format-chiffre-v1.json, " +
      "qui fige ce que le MODÈLE produit ; ici c'est ce que le DISQUE porte.",
    specification: {
      formatVolume: FORMAT_VOLUME_V3,
      formatJournal: GENERATION_FORMAT,
      sceauOctets: SCEAU_OCTETS,
      racineEnteteOctets: RACINE_ENTETE_OCTETS,
      racineEnteteV2Octets: RACINE_ENTETE_V2_OCTETS,
      racineOctets: RACINE_OCTETS,
      enTeteOctets: EN_TETE_OCTETS,
      enteteEnregistrementOctets: ENTETE_OCTETS,
      surcoutEnregistrement: SURCOUT_ENREGISTREMENT,
      fraicheurOctets: FRAICHEUR_OCTETS,
      temoinOctets: TEMOIN_OCTETS,
      temoinFormat: TEMOIN_FORMAT,
      rangSecteurDeVolume: RANG_SECTEUR_DE_VOLUME,
      rangEmpreinteRegion: RANG_EMPREINTE_REGION,
      rangTemoin: RANG_TEMOIN,
      scellementCompletOffset: SCELLEMENT_COMPLET_OFFSET,
      reference: "docs/format-de-volume-v3.md",
      producteur: "node tools/figer-vecteurs-disposition.mjs",
    },
    cle: {
      usage: "TEST",
      derivation: "octets 0x00 à 0x1f dans l'ordre",
      hex: octetsEnHex(CLE_DE_TEST),
    },
    volume: {
      identifiant: IDENTIFIANT_VOLUME,
      tailleLogique: TAILLE_LOGIQUE,
      disposition: {
        secteurs: disposition.secteurs,
        enTeteOctets: disposition.enTeteOctets,
        regionOffset: disposition.regionOffset,
        regionOctets: disposition.regionOctets,
        chargeOffset: disposition.chargeOffset,
        tailleSupport: disposition.tailleSupport,
      },
      contenuRegle: "octet i = (i * 7 + 13 + graine) mod 256",
    },
    enTete: {
      nom: "en-tête v3 d'un volume de quatre secteurs, scellement complet marqué",
      scellementComplet: true,
      hex: octetsEnHex(enTete),
    },
    enregistrements,
    region: {
      nom: "région d'authentification de quatre secteurs, rembourrée jusqu'au secteur",
      octets: disposition.regionOctets,
      utiles: SECTEURS.length * SCEAU_OCTETS,
      secteurs,
      hex: octetsEnHex(region),
      empreinte: octetsEnHex(empreinte),
    },
    racine: {
      nom: "racine v3 de format 3, avec la fraîcheur de sa région",
      entete: scelleRacine.entete,
      entrees: entrees.map((entree) => ({
        adresse: entree.adresse,
        longueur: entree.longueur,
        rang: entree.rang,
        etiquette: octetsEnHex(entree.etiquette),
      })),
      attendu: {
        nonce: octetsEnHex(scelleRacine.nonce),
        chiffre: octetsEnHex(scelleRacine.chiffre),
        etiquette: octetsEnHex(scelleRacine.etiquette),
        empreinteEntrees: octetsEnHex(scelleRacine.empreinteEntrees),
        fraicheurHex: octetsEnHex(fraicheur),
        hex: octetsEnHex(racine),
      },
    },
    temoin: {
      nom: "témoin de dernière séquence vue, scellé sous la clé du volume",
      sequence: SEQUENCE,
      generation: GENERATION,
      fraicheurActive: true,
      hex: octetsEnHex(temoin),
    },
  };

  writeFileSync(DESTINATION, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${enregistrements.length} enregistrement(s), ${secteurs.length} secteur(s) de région, une racine et un témoin figés dans ${DESTINATION.pathname}\n`,
  );
}

/** Relit une chaîne hexadécimale. Local plutôt qu'importé : ce script ne fait que produire. */
function hex(texte) {
  const octets = new Uint8Array(texte.length / 2);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(texte.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}

await main();
