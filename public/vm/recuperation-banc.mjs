// Coquille du banc de récupération (#91). Elle ne détient aucun handle : elle branche le Worker,
// lui passe un profil, et publie ce qu'il rapporte (ADR 0002).

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

let compteur = 0;

function brancher() {
  const worker = new Worker("/vm/recuperation-worker.mjs", {
    type: "module",
    name: "vault-recuperation-banc",
  });
  const enCours = new Map();

  worker.addEventListener("message", (event) => {
    const { id, ok, rapport: mesure, error } = event.data ?? {};
    const attente = enCours.get(id);
    if (!attente) return;
    enCours.delete(id);
    if (ok) attente.resolve(mesure);
    else attente.reject(new Error(`${error?.code ?? "sans code"} — ${error?.message ?? "échec"}`));
  });

  worker.addEventListener("error", (event) => {
    for (const attente of enCours.values()) attente.reject(new Error(event.message));
    enCours.clear();
  });

  return {
    worker,
    mesurer(options) {
      compteur += 1;
      const id = compteur;
      return new Promise((resolve, reject) => {
        enCours.set(id, { resolve, reject });
        worker.postMessage({ id, options });
      });
    },
  };
}

/**
 * Rejoue un profil de mesure et publie son relevé.
 * @param {{ chargeCible?: number, enregistrementOctets?: number, repetitions?: number }} options
 */
async function mesurer(options = {}) {
  etat.textContent = "Mesure en cours…";
  const banc = brancher();
  try {
    const mesure = await banc.mesurer(options);
    etat.textContent = `Terminé : p50 ${Math.round(mesure.recuperation.p50Ms)} ms, p95 ${Math.round(mesure.recuperation.p95Ms)} ms.`;
    rapport.textContent = JSON.stringify(mesure, null, 2);
    return mesure;
  } finally {
    banc.worker.terminate();
  }
}

globalThis.bancRecuperation = { mesurer };
etat.textContent = "Banc de récupération prêt.";
