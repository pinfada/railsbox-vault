// OUVERTURE d'un volume OPFS, et RÉCUPÉRATION de sa dernière génération (#6, #16, ADR 0014 ;
// #18, ADR 0016).
//
// C'est le seul chemin admis vers un `OpfsBlockBackend` : le constructeur ne garantit ni géométrie
// ni exclusivité, et l'ouverture est précisément la suite de gestes qui les établit — réserver le
// nom, saisir le handle, lire l'en-tête v3 ou le poser si le volume naît, confronter la géométrie
// déclarée à celle du fichier, importer la clé de volume, puis ouvrir le journal voisin et récupérer.
//
// La règle qui traverse tout le module : **chaque refus survenant APRÈS l'ouverture rend ce qu'il a
// pris.** Un handle non rendu laisserait le fichier verrouillé par un volume que personne ne
// détient, et le nom occupé par un backend que personne ne peut fermer.
//
// ## Deux tailles, et il ne faut jamais les confondre
//
// La taille LOGIQUE est celle que v86 voit et que le manifeste déclare. La taille SUPPORT est celle
// du fichier : l'en-tête v3, la région d'authentification, puis la charge. `size()` du backend rend
// la première ; le contrôle de géométrie confronte la seconde. Les confondre ferait croire à v86
// qu'il dispose de 6,64 % de disque en plus, c'est-à-dire de secteurs qui sont des sceaux.

import { SECTOR_SIZE, assertBlockGeometry, isBlockGeometry } from "./block-geometry.mjs";
import { BlockJournal } from "./block-journal.mjs";
import { exigerCleDeVolume } from "./cle-de-volume.mjs";
import { createFaultPlan } from "./fault-plan.mjs";
import { GenerationStore } from "./generation-store.mjs";
import { OpfsBlockBackend } from "./opfs-block-backend.mjs";
import { toStorageError } from "./opfs-error-mapping.mjs";
import { generationJournalName, openOpfsSyncAccess } from "./opfs-sync-access.mjs";
import { assertVolumeLibre, reserverVolume } from "./opfs-volume-registry.mjs";
import { Scellement } from "./scellement.mjs";
import { STORAGE_ERROR_CODES, StorageError, geometryMismatch } from "./storage-errors.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  decoderEnTeteV3,
  dispositionV3,
  encoderEnTeteV3,
  identifiantVolumeEnTexte,
  nouvelIdentifiantDeVolume,
} from "./volume-chiffre-format.mjs";

