// Worker runtime du spike #4 : v86 et son backend de blocs vivent ici, conformément à l'ADR 0002.
// Le document n'obtient jamais l'émulateur ni le backend — il reçoit un compte rendu.

import { RESILIENCE_SCENARIOS } from "/vm/resilience-scenarios.mjs";
import { BlockJournal } from "/src/vm/block-journal.mjs";
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
import { cleDuBanc, poserCleDuBanc } from "./cle-du-banc.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
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

/**
 * Acquiert le runtime v86 : le module de l'émulateur, PUIS ses artefacts.
 *
 * Les trois bancs de ce fichier franchissent la même porte dans le même ordre, et cet ordre est
 * celui que la mesure du transfert suppose : `transferredBytes` ne compte que les artefacts, jamais
 * le module — que le navigateur peut d'ailleurs servir depuis son cache de modules.
 */
async function acquerirRuntimeV86() {
  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, transferredBytes } = await loadArtifacts();
  return { V86, artifacts, transferredBytes };
}

/**
 * Arme la session guest AVEC le registre où ses pannes fatales se déposent.
 *
 * Les deux sont indissociables, et c'est pourquoi cette couture les rend ensemble : l'adaptateur de
 * tampon n'existe que pour être remis à la session — aucun banc ne le touche ensuite —, et son seul
 * autre effet est de pousser dans `failures` les erreurs typées que v86 ne sait pas remonter. Rendre
 * la session sans son registre laisserait ces pannes sans lecteur.
 */
function armerSession({ V86, artifacts, backend, journal, mode }) {
  const failures = [];
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
  return { session, failures };
}

/**
 * Boote le guest, déroule les étapes, puis referme TOUJOURS la session et le volume.
 *
 * Le `finally` n'est pas décoratif : une étape qui échoue laisserait sinon le handle exclusif
 * ouvert, et l'exécution suivante rougirait sur `VAULT_STORAGE_BUSY` en masquant la cause réelle.
 * L'appelant assemble donc son compte rendu APRÈS la fermeture — ce que les bancs OPFS veulent,
 * puisqu'ils relisent ensuite le fichier refermé.
 */
async function deroulerSousVolume({ session, backend, observations, steps }) {
  try {
    const boot = await booter(session, observations);
    const results = await runSteps(session, steps);
    return { boot, results };
  } finally {
    session.stop();
    await backend.close();
  }
}

/**
 * Ouvre un volume EN MÉMOIRE et le journal qui l'observe — le pendant de `ouvrirVolumeNeuf` pour le
 * banc qui ne touche aucun support durable.
 *
 * Le compteur monotone porte tout le poids de l'isolement : sans lui, deux exécutions successives du
 * Worker se donneraient le même nom, et le registre du module rendrait le volume de la première.
 */
function ouvrirVolumeMemoire({ volumeBytes, flushDelay }) {
  volumeCounter += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `worker-${volumeCounter}`,
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay,
  });
  return { journal, backend };
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

  const { V86, artifacts, transferredBytes } = await acquerirRuntimeV86();
  const { journal, backend } = ouvrirVolumeMemoire({ volumeBytes, flushDelay });

  const observations = [];
  const { session, failures } = armerSession({ V86, artifacts, backend, journal, mode });

  // Compte rendu assemblé DANS le `try`, donc avant la fermeture : `counts()` et le verdict portent
  // sur le journal tel que les étapes l'ont laissé. `deroulerSousVolume` refermerait d'abord.
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
/**
 * Ouvre un volume OPFS NEUF, le journal qui l'observe et le plan de fautes qui l'instrumente.
 *
 * L'ordre des gestes est celui que les bancs comptaient déjà : le fichier existant est effacé AVANT
 * toute ouverture — sans quoi la géométrie d'une exécution précédente survivrait —, puis le journal
 * précède le backend, parce que c'est lui qui recevra la toute première opération.
 *
 * @param {string|null} [fault] une valeur de `FAULT_KINDS` à faire échouer sur la PREMIÈRE barrière,
 *                              ou `null` pour un support qui ne ment jamais.
 */
