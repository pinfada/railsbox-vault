// Rendu accessible de la conduite de persistance (#42). Comme pour #9, cette couche NE rend pas de
// DOM : elle produit un descripteur pur — un rôle ARIA, l'état de coquille, la promesse de durabilité
// et un texte français — que n'importe quelle coquille peut poser dans une région vivante. La
// séparation garde la logique de conduite indépendante du navigateur et rend l'accessibilité testable
// sans page.
//
// Le rôle ARIA suit la convention de #9 : un état informatif ou d'avertissement prend `role="status"`
// (région polie), il informe sans interrompre. La conduite ne produit jamais d'`role="alert"` de son
// propre chef — l'alerte reste réservée à une mutation qui vient d'échouer (le quota dépassé de #9).
//
// Sur un état volatile qualifié transportant un diagnostic de #9, le texte accessible est RÉUTILISÉ
// tel quel via `describeDiagnostic` : le message de refus et son action « poursuivre ou s'arrêter »
// sont ceux de #9, jamais une copie.

import { describeDiagnostic } from "./storage-budget-messages.mjs";
import {
  DURABILITY_PROMISE,
  SHELL_STATES,
} from "./persistence-conduct.mjs";

/** Texte accessible propre à chaque état de coquille dépourvu de diagnostic #9. */
const TEXT_BY_STATE = Object.freeze({
  [SHELL_STATES.consentRequired]:
    "La persistance du stockage n'est demandée qu'à la suite d'un geste explicite de l'utilisateur. Aucune durabilité n'est promise tant que ce consentement n'est pas recueilli.",
  [SHELL_STATES.durableGuaranteed]:
    "Le navigateur a accordé la persistance : le stockage est durable et ne sera pas évincé sans une action de l'utilisateur.",
  [SHELL_STATES.awaitingResolution]:
    "La demande de persistance n'a pas encore été tranchée par le navigateur : l'invite reste en attente. Aucune durabilité n'est promise et aucune poursuite n'est décidée tant que la réponse n'est pas rendue.",
  [SHELL_STATES.qualifiedVolatile]:
    "La persistance n'est pas garantie : les données peuvent être évincées par le navigateur. Poursuivre reste possible mais SANS garantie de durabilité, ou s'arrêter — le choix appartient à l'utilisateur.",
  [SHELL_STATES.halted]:
    "La durabilité ne peut être garantie et l'utilisateur a choisi de s'arrêter plutôt que de poursuivre sans garantie. Aucune donnée n'est écrite sans durabilité assurée.",
});

/**
 * Transforme une conduite en descripteur accessible.
 *
 * @param {import("./persistence-conduct.mjs").ShellConduct} conduct
 * @returns {{ role: string, shellState: string, durability: string, text: string }}
 */
export function describeConduct(conduct) {
  if (!conduct || typeof conduct.shellState !== "string") {
    throw new Error("describeConduct attend une conduite de persistance.");
  }
  // Un verdict de refus transporte le diagnostic #9 : on réutilise SON texte accessible.
  if (conduct.diagnostic) {
    const base = describeDiagnostic(conduct.diagnostic);
    return {
      role: base.role,
      shellState: conduct.shellState,
      durability: conduct.durability ?? DURABILITY_PROMISE.unknown,
      text: base.text,
    };
  }
  const text = TEXT_BY_STATE[conduct.shellState];
  if (!text) {
    throw new Error(`État de coquille sans texte accessible : ${conduct.shellState}`);
  }
  return {
    role: "status",
    shellState: conduct.shellState,
    durability: conduct.durability ?? DURABILITY_PROMISE.unknown,
    text,
  };
}
