/**
 * LA RACINE INITIALE DE LA MIGRATION v2 → v3, MESURÉE (#181, ADR 0034).
 *
 * ## Pourquoi cette suite existe
 *
 * L'ADR 0034 décision 4 fait de ce geste **l'une des deux moitiés** de la règle « aucun volume
 * légitime n'est sans racine ». La revue de format de la PR #184 (constat 3) a relevé que c'était la
 * moitié NON MESURÉE : une sonde posée sur les trois branches de `daterLeVolumeMigre` comptait
 * onze passages par « cible sans `poserLaRacineInitiale` » et **zéro appel réel** ; sur tout le
 * dépôt, `grep -rn "poserLaRacineInitiale" tests/` ne rendait rien. Le seul endroit où la vraie
 * cible tournait était l'E2E de migration, qui n'assertionnait ni la racine ni son motif.
 *
 * Cette suite monte donc la VRAIE cible — `createOpfsMigrationTarget` — sur le double déterministe
 * du support, et joue une VRAIE migration v2 → v3. Elle mesure quatre choses, et aucune ne se déduit
 * des autres :
 *
 *  1. **la racine est ÉCRITE** : séquence 0, génération 0, aucune entrée, et un compteur de
 *     scellements égal au nombre de secteurs PLUS un — celui que la racine consomme ;
 *  2. **elle est écrite AVANT le manifeste migré** : un volume déclaré migré porte toujours de quoi
 *     être ouvert, et l'ordre inverse laisserait un volume sain qu'aucun remède ne rouvre ;
 *  3. **l'ouverture suivante est NORMALE** : une racine fait autorité, aucun engagement n'est
 *     consulté, et rien n'est écrit de plus ;
 *  4. **une coupure ENTRE la racine et le manifeste est REPRENABLE** : le volume reste non
 *     identifié, le journal de reprise subsiste, et une seconde migration aboutit.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { createOpfsMigrationTarget } from "../../src/vm/opfs-migration-target.mjs";
import { ouvrirVolumeBrut } from "../../src/vm/opfs-volume-brut.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { GENERATION_ETATS } from "../../src/vm/generation-recuperation.mjs";
import { decoderRacine, offsetDeRacine } from "../../src/vm/generation-format.mjs";
import { migrateVolume } from "../../src/vm/volume-migration.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { CONSISTENCY_KINDS } from "../../src/vm/volume-export.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  parseManifest,
  serializeManifest,
} from "../../src/vm/volume-manifest.mjs";
import { tailleSupportV3 } from "../../src/vm/volume-chiffre-format.mjs";

const NOM = "migre";
const TAILLE = 8 * SECTOR_SIZE;
const SECTEURS = TAILLE / SECTOR_SIZE;
const APP = { id: "railsbox-vault-reference", version: "1.0.0" };

/** Contenu déterministe du volume v2 : la migration ne doit pas en changer un octet de clair. */
function contenuV2() {
  const octets = new Uint8Array(TAILLE);
  for (let index = 0; index < TAILLE; index += 1) octets[index] = (index * 7 + 3) & 0xff;
  return octets;
}

/** Manifeste v2 du volume source : un v2 ne porte AUCUN identifiant, et c'est ce que v3 ajoute. */
function manifesteV2() {
  return createManifest({
    formatVersion: 2,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: APP,
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
  });
}

function attentes() {
  return {
    runtime: { version: "1.4.2", artifact: null },
    app: { id: APP.id },
    supportedFormat: { current: MANIFEST_FORMAT_VERSION, minReadable: 1 },
  };
}

/** La sauvegarde VÉRIFIÉE qu'une étape destructive exige (ADR 0011). */
async function sauvegardeDe(octets) {
  const { archive } = await exportVolumeToBytes({
    source: {
      size: octets.byteLength,
      read: (offset, longueur) => octets.slice(offset, offset + longueur),
    },
    manifest: manifesteV2(),
    consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "double déterministe" },
  });
  return {
    source: {
      byteLength: archive.byteLength,
      read: (offset, longueur) => archive.slice(offset, offset + longueur),
    },
  };
}

