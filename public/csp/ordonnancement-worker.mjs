// Worker de MESURE de l'issue #52 : sous quelle configuration de CSP la boucle d'ordonnancement de
// v86 bat-elle réellement, sur chacun des trois moteurs de la matrice ?
//
// Ce Worker n'est PAS le Worker runtime du produit et ne doit pas le devenir. Il s'en distingue par
// une propriété délibérée : **il ne vérifie aucun prérequis**. Le Worker runtime refuse de démarrer
// quand la boucle d'ordonnancement manque ; celui-ci démarre quand même, pour que la conduite de
// l'émulateur dans cette situation soit OBSERVÉE et non postulée. C'est la reproduction du symptôme
// décrit par #52 — « l'émulateur ne démarre alors jamais sans erreur visible ».
//
// Il capte donc tout ce qui pourrait passer pour du silence : erreurs du Worker, rejets non
// traités, violations de CSP, et le compteur de tours de la boucle de v86.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import { createGuestSession } from "/src/vm/guest-session.mjs";
import { openMemoryVolume } from "/src/vm/memory-block-backend.mjs";
import { sonderWorkerBlob } from "/src/vm/runtime-environment.mjs";
import {
  SOURCES_BOUCLE,
  decrireBoucle,
  installerBoucleOrdonnancement,
} from "/src/vm/scheduling-loop.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { BRIDGE_MODES } from "/src/vm/v86-flush-bridge.mjs";

const ARTEFACTS = "/vendor/v86/artefacts/";
const MIO = 1024 * 1024;
const PERIODE_SONDE_MS = 250;

/** Libellés du relevé, figés depuis la mesure de l'ADR 0013 : les rapports doivent rester lisibles. */
const LIBELLES_CALE = Object.freeze({
  [SOURCES_BOUCLE.native]: "native",
  [SOURCES_BOUCLE.vault]: "posee",
  [SOURCES_BOUCLE.vaultSurNative]: "posee-par-dessus-native",
});

/** Tout ce qui ressemblerait, sans être capté, à un échec silencieux. */
const incidents = [];
const noter = (type, message) => {
  if (incidents.length < 40) incidents.push({ type, message: String(message).slice(0, 400) });
};

self.addEventListener("error", (evenement) => noter("error", evenement.message));
self.addEventListener("unhandledrejection", (evenement) =>
  noter("unhandledrejection", evenement.reason?.message ?? evenement.reason),
);
self.addEventListener("securitypolicyviolation", (evenement) =>
  noter(
    "securitypolicyviolation",
    `${evenement.effectiveDirective} ← ${evenement.blockedURI ?? "?"}`,
  ),
);

/**
 * Cale de `scheduler.postTask` fournie par Vault, évaluée comme option 3 de l'ADR 0013.
 *
 * Depuis #74, elle n'est plus écrite ici : c'est `src/vm/scheduling-loop.mjs`, le module LIVRÉ dans
 * les Workers runtime, qui la pose. Le harnais mesure donc désormais le code du produit et non une
 * réplique — sans quoi la mesure de l'ADR 0013 pourrait rester verte pendant que la boucle livrée
 * diverge. Les libellés du relevé sont inchangés, pour que les rapports restent comparables.
 *
 * Deux modes, parce qu'ils répondent à deux questions différentes : « si-absent » complète un moteur
 * qui n'a pas l'API (WebKit), « toujours » remplace aussi l'implémentation NATIVE — c'est la seule
 * façon de savoir si la boucle `postTask` native est ce qui monopolise le thread sous Firefox (#74).
 */
function installerCale(mode) {
  if (!mode) return { libelle: "absente", descripteur: null };
  const boucle = installerBoucleOrdonnancement({ siNatifAbsent: mode !== "toujours" });
  return { libelle: LIBELLES_CALE[boucle.source], descripteur: boucle };
}

/** Chemin que v86 choisira, déduit des mêmes conditions que son module. */
function cheminAttendu() {
  if (
    typeof globalThis.scheduler?.postTask === "function" &&
    location.href.includes("use-scheduling-api")
  ) {
    return "scheduler.postTask";
  }
  return typeof Worker !== "undefined" ? "worker-imbrique-blob" : "setTimeout";
}

async function lireArtefact(nom) {
  const reponse = await fetch(`${ARTEFACTS}${nom}`, { cache: "no-store" });
  if (!reponse.ok) {
    throw new Error(`Artefact ${nom} indisponible (${reponse.status}). Exécuter « vm:fetch ».`);
  }
  return new Uint8Array(await reponse.arrayBuffer());
}

