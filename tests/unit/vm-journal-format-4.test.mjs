// Le format du journal passe de 3 à 4, et un journal de format 3 est REJOUÉ une fois (#143).
//
// ## Ce que ce fichier tient
//
// Séparer l'identité d'un enregistrement de celle d'un secteur (voir
// `tests/unit/vm-identite-magasin.test.mjs`) change les octets d'un magasin persistant : la charge
// du journal. Cela demande une version — le format du journal, de 3 à 4 —, et cela demande de dire
// ce qu'on fait des journaux qui portent encore l'ancienne. Deux issues seulement sont acceptables,
// et la revue de #110 les a nommées sur le format 1 :
//
//  - **refuser** le vieux journal perdrait une écriture ACQUITTÉE. Une génération validée vit dans le
//    journal jusqu'à ce qu'une ouverture la reporte dans le volume ; l'écarter est une perte
//    silencieuse, sous un rapport qui dit « tout va bien » ;
//  - **le lire sous le NOUVEL encodage** le refuserait par « sceau refusé », donc par
//    `VAULT_STORAGE_GENERATION_CORRUPT` — « restaurer une sauvegarde » — pour un volume intact.
//
// Ce runtime le REJOUE donc une fois, sous l'ancien encodage, puis écrit du format 4 : le vidage qui
// termine toute récupération s'en charge. La fenêtre dure exactement une ouverture, et le rapport la
// PUBLIE (`journalFormat`) — un contrôle qu'on ne publie pas finit par être supposé actif.
//
// ## Comment un journal de format 3 est fabriqué ici
//
// Aucun runtime ne l'écrit plus, et il ne faut pas non plus l'écrire à la main : ce sont les octets
// du produit qui doivent être éprouvés. Il est donc COMPOSÉ de deux gestes du produit — un magasin
// sans fraîcheur écrit la charge et la racine de #18 (enregistrements sous l'identité d'un bloc,
// racine sans empreinte), puis `scellerFraicheur` pose sur cette racine l'empreinte de région que
// #19 ajoutait, et le champ de format passe à 3. Les formats 3 et 4 ont exactement la même
// disposition ; seul le numéro et l'étiquette de domaine des enregistrements les séparent.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import {
  GENERATION_FORMAT,
  GENERATION_FORMAT_IDENTITE_DE_BLOC,
  RACINE_ENTETE_V2_OCTETS,
  RACINE_OCTETS,
  SURCOUT_ENREGISTREMENT,
  ZONE_ENREGISTREMENTS,
  decoderRacine,
  offsetDeRacine,
  racineDeSequence,
} from "../../src/vm/generation-format.mjs";
import { empreinteDeRegion, scellerFraicheur } from "../../src/vm/generation-fraicheur.mjs";
import { GenerationStore } from "../../src/vm/generation-store.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { VolumeChiffre } from "../../src/vm/volume-chiffre.mjs";
import { FORMAT_VOLUME_V3, dispositionV3 } from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE = 8 * SECTOR_SIZE;
const DISPOSITION = dispositionV3(TAILLE);
const IDENTIFIANT = "9".repeat(32);
const SANS_RANGEMENT = Number.MAX_SAFE_INTEGER;

let compteur = 0;

function banc() {
  compteur += 1;
  const magasin = createSyncAccessStore();
  return {
    magasin,
    nom: `journal4-${compteur}.gen`,
    support: new Uint8Array(DISPOSITION.tailleSupport),
    boite: { octets: null },
  };
}

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

async function scellementDuBanc() {
  return Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
  });
}

/**
 * La couche chiffrée du volume, SEULE : elle lit le volume sans ouvrir aucun journal.
 *
 * C'est ce qu'il faut pour un témoin négatif — ouvrir un magasin rejouerait la génération que le
 * témoin est justement censé ne pas encore voir.
 */
async function volumeSeul(cadre) {
  return new VolumeChiffre({
    volume: "vol",
    scellement: await scellementDuBanc(),
    disposition: DISPOSITION,
    lireSupport: (offset, longueur) => cadre.support.slice(offset, offset + longueur),
    ecrireSupport: (offset, octets) => cadre.support.set(octets, offset),
  });
}

