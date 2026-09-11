// Les VOISINS d'un volume qu'une ouverture doit saisir : le JOURNAL DE GÉNÉRATION `<volume>.gen` et
// le TÉMOIN DE SÉQUENCE `<volume>.temoin` (#16, ADR 0014 ; #19, ADR 0019).
//
// Extrait de `opfs-volume-ouverture.mjs` par #181, qui a fait franchir à ce fichier le plafond de
// 800 lignes. La coupure passe où le sens la met : d'un côté ce qui établit la GÉOMÉTRIE et
// l'EXCLUSIVITÉ du fichier de volume, de l'autre ce qui ouvre ses deux voisins et branche le magasin
// de générations dessus. Les deux gestes se lisent séparément, et l'un ne suppose rien de l'autre.
//
// La règle qui traverse ce module est celle de son parent : **chaque refus survenant APRÈS
// l'ouverture rend ce qu'il a pris.** Un handle non rendu laisserait un voisin verrouillé par un
// volume que personne ne détient.

import { FAULT_KINDS } from "./fault-plan.mjs";
import { TEMOIN_OCTETS } from "./generation-fraicheur.mjs";
import { GenerationStore } from "./generation-store.mjs";
import {
  decodeSupportCount,
  readCountFailure,
  toStorageError,
  writeCountFailure,
} from "./opfs-error-mapping.mjs";
import { generationJournalName, temoinSequenceName } from "./opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/**
 * Installe le magasin de générations sur un backend déjà construit, ou REFERME ce backend : un
 * refus de génération ne doit pas laisser le nom occupé par un volume que personne ne détient.
 */
export async function installerGenerationOuFermer(
  backend,
  { name, size, scellement, openHandle, seuilPointDeControle, fautesFraicheur, sansRacine },
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
        sansRacine,
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
export async function ouvrirGeneration({
  name,
  size,
  backend,
  scellement,
  openHandle,
  seuilPointDeControle,
  fautesFraicheur,
  sansRacine,
  confronterLaFraicheur = true,
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
      sansRacine,
      confronterLaFraicheur,
      fraicheur: sourceDeFraicheur({ name, backend, temoin, fautes: fautesFraicheur }),
    });
  } catch (cause) {
    rendreSansMasquer(handle);
    rendreSansMasquer(temoin);
    throw cause;
  }
}

/** Saisit un voisin de volume, en traduisant l'échec du support en état contractuel. */
export async function saisirVoisin(openHandle, nom, contexte) {
  try {
    return await openHandle(nom);
  } catch (cause) {
    throw toStorageError(cause, contexte);
  }
}

/** Rend un handle sans jamais masquer la raison du refus qui a conduit ici. */
export function rendreSansMasquer(handle) {
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

export async function ouvrirMagasin({
  name,
  size,
  backend,
  scellement,
  handle,
  seuilPointDeControle,
  sansRacine,
  fraicheur,
  confronterLaFraicheur = true,
}) {
  try {
    return await GenerationStore.ouvrir({
      volume: name,
      handle,
      tailleVolume: size,
      scellement,
      fraicheur,
      sansRacine,
      confronterLaFraicheur,
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
