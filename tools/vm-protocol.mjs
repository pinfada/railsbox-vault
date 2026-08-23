#!/usr/bin/env node
// Protocole de mesure du spike #4, sous Node. Il exécute le MÊME code que la preuve navigateur
// (`src/vm/*`) et produit `reports/vm/protocole.json` : sémantiques observées, comparaison amont /
// pont de durabilité, injection de fautes, temps de premier boot.
//
//   node tools/vm-protocol.mjs                 protocole complet
//   node tools/vm-protocol.mjs --boots 5       nombre d'essais de boot mesurés
//   node tools/vm-protocol.mjs --skip-boots    sémantiques et fautes seulement

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { BlockJournal, JOURNAL_OPERATIONS } from "../src/vm/block-journal.mjs";
import { FAULT_KINDS, createFaultPlan } from "../src/vm/fault-plan.mjs";
import { FILESYSTEM_STEPS, runSteps, summariseSteps } from "../src/vm/guest-scenarios.mjs";
import { createGuestSession } from "../src/vm/guest-session.mjs";
import { openMemoryVolume } from "../src/vm/memory-block-backend.mjs";
import { createV86BufferAdapter } from "../src/vm/v86-buffer-adapter.mjs";
import { BRIDGE_MODES } from "../src/vm/v86-flush-bridge.mjs";
import { ARTIFACT_DIRECTORY, MANIFEST_PATH, REPOSITORY_ROOT } from "./v86-paths.mjs";

