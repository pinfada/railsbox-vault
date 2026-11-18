// Les RESTES du parcours, sur la coquille réelle sans machine virtuelle — Chromium seul (#266 m7, B2-4,
// B2-7). Chaque épreuve est née rouge, sur `main`, avant le correctif.

import {
  LONG,
  PHRASE,
  afficherLeCode,
  bouton,
  eprouverLaFeuille,
  expect,
  jusquAuTravail,
  simulerLigneDuCycle,
  test,
  titre,
  verrouillerEtRecharger,
} from "./outils-d-apparence.mjs";

test("m7 : avant tout démarrage, la carte de l'étape 4 reste à la largeur des autres écrans", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await jusquAuTravail(page);
  await expect(titre(page, "Travailler dans l'application")).toBeVisible();
  const carte = await page.locator("main").boundingBox();
  expect(carte.width, "la moitié droite d'une carte de 1024 px serait vide").toBeLessThanOrEqual(
    520,
  );
});

for (const largeur of [360, 1280]) {
  test(`B2-4 (${largeur} px) : « Ouvrir mon coffre avec le code » ne bouge pas, code incomplet, faux ou juste`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: largeur, height: 900 });
    const { code } = await afficherLeCode(page);
    await bouton(page, "J'ai recopié mon code").click();
    await verrouillerEtRecharger(page);
    const champ = page.getByLabel("Code de récupération", { exact: true });
    await expect(champ).toBeVisible({ timeout: 60_000 });
    const ouvrir = bouton(page, "Ouvrir mon coffre avec le code");
    const y = async () =>
      Math.round((await ouvrir.boundingBox()).y + (await page.evaluate(() => scrollY)));
    const depart = await y();
    const faux = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    for (const saisie of [code.slice(0, 20), faux, code, "", faux]) {
      await champ.fill(saisie);
      await page.waitForTimeout(250);
      expect(await y(), `bouton après « ${saisie.slice(0, 8)}… »`).toBe(depart);
    }
  });
}

test("B2-7 : un numéro de feuille qui n'en est pas un se dit au champ, avant le clic", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  const feuille = await afficherLeCode(page);
  await eprouverLaFeuille(page, feuille.code);
  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await verrouillerEtRecharger(page);
  await expect(titre(page, "Rouvrir votre coffre")).toBeVisible(LONG);
  const ancre = page.getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", {
    exact: true,
  });
  // La phrase, tapée dans le champ du numéro : l'erreur que la recette a vue.
  await ancre.fill(PHRASE);
  await expect(ancre).toHaveAttribute("aria-invalid", "true");
  const decrit = (await ancre.getAttribute("aria-describedby")) ?? "";
  expect(decrit).not.toBe("");
  const message = page.locator(`#${decrit.split(" ")[0]}`);
  await expect(message).toBeVisible();
  await expect(message).toContainText("numéro de feuille");
  await expect(message).toContainText("chiffres");
  await expect(message).not.toContainText("version");
  // Corrigé, le message s'efface et le champ n'est plus marqué.
  await ancre.fill("2");
  await expect(ancre).not.toHaveAttribute("aria-invalid", "true");
  await expect(message).toBeHidden();
  // Vide : un choix, pas une erreur.
  await ancre.fill("");
  await expect(ancre).not.toHaveAttribute("aria-invalid", "true");
});

test("m11 : un refus du parcours est dit à la console par son code, sans la valeur refusée", async ({
  page,
}) => {
  const avertissements = [];
  page.on("console", (message) => {
    if (message.type() === "warning") avertissements.push(message.text());
  });
  const feuille = await afficherLeCode(page);
  await eprouverLaFeuille(page, feuille.code);
  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await verrouillerEtRecharger(page);
  await expect(titre(page, "Rouvrir votre coffre")).toBeVisible(LONG);
  const fausse = "une mauvaise phrase tout autre";
  await page.getByLabel("Votre phrase", { exact: true }).fill(fausse);
  await bouton(page, "Ouvrir mon coffre").click();
  await expect(page.locator("#parcours-refus")).not.toBeEmpty({ timeout: 60_000 });
  const refus = avertissements.filter((texte) => /VAULT_[A-Z0-9_]+/.test(texte));
  expect(refus, "le code du refus est à la console").toHaveLength(1);
  expect(refus[0]).toMatch(/^\[RailsBox Vault\] refus : VAULT_/);
  for (const texte of avertissements) {
    expect(texte).not.toContain(fausse);
    expect(texte).not.toContain(feuille.code);
  }
});

