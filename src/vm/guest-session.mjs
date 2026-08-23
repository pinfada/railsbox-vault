// Session de guest v86 pilotée par la console série. Le même module sert au harnais Node du spike
// et au Worker de la preuve navigateur : les sémantiques mesurées doivent être celles du code
// livré, pas celles d'un banc d'essai parallèle.
//
// La classe `V86` et les artefacts binaires sont INJECTÉS : ce module ne sait ni télécharger ni
// lire un fichier, ce qui le garde vérifiable sans réseau ni système de fichiers.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { installDurabilityBridge } from "./v86-flush-bridge.mjs";

/** Invite du shell BusyBox de l'image `linux4.iso`. */
export const GUEST_PROMPT = "~%";

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
 *           durability?: boolean, memorySize?: number }} options
 *   `durability: false` laisse v86 dans son comportement amont : les commandes ATA sont
 *   journalisées, aucune barrière n'est propagée.
 */
export function createGuestSession({
  V86,
  artifacts,
  adapter,
  journal,
  durability = true,
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
        durability,
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
     * Le jeton de fin est écrit `R""B<n>` dans la commande envoyée : l'écho du terminal montre les
     * guillemets, la sortie non. Attendre le jeton évite donc de confondre l'écho de la commande
     * avec son résultat — piège qui fausse silencieusement toute mesure pilotée par console série.
     */
    async shell(command, { timeout = DEFAULT_COMMAND_TIMEOUT_MS, label = command } = {}) {
      sequence += 1;
      const token = `RB${sequence}`;
      const from = journal.length;
      journal.record(JOURNAL_OPERATIONS.mark, { label: `shell:${label}` });
      transcript = "";
      emulator.serial0_send(`${command}; echo R""B${sequence}\n`);
      await wait(() => transcript.includes(token), timeout, `commande « ${label} »`);
      // Le résultat est ce qui sépare la FIN de l'écho de la commande du jeton. L'écho peut occuper
      // plusieurs lignes — le terminal replie à 80 colonnes — donc on le borne par la marque
      // `R""B`, présente dans l'écho et absente de la sortie.
      const lines = transcript.split("\n").map((line) => line.replace(/\r$/, ""));
      const start = lines.findIndex((line) => line.includes('R""B')) + 1;
      const end = lines.findIndex((line, index) => index >= start && line.includes(token));
      const output = lines
        .slice(start, end < 0 ? undefined : end)
        .filter((line) => !line.startsWith(GUEST_PROMPT))
        .join("\n")
        .trim();
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
  };
}
