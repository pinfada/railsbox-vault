// ACCÈS BRUT au fichier d'un volume OPFS (#101, ADR 0016, décision 7).
//
// L'export d'une archive et la restauration inter-origine manipulent un FICHIER, pas un volume
// logique : l'un le lit octet pour octet, l'autre le recopie octet pour octet, et **ni l'un ni
// l'autre n'a besoin de la clé**. Les faire passer par le backend chiffré leur ferait faire
// exactement l'inverse de ce qu'on attend — déchiffrer à l'export, rechiffrer à la restauration —,
// c'est-à-dire produire une archive en clair d'un volume chiffré. La tranche (a) de #18 refusait les
// deux gestes faute d'avoir cette porte ; la voici.
//
// ## Ce que ce module N'EST PAS
//
// Ce n'est pas un contournement du chiffrement, et il ne peut pas le devenir : les octets qu'il rend
// SONT ceux du support, donc ceux qui sont chiffrés. Il ne sait ni ouvrir un secteur, ni vérifier un
// sceau, ni lire un en-tête v3 — il n'importe même pas le format. Un appelant qui voudrait du clair
// n'obtiendrait rien de lui.
//
// Ce n'est pas non plus un second ouvreur de volume. Il partage le REGISTRE de `openOpfsVolume` :
// un export et un boot ne peuvent pas détenir le même volume, et le refus est le même
// `VAULT_STORAGE_BUSY`. Sans ce partage, les deux chemins se croiseraient sans se voir.
//
// ## Ce qu'il garde du contrat de #6
//
// L'exclusivité, la géométrie qui ne se retaille jamais en silence, et l'interprétation des comptes
// rendus par le support (#73) : `4294967288` n'est pas « plus d'octets qu'on n'en demandait », c'est
// un `FILE_ERROR_NO_SPACE` casté en non signé, et le confondre avec une écriture courte rendrait les
// deux remèdes inutiles.

import { readCountFailure, toStorageError, writeCountFailure } from "./opfs-error-mapping.mjs";
import { openOpfsSyncAccess } from "./opfs-sync-access.mjs";
import { assertVolumeLibre, libererVolume, reserverVolume } from "./opfs-volume-registry.mjs";
import { STORAGE_ERROR_CODES, StorageError, geometryMismatch } from "./storage-errors.mjs";

/** Ferme un handle après une ouverture ratée, sans jamais masquer l'erreur d'origine. */
function abandonner(handle, name, original) {
  try {
    handle.close();
  } catch (cause) {
    return new StorageError(
      STORAGE_ERROR_CODES.supportFailure,
      `${original.message} La fermeture de secours du volume « ${name} » a elle aussi échoué : ${cause?.name ?? cause}.`,
      { volume: name, initial: original.code, cause: cause?.name ?? "Error" },
    );
  }
  return original;
}

/**
 * Résout la taille du fichier : allouée si le volume naît, imposée par le fichier sinon.
 *
 * Un volume existant n'est JAMAIS retaillé, même si l'appelant déclare autre chose — ce serait
 * détruire une géométrie que #6 tient pour immuable, et le faire en silence par-dessus le marché.
 */
function resoudreTaille({ name, declaree, observee }) {
  if (observee === 0) {
    if (declaree === undefined) {
      throw geometryMismatch(name, {
        observed: 0,
        expected: null,
        reason: "Volume absent ou vide et aucune taille déclarée : rien à ouvrir.",
      });
    }
    return { taille: declaree, allouer: true };
  }
  if (declaree !== undefined && declaree !== observee) {
    throw geometryMismatch(name, {
      observed: observee,
      expected: declaree,
      reason: "Un volume existant n'est jamais retaillé en silence ; exporter puis migrer.",
    });
  }
  return { taille: observee, allouer: false };
}

/**
 * Ouvre le fichier d'un volume en accès BRUT et exclusif.
 *
 * @param {{ name: string, size?: number,
 *           openHandle?: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 *   `size` est la taille du FICHIER — pas la taille logique du volume, dont ce module ne sait rien.
 *   Facultative à la réouverture : elle est alors relue du support au lieu d'être supposée.
 * @returns {Promise<{ name: string, size: () => number,
 *                     read: (offset: number, length: number) => Promise<Uint8Array>,
 *                     write: (offset: number, bytes: Uint8Array) => Promise<void>,
 *                     flush: () => Promise<void>, close: () => Promise<void> }>}
 */
