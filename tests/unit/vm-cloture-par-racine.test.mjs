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
import { encoderInfoDeDomaine } from "../../src/vm/derivation/cle-de-domaine.mjs";
import { GENERATION_FORMAT_DEUX_COMPTEURS } from "../../src/vm/generation-format.mjs";

const NOM = "clot";
const TAILLE = 16 * SECTOR_SIZE;
const SECTEURS = TAILLE / SECTOR_SIZE;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

/**
 * SONDE qui compte les invocations RÉELLES de `crypto.subtle.encrypt` sous la clé d'un domaine.
 *
 * Elle enveloppe `deriveKey` pour retenir l'`info` de chaque clé dérivée, puis `encrypt` pour
 * compter celles qui passent sous la clé voulue. Rien du produit n'est modifié : c'est la
 * plate-forme qui est observée, et c'est ce qui rend la mesure opposable — une épreuve qui
 * demanderait son compte au produit ne mesurerait que ce que le produit croit.
 *
 * C'est la méthode que la revue de sécurité de la PR #186 a employée pour trouver le constat 1, et
 * elle entre ici pour que le prochain écart d'une unité ne passe pas non plus.
 */
function compteur(domaine) {
  // L'info ATTENDUE est construite par l'encodeur DU PRODUIT : la reconnaître à un sous-texte
  // reviendrait à deviner, et un encodage à champs préfixés ne se lit pas à l'œil.
  const attendue = encoderInfoDeDomaine({
    domaine,
    identifiantVolume: IDENTIFIANT,
    versionDeFormat: FORMAT_VOLUME_V4,
  });
  const memes = (octets) =>
    octets instanceof Uint8Array &&
    octets.byteLength === attendue.byteLength &&
    octets.every((octet, index) => octet === attendue[index]);

  const vraiEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const vraiDerive = crypto.subtle.deriveKey.bind(crypto.subtle);
  const duDomaine = new WeakSet();
  let invocations = 0;
  crypto.subtle.deriveKey = async (...arguments_) => {
    const cle = await vraiDerive(...arguments_);
    if (memes(arguments_[0]?.info)) duDomaine.add(cle);
    return cle;
  };
  crypto.subtle.encrypt = async (algorithme, cle, donnees) => {
    if (duDomaine.has(cle)) invocations += 1;
    return vraiEncrypt(algorithme, cle, donnees);
  };
  return {
    get invocations() {
      return invocations;
    },
    rendre() {
      crypto.subtle.encrypt = vraiEncrypt;
      crypto.subtle.deriveKey = vraiDerive;
    },
  };
}

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
  const sonde = compteur("volume");
  let racine;
  try {
    const backend = await ouvrir(store, { transactionnel: false });
    await backend.close();
    racine = racineDuJournal(store);
    // L'ÉGALITÉ, mesurée : ce que la racine publie, PLUS le cran que la reprise ajoutera pour la
    // racine elle-même, vaut exactement ce que la plate-forme a chiffré sous cette clé. Une
    // inégalité ne pouvait pas voir un décompte faux d'une unité — c'est ainsi que le témoin de
    // fraîcheur est resté non publié jusqu'à la revue de la PR #186.
    assert.equal(
      racine.scellementsCumulesVolume + 1,
      sonde.invocations,
      `publié ${racine.scellementsCumulesVolume} + 1 pour la racine, chiffré ${sonde.invocations}`,
    );
  } finally {
    sonde.rendre();
  }

  assert.notEqual(racine, null, "une création hors transaction écrit tout de même sa racine");
  assert.equal(racine.format, GENERATION_FORMAT_DEUX_COMPTEURS, "une racine de volume v4");
  assert.equal(racine.sequence, 0, "une racine de NAISSANCE porte la séquence 0");
  assert.equal(racine.generation, 0);
  assert.equal(racine.nombreEntrees, 0);

  // Et le compte, poste par poste : un secteur par secteur, l'empreinte de région, le témoin RÉSERVÉ.
  assert.equal(
    racine.scellementsCumulesVolume,
    SECTEURS + 2,
    "secteurs + empreinte de région + témoin réservé ; la racine est ajoutée à la reprise",
  );
  assert.equal(
    racine.scellementsCumulesJournal,
    0,
    "une création ne dépose AUCUN enregistrement : le budget de la clé du journal est neuf, et il le DIT",
  );
});

