// Un stockage INACCESSIBLE POUR L'INSTANT n'est pas un coffre ABSENT (#231, revue de la PR #305).
//
// Quand le Worker de confiance ne peut pas lire l'OPFS (`UnknownError` répété de `getDirectory()`, que
// le moteur dit « transitoire »), l'inventaire du coffre est INCONNU. Le dire « aucun coffre sur cet
// appareil » ferait proposer « Créer votre coffre » à quelqu'un qui en possède un, et appliquerait la
// politique de phrase de CRÉATION. L'écran dit donc que le stockage est inaccessible pour l'instant, ne
// propose NI la création NI un moyen d'ouverture, et offre « Réessayer » : la reprise relance la sonde
// puis l'inventaire, SANS rechargement, et rend l'écran du coffre EXISTANT.
//
// Le rejet est posé par l'ÉPREUVE, dans le Worker de confiance lui-même (`tests/support/rejet-opfs-worker.mjs`).
//
// AUCUNE sortie silencieuse : sous Chromium et Firefox les scénarios sont COMPLETS, et si l'écran devient
// « inaccessible » là où il ne doit pas l'être, l'épreuve ÉCHOUE. Le contexte WebKit éphémère, où le rejet
// est NATUREL et constant et où aucun coffre ne se crée, est déclaré par la FIXTURE — `test.skip(browserName
// === "webkit", …)`, visible au rapport — et a son épreuve séparée, qui VÉRIFIE l'écran inaccessible.
// Ce que ce fichier prouve, par moteur : Chromium et Firefox, un coffre existant et sa reprise ; WebKit, la
// seule conduite de l'écran (ni création ni moyen, « Réessayer » qui ne peut pas aboutir) — PAS la reprise
// d'un coffre existant, qu'un contexte WebKit persistant permettrait et que ce dépôt ne mesure pas.

import { expect, test } from "../support/test.mjs";
import { poserLeRejetDansLeWorker } from "../support/rejet-opfs-worker.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const PHRASE = "marqueur-de-phrase-du-stockage-indetermine-231-assez-longue";
const DELAI = 60_000;
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const TITRE_INACCESSIBLE = "Le stockage du navigateur ne répond pas pour l'instant";

const RAISON_WEBKIT_EPHEMERE =
  "WebKit éphémère : getDirectory() rejette UnknownError (mesuré, docs/compatibility.md), aucun coffre ne s'y crée ; l'écran inaccessible a son épreuve";

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });
const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

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

test("Chromium et Firefox : stockage inaccessible — ni création ni moyen, « Réessayer », et la reprise rend le coffre EXISTANT sans rechargement", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", RAISON_WEBKIT_EPHEMERE);
  const etat = { rejeter: false };
  await poserLeRejetDansLeWorker(context, etat);
  await ouvrirLaCoquille(page);
  // Un coffre EXISTANT, puis un stockage qui ne répond pas à la rouverture. `creerEtAfficherLeCode`
  // exige l'écran de création : si le stockage est inaccessible dès le départ, l'épreuve ÉCHOUE.
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

test("Chromium et Firefox : la même reprise rend l'écran de RÉOUVERTURE par la PHRASE d'un coffre existant, et la phrase l'ouvre", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", RAISON_WEBKIT_EPHEMERE);
  const etat = { rejeter: false };
  await poserLeRejetDansLeWorker(context, etat);
  await ouvrirLaCoquille(page);
  // Un coffre existant dont le code a été éprouvé : la page le rouvre désormais par la PHRASE.
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

test("Chromium et Firefox : une panne de LECTURE après une sonde RÉUSSIE (inventaire) mène à « Réessayer », jamais à un démarrage en erreur", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", RAISON_WEBKIT_EPHEMERE);
  const etat = { rejeter: false };
  await poserLeRejetDansLeWorker(context, etat);
  await ouvrirLaCoquille(page);
  const code = await creerEtAfficherLeCode(page);

  // La sonde du prochain Worker réussit (un appel passe), puis toute lecture rejette `UnknownError`.
  etat.laisserPasser = 1;
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
  await expect(page.locator("html")).not.toHaveAttribute("data-coquille", "erreur");
  await exigerAucuneOffre(page);
  await expect(ecran(page, "Créer votre coffre")).toHaveCount(0);

  // La reprise après cette panne : le stockage répond de nouveau, « Réessayer » rend le coffre existant.
  etat.laisserPasser = undefined;
  etat.rejeter = false;
  await bouton(page, "Réessayer").click();
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe("ouvert");
});

test("WebKit éphémère : l'écran « stockage inaccessible » n'offre NI création NI moyen, et « Réessayer » ne peut pas aboutir", async ({
  page,
  context,
  browserName,
}, info) => {
  test.skip(browserName !== "webkit", "épreuve du seul contexte WebKit éphémère mesuré");
  // Le rejet est NATUREL sous ce contexte : l'épreuve ne pose rien, elle VÉRIFIE. Si WebKit cessait de
  // rejeter, l'écran ne s'afficherait plus et l'épreuve échouerait — c'est voulu.
  await poserLeRejetDansLeWorker(context, { rejeter: false });
  await ouvrirLaCoquille(page);
  await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
  await exigerAucuneOffre(page);
  await expect(ecran(page, "Créer votre coffre")).toHaveCount(0);
  await bouton(page, "Réessayer").click();
  await expect(ecran(page, TITRE_INACCESSIBLE)).toBeVisible({ timeout: DELAI });
  await exigerAucuneOffre(page);
  await info.attach("limite-webkit-ephemere", {
    body: "Rejet naturel et constant : aucun coffre existant, la reprise d'un coffre n'est pas mesurée sous WebKit.",
    contentType: "text/plain",
  });
});