async function ouvrirVolumeNeuf({ volume, volumeBytes, flushDelay, fault = null }) {
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
    cle: cleDuBanc(),
  });
  return { journal, faults, backend };
}

/**
 * Phase GUEST de la preuve de persistance : marque de l'hôte déposée, guest booté, étapes déroulées,
 * session et volume refermés.
 *
 * Elle est séparée de la phase HÔTE parce que la preuve tient à leur frontière : tant que ce handle
 * n'est pas refermé, une relecture ne dirait rien du fichier, seulement du tampon qui le surplombe.
 */
async function deroulerGuestPersistance({ V86, artifacts, backend, journal, mode }) {
  // La marque de l'hôte est déposée AVANT le boot : ce que le guest lira vient du fichier OPFS et
  // d'aucun tampon intermédiaire.
  await backend.write(HOST_MARKER_OFFSET, encoder.encode(HOST_MARKER));
  await backend.flush();

  const observations = [];
  const { session, failures } = armerSession({ V86, artifacts, backend, journal, mode });
  const { boot, results } = await deroulerSousVolume({
    session,
    backend,
    observations,
    steps: OPFS_PERSISTENCE_STEPS,
  });
  return { boot, results, failures, observations };
}

/**
 * Phase HÔTE de la preuve : handle fermé, volume rouvert sans géométrie déclarée, les deux marques
 * relues. C'est la relecture qui porte sur le FICHIER, et sur rien d'autre.
 *
 * Le `finally` n'est pas décoratif : sans lui, une lecture qui échoue laisserait le handle exclusif
 * ouvert et l'exécution suivante rougirait sur `VAULT_STORAGE_BUSY`, en masquant la cause réelle.
 */
async function relireMarquesDansLeFichier(volume) {
  const reopened = await openOpfsVolume({
    name: volume,
    journal: new BlockJournal(),
    cle: cleDuBanc(),
  });
  try {
    const guestBytes = await reopened.read(GUEST_MARKER_OFFSET, GUEST_MARKER.length);
    const hostBytes = await reopened.read(HOST_MARKER_OFFSET, HOST_MARKER.length);
    return {
      // Relevée APRÈS les deux lectures, comme le banc l'a toujours fait : la taille rendue est
      // celle du volume tel qu'il vient d'être lu.
      reopenedSize: reopened.size(),
      hostReadOfGuestMarker: decoder.decode(guestBytes),
      hostReadOfHostMarker: decoder.decode(hostBytes),
    };
  } finally {
    await reopened.close();
  }
}

