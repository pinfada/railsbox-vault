// RECUL D'UNE GÉNÉRATION, et REJEU DU TÉMOIN (#142, #144 ; ADR 0019 amendé).
//
// Deux constats de la pré-revue adverse de #20 portent sur le même endroit — ce qu'une ouverture a
// le droit de conclure de l'état où elle trouve les deux racines et le témoin — et ce fichier les
// éprouve ensemble.
//
//  - **#144.** L'alternance des racines (§ 6.6) garde `s − 1` LISIBLE sur le support : le point de
//    recul est dans le fichier, par construction, et il n'y a rien à « détenir ». Abîmer les
//    512 octets de la racine `s` fait donc reculer le volume d'une génération. Ce que l'ouverture
//    doit en faire dépend du TÉMOIN, et de lui seul :
//    · témoin CONCORDANT avec la racine retenue — c'est une coupure pendant l'écriture de `s`, le
//      cas normal que l'alternance existe pour absorber. On ouvre, et la mise au rebut est PUBLIÉE ;
//    · témoin ABSENT — l'adversaire a dû le neutraliser pour que `s − 1` passe, et une coupure a pu
//      l'emporter : rien ne distingue les deux, et le refus est le seul état qui ne mente pas ;
//    · témoin EN AVANCE sur la racine retenue — c'est le recul que #19 ferme déjà, et cette borne
//      est éprouvée ici pour qu'on sache où la nouvelle règle s'arrête.
//  - **#142.** Le témoin est FONGIBLE pour un volume donné : sa séquence vit dans le clair, ses
//    données associées sont constantes, et deux témoins successifs sont aussi authentiques l'un que
//    l'autre. Une copie réinstallée après une restauration d'archive — qui retire journal et témoin
//    sans toucher à l'identifiant ni à la clé — fait donc refuser un volume SAIN. Le sceau achète la
//    non-forgerie, pas la non-fongibilité, et la seule chose qu'on puisse corriger sans ancre
//    monotone est le MESSAGE : il doit nommer les deux lectures et le geste qui en sort, avec sa
//    CONDITION.

import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { CRYPTO_ERROR_CODES } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import {
  RACINES,
  RACINE_OCTETS,
  decoderRacine,
  offsetDeRacine,
} from "../../src/vm/generation-format.mjs";
import { GardeDeFraicheur } from "../../src/vm/generation-fraicheur.mjs";
import { GENERATION_ETATS, poserRapport } from "../../src/vm/generation-recuperation.mjs";
import { GenerationStore } from "../../src/vm/generation-store.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

const TAILLE = 64 * SECTOR_SIZE;
/** Identifiant FIXE du banc : il entre dans les données associées de chaque sceau. */
const IDENTIFIANT_BANC = "4".repeat(32);
const JOURNAL = "vol.gen";

/**
 * Banc DÉTERMINISTE : un journal dans le double d'accès synchrone, un volume et une région en
 * mémoire, et un témoin dans une boîte. Les épreuves portent sur la machine d'état du magasin — ce
 * qu'il retient, ce qu'il refuse, ce qu'il publie —, pas sur la disposition du fichier de volume,
 * qui est éprouvée par le chemin de production dans `vm-generation-fraicheur.test.mjs`.
 */
function banc() {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(TAILLE);
  const region = Uint8Array.from({ length: 4096 }, (_, index) => (index * 11 + 5) % 256);
  const boite = { octets: null };
  const source = () => ({
    regionOffset: 0,
    regionOctets: region.byteLength,
    lireRegion: async (offset, longueur) => region.slice(offset, offset + longueur),
    lireTemoin: async () => boite.octets,
    ecrireTemoin: async (octets) => {
      boite.octets = octets;
    },
  });
  // `fraicheur` est explicite plutôt que par défaut : les épreuves de COMPATIBILITÉ ouvrent avec
  // `null` — c'est-à-dire comme #18 le faisait, sans témoin ni empreinte de région.
  const ouvrir = async (fraicheur = source()) =>
    GenerationStore.ouvrir({
      volume: "vol",
      handle: await magasin.openHandle(JOURNAL),
      tailleVolume: TAILLE,
      scellement: await Scellement.ouvrir({
        volume: IDENTIFIANT_BANC,
        cleOctets: CLE_DE_TEST,
        formatVersion: 3,
      }),
      fraicheur,
      lireVolume: async (offset, longueur) => volume.slice(offset, offset + longueur),
      ecrireVolume: async (offset, octets) => {
        volume.set(octets, offset);
      },
      barriereVolume: async () => {},
    });
  return { magasin, volume, region, boite, ouvrir };
}

