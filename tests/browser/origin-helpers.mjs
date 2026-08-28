// Outils communs aux épreuves de topologie d'origine (#35). Ils ne contiennent aucune assertion :
// les épreuves décident, ces fonctions se contentent de relever ce que le navigateur montre.

import { expect } from "@playwright/test";

import {
  CANARY_AUTHENTIC,
  CANARY_PATH,
  SHELL_ORIGIN,
  SHELL_PATH,
} from "../../src/spike/origin-topology.mjs";

/** Topologie que l'ADR 0002 retient ; les assertions strictes portent sur elle. */
export const TOPOLOGIE_RETENUE = "T2-origine-distincte-sandbox";
/** Topologie la plus permissive, utilisée comme témoin positif des sondes. */
export const TOPOLOGIE_TEMOIN = "T1a-meme-origine-sans-sandbox";
/** Nombre de sondes exécutées par `app-probe.mjs` : un relevé incomplet est un relevé faux. */
export const NOMBRE_DE_SONDES = 20;

const CONSTANTES_STOCKAGE = {
  opfsHostile: "hostile.marker",
  idbName: "vault-shell",
  idbStore: "secrets",
  idbHostileKey: "empreinte-hostile",
};

/** Ouvre la coquille dans une topologie donnée et attend qu'elle soit prête. */
export async function ouvrirCoquille(page, topologie, options = {}) {
  const url = new URL(SHELL_PATH, SHELL_ORIGIN);
  url.searchParams.set("topologie", topologie);
  if (options.isolation) url.searchParams.set("isolation", options.isolation);
  if (options.isolationCadre) url.searchParams.set("isolationCadre", options.isolationCadre);
  if (options.sondeCsp) url.searchParams.set("sondeCsp", "1");
  await page.goto(url.toString());
  await expect(page.locator("html")).toHaveAttribute("data-shell-state", "prete");
}

/** Attend la fin des sondes applicatives et rend leur relevé. */
export async function releverSondes(page) {
  const cadre = page.frameLocator("#app-frame");
  await expect(cadre.locator("#app-status")).toHaveText(/sondes-terminees/, { timeout: 90000 });
  return JSON.parse(await cadre.locator("#app-report").textContent());
}

/** Relevé publié par la coquille elle-même : refus, violations CSP et mesures d'isolation. */
export async function releverCoquille(page) {
  return JSON.parse(await page.locator("#shell-report").textContent());
}

/**
 * Vérifie, DEPUIS la coquille, si l'application a réussi à persister sur l'origine coquille.
 * L'application ne peut pas mentir sur ce point : la mesure a lieu de l'autre côté.
 */
export function contaminationCoquille(page) {
  return page.evaluate(async (noms) => {
    const releve = {};
    try {
      const racine = await navigator.storage.getDirectory();
      const handle = await racine.getFileHandle(noms.opfsHostile);
      releve.opfs = await (await handle.getFile()).text();
    } catch (error) {
      releve.opfs = `absent (${error?.name ?? "Error"})`;
    }
    try {
      releve.indexedDb = await new Promise((resolved, failed) => {
        const requete = indexedDB.open(noms.idbName, 1);
        requete.onupgradeneeded = () => requete.result.createObjectStore(noms.idbStore);
        requete.onerror = () => failed(requete.error ?? new Error("ouverture refusée"));
        requete.onsuccess = () => {
          const lecture = requete.result
            .transaction(noms.idbStore, "readonly")
            .objectStore(noms.idbStore)
            .get(noms.idbHostileKey);
          lecture.onsuccess = () => resolved(lecture.result ?? "absent");
          lecture.onerror = () => failed(lecture.error ?? new Error("lecture refusée"));
        };
      });
    } catch (error) {
      releve.indexedDb = `absent (${error?.name ?? "Error"})`;
    }
    return releve;
  }, CONSTANTES_STOCKAGE);
}

/**
 * Charge la ressource témoin de l'origine coquille depuis un client NEUF : seul un client neuf
 * traverse un Service Worker fraîchement enregistré. Attend jusqu'à `delaiMs` une interception.
 * @returns {Promise<string>} le contenu réellement servi
 */
export async function observerCanary(context, delaiMs = 6000) {
  const echeance = Date.now() + delaiMs;
  for (;;) {
    const victime = await context.newPage();
    await victime.goto(`${SHELL_ORIGIN}${CANARY_PATH}`);
    const servi = (await victime.locator("body").innerText()).trim();
    await victime.close();
    if (servi !== CANARY_AUTHENTIC || Date.now() >= echeance) return servi;
  }
}

/** Index d'un relevé de sondes par nom, pour des assertions lisibles. */
export function parNom(sondes) {
  return Object.fromEntries(sondes.map((sonde) => [sonde.nom, sonde]));
}
