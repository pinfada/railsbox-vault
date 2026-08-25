// Mesure d'isolation cross-origin, partagée par la page coquille, son Worker runtime et le document
// applicatif : ces contextes doivent être relevés séparément, `crossOriginIsolated` ne se déduisant
// pas de l'un à l'autre.
//
// Le module vit sous `src/` parce qu'il est chargé par une page ET par un Worker : `eslint.config.mjs`
// ne lui accorde ainsi que l'intersection des deux jeux de globals. Sous `public/`, il recevrait tout
// le jeu navigateur et un `document` y passerait le lint pour ne casser que le Worker, à l'exécution.
// `tests/unit/eslint-config.test.mjs` maintient cet emplacement.

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