/** Rend le handle du journal au double : le banc le tient à la main, l'ouvreur du produit non. */
function rendre(magasin) {
  magasin.abandon(JOURNAL);
}

/** Emplacement de la racine de séquence la PLUS HAUTE, et sa séquence. C'est la racine `s`. */
function racineLaPlusHaute(magasin) {
  const octets = magasin.snapshot(JOURNAL);
  let rang = null;
  let sequence = -1;
  for (let candidat = 0; candidat < RACINES; candidat += 1) {
    const offset = offsetDeRacine(candidat);
    if (octets.byteLength < offset + RACINE_OCTETS) continue;
    const lue = decoderRacine(octets.slice(offset, offset + RACINE_OCTETS), {
      tailleVolume: TAILLE,
    });
    if (!lue.valide) continue;
    if (lue.racine.sequence > sequence) {
      sequence = lue.racine.sequence;
      rang = candidat;
    }
  }
  assert.notEqual(rang, null, "le banc doit avoir écrit au moins une racine lisible");
  return { rang, sequence };
}

/**
 * ABÎME les 512 octets d'une racine : des octets quelconques, ni vierges ni décodables.
 *
 * C'est exactement la capacité que #144 décrit — écrire un secteur dans un fichier voisin de
 * l'OPFS —, et rien de plus : ni la clé, ni une copie du volume, ni une copie du journal.
 */
async function abimerRacine(magasin, rang) {
  const handle = await magasin.openHandle(JOURNAL);
  handle.write(buildPattern(RACINE_OCTETS, 0xa7), { at: offsetDeRacine(rang) });
  handle.flush();
  handle.close();
  rendre(magasin);
}

/** Remet le journal dans un état capturé plus tôt, ou le VIDE. C'est le retour arrière du support. */
async function remplacerJournal(magasin, octets) {
  const handle = await magasin.openHandle(JOURNAL);
  handle.truncate(0);
  if (octets.byteLength > 0) handle.write(octets, { at: 0 });
  handle.flush();
  handle.close();
  rendre(magasin);
}

/**
 * Amène le banc à l'état de la reproduction de #144 : DEUX validations sans point de contrôle, si
 * bien que les deux emplacements portent une racine lisible et que la charge du journal dépasse ce
 * que la racine `s − 1` authentifie.
 *
 * Rend le témoin tel qu'il était à `s − 1`, celui de `s`, et l'emplacement de `s`.
 */
async function deuxValidations() {
  const banc_ = banc();

  const magasin = await banc_.ouvrir();
  await magasin.deposer(0, buildPattern(SECTOR_SIZE, 121));
  await magasin.valider();
  // Le témoin est écrit APRÈS la racine et sa barrière : celui-ci atteste `s − 1`.
  const temoinPrecedent = banc_.boite.octets;
  await magasin.deposer(SECTOR_SIZE, buildPattern(SECTOR_SIZE, 122));
  await magasin.valider();
  const temoinCourant = banc_.boite.octets;
  magasin.close();
  rendre(banc_.magasin);

  assert.notEqual(temoinPrecedent, null, "la première validation doit avoir posé un témoin");
  assert.notEqual(temoinCourant, temoinPrecedent, "la seconde validation en pose un autre");

  const haute = racineLaPlusHaute(banc_.magasin);
  return { banc: banc_, temoinPrecedent, temoinCourant, haute };
}

