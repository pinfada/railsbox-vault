import { CAPABILITIES } from "/src/compat/capability-contract.mjs";
import { runPageProbe } from "/src/compat/page-probe.mjs";

const root = document.documentElement;
const summary = document.querySelector("#compat-summary");
const rows = document.querySelector("#compat-rows");

function labelOf(id) {
  return CAPABILITIES.find((capability) => capability.id === id)?.label ?? id;
}

function render(report) {
  summary.textContent = `${report.vaultVerdict.status} — ${report.capabilities.length} capacités mesurées`;
  for (const entry of report.capabilities) {
    const row = document.createElement("tr");
    row.dataset.capability = entry.id;
    for (const value of [labelOf(entry.id), entry.context, entry.verdict, entry.detail]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    rows.append(row);
  }
}

try {
  const report = await runPageProbe(new URL("/compat-worker.mjs", location.origin));
  globalThis.railsboxCompatReport = report;
  render(report);
  root.dataset.compatState = "done";
} catch (error) {
  const detail = `${error.name} : ${error.message}`;
  globalThis.railsboxCompatError = detail;
  summary.textContent = `sonde en échec — ${detail}`;
  root.dataset.compatState = "failed";
}
