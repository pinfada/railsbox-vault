// B — E2E SUR L'ARBRE PUBLIÉ, EN-TÊTES DE PRODUCTION, SANS HARNAIS (point 8 et constat MEDIUM 4) :
// la VRAIE coquille (index.html, main.mjs, Workers, libv86 : octets de `tools/publier.mjs`, aucun
// modifié) est servie par le SW de la réserve ; l'origine répond « MAUVAIS » à tout le code après
// l'installation ; on déverrouille par la phrase et on démarre la vraie application Rails de
// référence. Le SW est enregistré depuis la page produit par `page.evaluate` (le produit n'enregistre
// pas encore : c'est D1h-b) ; le portail typé n'existe pas non plus dans le produit : les refus ci-dessous
// sont des refus d'OCTETS par le SW, pas des codes de portail (voir P*).
//
// Prérequis : image de référence (`artifacts/reference-image/`, `artifacts/application.json`) et
// artefacts v86 (`npm run vm:fetch`). Budgets de `tests/e2e/parcours-page-rails.spec.mjs`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { demarrer } from "../../publier-servir.mjs";
import { RACINE_DEPOT } from "../banc/reserve.mjs";
import { jusqua, ORIGINE_COQUILLE, PORT_APPLICATION } from "../banc/cadre.mjs";
import { v1 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

const PHRASE = "une phrase de parcours assez longue pour la calibration argon";
const ARBRE_APPLICATION = join(RACINE_DEPOT, "artifacts", "publication-spike", "application");
const BUDGET_DEVERROUILLAGE_MS = 180_000;
const BUDGET_DEMARRAGE_MS = Number(process.env.SPIKE_BUDGET_DEMARRAGE_MS ?? 600_000);

const prealables = () => {
  const manque = [];
  if (!existsSync(join(RACINE_DEPOT, "artifacts", "application.json"))) manque.push("artifacts/application.json");
  if (!existsSync(join(RACINE_DEPOT, "artifacts", "reference-image", "paquet.json"))) manque.push("artifacts/reference-image/");
  if (!existsSync(join(RACINE_DEPOT, "vendor", "v86", "artefacts"))) manque.push("vendor/v86/artefacts");
  if (!existsSync(ARBRE_APPLICATION)) manque.push("artifacts/publication-spike/application");
  return manque;
};
const releve = (page) => page.evaluate(() => JSON.parse(document.querySelector("#coquille-rapport").textContent));

async function monter(t, { sansLeSW = false, hostile = true } = {}) {
  const manque = prealables();
  if (manque.length > 0) throw new Error("préalables absents : " + manque.join(", "));
  const generation = v1({ sansFixtures: true });
  const origine = await t.origineDe(generation);
  const app = await demarrer({ arbre: ARBRE_APPLICATION, host: "localhost", port: PORT_APPLICATION, retires: [] });
  t.origines.push({ arreter: () => app.arreter() });
  const contexte = await t.contexte();
  const page = await contexte.newPage();
  const journal = [];
  page.on("pageerror", (e) => journal.push("pageerror " + e.message.slice(0, 160)));
  page.on("console", (m) => m.type() === "error" && journal.push("console.error " + m.text().slice(0, 160)));
  await page.goto(ORIGINE_COQUILLE + "/index.html");
  if (!sansLeSW) {
    await page.evaluate(async () => {
      const r = await navigator.serviceWorker.register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none" });
      const ver = r.installing ?? r.waiting ?? r.active;
      await new Promise((ok, ko) => {
        const s = () => (ver.state === "activated" ? ok() : ver.state === "redundant" ? ko(new Error("rejetée")) : null);
        ver.addEventListener("statechange", s);
        s();
      });
    });
  }
  origine.hostile = hostile; // à partir d'ici, tout code que le RÉSEAU rendrait est « MAUVAIS »
  origine.vider();
  await page.goto(ORIGINE_COQUILLE + "/index.html?vue=complete");
  return { origine, contexte, page, journal, generation };
}
const requetesDeBoot = (origine) => origine.requetes((r) => r.chemin.startsWith("/artifacts/reference-image/") || /\/v86-[0-9a-f]+\.wasm$/.test(r.chemin));

ajouter(
  "B1",
  "E2E : la vraie coquille publiée derrière le SW (origine hostile après l'installation) déverrouille par la phrase et démarre la vraie application Rails ; tout le code vient du SW",
  async (t) => {
    const { origine, page, journal } = await monter(t);
    const etapes = [];
    const marquer = (nom) => etapes.push([nom, Math.round(Date.now() / 1000)]);
    const prete = await jusqua(() => page.evaluate(() => document.documentElement.dataset.coquille === "prete"), { delaiMs: 90_000 });
    marquer(prete ? "coquille-prete" : "coquille-non-prete");
    t.verifier(prete, "la coquille réelle est prête, contrôlée par le SW, l'origine répondant MAUVAIS à tout code");
    const controlee = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    t.verifier(controlee, "la page produit est contrôlée par le SW");
    const rapport0 = await releve(page);
    t.verifier(rapport0.canalPrivilegie === "etabli", "le Worker de confiance est démarré (octets du SW)");
    await page.fill("#saisie-phrase", PHRASE);
    await page.click("#ouvrir-par-phrase");
    const ouvert = await jusqua(async () => (await releve(page)).etat === "ouvert", { delaiMs: BUDGET_DEVERROUILLAGE_MS, pasMs: 500 });
    marquer(ouvert ? "coffre-ouvert" : "coffre-non-ouvert");
    const etatFinal = ouvert ? "ouvert" : ((await releve(page).catch(() => ({}))).etat ?? "inconnu");
    t.mesure("etatApresDeverrouillage", etatFinal);
    // ATTENDU par moteur (docs/compatibility.md, ADR 0038) : WebKit Playwright n'a pas d'OPFS → « indisponible »
    // (refus du produit, pas du SW) ; Chromium et Firefox ouvrent. Un résultat DIFFÉRENT de l'attendu est un échec.
    if (t.moteur === "webkit") {
      t.verifier(etatFinal === "indisponible", `WebKit : déverrouillage NON PROUVABLE (OPFS absent, refus du produit « ${etatFinal} ») — conforme à la matrice de compatibilité`);
      t.mesure("attendu", "webkit : indisponible (OPFS absent)");
    } else {
      t.verifier(ouvert, "DÉVERROUILLAGE COMPLET : Argon2id (Worker de dérivation réel) puis ouverture du volume, derrière le SW");
    }
    if (ouvert) {
      await page.click("#demarrer-application");
      const verdict = await jusqua(async () => /^cycle:(application-demarree|demarrage-refuse)/.test((await page.locator("#cycle-etat").textContent().catch(() => "")) ?? ""), { delaiMs: BUDGET_DEMARRAGE_MS, pasMs: 2000 });
      const cycle = await page.locator("#cycle-etat").textContent().catch(() => "?");
      marquer("cycle:" + cycle);
      t.mesure("cycle", cycle);
      if (t.moteur === "firefox") {
        // Baseline du dépôt : sous Firefox, Rails n'a jamais répondu dans le guest (ADR 0038). Le témoin B3 mesure
        // la même chose SANS SW ; ici le cycle est relevé, pas exigé.
        t.mesure("attendu", "firefox : boot Rails non prouvé (baseline du dépôt), voir B3");
        t.verifier(cycle === "cycle:application-demarree" || cycle === "cycle:demarrage-en-cours", `Firefox : cycle relevé « ${cycle} » (boot Rails NON PROUVÉ, comme sans SW : B3)`);
      } else {
        t.verifier(cycle === "cycle:application-demarree", `BOOT : ${cycle}`);
      }
      if (cycle === "cycle:application-demarree") {
        const rendue = await jusqua(
          () => page.frameLocator("#document-applicatif").frameLocator("#application-servie").locator("body").getAttribute("data-application-de-reference", { timeout: 2000 }).then((v) => v === "rendue", () => false),
          { delaiMs: 180_000, pasMs: 2000 },
        );
        marquer(rendue ? "rails-rendue" : "rails-non-rendue");
        t.verifier(rendue, "la page de l'application Rails de référence est RENDUE dans le cadre imbriqué");
      }
    }
    t.mesure("etapes", etapes);
    const refus = await page
      .evaluate(
        () =>
          new Promise((ok) => {
            const canal = new MessageChannel();
            canal.port1.onmessage = (e) => ok(e.data.journal);
            navigator.serviceWorker.controller?.postMessage({ type: "journal" }, [canal.port2]);
            setTimeout(() => ok(null), 2000);
          }),
      )
      .catch(() => null);
    t.mesure("refusDuSW", refus);
    t.mesure("journalDePage", journal.slice(0, 12));
    const code = origine.requetes((r) => r.chemin !== "/sw-coquille.mjs" && !r.chemin.startsWith("/artifacts/") && !/\/v86-[0-9a-f]+\.wasm$/.test(r.chemin) && !/\/(seabios|vgabios|linux4)-/.test(r.chemin));
    t.mesure("requetesDeCodeAuReseau", code.map((r) => r.chemin));
    t.verifier(code.length === 0, "AUCUNE requête de code n'a atteint l'origine : chaque octet exécuté vient du SW");
  },
  { delaiMs: 1_500_000 },
);

ajouter(
  "B2",
  "REFUS SANS BOOT sur la vraie coquille : Worker de confiance altéré dans le cache ; argon2.wasm retiré du cache — aucun déverrouillage, aucune requête de boot",
  async (t) => {
    for (const [nom, altere] of [
      ["worker-de-confiance-altere", async (page) => page.evaluate(async () => (await caches.open((await caches.keys())[0])).put("/runtime-worker.mjs", new Response("self.postMessage('altere');"))) ],
      ["argon2-retire", async (page) => page.evaluate(async () => (await caches.open((await caches.keys())[0])).delete("/vendor/argon2/argon2.wasm")) ],
    ]) {
      const { origine, contexte, page } = await monter(t);
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.coquille === "prete"), { delaiMs: 90_000 });
      await altere(page);
      await page.reload();
      await page.waitForLoadState("load");
      await page.waitForTimeout(4000);
      const etat = await page.evaluate(() => ({ coquille: document.documentElement.dataset.coquille ?? null, rapport: JSON.parse(document.querySelector("#coquille-rapport")?.textContent ?? "{}") }));
      let ouvert = false;
      if (nom === "argon2-retire") {
        await page.fill("#saisie-phrase", PHRASE).catch(() => {});
        await page.click("#ouvrir-par-phrase", { timeout: 5000 }).catch(() => {});
        ouvert = Boolean(await jusqua(async () => (await releve(page)).etat === "ouvert", { delaiMs: 20_000, pasMs: 500 }));
      }
      t.mesure(nom, { coquille: etat.coquille, canalPrivilegie: etat.rapport.canalPrivilegie ?? null, etat: etat.rapport.etat ?? null, ouvert, requetesDeBoot: requetesDeBoot(origine).length });
      t.verifier(!ouvert && requetesDeBoot(origine).length === 0, `${nom} : aucun déverrouillage, aucune requête de boot (VM ni image)`);
      if (nom === "worker-de-confiance-altere") t.verifier(etat.rapport.canalPrivilegie !== "etabli", "le canal privilégié n'est pas établi avec un Worker altéré");
      await contexte.close();
      await t.nettoyerLesOrigines(); // le serveur de l'origine applicative aussi (sinon le port 4294 fuit sur les épreuves suivantes)
    }
  },
  { delaiMs: 400_000 },
);

