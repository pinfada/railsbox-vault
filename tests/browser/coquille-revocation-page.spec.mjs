// La RÉVOCATION D'URGENCE câblée sur la coquille RÉELLE (#265, ADR 0049 § C2) : le vrai Worker de
// confiance, le vrai canal, le vrai DOM, trois moteurs. Aucune machine virtuelle.
//
// Ce que cette suite mesure, et qu'aucune épreuve en Node ne peut mesurer :
//  - l'ORDRE du DOM est l'ordre visuel et l'ordre de tabulation : « Terminer sans révoquer » d'abord ;
//  - la confirmation EN DEUX TEMPS, le focus sur « Annuler », et aucun message posé avant « Oui » ;
//  - le conteneur est MASQUÉ au moment où le message part (relevé par un enregistreur posé par l'ÉPREUVE
//    sur `postMessage`), et ne reste jamais visible pendant une modification ;
//  - un seul message `revoquerEnUrgence`, même sous un double clic ; aucun nouveau geste après l'acquit ;
//  - une réponse MALFORMÉE devient un doute : « peut-être », jamais « refusée », aucune nouvelle demande ;
//  - ajouter un code pendant une confirmation l'OUBLIE ;
//  - après rechargement, l'indice persisté n'ouvre que « aucun geste de révocation dans cette séance ».
//
// WebKit n'offre pas l'OPFS synchrone dans un Worker : la coquille y publie `indisponible`, aucun coffre
// ne s'y ouvre, et la limite est EXIGÉE ici — `test.skip` avec sa raison mesurée —, pas contournée.

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { TYPES_PRIVILEGIES } from "../../src/coquille/contrat-de-messages.mjs";
import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const PHRASE = "une phrase assez longue pour la revocation d'urgence 265";
const DELAI = 90_000;

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

/** Enregistre, pour chaque message posé sur un port, l'état du conteneur d'affichage AU DÉPART. */
async function installerLEnregistreur(page, typeRevocation, typeInventaire) {
  await page.addInitScript(
    ([revocation, inventaire]) => {
      const poster = MessagePort.prototype.postMessage;
      window.__envois = [];
      window.__alterer = null;
      MessagePort.prototype.postMessage = function (donnee, ...reste) {
        const type = donnee?.type;
        if (typeof type === "string") {
          const c = document.getElementById("affichage");
          window.__envois.push({
            type,
            estampille: c?.hasAttribute("data-vue") ?? null,
            cache: c?.hidden ?? null,
          });
          // L'épreuve peut faire répondre « inventaire » à une révocation : la réponse est MALFORMÉE.
          if (type === revocation && window.__alterer === "malformee") {
            return poster.call(this, { ...donnee, type: inventaire }, ...reste);
          }
        }
        return poster.call(this, donnee, ...reste);
      };
    },
    [typeRevocation, typeInventaire],
  );
}

const envois = (page, type) =>
  page.evaluate((cible) => window.__envois.filter((e) => e.type === cible), type);

async function ouvrirLaCoquille(page, requete = "?vue=complete") {
  await installerLEnregistreur(
    page,
    TYPES_PRIVILEGIES.revoquerEnUrgence,
    TYPES_PRIVILEGIES.inventaire,
  );
  await page.goto(new URL(`/index.html${requete}`, SHELL_ORIGIN).toString(), {
    waitUntil: "commit",
  });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", /prete|sans-cadre/, {
    timeout: DELAI,
  });
  if ((await releve(page)).etat === ETATS_DU_VOLUME.indisponible) {
    test.skip(
      true,
      "WebKit : pas d'OPFS synchrone dans un Worker, aucun coffre ne s'y ouvre (mesuré)",
    );
  }
}

const attendreLEtat = (page, etat) =>
  expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe(etat);

async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
}

async function creerLaFeuille(page) {
  await page.click("#creer-recuperation");
  await expect(page.locator("#feuille-code")).not.toBeEmpty({ timeout: DELAI });
  const version = (await page.locator("#feuille-version").textContent()).match(/\d+/)[0];
  return { code: (await page.locator("#feuille-code").textContent()).trim(), version };
}

