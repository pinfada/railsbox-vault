// Messages UI accessibles des diagnostics de budget (#9). Cette couche NE rend pas de DOM : elle
// produit un descripteur pur — un rôle ARIA et un texte — que n'importe quelle coquille peut poser
// dans un conteneur vivant. La séparation garde le module de budget indépendant du navigateur et rend
// l'accessibilité testable sans page.
//
// La règle WCAG appliquée est minimale mais réelle :
//
//  - une ERREUR (quota dépassé) est annoncée par `role="alert"` (région live assertive) : elle
//    interrompt, car une mutation vient d'échouer ;
//  - un AVERTISSEMENT ou une INFO (espace faible, persistance refusée, estimation inconnue) prend
//    `role="status"` (région live polie) : il informe sans interrompre.
//
// Le texte porte toujours le message ET l'action de récupération sûre, jamais le contenu utilisateur.

import { BUDGET_SEVERITY } from "./storage-budget.mjs";

/** Rôle ARIA associé à chaque sévérité. Une erreur interrompt ; le reste informe. */
const ROLE_BY_SEVERITY = Object.freeze({
  [BUDGET_SEVERITY.error]: "alert",
  [BUDGET_SEVERITY.warning]: "status",
  [BUDGET_SEVERITY.info]: "status",
});

/**
 * Transforme un diagnostic en descripteur accessible.
 *
 * @param {import("./storage-budget.mjs").BudgetDiagnostic} diagnostic
 * @returns {{ role: string, code: string, severity: string, text: string }}
 */
export function describeDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic.code !== "string") {
    throw new Error("describeDiagnostic attend un diagnostic de budget.");
  }
  const role = ROLE_BY_SEVERITY[diagnostic.severity] ?? "status";
  const text = `${diagnostic.message} ${diagnostic.recoveryText}`.trim();
  return { role, code: diagnostic.code, severity: diagnostic.severity, text };
}
