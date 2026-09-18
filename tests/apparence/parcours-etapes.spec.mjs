// L'APPARENCE des étapes 4 prête à 9, de `forced-colors` et du mouvement non réduit — Chromium seul
// (revue de la PR #216, constats 2, 3, 7, 10, 11).
//
// Les étapes 5 à 9 sont JOUÉES sur la coquille réelle, sans machine virtuelle : verrouiller, rouvrir,
// sauvegarder (refusée : un coffre jamais démarré n'a rien à sauvegarder), restaurer ailleurs (l'écran
// qui l'annonce), récupérer par le code, révoquer, parcours terminé. Chaque écran est vérifié (axe,
// débordement, capture) à 320 et 1024 px, en clair et en sombre. La restauration RÉELLE d'une archive
// exige un premier démarrage : elle n'est pas jouée ici (l'écran « Restaurer une sauvegarde » l'est,
// sur un appareil vierge, dans `parcours.spec.mjs`).
//
// L'étape 4 PRÊTE et le DÉMARRAGE EN COURS sont SIMULÉS : la ligne d'état du cycle est posée par
// l'épreuve, comme le module du cycle de vie la publie. Aucune machine virtuelle ne tourne ici ; la preuve
// réelle de l'étape 4 prête (aide repliée, cadre remonté, focus) reste l'E2E clavier.

import {
  PHRASE,
  aucunGroupeSansNom,
  bouton,
  capturer,
  contraste,
  expect,
  ouvrir,
  simulerLigneDuCycle,
  test,
  titre,
  verifier,
  verifierAux,
} from "./outils-d-apparence.mjs";

const DEUX_LARGEURS = [320, 1024];
const QUATRE_LARGEURS = [320, 768, 1024, 1440];
const FORME_DU_CODE = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/;
const LONG = { timeout: 180_000 };

/** Étapes 1 à 3 jusqu'à la feuille affichée ; rend le code et le numéro de version. */
async function afficherLeCode(page) {
  await ouvrir(page);
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: 60_000 });
  await expect(page.locator("#feuille-code")).toHaveText(FORME_DU_CODE);
  const code = (await page.locator("#feuille-code").textContent()).trim();
  const consigne = await page.locator("#parcours-consigne-feuille").textContent();
  return { code, version: /: (\d+)\./.exec(consigne)[1] };
}

/**
 * VERROUILLE et attend le NOUVEAU document : le verrouillage recharge la coquille, mais l'ancien
 * document voit le coffre verrouillé un instant avant — et y montre déjà l'écran d'après. Attendre un
 * titre ou un champ laissait l'épreuve agir dans un document condamné (#239, Firefox en CI).
 */
async function verrouillerEtRecharger(page) {
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
}

/** La feuille s'éprouve en verrouillant, puis en rouvrant par son code (#239). */
async function eprouverLaFeuille(page, code) {
  await bouton(page, "J'ai recopié mon code").click();
  await verrouillerEtRecharger(page);
  const champ = page.getByLabel("Code de récupération", { exact: true });
  await expect(champ).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState("load");
  await champ.fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(titre(page, "Travailler dans l'application")).toBeVisible({ timeout: 60_000 });
}

async function jusquAuTravail(page) {
  const feuille = await afficherLeCode(page);
  await eprouverLaFeuille(page, feuille.code);
  return feuille;
}

async function simulerRailsPret(page) {
  await simulerLigneDuCycle(page, "cycle:application-demarree");
  await expect(
    page.getByText("L'application est démarrée : elle s'affiche ci-dessous.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#parcours-aide")).not.toHaveAttribute("open", "");
  await expect(page.getByText("Aide pour cette étape", { exact: true })).toBeVisible();
  await expect(bouton(page, "Démarrer l'application")).toBeHidden();
}

/** Les messages de conduite sont à la taille du texte courant (constat 10). */
async function exigerLaTailleCourante(page, id) {
  const taille = await page.locator(`#${id}`).evaluate((noeud) => getComputedStyle(noeud).fontSize);
  expect(taille, `${id} à la taille du texte courant`).toBe("16px");
}

