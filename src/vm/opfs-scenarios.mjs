// Sonde de persistance partagée par les deux niveaux de preuve de #6.
//
// Le même code s'exécute sous Node au-dessus d'un double déterministe
// (`tests/unit/vm-opfs-scenarios.test.mjs`) et dans un Worker Chromium au-dessus du vrai OPFS
// (`tests/browser/opfs-block-backend.spec.mjs`). Les deux doivent produire la MÊME empreinte de
// volume : un écart entre eux serait un résultat, pas un détail de plomberie.
//
// La sonde OBSERVE et ne juge pas : elle rend un rapport sérialisable, franchissable par
// `postMessage`. Le verdict est calculé à part par `auditPersistenceReport`, qui reconstruit
// l'image attendue depuis sa règle. Une sonde qui s'auto-évaluerait pourrait toujours rendre
// « satisfait ».

import { buildBlockFixture, buildPattern, digestHex } from "./block-fixture.mjs";
import { SECTOR_SIZE, V86_BLOCK_SIZE } from "./block-geometry.mjs";
import { STORAGE_ERROR_CODES } from "./storage-errors.mjs";

/** Géométrie de la sonde : 512 Kio, multiple du secteur et du bloc v86. */
export const PROBE_VOLUME_BYTES = 512 * 1024;

/** Taille de la fixture écrite en tête de volume. */
export const PROBE_FIXTURE_BYTES = 64 * 1024;

/**
 * Régions écrites avant la fermeture du handle. Elles couvrent, dans l'ordre, les cas exigés par
 * les scénarios d'acceptation de #6 : une écriture longue alignée, une écriture NON alignée sur le
 * secteur, un secteur isolé, et le dernier bloc v86 du volume — c'est-à-dire la fin de fichier.
 */
export const PROBE_REGIONS = Object.freeze([
  Object.freeze({ label: "fixture", offset: 0, length: PROBE_FIXTURE_BYTES, kind: "fixture" }),
  Object.freeze({
    label: "non-alignee",
    offset: 262144 + 37,
    length: 173,
    kind: "pattern",
    seed: 3,
  }),
  Object.freeze({
    label: "secteur-isole",
    offset: 393216,
    length: SECTOR_SIZE,
    kind: "pattern",
    seed: 11,
  }),
  Object.freeze({
    label: "fin-de-volume",
    offset: PROBE_VOLUME_BYTES - V86_BLOCK_SIZE,
    length: V86_BLOCK_SIZE,
    kind: "pattern",
    seed: 23,
  }),
]);

/** Plages relues après réouverture : débuts, chevauchements de limites, dernier octet. */
export const PROBE_BOUNDARIES = Object.freeze([
  Object.freeze({ offset: 0, length: SECTOR_SIZE }),
  Object.freeze({ offset: SECTOR_SIZE - 1, length: 2 }),
  Object.freeze({ offset: PROBE_FIXTURE_BYTES - 1, length: 2 }),
  Object.freeze({ offset: V86_BLOCK_SIZE, length: V86_BLOCK_SIZE }),
  Object.freeze({ offset: PROBE_VOLUME_BYTES - SECTOR_SIZE, length: SECTOR_SIZE }),
  Object.freeze({ offset: PROBE_VOLUME_BYTES - 1, length: 1 }),
]);

/** Empreinte SHA-256 de `buildProbeImage()`, vérifiée par les tests unitaires. */
export const PROBE_VOLUME_DIGEST =
  "d6d782982a16369ad1c24dca90e854b9e5f614f2ab9c5b942bf5d7e1b2e36419";

/** Taille des lectures de relecture intégrale : assez grande pour être réaliste, assez petite
 *  pour rester une suite d'appels et non un seul `read` géant. */
const CHUNK_BYTES = 32 * 1024;

/** Reconnaît un `FileSystemSyncAccessHandle` à sa surface, sans dépendre de son constructeur. */
export function looksLikeSyncAccessHandle(value) {
  return (
    typeof value?.getSize === "function" &&
    typeof value?.read === "function" &&
    typeof value?.write === "function" &&
    typeof value?.truncate === "function"
  );
}

