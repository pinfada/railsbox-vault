// Coquille du banc de conduite de persistance (#42). Elle exécute la couche de conduite PURE contre
// des verdicts de persistance choisis, puis pose le message accessible et l'état de coquille dans le
// DOM. Le test navigateur lit ensuite le rôle ARIA, l'état de coquille, la promesse de durabilité et
// le texte réellement rendus.
//
// La conduite est pure : elle ne demande pas elle-même la persistance. Les verdicts synthétiques
// exercent chaque branche de façon déterministe — comme le banc de budget (#9) classe un
// `StorageError` synthétique plutôt que de remplir le disque. Une méthode supplémentaire enchaîne le
// VRAI `requestPersistence()` de #9 sur le vrai `navigator.storage` et vérifie que l'invariant tient
// quel que soit le verdict rendu par le moteur sans geste.

import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";
import {
  DURABILITY_PROMISE,
  PERSISTENCE_VERDICTS,
  SHELL_STATES,
  USER_STANCE,
  conductForPersistence,
  isDurableGuaranteed,
} from "/src/vm/persistence-conduct.mjs";
import { describeConduct } from "/src/vm/persistence-conduct-messages.mjs";

const etat = document.querySelector("#etat");
const coquille = document.querySelector("#coquille");
const annonce = document.querySelector("#annonce");
const rapport = document.querySelector("#rapport");

const budget = createStorageBudget(bindNavigatorStorage(navigator.storage));

/** Pose l'état de coquille et le message accessible dans le DOM, puis relit le rendu réel. */
function rendreConduite(conduite) {
  const vue = describeConduct(conduite);

  coquille.setAttribute("data-shell-state", conduite.shellState);
  coquille.setAttribute("data-durability", conduite.durability);
  coquille.textContent = `${conduite.shellState} · ${conduite.durability}`;

  const noeud = document.createElement("p");
  noeud.setAttribute("role", vue.role);
  noeud.textContent = vue.text;
  annonce.replaceChildren(noeud);

  return {
    shellState: conduite.shellState,
    durability: conduite.durability,
    durableGuaranteed: isDurableGuaranteed(conduite),
    role: vue.role,
    text: vue.text,
    domShellState: coquille.getAttribute("data-shell-state"),
    domDurability: coquille.getAttribute("data-durability"),
    domRole: annonce.firstElementChild?.getAttribute("role") ?? null,
    domText: annonce.firstElementChild?.textContent ?? null,
  };
}

const banc = {
  /** Exerce un verdict synthétique choisi et rend l'état + le message dans le DOM. */
  conduire(verdict, { userGesture = true, stance } = {}) {
    const conduite = conductForPersistence({ verdict, userGesture, stance });
    return rendreConduite(conduite);
  },

  /**
   * Enchaîne le VRAI `requestPersistence()` de #9 sur le vrai `navigator.storage`, sans geste, puis
   * dérive la conduite. L'invariant « durable ⟹ accordé » doit tenir quel que soit le verdict réel.
   */
  async depuisNavigateur() {
    const verdict = await budget.requestPersistence();
    const conduite = conductForPersistence({ verdict, userGesture: true });
    const rendu = rendreConduite(conduite);
    return { verdictState: verdict.state, ...rendu };
  },

  // Exposé pour lisibilité du test.
  VERDICTS: PERSISTENCE_VERDICTS,
  ETATS: SHELL_STATES,
  DURABILITE: DURABILITY_PROMISE,
  STANCE: USER_STANCE,
};

globalThis.bancConduite = banc;
etat.textContent = "Banc conduite prêt.";
rapport.textContent = "Prêt à décider la conduite de persistance.";
