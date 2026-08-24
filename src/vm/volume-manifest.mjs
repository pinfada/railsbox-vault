// Manifeste versionné d'un volume (#10, `VAULT-PORT-001`, `VAULT-COMPAT-001`).
//
// Le manifeste est le DOCUMENT qui lie les trois identités indépendantes de `docs/release-policy.md`
// — la version entière du FORMAT de volume, la version SemVer du RUNTIME, l'identité immuable et la
// version de l'APPLICATION — à la géométrie immuable du volume (#6). C'est un contrat de format
// persistant : sa structure v1 est figée par l'ADR 0007, et le format ne dépend jamais implicitement
// de la version npm.
//
// Ce module est PUR et déterministe : il ne lit ni OPFS, ni le temps, ni le réseau. La sérialisation
// est canonique (clés triées) pour qu'un même manifeste rende toujours les mêmes octets — condition
// d'une empreinte reproductible. Le calcul de l'empreinte du CONTENU du volume et l'export complet
// sont réservés à #11 ; la restauration inter-origine à #12 ; le détail des migrations à #13. Ici :
// la STRUCTURE, sa sérialisation, et la vérification de version/identité AVANT toute écriture.

import { SECTOR_SIZE, V86_BLOCK_SIZE, assertBlockGeometry } from "./block-geometry.mjs";
import { MANIFEST_ERROR_CODES, ManifestError } from "./manifest-errors.mjs";

/** Marqueur figé : distingue un manifeste Vault d'un objet JSON quelconque. Jamais modifié. */
export const MANIFEST_MAGIC = "railsbox-vault/volume-manifest";

/** Version du format de volume que ce runtime écrit. Un entier, jamais dérivé de la version npm. */
export const MANIFEST_FORMAT_VERSION = 1;

/**
 * Plage de formats que ce runtime prend en charge par défaut. `current` est le format qu'il écrit ;
 * `minReadable` le plus ancien qu'il sait encore lire. Un appelant fournit la sienne à mesure que la
 * matrice de `docs/release-policy.md` grandit ; tant qu'il n'existe qu'un format, les deux valent 1.
 */
export const DEFAULT_SUPPORTED_FORMAT = Object.freeze({
  current: MANIFEST_FORMAT_VERSION,
  minReadable: MANIFEST_FORMAT_VERSION,
});

/** SemVer minimal (major.minor.patch, pré-version et métadonnées tolérées mais ignorées). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Rend `{ major, minor, patch }` ou `null` si la chaîne n'est pas un SemVer valide. */
function parseSemVer(version) {
  if (typeof version !== "string") return null;
  const m = SEMVER.exec(version);
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Gèle en profondeur : un manifeste est immuable comme tout le reste du dépôt. */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Sérialisation canonique : clés triées récursivement, donc octets stables pour une même valeur. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Construit et gèle un manifeste v1 à partir de champs bruts. Une entrée invalide au moment de la
 * CRÉATION est une faute de programmation (`TypeError`/`RangeError`), pas un état de format : elle
 * n'atteint jamais le disque. La géométrie est validée par le contrat commun de #6.
 * @param {{ formatVersion?: number, runtime: object, app: object, volumeSize: number,
 *           identity?: object }} champs
 */
export function createManifest({
  formatVersion = MANIFEST_FORMAT_VERSION,
  runtime,
  app,
  volumeSize,
  identity = { algorithm: "sha-256", digest: null },
} = {}) {
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new TypeError(`Version de format invalide : ${JSON.stringify(formatVersion)}.`);
  }
  const runtimeNorm = normalizeRuntime(runtime, TypeError);
  const appNorm = normalizeApp(app, TypeError);
  const identityNorm = normalizeIdentity(identity, TypeError);
  assertBlockGeometry(volumeSize);

  return deepFreeze({
    magic: MANIFEST_MAGIC,
    formatVersion,
    runtime: runtimeNorm,
    app: appNorm,
    geometry: { volumeSize, sectorSize: SECTOR_SIZE, blockSize: V86_BLOCK_SIZE },
    identity: identityNorm,
  });
}

/** Encode un manifeste en octets déterministes (empreinte reproductible). */
export function serializeManifest(manifest) {
  return new TextEncoder().encode(JSON.stringify(canonicalize(manifest)));
}

/**
 * Valide une entrée (octets, chaîne ou objet) et rend un manifeste v1 GELÉ, ou lève une
 * `ManifestError` `VAULT_MANIFEST_MALFORMED`. Jamais un objet à moitié valide. Le marqueur et la
 * version de format forment le préambule figé : ils sont vérifiés d'abord, pour qu'un manifeste
 * reconnu mais d'un format futur soit ensuite REFUSÉ par `assertCompatible`, et non pris pour du
 * bruit. Les champs inconnus surnuméraires sont tolérés (compatibilité ascendante) ; le cœur v1 est
 * exigé.
 * @param {Uint8Array | string | object} input
 */