test("la description accessible du champ de la phrase, à la réouverture, est celle de la réouverture", async ({
  page,
}) => {
  const feuille = await afficherLeCode(page);
  await eprouverLaFeuille(page, feuille.code);
  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await verrouillerEtRecharger(page);
  await expect(titre(page, "Rouvrir votre coffre")).toBeVisible(LONG);
  const champ = page.getByLabel("Votre phrase", { exact: true });
  await expect(champ).toHaveAccessibleDescription(
    "Saisissez la phrase utilisée lors de la création du coffre.",
  );
  await expect(page.locator("#phrase-aide")).toBeEmpty();
});

// --- #302 : ce que l'ADR 0043 garantit à une personne au clavier, application démarrée (simulée) ---
//
// « Reprise MVP — lot 3 » est rouge depuis `857d210` sur deux épreuves E2E (`parcours-clavier`,
// `parcours-utilisateur`). Ces deux épreuves-ci jouent, SANS machine virtuelle, la même exigence que
// les E2E, au niveau où elle se prouve : la ligne d'état du cycle est posée comme le cycle la publie.

/** Tab jusqu'à la cible, sans focus forcé ni clic ; faux si elle n'est pas atteinte. */
async function atteintAuClavier(page, cible, essais = 80) {
  for (let i = 0; i < essais; i += 1) {
    if (await cible.evaluate((n) => n === n.ownerDocument.activeElement)) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

test("#302 : application démarrée, « Aide pour cette étape » s'atteint et se bascule au clavier par le menu « Coffre »", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await jusquAuTravail(page);
  await simulerLigneDuCycle(page, "cycle:application-demarree");
  await expect(page.locator("html")).toHaveAttribute("data-travail-pret", "true");
  const aide = page.locator("#parcours-aide > summary");
  const menu = page.locator("#menu-du-coffre > summary");
  // ADR 0043, Conséquences : menu fermé, le panneau est hors de l'ordre de tabulation.
  expect(await atteintAuClavier(page, aide, 40), "menu fermé : l'aide est hors de portée").toBe(
    false,
  );
  // Le menu « Coffre » est, lui, dans la barre : il s'atteint au clavier et ouvre le panneau.
  expect(await atteintAuClavier(page, menu), "le menu « Coffre » s'atteint au clavier").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("#menu-du-coffre")).toHaveAttribute("open", "");
  expect(await atteintAuClavier(page, aide), "menu ouvert : l'aide s'atteint au clavier").toBe(
    true,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator("#parcours-aide")).toHaveAttribute("open", "");
  await expect(page.locator("#parcours-attente-annoncee")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#parcours-aide")).not.toHaveAttribute("open", "");
});

test("#302 : application démarrée, une région d'alerte vide est hors de l'écran, un refus s'y montre", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await jusquAuTravail(page);
  await simulerLigneDuCycle(page, "cycle:application-demarree");
  await expect(page.locator("html")).toHaveAttribute("data-travail-pret", "true");
  // Vide : aucune alerte n'est annoncée ni montrée (le panneau est `visibility: hidden`, ADR 0043).
  await expect(page.locator('[role="alert"]:not(:empty)')).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Un refus s'écrit dans la même région et paraît en bandeau, menu fermé : il n'est jamais perdu.
  await page.locator("#portabilite-etat").evaluate((noeud) => {
    noeud.textContent = "portabilite:sauvegarde-refusee:VAULT_COQUILLE_APPLICATION_NON_INSTALLEE";
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).not.toBeEmpty();
});

test("#302 : application démarrée, « Où suis-je ? » se lit par le menu « Coffre », et résume les neuf étapes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await jusquAuTravail(page);
  await simulerLigneDuCycle(page, "cycle:application-demarree");
  await expect(page.locator("html")).toHaveAttribute("data-travail-pret", "true");
  const ouSuisJe = page.getByText("Où suis-je ?", { exact: true });
  await expect(ouSuisJe, "menu fermé : le panneau est caché").toBeHidden();
  await page.locator("#menu-du-coffre > summary").click();
  await ouSuisJe.click();
  await expect(page.getByRole("listitem")).toHaveCount(9);
});
