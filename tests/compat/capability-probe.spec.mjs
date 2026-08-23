import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { platform, release } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  CAPABILITIES,
  REQUIRED_CAPABILITY_IDS,
  finalizeCompatReport,
  validateCompatReport,
} from "../../src/compat/capability-contract.mjs";

const playwrightVersion = createRequire(import.meta.url)("@playwright/test/package.json").version;
const reportDirectory = fileURLToPath(new URL("../../reports/compat/", import.meta.url));

/**
 * Exécute la sonde dans le moteur courant et renvoie le rapport finalisé.
 * Toute erreur de page est remontée : une sonde qui plante doit faire échouer la suite.
 */
async function collectReport({ page, browser, browserName }) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name} : ${error.message}`));

  await page.goto("/compat.html");
  // Attendre un état terminal plutôt que « done » : un échec de sonde est ainsi rapporté avec sa
  // cause au lieu d'expirer silencieusement au bout du délai.
  await expect(page.locator("html")).toHaveAttribute("data-compat-state", /done|failed/, {
    timeout: 60_000,
  });

  const state = await page.getAttribute("html", "data-compat-state");
  const probeError = await page.evaluate(() => globalThis.railsboxCompatError ?? null);
  expect(state, `sonde en échec : ${probeError ?? "cause inconnue"}`).toBe("done");

  const probeReport = await page.evaluate(() => globalThis.railsboxCompatReport);
  expect(pageErrors, "la sonde ne doit produire aucune erreur de page non capturée").toEqual([]);

  return finalizeCompatReport(probeReport, {
    engine: browserName,
    engineVersion: browser.version(),
    playwrightVersion,
    os: platform(),
    osRelease: release(),
    node: process.version,
    recordedAt: new Date().toISOString(),
  });
}

test.describe("matrice de compatibilité", () => {
  test("la sonde publie un rapport de capacités conforme au schéma", async ({
    page,
    browser,
    browserName,
  }, testInfo) => {
    const report = await collectReport({ page, browser, browserName });
    const serialised = `${JSON.stringify(report, null, 2)}\n`;

    await mkdir(reportDirectory, { recursive: true });
    await writeFile(`${reportDirectory}${browserName}.json`, serialised, "utf8");
    await testInfo.attach(`compat-${browserName}.json`, {
      body: serialised,
      contentType: "application/json",
    });

    const { valid, problems } = validateCompatReport(report);
    expect(problems, "rapport malformé").toEqual([]);
    expect(valid).toBe(true);

    expect(report.runner.engine).toBe(browserName);
    expect(report.runner.engineVersion).not.toBe("");
    expect(report.agent.userAgent).not.toBe("");
    expect(JSON.parse(serialised)).toEqual(report);
  });

  test("chaque capacité déclarée reçoit un verdict argumenté, jamais un faux succès", async ({
    page,
    browser,
    browserName,
  }) => {
    const report = await collectReport({ page, browser, browserName });
    const byId = new Map(report.capabilities.map((entry) => [entry.id, entry]));

    for (const capability of CAPABILITIES) {
      const entry = byId.get(capability.id);
      expect(entry, `capacité ${capability.id} absente du rapport`).toBeDefined();
      expect(entry.context).toBe(capability.context);
      expect(entry.detail.trim(), `détail vide pour ${capability.id}`).not.toBe("");
    }

    const measured = REQUIRED_CAPABILITY_IDS.map((id) => byId.get(id).verdict);
    const allSupported = measured.every((verdict) => verdict === "supported");
    expect(report.vaultVerdict.supported).toBe(allSupported);
    expect(report.vaultVerdict.status).not.toBe("supporté");
  });
});
