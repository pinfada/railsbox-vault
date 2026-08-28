// Les CONTRÔLES DE SÉQUENCE, présentés par le chemin de production (#19, `SEC-GEN-001`).
//
// #18 a livré les refus du format : `ouvrirRacine` sait dire `VAULT_CRYPTO_REJEU`, `ouvrirBloc`
// aussi. Ce que `SECURITY.md` disait sans le masquer, c'est que **personne ne les appelait avec un
// minimum** : `sequenceMinimale` et `generationMinimale` valaient `null` sur tout le chemin de
// production, si bien que les deux refus étaient du code mort.
//
// Ce fichier les rend vivants. Il ne mesure pas le modèle — `vm-format-chiffre-modele.test.mjs` le
// fait déjà — mais le PARCOURS D'UNE CHARGE et le MAGASIN, c'est-à-dire les deux endroits où un
// minimum peut réellement être présenté.
//
// Chaque épreuve négative porte son TÉMOIN POSITIF, dans le même test : sans lui, un refus qui
// tomberait pour n'importe quelle raison — une racine illisible, un journal vide — passerait pour la
// preuve de la garde.

import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { CRYPTO_ERROR_CODES } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import { parcourirCharge } from "../../src/vm/generation-charge.mjs";
import {
  SURCOUT_ENREGISTREMENT,
  ZONE_ENREGISTREMENTS,
  decoderRacine,
  offsetDeRacine,
  RACINES,
  RACINE_OCTETS,
} from "../../src/vm/generation-format.mjs";
import { JournalDeGeneration } from "../../src/vm/generation-journal.mjs";
import { GENERATION_ETATS, GenerationStore } from "../../src/vm/generation-store.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

const TAILLE_VOLUME = 32 * 512;
const IDENTIFIANT = "2".repeat(32);
/** Assez haut pour qu'aucune validation ne déclenche de rangement : la charge doit s'accumuler. */
const SANS_RANGEMENT = 1024 * 1024;

