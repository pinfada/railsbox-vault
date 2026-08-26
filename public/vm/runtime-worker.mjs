// Worker runtime du spike #4 : v86 et son backend de blocs vivent ici, conformément à l'ADR 0002.
// Le document n'obtient jamais l'émulateur ni le backend — il reçoit un compte rendu.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { classerVolume } from "/src/vm/crash-oracle.mjs";
import { armerInjecteur } from "/src/vm/crash-plan.mjs";
import {
  VOLUME_OCTETS as RESILIENCE_VOLUME_OCTETS,
  blocsAttendus,
  ecrireEtatAncien,
  ecrireEtatNouveau,
  relireBlocs,
} from "/src/vm/crash-scenario.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import {
  BARRIER_STEPS,
  FILESYSTEM_STEPS,
  GUEST_MARKER,
  GUEST_MARKER_OFFSET,
  HOST_MARKER,
  HOST_MARKER_OFFSET,
  OPFS_PERSISTENCE_STEPS,
  runSteps,
  summariseSteps,
  verdictForBarrierScenario,
} from "/src/vm/guest-scenarios.mjs";
import { createGuestSession } from "/src/vm/guest-session.mjs";
import { openMemoryVolume } from "/src/vm/memory-block-backend.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "/src/vm/storage-errors.mjs";
import {
  consignerRejetsNonTraites,
  controlerContexteCourant,
  executerSousGarde,
  exigerContexteExecutable,
  mesurerRythme,
} from "/src/vm/runtime-environment.mjs";
import { decrireBoucle, installerBoucleOrdonnancement } from "/src/vm/scheduling-loop.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { BRIDGE_MODES } from "/src/vm/v86-flush-bridge.mjs";

/**
 * La boucle d'ordonnancement de v86 est posée À L'ÉVALUATION de ce module, donc avant tout import
 * dynamique de `libv86.mjs` et avant le contrôle préalable. L'ordre n'est pas négociable : v86 fige
 * son chemin d'ordonnancement à l'évaluation de SON module et ne le révise jamais (ADR 0013, § « Mise
 * en œuvre par #74 »). Posée plus tard, elle ne servirait à rien ; posée ici, elle sert aux trois
 * moteurs de la matrice.
 */
const boucleOrdonnancement = installerBoucleOrdonnancement();

/**
 * Rejets non traités du Worker, consignés dès son évaluation. `libv86.mjs` jette la valeur de
 * retour de `scheduler.postTask` : une exception dans un tour de boucle rejette une promesse que
 * rien n'attend, arrête l'émulateur sans bruit, et se déguise ensuite en délai de garde du guest.
 */
const lireRejets = consignerRejetsNonTraites();

const ARTIFACTS = "/vendor/v86/artefacts/";
const SCENARIOS = { barrier: BARRIER_STEPS, filesystem: FILESYSTEM_STEPS };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Le contexte est contrôlé AVANT toute construction d'émulateur, et son refus porte un code de
 * `src/vm/runtime-errors.mjs`. C'est la réponse au symptôme central de #52 : sous la CSP de la
 * coquille, v86 privé de boucle d'ordonnancement ne bat jamais, sans lever la moindre exception.
 *
 * Le chien de garde du premier tour complète le contrôle : il attrape les pannes que celui-ci n'a
 * pas su prédire, au lieu de laisser le délai de garde du guest les attribuer à un guest lent.
 *
 * Ici, `session.boot()` de `guest-session.mjs` attend l'INVITE du guest : la garde couvre donc
 * toute l'attente utile. Sur le chemin de l'image de référence, où `boot()` rend la main bien plus
 * tôt, la garde couvre une phase plus large — voir `reference-worker-boot.mjs`.
 *
 * Il rend AUSSI le rythme observé de la boucle sur la fenêtre du boot. C'est la mesure qui permet
 * de comparer deux exécutions de l'émulateur (#74) : une durée de boot seule ne dirait pas si
 * l'émulateur a tourné plus vite ou si le guest a eu moins à faire. Le compteur est cumulé depuis
 * la construction de l'émulateur, donc quelques tours avant `run()` entrent dans la fenêtre — sur
 * des milliers de tours, l'écart est sous la résolution de l'instrument.
 *
 * @param {object} session
 * @param {Record<string, unknown>[]} observations recueille les observations non fatales de la garde
 * @returns {Promise<{ bootMilliseconds: number, rythme: Record<string, number | null> }>}
 */
