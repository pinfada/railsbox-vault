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
import { FAULT_KINDS, createFaultPlan } from "./fault-plan.mjs";
import { TEMOIN_OCTETS } from "./generation-fraicheur.mjs";
import { GenerationStore } from "./generation-store.mjs";
import { OpfsBlockBackend } from "./opfs-block-backend.mjs";
import {
  decodeSupportCount,
  readCountFailure,
  toStorageError,
  writeCountFailure,
} from "./opfs-error-mapping.mjs";
import {
  generationJournalName,
  openOpfsSyncAccess,
  temoinSequenceName,
} from "./opfs-sync-access.mjs";
import { assertVolumeLibre, reserverVolume } from "./opfs-volume-registry.mjs";
import { Scellement } from "./scellement.mjs";
import { STORAGE_ERROR_CODES, StorageError, geometryMismatch } from "./storage-errors.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  MARQUEUR_SCELLEMENT_COMPLET,
  SCELLEMENT_COMPLET_OFFSET,
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
 * Un fichier non vide qui ne porte pas d'en-tête v3 est refusé, et le message dit ce qui est vrai :
 * son MANIFESTE se lit encore — c'est ce que `MIN_READABLE_FORMAT_VERSION` couvre —, mais le
 * FICHIER ne s'ouvre pas ici, faute de région d'authentification où loger le sceau d'un secteur.
 * Le message a longtemps promis trois remèdes de plus — « se lit, s'exporte et se migre » —, dont
 * aucun n'existait : l'export passe par cet ouvreur, qui refuse, et la migration vers v3 est
 * l'objet de #101.
 */
function dispositionExistante({ name, handle, declared, observed, identifiantVolume }) {
  const lu = decoderEnTeteV3(lireEnTete(handle, name));
  if (!lu.valide) {
    throw geometryMismatch(name, {
      observed,
      expected: null,
      reason: `${lu.raison} Le manifeste d'un volume antérieur au format v${FORMAT_VOLUME_V3} se lit encore, mais son fichier ne s'ouvre pas ici — il n'a pas de région d'authentification — et il n'a pas de chemin vers v${FORMAT_VOLUME_V3} avant #101.`,
    });
  }
  if (!lu.enTete.scellementComplet) throw creationInachevee(name, observed);
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
  const surLeDisque = identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
  // Deux sources qui divergent ne se départagent pas, elles se refusent. L'en-tête n'est pas
  // authentifié — c'est un localisateur —, et l'identité qui entrera dans les données associées est
  // celle que le MANIFESTE déclare. Confronter les deux ici sert au diagnostic : « ce fichier n'est
  // pas le volume que le manifeste décrit » se corrige autrement qu'un sceau refusé.
  if (identifiantVolume !== undefined && identifiantVolume !== surLeDisque) {
    throw new StorageError(
      STORAGE_ERROR_CODES.identiteVolume,
      `Volume « ${name} » refusé : son en-tête v3 porte l'identifiant ${surLeDisque}, le manifeste en déclare un autre. Aucun octet n'est lu.`,
      { volume: name, surLeDisque, declare: identifiantVolume },
    );
  }
  return { disposition, identifiantVolume: surLeDisque };
}

/**
 * Refus d'un volume dont la CRÉATION n'a pas abouti.
 *
 * Le remède nommé est le seul qui soit vrai. « Restaurer une sauvegarde » — ce que le refus de
 * sceau proposait — envoie chercher la sauvegarde d'un volume qui n'a jamais servi.
 *
 * **Pourquoi ce volume n'est PAS re-scellé automatiquement**, alors que ce serait sans perte : la
 * marque vit dans l'en-tête, qui n'est pas authentifié. Un re-scellement automatique donnerait à
 * quiconque peut effacer huit octets du fichier le moyen de faire écraser tout le volume par des
 * zéros scellés — c'est-à-dire de le détruire par un geste que rien ne distingue d'une réparation.
 * Le refus, lui, ne laisse à cet adversaire qu'un déni de service qu'il avait déjà.
 */
function creationInachevee(name, observed) {
  return new StorageError(
    STORAGE_ERROR_CODES.volumeIncomplet,
    `Volume « ${name} » refusé : sa création n'est pas allée jusqu'au bout — l'en-tête est posé, mais le scellement initial ne s'est jamais achevé. Ce fichier n'a jamais porté de données : le remède est de le supprimer et de le recréer, pas de restaurer une sauvegarde. Aucun octet n'est lu.`,
    { volume: name, observed },
  );
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
  // Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite (#73) : un support qui rend
  // `FILE_ERROR_NO_SPACE` casté en non signé n'a pas écrit un en-tête trop court, il n'a rien
  // écrit — et « manque de place » n'appelle pas le même remède que « géométrie incohérente ».
  const echec = writeCountFailure(handle.write(entete, { at: 0 }), {
    requested: EN_TETE_OCTETS,
    volume: name,
    offset: 0,
    operation: "write-header",
  });
  if (echec !== null) throw echec;
  handle.flush();
}

