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

/**
 * Pose, dans le Worker de confiance, un `getDirectory()` qui REJETTE `UnknownError` tant que l'épreuve
 * le demande. L'interrupteur est TENU PAR L'ÉPREUVE : le Worker l'interroge à chaque appel par un
 * `fetch` de même origine que la route de l'épreuve sert — un compte d'appels fixé d'avance serait
 * faux dès qu'un autre module du Worker appelle `getDirectory()` avant la sonde.
 */
async function poserLeRejetDansLeWorker(context, etat) {
  await context.route(/\/__rejets-d-opfs$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: etat.rejeter ? "1" : "0" }),
  );
  await context.route(/\/runtime-worker\.mjs/, async (route) => {
    const reponse = await route.fetch();
    const prelude =
      "const __origine = StorageManager.prototype.getDirectory;\n" +
      "StorageManager.prototype.getDirectory = async function () {\n" +
      '  const demande = await (await fetch("/__rejets-d-opfs", { cache: "no-store" })).text();\n' +
      '  if (demande === "1") throw new DOMException("transitoire", "UnknownError");\n' +
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
  const etat = { rejeter: false };
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
  etat.rejeter = true;
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
  await expect(page.locator("#deverrouillage-moyens")).toContainText("inaccessible pour l'instant");
  await expect(page.locator("#deverrouillage-moyens")).not.toContainText("Aucun coffre");
  await exigerAucuneOffre(page);

  // La reprise : SANS rechargement. L'épreuve compte les chargements du document depuis ce point.
  let chargements = 0;
  page.on("load", () => (chargements += 1));
  etat.rejeter = false;
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

test("la même reprise rend l'écran de RÉOUVERTURE par la PHRASE d'un coffre existant, et la phrase l'ouvre", async ({
  page,
  context,
}) => {
  const etat = { rejeter: false };
  await poserLeRejetDansLeWorker(context, etat);
  await ouvrirLaCoquille(page);
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBeTruthy();
  if ((await releve(page)).etat === "indetermine") {
    // WebKit éphémère : aucun coffre n'existe, la phrase n'a rien à rouvrir. Même écran, même absence
    // d'offre — la limite est écrite dans la première épreuve.
    await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
    await exigerAucuneOffre(page);
    return;
  }

  // Un coffre existant dont le code a été éprouvé, puis verrouillé : la page rouvre par la PHRASE.
  const code = await creerEtAfficherLeCode(page);
  await bouton(page, "J'ai recopié mon code").click();
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  await expect(page.getByLabel("Code de récupération", { exact: true })).toBeVisible({
    timeout: DELAI,
  });
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  // La feuille est éprouvée (c'est le Worker qui le constate) : un rechargement referme le coffre, et la
  // page le rouvre désormais par la PHRASE.
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });

  // Le stockage ne répond plus : l'écran de réouverture cède la place à l'écran « inaccessible »…
  etat.rejeter = true;
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
  await exigerAucuneOffre(page);

  // …puis, à la reprise, revient — celui d'un coffre EXISTANT, jamais « Créer votre coffre ».
  etat.rejeter = false;
  await bouton(page, "Réessayer").click();
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
  await expect(ecran(page, "Créer votre coffre")).toHaveCount(0);
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Ouvrir mon coffre").click();
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe("ouvert");
});
