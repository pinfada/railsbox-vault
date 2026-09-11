#!/usr/bin/env node
// Fige les vecteurs du FORMAT DE VOLUME v4 et de sa HIÉRARCHIE DE CLÉS (#182, ADR 0033).
//
//     node tools/figer-vecteurs-volume-v4.mjs
//
// Ce que la v4 ajoute aux vecteurs de #18 et #20 est la DÉRIVATION : les octets d'un secteur ne
// suffisent plus à un relecteur, parce que la clé sous laquelle ils sont scellés n'est plus la DEK.
// Ce document publie donc, de bout en bout et en clair :
//
//  1. la DEK de test, qui ne chiffre RIEN — elle est un matériau HKDF (ADR 0033, décision 6) ;
//  2. l'ANCRAGE de la primitive : le cas 3 de la RFC 5869, sel vide et info vide, dont le résultat
//     est publié par le document normatif lui-même. Un vérificateur qui le reproduit sait que son
//     HKDF est celui de la RFC avant de juger quoi que ce soit du format ;
//  3. l'INFO de chaque domaine, champ par champ, et les trente-deux octets que HKDF en tire ;
//  4. un SECTEUR scellé sous la clé du domaine `volume`, un ENREGISTREMENT scellé sous celle du
//     domaine `journal`, et une RACINE à onze champs — 144 octets de données associées ;
//  5. l'EN-TÊTE v4 du fichier et la RACINE SUR DISQUE au format de journal 5.
//
// **Les octets sont produits par le CHEMIN DE PRODUCTION**, jamais écrits à la main : `Scellement`,
// `encoderSceau`, `encoderRacine` et `encoderEnTeteV4` sont exactement ceux que le Worker exécute.
// Les OKM, eux, sont calculés par `deriveBits` — le produit, lui, dérive une `CryptoKey` NON
// EXTRACTIBLE et ne peut donc pas les montrer. C'est un écart voulu, et c'est ce qui permet à
// `tools/verifier-vecteurs.mjs` de faire la mesure qui compte : il redérive l'OKM depuis la
// spécification écrite, l'importe, et OUVRE avec lui le secteur que le produit a scellé. La clé du
// produit n'est jamais extraite, et pourtant l'égalité est établie.
//
// Relancer ce script après avoir modifié le format ne CORRIGE rien : cela change un format
// persistant, ce qui exige une version et un ADR.
//
// La clé employée est PUBLIQUE et sans entropie (0x00 à 0x1f) : la même que celle des vecteurs de
// l'ADR 0015, pour qu'un relecteur n'ait qu'une clé de test à connaître.

import { writeFileSync } from "node:fs";

import { CLE_DE_TEST } from "../src/vm/cle-de-volume.mjs";
import { octetsEnHex } from "../src/vm/format-chiffre/octets.mjs";
import {
  DOMAINES,
  ETIQUETTE_SCHEMA_DE_DOMAINE,
  encoderInfoDeDomaine,
} from "../src/vm/derivation/cle-de-domaine.mjs";
import {
  encoderEnteteRacine,
  encoderIdentiteBloc,
  encoderIdentiteEnregistrement,
} from "../src/vm/format-chiffre/identite-logique.mjs";
import { empreinteDesEntrees } from "../src/vm/format-chiffre/modele-reference.mjs";
import {
  GENERATION_FORMAT_DEUX_COMPTEURS,
  RACINE_ENTETE_V5_OCTETS,
  encoderRacine,
} from "../src/vm/generation-format.mjs";
import { RANG_SECTEUR_DE_VOLUME, Scellement } from "../src/vm/scellement.mjs";
import {
  FORMAT_VOLUME_V4,
  dispositionDuVolume,
  encoderEnTeteV4,
  encoderSceau,
  identifiantVolumeEnOctets,
} from "../src/vm/volume-chiffre-format.mjs";

const DESTINATION = new URL("../tests/vectors/volume-v4.json", import.meta.url);

const VOLUME = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TAILLE_LOGIQUE = 2048;
const SECTEUR = 512;
const GENERATION = 3;

/** Contenu déterministe, publié avec sa règle : `octet i = (i * 7 + 13 + graine) mod 256`. */
function contenu(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 7 + 13 + graine) % 256);
}

/**
 * Les trente-deux octets qu'HKDF-SHA-256 rend. Le produit, lui, n'en rend que la `CryptoKey`.
 *
 * Ce chemin-ci existe pour PUBLIER l'OKM : sans lui, un relecteur ne pourrait comparer sa propre
 * dérivation à rien. Le produit n'y a pas accès, et c'est délibéré (ADR 0033, décision 6).
 */
