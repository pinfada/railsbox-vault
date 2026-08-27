#!/usr/bin/env node
// Fige les vecteurs du format chiffré depuis le modèle de référence (#17, ADR 0015).
//
//     node tools/figer-vecteurs-scellement.mjs
//
// Ce que ce script produit est un CONTRAT, pas un artefact de commodité : #18 et #19 devront
// reproduire ces octets à l'identique. Le relancer après avoir modifié le modèle ne CORRIGE donc
// rien — cela change un format persistant, ce qui exige une version et un ADR. L'épreuve
// `tests/unit/vm-format-chiffre-vecteurs.test.mjs` est là pour que ce changement rougisse au lieu
// de passer.
//
// La clé employée est PUBLIQUE et volontairement sans entropie (0x00 à 0x1f). Aucun secret n'entre
// ici, et le premier gate d'utilisation de `SECURITY.md` interdit de toute façon qu'il en existe un
// dans ce dépôt.

import { writeFileSync } from "node:fs";

import {
  ALGORITHME,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  SPECIFICATION_VERSION,
} from "../src/vm/format-chiffre/identite-logique.mjs";
import { scellerBloc, scellerRacine } from "../src/vm/format-chiffre/modele-reference.mjs";
import { octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";

const DESTINATION = new URL("../tests/vectors/format-chiffre-v1.json", import.meta.url);

/** Clé de TEST, publique, sans entropie. Jamais un secret : 0x00 à 0x1f. */
const CLE_DE_TEST = Uint8Array.from({ length: 32 }, (_, index) => index);

const VOLUME = "volume-de-vecteur";
const FORMAT_VOLUME = 3;
const TAILLE_VOLUME = 1048576;

/** Contenu déterministe : `octet i = (i * 7 + 13 + graine) mod 256`. Publié dans le vecteur. */
function contenu(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 7 + 13 + graine) % 256);
}

/**
 * Les blocs figés. Ils sont choisis pour couvrir les axes de l'identité logique plutôt que pour
 * faire nombre : un secteur ordinaire, le MÊME bloc réécrit dans la même génération (le cas que
 * l'ADR 0014 autorise et que le nonce doit traiter), une adresse voisine, une génération suivante.
 */
const BLOCS = [
  {
    nom: "secteur ordinaire, première génération",
    couvre: ["modification", "deplacement"],
    identite: {
      volume: VOLUME,
      formatVersion: FORMAT_VOLUME,
      generation: 1,
      rang: 0,
      adresse: 0,
      longueur: 512,
    },
    contenu: { longueur: 512, graine: 0 },
  },
  {
    nom: "MÊME adresse réécrite dans la MÊME génération, rang suivant",
    couvre: ["modification"],
    identite: {
      volume: VOLUME,
      formatVersion: FORMAT_VOLUME,
      generation: 1,
      rang: 1,
      adresse: 0,
      longueur: 512,
    },
    contenu: { longueur: 512, graine: 1 },
  },
  {
    nom: "adresse voisine, même génération",
    couvre: ["deplacement"],
    identite: {
      volume: VOLUME,
      formatVersion: FORMAT_VOLUME,
      generation: 1,
      rang: 2,
      adresse: 512,
      longueur: 512,
    },
    contenu: { longueur: 512, graine: 2 },
  },
  {
    nom: "génération suivante, adresse déjà écrite",
    couvre: ["deplacement", "rejeu", "melange"],
    identite: {
      volume: VOLUME,
      formatVersion: FORMAT_VOLUME,
      generation: 2,
      rang: 0,
      adresse: 0,
      longueur: 512,
    },
    contenu: { longueur: 512, graine: 3 },
  },
  {
    nom: "écriture courte, non alignée sur un secteur",
    couvre: ["modification", "troncature"],
    identite: {
      volume: VOLUME,
      formatVersion: FORMAT_VOLUME,
      generation: 2,
      rang: 1,
      adresse: 4096,
      longueur: 16,
    },
    contenu: { longueur: 16, graine: 4 },
  },
];