async function booter(session, observations) {
  const ecouleMs = await executerSousGarde(
    () => session.ticks(),
    () => session.boot(),
    {
      onObservation: (observation) => observations.push(observation),
      decrireBoucle: () => decrireBoucle(boucleOrdonnancement),
      // La garde se cadence sur les BATTEMENTS de la boucle en plus de la minuterie : sous un
      // moteur qui affame ses minuteries pendant que la boucle tourne, elle n'expirerait pas
      // pendant la plage qu'elle borne (WebKit, mesuré — voir `scheduling-loop.mjs`).
      boucle: boucleOrdonnancement,
    },
  );
  return {
    bootMilliseconds: Number(ecouleMs.toFixed(1)),
    rythme: mesurerRythme({ ticks: session.ticks(), fenetreMs: ecouleMs }),
    // Relevé sur la MÊME fenêtre que le rythme : le nombre de tâches dit si v86 a réellement
    // emprunté la boucle posée, ce que « la boucle est posée » ne prouve pas à soi seul.
    boucleOrdonnancement: decrireBoucle(boucleOrdonnancement),
  };
}

let volumeCounter = 0;

async function fetchBytes(name) {
  const response = await fetch(`${ARTIFACTS}${name}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Artefact ${name} indisponible (${response.status}). Exécuter « npm run vm:fetch ».`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function loadArtifacts() {
  const [wasm, bios, vgaBios, cdrom] = await Promise.all([
    fetchBytes("v86.wasm"),
    fetchBytes("seabios.bin"),
    fetchBytes("vgabios.bin"),
    fetchBytes("linux4.iso"),
  ]);
  return {
    artifacts: { wasm, bios, vgaBios, cdrom },
    transferredBytes: wasm.byteLength + bios.byteLength + vgaBios.byteLength + cdrom.byteLength,
  };
}

async function run({
  scenario = "barrier",
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 5,
}) {
  const steps = SCENARIOS[scenario];
  if (!steps) throw new Error(`Scénario inconnu : ${scenario}`);
  await exigerContexteExecutable();

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();

  volumeCounter += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `worker-${volumeCounter}`,
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay,
  });
  const failures = [];
  const observations = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({
    V86,
    artifacts,
    adapter,
    journal,
    mode,
    boucle: boucleOrdonnancement,
  });

  try {
    const boot = await booter(session, observations);
    const results = await runSteps(session, steps);
    const verdict = verdictForBarrierScenario(journal);
    return {
      scenario,
      mode,
      bootMilliseconds: boot.bootMilliseconds,
      rythme: boot.rythme,
      boucleOrdonnancement: boot.boucleOrdonnancement,
      transferredBytes,
      counts: journal.counts(),
      steps: summariseSteps(journal, results),
      verdict,
      failures,
      observationsRuntime: [...observations, ...lireRejets()],
      crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
    };
  } finally {
    session.stop();
    await backend.close();
  }
}

/**
 * Preuve de persistance de bout en bout (#6) : un vrai guest Linux lit une marque écrite par
 * l'hôte dans le fichier OPFS, écrit la sienne, la synchronise ; l'hôte ferme alors le handle,
 * rouvre le volume et vérifie que les octets du guest sont bien dans le fichier.
 *
 * Deux directions, parce qu'une seule ne prouverait qu'une moitié : que le guest voie le support
 * n'implique pas que ses écritures y atterrissent, et l'inverse non plus.
 */