for (const theme of ["light", "dark"]) {
  test(`${theme} : étape 4 prête (état simulé) puis étapes 5 à 9 jouées, 320 et 1024`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(420_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const { code, version } = await jusquAuTravail(page);

    // Étape 4 prête : SIMULATION de l'état publié par le cycle, aux quatre largeurs.
    await simulerRailsPret(page);
    await aucunGroupeSansNom(page, "étape 4 prête");
    await exigerLaTailleCourante(page, "parcours-reussite");
    for (const largeur of QUATRE_LARGEURS) {
      await page.setViewportSize({ width: largeur, height: 900 });
      await verifier(page, testInfo, `etape-4-prete-simulee-${largeur}`);
      if (largeur >= 1024) {
        const cadre = await page.locator("#cadre-applicatif").boundingBox();
        expect(cadre.y, "le cadre applicatif remonte près du haut").toBeLessThan(380);
      }
    }
    await simulerLigneDuCycle(page, "cycle:au-repos");

    await bouton(page, "Continuer : Verrouiller et rouvrir").click();
    await expect(titre(page, "Verrouiller votre coffre")).toBeVisible();
    await verifierAux(page, testInfo, "etape-5-verrouiller", DEUX_LARGEURS);

    await verrouillerEtRecharger(page);
    await expect(titre(page, "Rouvrir votre coffre")).toBeVisible(LONG);
    await verifierAux(page, testInfo, "etape-5-rouvrir", DEUX_LARGEURS);
    // « J'ai oublié ma phrase » est un bouton actif : son contour doit se voir (constat 11).
    const perdu = await page.locator("#parcours-phrase-perdue").evaluate((noeud) => ({
      bord: getComputedStyle(noeud).borderTopColor,
      fond: getComputedStyle(noeud.closest("main")).backgroundColor,
    }));
    expect(
      contraste(perdu.bord, perdu.fond),
      "contour de « J'ai oublié ma phrase »",
    ).toBeGreaterThanOrEqual(3);

    // L'étape 5 se rouvre par la PHRASE : la feuille est éprouvée depuis l'étape 3 (#239).
    await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await bouton(page, "Ouvrir mon coffre").click();
    await expect(titre(page, "Sauvegarder votre coffre")).toBeVisible(LONG);
    await verifierAux(page, testInfo, "etape-6-sauvegarder", DEUX_LARGEURS);

    // Sans machine virtuelle, le coffre n'a encore rien à sauvegarder : le refus est l'écran atteint.
    await bouton(page, "Sauvegarder mon coffre").click();
    await expect(page.getByRole("alert")).toContainText("rien à sauvegarder", LONG);
    await exigerLaTailleCourante(page, "parcours-refus");
    await verifierAux(page, testInfo, "etape-6-sauvegarde-refusee", DEUX_LARGEURS);

    await bouton(page, "Continuer : Restaurer sur un autre appareil").click();
    await expect(titre(page, "Restaurer sur un autre appareil")).toBeVisible();
    await verifierAux(page, testInfo, "etape-7-restaurer-ailleurs", DEUX_LARGEURS);
    await bouton(page, "Continuer : Récupérer votre coffre avec le code").click();
    await expect(titre(page, "Récupérer votre coffre avec le code")).toBeVisible();
    await verifierAux(page, testInfo, "etape-8-preparer", DEUX_LARGEURS);

    await verrouillerEtRecharger(page);
    await expect(page.getByLabel("Code de récupération", { exact: true })).toBeVisible(LONG);
    await verifierAux(page, testInfo, "etape-8-recuperer", DEUX_LARGEURS);
    await page
      .getByLabel("Numéro de version noté sur votre feuille (facultatif)", { exact: true })
      .fill(version);
    await page.getByLabel("Code de récupération", { exact: true }).fill(code);
    await bouton(page, "Ouvrir mon coffre avec le code").click();
    await expect(titre(page, "Révoquer en urgence")).toBeVisible(LONG);
    await verifierAux(page, testInfo, "etape-9-revoquer", DEUX_LARGEURS);

    await bouton(page, "Révoquer tous les autres moyens d'ouvrir ce coffre").click();
    await expect(titre(page, "Parcours terminé")).toBeVisible(LONG);
    await verifierAux(page, testInfo, "termine", DEUX_LARGEURS);

    // Après la visite, l'étape 4 est l'accueil : l'application et les gestes du quotidien (#239).
    await bouton(page, "Revenir à mon application").click();
    await expect(titre(page, "Votre application")).toBeVisible();
    await aucunGroupeSansNom(page, "accueil");
    await verifierAux(page, testInfo, "accueil", DEUX_LARGEURS);

    // Application démarrée (état simulé) : « Démarrer » se retire, « Verrouiller » reste, au clavier.
    await simulerLigneDuCycle(page, "cycle:application-demarree");
    await expect(bouton(page, "Démarrer l'application")).toBeHidden();
    const verrouiller = bouton(page, "Verrouiller mon coffre");
    await expect(verrouiller).toBeVisible();
    for (let appuis = 0; appuis < 60; appuis += 1) {
      if (await verrouiller.evaluate((noeud) => noeud === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(verrouiller).toBeFocused();
    await verifierAux(page, testInfo, "accueil-application-demarree", DEUX_LARGEURS);
    await simulerLigneDuCycle(page, "cycle:au-repos");
  });
}

test("clair et sombre : « Vérifier votre code » après un rechargement, 320 et 1024", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await afficherLeCode(page);
  await page.reload();
  await expect(titre(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: 60_000 });
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await verifierAux(page, testInfo, `code-verifier-${theme}`, DEUX_LARGEURS);
  }
});

test("forced-colors : bordures et focus visibles à la création, au choix et à l'étape 4 prête (simulée)", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await ouvrir(page);
  const cadre = await page.locator("main").evaluate((noeud) => ({
    style: getComputedStyle(noeud).borderTopStyle,
    largeur: getComputedStyle(noeud).borderTopWidth,
  }));
  expect(cadre.style).toBe("solid");
  expect(parseFloat(cadre.largeur)).toBeGreaterThanOrEqual(1);
  await verifier(page, testInfo, "creation");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const commencer = bouton(page, "Commencer");
  await expect(commencer).toBeFocused();
  const contour = await commencer.evaluate((noeud) => ({
    style: getComputedStyle(noeud).outlineStyle,
    largeur: getComputedStyle(noeud).outlineWidth,
    bord: getComputedStyle(noeud).borderTopStyle,
  }));
  expect(contour.style).not.toBe("none");
  expect(parseFloat(contour.largeur)).toBeGreaterThanOrEqual(3);
  expect(contour.bord).toBe("solid");
  await capturer(page, {
    path: `reports/apparence/${testInfo.project.name}-forced-colors-focus.png`,
    fullPage: true,
  });
  await page.keyboard.press("Enter");
  await expect(titre(page, "Choisir comment l'ouvrir")).toBeVisible();
  await verifier(page, testInfo, "choix");
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: 60_000 });
  await expect(page.locator("#feuille-code")).toHaveText(FORME_DU_CODE);
  const code = (await page.locator("#feuille-code").textContent()).trim();
  await eprouverLaFeuille(page, code);
  await simulerRailsPret(page);
  await aucunGroupeSansNom(page, "étape 4 prête, forced-colors");
  await verifier(page, testInfo, "etape-4-prete-simulee");
});

test("mouvement non réduit : la barre indéterminée du démarrage est visible et animée (état simulé)", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await jusquAuTravail(page);
  await simulerLigneDuCycle(page, "cycle:demarrage-en-cours");
  const barre = page.locator("#parcours-progression");
  await expect(barre).toBeVisible();
  await expect(page.locator("#parcours-attente")).toContainText("Démarrage en cours");
  await exigerLaTailleCourante(page, "parcours-attente");
  const rendu = await barre.evaluate((noeud) => ({
    indeterminee: noeud.matches(":indeterminate"),
    apparence: getComputedStyle(noeud).appearance,
  }));
  expect(rendu.indeterminee).toBe(true);
  // Sous `reduce`, la feuille retire l'apparence native (barre pleine) ; ici, elle doit rester.
  expect(rendu.apparence).not.toBe("none");
  await verifier(page, testInfo, "demarrage-simule-barre");
  await simulerLigneDuCycle(page, "cycle:au-repos");
});
