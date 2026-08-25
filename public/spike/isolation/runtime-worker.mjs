// Worker runtime du spike #41 : v86 et son backend de blocs vivent ici, conformément à l'ADR 0002.
// Il ne mesure qu'une chose — le COÛT de l'isolation multi-origine sur le runtime — et il le mesure
// en ne faisant varier que l'en-tête servi par le serveur. Le code exécuté est identique dans les
// deux conditions, artefacts v86 compris.
//
// Le backend est en MÉMOIRE et non sur OPFS, délibérément : un backend OPFS ferait entrer dans la
// mesure la latence du système de fichiers de l'hôte, qui n'a rien à voir avec l'isolation et dont
// la variance masquerait l'écart cherché. La limite est déclarée dans le compte rendu du spike.

import { mesurerMemoireDetaillee } from "/src/spike/mesure-memoire.mjs";
import { BlockJournal } from "/src/vm/block-journal.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import { createGuestSession } from "/src/vm/guest-session.mjs";
import { openMemoryVolume } from "/src/vm/memory-block-backend.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { BRIDGE_MODES } from "/src/vm/v86-flush-bridge.mjs";

const ARTIFACTS = "/vendor/v86/artefacts/";
const MIO = 1024 * 1024;

/**
 * Étapes chronométrées. Chacune vise UNE ressource, pour qu'un écart soit attribuable :
 *
 * - `ecriture-disque` et `lecture-disque` traversent l'adaptateur v86 et le backend, donc le
 *   chemin JavaScript que l'isolation pourrait ralentir ;
 * - `purge-caches` n'est pas mesurée : sans elle, la lecture serait servie par le cache de pages du
 *   noyau invité et ne toucherait jamais le backend ;
 * - `cpu-copie-memoire` ne touche pas le disque : elle mesure le débit d'émulation pure ;
 * - `cpu-md5` est du calcul entier, là où la copie mémoire est de la bande passante. Les deux sont
 *   nécessaires : un moteur peut régresser sur l'une sans bouger sur l'autre.
 */
const ETAPES = Object.freeze([
  {
    label: "ecriture-disque",
    octets: 4 * MIO,
    command: "dd if=/dev/zero of=/dev/sda bs=65536 count=64 conv=fsync 2>&1",
  },
  {
    label: "purge-caches",
    octets: 0,
    command: "sync; echo 3 > /proc/sys/vm/drop_caches; echo rc=$?",
  },
  {
    label: "lecture-disque",
    octets: 4 * MIO,
    command: "dd if=/dev/sda of=/dev/null bs=65536 count=64 2>&1",
  },
  {
    label: "cpu-copie-memoire",
    octets: 32 * MIO,
    command: "dd if=/dev/zero of=/dev/null bs=1048576 count=32 2>&1",
  },
  {
    label: "cpu-md5",
    octets: 8 * MIO,
    command: "dd if=/dev/zero bs=65536 count=128 2>/dev/null | md5sum",
  },
]);

let compteurVolume = 0;

/** Isolation telle que la voit CE Worker : elle ne se déduit pas de celle du document. */
function mesurerIsolation() {
  return {
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    sharedArrayBuffer: mesurerSharedArrayBuffer(),
    secureContext: Boolean(globalThis.isSecureContext),
    schedulerPostTask: typeof globalThis.scheduler?.postTask === "function",
    urlContexte: location.href,
  };
}

function mesurerSharedArrayBuffer() {
  if (typeof SharedArrayBuffer !== "function") return "constructeur-absent";
  try {
    const tampon = new SharedArrayBuffer(8);
    return tampon.byteLength === 8 ? "alloue" : "alloue-taille-inattendue";
  } catch (erreur) {
    return `refuse:${erreur.name}`;
  }
}

/**
 * v86 choisit sa boucle d'ordonnancement à l'initialisation : `scheduler.postTask` si son URL
 * contient `use-scheduling-api`, sinon un Worker imbriqué chargé depuis une URL `blob:` que la CSP
 * de la coquille refuse — l'émulateur ne bat alors jamais, SANS erreur visible. La condition est
 * donc vérifiée avant le démarrage, et son absence est une raison typée, jamais un repli muet.
 */
function raisonDeNonMesurabilite() {
  if (!location.href.includes("use-scheduling-api")) {
    return "Le Worker runtime doit être chargé avec « ?use-scheduling-api » : sinon v86 tente un Worker imbriqué « blob: » que la CSP refuse.";
  }
  if (typeof globalThis.scheduler?.postTask !== "function") {
    return "scheduler.postTask est absent de ce moteur : sous la CSP de la coquille (worker-src 'self'), v86 n'a aucune boucle d'ordonnancement disponible. Voir l'ADR 0003 et docs/compatibility.md.";
  }
  return null;
}

