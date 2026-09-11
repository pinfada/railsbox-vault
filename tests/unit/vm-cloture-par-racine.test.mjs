/**
 * LA RÈGLE DE CLÔTURE, mesurée sur les trois chemins qui s'ouvrent hors transaction (#182, ADR 0033).
 *
 * > _Toute session qui scelle sous une clé à compteur clôt par une RACINE qui publie les deux
 * > compteurs ; une ouverture qui ne peut pas écrire de racine n'a pas le droit de sceller — elle
 * > est en LECTURE SEULE._
 *
 * C'est la moitié de #182 que la séparation des clés ne pouvait pas fermer. Séparer les clés rend le
 * compteur d'une clé exhaustif ; encore faut-il qu'il soit ÉCRIT. Le § 4.5 de la spécification
 * avouait le contraire — « le compteur est sous-estimé hors transaction » —, et un budget avoué faux
 * reste un budget faux.
 *
 * ## Les trois chemins, et ce que chacun doit rendre
 *
 *  1. **la CRÉATION** — c'est le pire des trois : elle scelle TOUS les secteurs, 2^20 pour 512 Mio,
 *     soit un deux-millième du budget en un seul geste, et son dernier geste était `VLTSEAL1`, pas
 *     une racine. Elle clôt désormais par une racine qui publie les deux compteurs ;
 *  2. **l'INSTALLATION INITIALE du volume applicatif** — le versement écrit le fichier entier hors
 *     transaction, ce qui périme la racine de la naissance ; `daterLaCreation` en réécrit une sur
 *     l'état final ;
 *  3. **une RÉOUVERTURE hors transaction** — elle n'est pas une naissance, elle n'écrira donc aucune
 *     racine, et elle est en LECTURE SEULE. Tout scellement qu'on lui demande est refusé.
 *
 * Le troisième est le seul qui n'existait pas avant #182, et c'est lui qui ferme la classe : les
 * deux premiers écrivaient déjà une racine depuis #181, mais rien n'empêchait un quatrième chemin
 * d'apparaître et de sceller sans compter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { decoderRacine, offsetDeRacine, RACINE_OCTETS } from "../../src/vm/generation-format.mjs";
import { GENERATION_ETATS } from "../../src/vm/generation-recuperation.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { generationJournalName } from "../../src/vm/opfs-sync-access.mjs";
import { FORMAT_VOLUME_V4 } from "../../src/vm/volume-chiffre-format.mjs";
import { GENERATION_FORMAT_DEUX_COMPTEURS } from "../../src/vm/generation-format.mjs";

const NOM = "clot";
const TAILLE = 16 * SECTOR_SIZE;
const SECTEURS = TAILLE / SECTOR_SIZE;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

/** Un secteur entier rempli d'un motif reconnaissable. */
function secteurDe(motif) {
  return new Uint8Array(SECTOR_SIZE).fill(motif);
}

/** La racine qui fait autorité dans le journal du volume, décodée SANS clé. */
function racineDuJournal(store, nom = NOM) {
  const octets = store.snapshot(generationJournalName(nom));
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

function ouvrir(store, options = {}) {
  return openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    ...options,
  });
}

test("CHEMIN 1 — la CRÉATION clôt par une racine qui publie les DEUX compteurs", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrir(store, { transactionnel: false });
  await backend.close();

  const racine = racineDuJournal(store);
  assert.notEqual(racine, null, "une création hors transaction écrit tout de même sa racine");
  assert.equal(racine.format, GENERATION_FORMAT_DEUX_COMPTEURS, "une racine de volume v4");
  assert.equal(racine.sequence, 0, "une racine de NAISSANCE porte la séquence 0");
  assert.equal(racine.generation, 0);
  assert.equal(racine.nombreEntrees, 0);

  // Ce que la racine PUBLIE, et qui n'était publié NULLE PART avant #182 : les scellements que la
  // création vient de consommer. Un secteur par secteur, plus l'empreinte de région, plus le témoin,
  // plus la racine elle-même.
  assert.ok(
    racine.scellementsCumulesVolume >= SECTEURS,
    `le compteur du volume (${racine.scellementsCumulesVolume}) doit couvrir les ${SECTEURS} secteurs scellés`,
  );
  assert.equal(
    racine.scellementsCumulesJournal,
    0,
    "une création ne dépose AUCUN enregistrement : le budget de la clé du journal est neuf, et il le DIT",
  );
});

test("CHEMIN 2 — l'INSTALLATION INITIALE clôt par une racine, sur l'état FINAL du fichier", async () => {
  const store = createSyncAccessStore();

  // Le VERSEMENT : naissance hors transaction, puis écriture du fichier entier, puis fermeture.
  const verse = await ouvrir(store, { transactionnel: false });
  let empreinte;
  try {
    for (let rang = 0; rang < SECTEURS; rang += 1) {
      await verse.write(rang * SECTOR_SIZE, secteurDe(0x40 + rang));
    }
    await verse.flush();
    empreinte = await verse.empreinteDuFichier();
  } finally {
    await verse.close();
  }

  const avant = racineDuJournal(store);
  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
  });
  const apres = racineDuJournal(store);

  assert.notEqual(apres, null);
  assert.equal(apres.format, GENERATION_FORMAT_DEUX_COMPTEURS);
  assert.equal(
    apres.scellementsCumulesJournal,
    0,
    "la datation ne dépose rien non plus : elle rescelle une empreinte de région et une racine",
  );
  // La datation REMPLACE la racine de la naissance : le compteur ne repart pas de zéro, il REPREND.
  assert.ok(
    apres.scellementsCumulesVolume > avant.scellementsCumulesVolume,
    `le compteur doit avancer : ${avant.scellementsCumulesVolume} → ${apres.scellementsCumulesVolume}`,
  );

  // Et l'ouverture qui suit est NORMALE : une racine fait autorité, rien n'est réécrit.
  const backend = await ouvrir(store);
  try {
    assert.equal(backend.generation.rapport.etat, GENERATION_ETATS.aucune);
    assert.equal(backend.generation.rapport.racineInitiale, false);
    assert.deepEqual([...(await backend.read(0, SECTOR_SIZE))], [...secteurDe(0x40)]);
  } finally {
    await backend.close();
  }
});

