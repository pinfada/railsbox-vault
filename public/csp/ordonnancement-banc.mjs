// Coquille du banc de mesure #52. Elle crée UN Worker par configuration — jamais deux mesures dans
// le même Worker : v86 fige son chemin d'ordonnancement à l'évaluation de son module, et un module
// déjà importé ne se réévalue pas. Réutiliser le Worker mesurerait donc la première configuration
// une seconde fois, sans le dire.

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

/** Configurations mesurées. Le nom est celui qui apparaît dans le tableau de l'ADR 0013. */
export const CONFIGURATIONS = Object.freeze({
  /** Configuration servie aujourd'hui : v86 retient `scheduler.postTask` quand le moteur l'expose. */
  "marqueur-url": { marqueur: true, cale: null },
  /** Sans le marqueur : v86 retombe sur son Worker imbriqué `blob:`. */
  "sans-marqueur": { marqueur: false, cale: null },
  /** Cale Vault posée SEULEMENT si le moteur n'expose pas l'API (cas de WebKit). */
  "cale-si-absente": { marqueur: true, cale: "si-absent" },
  /** Cale Vault posée MÊME par-dessus une implémentation native (question ouverte par #74). */
  "cale-forcee": { marqueur: true, cale: "toujours" },
});

function creerWorker(marqueur) {
  const url = marqueur
    ? "/csp/ordonnancement-worker.mjs?use-scheduling-api"
    : "/csp/ordonnancement-worker.mjs";
  return new Worker(url, { type: "module", name: "vault-mesure-ordonnancement" });
}

/**
 * Exécute une configuration et rend son relevé. La promesse est TOUJOURS résolue : un Worker qui
 * ne charge pas, ou qui se tait, est une mesure et non une exception à propager.
 */
function mesurer(nom, { bootTimeoutMs = 45000 } = {}) {
  const configuration = CONFIGURATIONS[nom];
  if (!configuration) throw new Error(`Configuration inconnue : ${nom}`);
  etat.textContent = `Mesure « ${nom} »…`;

  return new Promise((resolve) => {
    let worker;
    let echeance = null;
    const journalPage = [];

    const terminer = (releve) => {
      if (echeance !== null) clearTimeout(echeance);
      if (worker) worker.terminate();
      etat.textContent = `Mesure « ${nom} » terminée.`;
      rapport.textContent = JSON.stringify(releve, null, 2);
      resolve(releve);
    };

    // Garde de dernier ressort : le Worker borne déjà son propre boot, mais un Worker qui ne
    // charge pas du tout ne bornerait rien. La page ne reste jamais suspendue.
    echeance = setTimeout(() => {
      terminer({ configuration: nom, ...configuration, silence: true, journalPage });
    }, bootTimeoutMs + 60000);

    try {
      worker = creerWorker(configuration.marqueur);
    } catch (erreur) {
      terminer({
        configuration: nom,
        ...configuration,
        chargementWorker: `refuse:${erreur.name}`,
        journalPage,
        silence: false,
      });
      return;
    }

    worker.addEventListener("error", (evenement) => {
      journalPage.push(`worker-error: ${evenement.message}`);
    });
    worker.addEventListener("messageerror", () => journalPage.push("worker-messageerror"));
    worker.addEventListener("message", (evenement) => {
      const { ok, report, error } = evenement.data ?? {};
      terminer({
        configuration: nom,
        ...configuration,
        chargementWorker: "charge",
        silence: false,
        journalPage,
        ...(ok ? { releve: report } : { echec: error }),
      });
    });

    worker.postMessage({
      id: 1,
      type: "mesurer",
      payload: { cale: configuration.cale, bootTimeoutMs },
    });
  });
}

globalThis.bancOrdonnancement = Object.freeze({
  mesurer,
  configurations: Object.keys(CONFIGURATIONS),
});
etat.textContent = "Banc prêt.";