/**
 * Vrai si un handle du système de fichiers est ATTEIGNABLE depuis l'objet examiné — backend ou
 * adaptateur v86. Le backend range le sien dans un champ privé de classe : rien ne doit le
 * retrouver ici, et l'ADR 0002 exige que ce soit vérifié plutôt que supposé.
 */
export function exposesSyncAccessHandle(subject) {
  const reachable = [
    ...Object.getOwnPropertyNames(subject).map((key) => subject[key]),
    ...Object.values(subject),
  ];
  if (typeof subject.describe === "function") reachable.push(subject.describe());
  if (subject.journal) reachable.push(subject.journal);
  if (subject.faults) reachable.push(subject.faults);
  return reachable.some(looksLikeSyncAccessHandle);
}

async function regionBytes(region) {
  return region.kind === "fixture"
    ? buildBlockFixture(region.length)
    : buildPattern(region.length, region.seed);
}

/**
 * Image attendue du volume après la phase d'écriture : un volume de zéros où chaque région a été
 * appliquée. C'est la RÈGLE ; `PROBE_VOLUME_DIGEST` n'en est que l'empreinte publiée.
 * @returns {Promise<Uint8Array>}
 */
export async function buildProbeImage() {
  const image = new Uint8Array(PROBE_VOLUME_BYTES);
  for (const region of PROBE_REGIONS) {
    image.set(await regionBytes(region), region.offset);
  }
  return image;
}

/**
 * Première phase : ouvrir en DÉCLARANT la géométrie, appliquer chaque région dans l'ordre de
 * `PROBE_REGIONS`, franchir la barrière, puis rendre le handle.
 *
 * Séparée de la relecture pour que le `finally` qui ferme le volume ne couvre qu'une seule phase :
 * la fermeture doit avoir lieu même si une écriture échoue, et la suite de la sonde ne doit rien
 * pouvoir lire tant que ce handle vit encore.
 *
 * @returns {Promise<{ opened: object, written: object[] }>}
 */
async function ecrireRegionsPuisFermer(openVolume, name) {
  const first = await openVolume({ name, size: PROBE_VOLUME_BYTES });
  const opened = first.describe();
  const written = [];
  try {
    for (const region of PROBE_REGIONS) {
      const bytes = await regionBytes(region);
      await first.write(region.offset, bytes);
      written.push({ label: region.label, offset: region.offset, length: region.length });
    }
    await first.flush();
  } finally {
    // Le handle est rendu au support AVANT toute relecture : ce que la suite lit vient du fichier,
    // pas d'un tampon resté vivant dans le backend.
    await first.close();
  }
  return { opened, written };
}

/**
 * Relit le volume entier par lectures successives de `CHUNK_BYTES`, et rend l'image reconstituée
 * avec la suite des tailles demandées.
 *
 * La suite des tailles est relevée parce qu'elle est une PREUVE : la sonde doit montrer qu'elle a
 * traversé le backend appel après appel, et non par un unique `read` de la taille du volume.
 *
 * @returns {Promise<{ image: Uint8Array, chunks: number[] }>}
 */
async function relireVolumeEntier(volume, size) {
  const image = new Uint8Array(size);
  const chunks = [];
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, size - offset);
    const bytes = await volume.read(offset, length);
    image.set(bytes, offset);
    chunks.push(length);
  }
  return { image, chunks };
}

/**
 * Relit chaque région écrite. L'empreinte seule suffirait au verdict ; les octets de tête et de
 * queue sont relevés en plus pour qu'un écart soit LISIBLE dans le rapport sans réexécuter la sonde.
 *
 * @returns {Promise<object[]>}
 */
async function relireRegions(volume) {
  const regions = [];
  for (const region of PROBE_REGIONS) {
    const bytes = await volume.read(region.offset, region.length);
    regions.push({
      label: region.label,
      offset: region.offset,
      length: region.length,
      digest: await digestHex(bytes),
      firstBytes: [...bytes.subarray(0, 8)],
      lastBytes: [...bytes.subarray(-8)],
    });
  }
  return regions;
}

