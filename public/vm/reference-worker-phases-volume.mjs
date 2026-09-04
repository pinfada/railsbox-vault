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
  generationJournalName,
  migrationJournalName,
  removeOpfsVolume,
  statOpfsVolume,
  instantaneSidecarName,
  temoinSequenceName,
} from "/src/vm/opfs-sync-access.mjs";
import { revokeVolumeManifest, writeVolumeManifest } from "/src/vm/opfs-volume-open.mjs";
import { STORAGE_ERROR_CODES } from "/src/vm/storage-errors.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";
import { manifestSidecarName } from "/src/vm/volume-import.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  MIN_VOLUME_FORMAT_VERSION,
  VOLUME_ALGORITHM,
} from "/src/vm/volume-manifest.mjs";
import { ouvrirVolumeBrut } from "/src/vm/opfs-volume-brut.mjs";
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
async function verserLeDisque({ volume, appDiskBytes, appDiskUrl, journal, formatVersion }) {
  // Un volume au format ANTÉRIEUR est un fichier BRUT : ni en-tête, ni région d'authentification, ni
  // secteur scellé. Le fabriquer par l'ouvreur chiffré produirait un fichier v3 sous un manifeste
  // v2 — un volume qui mentirait sur lui-même, et que la migration lirait de travers. C'est ce que
  // le scénario de migration doit trouver : un vrai v2.
  if (formatVersion < MIN_VOLUME_FORMAT_VERSION) {
    const brut = await ouvrirVolumeBrut({ name: volume, size: appDiskBytes });
    const depart = performance.now();
    try {
      const offset = await verserFluxDansVolume(brut, appDiskUrl);
      return { offset, identifiantVolume: undefined, scellementMs: 0, versementMs: duree(depart) };
    } finally {
      await brut.close();
    }
  }

  // Le SCELLEMENT INITIAL est chronométré à part : « un secteur jamais écrit n'existe pas en v3 »
  // (ADR 0015), donc l'ouverture d'un volume neuf scelle TOUS ses secteurs, et ce coût est celui du
  // format — pas celui du versement. Les confondre publierait un chiffre qui ne dirait ni l'un ni
  // l'autre.
  const avantOuverture = performance.now();
  const backend = await openOpfsVolume({
    name: volume,
    size: appDiskBytes,
    journal,
    cle: cleDuBanc(),
    transactionnel: false,
  });
  const scellementMs = duree(avantOuverture);
  const identifiantVolume = backend.identifiantVolume;
  const avantVersement = performance.now();
  try {
    return {
      offset: await verserFluxDansVolume(backend, appDiskUrl),
      identifiantVolume,
      scellementMs,
      versementMs: duree(avantVersement),
    };
  } finally {
    await backend.close();
  }
}

/** Durée écoulée depuis `depart`, au dixième de milliseconde. */
function duree(depart) {
  return Number((performance.now() - depart).toFixed(1));
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
  const formatVersion = Number.isInteger(manifest.formatVersion)
    ? manifest.formatVersion
    : MANIFEST_FORMAT_VERSION;
  const verse = await verserLeDisque({
    volume,
    appDiskBytes,
    appDiskUrl,
    journal,
    formatVersion,
  });
  const { offset, identifiantVolume } = verse;
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
    // Les DEUX durées, publiées séparément : le scellement initial est le coût du FORMAT, le
    // versement celui du disque. `docs/quality-attributes.md` les reprend telles quelles.
    sealMs: verse.scellementMs,
    fillMs: verse.versementMs,
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
  // Le journal de GÉNÉRATION (#16) et le TÉMOIN de séquence (#19) sont observés eux aussi. Ils ne
  // servent pas au diagnostic d'une migration : ils servent à ce qu'une épreuve puisse CONSTATER
  // qu'une restauration les a bien emportés. Sans cette observation, « la restauration écarte le
  // témoin » resterait une phrase, et un scénario passerait aussi bien avec le correctif que sans.
  const journalGeneration = await statOpfsVolume(generationJournalName(volume));
  const temoin = await statOpfsVolume(temoinSequenceName(volume));
  // Et l'INSTANTANÉ (#65, ADR 0024) : sans cette observation, « l'ouverture écarte et RETIRE un
  // instantané périmé » resterait une phrase, et un scénario passerait aussi bien avec le retrait
  // que sans.
  const instantane = await statOpfsVolume(instantaneSidecarName(volume));
  return {
    phase: "inspect-volume",
    volume,
    present: etat.present,
    size: etat.size,
    manifestPresent: manifeste.present && manifeste.size > 0,
    manifestSize: manifeste.size,
    migrationJournalPresent: journalMigration.present && journalMigration.size > 0,
    migrationJournalSize: journalMigration.size,
    generationJournalPresent: journalGeneration.present && journalGeneration.size > 0,
    generationJournalSize: journalGeneration.size,
    temoinPresent: temoin.present && temoin.size > 0,
    temoinSize: temoin.size,
    instantanePresent: instantane.present && instantane.size > 0,
    instantaneSize: instantane.size,
  };
}

