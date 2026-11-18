// Un stockage INACCESSIBLE POUR L'INSTANT n'est pas un coffre ABSENT (#231, revue de la PR #305).
//
// Quand le Worker de confiance ne peut pas lire l'OPFS (`UnknownError` répété de `getDirectory()`, que
// le moteur dit « transitoire »), l'inventaire du coffre est INCONNU. Le dire « aucun coffre sur cet
// appareil » ferait proposer « Créer votre coffre » à quelqu'un qui en possède un, et appliquerait la
// politique de phrase de CRÉATION. L'écran dit donc que le stockage est inaccessible pour l'instant, ne
// propose NI la création NI un moyen d'ouverture, et offre « Réessayer » : la reprise relance la sonde
// puis l'inventaire, SANS rechargement, et rend l'écran du coffre EXISTANT.
//
// Le rejet est posé par l'ÉPREUVE, dans le Worker de confiance lui-même — `addInitScript` n'atteint pas
// les Workers : la route du script du Worker lui ajoute un préambule qui rejette les N premiers appels
// de `getDirectory()`, N étant fixé par l'épreuve. Sous WebKit éphémère le rejet est NATUREL et constant :
// aucun coffre ne s'y crée, la reprise ne peut pas aboutir, et l'épreuve dit exactement cela.

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const PHRASE = "marqueur-de-phrase-du-stockage-indetermine-231-assez-longue";
const DELAI = 60_000;
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const TITRE_INACCESSIBLE = "Le stockage du navigateur ne répond pas pour l'instant";

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });
const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

/** Le nombre d'appels de `getDirectory()` que le prochain Worker de confiance rejettera. */
async function poserLeRejetDansLeWorker(context, etat) {
  await context.route(/\/runtime-worker\.mjs/, async (route) => {
    const reponse = await route.fetch();
    const prelude =
      `const __restants = { n: ${etat.rejets} };\n` +
      "const __origine = StorageManager.prototype.getDirectory;\n" +
      "StorageManager.prototype.getDirectory = function () {\n" +
      "  if (__restants.n > 0) {\n" +
      "    __restants.n -= 1;\n" +
      '    return Promise.reject(new DOMException("transitoire", "UnknownError"));\n' +
      "  }\n" +
      "  return __origine.call(this);\n" +
      "};\n";
    await route.fulfill({ response: reponse, body: prelude + (await reponse.text()) });
  });
}

async function ouvrirLaCoquille(page) {
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
}

async function creerEtAfficherLeCode(page) {
  await expect(ecran(page, "Créer votre coffre")).toBeVisible({ timeout: DELAI });
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await expect(ecran(page, "Recevoir votre code de récupération")).toBeVisible({ timeout: DELAI });
  await bouton(page, "Afficher mon code de récupération").click();
  await expect(ecran(page, "Recopier votre code de récupération")).toBeVisible({ timeout: DELAI });
  const code = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
  expect(code).toMatch(FORME_DU_CODE);
  return code;
}

/** Rien de ce qui crée un coffre, ni de ce qui ouvre, ne doit être offert sur l'écran inaccessible. */
async function exigerAucuneOffre(page) {
  await expect(ecran(page, "Créer votre coffre")).toHaveCount(0);
  await expect(bouton(page, "Commencer")).toHaveCount(0);
  await expect(bouton(page, "Créer mon coffre")).toHaveCount(0);
  await expect(page.getByLabel("Votre phrase", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Code de récupération", { exact: true })).toBeHidden();
  await expect(bouton(page, "Ouvrir mon coffre avec ma passkey")).toBeHidden();
}

test("stockage inaccessible : ni création ni moyen, « Réessayer », et la reprise rend le coffre EXISTANT sans rechargement", async ({
  page,
  context,
}, info) => {
  const etat = { rejets: 0 };
  await poserLeRejetDansLeWorker(context, etat);
  await ouvrirLaCoquille(page);
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBeTruthy();

  if ((await releve(page)).etat === "indetermine") {
    // Sous WebKit éphémère : le rejet est NATUREL et constant, aucun coffre ne s'y crée. L'écran dit le
    // stockage inaccessible, n'offre rien, et la reprise — qui ne peut pas aboutir — le dit encore.
    await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
    await exigerAucuneOffre(page);
    await bouton(page, "Réessayer").click();
    await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
    await exigerAucuneOffre(page);
    await info.attach("limite-webkit-ephemere", {
      body: "Rejet naturel et constant : aucun coffre existant, la reprise ne peut pas aboutir ici.",
      contentType: "text/plain",
    });
    return;
  }

  // Chromium et Firefox : un coffre EXISTANT, puis un stockage qui ne répond pas à la rouverture.
  const code = await creerEtAfficherLeCode(page);
  etat.rejets = 3;
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
  await expect(page.locator("#deverrouillage-moyens")).toContainText("inaccessible pour l'instant");
  await expect(page.locator("#deverrouillage-moyens")).not.toContainText("Aucun coffre");
  await exigerAucuneOffre(page);

  // La reprise : SANS rechargement. L'épreuve compte les chargements du document depuis ce point.
  let chargements = 0;
  page.on("load", () => (chargements += 1));
  await bouton(page, "Réessayer").click();
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  await expect(ecran(page, "Créer votre coffre")).toHaveCount(0);
  await expect(ecran(page, TITRE_INACCESSIBLE)).toHaveCount(0);
  await expect(page.locator("#deverrouillage-moyens")).toContainText("Ce coffre s'ouvre par");
  expect(chargements, "la reprise ne recharge pas la page").toBe(0);

  // Le coffre existant s'ouvre : la reprise n'est pas qu'un écran.
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe("ouvert");
});
