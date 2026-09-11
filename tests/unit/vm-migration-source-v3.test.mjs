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
import { createOpfsMigrationTarget } from "../../src/vm/opfs-migration-target.mjs";
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
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
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
  MANIFEST_FORMAT_VERSION,
  createManifest,
  parseManifest,
  serializeManifest,
} from "../../src/vm/volume-manifest.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  decoderEnTeteDeVolume,
  dispositionDuVolume,
  identifiantVolumeEnTexte,
  tailleSupportDuVolume,
} from "../../src/vm/volume-chiffre-format.mjs";

const NOM = "source-v3";
const TAILLE = 8 * SECTOR_SIZE;
const APP = { id: "railsbox-vault-reference", version: "1.0.0" };

/** Contenu déterministe du volume v2 : la chaîne entière ne doit pas en changer un octet de clair. */
function contenuV2() {
  const octets = new Uint8Array(TAILLE);
  for (let index = 0; index < TAILLE; index += 1) octets[index] = (index * 7 + 3) & 0xff;
  return octets;
}

function manifesteDe(formatVersion, extra = {}) {
  return createManifest({
    formatVersion,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: APP,
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    ...extra,
  });
}

function attentes(current = MANIFEST_FORMAT_VERSION) {
  return {
    runtime: { version: "1.4.2", artifact: null },
    app: { id: APP.id },
    supportedFormat: { current, minReadable: 1 },
  };
}

/** La sauvegarde VÉRIFIÉE qu'une étape destructive exige (ADR 0011). */
async function sauvegardeDe(octets, manifest) {
  const { archive } = await exportVolumeToBytes({
    source: {
      size: octets.byteLength,
      read: (offset, longueur) => octets.slice(offset, offset + longueur),
    },
    manifest,
    consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "double déterministe" },
    // Une archive de volume CHIFFRÉ porte toujours un engagement, scellé sous la clé (#181).
    ...(manifest.formatVersion >= FORMAT_VOLUME_V3 ? { cle: CLE_DE_TEST } : {}),
  });
  return {
    source: {
      byteLength: archive.byteLength,
      read: (offset, longueur) => archive.slice(offset, offset + longueur),
    },
  };
}

/**
 * Monte la VRAIE cible de migration sur le double du support, et journalise ses gestes.
 *
 * `ouvrir` permet de substituer l'ouverture des voisins, pour couper une LECTURE du journal de
 * génération là où elle a lieu — dans le magasin, et non dans la cible.
 */
function cibleReelle(store, { ouvrir = store.openHandle } = {}) {
  const gestes = [];
  const fichiers = new Map();
  const cible = createOpfsMigrationTarget(NOM, {
    stat: async () => ({ present: true, size: store.sizeOf(NOM) }),
    readManifest: async () => fichiers.get(`${NOM}.manifest`) ?? null,
    // Les voisins que le MAGASIN écrit — `.gen`, le témoin, l'engagement — vivent dans le double du
    // support, pas dans la carte des manifestes : les lire ailleurs ferait croire à la migration
    // qu'un volume n'a pas de journal, ce qui est précisément l'état qu'elle doit savoir distinguer.
    readSidecar: async (nom) =>
      fichiers.get(nom) ?? (store.sizeOf(nom) > 0 ? store.snapshot(nom) : null),
    revoke: async () => {
      fichiers.delete(`${NOM}.manifest`);
    },
    writeSidecar: async (nom, octets) => {
      gestes.push(`ecrire:${nom}`);
      fichiers.set(nom, octets.slice());
    },
    removeSidecar: async (nom) => {
      gestes.push(`retirer:${nom}`);
      fichiers.delete(nom);
      store.resize(nom, 0);
    },
    openVolume: ({ name, size }) => ouvrirVolumeBrut({ name, size, openHandle: store.openHandle }),
    ouvrirHandle: ouvrir,
  });
  return {
    gestes,
    fichiers,
    cible,
    poserManifeste: (manifest) => fichiers.set(`${NOM}.manifest`, serializeManifest(manifest)),
  };
}

