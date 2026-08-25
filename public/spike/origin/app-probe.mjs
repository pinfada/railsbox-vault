// Document applicatif du spike #35, écrit comme un attaquant : il connaît le contrat de la
// coquille, s'annonce normalement, puis tente tout ce qu'un script Rails hostile tenterait.
// Le rapport est exposé sur `window.__probeReport` et recopié dans `#app-report` ; la suite
// Playwright le lit dans le contexte du cadre, sans passer par la coquille — un canal d'attaque
// ne doit pas servir à transporter la mesure.

import { measureIsolation } from "/src/spike/isolation-probe.mjs";
import { MESSAGE_TYPES } from "/src/spike/origin-topology.mjs";
import REALM_PROBES from "./app-probes-realm.mjs";
import STORAGE_PROBES from "./app-probes-storage.mjs";

const statusNode = document.querySelector("#app-status");
const reportNode = document.querySelector("#app-report");

document.querySelector("#app-isolation").textContent = JSON.stringify(measureIsolation());

let restrictedPort = null;
/** @type {{ resolve: (value: unknown) => void, servi: boolean }[]} */
const portWaiters = [];

function onPortMessage(event) {
  const waiter = portWaiters.find((candidate) => !candidate.servi);
  if (!waiter) return;
  waiter.servi = true;
  waiter.resolve(event.data);
}

/** Attend le port restreint que la coquille est censée accorder après l'annonce. */
function acquireRestrictedPort() {
  return new Promise((resolved) => {
    window.addEventListener("message", (event) => {
      if (event.data?.type !== MESSAGE_TYPES.channelGrant || !event.ports[0]) return;
      const port = event.ports[0];
      port.addEventListener("message", onPortMessage);
      port.start();
      resolved(port);
    });
    parent.postMessage({ type: MESSAGE_TYPES.appHello }, "*");
    setTimeout(() => resolved(null), 3000);
  });
}

function sendOnPort(message) {
  return new Promise((resolved) => {
    const waiter = { resolve: resolved, servi: false };
    portWaiters.push(waiter);
    restrictedPort.postMessage(message);
    setTimeout(() => {
      if (waiter.servi) return;
      waiter.servi = true;
      resolved({ type: "vault.aucune-reponse" });
    }, 1000);
  });
}

const context = {
  requestStatus: () =>
    restrictedPort === null
      ? Promise.resolve({ type: "vault.port-absent" })
      : sendOnPort({ type: MESSAGE_TYPES.statusRequest }),
};

// --- Sondes portant sur le canal lui-même -------------------------------------------------------

