// L'identité logique SÉPARE les deux magasins : un enregistrement de journal n'est PAS un secteur
// de volume (#143, constat HIGH de la pré-revue adverse de #20).
//
// ## Le défaut que ce fichier reproduit
//
// Jusqu'à ce constat, une seule forme de données associées couvrait les deux magasins. Le rang
// devait les séparer — le § 5.4 de `docs/format-de-volume-v3.md` l'affirmait —, et il ne le fait
// pas : un secteur du volume porte le rang 0 par épinglage du format, et le PREMIER enregistrement
// de chaque charge porte le rang 0 par construction, puisque son rang est sa position dans la
// charge. Dans le cas NOMINAL — une écriture du guest alignée sur un secteur —, les deux objets
// partagent alors volume, version de format, génération, rang, adresse et longueur : leurs données
// associées sont identiques OCTET POUR OCTET, et leurs clairs, eux, diffèrent.
//
// Ce que cela permet, sans aucune clé : épisser dans la RÉGION d'authentification et dans la CHARGE
// du volume le sceau et le chiffré d'un enregistrement du journal, et faire rendre au lecteur de
// volume un clair que le point de contrôle n'a pas rangé — ou ne rangera jamais.
//
// ## Ce qui couvre ce défaut, et ce qui ne le couvre pas
//
// L'empreinte de région (§ 6.8) le couvre dans le chemin nominal : une région modifiée est refusée
// avant la première lecture de secteur. Les trois autres états que le rapport d'ouverture publie —
// `non-fournie`, `sans-racine`, `migree` — ne confrontent RIEN, et c'est là que le constat mord.
// C'est pourquoi les trois sont éprouvés ici, un par un, plutôt que résumés par un seul cas.
//
// ## Ce que la correction change
//
// Une étiquette de domaine PAR MAGASIN : `…/v1/bloc` reste celle des secteurs — les données
// associées d'un secteur ne bougent pas d'un octet, et `tests/vectors/format-chiffre-v1.json` reste
// valide —, et les enregistrements du journal reçoivent `…/v1/enregistrement`. Le refus attendu est
// donc celui d'une étiquette qui ne vérifie pas : `VAULT_STORAGE_SCEAU_REFUSE`, traduit de
// `VAULT_CRYPTO_SCEAU_REFUSE`.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { CRYPTO_ERROR_CODES } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import {
  GENERATION_MAX,
  RANG_MAX,
  encoderIdentiteBloc,
  encoderIdentiteEnregistrement,
} from "../../src/vm/format-chiffre/identite-logique.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { ENTETE_OCTETS, ZONE_ENREGISTREMENTS } from "../../src/vm/generation-format.mjs";
import { GenerationStore } from "../../src/vm/generation-store.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { VolumeChiffre } from "../../src/vm/volume-chiffre.mjs";
import {
  FORMAT_VOLUME_V3,
  SCEAU_OCTETS,
  dispositionV3,
  offsetDeCharge,
  offsetDeSceau,
} from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE = 8 * SECTOR_SIZE;
const DISPOSITION = dispositionV3(TAILLE);

/** Identifiant FIXE du banc : il entre dans les données associées de chaque sceau. */
const IDENTIFIANT = "7".repeat(32);

/** Le journal du banc n'est jamais rangé tout seul : le point de contrôle est DEMANDÉ, jamais subi. */
const SANS_RANGEMENT = Number.MAX_SAFE_INTEGER;

let compteur = 0;

/**
 * Un volume v3 complet en mémoire — en-tête, région d'authentification, charge chiffrée — et son
 * journal voisin sur un double déterministe.
 *
 * Rien n'y est simulé : la région et la charge sont écrites par `VolumeChiffre`, le journal par
 * `GenerationStore`, et les deux partagent UN scellement, exactement comme l'ouvreur du produit les
 * assemble. C'est ce qui rend l'épissage ci-dessous opposable — il porte sur les octets que le
 * produit écrit, pas sur une maquette.
 */
function banc() {
  compteur += 1;
  const magasin = createSyncAccessStore();
  const nom = `identite-${compteur}.gen`;
  const support = new Uint8Array(DISPOSITION.tailleSupport);
  const boite = { octets: null };
  return { magasin, nom, support, boite };
}

/** La source de fraîcheur de l'ADR 0019, branchée sur la RÉGION réelle du banc. */
function fraicheurDuBanc({ support, boite }) {
  return {
    regionOffset: DISPOSITION.regionOffset,
    regionOctets: DISPOSITION.regionOctets,
    lireRegion: async (offset, longueur) => support.slice(offset, offset + longueur),
    lireTemoin: async () => boite.octets,
    ecrireTemoin: async (octets) => {
      boite.octets = octets;
    },
  };
}