test("CHEMIN 3 — une RÉOUVERTURE hors transaction ne clôt PAS par une racine, et c'est MESURÉ", async () => {
  // **Le chemin que la tranche T2a ne ferme pas, mesuré plutôt qu'annoncé fermé.**
  //
  // L'ADR 0033, décision 4, donne deux conduites admissibles à une session qui ne peut pas publier
  // ses compteurs : clore par une racine, ou être en LECTURE SEULE. Le volume de COQUILLE
  // (`public/runtime-worker.mjs`) ne peut être ni l'une ni l'autre en l'état — il ÉCRIT un secteur
  // par déverrouillage, donc la lecture seule le casse, et écrire une racine de clôture sur un
  // volume qui en a déjà une demande un geste que `GenerationStore` n'expose pas.
  //
  // Cette épreuve MESURE donc l'écart au lieu de le taire : une réouverture hors transaction scelle,
  // et la racine du volume ne bouge pas. Le jour où T2b donnera son geste au magasin, c'est ELLE qui
  // devra rougir — et son message le dit.
  const store = createSyncAccessStore();
  const naissance = await ouvrir(store, { transactionnel: false });
  const empreinte = await naissance.empreinteDuFichier();
  await naissance.close();
  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
  });
  const avant = racineDuJournal(store);

  // La RÉOUVERTURE hors transaction : le fichier existe, ce n'est donc pas une naissance.
  const relecture = await ouvrir(store, { transactionnel: false });
  try {
    assert.equal(relecture.describe().transactionnel, false);
    // Elle ÉCRIT, et l'écriture ABOUTIT : c'est ce que la coquille fait à chaque déverrouillage.
    await relecture.write(0, secteurDe(0x99));
    await relecture.flush();
    assert.deepEqual([...(await relecture.read(0, SECTOR_SIZE))], [...secteurDe(0x99)]);
  } finally {
    await relecture.close();
  }

  const apres = racineDuJournal(store);
  assert.equal(
    apres.scellementsCumulesVolume,
    avant.scellementsCumulesVolume,
    "ÉCART CONNU (#182, reste de T2b) : cette session a scellé, et aucune racine ne l'a publié. " +
      "Si cette égalité devient fausse, c'est que la clôture par racine a été livrée — et c'est une " +
      "bonne nouvelle : récrivez cette épreuve, elle a fini son travail.",
  );
  assert.equal(apres.sequence, avant.sequence, "aucune racine neuve n'a été écrite");

  // **La SECONDE moitié de l'écart, et elle est plus tranchante que la première.** Cette écriture a
  // changé la RÉGION d'authentification, donc périmé l'empreinte que la dernière racine scelle : un
  // ouvreur TRANSACTIONNEL refuse désormais ce volume par la garde de fraîcheur de l'ADR 0019.
  //
  // Ce n'est pas un défaut de #182 — c'est ce que le § 7.1 écrit depuis #181 : « un appelant qui
  // ÉCRIT le fichier ensuite doit le RE-DATER ». Le volume de COQUILLE ne le rencontre jamais parce
  // que personne ne l'ouvre transactionnellement. Mais cela dit exactement ce que la racine de
  // clôture apporterait : elle rescellerait la région du même geste qu'elle publie les compteurs.
  await assert.rejects(
    () => ouvrir(store),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt),
    "une écriture hors transaction périme la fraîcheur de la dernière racine",
  );
});

test("le REFUS tombe AVANT que le modèle ne produise un octet", async () => {
  // Le budget d'une clé se mesure en invocations d'AES-GCM. Un refus qui arriverait APRÈS le
  // chiffrement aurait consommé exactement ce qu'il prétend interdire.
  const scellement = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });
  assert.equal(scellement.peutSceller, true);
  scellement.interdireDeSceller();
  assert.equal(scellement.peutSceller, false);

  const identite = { generation: 1, rang: 0, adresse: 0, longueur: SECTOR_SIZE };
  for (const geste of [
    () => scellement.scellerBloc(identite, secteurDe(1)),
    () => scellement.scellerEnregistrement(identite, secteurDe(2)),
    () => scellement.rescellerEnSecteurs({ adresse: 0, contenu: secteurDe(3), generation: 1 }),
    () =>
      scellement.scellerRacine({ sequence: 1, generation: 1, tailleVolume: TAILLE }, [], {
        sequencePrecedente: null,
      }),
  ]) {
    await assert.rejects(geste, (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.lectureSeule),
    );
  }
  assert.equal(scellement.scellementsCumulesVolume, 0, "aucun compteur n'a bougé");
  assert.equal(scellement.scellementsCumulesJournal, 0);

  // OUVRIR reste permis, et c'est le sens de « lecture seule » : la session lit ce qui est là.
  const autre = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const scelle = await autre.scellerBloc(identite, secteurDe(7));
  assert.deepEqual([...(await scellement.ouvrirBloc(identite, scelle))], [...secteurDe(7)]);
});