/**
 * Relit les plages de bord de `PROBE_BOUNDARIES` : débuts, chevauchements de limites, dernier
 * octet. C'est là que se logent les fautes d'arithmétique d'un backend, pas au milieu d'un bloc.
 *
 * @returns {Promise<object[]>}
 */
async function relireLimites(volume) {
  const boundaries = [];
  for (const boundary of PROBE_BOUNDARIES) {
    const bytes = await volume.read(boundary.offset, boundary.length);
    boundaries.push({ ...boundary, digest: await digestHex(bytes) });
  }
  return boundaries;
}

/**
 * Demande un octet au-delà du dernier. La seule réponse acceptable est une erreur typée : un succès
 * ici serait la faute exacte que le contrat interdit — compléter par des zéros.
 *
 * L'issue est rendue comme une DONNÉE, jamais propagée : c'est une observation de la sonde, et le
 * verdict la juge ensuite comme les autres.
 *
 * @returns {Promise<{ code: string | null, message: string }>}
 */
async function sonderLectureHorsBornes(volume) {
  try {
    await volume.read(PROBE_VOLUME_BYTES - 1, 2);
  } catch (error) {
    return { code: error.code ?? null, message: error.message };
  }
  return { code: null, message: "La lecture hors bornes a réussi." };
}

/**
 * Exécute la sonde : écrire, franchir la barrière, FERMER le handle, rouvrir sans déclarer de
 * géométrie, tout relire.
 *
 * @param {{ openVolume: (options: object) => Promise<object>, name: string,
 *           support?: string }} options
 * @returns {Promise<object>} rapport sérialisable
 */
export async function observePersistence({ openVolume, name, support = "double" }) {
  // Chaque phase ferme SON volume dans un `finally`. Une erreur inattendue en cours de sonde
  // laisserait sinon le handle exclusif ouvert, et l'exécution suivante échouerait sur
  // `VAULT_STORAGE_BUSY` — un symptôme qui masquerait la cause.
  const { opened, written } = await ecrireRegionsPuisFermer(openVolume, name);

  const second = await openVolume({ name });
  const reopened = second.describe();
  let lecture;
  let regions;
  let boundaries;
  let outOfRange;
  let handleExposed;

  try {
    lecture = await relireVolumeEntier(second, reopened.size);
    regions = await relireRegions(second);
    boundaries = await relireLimites(second);
    outOfRange = await sonderLectureHorsBornes(second);
    handleExposed = exposesSyncAccessHandle(second);
  } finally {
    await second.close();
  }

  return {
    support,
    volume: name,
    opened: { size: opened.size, durable: opened.durable, kind: opened.kind },
    written,
    reopened: { size: reopened.size, durable: reopened.durable, kind: reopened.kind },
    reopenedWithoutDeclaredSize: true,
    chunks: lecture.chunks,
    wholeDigest: await digestHex(lecture.image),
    regions,
    boundaries,
    outOfRange,
    handleExposed,
  };
}

/**
 * Écarts de GÉOMÉTRIE. Ces trois-là se lisent sur les seuls `describe()` du rapport, sans
 * reconstruire l'image attendue : les isoler évite de faire dépendre le premier écart signalé d'un
 * calcul d'empreinte qui n'a rien à voir avec lui.
 *
 * @returns {string[]} raisons, dans l'ordre où le verdict les publie
 */
function raisonsDeGeometrie(report) {
  const reasons = [];
  if (report?.opened?.size !== PROBE_VOLUME_BYTES) {
    reasons.push(
      `Géométrie à l'ouverture : ${report?.opened?.size} au lieu de ${PROBE_VOLUME_BYTES}.`,
    );
  }
  if (report?.reopened?.size !== PROBE_VOLUME_BYTES) {
    reasons.push(
      `Géométrie après réouverture : ${report?.reopened?.size} au lieu de ${PROBE_VOLUME_BYTES}.`,
    );
  }
  if (report?.reopened?.durable !== true) {
    reasons.push("Le volume rouvert ne se déclare pas durable.");
  }
  return reasons;
}