/** Ouvre une session : un scellement, la couche chiffrée du volume, le magasin de générations. */
async function session(cadre, fraicheur) {
  const scellement = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
  });
  const chiffre = new VolumeChiffre({
    volume: "vol",
    scellement,
    disposition: DISPOSITION,
    lireSupport: (offset, longueur) => cadre.support.slice(offset, offset + longueur),
    ecrireSupport: (offset, octets) => cadre.support.set(octets, offset),
  });
  const magasin = await GenerationStore.ouvrir({
    volume: "vol",
    handle: await cadre.magasin.openHandle(cadre.nom),
    tailleVolume: TAILLE,
    scellement,
    fraicheur,
    seuilPointDeControle: SANS_RANGEMENT,
    lireVolume: (offset, longueur) => chiffre.lireSecteurs(offset, longueur),
    ecrireVolume: (offset, octets, generation) =>
      chiffre.ecrireSecteurs(offset, octets, generation),
    barriereVolume: async () => {},
  });
  return { scellement, chiffre, magasin };
}

function fermer(cadre, ouverte) {
  ouverte.magasin.close();
  cadre.magasin.abandon(cadre.nom);
}

/**
 * Prépare le banc et rend les octets du PREMIER enregistrement d'une charge, avec le clair du
 * secteur homologue rangé au même endroit.
 *
 * Deux dépôts à la MÊME adresse dans la même génération : le premier prend le rang 0 — celui que le
 * format épingle pour un secteur du volume —, le second le rang 1. Le point de contrôle range le
 * second, si bien que le volume et le journal portent, pour la même adresse et la MÊME GÉNÉRATION,
 * deux clairs différents. C'est le cas nominal du constat, pas un cas limite.
 */
async function preparer(cadre) {
  const cache = buildPattern(SECTOR_SIZE, 143);
  const range = buildPattern(SECTOR_SIZE, 44);

  // La session qui écrit est celle du PRODUIT : elle tient une fraîcheur, donc elle écrit un journal
  // de format 4 et scelle ses enregistrements sous l'étiquette de leur magasin.
  const ouverte = await session(cadre, fraicheurDuBanc(cadre));
  await ouverte.magasin.deposer(0, cache);
  await ouverte.magasin.deposer(0, range);
  await ouverte.magasin.valider();
  const journal = cadre.magasin.snapshot(cadre.nom);
  await ouverte.magasin.pointDeControle();
  fermer(cadre, ouverte);

  const debut = ZONE_ENREGISTREMENTS + ENTETE_OCTETS;
  return {
    cache,
    range,
    sceau: journal.slice(debut, debut + SCEAU_OCTETS),
    chiffre: journal.slice(debut + SCEAU_OCTETS, debut + SCEAU_OCTETS + SECTOR_SIZE),
  };
}

/** ÉPISSE le sceau et le chiffré d'un enregistrement à la place du secteur homologue. */
function episser(cadre, enregistrement) {
  cadre.support.set(enregistrement.sceau, offsetDeSceau(DISPOSITION, 0));
  cadre.support.set(enregistrement.chiffre, offsetDeCharge(DISPOSITION, 0));
}

/**
 * SUPPRIME le témoin de séquence. Aucune clé n'est nécessaire pour cela, et le § 6.9 le dit déjà :
 * `ouvrirTemoin` ne juge un fichier que sur son marqueur et sa longueur, si bien que l'effacer
 * suffit. C'est ce que fait une restauration d'archive, et c'est ce qui réarme les états où aucune
 * fraîcheur n'est prétendue.
 */
function retirerTemoin(cadre) {
  cadre.boite.octets = null;
}

/** Les trois états où le rapport d'ouverture ne prétend AUCUNE fraîcheur (§ 6.8). */
const ETATS_SANS_CONFRONTATION = [
  {
    etat: "non-fournie",
    // Le magasin DÉCLARE n'avoir aucune source de région. Rien n'est confronté à l'ouverture, et
    // c'est l'état des bancs et des outils de mesure.
    fraicheur: () => null,
  },
  {
    etat: "sans-racine",
    // Aucune racine ne fait autorité : c'est l'état que laisse une restauration d'archive, qui
    // retire le journal et le témoin sans en reposer tant qu'aucun point de contrôle n'a eu lieu.
    fraicheur: (cadre) => fraicheurDuBanc(cadre),
    avant: async (cadre) => {
      const handle = await cadre.magasin.openHandle(cadre.nom);
      handle.truncate(0);
      handle.flush();
      handle.close();
      cadre.magasin.abandon(cadre.nom);
      retirerTemoin(cadre);
    },
  },
  {
    etat: "migree",
    // La racine trouvée ne scelle aucune empreinte de région — l'état que laisse un runtime d'avant
    // l'ADR 0019 —, et cette ouverture-là ne confronte rien. Elle est fabriquée par le chemin
    // normal : une session qui DÉCLARE n'avoir aucune fraîcheur écrit le journal de #18, racine
    // sans empreinte comprise.
    fraicheur: (cadre) => fraicheurDuBanc(cadre),
    avant: async (cadre) => {
      const avant19 = await session(cadre, null);
      fermer(cadre, avant19);
      retirerTemoin(cadre);
    },
  },
];

