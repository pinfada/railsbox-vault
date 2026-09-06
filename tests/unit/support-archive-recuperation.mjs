/**
 * BANC PARTAGÉ des épreuves d'archive v2 (#149, ADR 0027).
 *
 * Il pose ce que les deux suites ont en commun et rien d'autre : un magasin de fichiers en mémoire,
 * un volume v3 réel scellé sous une clé de volume connue, son enveloppe, un moyen de récupération
 * de type 4, et la CIBLE de restauration branchée sur le même magasin.
 *
 * La cible est le VRAI module `opfs-import-target.mjs`, avec ses primitives injectées sur le
 * magasin. Un double écrit à la main aurait laissé hors mesure l'endroit exact où la tranche écrit
 * le voisin `.cles` — c'est-à-dire ce qu'elle livre.
 */

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { creerEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { createOpfsImportTarget } from "../../src/vm/opfs-import-target.mjs";
import { ouvrirVolumeBrut } from "../../src/vm/opfs-volume-brut.mjs";
import { manifestSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { supportEnveloppeOpfs } from "../../src/vm/ouverture-par-enveloppe.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import { identifiantDeVolume, suiteDOctets } from "./support-enveloppe-double.mjs";

/** Huit secteurs : assez pour un volume v3 complet, assez peu pour tenir dans une épreuve. */
export const TAILLE = 8 * SECTOR_SIZE;

/** Identifiants de volume des bancs. Publics, sans portée, distincts l'un de l'autre. */
export const VOLUME_A = identifiantDeVolume(0x0a);
export const VOLUME_B = identifiantDeVolume(0xb0);

/** Clé de déverrouillage du harnais : publique, sans entropie. */
export const KEK = suiteDOctets(0x80, 32);

/** Clé de volume (la DEK) des bancs. Publique elle aussi : rien ici n'est un secret. */
export const DEK = suiteDOctets(0x20, 32);

export const ATTENTES = {
  app: { id: "railsbox-vault-reference" },
  runtime: { version: "0.1.0" },
};

/** Manifeste voisin d'un volume v3 des bancs, sérialisé. */
export function manifesteDuVolume(identifiantVolume = VOLUME_A) {
  return serializeManifest(descripteurDeManifeste(identifiantVolume));
}

/** Le même manifeste, sous sa forme d'objet — ce que l'export attend. */
export function descripteurDeManifeste(identifiantVolume = VOLUME_A) {
  return createManifest({
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app: { id: "railsbox-vault-reference", version: "1.0.0" },
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    volume: { id: identifiantVolume, algorithm: "aes-256-gcm" },
  });
}

/**
 * Magasin de fichiers avec ses primitives de voisinage.
 *
 * `removeSidecar` RETAILLE à zéro plutôt que de supprimer : le double de #6 ne connaît pas la
 * suppression, et un fichier de taille nulle est exactement ce que `statOpfsVolume` rapporte comme
 * absent (`present: size > 0`). La distinction n'existe pas ici, et l'y inventer ferait diverger le
 * banc du support réel dans l'autre sens.
 */
export function magasin() {
  const store = createSyncAccessStore();
  const stat = async (nom) => ({ present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) });
  const ecrire = async (nom, octets) => {
    const handle = await store.openHandle(nom);
    try {
      handle.truncate(0);
      handle.write(octets, { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
  };
  const lire = (nom) => (store.sizeOf(nom) > 0 ? store.snapshot(nom) : null);
  const readFile = async (nom, taille) => store.snapshot(nom).subarray(0, taille);
  const retirer = async (nom) => {
    const present = store.sizeOf(nom) > 0;
    store.resize(nom, 0);
    return present;
  };
  return { store, stat, ecrire, lire, readFile, retirer };
}

/** Le support d'enveloppe d'un volume de ce magasin. */
export function supportDe(banc, nom) {
  return supportEnveloppeOpfs(nom, { openHandle: banc.store.openHandle, stat: banc.stat });
}

/**
 * POSE un volume v3 complet avec son manifeste, son enveloppe et — au choix — un moyen de
 * récupération de type 4. Rend le code une seule fois, comme le produit le fait.
 *
 * @param {{ store: object }} banc
 * @param {{ nom?: string, identifiantVolume?: string, avecRecuperation?: boolean }} options
 */
export async function poserVolume(
  banc,
  { nom = "coffre", identifiantVolume = VOLUME_A, avecRecuperation = true } = {},
) {
  const backend = await openOpfsVolume({
    name: nom,
    size: TAILLE,
    cle: DEK,
    identifiantVolume,
    openHandle: banc.store.openHandle,
    transactionnel: false,
  });
  await backend.close();
  await banc.ecrire(manifestSidecarName(nom), manifesteDuVolume(identifiantVolume));

  const support = supportDe(banc, nom);
  await creerEnveloppe({ support, identifiantVolume, dek: DEK, kek: KEK });
  let code = null;
  if (avecRecuperation) {
    const moyen = await creerMoyenDeRecuperation({ support, identifiantVolume, kek: KEK });
    code = moyen.rendre();
  }
  return { nom, identifiantVolume, support, code };
}

/** La SOURCE d'export : le fichier du volume, lu par tranches, comme l'accès brut le rend. */
export function sourceDuVolume(banc, nom) {
  const octets = banc.store.snapshot(nom);
  return {
    size: octets.byteLength,
    read: async (offset, longueur) => octets.slice(offset, offset + longueur),
  };
}

/** La SOURCE de restauration : une archive tenue en mémoire. */
export function sourceDArchive(octets) {
  return {
    byteLength: octets.byteLength,
    read: async (offset, longueur) => octets.slice(offset, offset + longueur),
  };
}

/**
 * La CIBLE de restauration : le module de production, branché sur le magasin.
 *
 * Le journal des gestes est tenu ici plutôt que dans la cible : l'ORDRE des écritures est ce que
 * l'ADR 0027 décide, et il doit être observable sans lire l'implémentation.
 */
export function cibleDe(banc, nom) {
  const gestes = [];
  const cible = createOpfsImportTarget(nom, {
    stat: banc.stat,
    readManifest: async (volume) => banc.lire(manifestSidecarName(volume)),
    revoke: async (volume) => {
      gestes.push("revoque-manifeste");
      await banc.retirer(manifestSidecarName(volume));
    },
    writeManifest: async (fichier, octets) => {
      gestes.push(`ecrit:${fichier.slice(nom.length) || "volume"}`);
      await banc.ecrire(fichier, octets);
    },
    removeSidecar: banc.retirer,
    openVolume: ({ name, size }) =>
      ouvrirVolumeBrut({ name, size, openHandle: banc.store.openHandle }),
  });
  return { cible, gestes };
}