/** Ouvre une session complète : scellement partagé, couche chiffrée du volume, magasin. */
async function session(cadre, fraicheur) {
  const scellement = await scellementDuBanc();
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

/** Écrit `octets` dans le journal du banc, à `position`. */
async function ecrireDansLeJournal(cadre, position, octets) {
  const handle = await cadre.magasin.openHandle(cadre.nom);
  handle.write(octets, { at: position });
  handle.flush();
  handle.close();
  cadre.magasin.abandon(cadre.nom);
}

/** La racine qui fait autorité dans le journal du banc, décodée. */
function racineDuJournal(cadre) {
  const octets = cadre.magasin.snapshot(cadre.nom);
  let retenue = null;
  for (const rang of [0, 1]) {
    const secteur = octets.slice(offsetDeRacine(rang), offsetDeRacine(rang) + RACINE_OCTETS);
    const lue = decoderRacine(secteur, { tailleVolume: TAILLE });
    if (lue.valide && (retenue === null || lue.racine.sequence > retenue.sequence)) {
      retenue = lue.racine;
    }
  }
  return retenue;
}

/**
 * Fabrique un journal de format 3 portant une génération VALIDÉE et non rangée.
 *
 * Les deux gestes sont ceux du produit : un magasin sans fraîcheur dépose et valide — donc écrit des
 * enregistrements sous l'identité d'un BLOC et une racine sans empreinte —, puis `scellerFraicheur`
 * pose l'empreinte de la région que #19 ajoutait, et le champ de format passe à 3.
 */
async function journalDeFormat3(cadre, ecritures) {
  // Le volume est SCELLÉ À NEUF d'abord, comme le fait la création d'un volume v3 : sans cela ses
  // secteurs seraient des zéros que rien n'authentifie, et le témoin négatif ci-dessous ne
  // distinguerait pas « pas encore rejoué » de « jamais scellé ».
  await (await volumeSeul(cadre)).scellerTout(0);

  const avant = await session(cadre, null);
  for (const [offset, octets] of ecritures) await avant.magasin.deposer(offset, octets);
  await avant.magasin.valider();
  fermer(cadre, avant);

  const racine = racineDuJournal(cadre);
  assert.equal(racine.nombreEntrees, ecritures.length, "la racine scelle la charge déposée");

  const scellement = await scellementDuBanc();
  const empreinte = await empreinteDeRegion({
    lireRegion: async (offset, longueur) => cadre.support.slice(offset, offset + longueur),
    volume: "vol",
    regionOffset: DISPOSITION.regionOffset,
    regionOctets: DISPOSITION.regionOctets,
  });
  const fraicheur = await scellerFraicheur(scellement, racine.generation, empreinte);

  const position = offsetDeRacine(racineDeSequence(racine.sequence));
  await ecrireDansLeJournal(cadre, position + RACINE_ENTETE_V2_OCTETS, fraicheur);
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, GENERATION_FORMAT_IDENTITE_DE_BLOC, true);
  await ecrireDansLeJournal(cadre, position + 8, version);

  assert.equal(
    racineDuJournal(cadre).format,
    GENERATION_FORMAT_IDENTITE_DE_BLOC,
    "le journal fabriqué doit se DÉCLARER au format 3, sans quoi l'épreuve ne dit rien.",
  );
  return racine;
}

test("l'OUVREUR DU PRODUIT écrit un journal de format 4, et ses enregistrements ne sont pas des blocs", async () => {
  // Le numéro de format dit deux choses ensemble — ce que porte la racine, et sous quelle étiquette
  // de domaine ses enregistrements sont scellés —, et la seule autre combinaison que ce runtime
  // sache écrire est celle de #18, réservée aux bancs. Cette épreuve épingle donc le fait qui
  // compte, par le CHEMIN D'OUVERTURE RÉEL et non par une phrase : ce que le produit écrit est du
  // format 4. Sans elle, un appelant qui déclarerait `fraicheur: null` en production reproduirait le
  // défaut #143 sans que rien ne le signale.
  const magasin = createSyncAccessStore();
  const backend = await openOpfsVolume({
    name: "produit",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: magasin.openHandle,
  });
  await backend.write(0, buildPattern(SECTOR_SIZE, 61));
  await backend.flush();
  await backend.close();

  const journal = magasin.snapshot("produit.gen");
  let formatTrouve = null;
  for (const rang of [0, 1]) {
    const lue = decoderRacine(
      journal.slice(offsetDeRacine(rang), offsetDeRacine(rang) + RACINE_OCTETS),
      { tailleVolume: TAILLE },
    );
    if (lue.valide) formatTrouve = Math.max(formatTrouve ?? 0, lue.racine.format);
  }
  assert.equal(
    formatTrouve,
    GENERATION_FORMAT,
    "l'ouvreur du produit doit écrire le format 4 : c'est lui qui met les enregistrements hors de l'espace d'identités du volume.",
  );
});