async function runOpfsPersistence({
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 0,
  volume = "guest-persistance",
}) {
  await exigerContexteExecutable();

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();

  await removeOpfsVolume(volume);
  const journal = new BlockJournal();
  const backend = await openOpfsVolume({
    name: volume,
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay,
  });

  // La marque de l'hôte est déposée AVANT le boot : ce que le guest lira vient du fichier OPFS et
  // d'aucun tampon intermédiaire.
  await backend.write(HOST_MARKER_OFFSET, encoder.encode(HOST_MARKER));
  await backend.flush();

  const failures = [];
  const observations = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({
    V86,
    artifacts,
    adapter,
    journal,
    mode,
    boucle: boucleOrdonnancement,
  });

  let boot;
  let results;
  try {
    boot = await booter(session, observations);
    results = await runSteps(session, OPFS_PERSISTENCE_STEPS);
  } finally {
    session.stop();
    await backend.close();
  }

  // Handle fermé, volume rouvert sans géométrie déclarée : la relecture porte sur le fichier.
  // Le `finally` n'est pas décoratif : sans lui, une lecture qui échoue laisserait le handle
  // exclusif ouvert et l'exécution suivante rougirait sur `VAULT_STORAGE_BUSY`, en masquant la
  // cause réelle.
  const reopened = await openOpfsVolume({ name: volume, journal: new BlockJournal() });
  let guestBytes;
  let hostBytes;
  let reopenedSize;
  try {
    guestBytes = await reopened.read(GUEST_MARKER_OFFSET, GUEST_MARKER.length);
    hostBytes = await reopened.read(HOST_MARKER_OFFSET, HOST_MARKER.length);
    reopenedSize = reopened.size();
  } finally {
    await reopened.close();
  }

  const steps = summariseSteps(journal, results);
  const stepOutput = (label) => steps.find((step) => step.label === label)?.output ?? null;

  return {
    scenario: "opfs-persistence",
    mode,
    volume,
    volumeBytes,
    reopenedSize,
    bootMilliseconds: boot.bootMilliseconds,
    rythme: boot.rythme,
    boucleOrdonnancement: boot.boucleOrdonnancement,
    transferredBytes,
    counts: journal.counts(),
    steps,
    verdict: verdictForBarrierScenario(journal),
    expected: { hostMarker: HOST_MARKER, guestMarker: GUEST_MARKER },
    guestReadOfHostMarker: stepOutput("lire-marque-hote"),
    guestReadOfOwnMarker: stepOutput("relire-marque-guest"),
    hostReadOfGuestMarker: decoder.decode(guestBytes),
    hostReadOfHostMarker: decoder.decode(hostBytes),
    failures,
    observationsRuntime: [...observations, ...lireRejets()],
    crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
  };
}

/**
 * Barrière durable de bout en bout sur le backend OPFS (#14, `SEC-DURABLE-001`). Un vrai guest écrit
 * puis `fsync` sur un disque IDE adossé au backend OPFS ; la mesure porte sur la CHAÎNE causale
 * write → flush(OPFS réel) → acquittement, et sur les deux écarts qui la rendraient fausse :
 *
 *  - `flushDelay > 0` retarde la barrière du support. Le guest reste occupé (BSY) jusqu'à sa
 *    résolution — le rapport le montre par un ordre `flush` avant `flush-ack` maintenu, jamais
 *    inversé ;
 *  - `fault` (une valeur de `FAULT_KINDS` sur l'opération `flush`) fait échouer la barrière. La
 *    commande ATA est alors ABANDONNÉE : le guest reçoit une erreur d'E/S, la coquille une erreur
 *    typée dans `failures`, et AUCUN `flush-ack` n'est inventé.
 */