async function lireArtefact(nom) {
  const reponse = await fetch(`${ARTIFACTS}${nom}`, { cache: "no-store" });
  if (!reponse.ok) {
    throw new Error(
      `Artefact ${nom} indisponible (${reponse.status}). Exécuter « npm run vm:fetch ».`,
    );
  }
  return new Uint8Array(await reponse.arrayBuffer());
}

async function chargerArtefacts() {
  const debut = performance.now();
  const [wasm, bios, vgaBios, cdrom] = await Promise.all([
    lireArtefact("v86.wasm"),
    lireArtefact("seabios.bin"),
    lireArtefact("vgabios.bin"),
    lireArtefact("linux4.iso"),
  ]);
  return {
    artifacts: { wasm, bios, vgaBios, cdrom },
    octetsTransferes: wasm.byteLength + bios.byteLength + vgaBios.byteLength + cdrom.byteLength,
    // Le chargement des artefacts est chronométré à part : sous `require-corp` chaque réponse doit
    // porter une politique de ressource, et un surcoût réseau ne doit pas être imputé au boot.
    chargementMs: Number((performance.now() - debut).toFixed(1)),
  };
}

/**
 * Pouls du Worker. Il n'a l'air de rien et il tranche une ambiguïté réelle : quand aucun compte
 * rendu n'arrive, « le guest ne démarre pas » et « le thread du Worker ne rend plus la main » sont
 * deux diagnostics différents, et un seul se corrige. Le pouls bat depuis l'instant où le boot
 * commence, la page compte les battements reçus. Zéro battement désigne un thread monopolisé, pas
 * un guest lent.
 */
const PERIODE_POULS_MS = 250;

/** Identifiant de la demande en cours : le pouls doit s'attacher à elle, pas à une autre. */
let idCourant = null;

/** Débit en Mio/s, ou `null` quand l'étape ne transporte pas d'octets. */
function debit(octets, millisecondes) {
  if (octets === 0 || millisecondes <= 0) return null;
  return Number((octets / MIO / (millisecondes / 1000)).toFixed(3));
}

async function mesurer({ volumeBytes = 16 * MIO, mode = BRIDGE_MODES.full } = {}) {
  const raison = raisonDeNonMesurabilite();
  if (raison) {
    const erreur = new Error(raison);
    erreur.code = "VAULT_ISOLATION_NON_MESURABLE";
    erreur.isolation = mesurerIsolation();
    throw erreur;
  }

  const { V86 } = await import(`${ARTIFACTS}libv86.mjs`);
  const { artifacts, octetsTransferes, chargementMs } = await chargerArtefacts();

  compteurVolume += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `isolation-${compteurVolume}`,
    size: volumeBytes,
    journal,
    faults: createFaultPlan(),
    flushDelay: 0,
  });
  const echecs = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (erreur) => echecs.push(erreur.toJSON()),
  });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });

  let battements = 0;
  const pouls = setInterval(() => {
    battements += 1;
    self.postMessage({ id: idCourant, type: "battement", battements });
  }, PERIODE_POULS_MS);

  try {
    const bootMs = await session.boot();
    const etapes = [];
    for (const etape of ETAPES) {
      const debut = performance.now();
      const resultat = await session.shell(etape.command, { label: etape.label });
      const millisecondes = performance.now() - debut;
      etapes.push({
        label: etape.label,
        octets: etape.octets,
        millisecondes: Number(millisecondes.toFixed(1)),
        mioParSeconde: debit(etape.octets, millisecondes),
        mesuree: etape.octets > 0,
        sortie: resultat.output.trim(),
      });
    }
    return {
      isolation: mesurerIsolation(),
      mode,
      volumeBytes,
      octetsTransferes,
      chargementMs,
      bootMs: Number(bootMs.toFixed(1)),
      etapes,
      // Les compteurs du journal sont le témoin d'égalité du travail : si les deux conditions ne
      // font pas le MÊME nombre de lectures, d'écritures et de barrières, comparer leurs durées
      // n'a aucun sens.
      counts: journal.counts(),
      battements,
      memoireDetaillee: await mesurerMemoireDetaillee(),
      echecs,
    };
  } finally {
    clearInterval(pouls);
    session.stop();
    await backend.close();
  }
}

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type === "capacites") {
    self.postMessage({
      id,
      ok: true,
      report: { isolation: mesurerIsolation(), raisonNonMesurable: raisonDeNonMesurabilite() },
    });
    return;
  }
  if (type !== "mesurer") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  idCourant = id;
  mesurer(payload ?? {}).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) =>
      self.postMessage({
        id,
        ok: false,
        error: {
          name: error.name,
          code: error.code ?? null,
          message: error.message,
          isolation: error.isolation ?? null,
        },
      }),
  );
});