async function ouvrirParLeCode(page, { code, version }) {
  await page.fill("#ancre-version", version);
  await page.fill("#saisie-code", code);
  await expect(page.locator("#ouvrir-par-code")).toBeEnabled();
  await page.click("#ouvrir-par-code");
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
}

/** Un coffre ouvert par la phrase, doté d'une feuille : P, prêt à révoquer. */
async function coffreOuvert(page) {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  const feuille = await creerLaFeuille(page);
  await expect(page.locator("#revoquer-en-urgence")).toBeVisible({ timeout: DELAI });
  return feuille;
}

const annonce = (page) => page.locator("#affichage-annonce");

test("[ordre] « Terminer sans révoquer » précède « Révoquer… » dans le DOM, à l'écran et à la tabulation", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  const ordre = await page.evaluate(() => {
    const sortie = document.getElementById("parcours-sans-revoquer");
    const revoquer = document.getElementById("revoquer-en-urgence");
    return {
      dom: Boolean(sortie.compareDocumentPosition(revoquer) & Node.DOCUMENT_POSITION_FOLLOWING),
      haut: sortie.getBoundingClientRect().top < revoquer.getBoundingClientRect().top,
      principal: [sortie, revoquer].map((b) => b.hasAttribute("data-principal-de-la-vue")),
      danger: revoquer.hasAttribute("data-danger"),
    };
  });
  expect(ordre.dom, "ordre du DOM").toBe(true);
  expect(ordre.haut, "ordre visuel").toBe(true);
  expect(ordre.principal, "« Terminer sans révoquer » est le principal, pas « Révoquer… »").toEqual(
    [true, false],
  );
  expect(ordre.danger).toBe(true);
  await page.locator("#parcours-sans-revoquer").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#revoquer-en-urgence"), "tabulation : le suivant").toBeFocused();
});

test("[deux temps] « Révoquer… » n'envoie rien ; « Annuler » ferme ; « Oui » envoie UN message, conteneur masqué", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  await page.click("#revoquer-en-urgence");
  await expect(page.getByRole("group", { name: "Confirmer la révocation" })).toBeVisible();
  await expect(page.locator("#revocation-annuler"), "le focus va à la sortie sûre").toBeFocused();
  expect(await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence)).toHaveLength(0);
  const texte = await page.locator("#revocation-confirmation-texte").textContent();
  expect(texte).toMatch(/irréversible/);
  expect(texte).toMatch(/Rien n'est retiré tant que vous n'avez pas cliqué/);

  await page.click("#revocation-annuler");
  await expect(page.locator("#revocation-confirmation")).toHaveCount(0);
  await expect(
    page.locator("#revoquer-en-urgence"),
    "le focus revient au geste ouvrant",
  ).toBeFocused();
  await expect(annonce(page)).toContainText("dans cette séance");
  expect(await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence)).toHaveLength(0);

  await page.click("#revoquer-en-urgence");
  // Un double clic : le second arrive sur le même nœud, dans le même tour, avant tout rendu.
  await page.evaluate(() => {
    const oui = document.getElementById("revocation-oui");
    oui.click();
    oui.click();
  });
  await expect(page.locator("#portabilite-etat")).toContainText("portabilite:revoque:", {
    timeout: DELAI,
  });
  const partis = await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence);
  expect(partis, "un seul message, malgré le double clic").toHaveLength(1);
  expect(partis[0].estampille, "l'affichage était masqué quand le message est parti").toBe(false);
  expect(partis[0].cache).toBe(true);
});

test("[acquit] après la réponse du coffre : « La révocation a été faite », plus de geste, l'inventaire relu", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  await page.click("#revoquer-en-urgence");
  await page.click("#revocation-oui");
  await expect(page.locator("#affichage")).toContainText("La révocation a été faite", {
    timeout: DELAI,
  });
  const bouton = page.locator("#revoquer-en-urgence");
  await expect(bouton).toHaveAttribute("aria-disabled", "true");
  await bouton.dispatchEvent("click");
  await expect(annonce(page)).toContainText("déjà été faite");
  expect(await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence)).toHaveLength(1);
  const rapport = await releve(page);
  expect(rapport.portabilite.revocation.nombreRestants).toBe(1);
  // Le miroir est écrit par l'effet `publier` : le constat suit l'inventaire RELU, pas l'ancien.
  expect(typeof rapport.feuilleEprouvee).toBe("boolean");
});

