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

/**
 * Une erreur qui traverse `page.evaluate` ne conserve que son MESSAGE : le code typé comme le
 * contexte se perdraient au passage. Tous deux sont donc portés PAR le message. Sans le code, un
 * test ne pourrait affirmer que « ça a échoué », jamais « ça a échoué pour la bonne raison » — et un
 * refus de sécurité vaut par sa raison. Sans le contexte, un échec de support arrive en CI privé de
 * ses mesures (offset, quota, errno), et l'on en est réduit à supposer sa cause (#73).
 *
 * Le contexte d'une `StorageError` ne porte que des nombres et des noms — jamais un octet de
 * contenu : le sérialiser dans un message de test n'expose rien de l'utilisateur.
 */
function erreurDuWorker(error) {
  const message = error?.message ?? "Échec du Worker runtime";
  const prefixe = error?.code ? `[${error.code}] ` : "";
  const contexte = decrireContexte(error?.context);
  return new Error(`${prefixe}${message}${contexte}`);
}

/** Sérialise le contexte d'une erreur typée, ou rend une chaîne vide s'il n'y en a pas. */
function decrireContexte(contexte) {
  if (!contexte || typeof contexte !== "object") return "";
  try {
    return ` — contexte : ${JSON.stringify(contexte)}`;
  } catch {
    // Un contexte non sérialisable ne doit pas faire disparaître l'erreur qu'il accompagne.
    return " — contexte non sérialisable";
  }
}

worker.addEventListener("message", (event) => {
  const { id, ok, report, error } = event.data ?? {};
  const attente = enCours.get(id);
  if (!attente) return;
  enCours.delete(id);
  if (ok) attente.resolve(report);
  else attente.reject(erreurDuWorker(error));
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

/** URL objet de l'archive en cours de remise, à révoquer dès que le transfert est fini. */
let urlArchive = null;

/**
 * Révoque l'URL objet de la dernière archive remise. Une URL objet retient le fichier tant qu'elle
 * vit : la libérer est un geste, pas un délai deviné. Le banc l'appelle sur `pagehide`, et
 * l'appelant peut le faire dès que le transfert est terminé.
 */
function libererArchive() {
  if (urlArchive === null) return false;
  URL.revokeObjectURL(urlArchive);
  urlArchive = null;
  return true;
}

addEventListener("pagehide", libererArchive);

/**
 * EXPORTE l'archive hors de cette origine, par le seul chemin que le produit emprunte : un
 * téléchargement vers le système de fichiers de l'utilisateur. Le `File` rendu par le Worker est
 * adossé au support — le navigateur le diffuse sans que la page ne tienne l'archive en mémoire.
 * Aucun canal inter-origines n'est ouvert : la CSP de la coquille n'en autorise aucun. Le Worker
 * refuse par ailleurs de remettre autre chose qu'une archive (marqueur `RBVAULT1` exigé).
 * @param {string} archive nom du volume d'archive dans OPFS
 */
async function telecharger(archive) {
  const report = await appeler({ phase: "archive-file", archive });
  libererArchive();
  urlArchive = URL.createObjectURL(report.file);
  const lien = document.createElement("a");
  lien.href = urlArchive;
  lien.download = `${archive}.rbvault`;
  document.body.append(lien);
  lien.click();
  lien.remove();
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

globalThis.bancReprise = Object.freeze({
  executer,
  telecharger,
  libererArchive,
  executerAvecFichier,
  memoire,
});
etat.textContent = "Worker runtime prêt.";