test("une racine abîmée à côté d'une racine lisible, SANS témoin, est REFUSÉE : rien ne la distingue d'un recul", async () => {
  // #144. L'adversaire écrit 512 octets sur l'emplacement de la racine `s` et supprime le témoin —
  // le § 6.9 dit lui-même que le second geste est gratuit. La racine `s − 1` redevient autorité, et
  // toutes les écritures acquittées de la génération `s` disparaissent.
  //
  // Ce qui est refusé n'est PAS « une racine abîmée » — une validation déchirée par une coupure est
  // le cas normal que l'alternance existe pour absorber, et l'épreuve suivante le montre. C'est la
  // CONJONCTION : une racine abîmée, une racine retenue, et aucun témoin pour dire laquelle faisait
  // autorité. Ni un volume neuf, ni un volume restauré, ni un premier point de contrôle ne la
  // produisent.
  const { banc: b, haute } = await deuxValidations();
  await abimerRacine(b.magasin, haute.rang);
  b.boite.octets = null;

  await assert.rejects(
    () => b.ouvrir(),
    (erreur) => {
      assert.ok(
        isStorageError(erreur, STORAGE_ERROR_CODES.generationRootCorrupt),
        `code inattendu : ${erreur.code}`,
      );
      // Le message doit porter les DEUX lectures : sans elles, l'exploitant croit à une panne de
      // support là où c'est peut-être un recul délibéré, et réciproquement.
      assert.match(erreur.message, /coupure/i);
      assert.match(erreur.message, /recul|reculer/i);
      assert.match(erreur.message, /témoin/i);
      assert.match(erreur.message, /restaurer une sauvegarde/i);
      return true;
    },
  );
  rendre(b.magasin);
});

test("une coupure qui déchire la racine `s` laisse le témoin à `s − 1` : le volume ROUVRE, et la mise au rebut est PUBLIÉE", async () => {
  // #144, l'autre moitié. Le témoin s'écrit APRÈS la racine et sa barrière (§ 6.9) : une coupure
  // dans cette fenêtre laisse un témoin EN RETARD, qui CONCORDE avec la racine retenue. C'est le cas
  // que l'alternance existe pour absorber, et le refuser enverrait « restaurer une sauvegarde » à
  // chaque coupure au mauvais instant.
  //
  // Ce qui manquait n'est donc pas un refus, c'est un CODE : les octets de la génération `s`
  // déposés au-delà de ce que `s − 1` authentifie sont écartés, et le § 10.2 promet que cette mise
  // au rebut est « publiée, jamais tue ». Elle ne l'était pas dans ce chemin.
  const { banc: b, temoinPrecedent, haute } = await deuxValidations();
  await abimerRacine(b.magasin, haute.rang);
  b.boite.octets = temoinPrecedent;

  const magasin = await b.ouvrir();
  const rapport = magasin.rapport;
  assert.equal(rapport.etat, "rejouee");
  assert.ok(rapport.octetsEcartes > 0, `octets écartés : ${rapport.octetsEcartes}`);
  assert.equal(
    rapport.code,
    STORAGE_ERROR_CODES.generationDiscarded,
    "une mise au rebut d'octets déposés porte son code, § 10.2 — publiée, jamais tue",
  );
  magasin.close();
  rendre(b.magasin);
});

test("une racine abîmée sous un témoin EN AVANCE reste un recul : le plancher de séquence refuse", async () => {
  // La BORNE de la règle précédente, et elle est verte avant elle : quand le témoin atteste encore
  // `s`, le plancher de séquence refuse la racine `s − 1` sans que rien de neuf soit nécessaire.
  // C'est pour cela que l'adversaire doit neutraliser le témoin — et c'est ce qui rend son absence
  // décisive.
  const { banc: b, temoinCourant, haute } = await deuxValidations();
  await abimerRacine(b.magasin, haute.rang);
  b.boite.octets = temoinCourant;

  await assert.rejects(
    () => b.ouvrir(),
    (erreur) => {
      assert.ok(
        isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt),
        `code inattendu : ${erreur.code}`,
      );
      assert.equal(erreur.context.cause, CRYPTO_ERROR_CODES.replay);
      return true;
    },
  );
  rendre(b.magasin);
});

