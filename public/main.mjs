import { isRuntimeReadyMessage } from "/src/runtime-contract.mjs";

const status = document.querySelector("#worker-status");
const worker = new Worker(new URL("./runtime-worker.mjs", import.meta.url), { type: "module" });

worker.addEventListener(
  "message",
  (event) => {
    if (!isRuntimeReadyMessage(event.data)) {
      status.textContent = "worker:invalid-contract";
      worker.terminate();
      return;
    }

    status.textContent = "worker:ready";
    document.documentElement.dataset.vaultReady = "true";
    worker.terminate();
  },
  { once: true },
);

worker.addEventListener(
  "error",
  () => {
    status.textContent = "worker:error";
  },
  { once: true },
);
