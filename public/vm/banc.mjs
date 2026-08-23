// Coquille du banc : elle crée le Worker runtime, lui transmet une demande et rend son compte
// rendu. Elle n'a aucun accès à l'émulateur ni au backend.

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

// `?use-scheduling-api` n'est pas décoratif : v86 choisit sa boucle d'ordonnancement en inspectant
// `location.href`. Sans ce paramètre, il crée un Worker imbriqué depuis une URL `blob:`, que la CSP
// de la coquille (`worker-src 'self'`) refuse — l'émulateur ne bat alors jamais. Voir l'ADR 0003.
const worker = new Worker("/vm/runtime-worker.mjs?use-scheduling-api", {
  type: "module",
  name: "vault-vm-runtime",
});
const enCours = new Map();
let compteur = 0;

worker.addEventListener("message", (event) => {
  const { id, ok, report, error } = event.data ?? {};
  const attente = enCours.get(id);
  if (!attente) return;
  enCours.delete(id);
  if (ok) attente.resolve(report);
  else attente.reject(new Error(error?.message ?? "Échec du Worker runtime"));
});

worker.addEventListener("error", (event) => {
  for (const attente of enCours.values()) {
    attente.reject(new Error(`Erreur du Worker runtime : ${event.message}`));
  }
  enCours.clear();
});

/**
 * Démarre un scénario de guest dans le Worker.
 * @param {{ scenario?: string, bridge?: boolean, volumeBytes?: number }} payload
 */
function executer(payload = {}) {
  compteur += 1;
  const id = compteur;
  etat.textContent = `Exécution du scénario « ${payload.scenario ?? "barrier"} »…`;
  return new Promise((resolve, reject) => {
    enCours.set(id, {
      resolve: (report) => {
        etat.textContent = "Terminé.";
        rapport.textContent = JSON.stringify(report, null, 2);
        resolve(report);
      },
      reject: (erreur) => {
        etat.textContent = `Échec : ${erreur.message}`;
        reject(erreur);
      },
    });
    worker.postMessage({ id, type: "run", payload });
  });
}

/** Mémoire du tas JavaScript, quand le moteur l'expose (Chromium uniquement). */
function memoire() {
  const mesure = performance.memory;
  if (!mesure) return null;
  return {
    usedJSHeapSize: mesure.usedJSHeapSize,
    totalJSHeapSize: mesure.totalJSHeapSize,
    jsHeapSizeLimit: mesure.jsHeapSizeLimit,
  };
}

globalThis.bancVault = Object.freeze({ executer, memoire });
etat.textContent = "Worker runtime prêt.";