/** Quelles entrées composent quelle génération. Les rangs sont ceux des blocs ci-dessus. */
const GENERATIONS = [
  {
    nom: "génération 1, trois entrées",
    sequence: 1,
    generation: 1,
    blocs: [0, 1, 2],
    couvre: ["troncature", "melange", "rejeu"],
  },
  {
    nom: "génération 2, deux entrées dont une courte",
    sequence: 2,
    generation: 2,
    blocs: [3, 4],
    couvre: ["troncature", "melange"],
  },
];

async function main() {
  const { importerCleDeVolume } = await import("../src/vm/format-chiffre/modele-reference.mjs");
  const cle = await importerCleDeVolume(CLE_DE_TEST);

  const blocs = [];
  for (const modele of BLOCS) {
    const octetsClairs = contenu(modele.contenu.longueur, modele.contenu.graine);
    const scelle = await scellerBloc({ cle, identite: modele.identite, contenu: octetsClairs });
    blocs.push({
      nom: modele.nom,
      couvre: modele.couvre,
      identite: modele.identite,
      contenu: { ...modele.contenu, hex: octetsEnHex(octetsClairs) },
      attendu: {
        nonce: octetsEnHex(scelle.nonce),
        chiffre: octetsEnHex(scelle.chiffre),
        etiquette: octetsEnHex(scelle.etiquette),
      },
    });
  }

  const racines = [];
  let scellementsCumules = blocs.length;
  for (const modele of GENERATIONS) {
    scellementsCumules += 1;
    const entrees = modele.blocs.map((index) => ({
      adresse: BLOCS[index].identite.adresse,
      longueur: BLOCS[index].identite.longueur,
      rang: BLOCS[index].identite.rang,
      etiquette: blocs[index].attendu.etiquette,
    }));
    const racine = await scellerRacine({
      cle,
      racine: {
        volume: VOLUME,
        formatVersion: FORMAT_VOLUME,
        sequence: modele.sequence,
        generation: modele.generation,
        tailleVolume: TAILLE_VOLUME,
        scellementsCumules,
      },
      entrees: entrees.map((entree) => ({
        ...entree,
        etiquette: Uint8Array.from(
          entree.etiquette.match(/../g).map((paire) => Number.parseInt(paire, 16)),
        ),
      })),
    });
    racines.push({
      nom: modele.nom,
      couvre: modele.couvre,
      racine: {
        volume: VOLUME,
        formatVersion: FORMAT_VOLUME,
        sequence: modele.sequence,
        generation: modele.generation,
        tailleVolume: TAILLE_VOLUME,
        scellementsCumules,
      },
      entrees,
      attendu: {
        nonce: octetsEnHex(racine.nonce),
        chiffre: octetsEnHex(racine.chiffre),
        etiquette: octetsEnHex(racine.etiquette),
        empreinteEntrees: octetsEnHex(racine.empreinteEntrees),
        nombreEntrees: racine.entete.nombreEntrees,
        longueurCharge: racine.entete.longueurCharge,
      },
    });
  }

  const document = {
    avertissement:
      "Vecteurs FIGÉS du format chiffré de RailsBox Vault (#17, ADR 0015). La clé est une clé de TEST publique, sans entropie et sans valeur : elle ne protège rien et ne doit jamais servir ailleurs. Ces octets sont un CONTRAT — #18 et #19 doivent les reproduire à l'identique ; les régénérer change un format persistant et exige une version et un ADR.",
    specification: {
      algorithme: ALGORITHME,
      version: SPECIFICATION_VERSION,
      nonceOctets: NONCE_OCTETS,
      etiquetteOctets: ETIQUETTE_OCTETS,
      reference: "docs/decisions/0015-proprietes-cryptographiques-du-format.md",
      producteur: "node tools/figer-vecteurs-scellement.mjs",
    },
    cle: {
      usage: "TEST",
      derivation: "octets 0x00 à 0x1f dans l'ordre",
      hex: octetsEnHex(CLE_DE_TEST),
    },
    blocs,
    racines,
  };

  writeFileSync(DESTINATION, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${blocs.length} bloc(s) et ${racines.length} racine(s) figés dans ${DESTINATION.pathname}\n`,
  );
}

await main();