test("un témoin REJOUÉ après une restauration nomme les DEUX lectures et le geste CONDITIONNEL", async () => {
  // #142. La copie d'un témoin authentique, réinstallée après une restauration d'archive, fait
  // refuser un volume sain — et le message d'origine conseillait « restaurer une sauvegarde »,
  // c'est-à-dire le geste qui réarme la boucle : la restauration retire le témoin, l'adversaire le
  // réinstalle, l'ouverture refuse de nouveau.
  //
  // Le sceau du témoin n'y peut rien : il achète la non-forgerie, pas la non-fongibilité, et seule
  // une ancre monotone hors du support fermerait le rejeu (§ 13, question n° 3). Ce qui est
  // corrigeable est le MESSAGE, et il l'est à une condition près : conseiller « retirer le témoin »
  // sans dire QUAND désarmerait la détection du recul réel.
  const b = banc();

  const premier = await b.ouvrir();
  await premier.deposer(0, buildPattern(SECTOR_SIZE, 131));
  await premier.valider();
  await premier.pointDeControle();
  premier.close();
  rendre(b.magasin);

  // 1. La COPIE, prise à un instant où le volume est à la séquence S.
  const copie = b.boite.octets;
  assert.ok(copie.byteLength > 0, "le témoin atteste une racine durable");
  const range = b.volume.slice(0, SECTOR_SIZE);

  // 2. La RESTAURATION d'archive : `discardGeneration` retire le journal ET le témoin, et l'archive
  //    porte le fichier v3 tel quel — donc le même identifiant de volume et la même clé (§ 7.5).
  await remplacerJournal(b.magasin, new Uint8Array(0));
  b.boite.octets = null;

  // 3. La RÉINSTALLATION de la copie. Elle est authentique : mêmes données associées, même clé.
  b.boite.octets = copie;

  await assert.rejects(
    () => b.ouvrir(),
    (erreur) => {
      assert.ok(
        isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt),
        `code inattendu : ${erreur.code}`,
      );
      assert.match(String(erreur.context.cause), /TEMOIN/);
      // Les DEUX lectures que rien ne distingue.
      assert.match(erreur.message, /ramené sous le témoin|a reculé/i);
      assert.match(erreur.message, /réinstall/i);
      assert.match(erreur.message, /restauration d'archive/i);
      // Le geste, et sa CONDITION. Les deux, ou aucun des deux.
      assert.match(erreur.message, /retirer/i);
      assert.match(erreur.message, /délibéré|Sinon/i);
      return true;
    },
  );
  rendre(b.magasin);

  // Et le geste NOMMÉ fonctionne : témoin retiré, le volume rouvre en PREMIÈRE OUVERTURE, et aucun
  // octet n'est perdu — le volume, lui, n'avait jamais bougé.
  b.boite.octets = null;
  const apres = await b.ouvrir();
  assert.equal(apres.rapport.temoinSequence, null);
  assert.equal(apres.rapport.fraicheurRegion, "sans-racine");
  assert.equal(apres.rapport.octetsEcartes, 0, "aucun octet n'est perdu au retrait du témoin");
  assert.deepEqual(
    [...b.volume.slice(0, SECTOR_SIZE)],
    [...range],
    "le volume porte toujours ce que le point de contrôle y a rangé",
  );
  apres.close();
  rendre(b.magasin);
});

test("un volume scellé par #18, dont une racine est déchirée, reste OUVRABLE : il n'a jamais pu avoir de témoin", async () => {
  // CONTRE-CAS de la règle précédente, relevé en revue (#153). Un volume scellé AVANT l'ADR 0019
  // n'écrit ni empreinte de région ni témoin — `tests/unit/vm-generation-fraicheur.test.mjs` › « un
  // magasin sans fraîcheur n'écrit aucun témoin » l'établit. Son témoin n'est donc pas « absent »
  // au sens de la règle : il n'a JAMAIS pu exister, et exiger sa présence rendrait irouvrable, pour
  // toujours, un volume que la migration devait ouvrir — le refus tombant avant toute écriture, le
  // vidage ne répare jamais l'emplacement déchiré.
  //
  // Ce que la racine DIT ici est vérifiable sans le témoin : une racine sans empreinte de région est
  // d'avant #19 (§ 6.8), et la fenêtre dure exactement une ouverture — le vidage qui clôt la
  // récupération écrit une racine à empreinte et pose un témoin. Le contrôle qui garde CETTE porte
  // existe déjà et ne bouge pas : `fraicheurDesarmee` refuse une racine sans empreinte sous un
  // témoin qui en atteste une.
  const b = banc();

  const avant19 = await b.ouvrir(null);
  await avant19.deposer(0, buildPattern(SECTOR_SIZE, 141));
  await avant19.valider();
  await avant19.deposer(SECTOR_SIZE, buildPattern(SECTOR_SIZE, 142));
  await avant19.valider();
  avant19.close();
  rendre(b.magasin);
  assert.equal(b.boite.octets, null, "un magasin sans fraîcheur n'écrit aucun témoin");

  const haute = racineLaPlusHaute(b.magasin);
  await abimerRacine(b.magasin, haute.rang);

  // TÉMOIN POSITIF de la lecture : la racine retenue est bien d'avant #19, donc sans empreinte.
  const migrant = await b.ouvrir();
  assert.equal(migrant.rapport.fraicheurRegion, "migree");
  assert.equal(migrant.rapport.temoinSequence, null);
  migrant.close();
  rendre(b.magasin);

  // Et la fenêtre dure UNE ouverture : le vidage a posé une racine à empreinte et un témoin.
  assert.notEqual(b.boite.octets, null, "le vidage de la migration a posé un témoin");
  const migre = await b.ouvrir();
  assert.equal(migre.rapport.fraicheurRegion, "verifiee");
  migre.close();
  rendre(b.magasin);
});