/**
 * Écarts région par région, chaque empreinte observée étant confrontée à celle de la tranche
 * correspondante de l'image attendue. Une région ABSENTE est une raison à part entière : sans elle,
 * un rapport tronqué passerait pour conforme.
 *
 * @returns {Promise<string[]>}
 */
async function raisonsDesRegions(report, expected) {
  const reasons = [];
  for (const region of PROBE_REGIONS) {
    const observed = report?.regions?.find((candidate) => candidate.label === region.label);
    if (!observed) {
      reasons.push(`Région « ${region.label} » absente du rapport.`);
      continue;
    }
    const slice = expected.subarray(region.offset, region.offset + region.length);
    const digest = await digestHex(slice);
    if (observed.digest !== digest) {
      reasons.push(`Région « ${region.label} » : ${observed.digest} au lieu de ${digest}.`);
    }
  }
  return reasons;
}

/**
 * Écarts sur les plages de bord. Une limite s'identifie par son couple (offset, longueur) et non
 * par une étiquette : deux plages peuvent partager un début et ne pas dire la même chose.
 *
 * @returns {Promise<string[]>}
 */
async function raisonsDesLimites(report, expected) {
  const reasons = [];
  for (const boundary of PROBE_BOUNDARIES) {
    const observed = report?.boundaries?.find(
      (candidate) => candidate.offset === boundary.offset && candidate.length === boundary.length,
    );
    if (!observed) {
      reasons.push(`Limite ${boundary.offset}+${boundary.length} absente du rapport.`);
      continue;
    }
    const digest = await digestHex(
      expected.subarray(boundary.offset, boundary.offset + boundary.length),
    );
    if (observed.digest !== digest) {
      reasons.push(
        `Limite ${boundary.offset}+${boundary.length} : ${observed.digest} au lieu de ${digest}.`,
      );
    }
  }
  return reasons;
}

/**
 * Écarts sur les deux promesses de CONTRAT que la sonde éprouve en fin de course : le refus typé
 * hors bornes, et le fait qu'aucun handle du système de fichiers ne soit atteignable depuis le
 * volume. Elles ne portent sur aucun octet, d'où leur place à part.
 *
 * @returns {string[]}
 */
function raisonsDuContrat(report) {
  const reasons = [];
  if (report?.outOfRange?.code !== STORAGE_ERROR_CODES.outOfRange) {
    reasons.push(
      `Lecture hors bornes : code ${report?.outOfRange?.code} au lieu de ${STORAGE_ERROR_CODES.outOfRange}.`,
    );
  }
  if (report?.handleExposed !== false) {
    reasons.push("Le backend expose un objet du système de fichiers à ses appelants.");
  }
  return reasons;
}

/**
 * Verdict de la sonde. Il reconstruit l'image attendue depuis la règle, puis compare chaque
 * observation. Chaque écart produit une raison nommée : un booléen seul n'aiderait personne.
 *
 * L'ordre d'assemblage des raisons est celui de la lecture d'un rapport — géométrie, empreinte
 * globale, régions, limites, contrat — et il fait partie de ce que les deux supports doivent rendre
 * à l'identique.
 *
 * @param {object} report sortie de `observePersistence`, éventuellement passée par `postMessage`
 * @returns {Promise<{ satisfied: boolean, reasons: string[] }>}
 */
export async function auditPersistenceReport(report) {
  const reasons = [];
  const expected = await buildProbeImage();

  reasons.push(...raisonsDeGeometrie(report));

  const expectedWhole = await digestHex(expected);
  if (report?.wholeDigest !== expectedWhole) {
    reasons.push(`Empreinte du volume relu : ${report?.wholeDigest} au lieu de ${expectedWhole}.`);
  }

  reasons.push(...(await raisonsDesRegions(report, expected)));
  reasons.push(...(await raisonsDesLimites(report, expected)));
  reasons.push(...raisonsDuContrat(report));

  return { satisfied: reasons.length === 0, reasons };
}
