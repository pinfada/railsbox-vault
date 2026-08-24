// Coquille du banc de bail d'écriture (#8). Elle démarre un Worker qui se dispute le bail, collecte
// ses transitions horodatées et affiche le statut d'UI courant. Elle ne détient ni verrou ni handle :
// tout l'arbitrage vit dans le Worker, conformément à l'ADR 0002.
//
// L'affichage est un ÉTAT EXPLICITE (lecture-seule / attente / ecriture / conflit / erreur), jamais
// un booléen : c'est ce que la preuve navigateur lit dans le DOM pour vérifier que l'UI distingue
// les quatre situations.

const etat = document.querySelector("#bail-etat");
const journal = document.querySelector("#bail-journal");

const worker = new Worker("/vm/lease-worker.mjs", { type: "module", name: "vault-bail" });

const transitions = [];
let latest = null;
let settledReport = null;
let terminated = false;
const waiters = new Set();
const replies = new Map();
let compteur = 0;
let workerReady;
const ready = new Promise((resolve) => {
  workerReady = resolve;
});

function afficher(snapshot) {
  etat.textContent = snapshot.uiStatus;
  etat.dataset.state = snapshot.state;
  journal.textContent = transitions.map((t) => `${t.state} · ${t.uiStatus}`).join("\n");
}

function notifier() {
  for (const waiter of [...waiters]) {
    if (waiter.predicate()) {
      waiters.delete(waiter);
      waiter.resolve(waiter.value());
    }
  }
}

worker.addEventListener("message", (event) => {
  const { kind, id, value, error, lease, outcome, reason, errorCode } = event.data ?? {};
  if (kind === "ready") {
    workerReady();
  } else if (kind === "state") {
    transitions.push(lease);
    latest = lease;
    afficher(lease);
    notifier();
  } else if (kind === "settled") {
    settledReport = { outcome, reason, errorCode, lease };
    latest = lease;
    afficher(lease);
    notifier();
  } else if (kind === "reply") {
    const attente = replies.get(id);
    if (!attente) return;
    replies.delete(id);
    if (error) attente.reject(new Error(`${error.code ?? "sans code"} — ${error.message}`));
    else attente.resolve(value);
  }
});

worker.addEventListener("error", (event) => {
  for (const attente of replies.values()) attente.reject(new Error(`Worker : ${event.message}`));
  replies.clear();
});

function envoyer(type, payload) {
  compteur += 1;
  const id = compteur;
  return new Promise((resolve, reject) => {
    replies.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

/** Attend qu'un instantané satisfaisant `predicate` soit observé (ou l'ait déjà été). */
function attendre(predicate, { timeoutMs = 15000 } = {}) {
  const dejaVu = [...transitions, settledReport?.lease].find((s) => s && predicate(s));
  if (dejaVu) return Promise.resolve(dejaVu);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate: () => Boolean(latest && predicate(latest)),
      value: () => latest,
      resolve,
    };
    waiters.add(waiter);
    setTimeout(() => {
      if (waiters.delete(waiter)) {
        reject(new Error(`Délai d'attente dépassé pour un état du bail « ${latest?.state} ».`));
      }
    }, timeoutMs);
  });
}

globalThis.bancBail = Object.freeze({
  pret: () => ready,
  capacite: () => envoyer("capacite"),
  acquerir: (payload) => envoyer("acquire", payload),
  liberer: () => envoyer("release"),
  /** Terminaison BRUTALE du Worker : ni release, ni fermeture propre du handle. Simule un crash. */
  terminer: () => {
    terminated = true;
    worker.terminate();
    etat.textContent = "worker-termine";
  },
  etat: () => latest,
  transitions: () => transitions.slice(),
  reglement: () => settledReport,
  estTermine: () => terminated,
  attendreEtat: (state, options) => attendre((s) => s.state === state, options),
  attendreStatut: (uiStatus, options) => attendre((s) => s.uiStatus === uiStatus, options),
});

etat.textContent = "banc-pret";