test("la racine ABÎMÉE n'est pas située : abîmer l'ancienne refuse comme abîmer la récente, et c'est le prix", async () => {
  // Relevé en revue (#153). `abimees` COMPTE les racines illisibles, il ne dit pas LAQUELLE : une
  // racine qu'on ne sait plus décoder n'a plus de séquence lisible, et prétendre la situer
  // reviendrait à croire un en-tête que rien n'authentifie. Abîmer la racine la plus ANCIENNE —
  // celle qui ne fait pas autorité, dont la perte ne coûte rien — produit donc le même refus,
  // alors que rien n'a reculé et qu'aucun octet n'est perdu.
  //
  // C'est une SUR-DÉTECTION, et elle est éprouvée plutôt qu'écrite seulement : le prix de la règle
  // doit être visible: une coupure au mauvais instant, sous un témoin déjà perdu, coûte une
  // restauration. Le témoin, lui, la couvre entièrement — c'est l'épreuve du dessus.
  const { banc: b, haute } = await deuxValidations();
  const ancienne = (haute.rang + 1) % RACINES;
  await abimerRacine(b.magasin, ancienne);
  b.boite.octets = null;

  await assert.rejects(
    () => b.ouvrir(),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.generationRootCorrupt),
    "la racine la plus haute est intacte, et pourtant le refus tombe : la garde ne situe pas l'avarie",
  );
  rendre(b.magasin);
});

test("un état « ecartee » sans octet écarté est REFUSÉ : le code ne peut pas se perdre en silence", async () => {
  // Relevé en revue (#153). Depuis que `code` suit les OCTETS ÉCARTÉS et non l'état, l'invariant
  // « ecartee ⇒ DISCARDED » ne tient plus que par la discipline des appelants — et `poserRapport`
  // publie `octetsEcartes: 0` par défaut, si bien qu'un appelant qui oublierait le détail rendrait
  // un rapport `ecartee` muet, sans qu'aucune épreuve ne le voie. Le rapport est justement ce qui
  // empêche un contrôle d'être supposé actif : il refuse donc l'incohérence au lieu de la publier.
  assert.throws(
    () =>
      poserRapport({
        volume: "vol",
        etat: GENERATION_ETATS.ecartee,
        generation: 1,
        sequence: 1,
        surmemoireMax: 0,
        details: {},
      }),
    /ecartee/,
  );

  // TÉMOIN POSITIF, sur le MÊME chemin : l'état cohérent passe, et il porte son code.
  const rapport = poserRapport({
    volume: "vol",
    etat: GENERATION_ETATS.ecartee,
    generation: 1,
    sequence: 1,
    surmemoireMax: 0,
    details: { octetsEcartes: 50 },
  });
  assert.equal(rapport.code, STORAGE_ERROR_CODES.generationDiscarded);

  // Et un état SANS octet écarté reste muet, comme il doit l'être.
  const aucune = poserRapport({
    volume: "vol",
    etat: GENERATION_ETATS.aucune,
    generation: 1,
    sequence: 1,
    surmemoireMax: 0,
    details: {},
  });
  assert.equal(aucune.code, null);
});

