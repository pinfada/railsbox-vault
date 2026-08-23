import { RUNTIME_CONTRACT } from "/src/runtime-contract.mjs";

postMessage({ type: "runtime-ready", contract: RUNTIME_CONTRACT });