function creerSupport(tailleVolume = TAILLE_VOLUME) {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(tailleVolume);
  return {
    magasin,
    volume,
    tailleVolume,
    lireVolume: async (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: async (offset, octets) => {
      volume.set(octets, offset);
    },
    barriereVolume: async () => {},
  };
}

function scellementDuBanc() {
  return Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
}

async function ouvrirMagasin(support, nom, reste = {}) {
  return GenerationStore.ouvrir({
    volume: "vol",
    handle: await support.magasin.openHandle(nom),
    tailleVolume: support.tailleVolume,
    scellement: await scellementDuBanc(),
    // La fraîcheur de région et le témoin sont l'objet de `vm-generation-fraicheur.test.mjs` ; ici
    // ils sont DÉCLARÉS absents, jamais oubliés — c'est la règle de l'ADR 0015 sur les attentes,
    // appliquée aux dépendances du magasin.
    fraicheur: null,
    seuilPointDeControle: SANS_RANGEMENT,
    ...reste,
    lireVolume: support.lireVolume,
    ecrireVolume: support.ecrireVolume,
    barriereVolume: support.barriereVolume,
  });
}

/** Les racines PRÉSENTES sur le support, décodées, de la plus ancienne à la plus récente. */
function racinesDuJournal(octets, tailleVolume) {
  const lues = [];
  for (let rang = 0; rang < RACINES; rang += 1) {
    const secteur = octets.slice(offsetDeRacine(rang), offsetDeRacine(rang) + RACINE_OCTETS);
    const lue = decoderRacine(secteur, { tailleVolume });
    if (lue.valide) lues.push(lue.racine);
  }
  return lues.sort((a, b) => a.sequence - b.sequence);
}

test("une racine AUTHENTIQUE mais antérieure au plancher de séquence est refusée en session", async () => {
  // Le magasin n'ouvre jamais deux racines de la même session, et c'est justement pourquoi le
  // plancher doit être PRÉSENTÉ : sans lui, un support qui échangerait les deux emplacements sous
  // une session ouverte ferait autorité avec la racine d'avant. L'épreuve fabrique les deux racines
  // par le chemin normal — chaque vidage en écrit une VIDE —, puis les présente au parcours.
  const support = creerSupport();

  for (let tour = 0; tour < 3; tour += 1) {
    const magasin = await ouvrirMagasin(support, "seq.gen");
    if (tour === 0) await magasin.deposer(0, buildPattern(512, 21));
    await magasin.valider();
    await magasin.pointDeControle();
    magasin.close();
    support.magasin.abandon("seq.gen");
  }

  const racines = racinesDuJournal(support.magasin.snapshot("seq.gen"), TAILLE_VOLUME);
  assert.equal(racines.length, 2, "les deux emplacements portent une racine");
  const [ancienne, recente] = racines;
  assert.equal(ancienne.nombreEntrees, 0, "un vidage écrit une racine VIDE");
  assert.equal(recente.nombreEntrees, 0);
  assert.ok(recente.sequence > ancienne.sequence);

  const parcourir = async (racine) => {
    const journal = new JournalDeGeneration("vol", await support.magasin.openHandle("seq.gen"));
    try {
      return await parcourirCharge({
        journal,
        volume: "vol",
        tailleVolume: TAILLE_VOLUME,
        racine,
        scellement: await scellementDuBanc(),
        sequenceMinimale: recente.sequence,
        generationPlancher: 1,
      });
    } finally {
      journal.close();
      support.magasin.abandon("seq.gen");
    }
  };

  // TÉMOIN POSITIF : la racine qui FAIT autorité passe sous son propre plancher.
  assert.equal(await parcourir(recente), 0);

  // ÉPREUVE : la précédente, authentique et scellée par la même clé, est refusée — et le classement
  // est REJEU, pas « sceau refusé » : l'étiquette a vérifié, l'écart est ÉTABLI.
  await assert.rejects(
    () => parcourir(ancienne),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      erreur.context.cause === CRYPTO_ERROR_CODES.replay,
  );
});

test("un ENREGISTREMENT authentique d'une génération antérieure est refusé dans une charge plus récente", async () => {
  // Une charge cumule PLUSIEURS générations tant qu'aucun point de contrôle ne l'a vidée
  // (ADR 0016, décision 2). Leur suite est donc CROISSANTE par construction : un enregistrement
  // authentique mais d'une génération inférieure à celle de l'enregistrement qui le précède ne peut
  // pas venir de ce journal.
  //
  // L'épreuve fabrique l'enregistrement de substitution PAR LE CHEMIN NORMAL, dans un journal
  // voisin : même volume, même clé, même adresse, même rang, même longueur — seule la GÉNÉRATION
  // diffère. Rien n'est forgé, et c'est ce qui rend la démonstration opposable.
  const support = creerSupport();
  const motifs = [buildPattern(512, 41), buildPattern(512, 42), buildPattern(512, 43)];
  const enregistrement = SURCOUT_ENREGISTREMENT + 512;

  // Journal DONNEUR : les trois enregistrements sont déposés puis validés d'un seul coup, donc tous
  // portent la génération 1.
  const donneur = await ouvrirMagasin(support, "don2.gen");
  for (const [rang, motif] of motifs.entries()) await donneur.deposer(rang * 512, motif);
  assert.equal(await donneur.valider(), 1);
  donneur.close();
  support.magasin.abandon("don2.gen");

  // Journal CIBLE : une validation par dépôt, donc les générations 1, 2 et 3 dans la même charge.
  const cible = await ouvrirMagasin(support, "cib2.gen");
  for (const [rang, motif] of motifs.entries()) {
    await cible.deposer(rang * 512, motif);
    assert.equal(await cible.valider(), rang + 1);
  }
  cible.close();
  support.magasin.abandon("cib2.gen");
  // L'état du journal AVANT toute réouverture : une réouverture rejoue puis VIDE, et il n'y aurait
  // alors plus de charge où substituer quoi que ce soit.
  const complet = support.magasin.snapshot("cib2.gen");

  // TÉMOIN POSITIF : la cible intacte se rejoue, ses trois enregistrements compris.
  const intact = await ouvrirMagasin(support, "cib2.gen");
  assert.equal(intact.rapport.etat, GENERATION_ETATS.rejouee);
  assert.equal(intact.rapport.enregistrementsRejoues, 3);
  intact.close();
  support.magasin.abandon("cib2.gen");

  // Le troisième enregistrement du donneur (génération 1) prend la place du troisième de la cible
  // (génération 3). Adresse, rang et longueur sont identiques : seule la génération change, et le
  // sceau du donneur est AUTHENTIQUE sous cette identité.
  const position = ZONE_ENREGISTREMENTS + 2 * enregistrement;
  const octets = support.magasin.snapshot("don2.gen").slice(position, position + enregistrement);
  const handle = await support.magasin.openHandle("cib2.gen");
  handle.truncate(0);
  handle.write(complet, { at: 0 });
  handle.write(octets, { at: position });
  handle.flush();
  handle.close();
  support.magasin.abandon("cib2.gen");

  await assert.rejects(
    () => ouvrirMagasin(support, "cib2.gen"),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      erreur.context.cause === CRYPTO_ERROR_CODES.replay,
    "la génération 1 ne peut pas suivre la génération 2 dans une même charge",
  );
});

test("TRONCATURE et AUGMENTATION restent refusées, et leur cause traverse la couche de stockage", async () => {
  // Ces deux refus sont ceux de #18 ; #19 ne les invente pas, il les RELIE aux codes de stockage —
  // ce que l'ADR 0016 promettait dans son tableau sans qu'aucune épreuve du magasin ne le vérifie.
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support, "tronc.gen");
  await magasin.deposer(0, buildPattern(512, 51));
  await magasin.deposer(512, buildPattern(512, 52));
  await magasin.valider();
  magasin.close();
  support.magasin.abandon("tronc.gen");
  // L'état du journal AVANT toute réouverture : une réouverture rejoue puis VIDE, et il n'y aurait
  // alors plus de charge à amputer.
  const complet = support.magasin.snapshot("tronc.gen");

  // TÉMOIN POSITIF : la charge entière se rejoue.
  const intact = await ouvrirMagasin(support, "tronc.gen");
  assert.equal(intact.rapport.etat, GENERATION_ETATS.rejouee);
  assert.equal(intact.rapport.enregistrementsRejoues, 2);
  intact.close();
  support.magasin.abandon("tronc.gen");

  // TRONCATURE : le journal ne porte plus le second enregistrement, que la racine authentifie.
  const handle = await support.magasin.openHandle("tronc.gen");
  handle.truncate(0);
  handle.write(complet, { at: 0 });
  handle.truncate(ZONE_ENREGISTREMENTS + SURCOUT_ENREGISTREMENT + 512);
  handle.flush();
  handle.close();
  support.magasin.abandon("tronc.gen");

  await assert.rejects(
    () => ouvrirMagasin(support, "tronc.gen"),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt),
    "une charge amputée n'est pas une charge plus courte",
  );
});

