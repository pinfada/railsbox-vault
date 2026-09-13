/**
 * BANC PARTAGÉ des épreuves de portabilité de la coquille (#207, ADR 0039).
 *
 * Il pose, sur un magasin en mémoire et avec les modules RÉELS, un coffre tel que le Worker de
 * confiance le laisse : le disque `application` installé par `installerSiNecessaire`, l'enveloppe
 * sur `coquille.cles` sous `IDENTIFIANT_DU_COFFRE`, un moyen de récupération dont le code est rendu
 * une fois. Il fournit aussi les PRIMITIVES que `public/portabilite-du-worker.mjs` attend, branchées
 * sur ce magasin : c'est le même code de production qui écrit et relit, sans OPFS.
 */

import { installerSiNecessaire } from "../../src/coquille/application-de-reference.mjs";
import { IDENTIFIANT_DU_COFFRE } from "../../src/coquille/identites-du-coffre.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { creerEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { manifestSidecarName, voisinsDunVolume } from "../../src/vm/opfs-sync-access.mjs";
import { createOpfsArchiveSink } from "../../src/vm/opfs-archive-sink.mjs";
import { EN_TETE_OCTETS } from "../../src/vm/volume-chiffre-format.mjs";
import { serializeManifest } from "../../src/vm/volume-manifest.mjs";
import { DEK, KEK, cibleDe, magasin, supportDe } from "./support-archive-recuperation.mjs";

export { DEK, KEK, magasin, supportDe };

/** Huit secteurs de disque : assez pour un volume v4 complet, assez peu pour une épreuve. */
export const OCTETS_DU_DISQUE = 8 * SECTOR_SIZE;

/** Le motif que « Rails » a écrit : c'est lui que la restauration doit relire. */
export const MOTIF_DE_RAILS = 0x5b;

export function descripteurDEpreuve() {
  return {
    descripteurVersion: 1,
    application: { id: "railsbox-vault-reference", version: "1.0.0" },
    runtime: { version: "0.1.0" },
    disque: { nom: "app.ext2", octets: OCTETS_DU_DISQUE },
    boot: {
      cmdline: "root=/dev/sda rw",
      memoireOctets: 33554432,
      kernel: "k",
      initrd: "i",
      rootfs: "r",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    prefixeDesArtefacts: "/artifacts/epreuve/",
  };
}

/** INSTALLE le disque par la fonction de production, qui choisit seule l'identité du volume. */
export async function installerLeDisque(banc, motif = MOTIF_DE_RAILS) {
  const { store } = banc;
  await installerSiNecessaire({
    descripteur: descripteurDEpreuve(),
    cleDeVolume: async () => DEK.slice(),
    observer: banc.stat,
    ouvrir: (options) => openOpfsVolume({ ...options, openHandle: store.openHandle }),
    verser: async (backend) => {
      for (let rang = 0; rang < OCTETS_DU_DISQUE / SECTOR_SIZE; rang += 1) {
        await backend.write(rang * SECTOR_SIZE, new Uint8Array(SECTOR_SIZE).fill(motif));
      }
      await backend.flush();
      return { ecrits: OCTETS_DU_DISQUE, empreinte: await backend.empreinteDuFichier() };
    },
    dater: (options) => daterLaCreation({ ...options, openHandle: store.openHandle }),
    revoquer: async () => {},
    inscrire: (nom, manifeste) =>
      banc.ecrire(manifestSidecarName(nom), serializeManifest(manifeste)),
    lireLeManifeste: async (nom) => banc.lire(manifestSidecarName(nom)),
  });
}

/** Pose l'enveloppe du coffre et, au choix, un moyen de récupération. Rend le code une fois. */
export async function poserLEnveloppe(banc, { avecRecuperation = true } = {}) {
  const support = supportDe(banc, "coquille");
  await creerEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, dek: DEK, kek: KEK });
  if (!avecRecuperation) return { support, code: null };
  const moyen = await creerMoyenDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  return { support, code: moyen.rendre() };
}

/** Crée le petit volume `coquille` sous l'identité donnée, comme un déverrouillage le ferait. */
export async function poserLeVolumeCoquille(banc, identifiantVolume) {
  const backend = await openOpfsVolume({
    name: "coquille",
    size: 32 * SECTOR_SIZE,
    cle: DEK,
    identifiantVolume,
    openHandle: banc.store.openHandle,
    transactionnel: false,
  });
  await backend.close();
}

/** Les PRIMITIVES de `portabilite-du-worker.mjs`, sur ce magasin. */
export function primitivesDe(banc, { ouvrirLeDisque }) {
  const { store } = banc;
  const retirerUn = async (nom) => banc.retirer(nom);
  return {
    observer: banc.stat,
    lireEnTete: async (nom) =>
      store.sizeOf(nom) > 0 ? store.snapshot(nom).subarray(0, EN_TETE_OCTETS) : null,
    lireVoisin: async (nom) => banc.lire(nom),
    async retirer(nom) {
      await retirerUn(nom);
      for (const voisin of voisinsDunVolume(nom)) await retirerUn(voisin);
    },
    ecrireVoisin: (nom, octets) => banc.ecrire(nom, octets),
    ouvrirLeDisque: (options) => ouvrirLeDisque({ ...options, openHandle: store.openHandle }),
    async ouvrirLePuits(nom) {
      const handle = await store.openHandle(nom);
      handle.truncate(0);
      return { handle, puits: createOpfsArchiveSink(handle, { volume: nom }) };
    },
    fichier: async (nom) => new File([store.snapshot(nom)], nom),
    cibleDImport: (nom) => cibleDe(banc, nom).cible,
    budget: () => null,
    lireLeDescripteur: async () => ({ present: true, descripteur: descripteurDEpreuve() }),
  };
}
