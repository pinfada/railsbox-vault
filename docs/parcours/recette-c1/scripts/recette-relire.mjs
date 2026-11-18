/* global document, MessagePort, MessageEvent, process, setTimeout */
// Recette QA de la relecture de #308 (REFUSÉ aefe2d1) : une relecture d'inventaire qui échoue APRÈS une
// révocation confirmée. L'écran « Votre coffre doit être relu » remplace « Parcours terminé », la région
// persistante dit la reprise, et la réouverture (rechargement) la lève.
//
// Usage : node recette-relire.mjs <origine> <dossier> [largeur theme]...
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const { TYPES_PRIVILEGIES, enveloppePrivilegiee } = await import(
  pathToFileURL(`${process.cwd()}/src/coquille/contrat-de-messages.mjs`).href
);

const [origine, sortie, ...reste] = process.argv.slice(2);
const runs = [];
for (let i = 0; i < reste.length; i += 2)
  runs.push({ largeur: Number(reste[i]), theme: reste[i + 1] });
if (runs.length === 0) {
  for (const largeur of [360, 1280])
    for (const theme of ["light", "dark"]) runs.push({ largeur, theme });
}
const PHRASE = "une phrase publique pour la recette du lot C";
const FORME = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/;
const REVOQUER = "Révoquer tous les autres moyens d'ouvrir ce coffre";

async function jouer({ largeur, theme }) {
  const nom = `${largeur}-${theme}`;
  await mkdir(sortie, { recursive: true });
  const navigateur = await chromium.launch();
  const contexte = await navigateur.newContext({
    viewport: { width: largeur, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await contexte.addInitScript(() => {
    const envoyer = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...suite) {
      if (globalThis.__echecInventaire && String(message?.type).endsWith("inventaire-prive")) {
        const reponse = { ...globalThis.__echecInventaire, correlation: message.correlation };
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: reponse })), 0);
        return undefined;
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
  const mesures = {};
  const relever = async (etiquette) => {
    mesures[etiquette] = await page.evaluate(() => ({
      region: document.getElementById("parcours-incertitude").textContent,
      sansRevoquerDesactive: document.getElementById("parcours-sans-revoquer").disabled,
      retourDesactive: document.getElementById("parcours-retour-application").disabled,
      alertes: [...document.querySelectorAll("[role=alert]")].map((n) => n.textContent.trim()),
    }));
  };

  await page.goto(`${origine}/index.html`);
  await titre("Créer votre coffre").waitFor({ timeout: 60_000 });
  await bouton("Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Créer mon coffre").click();
  await bouton("Afficher mon code de récupération").click({ timeout: 60_000 });
  await page.locator("#feuille-code").getByText(FORME).waitFor();
  const code = (await page.locator("#feuille-code").textContent()).trim();
  const version = /: (\d+)\./.exec(
    await page.locator("#parcours-consigne-feuille").textContent(),
  )[1];
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

  // La relecture de l'inventaire ÉCHOUE après la révocation : refus typé immédiat, jamais livré au Worker.
  const gabarit = enveloppePrivilegiee(TYPES_PRIVILEGIES.refus, {
    code: "VAULT_RECETTE",
    message: "refus de la recette",
    correlation: "x",
  });
  await page.evaluate((g) => (globalThis.__echecInventaire = g), gabarit);
  await bouton(REVOQUER).click();
  await bouton("Oui, révoquer les autres moyens").click();
  await titre("Votre coffre doit être relu").waitFor(long);
  await photo("relire");
  await relever("relire");
  // Après réouverture (rechargement), la région est levée.
  await page.reload();
  await page.locator("#parcours-incertitude").waitFor({ state: "attached" });
  await relever("apres-reouverture");
  await writeFile(`${sortie}/mesures-relire-${nom}.json`, JSON.stringify(mesures, null, 2) + "\n");
  await navigateur.close();
}

/** Hors de toute révocation : le déverrouillage ordinaire dont la relecture d'inventaire ÉCHOUE. */
async function jouerLOrdinaire({ largeur, theme }) {
  const nom = `${largeur}-${theme}`;
  const navigateur = await chromium.launch();
  const contexte = await navigateur.newContext({
    viewport: { width: largeur, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await contexte.addInitScript(() => {
    const envoyer = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...suite) {
      if (globalThis.__echecInventaire && String(message?.type).endsWith("inventaire-prive")) {
        const reponse = { ...globalThis.__echecInventaire, correlation: message.correlation };
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: reponse })), 0);
        return undefined;
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
  await page.goto(`${origine}/index.html`);
  await titre("Créer votre coffre").waitFor({ timeout: 60_000 });
  await bouton("Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Créer mon coffre").click();
  await bouton("Afficher mon code de récupération").click({ timeout: 60_000 });
  await page.locator("#feuille-code").getByText(FORME).waitFor();
  const code = (await page.locator("#feuille-code").textContent()).trim();
  await bouton("J'ai recopié mon code").click();
  await recharge(() => bouton("Verrouiller mon coffre").click());
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton("Ouvrir mon coffre avec le code").click();
  await titre("Travailler dans l'application").waitFor(long);
  await bouton("Continuer : Verrouiller et rouvrir").click();
  await recharge(() => bouton("Verrouiller mon coffre").click());
  await titre("Rouvrir votre coffre").waitFor(long);
  await page.evaluate((g) => (globalThis.__echecInventaire = g), gabarit());
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Ouvrir mon coffre").click();
  await titre("Votre coffre doit être relu").waitFor(long);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${sortie}/relire-ordinaire-${nom}.png`, fullPage: true });
  await writeFile(
    `${sortie}/mesures-relire-ordinaire-${nom}.json`,
    JSON.stringify({ texte: await page.locator("#parcours").innerText() }, null, 2) + "\n",
  );
  await navigateur.close();
}

function gabarit() {
  return enveloppePrivilegiee(TYPES_PRIVILEGIES.refus, {
    code: "VAULT_RECETTE",
    message: "refus de la recette",
    correlation: "x",
  });
}

for (const run of runs) {
  await jouer(run);
  await jouerLOrdinaire(run);
}
