// Coquille de la preuve de reprise (#7). Elle crée le Worker runtime, lui transmet une phase et
// rend son compte rendu. Elle n'a aucun accès à l'émulateur, au backend OPFS ni au pont série.
//
// `?use-scheduling-api` n'est pas décoratif : v86 choisit sa boucle d'ordonnancement en inspectant
// `location.href`. Sans ce paramètre, il crée un Worker imbriqué depuis une URL `blob:`, que la CSP
// de la coquille (`worker-src 'self'`) refuse — l'émulateur ne bat alors jamais. Voir l'ADR 0003.

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

const worker = new Worker("/vm/reference-worker.mjs?use-scheduling-api", {
  type: "module",
  name: "vault-vm-reference",
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
 * Appelle une phase du Worker et rend son compte rendu BRUT. Certains comptes rendus portent des
 * objets non sérialisables en JSON (un `File`, pour l'export d'archive) : ils ne peuvent pas passer
 * par l'affichage.
 * @param {{ phase?: string }} payload
 */
function appeler(payload = {}) {
  compteur += 1;
  const id = compteur;
  etat.textContent = `Phase « ${payload.phase ?? "full"} »…`;
  return new Promise((resolve, reject) => {
    enCours.set(id, {
      resolve,
      reject: (erreur) => {
        etat.textContent = `Échec : ${erreur.message}`;
        reject(erreur);
      },
    });
    worker.postMessage({ id, type: "run", payload });
  });
}

/**
 * Exécute une phase du scénario de reprise dans le Worker et publie son compte rendu.
 * @param {{ phase?: string }} payload
 */
async function executer(payload = {}) {
  const report = await appeler(payload);
  etat.textContent = "Terminé.";
  rapport.textContent = JSON.stringify(report, null, 2);
  return report;
}

/**
 * EXPORTE l'archive hors de cette origine, par le seul chemin que le produit emprunte : un
 * téléchargement vers le système de fichiers de l'utilisateur. Le `File` rendu par le Worker est
 * adossé au support — le navigateur le diffuse sans que la page ne tienne l'archive en mémoire.
 * Aucun canal inter-origines n'est ouvert : la CSP de la coquille n'en autorise aucun.
 * @param {string} archive nom du volume d'archive dans OPFS
 */
async function telecharger(archive) {
  const report = await appeler({ phase: "archive-file", archive });
  const url = URL.createObjectURL(report.file);
  const lien = document.createElement("a");
  lien.href = url;
  lien.download = `${archive}.rbvault`;
  document.body.append(lien);
  lien.click();
  lien.remove();
  // La révocation attend que le navigateur ait pris l'archive en charge ; la révoquer aussitôt
  // interromprait un téléchargement de plusieurs centaines de Mio.
  setTimeout(() => URL.revokeObjectURL(url), 300_000);
  etat.textContent = `Archive « ${archive} » remise au navigateur.`;
  return { archive, byteLength: report.byteLength };
}

/**
 * RESTAURE depuis l'archive remise à cette origine par le champ de fichier. C'est l'autre moitié du
 * geste utilisateur : le fichier entre par la boîte de dialogue du navigateur, jamais par le réseau.
 * @param {{ phase?: string }} payload
 */
function executerAvecFichier(payload = {}) {
  const champ = document.querySelector("#archive-entrante");
  const fichier = champ?.files?.[0] ?? null;
  if (fichier === null) {
    return Promise.reject(new Error("Aucune archive n'a été remise à cette origine."));
  }
  return executer({ ...payload, archiveFile: fichier });
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

globalThis.bancReprise = Object.freeze({ executer, telecharger, executerAvecFichier, memoire });
etat.textContent = "Worker runtime prêt.";