test("un journal de format 3 portant une génération VALIDÉE est rejoué sans perte", async () => {
  const cadre = banc();
  const premier = buildPattern(SECTOR_SIZE, 71);
  const second = buildPattern(SECTOR_SIZE, 72);
  await journalDeFormat3(cadre, [
    [0, premier],
    [SECTOR_SIZE, second],
  ]);

  // TÉMOIN NÉGATIF, et c'est lui qui donne son prix au rejeu : avant l'ouverture, le volume ne porte
  // rien de cette génération. Il est pris SANS ouvrir de magasin — en ouvrir un rejouerait
  // justement ce que ce témoin doit trouver absent.
  const avant = await volumeSeul(cadre);
  assert.notDeepEqual([...(await avant.lireSecteurs(0, SECTOR_SIZE))], [...premier]);

  const ouverte = await session(cadre, fraicheurDuBanc(cadre));
  assert.equal(ouverte.magasin.rapport.etat, "rejouee", "la génération validée doit être REJOUÉE");
  assert.equal(
    ouverte.magasin.rapport.journalFormat,
    GENERATION_FORMAT_IDENTITE_DE_BLOC,
    "le rapport doit DIRE que le journal trouvé portait l'ancienne identité d'enregistrement.",
  );
  assert.equal(ouverte.magasin.rapport.enregistrementsRejoues, 2);
  assert.deepEqual([...(await ouverte.chiffre.lireSecteurs(0, SECTOR_SIZE))], [...premier]);
  assert.deepEqual(
    [...(await ouverte.chiffre.lireSecteurs(SECTOR_SIZE, SECTOR_SIZE))],
    [...second],
  );

  // Après le vidage qui clôt la récupération, le journal est en format 4 : la fenêtre a duré
  // exactement une ouverture.
  assert.equal(racineDuJournal(cadre).format, GENERATION_FORMAT);
  fermer(cadre, ouverte);
});

test("après le rejeu, l'ouverture suivante trouve un journal de format 4 et ne rejoue rien", async () => {
  const cadre = banc();
  const motif = buildPattern(SECTOR_SIZE, 73);
  await journalDeFormat3(cadre, [[0, motif]]);

  const migrante = await session(cadre, fraicheurDuBanc(cadre));
  assert.equal(migrante.magasin.rapport.journalFormat, GENERATION_FORMAT_IDENTITE_DE_BLOC);
  fermer(cadre, migrante);

  const suivante = await session(cadre, fraicheurDuBanc(cadre));
  assert.equal(suivante.magasin.rapport.journalFormat, GENERATION_FORMAT);
  assert.equal(suivante.magasin.rapport.etat, "aucune", "il n'y a plus rien à rejouer");
  assert.equal(suivante.magasin.rapport.enregistrementsRejoues, 0);
  // Et les octets rejoués une fois sont toujours là : le rejeu n'a pas été défait par la suite.
  assert.deepEqual([...(await suivante.chiffre.lireSecteurs(0, SECTOR_SIZE))], [...motif]);
  fermer(cadre, suivante);
});

test("un journal de format 3 ABÎMÉ rend le même refus qu'avant, jamais un clair", async () => {
  // Le chemin de compatibilité ne doit pas être une porte : un enregistrement dont le chiffré a
  // changé d'un octet reste refusé, et sous le même code qu'un journal de format courant.
  const cadre = banc();
  await journalDeFormat3(cadre, [[0, buildPattern(SECTOR_SIZE, 74)]]);

  const cible = ZONE_ENREGISTREMENTS + SURCOUT_ENREGISTREMENT + 32;
  const octets = cadre.magasin.snapshot(cadre.nom);
  await ecrireDansLeJournal(cadre, cible, Uint8Array.of(octets[cible] ^ 0xff));

  await assert.rejects(
    () => session(cadre, fraicheurDuBanc(cadre)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("un journal de format 3 dont le NUMÉRO est retourné en 4 est refusé, jamais ouvert de travers", async () => {
  // Le champ de format n'est pas authentifié, et les formats 3 et 4 ont la même disposition : aucune
  // garde de cohérence ne peut les distinguer comme celle qui distingue 2 de 3. Ce que le retournement
  // produit doit donc être dit : les enregistrements sont présentés sous l'autre étiquette de
  // domaine, qui ne vérifie pas. Un REFUS, jamais un clair — et c'est la propriété à tenir.
  const cadre = banc();
  const racine = await journalDeFormat3(cadre, [[0, buildPattern(SECTOR_SIZE, 75)]]);

  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, GENERATION_FORMAT, true);
  await ecrireDansLeJournal(cadre, offsetDeRacine(racineDeSequence(racine.sequence)) + 8, version);

  await assert.rejects(
    () => session(cadre, fraicheurDuBanc(cadre)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});