/**
 * Monte la VRAIE cible de migration sur le double du support, et JOURNALISE les gestes qui portent
 * l'ordre du § 7.1 : l'écriture de la racine initiale, et l'inscription du manifeste migré.
 *
 * Rien n'est simulé du côté du produit : `poserLaRacineInitiale` ouvre le vrai voisin `.gen` par
 * `openHandle`, y écrit une vraie racine scellée, et c'est cette racine que l'épreuve relit.
 */
function cibleReelle(store, { couperApresLaRacine = false } = {}) {
  const gestes = [];
  const fichiers = new Map();
  const ecrire = async (nom, octets) => {
    fichiers.set(nom, octets.slice());
  };
  const cible = createOpfsMigrationTarget(NOM, {
    stat: async () => ({ present: true, size: store.sizeOf(NOM) }),
    readManifest: async () => fichiers.get(`${NOM}.manifest`) ?? null,
    readSidecar: async (nom) => fichiers.get(nom) ?? null,
    revoke: async () => {
      fichiers.delete(`${NOM}.manifest`);
    },
    writeSidecar: async (nom, octets) => {
      if (nom === `${NOM}.manifest`) gestes.push("commit-manifeste");
      await ecrire(nom, octets);
    },
    removeSidecar: async (nom) => {
      fichiers.delete(nom);
      store.resize(nom, 0);
    },
    openVolume: ({ name, size }) => ouvrirVolumeBrut({ name, size, openHandle: store.openHandle }),
    ouvrirHandle: store.openHandle,
  });
  return {
    gestes,
    fichiers,
    poserManifesteSource: () => ecrire(`${NOM}.manifest`, serializeManifest(manifesteV2())),
    cible: {
      ...cible,
      async poserLaRacineInitiale(appel) {
        const rendu = await cible.poserLaRacineInitiale(appel);
        gestes.push("poser-racine");
        if (couperApresLaRacine) throw new Error("coupure programmée après la racine initiale");
        return rendu;
      },
    },
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

/** Relit la RACINE que la migration a laissée dans le voisin `.gen`, sans passer par le produit. */
function racineDuJournal(store) {
  const octets = store.snapshot(`${NOM}.gen`);
  return decoderRacine(octets.subarray(offsetDeRacine(0), offsetDeRacine(0) + 512), {
    tailleVolume: TAILLE,
  });
}

test("la migration v2 → v3 ÉCRIT sa racine initiale, et elle porte ce qu'une naissance porte", async () => {
  const store = createSyncAccessStore();
  await poserLeVolumeV2(store);
  const montage = cibleReelle(store);
  await montage.poserManifesteSource();

  const rapport = await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: await sauvegardeDe(contenuV2()),
    cle: CLE_DE_TEST,
  });
  assert.equal(rapport.migrated, true);
  assert.equal(rapport.toVersion, MANIFEST_FORMAT_VERSION);
  assert.equal(store.sizeOf(NOM), tailleSupportV3(TAILLE), "le fichier a gagné sa région");

  const racine = racineDuJournal(store);
  assert.equal(racine.valide, true, racine.raison ?? "");
  assert.equal(racine.racine.sequence, 0, "une racine de NAISSANCE porte la séquence 0");
  assert.equal(racine.racine.generation, 0);
  assert.equal(racine.racine.nombreEntrees, 0);
  assert.equal(
    racine.racine.scellementsCumules,
    SECTEURS + 1,
    "la conversion scelle un secteur par secteur, et la racine en consomme un de plus",
  );
});

