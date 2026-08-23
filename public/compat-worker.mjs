import { CAPABILITY_PROBE_CONTRACT } from "/src/compat/capability-contract.mjs";
import { runWorkerProbe } from "/src/compat/worker-probe.mjs";

addEventListener("message", async (event) => {
  if (
    event.data?.type !== "probe-request" ||
    event.data?.contract?.id !== CAPABILITY_PROBE_CONTRACT.id ||
    event.data?.contract?.version !== CAPABILITY_PROBE_CONTRACT.version
  ) {
    postMessage({ type: "probe-rejected", reason: "requête hors contrat" });
    return;
  }

  postMessage({
    type: "probe-result",
    contract: CAPABILITY_PROBE_CONTRACT,
    capabilities: await runWorkerProbe(),
  });
});