test("`confronter` EXIGE le compte des racines abîmées : un oubli est refusé, jamais suivi", async () => {
  // Relevé en revue (#153). Une valeur par défaut aurait désarmé la garde EN SILENCE pour tout
  // appelant futur — exactement le défaut que l'ADR 0019 a corrigé sur les planchers de séquence,
  // et que `construireGarde` refuse quinze lignes plus bas pour « fraicheur === undefined ». Un
  // `null` (ou un oubli) par défaut, et non décidé, avait déjà laissé SEC-GEN-001 inerte pendant
  // toute la durée de #18.
  const garde = new GardeDeFraicheur({
    volume: "vol",
    scellement: null,
    source: {
      regionOffset: 0,
      regionOctets: 0,
      lireRegion: async () => new Uint8Array(0),
      lireTemoin: async () => null,
      ecrireTemoin: async () => {},
    },
  });
  await assert.rejects(() => garde.confronter(null), TypeError);
});

test("#142 COMPOSÉ à #144 : un témoin ARCHIVÉ puis rejoué fait perdre une génération acquittée sous « verifiee »", async () => {
  // LA LIMITE de la règle de #144, relevée en revue (#153) et éprouvée plutôt qu'écrite seulement.
  //
  // La règle fait décider le TÉMOIN. Elle tient contre l'adversaire qui neutralise le témoin — il
  // obtient un refus, pas un recul. Elle NE TIENT PAS contre l'adversaire de #142, accepté dans la
  // même PR : celui qui en détient une COPIE ANTÉRIEURE. Il archive 62 octets à la séquence `s − 1`,
  // abîme la racine `s`, puis REMET sa copie. Le témoin CONCORDE alors avec la racine retenue,
  // l'ouverture conclut « coupure », et le volume ouvre sur `s − 1`.
  //
  // Ce n'est pas une course : le témoin n'est pas perdu au bon instant, il est archivé À L'AVANCE.
  // C'est le retour arrière du § 9.1 — indétectable, et déjà accepté comme tel — obtenu à moindre
  // coût : 62 octets au lieu d'une copie du volume ET du journal. Le rapport publie `verifiee`, et
  // le seul signal est `DISCARDED`, qui dit « coupure normale ».
  const b = banc();

  const magasin = await b.ouvrir();
  await magasin.deposer(0, buildPattern(SECTOR_SIZE, 151));
  await magasin.valider();
  // 1. L'ARCHIVE : le témoin à `s − 1`, 62 octets, pris longtemps avant l'attaque.
  const archive = b.boite.octets;
  // 2. Une écriture ACQUITTÉE de la génération `s` : le guest a reçu son « oui ».
  await magasin.deposer(SECTOR_SIZE, buildPattern(SECTOR_SIZE, 152));
  await magasin.valider();
  magasin.close();
  rendre(b.magasin);

  // 3. L'ATTAQUE : abîmer la racine `s`, et REMETTRE l'archive.
  const haute = racineLaPlusHaute(b.magasin);
  await abimerRacine(b.magasin, haute.rang);
  b.boite.octets = archive;

  const apres = await b.ouvrir();
  assert.equal(apres.rapport.etat, "rejouee");
  assert.equal(
    apres.rapport.fraicheurRegion,
    "verifiee",
    "le rapport déclare la fraîcheur VÉRIFIÉE : rien n'annonce le recul",
  );
  assert.equal(
    apres.rapport.code,
    STORAGE_ERROR_CODES.generationDiscarded,
    "le seul signal est celui d'une coupure normale",
  );
  assert.ok(apres.rapport.octetsEcartes > 0);
  // Le rangement porte dans le volume ce que la racine `s − 1` authentifie, et rien de plus.
  await apres.pointDeControle();
  apres.close();
  rendre(b.magasin);

  assert.deepEqual(
    [...b.volume.slice(0, SECTOR_SIZE)],
    [...buildPattern(SECTOR_SIZE, 151)],
    "l'écriture de la génération `s − 1` est là",
  );
  assert.deepEqual(
    [...b.volume.slice(SECTOR_SIZE, 2 * SECTOR_SIZE)],
    [...new Uint8Array(SECTOR_SIZE)],
    "l'écriture ACQUITTÉE de la génération `s` a disparu, sans qu'aucun refus ne le dise",
  );
});
