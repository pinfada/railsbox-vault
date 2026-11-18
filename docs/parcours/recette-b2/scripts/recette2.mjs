/* global document, getComputedStyle, location, PerformanceObserver, console, process, setTimeout */
/* eslint-disable no-empty */
// Scénarios B (rechargement à l'étape 4 puis réouverture), C (restauration sur appareil vierge), T (CPU ralenti : attentes, verrouillage, profil).
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const [origine, sortie, largeurArg = "360", ralentiArg = "1"] = process.argv.slice(2);
const largeur = Number(largeurArg),
  ralenti = Number(ralentiArg);
const PHRASE = "une phrase publique pour la recette du lot B2";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(sortie, { recursive: true });
const res = { largeur, ralenti };
const navigateur = await chromium.launch();
const ctx = await navigateur.newContext({
  viewport: { width: largeur, height: 900 },
  reducedMotion: "reduce",
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const titre = (t) => page.getByRole("heading", { level: 2, name: t, exact: true });
const bouton = (n) => page.getByRole("button", { name: n, exact: true });
const ok = (loc, t = 240_000) => loc.waitFor({ state: "visible", timeout: t });
const photo = async (e) => {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${sortie}/${e}.png`, fullPage: true });
};
const lire = () =>
  page.evaluate(() => ({
    titre: document.getElementById("parcours-titre")?.textContent,
    rang: document.getElementById("parcours-rang")?.textContent,
    suivante: document.getElementById("parcours-suivante")?.textContent,
    attente: document.getElementById("parcours-attente")?.textContent,
    url: location.search,
    btnPhrase: (() => {
      const b = document.getElementById("ouvrir-par-phrase");
      return (
        b && {
          disabled: b.disabled,
          busy: b.getAttribute("aria-busy"),
          bg: getComputedStyle(b).backgroundColor,
          visible: b.offsetParent !== null,
        }
      );
    })(),
    btnCode: (() => {
      const b = document.getElementById("ouvrir-par-code");
      return (
        b && {
          disabled: b.disabled,
          bg: getComputedStyle(b).backgroundColor,
          visible: b.offsetParent !== null,
        }
      );
    })(),
    ce: document.getElementById("parcours-ce-qui-va-se-passer")?.textContent.slice(0, 120),
  }));
const suivre = async (declencheur, arret, nom, photoA = 3, max = 4000) => {
  const t0 = Date.now();
  await declencheur();
  const s = [];
  let p = false;
  for (let i = 0; i < max; i++) {
    const e = await lire();
    s.push({ ms: Date.now() - t0, ...e });
    if (arret(e)) break;
    if (i === photoA && !p) {
      p = true;
      await photo(nom);
    }
    await dormir(120);
  }
  return {
    ms: Date.now() - t0,
    premiereAnnonceMs: s.find((x) => /en cours/.test(x.attente ?? ""))?.ms ?? null,
    echantillons: s.filter((_, i, a) => i % 4 === 0 || i === a.length - 1).slice(0, 25),
  };
};
await page.goto(`${origine}/index.html`);
await ok(titre("Créer votre coffre"));
await dormir(1500);
if (ralenti > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: ralenti });
await bouton("Commencer").click();
await ok(titre("Choisir comment l'ouvrir"));
await page.locator("#saisie-phrase").fill(PHRASE);
res.creation = await suivre(
  () => bouton("Créer mon coffre").click(),
  (e) => e.titre !== "Choisir comment l'ouvrir",
  "T-creation-en-cours",
);
await ok(titre("Recevoir votre code de récupération"));
await bouton("Afficher mon code de récupération").click();
await page.waitForFunction(
  () =>
    /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/.test(
      document.getElementById("feuille-code").textContent.trim(),
    ),
  null,
  { timeout: 240_000 },
);
const code = (await page.locator("#feuille-code").textContent()).trim();
await bouton("J'ai recopié mon code").click();
await ok(titre("Vérifier votre code de récupération"));
// M4 : profil du verrouillage
await ctx.exposeBinding("__lt", (_s, d, t) =>
  (res.longtasks ??= []).push({ d: Math.round(d), t: Math.round(t) }),
);
await ctx.addInitScript(() => {
  try {
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => globalThis.__lt?.(e.duration, e.startTime)),
    ).observe({ entryTypes: ["longtask"] });
  } catch {}
});
await navigateur.startTracing(page, {
  path: `${sortie}/trace-verrouillage.json`,
  categories: ["devtools.timeline", "v8.execute", "disabled-by-default-devtools.timeline"],
});
const tv = Date.now();
const l = page.waitForEvent("load");
await bouton("Verrouiller mon coffre").click();
await l;
await ok(page.getByLabel("Code de récupération", { exact: true }));
res.verrouillage = { msJusquauChamp: Date.now() - tv };
await navigateur.stopTracing();
await dormir(500);
res.codeParCode = await suivre(
  async () => {
    await page.getByLabel("Code de récupération", { exact: true }).fill(code);
    await dormir(200);
    await bouton("Ouvrir mon coffre avec le code").click();
  },
  (e) => e.titre === "Travailler dans l'application",
  "T-ouverture-code-en-cours",
);
await ok(titre("Travailler dans l'application"));
await photo("T-etape4-avant-demarrage");
res.carteEtape4 = await page.evaluate(() => {
  const r = document.querySelector("main").getBoundingClientRect();
  return { w: Math.round(r.width), x: Math.round(r.x) };
});
// B : rechargement à l'étape 4 (coffre verrouillé), réouverture par la phrase
const l2 = page.waitForEvent("load");
await page.reload();
await l2;
await dormir(1500);
res.apresRechargement = await lire();
await photo("B-apres-rechargement-etape4");
if (await page.locator("#saisie-phrase").isVisible()) {
  await page.locator("#saisie-phrase").fill(PHRASE);
  res.reouverturePhrase = await suivre(
    () => bouton("Ouvrir mon coffre").click(),
    (e) =>
      (e.titre !== "Rouvrir votre coffre" && e.titre !== "Vérifier votre code de récupération") ||
      false,
    "B-reouverture-phrase-en-cours",
  );
  await dormir(800);
  res.apresReouverture = await lire();
  await photo("B-apres-reouverture");
}
// C : appareil vierge, « J'ai déjà une sauvegarde »
const vierge = await navigateur.newContext({ viewport: { width: largeur, height: 900 } });
const p2 = await vierge.newPage();
await p2.goto(`${origine}/index.html`);
await dormir(2000);
await p2.getByRole("button", { name: "J'ai déjà une sauvegarde", exact: true }).click();
await dormir(800);
res.restaurationVierge = await p2.evaluate(() => ({
  titre: document.getElementById("parcours-titre")?.textContent,
  rang: document.getElementById("parcours-rang")?.textContent,
  suivante: document.getElementById("parcours-suivante")?.textContent,
  ou: [...document.querySelectorAll("#ou-suis-je-liste li")].map((x) => x.textContent),
}));
await p2.mouse.move(0, 0);
await p2.screenshot({ path: `${sortie}/C-restauration-vierge.png`, fullPage: true });
await navigateur.close();
await writeFile(`${sortie}/mesures2.json`, JSON.stringify(res, null, 2));
console.log(
  JSON.stringify(
    {
      ...res,
      creation: { ms: res.creation.ms, premiere: res.creation.premiereAnnonceMs },
      codeParCode: { ms: res.codeParCode.ms, premiere: res.codeParCode.premiereAnnonceMs },
      reouverturePhrase: res.reouverturePhrase && {
        ms: res.reouverturePhrase.ms,
        premiere: res.reouverturePhrase.premiereAnnonceMs,
      },
    },
    null,
    1,
  ),
);