test("[doute] une réponse MALFORMÉE dit « peut-être » — jamais « refusée » — et n'offre plus de révocation", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  await page.evaluate(() => {
    window.__alterer = "malformee";
  });
  await page.click("#revoquer-en-urgence");
  await page.click("#revocation-oui");
  const affichage = page.locator("#affichage");
  await expect(affichage).toContainText("peut-être", { timeout: DELAI });
  await expect(affichage).not.toContainText(/refus[ée]e/i);
  await expect(page.locator("#revoquer-en-urgence")).toHaveCount(0);
  await expect(page.locator("#affichage-region")).toBeVisible();
  expect(await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence)).toHaveLength(1);
  // La conduite : rouvrir pour vérifier.
  await expect(affichage).toContainText("Rouvrez votre coffre");
});

test("[C2-3] ajouter un code pendant une confirmation OUBLIE la confirmation", async ({ page }) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  await page.click("#revoquer-en-urgence");
  await expect(page.locator("#revocation-confirmation")).toBeVisible();
  await page.click("#creer-recuperation");
  await expect(page.locator("#revocation-confirmation")).toHaveCount(0, { timeout: DELAI });
  expect(await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence)).toHaveLength(0);
  await expect(page.locator("#feuille-code")).not.toBeEmpty({ timeout: DELAI });
});

test("[C2-11] pendant une modification de l'enveloppe, le conteneur est masqué : jamais d'ancienne affirmation visible", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  const trace = page.evaluate(
    () =>
      new Promise((rendre) => {
        const c = document.getElementById("affichage");
        const vus = [];
        new MutationObserver(() => vus.push(c.hasAttribute("data-vue"))).observe(c, {
          attributes: true,
          attributeFilter: ["data-vue"],
        });
        document.getElementById("creer-recuperation").click();
        setTimeout(() => rendre(vus), 6_000);
      }),
  );
  await expect(page.locator("#feuille-code")).not.toBeEmpty({ timeout: DELAI });
  const vus = await trace;
  expect(vus[0], "le premier changement est un MASQUAGE").toBe(false);
  expect(vus.at(-1), "et le conteneur est republié une fois la lecture acceptée").toBe(true);
});

test("[C2-2] « Terminer sans révoquer » ne révoque rien et dit « aucun geste de révocation dans cette séance »", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await coffreOuvert(page);
  await page.click("#parcours-sans-revoquer");
  await expect(annonce(page)).toContainText("dans cette séance");
  expect(await envois(page, TYPES_PRIVILEGIES.revoquerEnUrgence)).toHaveLength(0);
});

test("[sans script] sans le script de la coquille, rien n'est affirmé : le conteneur est masqué par le CSS seul", async ({
  page,
}) => {
  await page.route("**/main.mjs", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString());
  const etat = await page.evaluate(() => {
    const c = document.getElementById("affichage");
    c.hidden = false;
    c.textContent = "Ce coffre s'ouvre par une phrase";
    const visible = (id) => getComputedStyle(document.getElementById(id)).display !== "none";
    return { conteneur: visible("affichage"), attente: visible("affichage-attente") };
  });
  expect(etat).toEqual({ conteneur: false, attente: true });
});

