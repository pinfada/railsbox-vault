// Mesure d'isolation cross-origin, partagée par la page coquille et son Worker runtime : les deux
// contextes doivent être relevés séparément, `crossOriginIsolated` ne se déduisant pas de l'autre.

/**
 * @returns {{ crossOriginIsolated: boolean, sharedArrayBuffer: string, secureContext: boolean }}
 */
export function measureIsolation() {
  return {
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    sharedArrayBuffer: measureSharedArrayBuffer(),
    secureContext: Boolean(globalThis.isSecureContext),
  };
}

function measureSharedArrayBuffer() {
  if (typeof SharedArrayBuffer !== "function") return "constructeur-absent";
  try {
    const buffer = new SharedArrayBuffer(8);
    return buffer.byteLength === 8 ? "alloue" : "alloue-taille-inattendue";
  } catch (error) {
    return `refuse: ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
  }
}
