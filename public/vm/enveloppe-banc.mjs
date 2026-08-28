// Coquille du banc d'ENVELOPPE DE CLÉ (#21, ADR 0020). Elle démarre le Worker, lui transmet une
// demande et affiche son compte rendu. Elle n'ouvre aucune enveloppe et ne détient aucune clé :
// c'est précisément ce que `sondePage` et le relevé des réponses vérifient.
//
// Ce banc porte le JETON du harnais, et rien d'autre. Le jeton n'ouvre qu'une chose : les clés de
// TEST — clé de volume et clés de déverrouillage — que `src/vm/cle-de-volume.mjs` distribue sous
// garde. Aucun chemin du produit ne le transmet.

import { HARNAIS_CLE_JETON } from "/src/vm/cle-de-volume.mjs";

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

const worker = new Worker("/vm/enveloppe-worker.mjs", {
  type: "module",
  name: "vault-enveloppe",
});
const enCours = new Map();
let compteur = 0;

/**
 * TOUTES les réponses reçues du Worker, conservées telles quelles.
 *
 * Elles ne servent pas au diagnostic : elles servent à être FOUILLÉES. L'épreuve de frontière y
 * cherche les octets des clés de TEST, et un banc qui n'aurait gardé que la dernière réponse
 * n'aurait rien mesuré des précédentes.
 */
const reponses = [];

worker.addEventListener("message", (event) => {
  const { id, ok, report, error } = event.data ?? {};
  reponses.push(event.data);
  const attente = enCours.get(id);
  if (!attente) return;
  enCours.delete(id);
  if (ok) attente.resolve(report);
  else attente.reject(new Error(`${error?.code ?? "sans code"} — ${error?.message ?? "échec"}`));
});

worker.addEventListener("error", (event) => {
  for (const attente of enCours.values()) {
    attente.reject(new Error(`Erreur du Worker d'enveloppe : ${event.message}`));
  }
  enCours.clear();
});

/** @param {{ scenario?: string }} payload */
function executer(payload = {}) {
  compteur += 1;
  const id = compteur;
  etat.textContent = `Exécution du scénario « ${payload.scenario ?? "cycle"} »…`;
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
    worker.postMessage({ id, type: "run", payload: { ...payload, jetonCle: HARNAIS_CLE_JETON } });
  });
}

/**
 * Mesure ce que la PAGE peut faire du fichier d'enveloppes. Le module d'accès doit la refuser : la
 * coquille — et donc le document applicatif qu'elle encadre — n'obtient jamais de handle exclusif
 * (ADR 0002), pas plus sur les clés d'un volume que sur le volume lui-même.
 */
async function sondePage(nomEnveloppe) {
  const { openOpfsSyncAccess } = await import("/src/vm/opfs-sync-access.mjs");
  let code = null;
  let message = null;
  let ouvert = false;

  try {
    const handle = await openOpfsSyncAccess(nomEnveloppe);
    ouvert = true;
    handle.close();
  } catch (erreur) {
    code = typeof erreur.code === "string" ? erreur.code : null;
    message = erreur.message;
  }

  return {
    nomEnveloppe,
    code,
    message,
    ouvert,
    getDirectory: typeof navigator.storage?.getDirectory,
    createSyncAccessHandleEnPage:
      typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
  };
}

/** Le texte BRUT de tout ce que le Worker a rendu, pour y chercher ce qui ne devrait pas y être. */
function toutCeQuiAFranchiLePort() {
  return JSON.stringify(reponses);
}

globalThis.bancEnveloppe = Object.freeze({ executer, sondePage, toutCeQuiAFranchiLePort });
etat.textContent = "Worker d'enveloppe prêt.";
