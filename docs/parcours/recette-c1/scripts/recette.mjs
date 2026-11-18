/* global document, getComputedStyle, process, MessagePort, scrollY, Node */
// Recette QA ciblée du lot C, tranche 1 (#265) — Chromium, coquille réelle sans machine virtuelle.
//
// Usage : node recette.mjs <origine> <dossier> avant|apres [largeur theme]...
//   `avant` : l'étape 9 et l'accueil tels que `main` les sert (le clic y révoque : pas de confirmation).
//   `apres` : idem, puis la confirmation ouverte, à l'étape 9 et à l'accueil.
// Écrit une capture par écran et `mesures-<largeur>-<theme>.json` dans <dossier>.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

const [origine, sortie, moment, ...reste] = process.argv.slice(2);
const runs = [];
for (let i = 0; i < reste.length; i += 2)
  runs.push({ largeur: Number(reste[i]), theme: reste[i + 1] });
if (runs.length === 0) {
  for (const largeur of [360, 1280])
    for (const theme of ["light", "dark"]) runs.push({ largeur, theme });
}
const PHRASE = "une phrase publique pour la recette du lot C";
const REVOQUER = "Révoquer tous les autres moyens d'ouvrir ce coffre";

async function jouer({ largeur, theme }) {
  const nom = `${largeur}-${theme}`;
  await mkdir(sortie, { recursive: true });
  const mesures = { nom, moment, ecrans: {} };
  const navigateur = await chromium.launch();
  const contexte = await navigateur.newContext({
    viewport: { width: largeur, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await contexte.addInitScript(() => {
    globalThis.__revocations = 0;
    const envoyer = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...suite) {
      if (typeof message?.type === "string" && message.type.endsWith("revoquer-en-urgence")) {
        globalThis.__revocations += 1;
      }
      return envoyer.call(this, message, ...suite);
    };
  });
  const page = await contexte.newPage();
  const titre = (t) => page.getByRole("heading", { level: 2, name: t, exact: true });
  const bouton = (n) => page.getByRole("button", { name: n, exact: true });
  const long = { timeout: 180_000 };
  const recharge = async (declencheur) => {
    const l = page.waitForEvent("load");
    await declencheur();
    await l;
    await page.waitForLoadState("load");
  };
  const photo = async (etiquette) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${sortie}/${etiquette}-${nom}.png`, fullPage: true });
  };
  const releve = async (etiquette) => {
    mesures.ecrans[etiquette] = await page.evaluate(() => {
      const visible = (n) => n !== null && n.offsetParent !== null;
      const portabilite = [...document.querySelectorAll("#portabilite > [data-bloc]")]
        .filter(visible)
        .map((n) => n.dataset.bloc);
      const boutons = [...document.querySelectorAll("#portabilite button, #parcours-sans-revoquer")]
        .filter(visible)
        .map((b) => ({
          id: b.id,
          texte: b.textContent.trim(),
          y: Math.round(b.getBoundingClientRect().y + scrollY),
          principal: b.hasAttribute("data-principal"),
          danger: b.hasAttribute("data-danger"),
          ordreCss: getComputedStyle(b.closest("[data-bloc]") ?? b).order,
        }));
      // L'ordre de TABULATION : l'ordre du DOM des boutons visibles de la section.
      const tabulation = boutons
        .slice()
        .sort((a, b) =>
          document.getElementById(a.id).compareDocumentPosition(document.getElementById(b.id)) &
          Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
        )
        .map((b) => b.id);
      return {
        blocsVisibles: portabilite,
        boutons,
        ordreDeTabulation: tabulation,
        ordreVisuel: boutons
          .slice()
          .sort((a, b) => a.y - b.y)
          .map((b) => b.id),
        revocationsEnvoyees: globalThis.__revocations,
        focus: document.activeElement?.id ?? null,
        confirmation: document.getElementById("revocation-confirmation")?.hidden === false,
        descriptionDuFocus:
          document.activeElement?.getAttribute("aria-describedby") !== null
            ? (document
                .getElementById(document.activeElement.getAttribute("aria-describedby"))
                ?.textContent.trim() ?? null)
            : null,
      };
    });
  };

  // Étapes 1 à 3, puis 4 à 8 : la coquille réelle (sans VM), le coffre d'essai.
  await page.goto(`${origine}/index.html`);
  await titre("Créer votre coffre").waitFor({ timeout: 60_000 });
  await bouton("Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Créer mon coffre").click();
  await bouton("Afficher mon code de récupération").click({ timeout: 60_000 });
  await page
    .locator("#feuille-code")
    .getByText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/)
    .waitFor();
  const code = (await page.locator("#feuille-code").textContent()).trim();
  const consigne = await page.locator("#parcours-consigne-feuille").textContent();
  const version = /: (\d+)\./.exec(consigne)[1];
  await bouton("J'ai recopié mon code").click();
  await recharge(() => bouton("Verrouiller mon coffre").click());
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton("Ouvrir mon coffre avec le code").click();
  await titre("Travailler dans l'application").waitFor(long);
  await bouton("Continuer : Verrouiller et rouvrir").click();
  await recharge(() => bouton("Verrouiller mon coffre").click());
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Ouvrir mon coffre").click();
  await titre("Sauvegarder votre coffre").waitFor(long);
  await bouton("Continuer : Restaurer sur un autre appareil").click();
  await bouton("Continuer : Récupérer votre coffre avec le code").click();
  await recharge(() => bouton("Verrouiller mon coffre").click());
  await page
    .getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", { exact: true })
    .fill(version);
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton("Ouvrir mon coffre avec le code").click();
  await titre("Révoquer en urgence").waitFor(long);

  // L'étape 9.
  await photo("etape-9");
  await releve("etape-9");
  if (moment === "apres") {
    await bouton(REVOQUER).click();
    await page.locator("#revocation-confirmation").waitFor({ state: "visible" });
    await photo("etape-9-confirmation");
    await releve("etape-9-confirmation");
    await bouton("Annuler").click();
    await releve("etape-9-annulee");
  }

  // L'accueil : « Terminer sans révoquer », puis « Revenir à mon application ».
  await bouton("Terminer sans révoquer").click();
  await bouton("Revenir à mon application").click();
  await titre("Votre application").waitFor();
  await photo("accueil");
  await releve("accueil");
  if (moment === "apres") {
    await bouton(REVOQUER).click();
    await page.locator("#revocation-confirmation").waitFor({ state: "visible" });
    await photo("accueil-confirmation");
    await releve("accueil-confirmation");
  }
  await writeFile(`${sortie}/mesures-${nom}.json`, JSON.stringify(mesures, null, 2) + "\n");
  await navigateur.close();
}

for (const run of runs) await jouer(run);