async function runOpfsBarrier({
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 0,
  fault = null,
  volume = "guest-barriere",
}) {
  await exigerContexteExecutable();

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();

  await removeOpfsVolume(volume);
  const journal = new BlockJournal();
  const faults = fault
    ? createFaultPlan([{ kind: fault, operation: "flush", occurrence: 1 }])
    : createFaultPlan();
  const backend = await openOpfsVolume({
    name: volume,
    size: volumeBytes,
    journal,
    faults,
    flushDelay,
  });

  const failures = [];
  const observations = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
  });
  const session = createGuestSession({
    V86,
    artifacts,
    adapter,
    journal,
    mode,
    boucle: boucleOrdonnancement,
  });

  let boot;
  let results;
  try {
    boot = await booter(session, observations);
    results = await runSteps(session, BARRIER_STEPS);
  } finally {
    session.stop();
    await backend.close();
  }

  return {
    scenario: "opfs-barrier",
    mode,
    volume,
    volumeBytes,
    flushDelay,
    fault,
    bootMilliseconds: boot.bootMilliseconds,
    rythme: boot.rythme,
    boucleOrdonnancement: boot.boucleOrdonnancement,
    transferredBytes,
    counts: journal.counts(),
    steps: summariseSteps(journal, results),
    verdict: verdictForBarrierScenario(journal),
    faultsFired: faults.fired(),
    faultsUnfired: faults.unfired(),
    failures,
    observationsRuntime: [...observations, ...lireRejets()],
    crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
  };
}

/**
 * Trois scénarios de RÉSILIENCE (#15). Ils n'ouvrent aucun émulateur : aucun artefact v86 n'est
 * chargé, et `exigerContexteExecutable` n'est donc pas appelé — ce contrôle porte sur la capacité à
 * faire tourner v86, qui n'est pas en jeu ici. Ce qui est en jeu, c'est ce qu'une coupure laisse sur
 * un volume OPFS RÉEL.
 *
 * Ils se répartissent le travail parce que l'arrêt est RÉEL : c'est la page qui appelle
 * `Worker.terminate()`, et un Worker terminé ne rend plus de compte rendu. Le Worker qui coupe rend
 * donc son journal AVANT de mourir ; un autre relit ensuite le volume et classe.
 */
const VOLUME_RESILIENCE = "resilience";

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rouvre un volume dont le détenteur précédent est mort sans fermer son handle. Le moteur reprend
 * l'exclusivité quand le Worker disparaît, mais pas forcément AVANT que la page ait démarré le
 * suivant : l'attente est bornée et son coût est PUBLIÉ, jamais masqué par une réussite tardive.
 */
async function rouvrirApresCoupure(volume, { tentatives, attenteMs, journal }) {
  for (let essai = 1; essai <= tentatives; essai += 1) {
    try {
      const backend = await openOpfsVolume({ name: volume, journal, faults: createFaultPlan() });
      return { backend, essais: essai };
    } catch (erreur) {
      if (!isStorageError(erreur, STORAGE_ERROR_CODES.busy) || essai === tentatives) throw erreur;
      await attendre(attenteMs);
    }
  }
  throw new Error("Inatteignable : la boucle rend ou relance toujours.");
}

/** Prépare l'ANCIEN état du volume, puis referme proprement. Le point de coupure part de là. */
async function runResiliencePreparer({ volume = VOLUME_RESILIENCE }) {
  await removeOpfsVolume(volume);
  const journal = new BlockJournal();
  const backend = await openOpfsVolume({
    name: volume,
    size: RESILIENCE_VOLUME_OCTETS,
    journal,
    faults: createFaultPlan(),
  });
  let ancien;
  try {
    ancien = await ecrireEtatAncien(backend);
  } finally {
    await backend.close();
  }
  if (ancien.arret !== null) {
    throw new Error(
      `La préparation de l'ancien état a échoué (${ancien.arret.code}) : la coupure ne mesurerait pas ce qu'elle prétend.`,
    );
  }
  return { scenario: "resilience-preparer", volume, ...ancien, counts: journal.counts() };
}

/**
 * Écrit le NOUVEL état sous injecteur armé, puis rend la main SANS fermer le volume et SANS
 * franchir de barrière. Le handle exclusif reste ouvert : la page tue ce Worker juste après avoir
 * reçu ce compte rendu, et c'est ce `terminate()` qui est l'arrêt réel.
 */