/**
 * Empreinte SHA-256 d'un volume OPFS, relue en flux depuis le support.
 *
 * Elle rend DEUX empreintes, et la distinction est le cœur de la décision 7 de l'ADR 0016 :
 *
 *  - `digest` porte sur le FICHIER, octets tels qu'ils sont sur le support. C'est ce qu'une archive
 *    contient, et c'est donc ce qui doit correspondre à `content.digest` — pour un volume v3, du
 *    chiffré. Elle ne demande aucune clé ;
 *  - `digestClair` porte sur le CLAIR obtenu par la lecture autorisée. Elle exige la clé, et elle
 *    dit quelque chose que la première ne dit plus : deux volumes portant le même contenu ont des
 *    fichiers DIFFÉRENTS — les nonces sont tirés — mais le même clair.
 *
 * Publier les deux évite le piège que ce banc a failli tendre : comparer une archive à l'empreinte
 * du clair, c'est-à-dire comparer deux choses qui n'ont plus de raison d'être égales.
 */
export async function phaseDigestVolume({ volume, blockBytes = EXPORT_BLOCK_BYTES }) {
  const brut = await ouvrirVolumeBrut({ name: volume });
  let maxLecture = 0;
  let taille;
  let digest;
  try {
    taille = brut.size();
    const hash = createSha256Stream();
    for (let offset = 0; offset < taille; offset += blockBytes) {
      const length = Math.min(blockBytes, taille - offset);
      maxLecture = Math.max(maxLecture, length);
      hash.update(await brut.read(offset, length));
    }
    digest = hash.digestHex();
  } finally {
    await brut.close();
  }

  return {
    phase: "digest-volume",
    volume,
    size: taille,
    digest,
    digestClair: await empreinteDuClair(volume, blockBytes),
    maxBlockBytes: maxLecture,
  };
}

/**
 * Empreinte du CLAIR, par la lecture autorisée. Rend `null` si le volume n'est pas un v3 lisible —
 * un volume d'un format antérieur n'a pas de clair distinct de son fichier, et le dire par `null`
 * vaut mieux que de recopier l'autre empreinte sous un second nom.
 */
async function empreinteDuClair(volume, blockBytes) {
  let backend;
  try {
    backend = await openOpfsVolume({ name: volume, journal: new BlockJournal(), cle: cleDuBanc() });
  } catch (cause) {
    // Un volume d'un format ANTÉRIEUR n'a pas de clair distinct de son fichier : `null` le dit, et
    // c'est le seul refus qu'on avale. Tout le reste — racine abîmée, sceau rejeté, support en
    // panne — est un DIAGNOSTIC, et l'avaler coûtait cher : la revue de #110 a relevé qu'un
    // scénario de bout en bout rougissait sur « reçu null » sans jamais dire
    // `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`, c'est-à-dire sans dire ce qui n'allait pas.
    if (cause?.code === STORAGE_ERROR_CODES.geometryMismatch) return null;
    throw cause;
  }
  try {
    const hash = createSha256Stream();
    const taille = backend.size();
    for (let offset = 0; offset < taille; offset += blockBytes) {
      hash.update(await backend.read(offset, Math.min(blockBytes, taille - offset)));
    }
    return hash.digestHex();
  } finally {
    await backend.close();
  }
}