test("une génération AUGMENTÉE d'une entrée est refusée, et le refus traverse en VAULT_STORAGE_*", async () => {
  // L'AUGMENTATION ne se fabrique pas en ajoutant des octets au journal : le parcours est borné par
  // ce que la racine authentifie, et des octets au-delà ne sont simplement pas lus. Elle se constate
  // là où elle se juge — quand la SUITE TROUVÉE est présentée à la racine. L'épreuve la présente
  // donc par le geste de production lui-même, `Scellement#ouvrirRacine`, et vérifie que le refus du
  // modèle arrive au stockage avec sa cause intacte : c'est la ligne du tableau de l'ADR 0016 que
  // rien ne vérifiait.
  const scellement = await scellementDuBanc();
  const entrees = [0, 1].map((rang) => ({
    adresse: rang * 512,
    longueur: 512,
    rang,
    etiquette: new Uint8Array(16).fill(rang + 1),
  }));
  const scelle = await scellement.scellerRacine(
    { sequence: 1, generation: 1, tailleVolume: TAILLE_VOLUME },
    entrees,
    { sequencePrecedente: null },
  );
  const entete = {
    sequence: 1,
    generation: 1,
    tailleVolume: TAILLE_VOLUME,
    nombreEntrees: scelle.entete.nombreEntrees,
    longueurCharge: scelle.entete.longueurCharge,
    scellementsCumules: scelle.entete.scellementsCumules,
  };
  const attentes = { tailleVolume: TAILLE_VOLUME, sequenceMinimale: 1 };

  // TÉMOIN POSITIF : la suite exacte est acceptée.
  await scellement.ouvrirRacine(entete, scelle, entrees, attentes);

  const augmentee = [
    ...entrees,
    { adresse: 1024, longueur: 512, rang: 2, etiquette: new Uint8Array(16) },
  ];
  await assert.rejects(
    () => scellement.ouvrirRacine(entete, scelle, augmentee, attentes),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      erreur.context.cause === CRYPTO_ERROR_CODES.truncation,
  );
  await assert.rejects(
    () => scellement.ouvrirRacine(entete, scelle, entrees.slice(0, 1), attentes),
    (erreur) =>
      isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt) &&
      erreur.context.cause === CRYPTO_ERROR_CODES.truncation,
  );
});
