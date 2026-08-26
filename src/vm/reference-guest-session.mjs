// Session de guest de l'IMAGE DE RÉFÉRENCE (#5) pilotée par le pont série HTTP `@VLT1`.
//
// C'est la pièce que la reprise (#7) ajoute aux acquis : le harnais Node du boot de référence
// (`tools/vm/boot-reference.mjs`) sert des disques URL en LECTURE et n'installe aucun pont de
// durabilité ; le Worker de la barrière (#14) installe le pont mais boote un guest minimal sur
// `linux4.iso`. Ici les deux se rejoignent : le noyau, l'initrd et le rootfs sont fournis en
// tampons, le DISQUE APPLICATIF (hdb, `/dev/sdb`) est adossé au backend OPFS en écriture par
// l'adaptateur de v86, et le pont de durabilité propage jusqu'à OPFS les barrières `fsync` que
// SQLite et ActiveStorage émettent. Une écriture de Rails atterrit ainsi réellement dans OPFS.
//
// La classe `V86`, les tampons et l'adaptateur sont INJECTÉS : ce module ne sait ni télécharger ni
// ouvrir de handle, ce qui le garde vérifiable sans réseau ni support.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { createSerialHttpClient } from "./serial-http-client.mjs";
import { BRIDGE_MODES, installDurabilityBridge } from "./v86-flush-bridge.mjs";

const POLL_INTERVAL_MS = 20;
const DEFAULT_IDE_TIMEOUT_MS = 60_000;

/** Erreur de démarrage portant le journal série pour diagnostic — jamais un échec muet. */
export class BootTimeout extends Error {
  constructor(message, transcript) {
    super(message);
    this.name = "BootTimeout";
    this.transcript = transcript;
  }
}

const asArrayBuffer = (source) =>
  source instanceof ArrayBuffer
    ? source
    : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);

/**
 * @param {{
 *   V86: Function,
 *   artifacts: { wasm: BufferSource, bios: BufferSource, vgaBios: BufferSource,
 *                kernel: BufferSource, initrd: BufferSource, rootfs: BufferSource },
 *   appAdapter: object,
 *   journal: import("./block-journal.mjs").BlockJournal,
 *   cmdline: string,
 *   memoryBytes?: number,
 *   mode?: string,
 *   onJournal?: (ligne: string) => void,
 *   onSerial?: (fragment: string) => void,
 * }} options
 */
