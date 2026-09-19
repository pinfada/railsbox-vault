// LE PREMIER CLIC après l'application (#251) : « Verrouiller mon coffre » ne se perd jamais en silence.
//
// Recette QA de la PR #249 (contre-recette n° 8) : juste après que l'application s'est affichée dans
// son cadre — ou y a eu la main —, le premier clic sur un bouton de la coquille restait sans effet ni
// signe ; le second était pris. Aucune machine virtuelle ne tourne ici : l'état « application affichée »
// est publié sur la ligne du cycle comme le geste de démarrage le publierait, et le cadre applicatif est
// le vrai document d'une autre origine.

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const DELAI = 90_000;
const PHRASE = "marqueur-de-phrase-du-parcours-251-une-phrase-assez-longue";
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });

/** Crée le coffre, éprouve la feuille, termine la visite : mène à l'accueil, coffre ouvert. */
async function jusquALAccueil(page, browserName) {
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
  await expect(ecran(page, "Créer votre coffre")).toBeVisible({ timeout: DELAI });
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: DELAI });
  const code = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
  await bouton(page, "J'ai recopié mon code").click();
  let recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  await page.getByLabel("Code de récupération", { exact: true }).fill(code, { timeout: DELAI });
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  // La visite est finie : la progression le dit, et l'accueil suit la réouverture.
  await page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await racine.getFileHandle("parcours.json");
    const progression = JSON.parse(await (await fichier.getFile()).text());
    const flux = await fichier.createWritable();
    await flux.write(JSON.stringify({ ...progression, etapeAtteinte: 9, visiteTerminee: true }));
    await flux.close();
  });
  recharge = page.waitForEvent("load");
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
  await recharge;
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE, { timeout: DELAI });
  await bouton(page, "Ouvrir mon coffre").click();
  // Firefox ne montre pas l'application (sa limite, ADR 0040) : son accueil n'a pas de titre d'accueil.
  if (browserName === "firefox") {
    await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
    return;
  }
  await expect(ecran(page, "Votre application")).toBeVisible({ timeout: DELAI });
}

/** L'application « s'affiche » : la ligne du cycle, telle que le démarrage la publie. */
async function afficherLApplication(page, browserName) {
  await page.evaluate(() => {
    document.getElementById("cycle-etat").textContent = "cycle:application-demarree";
  });
  if (browserName === "firefox") return;
  await expect(page.locator("html")).toHaveAttribute("data-travail-pret", "true");
}

for (const variante of ["après un geste DANS le cadre", "juste après l'affichage"]) {
  test(`#251 : UN clic sur « Verrouiller mon coffre » ${variante} verrouille`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === "webkit", "rien ne s'y ouvre : pas d'OPFS synchrone");
    test.skip(
      browserName === "firefox",
      "l'application ne s'y affiche pas (ADR 0040) : aucun premier clic après elle",
    );
    test.setTimeout(240_000);
    await jusquALAccueil(page, browserName);
    await afficherLApplication(page, browserName);
    if (variante.startsWith("après")) {
      await page.frameLocator("#document-applicatif").locator("body").click();
    }
    const recharge = page.waitForEvent("load", { timeout: 20_000 });
    await bouton(page, "Verrouiller mon coffre").click();
    await recharge;
    await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
  });
}

test("#251 : un bouton fermé puis rouvert PENDANT qu'il est pressé ne perd pas le clic", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "rien ne s'y ouvre : pas d'OPFS synchrone");
  test.skip(browserName === "firefox", "l'application ne s'y affiche pas (ADR 0040)");
  test.setTimeout(240_000);
  await jusquALAccueil(page, browserName);
  await afficherLApplication(page, browserName);
  const cible = bouton(page, "Verrouiller mon coffre");
  const boite = await cible.boundingBox();
  await page.mouse.move(boite.x + boite.width / 2, boite.y + boite.height / 2);
  await page.mouse.down();
  // Pendant la pression, un relevé publié fait RENDRE la page : un geste long s'annonce puis finit.
  await page.evaluate(() => {
    const ligne = document.getElementById("portabilite-etat");
    ligne.textContent = "portabilite:sauvegarde-en-cours";
  });
  await page.evaluate(() => {
    document.getElementById("portabilite-etat").textContent = "portabilite:au-repos";
  });
  const recharge = page.waitForEvent("load", { timeout: 20_000 });
  await page.mouse.up();
  await recharge;
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
});

