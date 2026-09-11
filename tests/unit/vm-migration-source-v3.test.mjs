/**
 * MIGRER un volume v3 RÉEL — celui que ce dépôt produit, avec son journal (#182, revue de la PR #186).
 *
 * ## Le trou que cette suite comble, et pourquoi il était invisible
 *
 * Les trois niveaux d'épreuves de la migration partaient tous d'un v1 ou d'un v2, jamais d'un v3
 * réel : `vm-migration-racine-initiale.test.mjs` pose un fichier v2 brut sans voisin,
 * `vm-volume-migration.test.mjs` travaille sur des doubles, `vm-migration-v4.test.mjs` appelle
 * `convertirEnV4` sans jamais traverser `migrateVolume`, et l'E2E traverse `v1 → v2 → v3 → v4` en une
 * seule session, si bien que son palier v3 est intermédiaire et n'a jamais de `.gen`. **Le seul
 * chemin qu'un utilisateur empruntera était le seul qui ne fût pas couvert**, et il était CASSÉ :
 *
 *  - CRITICAL de format n° 1 : le lecteur du journal de FORMAT 1 était appliqué au `.gen` de la
 *    source quelle que soit sa version. Un journal de format 4 franchissait le contrôle de marqueur
 *    — `VLTGEN01` est partagé par les formats 1 à 5 — puis échouait au CRC-32 que le format 4 a
 *    justement remplacé par une étiquette. Depuis #181 tout v3 légitime porte une racine, donc un
 *    `.gen` ; depuis #182 un en-tête v3 est refusé en nommant la migration comme seul remède. Un
 *    volume v3 produit par ce dépôt n'était **ni ouvrable ni migrable** ;
 *  - HIGH de format n° 4 : la migration ne consultait JAMAIS l'engagement d'une archive restaurée.
 *    Elle datait d'une racine neuve un v3 sans racine — l'état exact que `VOLUME_SANS_RACINE`
 *    refuse —, si bien que la moitié « restauration » du CRITICAL de #181 redevenait franchissable
 *    par le seul chemin que le produit v4 laisse à une archive v3.
 *
 * ## Le v3 de ces épreuves est produit par le PRODUIT
 *
 * Il n'est pas fabriqué à la main : il est obtenu en migrant un v2 vers la version 3, c'est-à-dire
 * par le seul geste qui écrive un v3 dans ce dépôt. Sa région, son en-tête, ses sceaux et sa racine
 * de naissance sont donc ceux d'un v3 authentique, et non ceux qu'une épreuve aurait cru devoir
 * écrire — c'est ce qui fait la différence entre couvrir le chemin et couvrir son idée.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { ouvrirVolumeBrut } from "../../src/vm/opfs-volume-brut.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { migrateVolume } from "../../src/vm/volume-migration.mjs";
import { ouvrirPourExport } from "../../src/vm/export-du-fichier.mjs";
import { createFaultPlan } from "../../src/vm/fault-plan.mjs";
import { ouvrirGeneration } from "../../src/vm/opfs-generation-voisins.mjs";
import {
  MOTIFS_DE_RACINE_INITIALE,
  autorisationSansRacine,
} from "../../src/vm/opfs-racine-initiale.mjs";
import { exportVolumeToBytes, verifyArchive } from "../../src/vm/archive-en-memoire.mjs";
import { GENERATION_ETATS } from "../../src/vm/generation-recuperation.mjs";
import { RACINE_OCTETS, decoderRacine, offsetDeRacine } from "../../src/vm/generation-format.mjs";
import { CONSISTENCY_KINDS } from "../../src/vm/volume-export.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { createSha256Stream } from "../../src/vm/sha256-stream.mjs";
import {
  descripteurDEngagement,
  encoderFichierDEngagement,
  scellerEngagement,
} from "../../src/vm/archive-engagement.mjs";
import {
  engagementSidecarName,
  generationJournalName,
  temoinSequenceName,
} from "../../src/vm/opfs-sync-access.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  dispositionDuVolume,
  tailleSupportDuVolume,
} from "../../src/vm/volume-chiffre-format.mjs";

import {
  NOM,
  TAILLE,
  attentes,
  cibleReelle,
  contenuV2,
  identifiantDuFichier,
  journalPresent,
  poserUnV3Reel,
  sauvegardeDe,
} from "./support-volume-v3.mjs";

test("un volume v3 RÉEL, avec son journal de naissance, se migre en v4 et rend le même clair", async () => {
  // C'est le CRITICAL de format n° 1, pris par le chemin exact d'un utilisateur : un v3 que ce dépôt
  // vient d'écrire, migré vers v4 par `migrateVolume`, puis OUVERT.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  assert.equal(journalPresent(store), true, "un v3 légitime porte une racine, donc un .gen (#181)");

  const v3 = store.snapshot(NOM);
  const rapport = await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: await sauvegardeDe(v3, montage.manifesteV3),
    cle: CLE_DE_TEST,
  });

  assert.equal(rapport.migrated, true, "un v3 avec son journal DOIT être migrable");
  assert.equal(rapport.fromVersion, FORMAT_VOLUME_V3);
  assert.equal(rapport.toVersion, FORMAT_VOLUME_V4);

  const backend = await openOpfsVolume({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: identifiantDuFichier(store, FORMAT_VOLUME_V4),
    openHandle: store.openHandle,
  });
  try {
    const relu = await backend.read(0, TAILLE);
    assert.deepEqual(
      Array.from(relu),
      Array.from(contenuV2()),
      "le clair traverse v2 → v3 → v4 sans qu'un octet bouge",
    );
  } finally {
    await backend.close();
  }
});

test("une écriture ACQUITTÉE restée dans le journal v3 survit à la migration", async () => {
  // Le report du journal existe pour cela, et pour rien d'autre : une génération validée que le
  // volume ne porte pas encore doit être appliquée AVANT le rescellement. La perdre en silence est
  // exactement ce que `SEC-DURABLE-001` interdit.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  const attendu = new Uint8Array(SECTOR_SIZE).fill(0xa7);

  const brut = await ouvrirVolumeBrut({
    name: NOM,
    size: tailleSupportDuVolume(TAILLE),
    openHandle: store.openHandle,
  });
  try {
    await deposerUneGenerationV3(brut, store, montage.identifiant, attendu);
  } finally {
    await brut.close();
  }

  const v3 = store.snapshot(NOM);
  await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: await sauvegardeDe(v3, montage.manifesteV3),
    cle: CLE_DE_TEST,
  });

  const backend = await openOpfsVolume({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: identifiantDuFichier(store, FORMAT_VOLUME_V4),
    openHandle: store.openHandle,
  });
  try {
    const relu = await backend.read(SECTOR_SIZE, SECTOR_SIZE);
    assert.deepEqual(
      Array.from(relu),
      Array.from(attendu),
      "la charge acquittée du journal v3 doit être DANS le clair v4",
    );
  } finally {
    await backend.close();
  }
});

test("un v3 SANS racine et SANS engagement est REFUSÉ par la migration, sans une écriture", async () => {
  // C'est le HIGH de format n° 4 : l'état que `VOLUME_SANS_RACINE` refuse à l'ouverture était DATÉ
  // par la migration, qui ne demandait rien à personne. Le refus doit tomber avant tout octet.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  etatDUneRestauration(store);
  assert.equal(journalPresent(store), false, "l'état d'une restauration : aucune racine");

  const avant = store.snapshot(NOM);
  await assert.rejects(
    migrateVolume({
      target: montage.cible,
      expectations: attentes(),
      backup: await sauvegardeDe(avant, montage.manifesteV3),
      cle: CLE_DE_TEST,
    }),
    (erreur) => {
      assert.equal(erreur.code, STORAGE_ERROR_CODES.volumeSansRacine);
      return true;
    },
  );
  assert.deepEqual(
    Array.from(store.snapshot(NOM)),
    Array.from(avant),
    "un refus ne touche pas un octet du volume",
  );
  assert.ok(
    montage.fichiers.has(`${NOM}.manifest`),
    "un refus laisse le volume IDENTIFIÉ : une migration refusée ne rend pas inutilisable un fichier intact",
  );
});

test("un v3 restauré, SANS racine mais AVEC son engagement, est vérifié puis migré", async () => {
  // Le second des trois cas de #181. L'engagement est vérifié sous la clé, sur l'empreinte du
  // FICHIER ENTIER, avant qu'un seul clair ne soit produit — puis CONSOMMÉ, comme à l'ouverture.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  etatDUneRestauration(store);
  await deposerUnEngagement(store, montage.identifiant, store.snapshot(NOM));
  const voisin = engagementSidecarName(NOM);
  assert.ok(store.sizeOf(voisin) > 0, "une restauration DÉPOSE l'engagement");

  const rapport = await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: await sauvegardeDe(store.snapshot(NOM), montage.manifesteV3),
    cle: CLE_DE_TEST,
  });
  assert.equal(rapport.migrated, true, "un engagement vérifié AUTORISE la migration");
  assert.equal(store.sizeOf(voisin), 0, "l'engagement est CONSOMMÉ, jamais relu deux fois");

  const backend = await openOpfsVolume({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: identifiantDuFichier(store, FORMAT_VOLUME_V4),
    openHandle: store.openHandle,
  });
  try {
    const relu = await backend.read(0, TAILLE);
    assert.deepEqual(Array.from(relu), Array.from(contenuV2()));
  } finally {
    await backend.close();
  }
});

test("un v3 dont l'engagement porte sur un AUTRE état est REFUSÉ, sans une écriture", async () => {
  // Le mélange que la revue externe du 10 septembre 2026 a employé : des secteurs authentiques venus
  // de deux états du même volume. L'engagement scelle l'empreinte d'un fichier PRÉCIS ; ce qui est
  // sur le support n'est pas ce fichier-là, et la migration doit le dire avant tout clair.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  etatDUneRestauration(store);
  const autreEtat = store.snapshot(NOM).slice();
  autreEtat[autreEtat.byteLength - 1] ^= 0x80;
  await deposerUnEngagement(store, montage.identifiant, autreEtat);

  const avant = store.snapshot(NOM);
  await assert.rejects(
    migrateVolume({
      target: montage.cible,
      expectations: attentes(),
      backup: await sauvegardeDe(avant, montage.manifesteV3),
      cle: CLE_DE_TEST,
    }),
    (erreur) => {
      assert.equal(erreur.code, STORAGE_ERROR_CODES.engagementInvalide);
      return true;
    },
  );
  assert.deepEqual(
    Array.from(store.snapshot(NOM)),
    Array.from(avant),
    "un engagement qui ne tient pas ne coûte pas un octet au volume",
  );
});

/**
 * Met le support dans l'ÉTAT QU'UNE RESTAURATION LAISSE : le fichier de volume, et aucun voisin de
 * génération. `removeOpfsVolume` retire tous les voisins de la cible écrasée — le journal comme le
 * témoin —, et laisser le témoin en place ferait porter l'épreuve sur un RETOUR ARRIÈRE, qui est un
 * autre état et un autre refus.
 */