export function parseManifest(input) {
  const raw = decodeInput(input);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw malformed("un manifeste doit être un objet JSON.", { received: typeof raw });
  }
  if (raw.magic !== MANIFEST_MAGIC) {
    throw malformed("marqueur de manifeste absent ou inconnu.", { magic: raw.magic ?? null });
  }
  if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) {
    throw malformed("version de format absente ou non entière.", {
      formatVersion: raw.formatVersion,
    });
  }
  const runtime = normalizeRuntime(raw.runtime, malformedThrower("runtime"));
  const app = normalizeApp(raw.app, malformedThrower("app"));
  const identity = normalizeIdentity(raw.identity, malformedThrower("identity"));
  const geometry = normalizeGeometry(raw.geometry);

  return deepFreeze({
    magic: MANIFEST_MAGIC,
    formatVersion: raw.formatVersion,
    runtime,
    app,
    geometry,
    identity,
  });
}

/**
 * Verdict de compatibilité PUR (ne lève rien). Distingue lecture seule tolérée et écriture refusée.
 * `scope` vaut `"read"` quand le refus interdit déjà la lecture, `"write"` quand seule l'écriture est
 * refusée, `null` quand tout est permis.
 * @returns {{ readable: boolean, writable: boolean, refusal: string|null, scope: "read"|"write"|null }}
 */
export function evaluateCompatibility(manifest, expectations = {}) {
  const supported = expectations.supportedFormat ?? DEFAULT_SUPPORTED_FORMAT;

  if (manifest.formatVersion > supported.current) {
    return verdict(false, false, MANIFEST_ERROR_CODES.formatTooNew, "read");
  }
  if (manifest.formatVersion < supported.minReadable) {
    return verdict(false, false, MANIFEST_ERROR_CODES.formatTooOld, "read");
  }
  if (expectations.app && manifest.app.id !== expectations.app.id) {
    return verdict(false, false, MANIFEST_ERROR_CODES.identityMismatch, "read");
  }
  // Lisible à partir d'ici. Restent les refus qui ne bloquent QUE l'écriture.
  if (manifest.formatVersion < supported.current) {
    return verdict(true, false, MANIFEST_ERROR_CODES.migrationRequired, "write");
  }
  if (isRuntimeDowngrade(manifest, expectations)) {
    return verdict(true, false, MANIFEST_ERROR_CODES.runtimeDowngrade, "write");
  }
  return verdict(true, true, null, null);
}

/** Exige la LECTURE : lève si le format est futur, trop ancien, ou l'identité étrangère. */
export function assertReadable(manifest, expectations = {}) {
  const v = evaluateCompatibility(manifest, expectations);
  if (!v.readable) throw refusalError(v.refusal, manifest, expectations);
}

/** Exige l'ÉCRITURE : lève pour tout refus, lecture comme écriture (migration, downgrade compris). */
export function assertWritable(manifest, expectations = {}) {
  const v = evaluateCompatibility(manifest, expectations);
  if (!v.writable) throw refusalError(v.refusal, manifest, expectations);
}

/**
 * Chemin d'OUVERTURE EN ÉCRITURE (`SEC-UPDATE-001`) : lit le manifeste d'un volume et EXIGE une
 * identité et une version connues avant d'autoriser l'écriture. Un volume sans manifeste
 * (`manifestBytes` absent) est refusé — jamais d'écriture sur un support non identifié. Un manifeste
 * malformé ou incompatible propage son refus typé. Rend le manifeste validé en cas de succès.
 * @param {{ manifestBytes: Uint8Array | string | null | undefined, expectations?: object }} args
 */
export function assertVolumeWritable({ manifestBytes, expectations = {} } = {}) {
  if (manifestBytes === null || manifestBytes === undefined) {
    throw new ManifestError(
      MANIFEST_ERROR_CODES.unidentified,
      "Ouverture en écriture refusée : le volume ne porte aucun manifeste identifiable.",
    );
  }
  const manifest = parseManifest(manifestBytes);
  assertWritable(manifest, expectations);
  return manifest;
}

// --- interne ----------------------------------------------------------------------------------

function verdict(readable, writable, refusal, scope) {
  return { readable, writable, refusal, scope };
}

function isRuntimeDowngrade(manifest, expectations) {
  if (!expectations.runtime) return false;
  const volume = parseSemVer(manifest.runtime.version);
  const running = parseSemVer(expectations.runtime.version);
  if (running === null) {
    throw new TypeError(
      `Version de runtime en cours invalide : ${JSON.stringify(expectations.runtime.version)}.`,
    );
  }
  // Le manifeste a déjà été validé (SemVer garanti) ; ce garde-fou reste par prudence.
  if (volume === null) return false;
  return volume.major > running.major;
}

