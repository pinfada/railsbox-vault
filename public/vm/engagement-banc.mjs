// Coquille du banc d'ENGAGEMENT D'ARCHIVE (#181, ADR 0034). Elle démarre le Worker, lui transmet
// une demande et affiche son compte rendu. Elle n'ouvre aucun volume et ne détient aucune clé.
//
// Ce banc porte le JETON du harnais, et rien d'autre. Le jeton n'ouvre qu'une chose : la clé de
// volume de TEST que `src/vm/cle-de-volume.mjs` distribue sous garde. Aucun chemin du produit ne le
// transmet.

import { HARNAIS_CLE_JETON } from "/src/vm/cle-de-volume.mjs";

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

const worker = new Worker("/vm/engagement-worker.mjs", {
  type: "module",
  name: "vault-engagement",
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
    attente.reject(new Error(`Erreur du Worker d'engagement : ${event.message}`));
  }
  enCours.clear();
});

/** @param {{ scenario?: string }} payload */
function executer(payload = {}) {
  compteur += 1;
  const id = compteur;
  etat.textContent = `Exécution du scénario « ${payload.scenario ?? "melange"} »…`;
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

/** Le texte BRUT de tout ce que le Worker a rendu, pour y chercher ce qui ne devrait pas y être. */
function toutCeQuiAFranchiLePort() {
  return JSON.stringify(reponses);
}

globalThis.bancEngagement = Object.freeze({ executer, toutCeQuiAFranchiLePort });
etat.textContent = "Worker d'engagement prêt.";
