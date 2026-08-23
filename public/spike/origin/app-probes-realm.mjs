// Sondes portant sur le REALM de la coquille : DOM, globales, prototypes, navigation et fenêtres.
// Chacune rend `reussi` quand l'attaque atteint son but, `bloque` avec l'erreur exacte sinon.
// Aucune n'avale son échec : un `bloque` sans motif ne prouverait pas la frontière.

import { STORAGE_KEY } from "./shell-state.mjs";

const REALM_PROBES = [
  {
    nom: "acces-dom-coquille",
    cible: "coquille",
    intention: "lire et modifier le document de la coquille",
    async run() {
      const titre = parent.document.title;
      parent.document.documentElement.dataset.hostile = "present";
      return { resultat: "reussi", detail: `titre lu : « ${titre} », attribut hostile posé` };
    },
  },
  {
    nom: "lecture-appat-realm",
    cible: "coquille",
    intention: "lire un secret joignable depuis le realm de la coquille",
    async run() {
      const bait = parent.__vaultShellSecretBait;
      if (typeof bait !== "string") {
        return { resultat: "bloque", detail: "appât absent du realm parent" };
      }
      return { resultat: "reussi", detail: `secret lu : ${bait}` };
    },
  },
  {
    nom: "lecture-stockage-cle-valeur",
    cible: "coquille",
    intention: "lire le secret déposé en localStorage et sessionStorage",
    async run() {
      const local = localStorage.getItem(STORAGE_KEY);
      const session = parent.sessionStorage.getItem(STORAGE_KEY);
      if (local === null && session === null) {
        return {
          resultat: "bloque",
          detail: "stockages accessibles mais vides pour cette origine",
        };
      }
      return { resultat: "reussi", detail: `localStorage=${local} sessionStorage=${session}` };
    },
  },
  {
    nom: "reference-worker-runtime",
    cible: "coquille",
    intention: "obtenir une référence au Worker runtime ou à un MessagePort de la coquille",
    async run() {
      const explicite = parent.__vaultRuntimeWorker;
      if (explicite) return { resultat: "reussi", detail: "globale __vaultRuntimeWorker exposée" };
      const trouves = Object.getOwnPropertyNames(parent).filter((nom) => {
        const valeur = parent[nom];
        return valeur instanceof parent.Worker || valeur instanceof parent.MessagePort;
      });
      if (trouves.length > 0) {
        return { resultat: "reussi", detail: `globales joignables : ${trouves.join(", ")}` };
      }
      return {
        resultat: "bloque",
        detail: "realm parent atteint, aucun Worker ni MessagePort exposé en globale",
      };
    },
  },
  {
    nom: "empoisonnement-prototype-port",
    cible: "coquille",
    intention: "capter les messages du canal privilégié en remplaçant MessagePort.postMessage",
    async run(context) {
      const captures = [];
      const prototype = parent.MessagePort.prototype;
      const original = prototype.postMessage;
      prototype.postMessage = function piege(...args) {
        captures.push(args[0]);
        return original.apply(this, args);
      };
      await context.requestStatus();
      const vole = captures.find((message) => typeof message?.jeton === "string");
      if (vole) {
        return { resultat: "reussi", detail: `jeton de session capté : ${vole.jeton}` };
      }
      return {
        resultat: "bloque",
        detail: `prototype remplacé, ${captures.length} envoi(s) observé(s), aucun jeton`,
      };
    },
  },
  {
    nom: "navigation-top-fragment",
    cible: "coquille",
    intention: "modifier l'URL du document de plus haut niveau",
    async run() {
      top.location.hash = "#hostile-35";
      return { resultat: "reussi", detail: "fragment du sommet réécrit" };
    },
  },
  {
    nom: "ouverture-popup",
    cible: "coquille",
    intention: "ouvrir une fenêtre auxiliaire sur l'origine de la coquille",
    async run() {
      const popup = window.open("about:blank", "_blank");
      if (popup === null) return { resultat: "bloque", detail: "window.open a rendu null" };
      popup.close();
      return { resultat: "reussi", detail: "fenêtre auxiliaire ouverte puis refermée" };
    },
  },
];

export default REALM_PROBES;
