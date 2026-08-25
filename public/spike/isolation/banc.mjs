// Coquille du banc du spike #41. Elle crée le Worker runtime, lui transmet une demande et rend son
// compte rendu ; elle n'a aucun accès à l'émulateur ni au backend, conformément à l'ADR 0002.
//
// Le banc du spike #4 (`public/vm/`) n'est pas réutilisé tel quel pour une raison de mesure : il
// rend des compteurs, pas des durées par étape. Ici la question est un COÛT, donc chaque commande
// du guest est chronométrée séparément. Le Worker importe en revanche exactement les modules de
// `src/vm/` qui portent le runtime livré : la mesure porte sur ce code-là, pas sur une réplique.

import { mesurerMemoireDetaillee } from "/src/spike/mesure-memoire.mjs";

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

// `?use-scheduling-api` n'est pas décoratif : v86 choisit sa boucle d'ordonnancement en inspectant
// `location.href`. Sans ce paramètre il crée un Worker imbriqué depuis une URL `blob:`, que la CSP
// de la coquille (`worker-src 'self'`) refuse — et l'émulateur ne bat jamais. Voir l'ADR 0003.
const worker = new Worker("./runtime-worker.mjs?use-scheduling-api", {
  type: "module",
  name: "vault-isolation-runtime",
});
const enCours = new Map();
let compteur = 0;

// Battements reçus du Worker depuis le début de la demande en cours. Ils ne servent qu'à
// diagnostiquer un silence : un Worker qui ne rend rien mais bat n'a pas le même défaut qu'un
// Worker dont le thread ne rend plus la main.
let battements = 0;

worker.addEventListener("message", (event) => {
  const { id, ok, report, error, type } = event.data ?? {};
  if (type === "battement") {
    battements += 1;
    return;
  }
  const attente = enCours.get(id);
  if (!attente) return;
  enCours.delete(id);
  if (ok) attente.resolve(report);
  else attente.reject(Object.assign(new Error(error?.message ?? "Échec du Worker"), error ?? {}));
});

worker.addEventListener("error", (event) => {
  for (const attente of enCours.values()) {
    attente.reject(new Error(`Erreur du Worker runtime : ${event.message}`));
  }
  enCours.clear();
});

function demander(type, payload = {}) {
  compteur += 1;
  const id = compteur;
  return new Promise((resolve, reject) => {
    enCours.set(id, {
      resolve: (report) => {
        etat.textContent = "Terminé.";
        rapport.textContent = JSON.stringify(report, null, 2);
        resolve(report);
      },
      reject: (erreur) => {
        etat.textContent = `Échec : ${erreur.message}`;
        // L'échec est rendu comme une VALEUR typée et non comme une exception opaque : un moteur
        // qui ne peut pas porter le runtime doit produire une raison lisible dans le rapport, pas
        // une trace à interpréter. C'est ce qui distingue « non mesurable » de « mesure ratée ».
        reject(erreur);
      },
    });
    worker.postMessage({ id, type, payload });
  });
}

/** Capacités du contexte, sans démarrer de VM : sert à qualifier un moteur non mesurable. */
function capacites() {
  etat.textContent = "Relevé des capacités…";
  return demander("capacites");
}

/** Un boot de guest suivi des étapes chronométrées. */
function mesurer(payload = {}) {
  etat.textContent = "Boot du guest et étapes chronométrées…";
  battements = 0;
  return demander("mesurer", payload);
}

/** Battements reçus depuis la dernière demande de mesure. Voir le pouls du Worker. */
function poulsRecu() {
  return battements;
}

/** Isolation telle que la voit le DOCUMENT ; celle du Worker est relevée séparément. */
function isolationDocument() {
  return {
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    sharedArrayBuffer: typeof SharedArrayBuffer === "function" ? "constructeur-present" : "absent",
    secureContext: Boolean(globalThis.isSecureContext),
  };
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

globalThis.bancIsolation = Object.freeze({
  capacites,
  mesurer,
  poulsRecu,
  isolationDocument,
  memoire,
  // Le même instrument que le Worker, appliqué au DOCUMENT : `performance` n'expose pas
  // nécessairement les mêmes méthodes dans les deux contextes, et le supposer serait une
  // affirmation de plus dans un spike qui existe pour en retirer une.
  memoireDetaillee: mesurerMemoireDetaillee,
});
etat.textContent = "Worker runtime prêt.";
