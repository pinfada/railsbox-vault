// SUPPORT des épreuves de COURSE ENTRE ONGLETS (#311, C5) : les gestes de la coquille qu'elles
// enchaînent, et le POINT D'ARRÊT qui retient un Worker de produit (`tools/harnais-point-d-arret.mjs`,
// servi sous `playwright.course-onglets.config.mjs` et nulle part ailleurs).

import { expect } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { CANAL_DU_HARNAIS } from "../../tools/harnais-point-d-arret.mjs";

/**
 * L'AUTRE nom du même serveur — `--alias localhost` de la configuration — donc un OPFS que les pages de
 * `127.0.0.1` n'ont pas touché. Le port est celui de `playwright.course-onglets.config.mjs`.
 */
export const ORIGINE_ALIAS = "http://localhost:4188";

export const DELAI = 120_000;
export const PHRASE = "une phrase de course entre onglets assez longue pour la calibration";

export const releve = async (page) =>
  JSON.parse(await page.locator("#coquille-rapport").textContent());

export async function ouvrirLaCoquille(page, origine = "") {
  await page.goto(`${origine}/index.html?vue=complete`, { waitUntil: "commit" });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", /prete|sans-cadre/, {
    timeout: DELAI,
  });
}

export async function attendreLEtat(page, etat) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe(etat);
}

/** WebKit : pas d'OPFS synchrone dans un Worker, la coquille publie `indisponible`. */
export async function sansOpfsSynchrone(page) {
  return (await releve(page)).etat === ETATS_DU_VOLUME.indisponible;
}

// --- Le point d'arrêt -------------------------------------------------------------------------------

/**
 * L'écouteur de la PAGE, posé APRÈS la navigation : un `goto` détruit le contexte d'avant. Le canal
 * est celui du harnais ; la page émet les ordres, les Workers instrumentés les exécutent.
 */
export async function ecouterLePointDArret(page) {
  await page.evaluate((canal) => {
    globalThis.__pointDArret = { atteint: null, canal: new BroadcastChannel(canal) };
    globalThis.__pointDArret.canal.onmessage = ({ data }) => {
      if (data?.atteint !== undefined) globalThis.__pointDArret.atteint = data.atteint;
    };
  }, CANAL_DU_HARNAIS);
}

/** Arme la pause : `"*"` retient la PREMIÈRE prise de handle, un nom retient celle de ce fichier. */
export const armer = (page, cible = "*") =>
  page.evaluate((nom) => globalThis.__pointDArret.canal.postMessage({ armer: nom }), cible);

/** Retire l'armement des Workers qui ne l'ont pas consommé : à envoyer dès la pause atteinte. */
export const desarmer = (page) =>
  page.evaluate(() => globalThis.__pointDArret.canal.postMessage("desarmer"));

export const reprendre = (page) =>
  page.evaluate(() => globalThis.__pointDArret.canal.postMessage("reprendre"));

/** Attend qu'un Worker ait atteint la pause, et rend le NOM du fichier qu'il allait ouvrir. */
export async function pauseAtteinte(page) {
  await expect
    .poll(() => page.evaluate(() => globalThis.__pointDArret.atteint), { timeout: DELAI })
    .not.toBeNull();
  return page.evaluate(() => globalThis.__pointDArret.atteint);
}

// --- Les gestes -------------------------------------------------------------------------------------

export async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
}

/** Ouvre par la phrase, imprime un code de récupération, et rend ce code avec sa version. */
export async function ouvrirEtImprimerUnCode(page) {
  await ouvrirParLaPhrase(page);
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
  await page.click("#creer-recuperation");
  await expect(page.locator("#feuille-code")).not.toBeEmpty({ timeout: DELAI });
  const version = (await page.locator("#feuille-version").textContent()).match(/\d+/)[0];
  return { code: (await page.locator("#feuille-code").textContent()).trim(), version };
}

export async function ouvrirParLeCode(page, { code, version }) {
  await page.fill("#ancre-version", version);
  await page.fill("#saisie-code", code);
  await expect(page.locator("#ouvrir-par-code")).toBeEnabled();
  await page.click("#ouvrir-par-code");
}

/** VERROUILLE : le Worker meurt, le handle est libre, la coquille se recharge d'elle-même. */
export async function verrouiller(page) {
  await page.evaluate(() => {
    globalThis.__documentDAvantLeVerrouillage = true;
  });
  await page.locator("#verrouiller-le-coffre").click();
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() => globalThis.__documentDAvantLeVerrouillage === undefined);
        } catch {
          return false; // contexte détruit par la navigation : c'est le rechargement
        }
      },
      { timeout: DELAI },
    )
    .toBe(true);
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
}

/** Révoque tout sauf soi (si `revoquer`), puis verrouille. */
export async function revoquerPuisVerrouiller(page, { dejaRevoque = false } = {}) {
  if (!dejaRevoque) {
    await page.click("#revoquer-en-urgence");
    await expect(page.locator("#portabilite-etat")).toContainText("portabilite:revoque:1-retires", {
      timeout: DELAI,
    });
  }
  await verrouiller(page);
}