/**
 * Pose l'en-tête d'un volume qui naît, et REND le handle si la pose échoue.
 *
 * C'est le premier geste qui ÉCRIT, et il vient délibérément après le contrôle de la clé : un
 * volume qu'on ne saura pas sceller ne doit pas laisser derrière lui un fichier alloué à sa taille
 * support et porteur d'un en-tête.
 */
function poserEnTeteOuRendre(handle, name, disposition, identifiantVolume) {
  try {
    poserEnTete(handle, name, disposition, identifiantVolume);
  } catch (cause) {
    throw abandonHandle(
      handle,
      name,
      toStorageError(cause, { operation: "allocate", volume: name }),
    );
  }
}

/**
 * Pose la marque de SCELLEMENT COMPLET, et la matérialise.
 *
 * Huit octets écrits dans la réserve de l'en-tête déjà allouée, puis une barrière. Ce geste est le
 * DERNIER de la création, et c'est tout son intérêt : tant qu'il n'a pas eu lieu, le fichier se
 * relit comme une création inachevée. Une coupure entre le scellement et cette marque refuse un
 * volume pourtant complet — un faux refus, sans perte, contre un faux succès qui coûtait le volume.
 */
function marquerScellementComplet(handle, name) {
  const echec = writeCountFailure(
    handle.write(MARQUEUR_SCELLEMENT_COMPLET, { at: SCELLEMENT_COMPLET_OFFSET }),
    {
      requested: MARQUEUR_SCELLEMENT_COMPLET.byteLength,
      volume: name,
      offset: SCELLEMENT_COMPLET_OFFSET,
      operation: "write-seal-mark",
    },
  );
  if (echec !== null) throw echec;
  handle.flush();
}

/**
 * SAISIT le support : handle exclusif, en-tête v3 LU, géométrie confrontée. L'ouvreur peut être le
 * vrai OPFS, qui rend déjà des erreurs typées, ou un double qui rend des `DOMException` brutes : les
 * deux passent par la même traduction. Chaque refus survenant APRÈS l'ouverture rend le handle, sans
 * quoi le fichier resterait verrouillé par un volume que personne ne détient.
 *
 * Elle n'écrit RIEN, pas même l'en-tête d'un volume qui naît : la pose est faite par l'appelant,
 * après le contrôle de la clé. Voir `poserEnTeteOuRendre`.
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
      : dispositionExistante({ name, handle, declared: size, observed, identifiantVolume });
  } catch (error) {
    throw abandonHandle(handle, name, error);
  }

  return { handle, ...resolue, naissance };
}

/**
 * Installe le magasin de générations sur un backend déjà construit, ou REFERME ce backend : un
 * refus de génération ne doit pas laisser le nom occupé par un volume que personne ne détient.
 */
