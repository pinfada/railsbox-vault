/**
 * LE HARNAIS D'UN VOLUME v3 RÉEL — celui que ce dépôt produit, avec son journal de naissance.
 *
 * Il vivait dans `vm-migration-source-v3.test.mjs`, et il en sort pour une raison mesurée : la revue
 * de sécurité de la PR #187 (constat 8) demande que le banc de budget par domaine exerce AUSSI
 * l'export d'un v3, et un second harnais recopié aurait produit un v3 « d'après l'idée qu'on s'en
 * fait » là où celui-ci est produit par le SEUL geste du dépôt qui écrive un v3 : la migration
 * v2 → v3. Deux bancs qui mesurent le même chemin doivent partir du même volume.
 *
 * Rien n'est modifié au passage : les fonctions sont celles de la suite de migration, exportées.
 */

import assert from "node:assert/strict";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { createOpfsMigrationTarget } from "../../src/vm/opfs-migration-target.mjs";
import { ouvrirVolumeBrut } from "../../src/vm/opfs-volume-brut.mjs";
import { migrateVolume } from "../../src/vm/volume-migration.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { CONSISTENCY_KINDS } from "../../src/vm/volume-export.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  parseManifest,
  serializeManifest,
} from "../../src/vm/volume-manifest.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  decoderEnTeteDeVolume,
  identifiantVolumeEnTexte,
} from "../../src/vm/volume-chiffre-format.mjs";

export const NOM = "source-v3";
export const TAILLE = 8 * SECTOR_SIZE;
export const APP = { id: "railsbox-vault-reference", version: "1.0.0" };

/** Contenu déterministe du volume v2 : la chaîne entière ne doit pas en changer un octet de clair. */
export function contenuV2() {
  const octets = new Uint8Array(TAILLE);
  for (let index = 0; index < TAILLE; index += 1) octets[index] = (index * 7 + 3) & 0xff;
  return octets;
}

export function manifesteDe(formatVersion, extra = {}) {
  return createManifest({
    formatVersion,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: APP,
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    ...extra,
  });
}

export function attentes(current = MANIFEST_FORMAT_VERSION) {
  return {
    runtime: { version: "1.4.2", artifact: null },
    app: { id: APP.id },
    supportedFormat: { current, minReadable: 1 },
  };
}

/** La sauvegarde VÉRIFIÉE qu'une étape destructive exige (ADR 0011). */
export async function sauvegardeDe(octets, manifest) {
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
export function cibleReelle(store, { ouvrir = store.openHandle } = {}) {
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
export async function poserLeVolumeV2(store) {
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
export async function poserUnV3Reel(store) {
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
export function identifiantDuFichier(store, formatVersion) {
  const entete = store.snapshot(NOM).subarray(0, EN_TETE_OCTETS);
  const lu = decoderEnTeteDeVolume(entete, { formatVersion });
  assert.equal(lu.valide, true, lu.raison ?? "");
  return identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
}

/** Le voisin `.gen` tel que le support le porte. Un fichier de zéro octet EST un voisin absent. */
export function journalPresent(store) {
  return store.sizeOf(`${NOM}.gen`) > 0;
}
