// Worker runtime du backend de blocs OPFS (#6). C'est le SEUL contexte du dépôt autorisé à ouvrir
// un handle exclusif : la coquille lui demande un compte rendu et n'obtient jamais autre chose que
// des données JSON (ADR 0002).
//
// Aucun scénario ne rend « réussi » de lui-même : il rend ce qu'il a observé, et l'assertion vit
// dans `tests/browser/opfs-block-backend.spec.mjs`. Une capacité absente devient une erreur typée
// remontée à la page, jamais un repli silencieux.

import { buildBlockFixture, digestHex } from "/src/vm/block-fixture.mjs";
import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import {
  PROBE_VOLUME_BYTES,
  exposesSyncAccessHandle,
  observePersistence,
} from "/src/vm/opfs-scenarios.mjs";
import { openOpfsSyncAccess, removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";

/** Code d'une erreur typée, ou `null` si l'opération a réussi — ce qui est alors un échec. */
function codeOf(error) {
  return typeof error?.code === "string" ? error.code : null;
}

/**
 * Ce que CE moteur offre au Worker. La mesure ne se contente pas d'interroger `typeof` : elle
 * ouvre réellement un handle, parce qu'une API présente peut refuser à l'exécution. Un refus est
 * enregistré avec son code typé — c'est une mesure, pas une erreur avalée.
 */
async function scenarioCapacite() {
  const name = "sonde-capacite";
  const measurement = {
    workerGetDirectory: typeof globalThis.navigator?.storage?.getDirectory,
    workerCreateSyncAccessHandle:
      typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
    openCode: null,
    openMessage: null,
  };
  try {
    const handle = await openOpfsSyncAccess(name);
    handle.close();
    await removeOpfsVolume(name);
  } catch (error) {
    measurement.openCode = codeOf(error);
    measurement.openMessage = error.message;
  }
  return measurement;
}

/** Sonde de persistance : écrire, flusher, fermer, rouvrir, tout relire sur le vrai OPFS. */
async function scenarioPersistance() {
  const name = "sonde-persistance";
  await removeOpfsVolume(name);
  return observePersistence({ openVolume: openOpfsVolume, name, support: "opfs" });
}

/** Exclusivité : le registre local ET le support lui-même refusent un second détenteur. */
async function scenarioExclusivite() {
  const name = "sonde-exclusivite";
  await removeOpfsVolume(name);

  const first = await openOpfsVolume({ name, size: PROBE_VOLUME_BYTES });
  let secondVolumeCode = null;
  let secondHandleCode = null;

  try {
    try {
      const doublon = await openOpfsVolume({ name, size: PROBE_VOLUME_BYTES });
      await doublon.close();
    } catch (error) {
      secondVolumeCode = codeOf(error);
    }

    // Le registre du module pourrait masquer un support permissif : la demande suivante
    // court-circuite le registre et interroge OPFS directement.
    try {
      const brut = await openOpfsSyncAccess(name);
      brut.close();
    } catch (error) {
      secondHandleCode = codeOf(error);
    }
  } finally {
    await first.close();
  }

  const third = await openOpfsVolume({ name });
  let afterCloseSize;
  try {
    afterCloseSize = third.size();
  } finally {
    await third.close();
  }

  let closedVolumeCode = null;
  try {
    await third.read(0, SECTOR_SIZE);
  } catch (error) {
    closedVolumeCode = codeOf(error);
  }

  return { volume: name, secondVolumeCode, secondHandleCode, afterCloseSize, closedVolumeCode };
}

/**
 * Contrat de tampon de v86 au-dessus du support durable. L'adaptateur de #4 est branché tel quel :
 * si le backend OPFS respectait le contrat « sur le papier » mais pas la sémantique attendue par
 * `ide.js`, c'est ici que cela se verrait.
 */
async function scenarioAdaptateur() {
  const name = "sonde-adaptateur";
  await removeOpfsVolume(name);

  const backend = await openOpfsVolume({ name, size: PROBE_VOLUME_BYTES });
  const failures = [];
  const pending = new Set();
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => {
      failures.push(error.toJSON());
      // Une opération qui échoue n'appelle jamais son callback : sans ceci, la sonde attendrait
      // indéfiniment un acquittement qui ne viendra pas.
      for (const reject of pending) reject(error);
      pending.clear();
    },
  });

  const attendre = (register) =>
    new Promise((resolve, reject) => {
      pending.add(reject);
      register((value) => {
        pending.delete(reject);
        resolve(value ?? true);
      });
    });

  const offset = 2 * SECTOR_SIZE;
  const payload = await buildBlockFixture(4096);
  const writtenDigest = await digestHex(payload);

  let loaded = false;
  let setAcknowledged;
  let flushAcknowledged;
  let roundTrip;
  let getStateCode = null;
  let exposesFileSystemHandle;
  let status;

  // `attendre` rejette dès que l'adaptateur signale une panne : sans `finally`, ce rejet laisserait
  // le handle exclusif ouvert et l'exécution suivante rougirait sur `VAULT_STORAGE_BUSY`.
  try {
    adapter.onload = () => {
      loaded = true;
    };
    adapter.load();

    setAcknowledged = await attendre((done) => adapter.set(offset, payload, () => done(true)));
    flushAcknowledged = await attendre((done) => adapter.flush(() => done(true)));
    roundTrip = await attendre((done) =>
      adapter.get(offset, payload.byteLength, (data) => done(data)),
    );

    try {
      adapter.get_state();
    } catch (error) {
      getStateCode = codeOf(error);
    }

    exposesFileSystemHandle = exposesSyncAccessHandle(backend) || exposesSyncAccessHandle(adapter);

    // L'adaptateur décrémente son compteur d'opérations en vol dans le `finally` de sa promesse,
    // donc APRÈS avoir appelé le callback de v86. Lire l'état sans céder la main compterait une
    // opération déjà acquittée ; le tour de boucle ci-dessous rend la mesure exacte.
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = adapter.status();
  } finally {
    await backend.close();
  }

  // Le volume est rouvert APRÈS la fermeture du handle : ce que l'adaptateur a écrit doit encore
  // être là, sinon la durabilité annoncée par `describe()` serait un mensonge.
  const reopened = await openOpfsVolume({ name });
  let persistedAfterReopen;
  try {
    const relu = await reopened.read(offset, payload.byteLength);
    persistedAfterReopen = (await digestHex(relu)) === writtenDigest;
  } finally {
    await reopened.close();
  }

  return {
    volume: name,
    byteLength: adapter.byteLength,
    loaded,
    setAcknowledged,
    flushAcknowledged,
    writtenDigest,
    roundTripDigest: await digestHex(roundTrip),
    getStateCode,
    exposesFileSystemHandle,
    status: { fatal: status.fatal, inFlight: status.inFlight },
    failures,
    persistedAfterReopen,
  };
}

const SCENARIOS = new Map([
  ["capacite", scenarioCapacite],
  ["persistance", scenarioPersistance],
  ["exclusivite", scenarioExclusivite],
  ["adaptateur", scenarioAdaptateur],
]);

async function run({ scenario = "persistance" } = {}) {
  const runner = SCENARIOS.get(scenario);
  if (!runner) throw new Error(`Scénario inconnu : ${scenario}`);
  return runner();
}

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  run(payload ?? {}).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) =>
      self.postMessage({
        id,
        ok: false,
        error: { name: error.name, code: codeOf(error), message: error.message },
      }),
  );
});