/** Ferme un handle après une ouverture ratée, sans jamais masquer l'erreur d'origine. */
function abandonHandle(handle, name, original) {
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

/** Lit le premier secteur du fichier : l'en-tête v3, ou ce qui prétend l'être. */
function lireEnTete(handle, name) {
  const octets = new Uint8Array(EN_TETE_OCTETS);
  const lus = handle.read(octets, { at: 0 });
  if (lus !== EN_TETE_OCTETS) {
    throw geometryMismatch(name, {
      observed: lus,
      expected: EN_TETE_OCTETS,
      reason: "Le fichier ne rend pas son en-tête v3 entier ; il n'est pas ouvert.",
    });
  }
  return octets;
}

/**
 * Résout la disposition d'un volume EXISTANT à partir de son en-tête.
 *
 * Un fichier non vide qui ne porte pas d'en-tête v3 est refusé, et le message le dit : c'est un
 * volume d'un format antérieur, qui se lit, s'exporte et se migre — mais qui ne s'ouvre pas ici,
 * faute de région d'authentification où loger le sceau d'un secteur.
 */
function dispositionExistante({ name, handle, declared, observed }) {
  const lu = decoderEnTeteV3(lireEnTete(handle, name));
  if (!lu.valide) {
    throw geometryMismatch(name, {
      observed,
      expected: null,
      reason: `${lu.raison} Un volume antérieur au format v${FORMAT_VOLUME_V3} se lit, s'exporte et se migre, mais ne s'ouvre pas ici : il n'a pas de région d'authentification.`,
    });
  }
  const disposition = dispositionV3(lu.enTete.tailleLogique);
  if (observed !== disposition.tailleSupport) {
    throw geometryMismatch(name, {
      observed,
      expected: disposition.tailleSupport,
      reason: "Le fichier ne fait pas la taille que son propre en-tête impose.",
    });
  }
  if (declared !== undefined && declared !== disposition.tailleLogique) {
    throw geometryMismatch(name, {
      observed: disposition.tailleLogique,
      expected: declared,
      reason: "Un volume existant n'est jamais retaillé en silence ; exporter puis migrer.",
    });
  }
  return { disposition, identifiantVolume: identifiantVolumeEnTexte(lu.enTete.identifiantVolume) };
}

/** Résout la disposition d'un volume qui NAÎT. Sa taille logique est celle qu'on déclare. */
function dispositionNeuve({ name, declared, identifiantVolume }) {
  if (declared === undefined) {
    throw geometryMismatch(name, {
      observed: 0,
      expected: null,
      reason: "Volume absent ou vide et aucune géométrie déclarée : rien à ouvrir.",
    });
  }
  if (!isBlockGeometry(declared)) {
    throw geometryMismatch(name, {
      observed: 0,
      expected: declared,
      reason: `La taille déclarée n'est pas un multiple de ${SECTOR_SIZE} octets.`,
    });
  }
  return {
    disposition: dispositionV3(declared),
    identifiantVolume: identifiantVolume ?? nouvelIdentifiantDeVolume(),
  };
}

/** Alloue le fichier à sa taille support et y pose l'en-tête v3. Le scellement vient après. */
function poserEnTete(handle, name, disposition, identifiantVolume) {
  handle.truncate(disposition.tailleSupport);
  const entete = encoderEnTeteV3({
    tailleLogique: disposition.tailleLogique,
    identifiantVolume,
  });
  const ecrits = handle.write(entete, { at: 0 });
  if (ecrits !== EN_TETE_OCTETS) {
    throw geometryMismatch(name, {
      observed: ecrits,
      expected: EN_TETE_OCTETS,
      reason: "L'en-tête v3 n'a pas été écrit entièrement ; le volume n'est pas créé.",
    });
  }
  handle.flush();
}

/**
 * SAISIT le support : handle exclusif, en-tête v3 lu ou posé, géométrie confrontée. L'ouvreur peut
 * être le vrai OPFS, qui rend déjà des erreurs typées, ou un double qui rend des `DOMException`
 * brutes : les deux passent par la même traduction. Chaque refus survenant APRÈS l'ouverture rend le
 * handle, sans quoi le fichier resterait verrouillé par un volume que personne ne détient.
 */
async function saisirSupport({ name, size, identifiantVolume, openHandle }) {
  let handle;
  try {
    handle = await openHandle(name);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open", volume: name });
  }

  let observed;
  try {
    observed = handle.getSize();
  } catch (cause) {
    throw abandonHandle(handle, name, toStorageError(cause, { operation: "size", volume: name }));
  }

  const naissance = observed === 0;
  let resolue;
  try {
    resolue = naissance
      ? dispositionNeuve({ name, declared: size, identifiantVolume })
      : dispositionExistante({ name, handle, declared: size, observed });
  } catch (error) {
    throw abandonHandle(handle, name, error);
  }

  if (naissance) {
    try {
      poserEnTete(handle, name, resolue.disposition, resolue.identifiantVolume);
    } catch (cause) {
      throw abandonHandle(
        handle,
        name,
        toStorageError(cause, { operation: "allocate", volume: name }),
      );
    }
  }

  return { handle, ...resolue, naissance };
}

/**
 * Installe le magasin de générations sur un backend déjà construit, ou REFERME ce backend : un
 * refus de génération ne doit pas laisser le nom occupé par un volume que personne ne détient.
 */
async function installerGenerationOuFermer(
  backend,
  { name, size, scellement, openHandle, seuilPointDeControle },
) {
  try {
    backend.installerGeneration(
      await ouvrirGeneration({ name, size, backend, scellement, openHandle, seuilPointDeControle }),
    );
  } catch (cause) {
    await backend.close().catch(() => {});
    throw cause;
  }
}

/**
 * Ouvre le journal de génération voisin et RÉCUPÈRE. C'est ici que se joue la promesse de #16 : au
 * retour, le volume porte la dernière génération VALIDÉE, et rien d'autre.
 */
async function ouvrirGeneration({
  name,
  size,
  backend,
  scellement,
  openHandle,
  seuilPointDeControle,
}) {
  const nomJournal = generationJournalName(name);
  let handle;
  try {
    handle = await openHandle(nomJournal);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open-generation", volume: name });
  }
  try {
    return await ouvrirMagasin({ name, size, backend, scellement, handle, seuilPointDeControle });
  } catch (cause) {
    try {
      handle.close();
    } catch {
      // La fermeture de secours ne doit jamais masquer la raison du refus.
    }
    throw cause;
  }
}

async function ouvrirMagasin({ name, size, backend, scellement, handle, seuilPointDeControle }) {
  try {
    return await GenerationStore.ouvrir({
      volume: name,
      handle,
      tailleVolume: size,
      scellement,
      lireVolume: (offset, longueur) => backend.lireSupportBrut(offset, longueur),
      ecrireVolume: (offset, octets, generation) =>
        backend.ecrireSupportBrut(offset, octets, generation),
      barriereVolume: () => backend.barriereSupportBrute(),
      seuilPointDeControle,
    });
  } catch (cause) {
    // Un échec du SUPPORT pendant la récupération — quota, handle perdu — reste un état contractuel
    // nommé. Les refus propres au journal (`VAULT_STORAGE_GENERATION_*`) et au format chiffré
    // (`VAULT_STORAGE_SCEAU_REFUSE`) traversent tels quels.
    throw toStorageError(cause, { operation: "recover-generation", volume: name });
  }
}

/**
 * Ouvre un volume OPFS en exclusivité.
 *
 * @param {{ name?: string, size?: number, cle?: Uint8Array, identifiantVolume?: string,
 *           journal?: BlockJournal, faults?: import("./fault-plan.mjs").FaultPlan,
 *           flushDelay?: number,
 *           openHandle?: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 *   `size` est la taille LOGIQUE, facultative : à la réouverture, elle est RELUE de l'en-tête v3 au
 *   lieu d'être supposée. Fournie, elle doit correspondre exactement.
 *   `cle` est la clé de volume, OBLIGATOIRE : le format v3 est chiffré, et un volume sans clé est
 *   refusé par `VAULT_STORAGE_CLE_REQUISE` avant toute lecture. Aucun chemin du produit n'en
 *   fabrique une avant #21 ; les bancs la reçoivent du harnais sous jeton (`cle-de-volume.mjs`).
 *   `identifiantVolume` est l'identifiant que le MANIFESTE déclare. À la création il est inscrit
 *   dans l'en-tête ; à la réouverture il est confronté à celui du fichier.
 *   `openHandle` est le point d'injection du support : le vrai OPFS en production, un double
 *   déterministe dans les tests unitaires.
 * @returns {Promise<OpfsBlockBackend>}
 */
export async function openOpfsVolume({
  name = "vault",
  size,
  cle,
  identifiantVolume,
  journal = new BlockJournal(),
  faults = createFaultPlan(),
  flushDelay = 0,
  openHandle = openOpfsSyncAccess,
  transactionnel = true,
  seuilPointDeControle,
} = {}) {
  assertVolumeLibre(name);
  if (size !== undefined) assertBlockGeometry(size);
  // Le refus tombe AVANT que le fichier ne soit ouvert : un volume qu'on ne saura pas lire ne doit
  // pas voir son handle pris, ni sa géométrie allouée.
  exigerCleDeVolume(name, cle);

  const saisi = await saisirSupport({ name, size, identifiantVolume, openHandle });
  const scellement = await Scellement.ouvrir({
    volume: saisi.identifiantVolume,
    cleOctets: cle,
    formatVersion: FORMAT_VOLUME_V3,
  });

  const backend = new OpfsBlockBackend({
    name,
    handle: saisi.handle,
    size: saisi.disposition.tailleLogique,
    disposition: saisi.disposition,
    scellement,
    journal,
    faults,
    flushDelay,
  });

  // « Un secteur jamais écrit n'existe pas en v3 » (ADR 0015) : un volume qui naît est scellé
  // ENTIER, y compris ses secteurs de zéros. Sans cela, il suffirait de zéroter la région
  // d'authentification pour faire lire un secteur comme blanc.
  if (saisi.naissance) {
    try {
      await backend.chiffre.scellerTout(0);
      await backend.barriereSupportBrute();
    } catch (cause) {
      await backend.close().catch(() => {});
      throw toStorageError(cause, { operation: "seal-volume", volume: name });
    }
  }

  if (transactionnel) {
    await installerGenerationOuFermer(backend, {
      name,
      size: saisi.disposition.tailleLogique,
      scellement,
      openHandle,
      seuilPointDeControle,
    });
  }

  reserverVolume(name, backend);
  return backend;
}
