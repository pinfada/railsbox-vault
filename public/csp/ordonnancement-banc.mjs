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

/** Assemble le relevé d'une configuration et l'affiche dans la page, d'où le harnais le lit. */
function publier(nom, configuration, journalPage, complement) {
  const releve = { configuration: nom, ...configuration, journalPage, ...complement };
  etat.textContent = `Mesure « ${nom} » terminée.`;
  rapport.textContent = JSON.stringify(releve, null, 2);
  return releve;
}

/**
 * Branche les écouteurs du Worker de mesure et lui confie la configuration. Les événements de la
 * PAGE sont journalisés séparément du relevé du Worker : un Worker qui meurt à son chargement ne
 * publie rien, et c'est ce journal qui dit alors ce qui s'est passé.
 */
function brancherWorker(worker, { configuration, bootTimeoutMs, journalPage, terminer }) {
  worker.addEventListener("error", (evenement) => {
    journalPage.push(`worker-error: ${evenement.message}`);
  });
  worker.addEventListener("messageerror", () => journalPage.push("worker-messageerror"));
  worker.addEventListener("message", (evenement) => {
    const { ok, report, error } = evenement.data ?? {};
    terminer({
      chargementWorker: "charge",
      silence: false,
      ...(ok ? { releve: report } : { echec: error }),
    });
  });

  worker.postMessage({
    id: 1,
    type: "mesurer",
    payload: { cale: configuration.cale, bootTimeoutMs },
  });
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
    const journalPage = [];
    let worker = null;
    let echeance = null;

    const terminer = (complement) => {
      if (echeance !== null) clearTimeout(echeance);
      if (worker) worker.terminate();
      resolve(publier(nom, configuration, journalPage, complement));
    };

    // Garde de dernier ressort : le Worker borne déjà son propre boot, mais un Worker qui ne
    // charge pas du tout ne bornerait rien. La page ne reste jamais suspendue.
    echeance = setTimeout(() => terminer({ silence: true }), bootTimeoutMs + 60000);

    try {
      worker = creerWorker(configuration.marqueur);
    } catch (erreur) {
      terminer({ chargementWorker: `refuse:${erreur.name}`, silence: false });
      return;
    }
    brancherWorker(worker, { configuration, bootTimeoutMs, journalPage, terminer });
  });
}

globalThis.bancOrdonnancement = Object.freeze({
  mesurer,
  configurations: Object.keys(CONFIGURATIONS),
});
etat.textContent = "Banc prêt.";