async function installerGenerationOuFermer(
  backend,
  { name, size, scellement, openHandle, seuilPointDeControle, fautesFraicheur },
) {
  try {
    backend.installerGeneration(
      await ouvrirGeneration({
        name,
        size,
        backend,
        scellement,
        openHandle,
        seuilPointDeControle,
        fautesFraicheur,
      }),
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
  fautesFraicheur,
}) {
  const handle = await saisirVoisin(openHandle, generationJournalName(name), {
    operation: "open-generation",
    volume: name,
  });
  let temoin;
  try {
    temoin = await saisirVoisin(openHandle, temoinSequenceName(name), {
      operation: "open-temoin",
      volume: name,
    });
  } catch (cause) {
    rendreSansMasquer(handle);
    throw cause;
  }
  try {
    return await ouvrirMagasin({
      name,
      size,
      backend,
      scellement,
      handle,
      seuilPointDeControle,
      fraicheur: sourceDeFraicheur({ name, backend, temoin, fautes: fautesFraicheur }),
    });
  } catch (cause) {
    rendreSansMasquer(handle);
    rendreSansMasquer(temoin);
    throw cause;
  }
}

/** Saisit un voisin de volume, en traduisant l'échec du support en état contractuel. */
async function saisirVoisin(openHandle, nom, contexte) {
  try {
    return await openHandle(nom);
  } catch (cause) {
    throw toStorageError(cause, contexte);
  }
}

/** Rend un handle sans jamais masquer la raison du refus qui a conduit ici. */
function rendreSansMasquer(handle) {
  try {
    handle.close();
  } catch {
    // Une fermeture de secours qui échoue ne doit pas remplacer la cause d'origine.
  }
}

/**
 * SOURCE de fraîcheur du magasin (#19, ADR 0019) : la région d'authentification et le témoin.
 *
 * Le handle du témoin est saisi UNE FOIS et tenu pour la session, comme celui du journal. Le rouvrir
 * à chaque racine coûterait une ouverture OPFS par barrière du guest — un prix payé sur le chemin
 * même que `SEC-DURABLE-001` rend critique.
 */
function sourceDeFraicheur({ name, backend, temoin, fautes }) {
  const nom = temoinSequenceName(name);
  return {
    regionOffset: backend.disposition.regionOffset,
    regionOctets: backend.disposition.regionOctets,
    lireRegion: async (offset, longueur) => {
      const courte = fauteDeFraicheur(fautes, "read", { volume: nom, offset, longueur });
      const octets = await backend.lireRegionAuth(offset, longueur);
      // Une lecture COURTE programmée est rendue telle quelle : c'est `empreinteDeRegion` qui doit
      // la refuser, et l'éprouver ici vérifie sa garde plutôt que de la contourner.
      return courte === null ? octets : octets.subarray(0, Math.min(courte, octets.byteLength));
    },
    lireTemoin: async () => lireTemoinDuSupport(temoin, nom),
    ecrireTemoin: async (octets) => {
      fauteDeFraicheur(fautes, "write", { volume: nom, offset: 0, longueur: octets.byteLength });
      return ecrireTemoinSurLeSupport(temoin, nom, octets);
    },
    fermer: () => temoin.close(),
  };
}

/**
 * Consomme le plan de fautes des VOISINS DE FRAÎCHEUR, et traduit ce qu'il programme.
 *
 * Rend le nombre d'octets d'une lecture COURTE — que l'appelant applique lui-même —, ou lève l'état
 * contractuel que la faute décrit. Aucun genre de faute n'est ignoré en silence : une faute
 * programmée qui ne ferait rien rendrait une mesure creuse.
 */
function fauteDeFraicheur(fautes, operation, { volume, offset, longueur }) {
  const faute = fautes.consume(operation);
  if (faute === null) return null;
  if (faute.kind === FAULT_KINDS.shortRead) return faute.bytes ?? Math.floor(longueur / 2);
  if (faute.kind === FAULT_KINDS.partialWrite) {
    throw writeCountFailure(faute.bytes ?? 0, {
      requested: longueur,
      volume,
      offset,
      operation: "write-temoin",
    });
  }
  throw new StorageError(
    STORAGE_ERROR_CODES.handleLost,
    `Le voisin de fraîcheur « ${volume} » a disparu sous la session : faute programmée ${faute.kind}.`,
    { volume, offset, operation, kind: faute.kind },
  );
}

/**
 * Lit le témoin, ou rend `null` s'il n'y en a pas encore. Un fichier VIDE est un témoin absent —
 * c'est ce que `createSyncAccessHandle` laisse d'un voisin qui vient d'être créé pour être lu.
 *
 * Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite (#73) : un support qui rend un
 * code d'échec casté en non signé n'a pas fait une lecture courte, il n'a rien lu — et rendre alors
 * un tampon de zéros ferait passer un témoin illisible pour un témoin absent, c'est-à-dire
 * désarmerait le contrôle au moment précis où le support se dérobe.
 */
function lireTemoinDuSupport(handle, nom) {
  if (handle.getSize() === 0) return null;
  const octets = new Uint8Array(TEMOIN_OCTETS);
  const lus = handle.read(octets, { at: 0 });
  if (decodeSupportCount(lus, TEMOIN_OCTETS).kind === "errno") {
    throw readCountFailure(lus, {
      requested: TEMOIN_OCTETS,
      volume: nom,
      offset: 0,
      operation: "read-temoin",
    });
  }
  return lus === TEMOIN_OCTETS ? octets : octets.subarray(0, lus);
}

/** Remplace le témoin et franchit SA barrière : un témoin non durable ne date rien. */
function ecrireTemoinSurLeSupport(handle, nom, octets) {
  handle.truncate(0);
  const echec = writeCountFailure(handle.write(octets, { at: 0 }), {
    requested: octets.byteLength,
    volume: nom,
    offset: 0,
    operation: "write-temoin",
  });
  if (echec !== null) throw echec;
  handle.flush();
}

async function ouvrirMagasin({
  name,
  size,
  backend,
  scellement,
  handle,
  seuilPointDeControle,
  fraicheur,
}) {
  try {
    return await GenerationStore.ouvrir({
      volume: name,
      handle,
      tailleVolume: size,
      scellement,
      fraicheur,
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
 * Scelle ENTIÈREMENT un volume qui vient de naître, secteurs de zéros compris.
 *
 * « Un secteur jamais écrit n'existe pas en v3 » (ADR 0015) : si la région d'authentification était
 * à zéro pour un secteur vierge, il suffirait de la zéroter pour faire lire un secteur comme blanc.
 * Le coût est un scellement par secteur, mesuré dans `docs/quality-attributes.md`, et il se paie une
 * fois — à la création.
 */
async function scellerLeVolumeNeuf(backend, name, handle) {
  try {
    await backend.chiffre.scellerTout(0);
    await backend.barriereSupportBrute();
    // La marque vient APRÈS la barrière : elle atteste que les sceaux sont sur le support, et une
    // marque posée avant attesterait d'un état qui n'est peut-être jamais arrivé jusqu'au disque.
    marquerScellementComplet(handle, name);
  } catch (cause) {
    await backend.close().catch(() => {});
    throw toStorageError(cause, { operation: "seal-volume", volume: name });
  }
}

/**
 * Saisit le support, EXIGE la clé, puis alloue si le volume naît. L'ordre est le sujet.
 *
 * L'en-tête est lu avant que la clé ne soit exigée, et c'est un diagnostic : un fichier d'un format
 * antérieur n'a pas besoin d'une clé pour qu'on sache qu'il ne s'ouvre pas ici, et lui répondre
 * « aucune clé de volume n'a été remise » désignait un remède qui n'était pas le sien.
 *
 * Rien n'est ÉCRIT tant que la clé n'est pas là : un volume qu'on ne saura pas sceller ne doit pas
 * laisser derrière lui un fichier alloué et porteur d'un en-tête. Rien n'est rendu de la charge non
 * plus — seul l'en-tête est lu, et il est un localisateur.
 */
async function saisirLireEtAllouer({ name, size, cle, identifiantVolume, openHandle }) {
  const saisi = await saisirSupport({ name, size, identifiantVolume, openHandle });
  try {
    exigerCleDeVolume(name, cle);
  } catch (refus) {
    throw abandonHandle(saisi.handle, name, refus);
  }
  if (saisi.naissance) {
    poserEnTeteOuRendre(saisi.handle, name, saisi.disposition, saisi.identifiantVolume);
  }
  return saisi;
}

/** Assemble le backend : taille LOGIQUE d'un côté, disposition du support de l'autre. */
function construireBackend({ name, saisi, scellement, journal, faults, flushDelay }) {
  return new OpfsBlockBackend({
    name,
    handle: saisi.handle,
    size: saisi.disposition.tailleLogique,
    disposition: saisi.disposition,
    scellement,
    journal,
    faults,
    flushDelay,
  });
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
 *   `fautesFraicheur` vise les VOISINS de fraîcheur (#19) — la région d'authentification et le
 *   témoin — et il est SÉPARÉ de `faults`, qui vise les gestes du guest : mêler les deux décalerait
 *   les occurrences de la matrice de coupures de #15.
 * @returns {Promise<OpfsBlockBackend>}
 */
export async function openOpfsVolume({
  name = "vault",
  size,
  cle,
  identifiantVolume,
  journal = new BlockJournal(),
  faults = createFaultPlan(),
  fautesFraicheur = createFaultPlan(),
  flushDelay = 0,
  openHandle = openOpfsSyncAccess,
  transactionnel = true,
  seuilPointDeControle,
} = {}) {
  assertVolumeLibre(name);
  if (size !== undefined) assertBlockGeometry(size);

  const saisi = await saisirLireEtAllouer({ name, size, cle, identifiantVolume, openHandle });
  const scellement = await Scellement.ouvrir({
    volume: saisi.identifiantVolume,
    cleOctets: cle,
    formatVersion: FORMAT_VOLUME_V3,
  });
  const backend = construireBackend({ name, saisi, scellement, journal, faults, flushDelay });
  if (saisi.naissance) await scellerLeVolumeNeuf(backend, name, saisi.handle);

  if (transactionnel) {
    await installerGenerationOuFermer(backend, {
      name,
      size: saisi.disposition.tailleLogique,
      scellement,
      openHandle,
      seuilPointDeControle,
      fautesFraicheur,
    });
  }

  reserverVolume(name, backend);
  return backend;
}