test("les données associées d'un enregistrement de journal ne sont JAMAIS celles du secteur homologue", async () => {
  // La propriété est éprouvée SUR TOUT RANG, et non sur le seul rang 0 : le constat #143 est tombé
  // sur le rang 0, mais une correction qui se contenterait de décaler les rangs laisserait deux
  // magasins dans le même espace d'identités, à une convention près. Ce que l'étiquette de domaine
  // établit est plus fort — aucun rang ne peut faire coïncider les deux.
  const base = {
    volume: IDENTIFIANT,
    formatVersion: FORMAT_VOLUME_V3,
    generation: 3,
    adresse: 0,
    longueur: SECTOR_SIZE,
  };
  for (const rang of [0, 1, 2, 41, 30_000, RANG_MAX - 1, RANG_MAX]) {
    assert.notEqual(
      octetsEnHex(encoderIdentiteEnregistrement({ ...base, rang })),
      octetsEnHex(encoderIdentiteBloc({ ...base, rang })),
      `rang ${rang} : les deux magasins partagent encore leurs données associées.`,
    );
  }
  // Et l'encodage reste INJECTIF dans le magasin du journal : deux enregistrements distincts ne
  // rendent pas la même chaîne. Sans quoi séparer les magasins aurait rouvert la porte à l'intérieur
  // de l'un d'eux.
  const rendus = new Set();
  for (const variante of [
    base,
    { ...base, generation: base.generation + 1 },
    { ...base, generation: GENERATION_MAX },
    { ...base, rang: 1 },
    { ...base, adresse: SECTOR_SIZE },
    { ...base, longueur: SECTOR_SIZE / 2 },
    { ...base, formatVersion: FORMAT_VOLUME_V3 + 1 },
    { ...base, volume: "8".repeat(32) },
  ]) {
    rendus.add(octetsEnHex(encoderIdentiteEnregistrement({ rang: 0, ...variante })));
  }
  assert.equal(rendus.size, 8, "deux identités d'enregistrement distinctes ont collisionné.");
});

test("TÉMOIN POSITIF : sans épissage, le secteur rangé par le point de contrôle se relit", async () => {
  // Sans ce témoin, un lecteur qui refuserait TOUT passerait pour corrigé.
  const cadre = banc();
  const enregistrement = await preparer(cadre);
  const ouverte = await session(cadre, null);
  assert.deepEqual(
    [...(await ouverte.chiffre.lireSecteurs(0, SECTOR_SIZE))],
    [...enregistrement.range],
    "le point de contrôle range le SECOND dépôt : c'est lui que le volume porte.",
  );
  fermer(cadre, ouverte);
});

test("un ENREGISTREMENT de journal épissé dans la région et la charge du volume est REFUSÉ", async () => {
  // La reproduction du constat #143, jouée dans les trois états où la fraîcheur ne confronte rien.
  for (const cas of ETATS_SANS_CONFRONTATION) {
    const cadre = banc();
    const enregistrement = await preparer(cadre);
    episser(cadre, enregistrement);
    await cas.avant?.(cadre);

    const ouverte = await session(cadre, cas.fraicheur(cadre));
    assert.equal(
      ouverte.magasin.rapport.fraicheurRegion,
      cas.etat,
      `l'ouverture devait publier l'état « ${cas.etat} » : sans lui, l'épreuve ne dirait rien de ce que le constat vise.`,
    );

    await assert.rejects(
      () => ouverte.chiffre.lireSecteurs(0, SECTOR_SIZE),
      (erreur) =>
        isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse) &&
        erreur.context.cause === CRYPTO_ERROR_CODES.sealRejected,
      `état « ${cas.etat} » : le lecteur de volume a rendu un clair pour un sceau d'ENREGISTREMENT.`,
    );
    fermer(cadre, ouverte);
  }
});