test("la racine initiale est posée AVANT que le manifeste migré ne soit inscrit", async () => {
  // C'est l'ordre du § 7.1, et il est le contrat : un volume déclaré migré porte toujours de quoi
  // être ouvert. L'ordre inverse laisserait un volume sain que `VOLUME_SANS_RACINE` refuse et
  // qu'aucune reprise ne rattrape — le manifeste le déclarant déjà v3.
  const store = createSyncAccessStore();
  await poserLeVolumeV2(store);
  const montage = cibleReelle(store);
  await montage.poserManifesteSource();

  await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: await sauvegardeDe(contenuV2()),
    cle: CLE_DE_TEST,
  });

  const racine = montage.gestes.indexOf("poser-racine");
  const manifeste = montage.gestes.indexOf("commit-manifeste");
  assert.notEqual(racine, -1, "la migration DATE son résultat");
  assert.notEqual(manifeste, -1, "la migration inscrit son manifeste");
  assert.ok(racine < manifeste, `ordre attendu racine → manifeste, relevé : ${montage.gestes}`);
});

test("le volume migré s'ouvre NORMALEMENT, sans qu'aucun engagement ne soit consulté", async () => {
  const store = createSyncAccessStore();
  await poserLeVolumeV2(store);
  const montage = cibleReelle(store);
  await montage.poserManifesteSource();
  await migrateVolume({
    target: montage.cible,
    expectations: attentes(),
    backup: await sauvegardeDe(contenuV2()),
    cle: CLE_DE_TEST,
  });
  const inscrit = parseManifest(montage.fichiers.get(`${NOM}.manifest`));

  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: inscrit.volume.id,
    openHandle: store.openHandle,
  });
  try {
    const rapport = backend.generation.rapport;
    assert.equal(rapport.etat, GENERATION_ETATS.aucune, "chemin normal : une racine décide");
    assert.equal(rapport.racineInitiale, false, "rien n'est écrit de plus : la racine est déjà là");
    assert.equal(rapport.motifDeLaRacine, null);
    assert.equal(rapport.voisinIgnore, false, "aucun voisin d'engagement n'a jamais existé ici");
    assert.deepEqual([...(await backend.read(0, TAILLE))], [...contenuV2()]);
  } finally {
    await backend.close();
  }
});

test("une coupure ENTRE la racine et le manifeste est REPRENABLE", async () => {
  // L'ordre choisi rend cette coupure sûre, et c'est tout son intérêt : le volume reste NON
  // IDENTIFIÉ — le boot le refuse plutôt que de l'ouvrir de travers —, et le journal de reprise dit
  // d'où repartir. Une seconde migration retrouve la racine de séquence 0, la prend pour autorité,
  // et aboutit.
  const store = createSyncAccessStore();
  await poserLeVolumeV2(store);
  const coupe = cibleReelle(store, { couperApresLaRacine: true });
  await coupe.poserManifesteSource();
  const sauvegarde = await sauvegardeDe(contenuV2());

  await assert.rejects(
    () =>
      migrateVolume({
        target: coupe.cible,
        expectations: attentes(),
        backup: sauvegarde,
        cle: CLE_DE_TEST,
      }),
    /coupure programmée/,
  );
  assert.equal(coupe.fichiers.has(`${NOM}.manifest`), false, "le volume reste NON IDENTIFIÉ");
  assert.ok(coupe.fichiers.has(`${NOM}.migration`), "le journal de reprise dit d'où repartir");
  assert.equal(racineDuJournal(store).valide, true, "la racine, elle, est déjà durable");

  // La REPRISE : même support, même journal, cible qui ne coupe plus.
  const reprise = cibleReelle(store);
  for (const [nom, octets] of coupe.fichiers) reprise.fichiers.set(nom, octets);
  const rapport = await migrateVolume({
    target: reprise.cible,
    expectations: attentes(),
    backup: sauvegarde,
    cle: CLE_DE_TEST,
  });
  assert.equal(rapport.migrated, true);
  const inscrit = parseManifest(reprise.fichiers.get(`${NOM}.manifest`));
  assert.equal(inscrit.formatVersion, MANIFEST_FORMAT_VERSION);

  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: inscrit.volume.id,
    openHandle: store.openHandle,
  });
  try {
    assert.deepEqual([...(await backend.read(0, TAILLE))], [...contenuV2()]);
  } finally {
    await backend.close();
  }
});