export function createReferenceGuestSession({
  V86,
  artifacts,
  appAdapter,
  journal,
  cmdline,
  memoryBytes = 512 * 1024 * 1024,
  mode = BRIDGE_MODES.full,
  onJournal = () => {},
  onSerial = () => {},
}) {
  if (typeof V86 !== "function")
    throw new TypeError("createReferenceGuestSession exige la classe V86.");
  if (!appAdapter)
    throw new TypeError("createReferenceGuestSession exige un adaptateur applicatif.");
  if (typeof cmdline !== "string" || cmdline.length === 0) {
    throw new TypeError("createReferenceGuestSession exige une ligne de commande noyau.");
  }

  let emulator = null;
  let bridge = null;
  let transcript = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const client = createSerialHttpClient({
    send: (ligne) => emulator.serial0_send(ligne),
    onLog: (texte) => onJournal(texte),
  });

  const wait = (predicate, timeout, description) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new BootTimeout(`Délai dépassé : ${description}`, transcript.slice(-4000)));
        }
      }, POLL_INTERVAL_MS);
    });

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    /**
     * Démarre la VM. Le pont de durabilité est posé AVANT `run()` : le noyau lit le paquet IDENTIFY
     * une seule fois au démarrage, et un pont posé après coup n'obtiendrait aucune barrière.
     */
    async boot({ ideTimeoutMs = DEFAULT_IDE_TIMEOUT_MS } = {}) {
      const wasm = asArrayBuffer(artifacts.wasm);
      emulator = new V86({
        wasm_fn: async (env) => (await WebAssembly.instantiate(wasm, env)).instance.exports,
        bios: { buffer: asArrayBuffer(artifacts.bios) },
        vga_bios: { buffer: asArrayBuffer(artifacts.vgaBios) },
        bzimage: { buffer: asArrayBuffer(artifacts.kernel) },
        initrd: { buffer: asArrayBuffer(artifacts.initrd) },
        cmdline,
        // hda = rootfs en lecture/écriture éphémère (les écritures du guest y restent en RAM) ;
        // hdb = disque applicatif adossé à OPFS, où atterrissent SQLite et la pièce jointe.
        hda: { buffer: asArrayBuffer(artifacts.rootfs) },
        hdb: appAdapter,
        memory_size: memoryBytes,
        vga_memory_size: 2 * 1024 * 1024,
        autostart: false,
        disable_speaker: true,
        disable_keyboard: true,
        disable_mouse: true,
      });

      emulator.add_listener("serial0-output-byte", (byte) => {
        const fragment = decoder.decode(new Uint8Array([byte]), { stream: true });
        transcript += fragment;
        // `onSerial` reçoit le flux série BRUT (BIOS, noyau, init) tel qu'il sort du guest, avant
        // le pont `@VLT1`. C'est ce que `onJournal` ne peut pas donner : `onJournal` ne voit que
        // les lignes applicatives relayées par le pont, une fois celui-ci démarré. Le banc de
        // reprise s'en sert pour horodater les jalons de boot (montage /dev/sdb, lancement de Puma,
        // pont série actif) et décomposer le temps de reprise. Aucun effet sur le démarrage.
        onSerial(fragment);
        client.ingest(fragment);
      });

      await wait(
        () => Boolean(emulator.v86?.cpu?.devices?.ide),
        ideTimeoutMs,
        "initialisation du contrôleur IDE",
      );

      bridge = installDurabilityBridge({
        ideController: emulator.v86.cpu.devices.ide,
        adapter: appAdapter,
        journal,
        mode,
      });

      journal.record(JOURNAL_OPERATIONS.mark, { label: "boot-start" });
      emulator.run();
    },

    /**
     * Attend que Rails réponde à `/vault/health`. La VM est « prête » quand l'application répond,
     * pas quand le noyau a démarré. Rend la durée mesurée jusqu'à la première réponse 200.
     *
     * @param {{ totalTimeoutMs: number, probeTimeoutMs?: number, intervalMs?: number }} reglages
     * @returns {Promise<{ durationMs: number, sante: Record<string, any> }>}
     */
    async awaitHealth({ totalTimeoutMs, probeTimeoutMs = 5_000, intervalMs = 2_000 }) {
      const started = Date.now();
      let derniereErreur = null;
      while (Date.now() - started < totalTimeoutMs) {
        try {
          const reponse = await client.request("GET", "/vault/health", {
            timeoutMs: probeTimeoutMs,
          });
          if (reponse.statut === 200) {
            const durationMs = Date.now() - started;
            journal.record(JOURNAL_OPERATIONS.mark, {
              label: "health-ready",
              milliseconds: durationMs,
            });
            return { durationMs, sante: JSON.parse(new TextDecoder().decode(reponse.corps)) };
          }
          derniereErreur = new Error(`/vault/health a répondu ${reponse.statut}`);
        } catch (erreur) {
          derniereErreur = erreur instanceof Error ? erreur : new Error(String(erreur));
        }
        await pause(intervalMs);
      }
      throw new BootTimeout(
        `Rails n'a pas répondu à /vault/health en ${Math.round(totalTimeoutMs / 1000)} s ; ` +
          `dernière erreur : ${derniereErreur?.message ?? "aucune"}`,
        transcript.slice(-4000),
      );
    },

    /** Émet une requête HTTP vers Rails par le pont série. */
    request(methode, chemin, reglages = {}) {
      return client.request(methode, chemin, reglages);
    },

    /** Arrête la VM et RETIRE le pont : le prototype de v86 est un état global partagé. */
    stop() {
      if (emulator) emulator.stop();
      if (bridge) bridge.uninstall();
      bridge = null;
    },

    transcript() {
      return transcript;
    },

    /**
     * Compteur de tours de la boucle d'ordonnancement de v86, ou `null` tant que l'émulateur n'a pas
     * été construit ou si le nom n'est plus celui-là après une montée de version. Même contrat et
     * même raison d'être que dans `guest-session.mjs` : distinguer un guest LENT d'un émulateur qui
     * NE BAT PAS (#52).
     */
    ticks() {
      const compteur = emulator?.v86?.tick_counter;
      return typeof compteur === "number" ? compteur : null;
    },
  };
}