test("[D4] après rechargement, l'indice persisté n'ouvre que « aucun geste de révocation dans cette séance »", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const feuille = await coffreOuvert(page);
  // Rouvrir par le CODE : c'est ce qui fait constater la feuille au Worker (#239).
  await page.reload();
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await ouvrirParLeCode(page, feuille);
  // Le fichier de progression d'une personne arrivée à l'étape 9, qui y a révoqué avant le rechargement.
  await page.evaluate(async () => {
    const { PROGRESSION_INITIALE, ecrireProgression, progressionApres } =
      await import("/src/coquille/parcours.mjs");
    let progression = progressionApres(PROGRESSION_INITIALE, "feuille", true);
    progression = progressionApres(progression, "etape", 9);
    progression = progressionApres(progression, "revocation-faite");
    const racine = await navigator.storage.getDirectory();
    const flux = await (
      await racine.getFileHandle("parcours.json", { create: true })
    ).createWritable();
    await flux.write(ecrireProgression(progression));
    await flux.close();
  });
  await page.goto(new URL("/index.html?etape=9", SHELL_ORIGIN).toString());
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  // Chaque publication du conteneur est relevée : ce que la personne a pu LIRE, état après état.
  await page.evaluate(() => {
    window.__publications = [];
    const c = document.getElementById("affichage");
    new MutationObserver(() => {
      if (c.hasAttribute("data-vue")) window.__publications.push(c.textContent);
    }).observe(c, { attributes: true, attributeFilter: ["data-vue", "data-occurrence"] });
  });
  await ouvrirParLaPhrase(page);
  await expect
    .poll(() => page.evaluate(() => window.__publications.length), { timeout: DELAI })
    .toBeGreaterThan(1);
  const lues = await page.evaluate(() => window.__publications);
  expect(
    lues.some((texte) =>
      texte.includes("Aucun geste de révocation n'a été fait dans cette séance"),
    ),
    "la fin offerte par l'indice ne dit que « aucun geste dans cette séance »",
  ).toBe(true);
  for (const texte of lues) expect(texte).not.toMatch(/La révocation a été faite|révoqué\b/i);
});

test("[C2-17] deux documents, fermetures INVERSÉES : le fichier final est celui de l'ancien, et aucun écran de travail ne s'ouvre", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await coffreOuvert(page);
  // Un coffre dont le code existe mais n'a JAMAIS ouvert le coffre : le Worker ne constate rien.
  const ancien = {
    version: 2,
    etapeAtteinte: 9,
    origine: "creation",
    code: { rendu: true, version: 7 },
    feuilleEprouvee: true,
    visiteTerminee: true,
    revocationFaite: true,
  };
  const neuf = {
    version: 2,
    etapeAtteinte: 3,
    origine: "restauration",
    code: { rendu: false, version: null },
    feuilleEprouvee: false,
    visiteTerminee: false,
    revocationFaite: false,
  };
  // X ouvre son flux d'écriture ; Y remet à zéro ET FERME d'abord ; X ferme ensuite : X l'emporte.
  await page.evaluate(async (texte) => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await racine.getFileHandle("parcours.json", { create: true });
    window.__fluxDeX = await fichier.createWritable();
    await window.__fluxDeX.write(texte);
  }, JSON.stringify(ancien));
  const autre = await context.newPage();
  await autre.goto(new URL("/index.html?vue=complete", SHELL_ORIGIN).toString(), {
    waitUntil: "commit",
  });
  await autre.evaluate(async (texte) => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await racine.getFileHandle("parcours.json", { create: true });
    const flux = await fichier.createWritable();
    await flux.write(texte);
    await flux.close();
  }, JSON.stringify(neuf));
  await autre.close();
  await page.evaluate(() => window.__fluxDeX.close());
  const final = await page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await (await racine.getFileHandle("parcours.json")).getFile();
    return JSON.parse(await fichier.text());
  });
  expect(final.etapeAtteinte, "la fermeture inversée : le fichier est celui de X").toBe(9);

  // Un troisième document recharge, demande l'étape 9 et ouvre par la phrase : le constat du Worker est
  // « non éprouvée ». L'écran est celui de la VÉRIFICATION de la feuille — jamais l'étape 9.
  await page.goto(new URL("/index.html?etape=9", SHELL_ORIGIN).toString());
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await ouvrirParLaPhrase(page);
  await expect(
    page.getByRole("heading", { level: 2, name: "Vérifier votre code de récupération" }),
  ).toBeVisible({ timeout: DELAI });
  await expect(page.locator("#revoquer-en-urgence")).toHaveCount(0);
  await expect(page.locator("#parcours-sans-revoquer")).toHaveCount(0);
});
