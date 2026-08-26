// Session de guest v86 pilotée par la console série. Le même module sert au harnais Node du spike
// et au Worker de la preuve navigateur : les sémantiques mesurées doivent être celles du code
// livré, pas celles d'un banc d'essai parallèle.
//
// La classe `V86` et les artefacts binaires sont INJECTÉS : ce module ne sait ni télécharger ni
// lire un fichier, ce qui le garde vérifiable sans réseau ni système de fichiers.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import {
  GUEST_PROMPT,
  buildCommandFrame,
  endToken,
  reassembleCommandOutput,
} from "./serial-console.mjs";
import { BRIDGE_MODES, installDurabilityBridge } from "./v86-flush-bridge.mjs";

export { GUEST_PROMPT };

const POLL_INTERVAL_MS = 20;
const DEFAULT_BOOT_TIMEOUT_MS = 240000;
const DEFAULT_COMMAND_TIMEOUT_MS = 180000;

class GuestTimeout extends Error {
  constructor(message, transcript) {
    super(message);
    this.name = "GuestTimeout";
    this.transcript = transcript;
  }
}

/**
 * @param {{ V86: Function, artifacts: { wasm: BufferSource, bios: BufferSource,
 *           vgaBios: BufferSource, cdrom: BufferSource },
 *           adapter: object, journal: import("./block-journal.mjs").BlockJournal,
 *           mode?: string, memorySize?: number }} options
 *   `mode` est une valeur de `BRIDGE_MODES` : `observe` reproduit le comportement amont,
 *   `identify` n'annonce que le cache d'écriture, `full` propage la barrière.
 */
export function createGuestSession({
  V86,
  artifacts,
  adapter,
  journal,
  mode = BRIDGE_MODES.full,
  memorySize = 128 * 1024 * 1024,
}) {
  let transcript = "";
  let emulator = null;
  let installed = null;
  let sequence = 0;

  const asArrayBuffer = (source) =>
    source instanceof ArrayBuffer
      ? source
      : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);

  const wait = (predicate, timeout, description) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new GuestTimeout(`Délai dépassé : ${description}`, transcript.slice(-4000)));
        }
      }, POLL_INTERVAL_MS);
    });

  return {
    /** Démarre la VM et rend la durée du premier boot, en millisecondes. */
    async boot({ timeout = DEFAULT_BOOT_TIMEOUT_MS } = {}) {
      const wasm = asArrayBuffer(artifacts.wasm);
      emulator = new V86({
        wasm_fn: async (env) => (await WebAssembly.instantiate(wasm, env)).instance.exports,
        bios: { buffer: asArrayBuffer(artifacts.bios) },
        vga_bios: { buffer: asArrayBuffer(artifacts.vgaBios) },
        cdrom: { buffer: asArrayBuffer(artifacts.cdrom) },
        hda: adapter,
        memory_size: memorySize,
        vga_memory_size: 2 * 1024 * 1024,
        autostart: false,
        // Le runtime vit dans un Worker dédié (ADR 0002) : aucun adaptateur d'entrée ni de son ne
        // doit chercher un `document`.
        disable_speaker: true,
        disable_keyboard: true,
        disable_mouse: true,
      });

      emulator.add_listener("serial0-output-byte", (byte) => {
        transcript += String.fromCharCode(byte);
      });

      await wait(
        () => Boolean(emulator.v86?.cpu?.devices?.ide),
        timeout,
        "initialisation du contrôleur IDE",
      );

      installed = installDurabilityBridge({
        ideController: emulator.v86.cpu.devices.ide,
        adapter,
        journal,
        mode,
      });

      const started = performance.now();
      journal.record(JOURNAL_OPERATIONS.mark, { label: "boot-start" });
      emulator.run();
      await wait(() => transcript.includes(GUEST_PROMPT), timeout, "invite du guest");
      const elapsed = performance.now() - started;
      journal.record(JOURNAL_OPERATIONS.mark, { label: "boot-ready", milliseconds: elapsed });
      return elapsed;
    },

    /**
     * Exécute une commande shell et rend sa sortie.
     *
     * La commande émise et le réassemblage de la sortie vivent dans `serial-console.mjs`, module
     * pur : la logique fragile — celle que le repli du terminal du guest à 80 colonnes met en
     * défaut — est ainsi vérifiable sans démarrer de VM.
     */
    async shell(command, { timeout = DEFAULT_COMMAND_TIMEOUT_MS, label = command } = {}) {
      sequence += 1;
      const token = endToken(sequence);
      const from = journal.length;
      journal.record(JOURNAL_OPERATIONS.mark, { label: `shell:${label}` });
      transcript = "";
      emulator.serial0_send(buildCommandFrame(command, sequence));
      await wait(() => transcript.includes(token), timeout, `commande « ${label} »`);
      const output = reassembleCommandOutput(transcript, sequence);
      return { label, command, output, from, to: journal.length };
    },

    /** Arrête la VM et retire le pont : le prototype de v86 est un état global. */
    stop() {
      if (emulator) emulator.stop();
      if (installed) installed.uninstall();
      installed = null;
    },

    transcript() {
      return transcript;
    },

    /**
     * Compteur de tours de la boucle d'ordonnancement de v86, ou `null` tant que l'émulateur n'a
     * pas été construit. Il sert à distinguer deux pannes que rien d'autre ne sépare (#52) : un
     * guest LENT, dont le compteur avance, et un émulateur qui ne BAT PAS, dont le compteur reste
     * figé parce que v86 n'a aucune boucle disponible — `scheduler.postTask` absent et Worker
     * imbriqué « blob: » refusé par la CSP de la coquille.
     *
     * `tick_counter` est un nom conservé par la compilation Closure `SIMPLE` des artefacts publiés,
     * comme les trois noms dont dépend déjà le pont de durabilité (ADR 0003). Une montée de version
     * qui le renommerait rendrait `null` au lieu d'un nombre : le chien de garde du Worker runtime
     * traite ce cas explicitement plutôt que de conclure à l'arrêt.
     */
    ticks() {
      const compteur = emulator?.v86?.tick_counter;
      return typeof compteur === "number" ? compteur : null;
    },
  };
}
