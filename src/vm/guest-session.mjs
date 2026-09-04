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
import { cadencer } from "./scheduling-loop.mjs";
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
 * Attente CADENCÉE, et non « scrutée par une minuterie ». La différence porte : sous un moteur qui
 * affame ses minuteries pendant que la boucle d'ordonnancement tourne (WebKit, mesuré le
 * 2026-08-26), un `setInterval` ne s'exécuterait pas pendant la plage même que cette attente
 * borne — et un guest qui n'aboutit pas resterait suspendu sans jamais rendre de `GuestTimeout`.
 * `cadencer` avance depuis la minuterie ET depuis les battements de la boucle.
 *
 * Cousue hors de la fabrique (#93). Le journal série est donc lu par `lireTranscript`, et non
 * capturé : `shell` le REMET À ZÉRO avant chaque commande et il grandit ensuite pendant l'attente.
 * C'est son état à l'instant du rejet qui doit accompagner l'erreur, pas celui de la construction.
 */
function creerAttenteCadencee({ cadence, lireTranscript }) {
  return (predicate, timeout, description) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      let fini = false;
      let arreter = () => {};
      const verifier = () => {
        if (fini) return;
        if (predicate()) {
          fini = true;
          arreter();
          resolve();
        } else if (Date.now() - started > timeout) {
          fini = true;
          arreter();
          reject(new GuestTimeout(`Délai dépassé : ${description}`, lireTranscript().slice(-4000)));
        }
      };
      arreter = cadence(verifier);
      if (fini) arreter();
    });
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
  boucle = null,
  cadence = (rappel) => cadencer(rappel, { periodeMs: POLL_INTERVAL_MS, boucle }),
}) {
  let transcript = "";
  let emulator = null;
  let installed = null;
  let sequence = 0;

  const asArrayBuffer = (source) =>
    source instanceof ArrayBuffer
      ? source
      : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);

  const wait = creerAttenteCadencee({ cadence, lireTranscript: () => transcript });

  return {
    /**
     * Démarre la VM et rend la durée du premier boot, en millisecondes.
     *
     * `etatARestaurer` fait de ce démarrage une REPRISE (#65, ADR 0024) : l'état v86 est rendu à
     * l'émulateur APRÈS la pose du pont de durabilité et AVANT `run()`, et l'invite du guest n'est
     * pas attendue. Chacun de ces trois points a sa raison :
     *
     *  - APRÈS le pont, parce que `restore_state` rend au guest un paquet IDENTIFY déjà lu : le
     *    guest capturé savait son disque en « write back », et un pont posé ensuite n'aurait plus
     *    d'IDENTIFY à corriger ;
     *  - AVANT `run()`, parce qu'un guest lancé à froid puis écrasé par une restauration aurait
     *    battu pour rien ;
     *  - sans attendre l'invite, parce qu'elle a été imprimée AVANT la capture. Le transcrit
     *    repart vide à la reprise, et l'attendre ferait expirer un boot parfaitement sain.
     *
     * C'est `set_state` de l'adaptateur qui confronte alors la liaison au volume réellement ouvert,
     * avant que la moindre instruction n'ait été exécutée.
     */
    async boot({ timeout = DEFAULT_BOOT_TIMEOUT_MS, etatARestaurer = null } = {}) {
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
      if (etatARestaurer !== null) {
        await emulator.restore_state(etatARestaurer.buffer ?? etatARestaurer);
        journal.record(JOURNAL_OPERATIONS.mark, { label: "instantane-restaure" });
      }
      emulator.run();
      if (etatARestaurer === null) {
        await wait(() => transcript.includes(GUEST_PROMPT), timeout, "invite du guest");
      }
      const elapsed = performance.now() - started;
      journal.record(JOURNAL_OPERATIONS.mark, { label: "boot-ready", milliseconds: elapsed });
      return elapsed;
    },

    /**
     * SUSPEND le guest sans rien sérialiser : la quiescence de l'ADR 0024 obtenue par l'arrêt.
     *
     * Le pont N'EST PAS retiré, contrairement à `stop()` : une capture refusée doit pouvoir rendre
     * le service au guest, et un pont déposé ne se repose pas sur le même prototype.
     */
    suspendre() {
      if (emulator) emulator.stop();
    },

    /**
     * CAPTURE l'état v86. L'émulateur est ARRÊTÉ d'abord : capturer une machine qui bat donnerait un
     * état que rien ne décrit.
     */
    async capturer() {
      emulator.stop();
      return new Uint8Array(await emulator.save_state());
    },

    /**
     * Cette session monte l'unique disque du guest sur l'adaptateur : elle n'a pas de rootfs à part,
     * donc pas de delta à publier. Le membre existe pour que la conduite de capture — écrite pour la
     * session de référence — n'ait pas à savoir à laquelle des deux elle parle.
     */
    deltaRootfsOctets() {
      return null;
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