const REPORT_PATH = join(REPOSITORY_ROOT, "reports", "vm", "protocole.json");
const VOLUME_BYTES = 16 * 1024 * 1024;
const FLUSH_DELAY_MS = 5;

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Option --${name} invalide.`);
  return value;
}

async function loadArtifacts() {
  const read = async (name) => new Uint8Array(await readFile(join(ARTIFACT_DIRECTORY, name)));
  return {
    wasm: await read("v86.wasm"),
    bios: await read("seabios.bin"),
    vgaBios: await read("vgabios.bin"),
    cdrom: await read("linux4.iso"),
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(1));
}

let volumeCounter = 0;

async function withSession({ V86, artifacts, mode, faults }, body) {
  volumeCounter += 1;
  const journal = new BlockJournal();
  const backend = openMemoryVolume({
    name: `protocole-${volumeCounter}`,
    size: VOLUME_BYTES,
    journal,
    faults: faults ?? createFaultPlan(),
    flushDelay: FLUSH_DELAY_MS,
  });
  const failures = [];
  const adapter = createV86BufferAdapter({ backend, onFatal: (error) => failures.push(error) });
  const session = createGuestSession({ V86, artifacts, adapter, journal, mode });
  try {
    return await body({ session, journal, backend, adapter, failures });
  } finally {
    session.stop();
    await backend.close();
  }
}

async function measureSemantics({ V86, artifacts, mode }) {
  return withSession({ V86, artifacts, mode }, async ({ session, journal }) => {
    const bootMilliseconds = await session.boot();
    const results = await runSteps(session, FILESYSTEM_STEPS);
    return {
      mode,
      bootMilliseconds: Number(bootMilliseconds.toFixed(1)),
      counts: journal.counts(),
      steps: summariseSteps(journal, results),
    };
  });
}

async function measureBoots({ V86, artifacts }, attempts) {
  const durations = [];
  for (let attempt = 0; attempt < attempts + 1; attempt += 1) {
    const elapsed = await withSession({ V86, artifacts, mode: BRIDGE_MODES.full }, ({ session }) =>
      session.boot(),
    );
    // Le premier essai échauffe le compilateur JIT du moteur : il est mesuré puis écarté.
    if (attempt > 0) durations.push(elapsed);
    process.stdout.write(`  boot ${attempt}/${attempts} : ${elapsed.toFixed(0)} ms\n`);
  }
  return {
    attempts,
    durationsMilliseconds: durations.map((value) => Number(value.toFixed(1))),
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    peakResidentBytes: process.memoryUsage().rss,
  };
}

// Le démarrage consomme exactement TROIS lectures du disque Vault (secteur d'amorçage puis examen
// des partitions) et AUCUNE écriture : les rangs ci-dessous visent donc la première opération
// demandée par la commande du guest. Le rapport signale toute faute programmée non atteinte.
const BOOT_READS = 3;

const FAULT_COMMANDS = {
  // `skip=1024` lit à 4 Mio du début : une zone qu'aucune lecture d'amorçage n'a mise en cache,
  // donc une vraie lecture du support. Le `dd` de BusyBox ne connaît pas `iflag=direct`.
  read: "dd if=/dev/sda of=/dev/null bs=4096 count=8 skip=1024 2>&1; echo rc=$?",
  write: "dd if=/dev/urandom of=/dev/sda bs=4096 count=4 conv=fsync 2>&1; echo rc=$?",
};

const FAULT_CASES = [
  {
    label: "lecture-courte",
    faults: [{ kind: FAULT_KINDS.shortRead, operation: "read", occurrence: BOOT_READS + 1 }],
    command: FAULT_COMMANDS.read,
  },
  {
    label: "ecriture-partielle",
    faults: [{ kind: FAULT_KINDS.partialWrite, operation: "write", occurrence: 1 }],
    command: FAULT_COMMANDS.write,
  },
  {
    label: "ecriture-partielle-persistante",
    faults: [1, 2, 3, 4, 5, 6].map((occurrence) => ({
      kind: FAULT_KINDS.partialWrite,
      operation: "write",
      occurrence,
    })),
    command: FAULT_COMMANDS.write,
  },
  {
    label: "echec-de-flush",
    faults: [{ kind: FAULT_KINDS.flushFailure, operation: "flush", occurrence: 1 }],
    command: FAULT_COMMANDS.write,
  },
  {
    label: "echec-de-flush-persistant",
    faults: [1, 2, 3, 4, 5, 6].map((occurrence) => ({
      kind: FAULT_KINDS.flushFailure,
      operation: "flush",
      occurrence,
    })),
    command: FAULT_COMMANDS.write,
  },
  {
    label: "handle-perdu",
    faults: [{ kind: FAULT_KINDS.lostHandle, operation: "write", occurrence: 1 }],
    command: FAULT_COMMANDS.write,
  },
];

async function measureFaults({ V86, artifacts }) {
  const observations = [];
  for (const testCase of FAULT_CASES) {
    process.stdout.write(`  faute : ${testCase.label}\n`);
    const observation = await withSession(
      { V86, artifacts, mode: BRIDGE_MODES.full, faults: createFaultPlan(testCase.faults) },
      async ({ session, journal, failures, backend }) => {
        await session.boot();
        let guest;
        const started = performance.now();
        try {
          guest = await session.shell(testCase.command, { label: testCase.label, timeout: 120000 });
          // Le journal du noyau dit ce que le guest a réellement vu du support.
          const kernel = await session.shell("dmesg | tail -6", { label: "dmesg", timeout: 60000 });
          guest.kernel = kernel.output;
        } catch (error) {
          guest = { output: `[${error.name}] ${error.message}`, timedOut: true, kernel: "" };
        }
        const elapsed = performance.now() - started;
        return {
          label: testCase.label,
          guestOutput: guest.output,
          guestKernelLog: guest.kernel ?? "",
          guestElapsedMilliseconds: Number(elapsed.toFixed(0)),
          guestTimedOut: Boolean(guest.timedOut),
          runtimeErrors: failures.map((error) => error.toJSON()),
          faultsFired: backend.faults.fired(),
          faultsMissed: backend.faults.unfired(),
          journalTail: journal
            .entries()
            .slice(-8)
            .map((entry) => ({ ...entry })),
        };
      },
    );
    observations.push(observation);
  }
  return observations;
}

async function main() {
  const attempts = readOption("boots", 5);
  const skipBoots = process.argv.includes("--skip-boots");

  const { V86 } = await import(pathToFileURL(join(ARTIFACT_DIRECTORY, "libv86.mjs")).href);
  const artifacts = await loadArtifacts();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

  process.stdout.write("Sémantiques amont (aucune correction)…\n");
  const upstream = await measureSemantics({ V86, artifacts, mode: BRIDGE_MODES.observe });
  // Le mode intermédiaire isole la SECONDE rupture : le guest demande ses barrières, `ide.js` les
  // acquitte, et le backend n'en voit aucune. Sans lui, on ne saurait pas laquelle des deux
  // corrections fait quoi.
  process.stdout.write("Sémantiques avec IDENTIFY corrigé seulement…\n");
  const identifyOnly = await measureSemantics({ V86, artifacts, mode: BRIDGE_MODES.identify });
  process.stdout.write("Sémantiques avec pont de durabilité complet…\n");
  const bridged = await measureSemantics({ V86, artifacts, mode: BRIDGE_MODES.full });
  process.stdout.write("Injection de fautes…\n");
  const faults = await measureFaults({ V86, artifacts });
  let boots = null;
  if (!skipBoots) {
    process.stdout.write(`Premier boot, ${attempts} essais après échauffement…\n`);
    boots = await measureBoots({ V86, artifacts }, attempts);
  }

  const report = {
    contract: { id: "railsbox-vault-vm-protocol", version: 1 },
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      release: process.release.name,
      arch: process.arch,
    },
    pins: manifest.pins,
    transferredBytes: manifest.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
    volumeBytes: VOLUME_BYTES,
    flushDelayMilliseconds: FLUSH_DELAY_MS,
    upstream,
    identifyOnly,
    bridged,
    faults,
    boots,
  };

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nRapport écrit : ${REPORT_PATH}\n`);
  const flushCount = (measure) => measure.counts[JOURNAL_OPERATIONS.flush] ?? 0;
  const ataCount = (measure) => measure.counts[JOURNAL_OPERATIONS.ata] ?? 0;
  const barrierCount = (measure) =>
    measure.steps.reduce(
      (total, step) => total + (step.ata["0xE7"] ?? 0) + (step.ata["0xEA"] ?? 0),
      0,
    );
  process.stdout.write(
    [
      "",
      "Mode        FLUSH CACHE demandés par le guest   barrières reçues par le backend   commandes ATA",
      `amont       ${String(barrierCount(upstream)).padEnd(34)} ${String(flushCount(upstream)).padEnd(33)} ${ataCount(upstream)}`,
      `identify    ${String(barrierCount(identifyOnly)).padEnd(34)} ${String(flushCount(identifyOnly)).padEnd(33)} ${ataCount(identifyOnly)}`,
      `pont        ${String(barrierCount(bridged)).padEnd(34)} ${String(flushCount(bridged)).padEnd(33)} ${ataCount(bridged)}`,
      "",
    ].join("\n"),
  );
}

await main();
