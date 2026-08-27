// Phases du Worker de référence qui FABRIQUENT ou OBSERVENT un volume OPFS (#7, #9, #12, #13).
//
// Elles ne bootent rien : elles créent le disque applicatif dans OPFS, créent le témoin négatif,
// retirent un volume et ses voisins, révoquent un manifeste, constatent ce que l'origine porte, et
// relisent un volume pour en donner l'empreinte. Ce sont les gestes dont les phases de boot et
// d'archive supposent le résultat.
//
// Une règle les traverse toutes : **un volume naît ANONYME.** Son manifeste n'est inscrit qu'une
// fois le disque écrit et flushé, si bien qu'un volume à moitié préparé reste non identifié — donc
// non ouvrable en écriture. C'est la même règle qu'à la restauration, appliquée à la création.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { cleDuBanc } from "./cle-du-banc.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import {
  migrationJournalName,
  removeOpfsVolume,
  statOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { revokeVolumeManifest, writeVolumeManifest } from "/src/vm/opfs-volume-open.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";
import { manifestSidecarName } from "/src/vm/volume-import.mjs";
import { VOLUME_ALGORITHM } from "/src/vm/volume-manifest.mjs";
import { attentesDe, manifesteDuDescripteur } from "./reference-worker-boot.mjs";
import { EXPORT_BLOCK_BYTES } from "./reference-worker-mesures.mjs";

/**
 * Verse une réponse HTTP dans le backend, morceau par morceau, et franchit une barrière à la fin.
 * Aucun morceau n'est conservé : c'est ce qui borne la surmémoire de la préparation, quelle que
 * soit la taille du disque. Rend le nombre d'octets RÉELLEMENT écrits, que l'appelant confronte à
 * la taille annoncée — un flux tronqué ne doit pas produire un volume qui se croit complet.
 *
 * La fermeture du backend n'est PAS faite ici : elle appartient au `finally` de l'appelant, qui
 * doit fermer même quand le flux échoue.
 */
async function verserFluxDansVolume(backend, url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || response.body === null) {
    throw new Error(`Disque applicatif ${url} indisponible (${response.status}).`);
  }
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.byteLength === 0) continue;
    await backend.write(offset, value);
    offset += value.byteLength;
  }
  await backend.flush();
  return offset;
}

/**
 * Ouvre le volume NEUF, y verse le disque, et rend ce que la suite doit savoir : les octets écrits
 * et l'IDENTIFIANT du volume.
 *
 * L'identifiant est relevé ici parce qu'il naît avec le volume — `openOpfsVolume` le tire et
 * l'inscrit dans l'en-tête v3 (ADR 0016) —, et c'est ce même identifiant que le manifeste devra
 * déclarer. Le réinventer plus loin décrirait un autre volume que celui qui vient d'être écrit.
 *
 * L'ouverture est SANS génération transactionnelle (#16, ADR 0014), pour la même raison qu'à la
 * restauration : écrire un disque de plusieurs centaines de mébioctets d'un seul tenant n'est pas
 * une génération du guest, et la création porte déjà son atomicité — le manifeste n'est inscrit
 * qu'après le disque écrit et flushé.
 */
async function verserLeDisque({ volume, appDiskBytes, appDiskUrl, journal }) {
  const backend = await openOpfsVolume({
    name: volume,
    size: appDiskBytes,
    journal,
    cle: cleDuBanc(),
    transactionnel: false,
  });
  const identifiantVolume = backend.identifiantVolume;
  try {
    return { offset: await verserFluxDansVolume(backend, appDiskUrl), identifiantVolume };
  } finally {
    await backend.close();
  }
}

/**
 * Écrit le disque applicatif de l'image #5 dans un volume OPFS neuf, en flux : aucun tampon de
 * 512 Mio n'est jamais tenu en mémoire. C'est le point technique dur de #7 — faire pointer le
 * disque `hdb` de v86 vers OPFS en écriture — traité côté données : le disque naît dans OPFS.
 */
export async function phasePrepare({ volume, appDiskBytes, appDiskUrl, manifest }) {
  const identites = attentesDe(manifest);
  await removeOpfsVolume(volume);
  // Le volume naît anonyme : son manifeste ne sera inscrit qu'une fois le disque écrit et flushé.
  // Un volume à moitié préparé est donc, lui aussi, non identifié — la même règle qu'à la
  // restauration, appliquée à la création.
  await revokeVolumeManifest(volume);
  const journal = new BlockJournal();
  const { offset, identifiantVolume } = await verserLeDisque({
    volume,
    appDiskBytes,
    appDiskUrl,
    journal,
  });
  if (offset !== appDiskBytes) {
    throw new Error(`Disque applicatif tronqué : ${offset} octets écrits sur ${appDiskBytes}.`);
  }
  // Dernier geste : le volume devient identifié, donc ouvrable en écriture. Le format inscrit est
  // celui que le descripteur demande — un scénario de migration prépare délibérément un volume au
  // format ANTÉRIEUR, sans quoi il n'aurait rien à migrer.
  const inscrit = manifesteDuDescripteur(manifest, appDiskBytes, {
    id: identifiantVolume,
    algorithm: VOLUME_ALGORITHM,
  });
  await writeVolumeManifest(volume, inscrit);
  return {
    phase: "prepare",
    volume,
    bytesWritten: offset,
    formatVersion: inscrit.formatVersion,
    counts: journal.counts(),
    identified: identites,
  };
}

