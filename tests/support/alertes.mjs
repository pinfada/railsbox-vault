import { expect } from "@playwright/test";

/**
 * Aucune alerte n'a de texte (#302, ADR 0043).
 *
 * Application démarrée, le panneau du parcours est `visibility: hidden` : une région d'alerte vide
 * n'est plus dans l'arbre d'accessibilité, et `getByRole('alert')` ne la trouve plus. On lit donc le
 * DOCUMENT, cachée ou non.
 */
export async function exigerAucuneAlerteAvecTexte(page, message = "aucune alerte") {
  await expect(page.locator('[role="alert"]:not(:empty)'), message).toHaveCount(0);
}
