/* global document, MessagePort, process */
// Recette QA de la relecture de #308 : un coffre à DEUX feuilles, ouvert par l'une, à l'étape 9.
// La confirmation doit dire que l'AUTRE feuille part aussi (jamais « rien ne sera retiré »).
//
// Usage : node recette-deux-feuilles.mjs <origine> <dossier> [largeur theme]...
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

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
  const lireLaFeuille = async () => {
    await page.locator("#feuille-code").getByText(FORME).waitFor();
    const code = (await page.locator("#feuille-code").textContent()).trim();
    const consigne = await page.locator("#parcours-consigne-feuille").textContent();
    return { code, version: /: (\d+)\./.exec(consigne)[1] };
  };

  await page.goto(`${origine}/index.html`);
  await titre("Créer votre coffre").waitFor({ timeout: 60_000 });
  await bouton("Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Créer mon coffre").click();
  await bouton("Afficher mon code de récupération").click({ timeout: 60_000 });
  await lireLaFeuille();
  // Un second code : « Je n'ai plus cette feuille » depuis une page neuve, ouverte par la phrase.
  await page.goto(`${origine}/index.html`);
  await titre("Vérifier votre code de récupération").waitFor({ timeout: 60_000 });
  await bouton("Je n'ai plus cette feuille — afficher un nouveau code").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton("Ouvrir mon coffre").click();
  await titre("Recevoir votre code de récupération").waitFor(long);
  await bouton("Afficher mon code de récupération").click();
  const seconde = await lireLaFeuille();
  await bouton("J'ai recopié mon code").click();
  await recharge(() => bouton("Verrouiller mon coffre").click());
  await page.getByLabel("Code de récupération", { exact: true }).fill(seconde.code);
  await bouton("Ouvrir mon coffre avec le code").click();
  await titre("Travailler dans l'application").waitFor(long);
  // Jusqu'à l'étape 9, par le code de la seconde feuille.
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
    .fill(seconde.version);
  await page.getByLabel("Code de récupération", { exact: true }).fill(seconde.code);
  await bouton("Ouvrir mon coffre avec le code").click();
  await titre("Révoquer en urgence").waitFor(long);

  await bouton(REVOQUER).click();
  await page.locator("#revocation-confirmation").waitFor({ state: "visible" });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${sortie}/etape-9-deux-feuilles-${nom}.png`, fullPage: true });
  const mesures = await page.evaluate(() => ({
    avertissement: document.getElementById("parcours-avertissement-revocation").textContent,
    confirmation: document.getElementById("revocation-confirmation-texte").textContent,
    revocationsEnvoyees: globalThis.__revocations,
  }));
  await writeFile(
    `${sortie}/mesures-deux-feuilles-${nom}.json`,
    JSON.stringify(mesures, null, 2) + "\n",
  );
  await navigateur.close();
}

for (const run of runs) await jouer(run);