/** Pose le fichier v2 — brut, sans en-tête ni région — dans le double du support. */
async function poserLeVolumeV2(store) {
  const handle = await store.openHandle(NOM);
  try {
    handle.truncate(TAILLE);
    handle.write(contenuV2(), { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/**
 * PRODUIT un volume v3 RÉEL, par le seul geste du dépôt qui en écrive un : la migration v2 → v3.
 *
 * Elle laisse derrière elle exactement ce qu'un v3 en service porte — en-tête `VLTVOL03`, région
 * scellée, et un voisin `.gen` portant sa racine de naissance au format 4.
 */
async function poserUnV3Reel(store) {
  await poserLeVolumeV2(store);
  const montage = cibleReelle(store);
  montage.poserManifeste(manifesteDe(2));
  const rapport = await migrateVolume({
    target: montage.cible,
    expectations: attentes(FORMAT_VOLUME_V3),
    toVersion: FORMAT_VOLUME_V3,
    backup: await sauvegardeDe(contenuV2(), manifesteDe(2)),
    cle: CLE_DE_TEST,
  });
  assert.equal(rapport.migrated, true, "le v3 d'épreuve doit être produit par le produit lui-même");
  // Le manifeste et l'identifiant sont ceux que le PRODUIT vient d'écrire : les refabriquer à la
  // main ferait porter l'épreuve sur l'idée qu'on s'en fait, et non sur le volume qui est là.
  montage.manifesteV3 = parseManifest(montage.fichiers.get(`${NOM}.manifest`));
  montage.identifiant = identifiantDuFichier(store, FORMAT_VOLUME_V3);
  return montage;
}

/** L'identifiant que l'EN-TÊTE du fichier porte, relu sans passer par le manifeste. */
function identifiantDuFichier(store, formatVersion) {
  const entete = store.snapshot(NOM).subarray(0, EN_TETE_OCTETS);
  const lu = decoderEnTeteDeVolume(entete, { formatVersion });
  assert.equal(lu.valide, true, lu.raison ?? "");
  return identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
}

/** Le voisin `.gen` tel que le support le porte. Un fichier de zéro octet EST un voisin absent. */
function journalPresent(store) {
  return store.sizeOf(`${NOM}.gen`) > 0;
}

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

test("MESURE — ce runtime ne sait pas EXPORTER un v3, donc il ne peut pas en faire la sauvegarde", async () => {
  // **Trouvé en livrant le correctif du CRITICAL, et ce n'est pas lui.** Un pas destructif exige une
  // sauvegarde VÉRIFIÉE — `assertPreuveDisponible` refuse explicitement qu'un consentement nommé en
  // tienne lieu (ADR 0011). Or `ouvrirPourExport` ouvre le volume par `openOpfsVolume` dès que son
  // format atteint `MIN_VOLUME_FORMAT_VERSION`, et ce runtime REFUSE un en-tête v3 en renvoyant à la
  // migration. Les deux règles se referment donc de nouveau l'une sur l'autre, un cran plus loin :
  // **un v3 est migrable, à condition de détenir déjà une archive faite par le runtime précédent.**
  //
  // Ce n'est pas corrigé ici, et c'est délibéré : ouvrir un chemin d'export pour un format que ce
  // runtime n'ouvre pas est une DÉCISION — que déclare le manifeste de l'archive, qui scelle son
  // engagement, ce que devient la génération validée que le journal porte encore — et elle ne
  // s'invente pas en fin de chantier. Elle est portée au mainteneur avec cette mesure.
  //
  // L'épreuve MESURE l'état, elle ne garde pas une règle : le jour où ce chemin s'ouvre, elle
  // rougit, et c'est voulu.
  const store = createSyncAccessStore();
  const montage = await poserUnV3Reel(store);
  assert.equal(montage.manifesteV3.formatVersion, FORMAT_VOLUME_V3);

  await assert.rejects(
    () =>
      ouvrirPourExport({
        name: NOM,
        cle: CLE_DE_TEST,
        formatVersion: FORMAT_VOLUME_V3,
        openHandle: store.openHandle,
      }),
    (erreur) => {
      // Le refus est celui de l'OUVERTURE, et il nomme la migration comme remède — ce qui est
      // exactement la boucle : pour migrer il faut une sauvegarde, et pour la faire il faut ouvrir.
      assert.match(erreur.message, /migr/i, `refus inattendu : ${erreur.code} — ${erreur.message}`);
      return true;
    },
    "ce runtime ne sait pas ouvrir un v3, donc il ne sait pas en faire une archive",
  );
});