function etatDUneRestauration(store) {
  store.resize(generationJournalName(NOM), 0);
  store.resize(temoinSequenceName(NOM), 0);
}

/** DÉPOSE l'engagement d'une archive à côté du volume, tel que la restauration l'écrit. */
async function deposerUnEngagement(store, identifiantVolume, octetsDuFichier) {
  const hachage = createSha256Stream();
  hachage.update(octetsDuFichier);
  const engagement = await scellerEngagement({
    cleMaitresse: CLE_DE_TEST,
    empreinteDuContenu: hachage.digest(),
    descripteur: descripteurDEngagement({
      versionDArchive: FORMAT_VOLUME_V3,
      identifiantVolume,
      tailleSupport: tailleSupportDuVolume(TAILLE),
      tailleLogique: TAILLE,
      longueurDuContenu: tailleSupportDuVolume(TAILLE),
    }),
  });
  const octets = encoderFichierDEngagement(engagement);
  const handle = await store.openHandle(engagementSidecarName(NOM));
  try {
    handle.truncate(octets.byteLength);
    handle.write(octets, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/**
 * DÉPOSE une génération VALIDÉE dans le journal v3, et la laisse là — le volume ne la porte pas.
 *
 * Rien n'est simulé : le magasin est celui qu'une session v3 emploie, sous un scellement v3 —
 * c'est-à-dire sous la DEK importée directement en clé AES-GCM, le régime que la v4 remplace. La
 * session se ferme APRÈS `valider()` et AVANT tout point de contrôle : c'est exactement l'état
 * qu'une mort d'onglet laisse derrière une écriture que le guest a vue acquittée.
 */
async function deposerUneGenerationV3(brut, store, identifiant, octets) {
  const magasin = await ouvrirGeneration({
    name: NOM,
    size: TAILLE,
    backend: adaptateurBrut(brut, identifiant),
    scellement: await Scellement.ouvrir({
      volume: identifiant,
      cleOctets: CLE_DE_TEST,
      formatVersion: FORMAT_VOLUME_V3,
    }),
    openHandle: store.openHandle,
    seuilPointDeControle: undefined,
    fautesFraicheur: createFaultPlan(),
    sansRacine: autorisationSansRacine({
      name: NOM,
      motif: MOTIFS_DE_RACINE_INITIALE.engagement,
      backend: adaptateurBrut(brut, identifiant),
      cle: CLE_DE_TEST,
      openHandle: store.openHandle,
    }),
  });
  try {
    await magasin.deposer(SECTOR_SIZE, octets);
    await magasin.valider();
  } finally {
    magasin.close();
  }
}

/** L'adaptateur d'accès brut, à la forme que `ouvrirGeneration` attend d'un backend. */
function adaptateurBrut(brut, identifiant) {
  return {
    disposition: dispositionDuVolume(TAILLE),
    identifiantVolume: identifiant,
    lireRegionAuth: (offset, longueur) => brut.read(offset, longueur),
    lireSupportBrut: (offset, longueur) => brut.read(offset, longueur),
    ecrireSupportBrut: (offset, octets) => brut.write(offset, octets),
    barriereSupportBrute: () => brut.flush(),
  };
}

test("une coupure pendant la LECTURE du journal v3 laisse la migration REPRENABLE à l'identique", async () => {
  // Le solde vient AVANT le journal de reprise, donc avant tout geste destructif : une coupure qui
  // survient pendant qu'il LIT n'a rien écrit. Le volume est encore le v3 qu'il était, son manifeste
  // est intact, et la MÊME sauvegarde vaut encore — une seconde tentative repart donc à l'identique,
  // sans que l'exploitant ait rien à refaire.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  const attendu = new Uint8Array(SECTOR_SIZE).fill(0x5c);

  const brut = await ouvrirVolumeBrut({
    name: NOM,
    size: tailleSupportDuVolume(TAILLE),
    openHandle: store.openHandle,
  });
  try {
    await deposerUneGenerationV3(brut, store, montage.identifiant, attendu);
  } finally {
    await brut.close();
  }

  const avant = store.snapshot(NOM);
  const sauvegarde = await sauvegardeDe(avant, montage.manifesteV3);
  const coupe = cibleReelle(store, { ouvrir: coupantLaLectureDuJournal(store) });
  coupe.poserManifeste(montage.manifesteV3);
  await assert.rejects(
    migrateVolume({
      target: coupe.cible,
      expectations: attentes(),
      backup: sauvegarde,
      cle: CLE_DE_TEST,
    }),
    /coupure programmée/,
  );
  assert.deepEqual(
    Array.from(store.snapshot(NOM)),
    Array.from(avant),
    "une coupure en LECTURE n'a pas touché un octet du volume",
  );

  const reprise = cibleReelle(store);
  reprise.poserManifeste(montage.manifesteV3);
  const rapport = await migrateVolume({
    target: reprise.cible,
    expectations: attentes(),
    // La MÊME sauvegarde : rien n'a bougé, donc rien n'est à reprendre du côté de l'exploitant.
    backup: sauvegarde,
    cle: CLE_DE_TEST,
  });
  assert.equal(rapport.migrated, true, "la seconde tentative aboutit, avec la même preuve");

  const backend = await openOpfsVolume({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: identifiantDuFichier(store, FORMAT_VOLUME_V4),
    openHandle: store.openHandle,
  });
  try {
    assert.deepEqual(
      Array.from(await backend.read(SECTOR_SIZE, SECTOR_SIZE)),
      Array.from(attendu),
      "la charge acquittée survit à la coupure ET à la reprise",
    );
    assert.deepEqual(
      Array.from(await backend.read(0, SECTOR_SIZE)),
      Array.from(contenuV2().subarray(0, SECTOR_SIZE)),
      "et le reste du clair n'a pas bougé",
    );
  } finally {
    await backend.close();
  }
});

/** Fait échouer la PREMIÈRE lecture du voisin `.gen`, là où le magasin la fait. */
function coupantLaLectureDuJournal(store) {
  let coupe = false;
  return async (nom) => {
    const handle = await store.openHandle(nom);
    if (coupe || nom !== generationJournalName(NOM)) return handle;
    return {
      ...handle,
      getSize: () => handle.getSize(),
      truncate: (taille) => handle.truncate(taille),
      write: (octets, options) => handle.write(octets, options),
      flush: () => handle.flush(),
      close: () => handle.close(),
      read() {
        coupe = true;
        throw new Error("coupure programmée pendant la lecture du journal");
      },
    };
  };
}

test("ce runtime EXPORTE un volume v3, charge acquittée comprise, et son engagement tient", async () => {
  // **La boucle que la PR #186 a MESURÉE, refermée ici (second amendement de la DoR de #182).** Un
  // pas destructif exige une sauvegarde VÉRIFIÉE — `assertPreuveDisponible` refuse qu'un
  // consentement nommé en tienne lieu (ADR 0011). Or `ouvrirPourExport` passait par `openOpfsVolume`
  // dès la version 3, et ce runtime refuse un en-tête v3 en renvoyant à la migration : **un v3
  // n'était migrable qu'à condition de détenir déjà une archive faite par le runtime précédent.**
  //
  // L'export d'un v3 emprunte désormais le SEUL lecteur de v3 du dépôt, celui de la migration. Ce
  // que cette épreuve exige n'est donc pas « ça ne lève plus », mais que l'archive porte l'état
  // SOLDÉ : la génération validée que le journal portait encore est DANS le fichier exporté.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  const acquitte = new Uint8Array(SECTOR_SIZE).fill(0xa7);

  const depot = await ouvrirVolumeBrut({
    name: NOM,
    size: tailleSupportDuVolume(TAILLE),
    openHandle: store.openHandle,
  });
  try {
    await deposerUneGenerationV3(depot, store, montage.identifiant, acquitte);
  } finally {
    await depot.close();
  }
  // Le fichier ne porte PAS encore l'écriture : c'est tout l'objet de l'épreuve.
  const avantSolde = store.snapshot(NOM);

  const { brut, rapport } = await ouvrirPourExport({
    name: NOM,
    cle: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
    openHandle: store.openHandle,
  });
  let archive;
  try {
    assert.equal(
      rapport?.etat,
      GENERATION_ETATS.rejouee,
      "l'export d'un v3 SOLDE son journal : sans cela l'archive perdrait une écriture acquittée",
    );
    const exporte = await exportVolumeToBytes({
      source: { size: brut.size(), read: (offset, longueur) => brut.read(offset, longueur) },
      manifest: montage.manifesteV3,
      consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "export v3 avant migration" },
      cle: CLE_DE_TEST,
    });
    archive = exporte.archive;
  } finally {
    await brut.close();
  }

  assert.notDeepEqual(
    Array.from(store.snapshot(NOM).subarray(0, EN_TETE_OCTETS * 4)),
    Array.from(avantSolde.subarray(0, EN_TETE_OCTETS * 4)),
    "solder un v3 ÉCRIT dans son fichier : la charge acquittée y entre",
  );

  // L'archive est une archive v3 au sens de #181 : elle déclare un volume de format 3 et porte un
  // engagement scellé sous la clé du domaine `archive`, version 3 du domaine. Rien de neuf n'a été
  // inventé pour elle.
  const verdict = await verifyArchive(archive, { enforceCompatibility: false });
  assert.equal(verdict.manifest.formatVersion, FORMAT_VOLUME_V3);
  assert.notEqual(verdict.engagement, null, "une archive de volume chiffré PORTE son engagement");
  assert.equal(verdict.engagement.descripteur.versionDArchive, FORMAT_VOLUME_V3);
  assert.equal(verdict.engagement.descripteur.identifiantVolume, montage.identifiant);
});

test("l'archive d'un v3 se RESTAURE et se migre : la charge acquittée arrive dans le clair v4", async () => {
  // Le cycle entier, par les gestes du produit : un v3 en service, une écriture acquittée restée
  // dans son journal, un EXPORT par ce runtime, l'état qu'une restauration laisse — le fichier et
  // son engagement, aucun voisin de génération —, puis la migration. C'est le chemin que le second
  // amendement de la DoR ouvre, et il n'a de valeur que s'il rend le clair.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  const acquitte = new Uint8Array(SECTOR_SIZE).fill(0x3e);

  const depot = await ouvrirVolumeBrut({
    name: NOM,
    size: tailleSupportDuVolume(TAILLE),
    openHandle: store.openHandle,
  });
  try {
    await deposerUneGenerationV3(depot, store, montage.identifiant, acquitte);
  } finally {
    await depot.close();
  }

  const { brut } = await ouvrirPourExport({
    name: NOM,
    cle: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
    openHandle: store.openHandle,
  });
  let archive;
  try {
    const exporte = await exportVolumeToBytes({
      source: { size: brut.size(), read: (offset, longueur) => brut.read(offset, longueur) },
      manifest: montage.manifesteV3,
      consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "export v3 avant migration" },
      cle: CLE_DE_TEST,
    });
    archive = exporte.archive;
  } finally {
    await brut.close();
  }

  // L'ÉTAT QU'UNE RESTAURATION LAISSE : le contenu de l'archive dans le fichier, l'engagement de
  // l'archive à côté, et aucun voisin de génération. Les octets d'engagement viennent de l'ARCHIVE,
  // jamais recalculés ici — un engagement refabriqué prouverait le harnais, pas le produit.
  const verdict = await verifyArchive(archive, { enforceCompatibility: false });
  await poserLeContenuRestaure(store, archive, verdict);
  etatDUneRestauration(store);
  await poserLesOctetsDEngagement(store, encoderFichierDEngagement(verdict.engagement));

  const rapport = await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: { source: { byteLength: archive.byteLength, read: (o, l) => archive.slice(o, o + l) } },
    cle: CLE_DE_TEST,
  });
  assert.equal(rapport.migrated, true, "l'archive faite par CE runtime autorise la migration");

  const backend = await openOpfsVolume({
    name: NOM,
    cle: CLE_DE_TEST,
    identifiantVolume: identifiantDuFichier(store, FORMAT_VOLUME_V4),
    openHandle: store.openHandle,
  });
  try {
    assert.deepEqual(
      Array.from(await backend.read(SECTOR_SIZE, SECTOR_SIZE)),
      Array.from(acquitte),
      "export v3 → archive → restauration → migration : la charge acquittée est dans le clair v4",
    );
    assert.deepEqual(
      Array.from(await backend.read(0, SECTOR_SIZE)),
      Array.from(contenuV2().subarray(0, SECTOR_SIZE)),
      "et le reste du clair n'a pas bougé",
    );
  } finally {
    await backend.close();
  }
});

