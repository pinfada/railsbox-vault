// Coquille du banc OPFS. Elle démarre le Worker, lui transmet une demande et affiche son compte
// rendu. Elle n'ouvre aucun volume et ne détient aucun handle : c'est précisément ce que
// `sondePage` vérifie.

import { HARNAIS_CLE_JETON } from "/src/vm/cle-de-volume.mjs";

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

const worker = new Worker("/vm/opfs-runtime-worker.mjs", {
  type: "module",
  name: "vault-opfs-runtime",
});
const enCours = new Map();
let compteur = 0;

worker.addEventListener("message", (event) => {
  const { id, ok, report, error } = event.data ?? {};
  const attente = enCours.get(id);
  if (!attente) return;
  enCours.delete(id);
  if (ok) attente.resolve(report);
  else attente.reject(new Error(`${error?.code ?? "sans code"} — ${error?.message ?? "échec"}`));
});

worker.addEventListener("error", (event) => {
  for (const attente of enCours.values()) {
    attente.reject(new Error(`Erreur du Worker OPFS : ${event.message}`));
  }
  enCours.clear();
});

/**
 * @param {{ scenario?: string }} payload
 *
 * Le JETON DU HARNAIS est ajouté ici, et il n'ouvre qu'une chose : la clé de volume de TEST que ce
 * banc emploie pour lire et écrire un volume v3 (ADR 0016, décision 6). Ce fichier est un banc, pas
 * le produit ; aucun chemin du produit ne transmet ce jeton, et un volume ouvert sans clé est refusé
 * par `VAULT_STORAGE_CLE_REQUISE`.
 */
function executer(payload = {}) {
  compteur += 1;
  const id = compteur;
  etat.textContent = `Exécution du scénario « ${payload.scenario ?? "persistance"} »…`;
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
    worker.postMessage({
      id,
      type: "run",
      payload: { ...payload, jeton: HARNAIS_CLE_JETON },
    });
  });
}

/**
 * Mesure ce que la PAGE peut faire d'OPFS. Le module d'accès doit la refuser : la coquille, et
 * donc le document applicatif qu'elle encadre, n'obtiennent jamais de handle exclusif (ADR 0002).
 * Un succès est rapporté tel quel — il ferait échouer la suite, ce qui est le comportement voulu.
 */
async function sondePage() {
  const { openOpfsSyncAccess } = await import("/src/vm/opfs-sync-access.mjs");
  let code = null;
  let message = null;
  let opened = false;

  try {
    const handle = await openOpfsSyncAccess("sonde-page");
    opened = true;
    handle.close();
  } catch (erreur) {
    code = typeof erreur.code === "string" ? erreur.code : null;
    message = erreur.message;
  }

  return {
    code,
    message,
    opened,
    getDirectory: typeof navigator.storage?.getDirectory,
    createSyncAccessHandleEnPage:
      typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
  };
}

globalThis.bancOpfs = Object.freeze({ executer, sondePage });
etat.textContent = "Worker OPFS prêt.";