async function okm(materiau, sel, info) {
  const base = await crypto.subtle.importKey("raw", materiau, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sel, info }, base, 256),
  );
}

/**
 * Le cas 3 de la RFC 5869 : IKM de 22 octets à 0x0b, **sel VIDE**, **info VIDE**, OKM de 42 octets.
 *
 * Il est ici parce que les domaines à compteur emploient un sel vide (ADR 0033, décision 3), et que
 * c'est exactement ce que ce cas normatif couvre. Un vérificateur qui le reproduit sait que son
 * HKDF est celui de la RFC avant de juger quoi que ce soit du format de ce dépôt.
 */
async function ancrageRfc5869() {
  const ikm = new Uint8Array(22).fill(0x0b);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
    base,
    42 * 8,
  );
  return {
    source: "RFC 5869, appendice A, cas 3 — sel VIDE et info VIDE",
    ikm: octetsEnHex(ikm),
    sel: "",
    info: "",
    okm: octetsEnHex(new Uint8Array(bits)),
    attenduParLaRfc:
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
  };
}

async function principal() {
  const disposition = dispositionDuVolume(TAILLE_LOGIQUE);
  const scellement = await Scellement.ouvrir({
    volume: VOLUME,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });

  // --- LA DÉRIVATION : l'info de chaque domaine, et l'OKM que HKDF en tire ------------------
  const domaines = {};
  for (const domaine of [DOMAINES.volume, DOMAINES.journal]) {
    const info = encoderInfoDeDomaine({
      domaine,
      identifiantVolume: VOLUME,
      versionDeFormat: FORMAT_VOLUME_V4,
    });
    domaines[domaine] = {
      domaine,
      regime: "compteur",
      versionDeFormatDuDomaine: FORMAT_VOLUME_V4,
      sel: "",
      selOctets: 0,
      info: octetsEnHex(info),
      okm: octetsEnHex(await okm(CLE_DE_TEST, new Uint8Array(0), info)),
    };
  }

  // --- UN SECTEUR, sous la clé du domaine `volume` ------------------------------------------
  const clairDuSecteur = contenu(SECTEUR, 11);
  const identiteDuSecteur = {
    volume: VOLUME,
    formatVersion: FORMAT_VOLUME_V4,
    generation: GENERATION,
    rang: RANG_SECTEUR_DE_VOLUME,
    adresse: 0,
    longueur: SECTEUR,
  };
  const secteurScelle = await scellement.scellerBloc(
    { generation: GENERATION, rang: RANG_SECTEUR_DE_VOLUME, adresse: 0, longueur: SECTEUR },
    clairDuSecteur,
  );

  // --- UN ENREGISTREMENT, sous la clé du domaine `journal` ----------------------------------
  const clairDeLEnregistrement = contenu(SECTEUR, 29);
  const identiteDeLEnregistrement = {
    volume: VOLUME,
    formatVersion: FORMAT_VOLUME_V4,
    generation: GENERATION,
    rang: 0,
    adresse: 0,
    longueur: SECTEUR,
  };
  const enregistrementScelle = await scellement.scellerEnregistrement(
    { generation: GENERATION, rang: 0, adresse: 0, longueur: SECTEUR },
    clairDeLEnregistrement,
  );

  // --- LA RACINE, à onze champs -------------------------------------------------------------
  const entrees = [
    {
      adresse: 0,
      longueur: SECTEUR,
      rang: 0,
      etiquette: enregistrementScelle.etiquette,
    },
  ];
  const scellementsCumulesVolume = scellement.scellementsCumulesVolume;
  const scellementsCumulesJournal = scellement.scellementsCumulesJournal;
  const racineScellee = await scellement.scellerRacine(
    { sequence: 7, generation: GENERATION, tailleVolume: TAILLE_LOGIQUE },
    entrees,
    { sequencePrecedente: null },
  );
  const fraicheur = contenu(66, 5);
  const racineSurDisque = encoderRacine({
    format: GENERATION_FORMAT_DEUX_COMPTEURS,
    sequence: racineScellee.entete.sequence,
    generation: racineScellee.entete.generation,
    tailleVolume: racineScellee.entete.tailleVolume,
    nombreEntrees: racineScellee.entete.nombreEntrees,
    longueurCharge: racineScellee.entete.longueurCharge,
    identifiantVolume: identifiantVolumeEnOctets(VOLUME),
    scellementsCumulesVolume: racineScellee.entete.scellementsCumulesVolume,
    scellementsCumulesJournal: racineScellee.entete.scellementsCumulesJournal,
    nonce: racineScellee.nonce,
    chiffre: racineScellee.chiffre,
    etiquette: racineScellee.etiquette,
    fraicheur,
  });

  const vecteurs = {
    specification: "railsbox-vault/format-de-volume/v4",
    adr: "docs/decisions/0033-hierarchie-de-cles-derivees-par-domaine.md",
    produitPar: "tools/figer-vecteurs-volume-v4.mjs",
    avertissement:
      "Ces octets sont un CONTRAT. Les régénérer n'est pas une correction : c'est un changement de format persistant, qui exige une version et un ADR.",
    algorithme: "aes-256-gcm",
    formatVolume: FORMAT_VOLUME_V4,
    formatJournal: GENERATION_FORMAT_DEUX_COMPTEURS,
    racineEnteteOctets: RACINE_ENTETE_V5_OCTETS,
    cleMaitresse: {
      role: "DEK de TEST, publique et sans entropie. Elle ne chiffre RIEN : c'est un matériau HKDF.",
      hex: octetsEnHex(CLE_DE_TEST),
    },
    ancrage: await ancrageRfc5869(),
    derivation: {
      etiquetteDuSchema: ETIQUETTE_SCHEMA_DE_DOMAINE,
      identifiantVolume: VOLUME,
      forme:
        "info = LP(étiquette du schéma) ‖ LP(domaine) ‖ LP(identifiantVolume) ‖ U32BE(version du format du domaine) ‖ LP(algorithme)",
      domaines,
    },
    volume: {
      identifiant: VOLUME,
      tailleLogique: TAILLE_LOGIQUE,
      disposition: { ...disposition },
      contenuRegle: "octet i = (i * 7 + 13 + graine) mod 256",
    },
    enTete: {
      nom: "en-tête v4 d'un volume de quatre secteurs, scellement complet posé",
      scellementComplet: true,
      hex: octetsEnHex(
        encoderEnTeteV4({
          tailleLogique: TAILLE_LOGIQUE,
          identifiantVolume: VOLUME,
          scellementComplet: true,
        }),
      ),
    },
    secteur: {
      nom: "un secteur de la charge, scellé sous la clé du domaine « volume »",
      domaine: DOMAINES.volume,
      identite: identiteDuSecteur,
      clair: { longueur: SECTEUR, graine: 11, hex: octetsEnHex(clairDuSecteur) },
      donneesAssociees: octetsEnHex(encoderIdentiteBloc(identiteDuSecteur)),
      nonce: octetsEnHex(secteurScelle.nonce),
      chiffre: octetsEnHex(secteurScelle.chiffre),
      etiquette: octetsEnHex(secteurScelle.etiquette),
      sceauHex: octetsEnHex(
        encoderSceau({
          nonce: secteurScelle.nonce,
          etiquette: secteurScelle.etiquette,
          generation: GENERATION,
        }),
      ),
    },
    enregistrement: {
      nom: "un enregistrement du journal, scellé sous la clé du domaine « journal »",
      domaine: DOMAINES.journal,
      identite: identiteDeLEnregistrement,
      clair: { longueur: SECTEUR, graine: 29, hex: octetsEnHex(clairDeLEnregistrement) },
      donneesAssociees: octetsEnHex(encoderIdentiteEnregistrement(identiteDeLEnregistrement)),
      nonce: octetsEnHex(enregistrementScelle.nonce),
      chiffre: octetsEnHex(enregistrementScelle.chiffre),
      etiquette: octetsEnHex(enregistrementScelle.etiquette),
    },
    racine: {
      nom: "une racine à ONZE champs : elle publie les DEUX compteurs",
      domaine: DOMAINES.volume,
      entete: { ...racineScellee.entete },
      compteursAvantLaRacine: {
        volume: scellementsCumulesVolume,
        journal: scellementsCumulesJournal,
      },
      entrees: entrees.map((entree) => ({
        adresse: entree.adresse,
        longueur: entree.longueur,
        rang: entree.rang,
        etiquette: octetsEnHex(entree.etiquette),
      })),
      donneesAssociees: octetsEnHex(encoderEnteteRacine(racineScellee.entete)),
      donneesAssocieesOctets: encoderEnteteRacine(racineScellee.entete).byteLength,
      empreinteEntrees: octetsEnHex(await empreinteDesEntrees(entrees)),
      nonce: octetsEnHex(racineScellee.nonce),
      chiffre: octetsEnHex(racineScellee.chiffre),
      etiquette: octetsEnHex(racineScellee.etiquette),
      fraicheurHex: octetsEnHex(fraicheur),
      surDisqueHex: octetsEnHex(racineSurDisque),
    },
  };

  writeFileSync(DESTINATION, `${JSON.stringify(vecteurs, null, 2)}\n`, "utf8");
  console.log(`vecteurs v4 figés dans ${DESTINATION.pathname}`);
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