/**
 * Témoin négatif : un volume OPFS NEUF et vide (que des zéros). Un boot dessus ne peut pas monter
 * `/dev/sdb` ni servir l'invariant — ce qui prouve que la reprise dépend du CONTENU d'OPFS, et non
 * du réseau ou de l'artefact resservi.
 */
export async function phasePrepareEmpty({ volume, appDiskBytes, manifest }) {
  attentesDe(manifest);
  await removeOpfsVolume(volume);
  // Même règle qu'à la préparation : le volume naît ANONYME. Sans cette révocation, un manifeste
  // hérité d'une exécution précédente identifierait le volume vide pendant toute sa fabrication.
  await revokeVolumeManifest(volume);
  const backend = await openOpfsVolume({
    name: volume,
    size: appDiskBytes,
    journal: new BlockJournal(),
    cle: cleDuBanc(),
  });
  const identifiantVolume = backend.identifiantVolume;
  await backend.flush();
  await backend.close();
  // Le témoin est IDENTIFIÉ comme n'importe quel volume, mais VIDE. Sans manifeste, il serait
  // refusé pour non-identification (#12) et ne dirait plus rien du CONTENU d'OPFS — qui est
  // précisément ce qu'il doit prouver.
  await writeVolumeManifest(
    volume,
    manifesteDuDescripteur(manifest, appDiskBytes, {
      id: identifiantVolume,
      algorithm: VOLUME_ALGORITHM,
    }),
  );
  return { phase: "prepare-empty", volume, appDiskBytes };
}

/** Retire un volume OPFS ET tous ses voisins : rend le profil réellement « neuf ». */
export async function phaseCleanup({ volume }) {
  const retire = await removeOpfsVolume(volume);
  const manifesteRetire = await revokeVolumeManifest(volume);
  const journalRetire = await removeOpfsVolume(migrationJournalName(volume));
  return {
    phase: "cleanup",
    volume,
    removed: retire,
    manifestRemoved: manifesteRetire,
    migrationJournalRemoved: journalRetire,
  };
}

/**
 * Retire le SEUL manifeste voisin, en laissant le volume intact. C'est l'état exact que laisse une
 * restauration interrompue : le test s'en sert pour vérifier que le boot suivant est bien refusé.
 */
export async function phaseRevokeManifest({ volume }) {
  const revoked = await revokeVolumeManifest(volume);
  return { phase: "revoke-manifest", volume, revoked };
}

/**
 * OBSERVE un volume et son manifeste voisin, sans rien créer ni ouvrir en exclusivité. C'est ce qui
 * permet au test de prouver l'ISOLATION D'ORIGINE — l'OPFS de l'origine de restauration ignore tout
 * du volume de l'origine d'export — et, après un refus, qu'aucun octet n'a été écrit.
 */
export async function phaseInspectVolume({ volume }) {
  const etat = await statOpfsVolume(volume);
  const manifeste = await statOpfsVolume(manifestSidecarName(volume));
  // Le journal de migration (#13) est observé au même titre : sa présence signale une migration
  // inachevée, et c'est ce que le scénario d'interruption doit pouvoir constater.
  const journalMigration = await statOpfsVolume(migrationJournalName(volume));
  return {
    phase: "inspect-volume",
    volume,
    present: etat.present,
    size: etat.size,
    manifestPresent: manifeste.present && manifeste.size > 0,
    manifestSize: manifeste.size,
    migrationJournalPresent: journalMigration.present && journalMigration.size > 0,
    migrationJournalSize: journalMigration.size,
  };
}

/**
 * Empreinte SHA-256 du CONTENU d'un volume OPFS, relue en flux depuis le support. Elle ne sert pas
 * la restauration elle-même : elle donne au test un moyen INDÉPENDANT de comparer octet pour octet
 * le volume de l'origine d'export et celui de l'origine de restauration.
 */
export async function phaseDigestVolume({ volume, blockBytes = EXPORT_BLOCK_BYTES }) {
  const backend = await openOpfsVolume({
    name: volume,
    journal: new BlockJournal(),
    cle: cleDuBanc(),
  });
  const hash = createSha256Stream();
  let maxLecture = 0;
  try {
    const taille = backend.size();
    for (let offset = 0; offset < taille; offset += blockBytes) {
      const length = Math.min(blockBytes, taille - offset);
      maxLecture = Math.max(maxLecture, length);
      hash.update(await backend.read(offset, length));
    }
    return {
      phase: "digest-volume",
      volume,
      size: taille,
      digest: hash.digestHex(),
      maxBlockBytes: maxLecture,
    };
  } finally {
    await backend.close();
  }
}