test("#251 : « Verrouiller mon coffre » REÇU se voit en moins d'une seconde — bouton occupé, ligne d'état", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "rien ne s'y ouvre : pas d'OPFS synchrone");
  test.skip(browserName === "firefox", "l'application ne s'y affiche pas (ADR 0040)");
  test.setTimeout(240_000);
  await jusquALAccueil(page, browserName);
  await afficherLApplication(page, browserName);
  // Le relevé de l'épreuve : l'instant du clic, puis celui où le bouton se dit occupé ET où la ligne
  // d'état, lue par les lecteurs d'écran, dit le verrouillage. Gardé dans `sessionStorage`, car le
  // verrouillage RECHARGE la page.
  await page.evaluate(() => {
    const bouton = document.getElementById("verrouiller-le-coffre");
    const attente = document.getElementById("parcours-attente");
    bouton.addEventListener("click", () => sessionStorage.setItem("clic", performance.now()), {
      capture: true,
    });
    new MutationObserver(() => {
      if (sessionStorage.getItem("signe") !== null || sessionStorage.getItem("clic") === null) {
        return;
      }
      if (bouton.getAttribute("aria-busy") !== "true" || attente.textContent === "") return;
      const ecart = performance.now() - Number(sessionStorage.getItem("clic"));
      sessionStorage.setItem(
        "signe",
        JSON.stringify({ ecart, texte: attente.textContent, ferme: bouton.disabled }),
      );
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
  });
  const recharge = page.waitForEvent("load", { timeout: 20_000 });
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  const signe = JSON.parse(await page.evaluate(() => sessionStorage.getItem("signe")));
  expect(signe, "le geste reçu a donné un signe avant le rechargement").not.toBeNull();
  expect(signe.ecart).toBeLessThan(1_000);
  expect(signe.texte).toMatch(/[Vv]errouillage/);
  expect(signe.ferme).toBe(true);
});

test("#251, Chromium et WebKit : un geste long pressé pendant un rendu de la page n'est pas perdu", async ({
  page,
  browserName,
}) => {
  // Firefox : la souris de Playwright n'y livre AUCUN événement de pointeur à ce scénario — ni
  // pointerdown, ni click, sonde du 19/09/2026 —, avec ou sans la garde. La mesure n'y dirait rien.
  test.skip(browserName === "firefox", "appui souris non livré par le pilote sous Firefox");
  test.setTimeout(120_000);
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
  await expect(ecran(page, "Créer votre coffre")).toBeVisible({ timeout: DELAI });
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  const cible = bouton(page, "Créer mon coffre");
  const boite = await cible.boundingBox();
  await page.mouse.move(boite.x + boite.width / 2, boite.y + boite.height / 2);
  await page.mouse.down();
  // Pendant la pression, un relevé publié fait RENDRE la page : un geste long s'annonce puis finit.
  await page.evaluate(() => {
    document.getElementById("portabilite-etat").textContent = "portabilite:sauvegarde-en-cours";
  });
  await page.evaluate(() => {
    document.getElementById("portabilite-etat").textContent = "portabilite:au-repos";
  });
  await page.mouse.up();
  if (browserName === "webkit") {
    // Aucun coffre ne s'y crée (pas d'OPFS synchrone) : le clic PRIS se voit à son refus, dit.
    await expect(page.getByRole("alert")).toContainText("navigateur", { timeout: DELAI });
    return;
  }
  await expect(ecran(page, "Recevoir votre code de récupération")).toBeVisible({ timeout: DELAI });
});
