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
  // Et la région des refus EXISTE, en `role="alert"`, VIDE : sans cela, une page qui n'aurait plus de
  // région d'alerte réussirait le contrôle, là où l'ancien `getByRole('alert')…toBeEmpty()` l'exigeait.
  const refus = page.locator("#parcours-refus");
  await expect(refus, `${message} : la région #parcours-refus existe`).toHaveCount(1);
  await expect(refus, `${message} : #parcours-refus est une alerte`).toHaveAttribute(
    "role",
    "alert",
  );
  await expect(refus, `${message} : #parcours-refus est vide`).toBeEmpty();
}