test("CHEMIN 2 — l'INSTALLATION INITIALE clôt par une racine, sur l'état FINAL du fichier", async () => {
  const store = createSyncAccessStore();

  const sonde = compteur("volume");
  let apres;
  try {
    // Le VERSEMENT : naissance hors transaction, puis écriture du fichier entier, puis fermeture.
    const verse = await ouvrir(store, { transactionnel: false, clotureParDatation: true });
    let empreinte;
    let scellementsVerses;
    try {
      for (let rang = 0; rang < SECTEURS; rang += 1) {
        await verse.write(rang * SECTOR_SIZE, secteurDe(0x40 + rang));
      }
      await verse.flush();
      empreinte = await verse.empreinteDuFichier();
      // Le versement rend son COMPTE comme il rend son empreinte : cette session se ferme sans
      // écrire de racine, et ce qu'elle a consommé ne vit nulle part ailleurs.
      scellementsVerses = verse.scellementsCumules;
    } finally {
      await verse.close();
    }

    await daterLaCreation({
      name: NOM,
      cle: CLE_DE_TEST,
      identifiantVolume: IDENTIFIANT,
      openHandle: store.openHandle,
      empreinteVersee: empreinte,
      scellementsVerses,
    });
    apres = racineDuJournal(store);

    // L'ÉGALITÉ, mesurée par le nombre d'invocations réelles. L'inégalité stricte qui tenait ici ne
    // pouvait pas voir l'écart que la revue de format de la PR #186 a trouvé : 38 scellements réels
    // pour 18 publiés — la datation ne reportait que les compteurs de la racine de NAISSANCE, et
    // tout le versement disparaissait. Pour un disque de 512 Mio, c'était la moitié du budget de la
    // clé perdue à l'installation, sur le chemin même que la règle de clôture prétend fermer.
    assert.equal(
      apres.scellementsCumulesVolume + 1,
      sonde.invocations,
      `publié ${apres.scellementsCumulesVolume} + 1 pour la racine, chiffré ${sonde.invocations}`,
    );
  } finally {
    sonde.rendre();
  }

  assert.notEqual(apres, null);
  assert.equal(apres.format, GENERATION_FORMAT_DEUX_COMPTEURS);
  assert.equal(
    apres.scellementsCumulesJournal,
    0,
    "la datation ne dépose rien non plus : elle rescelle une empreinte de région et une racine",
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

test("CHEMIN 3 — une RÉOUVERTURE hors transaction CLÔT par une racine, et le compte est une ÉGALITÉ", async () => {
  // **Le troisième chemin hors transaction, fermé par T2b (#182, amendement du 11 septembre 2026).**
  //
  // L'ADR 0033, décision 4, donne deux conduites à une session qui scelle sous une clé à compteur :
  // clore par une racine, ou être en LECTURE SEULE. Le volume de COQUILLE ne pouvait être ni l'une
  // ni l'autre en T2a — il ÉCRIT un secteur par déverrouillage, si bien que la lecture seule le
  // casse (l'E2E `reprise-coquille-boot-froid` l'a réfutée par exécution), et écrire une racine sur
  // un volume DÉJÀ DATÉ demandait un geste que `GenerationStore` n'exposait pas.
  //
  // Ce geste est `cloturerParRacine`, et il n'ouvre AUCUN second chemin de scellement : il appelle
  // `#vider`, exactement comme la récupération et le point de contrôle le font déjà. La session
  // hors transaction TIENT son magasin sans l'INSTALLER — ses écritures vont droit au volume, ce
  // que la coquille exige — et le referme par une racine.
  //
  // L'épreuve qui vivait ici mesurait l'ÉCART. Elle mesure désormais l'ÉGALITÉ, par le nombre
  // d'invocations RÉELLES de `encrypt` sous la clé du volume : « publié + 1 pour la racine » est ce
  // que le § 4.5 promet, et rien de moins.
  const store = createSyncAccessStore();
  const naissance = await ouvrir(store, { transactionnel: false, clotureParDatation: true });
  const empreinte = await naissance.empreinteDuFichier();
  const scellementsVerses = naissance.scellementsCumules;
  await naissance.close();
  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
    scellementsVerses,
  });
  const avant = racineDuJournal(store);

  const sonde = compteur("volume");
  let apres;
  try {
    // La RÉOUVERTURE hors transaction : le fichier existe, ce n'est donc pas une naissance.
    const relecture = await ouvrir(store, { transactionnel: false });
    try {
      assert.equal(
        relecture.describe().transactionnel,
        false,
        "les écritures vont droit au volume",
      );
      // Elle ÉCRIT, et l'écriture ABOUTIT : c'est ce que la coquille fait à chaque déverrouillage.
      await relecture.write(0, secteurDe(0x99));
      await relecture.flush();
      assert.deepEqual([...(await relecture.read(0, SECTOR_SIZE))], [...secteurDe(0x99)]);
    } finally {
      await relecture.close();
    }
    apres = racineDuJournal(store);

    // L'ÉGALITÉ, et elle est EXACTE — pas « publié + 1 ». Une racine RÉSERVE dans le compte qu'elle
    // publie son propre scellement et celui du témoin qui la suit (revue de sécurité de la PR #186,
    // constat 1) : ce que la dernière racine annonce couvre donc tout ce que la session a chiffré,
    // la clôture comprise. La sonde compte les invocations RÉELLES de `encrypt` sous la clé du
    // domaine `volume` depuis la réouverture.
    assert.equal(
      apres.scellementsCumulesVolume - avant.scellementsCumulesVolume,
      sonde.invocations,
      `publié ${apres.scellementsCumulesVolume - avant.scellementsCumulesVolume}, chiffré ${sonde.invocations}`,
    );
  } finally {
    sonde.rendre();
  }

  assert.equal(
    apres.sequence - avant.sequence,
    2,
    "DEUX racines : celle que la récupération écrit à l'ouverture, et celle de la CLÔTURE",
  );
  assert.equal(
    apres.scellementsCumulesJournal,
    avant.scellementsCumulesJournal,
    "une session hors transaction ne dépose AUCUN enregistrement : le budget du journal ne bouge pas",
  );

  // **La seconde moitié de l'écart, refermée par le même geste.** L'écriture hors transaction avait
  // périmé l'empreinte de région que la dernière racine scelle, et un ouvreur TRANSACTIONNEL
  // refusait ensuite le volume par la garde de fraîcheur de l'ADR 0019. La racine de clôture
  // rescelle la région du même geste qu'elle publie les compteurs : le volume se rouvre.
  const backend = await ouvrir(store);
  try {
    assert.deepEqual(
      [...(await backend.read(0, SECTOR_SIZE))],
      [...secteurDe(0x99)],
      "le clair écrit hors transaction est relu par une ouverture transactionnelle",
    );
  } finally {
    await backend.close();
  }
});

test("CHEMIN 3 — une réouverture qui n'écrit RIEN n'écrit AUCUNE racine", async () => {
  // Le témoin négatif du geste : « toute session qui SCELLE clôt par une racine » ne dit pas
  // « toute session clôt par une racine ». Une clôture inconditionnelle consommerait un scellement
  // pour publier le compte de ce scellement — un compteur qui avancerait d'une unité par ouverture,
  // c'est-à-dire la dérive que la règle a précisément pour objet d'empêcher.
  const store = createSyncAccessStore();
  const naissance = await ouvrir(store, { transactionnel: false, clotureParDatation: true });
  const empreinte = await naissance.empreinteDuFichier();
  const scellementsVerses = naissance.scellementsCumules;
  await naissance.close();
  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
    scellementsVerses,
  });
  const avant = racineDuJournal(store);

  const relecture = await ouvrir(store, { transactionnel: false });
  try {
    await relecture.read(0, SECTOR_SIZE);
  } finally {
    await relecture.close();
  }

  // UNE seule racine : celle que la récupération écrit en ouvrant, comme toute ouverture depuis #16.
  // La CLÔTURE, elle, n'en écrit aucune — c'est ce que cette épreuve mesure.
  const apres = racineDuJournal(store);
  assert.equal(
    apres.sequence - avant.sequence,
    1,
    "la récupération écrit sa racine ; la clôture n'en ajoute AUCUNE quand rien n'a été scellé",
  );
});