async function runOpfsPersistence({
  mode = BRIDGE_MODES.full,
  volumeBytes = 16 * 1024 * 1024,
  flushDelay = 0,
  volume = "guest-persistance",
}) {
  await exigerContexteExecutable();

  const { V86, artifacts, transferredBytes } = await acquerirRuntimeV86();
  const { journal, backend } = await ouvrirVolumeNeuf({ volume, volumeBytes, flushDelay });
  const guest = await deroulerGuestPersistance({ V86, artifacts, backend, journal, mode });
  const relecture = await relireMarquesDansLeFichier(volume);

  const steps = summariseSteps(journal, guest.results);
  const stepOutput = (label) => steps.find((step) => step.label === label)?.output ?? null;

  return {
    scenario: "opfs-persistence",
    mode,
    volume,
    volumeBytes,
    reopenedSize: relecture.reopenedSize,
    bootMilliseconds: guest.boot.bootMilliseconds,
    rythme: guest.boot.rythme,
    boucleOrdonnancement: guest.boot.boucleOrdonnancement,
    transferredBytes,
    counts: journal.counts(),
    steps,
    verdict: verdictForBarrierScenario(journal),
    expected: { hostMarker: HOST_MARKER, guestMarker: GUEST_MARKER },
    guestReadOfHostMarker: stepOutput("lire-marque-hote"),
    guestReadOfOwnMarker: stepOutput("relire-marque-guest"),
    hostReadOfGuestMarker: relecture.hostReadOfGuestMarker,
    hostReadOfHostMarker: relecture.hostReadOfHostMarker,
    failures: guest.failures,
    observationsRuntime: [...guest.observations, ...lireRejets()],
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

  const { V86, artifacts, transferredBytes } = await acquerirRuntimeV86();
  const { journal, faults, backend } = await ouvrirVolumeNeuf({
    volume,
    volumeBytes,
    flushDelay,
    fault,
  });

  const observations = [];
  const { session, failures } = armerSession({ V86, artifacts, backend, journal, mode });
  const { boot, results } = await deroulerSousVolume({
    session,
    backend,
    observations,
    steps: BARRIER_STEPS,
  });

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

// Les scénarios de résilience (#15) vivent dans leur propre module : ils n'ouvrent aucun émulateur,
// et l'armement de l'injecteur y est ainsi borné par un fichier entier plutôt que par une plage de
// texte au milieu de celui-ci — ce que `tests/unit/vm-crash-armement.test.mjs` vérifie.
const OPFS_SCENARIOS = new Map([
  ["opfs-persistence", runOpfsPersistence],
  ["opfs-barrier", runOpfsBarrier],
  ...RESILIENCE_SCENARIOS,
]);

/**
 * Un refus qui traverse le port avec son code ET son contexte (#73).
 *
 * Sans eux, un échec de support arrive en CI réduit à une phrase : ni offset, ni quota, ni errno —
 * c'est-à-dire sans rien de ce qui permet de le diagnostiquer. `toJSON()` est le contrat commun de
 * `StorageError` et de `RuntimeError`.
 */
function refusTransportable(error) {
  return typeof error.toJSON === "function"
    ? error.toJSON()
    : { name: error.name, code: error.code ?? null, message: error.message };
}

/**
 * Répond au DIAGNOSTIC : ce que ce contexte sait faire, sans démarrer d'émulateur ni charger un seul
 * artefact. C'est ce qui permet de l'éprouver sur les trois moteurs dans `npm run check`, qui n'a
 * pas de préalable réseau — et à une coquille de savoir, avant d'ouvrir un volume, si ce contexte
 * peut exécuter le runtime.
 */
function repondreAuControle(id) {
  controlerContexteCourant().then(
    (erreur) =>
      self.postMessage({
        id,
        ok: true,
        report: {
          url: location.href,
          schedulerPostTask: typeof globalThis.scheduler?.postTask === "function",
          // La boucle réellement en place dans CE contexte. Sans elle, `schedulerPostTask` serait
          // ambigu : il vaut « vrai » aussi bien pour l'implémentation du moteur que pour la nôtre,
          // et ce sont deux situations que #74 a mesurées comme opposées sous Firefox.
          boucleOrdonnancement: decrireBoucle(boucleOrdonnancement),
          diagnostic: erreur ? erreur.toJSON() : null,
        },
      }),
    (erreur) => self.postMessage({ id, ok: false, error: { message: erreur.message } }),
  );
}

/** Exécute un scénario sous la clé du harnais, posée pour sa durée et pour elle seule (ADR 0016). */
function executerScenario(id, options) {
  const relacher = poserCleDuBanc(options.jetonCle);
  const opfsRunner = OPFS_SCENARIOS.get(options.scenario);
  const execute = opfsRunner ? opfsRunner(options) : run(options);
  execute.finally(relacher).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) => self.postMessage({ id, ok: false, error: refusTransportable(error) }),
  );
}

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type === "controler") {
    repondreAuControle(id);
    return;
  }
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  executerScenario(id, payload ?? {});
});