export async function ouvrirVolumeBrut({ name, size, openHandle = openOpfsSyncAccess }) {
  assertVolumeLibre(name);

  let handle;
  try {
    handle = await openHandle(name);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open", volume: name });
  }

  let resolue;
  try {
    resolue = resoudreTaille({ name, declaree: size, observee: handle.getSize() });
    if (resolue.allouer) handle.truncate(resolue.taille);
  } catch (cause) {
    throw abandonner(
      handle,
      name,
      cause instanceof StorageError
        ? cause
        : toStorageError(cause, { operation: "allocate", volume: name }),
    );
  }

  const acces = creerAccesBrut({ name, handle, taille: resolue.taille });
  reserverVolume(name, acces);
  return acces;
}

/**
 * Le contrat rendu à l'appelant. Il a la FORME d'un backend de blocs — `size`, `read`, `write`,
 * `flush`, `close` — pour que l'orchestration d'export et de restauration n'ait pas à distinguer les
 * deux, mais il n'en a ni la géométrie logique, ni les fautes programmées, ni les générations.
 */
function creerAccesBrut({ name, handle, taille: tailleInitiale }) {
  let taille = tailleInitiale;
  let ferme = false;

  const exigerUtilisable = () => {
    if (!ferme) return;
    throw new StorageError(
      STORAGE_ERROR_CODES.closed,
      `Volume « ${name} » fermé : plus aucune E/S n'est acceptée.`,
      { volume: name },
    );
  };

  const bornes = (offset, longueur) => {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(longueur) || longueur < 0) {
      throw new RangeError(`Plage invalide : offset=${offset} length=${longueur}.`);
    }
    if (offset + longueur > taille) {
      throw new StorageError(
        STORAGE_ERROR_CODES.outOfRange,
        `Accès hors bornes : ${longueur} octet(s) à l'offset ${offset} d'un fichier de ${taille} octets.`,
        { volume: name, offset, length: longueur, size: taille },
      );
    }
  };

  return {
    name,
    /** Taille du FICHIER. Elle ne suit jamais le support : elle le contrôle. */
    size: () => taille,

    async read(offset, longueur) {
      exigerUtilisable();
      bornes(offset, longueur);
      const cible = new Uint8Array(longueur);
      let obtenus;
      try {
        obtenus = handle.read(cible, { at: offset });
      } catch (cause) {
        throw toStorageError(cause, { operation: "read", volume: name, offset });
      }
      const echec = readCountFailure(obtenus, { requested: longueur, volume: name, offset });
      if (echec !== null) throw echec;
      return cible;
    },

    async write(offset, octets) {
      exigerUtilisable();
      if (!(octets instanceof Uint8Array))
        throw new TypeError("Une écriture attend un Uint8Array.");
      bornes(offset, octets.byteLength);
      let acceptes;
      try {
        acceptes = handle.write(octets, { at: offset });
      } catch (cause) {
        throw toStorageError(cause, { operation: "write", volume: name, offset });
      }
      const echec = writeCountFailure(acceptes, {
        requested: octets.byteLength,
        volume: name,
        offset,
      });
      if (echec !== null) throw echec;
    },

    async flush() {
      exigerUtilisable();
      try {
        await handle.flush();
      } catch (cause) {
        throw toStorageError(cause, { operation: "flush", volume: name });
      }
    },

    /**
     * RETAILLE le fichier. C'est le seul geste de ce module qui change une géométrie, et il n'existe
     * que pour un appelant : la conversion v2 → v3, qui doit agrandir le fichier de sa région
     * d'authentification (ADR 0016, décision 8).
     *
     * Il est ici et non dans le backend de blocs, et la distinction porte : un backend tient une
     * géométrie IMMUABLE, parce que v86 raisonne dessus et qu'un volume qui rétrécit sous la VM
     * n'est pas un volume plus petit, c'est un volume corrompu (#6). Une migration, elle, est le
     * seul moment où la géométrie du FICHIER change légitimement — sous le manifeste révoqué, donc
     * sur un volume que plus rien ne présente comme valide.
     */
    async retailler(nouvelleTaille) {
      exigerUtilisable();
      try {
        handle.truncate(nouvelleTaille);
      } catch (cause) {
        throw toStorageError(cause, { operation: "allocate", volume: name });
      }
      taille = nouvelleTaille;
    },

    /**
     * Rend le handle au support ET libère le nom. La propriété est relâchée D'ABORD, pour qu'un
     * support récalcitrant ne bloque pas définitivement le nom ; l'échec de la fermeture remonte
     * quand même.
     */
    async close() {
      if (ferme) return;
      ferme = true;
      libererVolume(name);
      try {
        handle.close();
      } catch (cause) {
        throw toStorageError(cause, { operation: "close", volume: name });
      }
    },
  };
}
