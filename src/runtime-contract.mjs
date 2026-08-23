export const RUNTIME_CONTRACT = Object.freeze({
  id: "railsbox-vault-browser-harness",
  version: 1,
});

export function isRuntimeReadyMessage(value) {
  return (
    value?.type === "runtime-ready" &&
    value?.contract?.id === RUNTIME_CONTRACT.id &&
    value?.contract?.version === RUNTIME_CONTRACT.version
  );
}
