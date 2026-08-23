import { expect, test } from "@playwright/test";

test("la page et un Worker dédié exécutent le contrat du harnais", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-vault-ready", "true");
  await expect(page.getByRole("heading", { name: "RailsBox Vault" })).toBeVisible();
  await expect(page.locator("#worker-status")).toHaveText("worker:ready");
});
