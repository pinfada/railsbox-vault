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
      payload: { ...payload, jetonCle: HARNAIS_CLE_JETON },
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

/**
 * CE QUE LE MOTEUR FAIT DU HANDLE EXCLUSIF À LA MORT DU WORKER (#169, ADR 0031).
 *
 * Le dossier affirmait, depuis #163 et en quatre endroits, que terminer un Worker sans avoir appelé
 * `close()` laisserait le handle exclusif « tenu par un objet que plus personne ne référence », si
 * bien que l'ouverture suivante rendrait `VAULT_STORAGE_BUSY`. La revue de sécurité de la PR #174 a
 * mesuré le contraire sur deux moteurs. Ce banc-ci fait de sa sonde un FAIT du dépôt, mesuré plutôt
 * qu'affirmé, et `docs/compatibility.md` l'inscrit comme un fait de MOTEUR.
 *
 * Le protocole, avec son témoin positif D'ABORD :
 *
 *  1. un SECOND Worker prend le handle exclusif et le GARDE ;
 *  2. le Worker du banc tente d'ouvrir le même fichier — il doit être REFUSÉ. Sans ce témoin,
 *     « l'ouverture réussit après la mort » ne prouverait rien : elle réussirait aussi si
 *     l'exclusivité n'existait pas du tout ;
 *  3. le second Worker est TERMINÉ, sans avoir rien fermé ;
 *  4. le Worker du banc retente, et le banc rend combien de tours il a fallu.
 *
 * Le nombre de tours est la mesure : il dit si le moteur rend l'exclusivité SUR-LE-CHAMP ou après un
 * délai — la question que `tests/unit/vm-reouverture-handles.test.mjs` déclare hors de portée d'un
 * double déterministe.
 */
async function handleALaMortDuWorker({ tours = 20, pause = 100 } = {}) {
  const detenteur = new Worker("/vm/opfs-runtime-worker.mjs", {
    type: "module",
    name: "vault-opfs-detenteur",
  });
  const demander = (payload) =>
    new Promise((rendre, refuser) => {
      const id = `detenteur-${compteur++}`;
      const ecouteur = (event) => {
        if (event.data?.id !== id) return;
        detenteur.removeEventListener("message", ecouteur);
        if (event.data.ok) return rendre(event.data.report);
        refuser(
          new Error(`${event.data.error?.code ?? "sans code"} — ${event.data.error?.message}`),
        );
      };
      detenteur.addEventListener("message", ecouteur);
      detenteur.postMessage({ id, type: "run", payload });
    });

  try {
    const priseEnMain = await demander({
      scenario: "tenir-le-handle",
      jetonCle: HARNAIS_CLE_JETON,
    });
    // TÉMOIN POSITIF : tant que le détenteur vit, un second demandeur est refusé.
    const pendantLaVie = await executer({ scenario: "tenter-l-ouverture" });
    detenteur.terminate();

    let apresLaMort = null;
    let toursAttendus = 0;
    for (; toursAttendus < tours; toursAttendus += 1) {
      apresLaMort = await executer({ scenario: "tenter-l-ouverture" });
      if (apresLaMort.ouvert) break;
      await new Promise((rendre) => setTimeout(rendre, pause));
    }
    return { priseEnMain, pendantLaVie, apresLaMort, toursAttendus, pauseMs: pause };
  } finally {
    detenteur.terminate();
  }
}

globalThis.bancOpfs = Object.freeze({ executer, sondePage, handleALaMortDuWorker });
etat.textContent = "Worker OPFS prêt.";
