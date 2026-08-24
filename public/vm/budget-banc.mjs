// Coquille du banc de budget de stockage (#9). Elle exécute la couche budget contre le VRAI
// `navigator.storage` de la page, puis pose le message accessible d'un diagnostic dans une région
// vivante du DOM. Le test navigateur lit ensuite le rôle ARIA et le texte réellement rendus.
//
// Aucun handle OPFS n'est ouvert : la couche budget mesure et diagnostique, elle n'écrit pas. Les
// branches exercées ici sont exactement celles que le vrai moteur atteint ; les branches d'absence
// (estimate/persist manquants, quota réellement dépassé) restent prouvées par les doubles de
// `tests/unit/vm-storage-budget.test.mjs`.

import { STORAGE_ERROR_CODES, StorageError } from "/src/vm/storage-errors.mjs";
import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";
import { describeDiagnostic } from "/src/vm/storage-budget-messages.mjs";

const etat = document.querySelector("#etat");
const annonce = document.querySelector("#annonce");
const rapport = document.querySelector("#rapport");

const budget = createStorageBudget(bindNavigatorStorage(navigator.storage));

/** Pose le descripteur accessible d'un diagnostic dans la région vivante et le relit depuis le DOM. */
function annoncer(diagnostic) {
  const vue = describeDiagnostic(diagnostic);
  const noeud = document.createElement("p");
  noeud.setAttribute("role", vue.role);
  noeud.textContent = vue.text;
  annonce.replaceChildren(noeud);
  return {
    role: noeud.getAttribute("role"),
    text: noeud.textContent,
    domRole: annonce.firstElementChild?.getAttribute("role") ?? null,
  };
}

const banc = {
  /** Mesure réelle de l'espace : état connu/inconnu, sans jamais prétendre zéro capacité. */
  async mesurer() {
    const mesure = await budget.measure();
    return {
      state: mesure.state,
      quotaIsNumber: typeof mesure.quota === "number",
      usageIsNumber: typeof mesure.usage === "number",
      available: mesure.available,
      diagnosticCode: mesure.diagnostic?.code ?? null,
    };
  },

  /** Demande réelle de persistance : le verdict ne promet jamais la durabilité sur un refus. */
  async persister() {
    const issue = await budget.requestPersistence();
    return {
      state: issue.state,
      durable: issue.durable,
      diagnosticCode: issue.diagnostic?.code ?? null,
    };
  },

  /** Réservation réelle : sur estimation connue, un besoin absurde déclenche l'avertissement. */
  async reserver(besoin) {
    const verdict = await budget.reserve(besoin);
    const rendu = verdict.diagnostic ? annoncer(verdict.diagnostic) : null;
    return {
      state: verdict.state,
      sufficient: verdict.sufficient,
      available: verdict.available,
      diagnosticCode: verdict.diagnostic?.code ?? null,
      rendu,
    };
  },

  /**
   * Classe un quota dépassé synthétique — un `StorageError` typé de #6, jamais une vraie saturation —
   * et rend le descripteur accessible qui en résulte. Le message ne doit pas porter le texte brut.
   */
  classerQuota() {
    const diagnostic = budget.classifyWriteFailure(
      new StorageError(STORAGE_ERROR_CODES.quotaExceeded, "octets sensibles CONTENU-SECRET-42", {
        operation: "flush",
        volume: "banc",
      }),
      { operation: "flush" },
    );
    const rendu = annoncer(diagnostic);
    return {
      code: diagnostic.code,
      severity: diagnostic.severity,
      volumeReset: diagnostic.context.volumeReset,
      priorDataReadable: diagnostic.context.priorDataReadable,
      leaksContent:
        diagnostic.message.includes("CONTENU-SECRET-42") ||
        JSON.stringify(diagnostic.toJSON()).includes("CONTENU-SECRET-42"),
      rendu,
    };
  },
};

globalThis.bancBudget = banc;
etat.textContent = "Banc budget prêt.";
rapport.textContent = "Prêt à mesurer le budget de stockage.";