async function chargerArtefacts() {
  const [wasm, bios, vgaBios, cdrom] = await Promise.all([
    lireArtefact("v86.wasm"),
    lireArtefact("seabios.bin"),
    lireArtefact("vgabios.bin"),
    lireArtefact("linux4.iso"),
  ]);
  return { wasm, bios, vgaBios, cdrom };
}

/** Instanciation d'un module WebAssembly minimal — le module vide, huit octets d'en-tête. */
async function essayerWasm() {
  const octets = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  try {
    await WebAssembly.instantiate(octets, {});
    return "instancie";
  } catch (erreur) {
    return `refuse:${erreur.name}: ${erreur.message}`.slice(0, 200);
  }
}

/**
 * Ce que le contexte offre AVANT que l'émulateur ne soit construit. Le relevé est pris ici et non
 * après le boot : c'est ce qui permet d'attribuer un non-démarrage à la CSP plutôt qu'à v86.
 *
 * `workerBlob` passe par `sonderWorkerBlob()` du runtime livré, qui mesure un SIGNE DE VIE borné.
 * L'ancienne sonde de ce banc concluait « cree » dès que le constructeur n'avait pas levé — or
 * c'est exactement ce que #52 a mesuré : sous `worker-src 'self'`, le constructeur ne lève jamais et
 * rend un objet inerte. Le champ annonçait donc « cree » sur des Workers morts (#85).
 */
async function relevePrealable({ cale, bootTimeoutMs }) {
  const { libelle, descripteur } = installerCale(cale);
  const releve = {
    urlContexte: location.href,
    marqueurUrl: location.href.includes("use-scheduling-api"),
    schedulerPostTask: typeof globalThis.scheduler?.postTask === "function",
    cale: libelle,
    cheminAttendu: cheminAttendu(),
    workerBlob: await sonderWorkerBlob(),
    wasm: await essayerWasm(),
    bootTimeoutMs,
  };
  return { releve, descripteur };
}

/** Ouvre un volume en mémoire et la session de guest qui s'y adosse. */
async function ouvrirSession(volumeBytes) {
  const { V86 } = await import(`${ARTEFACTS}libv86.mjs`);
  const artifacts = await chargerArtefacts();
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: "ordonnancement",
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay: 0,
  });
  const adapter = createV86BufferAdapter({ backend, onFatal: (e) => noter("backend", e.message) });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode: BRIDGE_MODES.full });
  return { session, journal, backend };
}

/**
 * Boot borné, sous scrutation du compteur de tours. Le boot est mené jusqu'au bout ou jusqu'à son
 * délai ; un échec est CONSIGNÉ, jamais propagé : un moteur qui ne démarre pas est une mesure.
 */
async function mesurerBoot({ session, backend, bootTimeoutMs }) {
  let ticks = null;
  let battements = 0;
  const sonde = setInterval(() => {
    battements += 1;
    const tours = session.ticks();
    if (tours !== null) ticks = tours;
  }, PERIODE_SONDE_MS);

  const debut = performance.now();
  let bootMs = null;
  let erreur = null;
  try {
    bootMs = Number((await session.boot({ timeout: bootTimeoutMs })).toFixed(1));
  } catch (echec) {
    erreur = { name: echec.name, message: echec.message.slice(0, 300) };
  } finally {
    clearInterval(sonde);
    session.stop();
    await backend.close();
  }
  return {
    ticks,
    battements,
    bootMs,
    erreur,
    dureeTotaleMs: Math.round(performance.now() - debut),
  };
}

async function mesurer({ cale = null, bootTimeoutMs = 45000, volumeBytes = 16 * MIO } = {}) {
  const { releve, descripteur } = await relevePrealable({ cale, bootTimeoutMs });
  const { session, journal, backend } = await ouvrirSession(volumeBytes);
  const boot = await mesurerBoot({ session, backend, bootTimeoutMs });

  return {
    ...releve,
    // `ticks` est le fait décisif : figé à `0`/`null`, la boucle n'a jamais battu ; positif, elle
    // bat et un non-démarrage a une autre cause.
    ...boot,
    invite: boot.bootMs !== null,
    // Relevé de la boucle APRÈS le boot : son compteur de tâches dit si v86 l'a réellement
    // empruntée, et `minuteries` dit si le chemin `setTimeout` — celui que le plafond de quatre
    // millisecondes menace — a été emprunté, et jusqu'à quelle imbrication (#87).
    boucleOrdonnancement: decrireBoucle(descripteur),
    counts: journal.counts(),
    transcriptFin: session.transcript().slice(-400),
    incidents,
  };
}

self.addEventListener("message", (evenement) => {
  const { id, type, payload } = evenement.data ?? {};
  if (type !== "mesurer") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  mesurer(payload ?? {}).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) =>
      self.postMessage({
        id,
        ok: false,
        error: { name: error.name, message: error.message, incidents },
      }),
  );
});