function decodeInput(input) {
  if (input instanceof Uint8Array) return parseJson(new TextDecoder().decode(input));
  if (typeof input === "string") return parseJson(input);
  if (input && typeof input === "object") return input;
  throw malformed("entrée de manifeste non décodable.", { received: typeof input });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw malformed("JSON invalide.", {});
  }
}

function malformed(detail, context) {
  return new ManifestError(
    MANIFEST_ERROR_CODES.malformed,
    `Manifeste malformé : ${detail}`,
    context,
  );
}

/** Fabrique un « leveur » d'erreur MALFORMED pour un champ nommé, réutilisé par les normalisateurs. */
function malformedThrower(champ) {
  return (message) => {
    throw malformed(`champ « ${champ} » invalide : ${message}`, { champ });
  };
}

function normalizeRuntime(runtime, onError) {
  if (!runtime || typeof runtime !== "object") throwWith(onError, "runtime absent.", TypeError);
  if (parseSemVer(runtime.version) === null) {
    throwWith(onError, `version SemVer invalide : ${JSON.stringify(runtime.version)}.`, TypeError);
  }
  const artifact = runtime.artifact ?? null;
  if (artifact !== null && typeof artifact !== "string") {
    throwWith(onError, "artefact de runtime : chaîne ou null attendu.", TypeError);
  }
  return { version: runtime.version, artifact };
}

function normalizeApp(app, onError) {
  if (!app || typeof app !== "object") throwWith(onError, "application absente.", TypeError);
  if (typeof app.id !== "string" || app.id === "") {
    throwWith(onError, "identité d'application absente.", TypeError);
  }
  if (typeof app.version !== "string" || app.version === "") {
    throwWith(onError, "version d'application absente.", TypeError);
  }
  return { id: app.id, version: app.version };
}

function normalizeIdentity(identity, onError) {
  if (!identity || typeof identity !== "object") throwWith(onError, "identité absente.", TypeError);
  if (typeof identity.algorithm !== "string" || identity.algorithm === "") {
    throwWith(onError, "algorithme d'empreinte absent.", TypeError);
  }
  const digest = identity.digest ?? null;
  if (digest !== null && typeof digest !== "string") {
    throwWith(onError, "empreinte : chaîne ou null attendu.", TypeError);
  }
  return { algorithm: identity.algorithm, digest };
}

/** Géométrie du manifeste : elle DOIT correspondre au contrat figé de #6, sinon c'est un malformé. */
function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    throw malformed("géométrie absente.", {});
  }
  if (geometry.sectorSize !== SECTOR_SIZE || geometry.blockSize !== V86_BLOCK_SIZE) {
    throw malformed("géométrie incohérente avec le contrat de blocs figé.", {
      sectorSize: geometry.sectorSize ?? null,
      blockSize: geometry.blockSize ?? null,
    });
  }
  try {
    assertBlockGeometry(geometry.volumeSize);
  } catch (cause) {
    throw malformed(`taille de volume invalide : ${geometry.volumeSize}.`, {
      volumeSize: geometry.volumeSize ?? null,
      cause: cause.message,
    });
  }
  return { volumeSize: geometry.volumeSize, sectorSize: SECTOR_SIZE, blockSize: V86_BLOCK_SIZE };
}

/**
 * Applique `onError` s'il est fourni (contexte parse → MALFORMED), sinon lève l'erreur `Fallback`
 * (contexte création → `TypeError`). Deux appelants, deux natures d'erreur, un seul normaliseur.
 */
function throwWith(onError, message, Fallback) {
  if (typeof onError === "function") onError(message);
  throw new Fallback(message);
}

const REFUSAL_MESSAGES = Object.freeze({
  [MANIFEST_ERROR_CODES.formatTooNew]: "format de volume plus récent que ce runtime : refusé.",
  [MANIFEST_ERROR_CODES.formatTooOld]: "format de volume trop ancien pour ce runtime : refusé.",
  [MANIFEST_ERROR_CODES.migrationRequired]:
    "format antérieur : lecture tolérée, écriture refusée jusqu'à migration.",
  [MANIFEST_ERROR_CODES.runtimeDowngrade]:
    "volume écrit par un runtime plus récent : écriture refusée (downgrade dangereux).",
  [MANIFEST_ERROR_CODES.identityMismatch]:
    "l'application en cours ne possède pas ce volume : refusé.",
});

function refusalError(code, manifest, expectations) {
  const supported = expectations.supportedFormat ?? DEFAULT_SUPPORTED_FORMAT;
  return new ManifestError(code, `Compatibilité refusée : ${REFUSAL_MESSAGES[code]}`, {
    formatVersion: manifest.formatVersion,
    supportedFormat: { current: supported.current, minReadable: supported.minReadable },
    volumeRuntime: manifest.runtime.version,
    runningRuntime: expectations.runtime?.version ?? null,
    volumeApp: manifest.app.id,
    runningApp: expectations.app?.id ?? null,
  });
}