const CHANNEL_PROBES = [
  {
    nom: "message-forge-fenetre",
    cible: "coquille",
    intention: "obtenir la clé de volume par un message forgé sur window",
    async run() {
      const reponse = await new Promise((resolved) => {
        const ecoute = (event) => {
          if (event.data?.type === "vault.volume-key") resolved(event.data);
        };
        window.addEventListener("message", ecoute);
        parent.postMessage({ type: "vault.grant-volume-key", jeton: "forge" }, "*");
        setTimeout(() => {
          window.removeEventListener("message", ecoute);
          resolved(null);
        }, 500);
      });
      if (reponse) return { resultat: "reussi", detail: JSON.stringify(reponse) };
      return { resultat: "bloque", detail: "aucune réponse porteuse de clé en 500 ms" };
    },
  },
  {
    nom: "second-canal-reclame",
    cible: "coquille",
    intention: "obtenir un second port en rejouant l'annonce",
    async run() {
      const second = await new Promise((resolved) => {
        const ecoute = (event) => {
          if (event.data?.type === MESSAGE_TYPES.channelGrant && event.ports[0]) resolved(true);
        };
        window.addEventListener("message", ecoute);
        parent.postMessage({ type: MESSAGE_TYPES.appHello }, "*");
        setTimeout(() => {
          window.removeEventListener("message", ecoute);
          resolved(false);
        }, 500);
      });
      return second
        ? { resultat: "reussi", detail: "un second port a été accordé" }
        : { resultat: "bloque", detail: "annonce rejouée sans nouveau port" };
    },
  },
  {
    nom: "commande-privilegiee-sur-port",
    cible: "coquille",
    intention: "détourner le port restreint vers une commande privilégiée",
    async run() {
      if (restrictedPort === null) {
        return { resultat: "bloque", detail: "aucun port restreint obtenu" };
      }
      const reponse = await sendOnPort({ type: "vault.export-key" });
      const texte = JSON.stringify(reponse);
      return texte.includes("cle-de-volume")
        ? { resultat: "reussi", detail: texte }
        : { resultat: "bloque", detail: `refus typé reçu : ${texte}` };
    },
  },
  {
    nom: "usurpation-iframe-imbriquee",
    cible: "coquille",
    intention: "faire annoncer une iframe imbriquée pour obtenir un port à sa place",
    async run() {
      const nested = document.createElement("iframe");
      nested.id = "nested-frame";
      nested.title = "iframe imbriquée usurpatrice";
      nested.srcdoc = `<!doctype html><meta charset="utf-8"><script>
        window.addEventListener("message", (e) => {
          if (e.data && e.data.type === "${MESSAGE_TYPES.channelGrant}") {
            parent.postMessage({ type: "usurpation", obtenu: true }, "*");
          }
        });
        top.postMessage({ type: "${MESSAGE_TYPES.appHello}" }, "*");
        setTimeout(() => parent.postMessage({ type: "usurpation", obtenu: false }, "*"), 600);
      </${"script"}>`;
      const verdict = await new Promise((resolved) => {
        const ecoute = (event) => {
          if (event.data?.type !== "usurpation") return;
          window.removeEventListener("message", ecoute);
          resolved(event.data.obtenu);
        };
        window.addEventListener("message", ecoute);
        document.body.append(nested);
        setTimeout(() => resolved(false), 1500);
      });
      nested.remove();
      return verdict
        ? { resultat: "reussi", detail: "port accordé à une iframe imbriquée" }
        : { resultat: "bloque", detail: "annonce d'une iframe imbriquée refusée" };
    },
  },
];

// --- Exécution ----------------------------------------------------------------------------------

/**
 * Certaines API refusent une origine opaque en NE RÉPONDANT JAMAIS plutôt qu'en rejetant :
 * IndexedDB, notamment, n'émet alors ni `success` ni `error`. Un délai par sonde transforme ce
 * silence en constat nommé au lieu de bloquer tout le relevé.
 */
const DELAI_SONDE_MS = 3000;

function avecDelai(promesse) {
  return Promise.race([
    promesse,
    new Promise((resolved) =>
      setTimeout(
        () => resolved({ resultat: "bloque", detail: `aucune réponse en ${DELAI_SONDE_MS} ms` }),
        DELAI_SONDE_MS,
      ),
    ),
  ]);
}

async function runProbe(probe) {
  try {
    const issue = await avecDelai(probe.run(context));
    return { nom: probe.nom, cible: probe.cible, intention: probe.intention, ...issue };
  } catch (error) {
    return {
      nom: probe.nom,
      cible: probe.cible,
      intention: probe.intention,
      resultat: "bloque",
      detail: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    };
  }
}

async function runAllProbes() {
  restrictedPort = await acquireRestrictedPort();
  const results = [
    {
      nom: "obtention-port-restreint",
      cible: "contrat",
      intention: "obtenir le port restreint prévu par le contrat",
      resultat: restrictedPort ? "reussi" : "bloque",
      detail: restrictedPort ? "port restreint reçu" : "aucun port accordé en 3 s",
    },
  ];
  for (const probe of [...CHANNEL_PROBES, ...REALM_PROBES, ...STORAGE_PROBES]) {
    results.push(await runProbe(probe));
  }
  reportNode.textContent = JSON.stringify(results, null, 2);
  statusNode.textContent = `application:sondes-terminees:${results.length}`;
  document.documentElement.dataset.appState = "sondes-terminees";
  return results;
}

window.__probeReport = runAllProbes();