ajouter(
  "B3",
  "TÉMOIN sans SW (Firefox) : la même coquille, servie par le réseau, déverrouille puis démarre-t-elle ? — sépare ce qui tient au SW de ce qui tient au moteur",
  async (t) => {
    const { page } = await monter(t, { sansLeSW: true, hostile: false });
    const prete = await jusqua(() => page.evaluate(() => document.documentElement.dataset.coquille === "prete"), { delaiMs: 90_000 });
    t.verifier(prete, "coquille prête (sans SW)");
    await page.fill("#saisie-phrase", PHRASE);
    await page.click("#ouvrir-par-phrase");
    const ouvert = await jusqua(async () => (await releve(page)).etat === "ouvert", { delaiMs: BUDGET_DEVERROUILLAGE_MS, pasMs: 500 });
    t.mesure("ouvertSansSW", Boolean(ouvert));
    if (ouvert) {
      await page.click("#demarrer-application");
      await jusqua(async () => /^cycle:(application-demarree|demarrage-refuse)/.test((await page.locator("#cycle-etat").textContent().catch(() => "")) ?? ""), { delaiMs: BUDGET_DEMARRAGE_MS, pasMs: 2000 });
      const cycle = await page.locator("#cycle-etat").textContent().catch(() => "?");
      t.mesure("cycleSansSW", cycle);
    }
    t.note("Épreuve-témoin : son verdict est une MESURE (cycleSansSW), pas une exigence. Si le cycle reste « demarrage-en-cours » sans SW sur ce moteur, le blocage de B1 n'est pas imputable au SW.");
    t.verifier(Boolean(ouvert), "déverrouillage sans SW (référence pour B1)");
  },
  { delaiMs: 900_000, moteurs: ["firefox"] },
);
