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

  const second = await openVolume({ name });
  const reopened = second.describe();
  const chunks = [];
  const regions = [];
  const boundaries = [];
  let image;
  let outOfRange;
  let handleExposed;

  try {
    image = new Uint8Array(reopened.size);
    for (let offset = 0; offset < reopened.size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, reopened.size - offset);
      const bytes = await second.read(offset, length);
      image.set(bytes, offset);
      chunks.push(length);
    }

    for (const region of PROBE_REGIONS) {
      const bytes = await second.read(region.offset, region.length);
      regions.push({
        label: region.label,
        offset: region.offset,
        length: region.length,
        digest: await digestHex(bytes),
        firstBytes: [...bytes.subarray(0, 8)],
        lastBytes: [...bytes.subarray(-8)],
      });
    }

    for (const boundary of PROBE_BOUNDARIES) {
      const bytes = await second.read(boundary.offset, boundary.length);
      boundaries.push({ ...boundary, digest: await digestHex(bytes) });
    }

    // Un octet au-delà du dernier : la seule réponse acceptable est une erreur typée. Un succès ici
    // serait la faute exacte que le contrat interdit — compléter par des zéros.
    outOfRange = { code: null, message: "La lecture hors bornes a réussi." };
    try {
      await second.read(PROBE_VOLUME_BYTES - 1, 2);
    } catch (error) {
      outOfRange = { code: error.code ?? null, message: error.message };
    }

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
    chunks,
    wholeDigest: await digestHex(image),
    regions,
    boundaries,
    outOfRange,
    handleExposed,
  };
}

/**
 * Verdict de la sonde. Il reconstruit l'image attendue depuis la règle, puis compare chaque
 * observation. Chaque écart produit une raison nommée : un booléen seul n'aiderait personne.
 *
 * @param {object} report sortie de `observePersistence`, éventuellement passée par `postMessage`
 * @returns {Promise<{ satisfied: boolean, reasons: string[] }>}
 */
export async function auditPersistenceReport(report) {
  const reasons = [];
  const expected = await buildProbeImage();

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

  const expectedWhole = await digestHex(expected);
  if (report?.wholeDigest !== expectedWhole) {
    reasons.push(`Empreinte du volume relu : ${report?.wholeDigest} au lieu de ${expectedWhole}.`);
  }

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

  if (report?.outOfRange?.code !== STORAGE_ERROR_CODES.outOfRange) {
    reasons.push(
      `Lecture hors bornes : code ${report?.outOfRange?.code} au lieu de ${STORAGE_ERROR_CODES.outOfRange}.`,
    );
  }
  if (report?.handleExposed !== false) {
    reasons.push("Le backend expose un objet du système de fichiers à ses appelants.");
  }

  return { satisfied: reasons.length === 0, reasons };
}