test("CHEMIN 3 — une session TUÉE sans `close()` a DÉJÀ publié tout ce qu'elle a scellé", async () => {
  // **Le constat 3 de la revue de sécurité, et c'est celui qui décide de la phrase du § 4.5.**
  //
  // `src/coquille/fins-d-onglet.mjs` écrit la conduite en toutes lettres : « `pagehide` → tuer. Dès
  // que le Worker de confiance VIT, `terminate()` immédiat, quel que soit `event.persisted`, SANS
  // capture et SANS `close()` ». Or c'est `close()` qui appelait la clôture par racine. Le relecteur
  // a mesuré ce que cela coûtait : publié 33 pour 37 réels après UNE session tuée, et la perte est
  // DÉFINITIVE — la session suivante reprend son compteur de la racine amputée. Un lot par onglet
  // fermé, sans borne.
  //
  // La correction est que la racine de clôture SUIT immédiatement le secteur, dans la même séquence
  // d'écriture : il n'existe plus d'instant où un scellement hors transaction ne soit pas publié.
  // Cette épreuve le mesure sur la fin d'onglet ORDINAIRE, celle qui ne referme rien.
  const store = createSyncAccessStore();
  const naissance = await ouvrir(store, { transactionnel: false, clotureParDatation: true });
  const empreinte = await naissance.empreinteDuFichier();
  const scellementsVerses = naissance.scellementsCumules;
  await naissance.close();
  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
    scellementsVerses,
  });
  const avant = racineDuJournal(store);

  const sonde = compteur("volume");
  let tuee;
  let apres;
  try {
    tuee = await ouvrir(store, { transactionnel: false });
    for (const motif of [0x91, 0x92, 0x93]) {
      await tuee.write(0, secteurDe(motif));
      await tuee.flush();
    }
    // **AUCUN `close()` ici, et c'est tout le sujet.** Le relevé est pris sur le support tel qu'un
    // `terminate()` le laisserait. La fermeture qui suit, dans le `finally`, ne sert qu'à rendre le
    // nom au registre d'exclusivité : elle a lieu APRÈS la mesure, et elle n'écrit plus rien.
    apres = racineDuJournal(store);
    assert.equal(
      apres.scellementsCumulesVolume - avant.scellementsCumulesVolume,
      sonde.invocations,
      `une session tuée a perdu ${sonde.invocations - (apres.scellementsCumulesVolume - avant.scellementsCumulesVolume)} scellement(s) : publié ${apres.scellementsCumulesVolume - avant.scellementsCumulesVolume}, chiffré ${sonde.invocations}`,
    );
  } finally {
    sonde.rendre();
    await tuee?.close();
  }

  assert.ok(
    apres.sequence > avant.sequence,
    "une racine a bien été écrite : la clôture suit le secteur, elle ne l'attend pas",
  );

  // Et le volume RESTE ouvrable transactionnellement : la racine écrite en cours de session a
  // rescellé la région, donc la fraîcheur de la dernière racine décrit l'état réel.
  const backend = await ouvrir(store);
  try {
    assert.deepEqual([...(await backend.read(0, SECTOR_SIZE))], [...secteurDe(0x93)]);
  } finally {
    await backend.close();
  }
});