async function runResilienceCouper({ volume = VOLUME_RESILIENCE, point, jeton }) {
  const journal = new BlockJournal();
  const fautes = armerInjecteur(point, { jeton });
  const backend = await openOpfsVolume({ name: volume, journal, faults: fautes });
  const ecriture = await ecrireEtatNouveau(backend);
  return {
    scenario: "resilience-couper",
    volume,
    point,
    ...ecriture,
    // Le journal traverse le port AVANT la mort du Worker : l'oracle en a besoin pour savoir
    // quelles écritures ont été acquittées et lesquelles une barrière a franchies.
    journal: journal.entries().map((entree) => ({ ...entree })),
    fautesTirees: fautes.fired().map((faute) => ({ ...faute })),
    fautesNonTirees: fautes.unfired().map((faute) => ({ ...faute })),
  };
}

/** Rouvre le volume après la coupure, relit les blocs suivis et les classe. */
async function runResilienceClasser({
  volume = VOLUME_RESILIENCE,
  journal = [],
  tentatives = 60,
  attenteMs = 50,
}) {
  const relecture = new BlockJournal();
  const { backend, essais } = await rouvrirApresCoupure(volume, {
    tentatives,
    attenteMs,
    journal: relecture,
  });
  let blocs;
  try {
    blocs = await relireBlocs(backend);
  } finally {
    await backend.close();
  }
  const rapport = classerVolume({ blocs: blocsAttendus(blocs), journal });
  return {
    scenario: "resilience-classer",
    volume,
    reouverture: { essais, attenteMs },
    verdict: rapport.verdict,
    raison: rapport.raison,
    atomique: rapport.atomique,
    classes: rapport.classes,
    blocs: rapport.blocs.map((bloc) => ({ ...bloc })),
  };
}

const OPFS_SCENARIOS = new Map([
  ["opfs-persistence", runOpfsPersistence],
  ["opfs-barrier", runOpfsBarrier],
  ["resilience-preparer", runResiliencePreparer],
  ["resilience-couper", runResilienceCouper],
  ["resilience-classer", runResilienceClasser],
]);

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  // Le diagnostic est interrogeable SANS démarrer d'émulateur ni charger un seul artefact. C'est ce
  // qui permet de l'éprouver sur les trois moteurs dans `npm run check`, qui n'a pas de préalable
  // réseau — et à une coquille de savoir, avant d'ouvrir un volume, si ce contexte peut exécuter le
  // runtime.
  if (type === "controler") {
    controlerContexteCourant().then(
      (erreur) =>
        self.postMessage({
          id,
          ok: true,
          report: {
            url: location.href,
            schedulerPostTask: typeof globalThis.scheduler?.postTask === "function",
            // La boucle réellement en place dans CE contexte. Sans elle, `schedulerPostTask` serait
            // ambigu : il vaut « vrai » aussi bien pour l'implémentation du moteur que pour la
            // nôtre, et ce sont deux situations que #74 a mesurées comme opposées sous Firefox.
            boucleOrdonnancement: decrireBoucle(boucleOrdonnancement),
            diagnostic: erreur ? erreur.toJSON() : null,
          },
        }),
      (erreur) => self.postMessage({ id, ok: false, error: { message: erreur.message } }),
    );
    return;
  }
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  const options = payload ?? {};
  const opfsRunner = OPFS_SCENARIOS.get(options.scenario);
  const execute = opfsRunner ? opfsRunner(options) : run(options);
  execute.then(
    (report) => self.postMessage({ id, ok: true, report }),
    // Une erreur TYPÉE traverse le port avec son code ET son contexte : la coquille doit pouvoir
    // distinguer « la CSP refuse WebAssembly » de « le Worker imbriqué est mort » sans lire un
    // message. `toJSON()` est le contrat commun de `StorageError` et de `RuntimeError`.
    (error) =>
      self.postMessage({
        id,
        ok: false,
        error:
          typeof error.toJSON === "function"
            ? error.toJSON()
            : { name: error.name, code: error.code ?? null, message: error.message },
      }),
  );
});
