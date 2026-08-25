// Worker runtime du spike #35. Il représente le seul détenteur légitime de la clé de volume :
// la coquille la lui transmet une fois, sur un port privé créé avant tout contenu applicatif, et
// le worker ne la renvoie jamais — même à qui la demande sur ce port.

import { measureIsolation } from "/src/spike/isolation-probe.mjs";

let volumeKey = null;
let privilegedPort = null;

function onPrivilegedMessage(event) {
  const message = event.data;
  if (message?.type === "vault.unlock") {
    volumeKey = message.key;
    privilegedPort.postMessage({
      type: "vault.unlock-ok",
      empreinte: volumeKey.length,
      isolation: measureIsolation(),
    });
    return;
  }
  if (message?.type === "vault.status-request") {
    privilegedPort.postMessage({
      type: "vault.runtime-status",
      pret: volumeKey !== null,
      jeton: message.jeton,
    });
    return;
  }
  privilegedPort.postMessage({
    type: "vault.refus",
    motif: "commande-inconnue",
    recu: String(message?.type),
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "vault.privileged-channel" || !event.ports[0]) {
    // Aucun repli silencieux : le worker refuse de fonctionner sans son canal privé.
    throw new Error("Le worker runtime n'accepte que l'établissement du canal privilégié.");
  }
  privilegedPort = event.ports[0];
  privilegedPort.addEventListener("message", onPrivilegedMessage);
  privilegedPort.start();
});