/** Écrit dans le fichier de volume la section de CONTENU de l'archive, comme la restauration. */
async function poserLeContenuRestaure(store, archive, verdict) {
  const contenu = archive.subarray(
    verdict.contentOffset,
    verdict.contentOffset + verdict.contentLength,
  );
  const handle = await store.openHandle(NOM);
  try {
    handle.truncate(contenu.byteLength);
    handle.write(contenu, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** Dépose les octets d'engagement que l'ARCHIVE porte, à côté du volume. */
async function poserLesOctetsDEngagement(store, octets) {
  const handle = await store.openHandle(engagementSidecarName(NOM));
  try {
    handle.truncate(octets.byteLength);
    handle.write(octets, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/**
 * SONDE : compte les invocations de `encrypt` sous une clé AES-GCM importée depuis la CLÉ DE VOLUME.
 *
 * Un volume v3 n'a pas de clé maîtresse : ses octets sont scellés sous la clé de volume elle-même,
 * importée en clé AES-GCM (`#sousLaCleMaitresse`). C'est donc l'ORIGINE DES OCTETS qui étiquette,
 * pas le nom de l'appelant — la même discipline que `vm-budget-par-domaine.test.mjs`.
 */
function sondeDeLaCleV3() {
  const vraiImport = crypto.subtle.importKey.bind(crypto.subtle);
  const vraiEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const sousLaCleDeVolume = new WeakSet();
  let invocations = 0;
  const memes = (a, b) =>
    a instanceof Uint8Array &&
    a.byteLength === b.byteLength &&
    a.every((octet, index) => octet === b[index]);

  crypto.subtle.importKey = async (...arguments_) => {
    const cle = await vraiImport(...arguments_);
    const nom = arguments_[2]?.name ?? arguments_[2];
    if (arguments_[0] === "raw" && nom === "AES-GCM" && memes(arguments_[1], CLE_DE_TEST)) {
      sousLaCleDeVolume.add(cle);
    }
    return cle;
  };
  crypto.subtle.encrypt = async (algorithme, cle, donnees) => {
    if (sousLaCleDeVolume.has(cle)) invocations += 1;
    return vraiEncrypt(algorithme, cle, donnees);
  };
  return {
    remettreAZero() {
      invocations = 0;
    },
    get invocations() {
      return invocations;
    },
    rendre() {
      crypto.subtle.importKey = vraiImport;
      crypto.subtle.encrypt = vraiEncrypt;
    },
  };
}

/** Le compteur du domaine `volume` que la racine du journal v3 AUTHENTIFIE, ou `null`. */
function compteurDeLaRacineV3(store) {
  const octets = store.snapshot(generationJournalName(NOM));
  if (octets === null || octets.byteLength === 0) return null;
  let retenue = null;
  for (const rang of [0, 1]) {
    const secteur = octets.slice(offsetDeRacine(rang), offsetDeRacine(rang) + RACINE_OCTETS);
    const lue = decoderRacine(secteur, { tailleVolume: TAILLE });
    if (lue.valide && (retenue === null || lue.racine.sequence > retenue.sequence)) {
      retenue = lue.racine;
    }
  }
  return retenue === null ? null : retenue.scellementsCumulesVolume;
}

test("ce que l'export d'un v3 SCELLE est mesuré : TROIS, plus un par secteur rejoué", async () => {
  // **Le constat 1 de la revue de format, et le constat 4 de la revue de sécurité.** Dix endroits du
  // dépôt publiaient « deux scellements sous la clé de volume », et le nombre n'avait jamais été
  // compté. La mesure en donne TROIS quand il n'y a rien à rejouer — l'empreinte de région, la
  // racine de clôture, le témoin — et TROIS PLUS N quand le journal porte N secteurs de charge
  // acquittée. Le nombre n'est donc pas une constante, et il n'est pas borné par le texte : il l'est
  // par le contenu du journal validé.
  //
  // Ce que la mesure confirme aussi, et qui compte autant : les trois — ou 3 + N — passent TOUS par
  // le budget, donc ils sont COMPTÉS dans la racine v3. Ce chemin ne scelle rien hors compteur.
  const sonde = sondeDeLaCleV3();
  try {
    // 1. SANS RIEN À REJOUER : le plancher.
    const sansCharge = createSyncAccessStore();
    await poserUnV3Reel(sansCharge);
    const avantSans = compteurDeLaRacineV3(sansCharge);
    sonde.remettreAZero();
    const ouvert = await ouvrirPourExport({
      name: NOM,
      cle: CLE_DE_TEST,
      formatVersion: FORMAT_VOLUME_V3,
      openHandle: sansCharge.openHandle,
    });
    await ouvert.brut.close();
    const plancher = sonde.invocations;
    assert.equal(
      plancher,
      3,
      `le plancher est une empreinte de région, une racine et un témoin : trois, et non ${plancher}`,
    );
    assert.equal(
      compteurDeLaRacineV3(sansCharge) - avantSans,
      plancher,
      "les trois scellements sont COMPTÉS dans la racine v3 : aucun n'échappe au budget",
    );

    // 2. AVEC UNE écriture acquittée restée dans le journal : trois, plus un.
    const avecCharge = createSyncAccessStore();
    const montage = await poserUnV3Reel(avecCharge);
    const depot = await ouvrirVolumeBrut({
      name: NOM,
      size: tailleSupportDuVolume(TAILLE),
      openHandle: avecCharge.openHandle,
    });
    try {
      await deposerUneGenerationV3(
        depot,
        avecCharge,
        montage.identifiant,
        new Uint8Array(SECTOR_SIZE).fill(0xc4),
      );
    } finally {
      await depot.close();
    }
    const avantAvec = compteurDeLaRacineV3(avecCharge);
    sonde.remettreAZero();
    const exporte = await ouvrirPourExport({
      name: NOM,
      cle: CLE_DE_TEST,
      formatVersion: FORMAT_VOLUME_V3,
      openHandle: avecCharge.openHandle,
    });
    await exporte.brut.close();

    assert.equal(
      sonde.invocations,
      plancher + 1,
      `un secteur rejoué coûte UN scellement de plus : ${sonde.invocations} au lieu de ${plancher + 1}`,
    );
    assert.equal(
      compteurDeLaRacineV3(avecCharge) - avantAvec,
      sonde.invocations,
      "le secteur rejoué est COMPTÉ lui aussi : le budget du v3 suit ce que l'export consomme",
    );
  } finally {
    sonde.rendre();
  }
});
