/* global document, getComputedStyle, location, scrollY, PerformanceObserver, console, process, setTimeout */
/* eslint-disable no-empty */
// Recette QA ciblée du lot B2 (Chromium, Playwright). Usage : node recette.mjs <origine> <dossier> [largeur theme]...
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

const [origine, sortie, ...reste] = process.argv.slice(2);
const runs = [];
for (let i = 0; i < reste.length; i += 2)
  runs.push({ largeur: Number(reste[i]), theme: reste[i + 1] });
if (runs.length === 0)
  runs.push(
    { largeur: 360, theme: "light" },
    { largeur: 1280, theme: "light" },
    { largeur: 360, theme: "dark" },
    { largeur: 1280, theme: "dark" },
  );
const PHRASE = "une phrase publique pour la recette du lot B2";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function jouer({ largeur, theme }) {
  const nom = `${largeur}-${theme}`;
  const dossier = `${sortie}/${nom}`;
  await mkdir(dossier, { recursive: true });
  const mesures = { nom, console: [], reponsesEnErreur: [], longtasks: [], etapes: {} };
  const navigateur = await chromium.launch();
  const contexte = await navigateur.newContext({
    viewport: { width: largeur, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await contexte.exposeBinding("__longtask", (_s, d, t) =>
    mesures.longtasks.push({ d: Math.round(d), t: Math.round(t) }),
  );
  await contexte.addInitScript(() => {
    try {
      new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => globalThis.__longtask?.(e.duration, e.startTime)),
      ).observe({ entryTypes: ["longtask"] });
    } catch {}
  });
  const page = await contexte.newPage();
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type()))
      mesures.console.push(`${m.type()}: ${m.text()}`.slice(0, 300));
  });
  page.on("response", (r) => {
    if (r.status() >= 400) mesures.reponsesEnErreur.push(`${r.status()} ${r.url()}`);
  });
  const txt = async (sel) =>
    (
      await page
        .locator(sel)
        .first()
        .textContent()
        .catch(() => null)
    )
      ?.replace(/\s+/g, " ")
      .trim() ?? null;
  const photo = async (etiquette) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${dossier}/${etiquette}.png`, fullPage: true });
  };
  const titre = (t) => page.getByRole("heading", { level: 2, name: t, exact: true });
  const bouton = (n) => page.getByRole("button", { name: n, exact: true });
  const attendreChargement = async (declencheur) => {
    const l = page.waitForEvent("load");
    await declencheur();
    await l;
    await page.waitForLoadState("load");
  };
  const etat = async () =>
    page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      const cs = (id) => {
        const e = g(id);
        return e ? getComputedStyle(e) : null;
      };
      const b = (id) => {
        const e = id === "main" ? document.querySelector("main") : g(id);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y + scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      return {
        url: location.search,
        titre: g("parcours-titre")?.textContent,
        rang: g("parcours-rang")?.textContent,
        suivante: g("parcours-suivante")?.textContent,
        attente: g("parcours-attente")?.textContent,
        reussite: g("parcours-reussite")?.textContent,
        refus: g("parcours-refus")?.textContent,
        refusParent:
          g("parcours-refus")?.parentElement?.id || g("parcours-refus")?.parentElement?.tagName,
        refusBox: b("parcours-refus"),
        attenteAnnoncee: g("parcours-attente-annoncee")?.textContent,
        conseil: g("phrase-conseil")?.textContent,
        continuer: g("parcours-continuer")?.textContent,
        principal: [...document.querySelectorAll("button[data-principal]")]
          .filter((x) => x.offsetParent !== null)
          .map((x) => x.id),
        champPhrase: g("saisie-phrase")
          ? {
              invalid: g("saisie-phrase").getAttribute("aria-invalid"),
              describedby: g("saisie-phrase").getAttribute("aria-describedby"),
              box: b("saisie-phrase"),
            }
          : null,
        champCode: g("saisie-code")
          ? {
              invalid: g("saisie-code").getAttribute("aria-invalid"),
              describedby: g("saisie-code").getAttribute("aria-describedby"),
              box: b("saisie-code"),
              scrollW: g("saisie-code").scrollWidth,
              clientW: g("saisie-code").clientWidth,
            }
          : null,
        codeLu: g("parcours-code-lu")?.textContent,
        boutonsBox: {
          phrase: b("ouvrir-par-phrase"),
          code: b("ouvrir-par-code"),
          verrouiller: b("verrouiller-le-coffre"),
          commencer: b("parcours-commencer"),
        },
        boutonPhrase: g("ouvrir-par-phrase")
          ? {
              disabled: g("ouvrir-par-phrase").disabled,
              busy: g("ouvrir-par-phrase").getAttribute("aria-busy"),
              bg: cs("ouvrir-par-phrase").backgroundColor,
            }
          : null,
        boutonCode: g("ouvrir-par-code")
          ? {
              disabled: g("ouvrir-par-code").disabled,
              busy: g("ouvrir-par-code").getAttribute("aria-busy"),
              bg: cs("ouvrir-par-code").backgroundColor,
            }
          : null,
        carte: b("main"),
        ombre: cs("parcours-titre") && getComputedStyle(document.querySelector("main")).boxShadow,
        corps: {
          ceQuiVaSePasser: cs("parcours-ce-qui-va-se-passer")?.fontSize,
          attendu: cs("parcours-attendu")?.fontSize,
          label: document.querySelector("label")
            ? getComputedStyle(document.querySelector("label")).fontSize
            : null,
          rang: cs("parcours-rang")?.fontSize,
          refus: cs("parcours-refus")?.fontSize,
          conseil: cs("phrase-conseil")?.fontSize,
        },
        ouSuisJe: [...document.querySelectorAll("#ou-suis-je-liste li")].map((l) => l.textContent),
        ancre: g("ancre-version")
          ? {
              visible: g("ancre-version").offsetParent !== null,
              label: g("ancre-version").labels?.[0]?.textContent,
              type: g("ancre-version").type,
            }
          : null,
        ce: g("parcours-ce-qui-va-se-passer")?.textContent,
        attendu: g("parcours-attendu")?.textContent,
        version: g("version-de-l-application")?.textContent,
        consigne: g("parcours-consigne-feuille")?.textContent,
      };
    });
  const noter = async (cle, extra = {}) => {
    mesures.etapes[cle] = { ...(await etat()), ...extra };
  };

  await page.goto(`${origine}/index.html`);
  await expect(titre("Créer votre coffre"));
  async function expect(loc, t = 90_000) {
    await loc.waitFor({ state: "visible", timeout: t });
  }
  await page.locator("#parcours-attente-annoncee").waitFor({ state: "attached" });
  await dormir(1500);
  await noter("01-creer");
  await photo("01-creer");

  await bouton("Commencer").click();
  await expect(titre("Choisir comment l'ouvrir"));
  await noter("02-choisir");
  await photo("02-choisir");

  // Phrase trop courte : conseil, puis refus au clic
  await page.locator("#saisie-phrase").fill("trop court");
  await dormir(300);
  await noter("02b-phrase-courte");
  await photo("02b-phrase-courte");
  await page.locator("#saisie-phrase").fill(PHRASE);
  await dormir(300);
  await noter("02c-phrase-ok");
  await photo("02c-phrase-ok");

  // Création : on suit l'écran pendant le calcul
  const t0 = Date.now();
  await bouton("Créer mon coffre").click();
  const suivi = [];
  for (let i = 0; i < 40; i++) {
    const e = await page.evaluate(() => ({
      t: document.getElementById("parcours-titre")?.textContent,
      att: document.getElementById("parcours-attente")?.textContent,
      champ: document.getElementById("saisie-phrase")?.value?.length ?? null,
      btn: document.getElementById("ouvrir-par-phrase")?.disabled,
      busy: document.getElementById("ouvrir-par-phrase")?.getAttribute("aria-busy"),
    }));
    suivi.push({ ms: Date.now() - t0, ...e });
    if (e.t !== "Choisir comment l'ouvrir") break;
    if (i === 3) await photo("02d-creation-en-cours");
    await dormir(150);
  }
  mesures.creation = {
    ms: Date.now() - t0,
    suivi: suivi.filter((_, i, a) => i < 6 || i === a.length - 1),
  };
  await expect(titre("Recevoir votre code de récupération"));
  await noter("03-code-annonce");
  await photo("03-code-annonce");
  await bouton("Afficher mon code de récupération").click();
  await page.locator("#feuille-code").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/.test(
      document.getElementById("feuille-code").textContent.trim(),
    ),
  );
  const code = (await txt("#feuille-code")).trim();
  await noter("04-code-feuille");
  await photo("04-code-feuille");
  await bouton("J'ai recopié mon code").click();
  await expect(titre("Vérifier votre code de récupération"));
  await noter("05-code-a-verrouiller");
  await photo("05-code-a-verrouiller");

  // Verrouillage : durée et tâches longues
  mesures.longtasks.length = 0;
  const tv = Date.now();
  await attendreChargement(() => bouton("Verrouiller mon coffre").click());
  const champCode = page.getByLabel("Code de récupération", { exact: true });
  await expect(champCode);
  mesures.verrouillage = { msJusquauChamp: Date.now() - tv, longtasks: [...mesures.longtasks] };
  await dormir(500);
  await noter("06-code-verifier");
  await photo("06-code-verifier");
  // code faux (valide en forme, mauvais) puis à moitié tapé
  await champCode.fill(code.slice(0, 20));
  await dormir(300);
  await noter("06b-code-incomplet");
  await photo("06b-code-incomplet");
  const faux = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
  await champCode.fill(faux);
  await dormir(300);
  await noter("06c-code-faux");
  await photo("06c-code-faux");
  await champCode.fill(code);
  await dormir(300);
  await noter("06d-code-juste");
  await photo("06d-code-juste");

  // Ouverture par le code : on suit l'attente
  const to = Date.now();
  await bouton("Ouvrir mon coffre avec le code").click();
  const suiviO = [];
  for (let i = 0; i < 120; i++) {
    const e = await etat();
    suiviO.push({
      ms: Date.now() - to,
      titre: e.titre,
      att: e.attente,
      url: e.url,
      btn: e.boutonCode,
    });
    if (e.titre === "Travailler dans l'application") break;
    if (i === 4) await photo("06e-ouverture-en-cours");
    await dormir(100);
  }
  const premier = suiviO.find((s) => s.att && /Ouverture en cours/.test(s.att));
  mesures.ouvertureParCode = {
    ms: Date.now() - to,
    premiereAnnonceMs: premier?.ms ?? null,
    suivi: suiviO.filter((_, i, a) => i % 5 === 0 || i === a.length - 1).slice(0, 14),
  };
  await expect(titre("Travailler dans l'application"));
  await dormir(500);
  await noter("07-travailler");
  await photo("07-travailler");

  // Étape 5 : verrouiller
  await bouton("Continuer : Verrouiller et rouvrir").click();
  await expect(titre("Verrouiller votre coffre"));
  await noter("08-verrouiller");
  await photo("08-verrouiller");
  await attendreChargement(() => bouton("Verrouiller mon coffre").click());
  await expect(titre("Rouvrir votre coffre"));
  await dormir(500);
  await noter("09-rouvrir");
  await photo("09-rouvrir");

  // Mauvaise phrase : place, ARIA, effacement à la frappe
  await page.locator("#saisie-phrase").fill("une mauvaise phrase tout autre");
  const tm = Date.now();
  await bouton("Ouvrir mon coffre").click();
  await page.locator("#parcours-refus:not(:empty)").waitFor({ timeout: 90_000 });
  mesures.phraseFausse = { ms: Date.now() - tm };
  await dormir(300);
  await noter("09b-phrase-fausse");
  await photo("09b-phrase-fausse");
  await page.locator("#saisie-phrase").pressSequentially("x");
  await dormir(300);
  await noter("09c-refus-efface");
  await photo("09c-refus-efface");

  // Bonne phrase : on suit « Ouverture en cours »
  await page.locator("#saisie-phrase").fill(PHRASE);
  const tp = Date.now();
  await bouton("Ouvrir mon coffre").click();
  const suiviP = [];
  for (let i = 0; i < 120; i++) {
    const e = await etat();
    suiviP.push({ ms: Date.now() - tp, titre: e.titre, att: e.attente, btn: e.boutonPhrase });
    if (e.titre === "Sauvegarder votre coffre") break;
    if (i === 3) await photo("09d-ouverture-phrase-en-cours");
    await dormir(100);
  }
  mesures.ouvertureParPhrase = {
    ms: Date.now() - tp,
    suivi: suiviP.filter((_, i, a) => i % 5 === 0 || i === a.length - 1).slice(0, 12),
  };
  await expect(titre("Sauvegarder votre coffre"));
  await dormir(500);
  await noter("10-sauvegarder");
  await photo("10-sauvegarder");

  await bouton("Sauvegarder mon coffre").click();
  await page.locator("#parcours-refus:not(:empty)").waitFor({ timeout: 90_000 });
  await noter("10b-sauvegarde-refusee");
  await photo("10b-sauvegarde-refusee");
  await bouton("Continuer : Restaurer sur un autre appareil").click();
  await expect(titre("Restaurer sur un autre appareil"));
  await noter("11-restaurer-ailleurs");
  await photo("11-restaurer-ailleurs");
  await bouton("Continuer : Récupérer votre coffre avec le code").click();
  await expect(titre("Récupérer votre coffre avec le code"));
  await attendreChargement(() => bouton("Verrouiller mon coffre").click());
  await expect(page.getByLabel("Code de récupération", { exact: true }));
  await dormir(500);
  await noter("12-recuperer");
  await photo("12-recuperer");
  // B2-7 : une phrase saisie dans le champ du numéro de feuille ?
  await page
    .getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", { exact: true })
    .fill(PHRASE.slice(0, 12));
  await dormir(300);
  await noter("12b-numero-non-numerique");
  await photo("12b-numero-non-numerique");
  await page
    .getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", { exact: true })
    .fill("");
  const version = mesures.etapes["04-code-feuille"].consigne.match(/: (\d+)\./)?.[1] ?? "1";
  await page
    .getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", { exact: true })
    .fill(version);
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton("Ouvrir mon coffre avec le code").click();
  await expect(titre("Révoquer en urgence"));
  await dormir(500);
  await noter("13-revoquer");
  await photo("13-revoquer");
  await bouton("Révoquer tous les autres moyens d'ouvrir ce coffre").click();
  await expect(titre("Parcours terminé"));
  await dormir(500);
  await noter("14-termine");
  await photo("14-termine");
  await bouton("Revenir à mon application").click();
  await expect(titre("Votre application"));
  await dormir(500);
  await noter("15-accueil");
  await photo("15-accueil");
  // Rails prêt simulé
  await page.locator("#cycle-etat").evaluate((n) => {
    n.textContent = "cycle:application-demarree";
  });
  await dormir(800);
  await noter("16-application-simulee");
  await photo("16-application-simulee");
  await page.locator("#cycle-etat").evaluate((n) => {
    n.textContent = "cycle:demarrage-en-cours";
  });
  await dormir(800);
  await noter("17-demarrage-simule");
  await photo("17-demarrage-simule");
  await navigateur.close();
  await writeFile(`${dossier}/mesures.json`, JSON.stringify(mesures, null, 2));
  console.log(nom, "ok");
}
for (const r of runs) {
  try {
    await jouer(r);
  } catch (e) {
    console.error(r, "ÉCHEC", e.message.split("\n")[0]);
  }
}