test("CHEMIN 3 — la clôture est IDEMPOTENTE : deux appels n'écrivent qu'une racine", async () => {
  // Constat 6 de la revue de sécurité. La garde comparait le compteur au repère posé à la
  // RÉCUPÉRATION, et `#vider` ne remettait pas ce repère à jour : comme écrire une racine scelle, un
  // second appel voyait de nouveau un écart et écrivait une SECONDE racine. Le produit n'appelait le
  // geste qu'une fois — mais l'ADR 0036 le présente comme un geste PUBLIC du magasin, et un geste
  // public qui n'est pas idempotent est un piège pour son prochain appelant.
  //
  // Depuis que la clôture suit chaque écriture (constat 3), ce n'est plus théorique : `close()`
  // rappelle la clôture après la dernière écriture, et sans l'idempotence il écrirait une racine de
  // plus à chaque fermeture.
  const store = createSyncAccessStore();
  const naissance = await ouvrir(store, { transactionnel: false, clotureParDatation: true });
  const empreinte = await naissance.empreinteDuFichier();
  const scellementsVerses = naissance.scellementsCumules;
  await naissance.close();
  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
    scellementsVerses,
  });

  const session = await ouvrir(store, { transactionnel: false });
  let apresEcriture;
  try {
    await session.write(0, secteurDe(0x77));
    await session.flush();
    apresEcriture = racineDuJournal(store);
  } finally {
    await session.close();
  }
  const apresFermeture = racineDuJournal(store);

  assert.deepEqual(
    {
      sequence: apresFermeture.sequence,
      volume: apresFermeture.scellementsCumulesVolume,
    },
    {
      sequence: apresEcriture.sequence,
      volume: apresEcriture.scellementsCumulesVolume,
    },
    "la fermeture a écrit une SECONDE racine de clôture : la garde n'est pas idempotente",
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

test("LE COMPTEUR NE DÉRIVE PAS : cinq ouvertures transactionnelles, à l'unité près", async () => {
  // **Le chemin ORDINAIRE, celui que personne ne mesurait.** Les trois CHEMINS ci-dessus tiennent
  // les ouvertures hors transaction ; la revue de sécurité de la PR #186 a trouvé son constat 1
  // ailleurs — sur le chemin transactionnel nominal, où l'écart croissait d'exactement UN par
  // session, de façon monotone et sans borne. La cause : le témoin de fraîcheur est scellé sous la
  // clé du volume APRÈS la racine, si bien que le témoin de la DERNIÈRE racine d'une session
  // n'était publié nulle part, et jamais rattrapé.
  //
  // Ce qui ne pouvait pas le voir : une inégalité. Ce qui le voit : le nombre d'invocations réelles,
  // relevé sur la plate-forme et confronté au compteur publié, session après session.
  const store = createSyncAccessStore();
  const sonde = compteur("volume");
  try {
    const creation = await ouvrir(store, { transactionnel: false });
    await creation.close();

    for (let session = 1; session <= 5; session += 1) {
      const backend = await ouvrir(store);
      try {
        await backend.write(0, secteurDe(session));
        await backend.flush();
      } finally {
        await backend.close();
      }
      const racine = racineDuJournal(store);
      assert.equal(
        racine.scellementsCumulesVolume + 1,
        sonde.invocations,
        `session ${session} : publié ${racine.scellementsCumulesVolume} + 1, chiffré ${sonde.invocations}`,
      );
    }
  } finally {
    sonde.rendre();
  }
});

test("LE COMPTEUR DU JOURNAL NE DÉRIVE PAS NON PLUS, sur les mêmes ouvertures", async () => {
  // Le second compteur a la même exigence, et il n'a pas la même forme : rien n'est scellé sous la
  // clé du journal après la racine, si bien qu'il n'a rien à réserver. L'épreuve le MESURE plutôt
  // que de le supposer — c'est la seule façon de savoir qu'un jour où il aura, lui aussi, quelque
  // chose à réserver, quelqu'un s'en apercevra.
  const store = createSyncAccessStore();
  const sonde = compteur("journal");
  try {
    const creation = await ouvrir(store, { transactionnel: false });
    await creation.close();

    for (let session = 1; session <= 3; session += 1) {
      const backend = await ouvrir(store);
      try {
        await backend.write(SECTOR_SIZE, secteurDe(0x80 + session));
        await backend.flush();
      } finally {
        await backend.close();
      }
      const racine = racineDuJournal(store);
      assert.equal(
        racine.scellementsCumulesJournal,
        sonde.invocations,
        `session ${session} : publié ${racine.scellementsCumulesJournal}, chiffré ${sonde.invocations}`,
      );
    }
  } finally {
    sonde.rendre();
  }
});

test("une datation SANS compte versé retombe sur les compteurs de la racine ÉCARTÉE", async () => {
  // **Le chemin DÉGRADÉ, et il existe encore.** Un versement d'avant la garde de la revue de format
  // de la PR #186 ne rend pas son compte : `scellementsVerses` vaut alors `null`, et la datation ne
  // dispose plus que des compteurs de la racine de NAISSANCE. Elle les REPORTE — c'est le défaut
  // n° 2 de l'ADR 0035 — au lieu de repartir de zéro.
  //
  // L'épreuve existe parce que le compte versé MASQUE ce report quand il est présent : il le domine
  // toujours. Sans elle, retirer le report ne ferait plus rougir personne, et la prochaine
  // régression sur ce chemin-là passerait — ce que la campagne de mutation a justement montré.
  const store = createSyncAccessStore();

  const verse = await ouvrir(store, { transactionnel: false, clotureParDatation: true });
  let empreinte;
  try {
    await verse.write(0, secteurDe(0x11));
    await verse.flush();
    empreinte = await verse.empreinteDuFichier();
  } finally {
    await verse.close();
  }

  const naissance = racineDuJournal(store);
  assert.ok(
    naissance.scellementsCumulesVolume >= SECTEURS,
    "la naissance a scellé tous les secteurs",
  );

  await daterLaCreation({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
    // AUCUN compte versé : c'est le contrat d'un appelant qui n'en rend pas.
  });

  const apres = racineDuJournal(store);
  assert.ok(
    apres.scellementsCumulesVolume >= naissance.scellementsCumulesVolume,
    `le compteur ne recule pas : ${naissance.scellementsCumulesVolume} → ${apres.scellementsCumulesVolume}`,
  );
  assert.ok(
    apres.scellementsCumulesVolume >= SECTEURS,
    "les scellements de la CRÉATION sont repris, et non remis à zéro",
  );
});
