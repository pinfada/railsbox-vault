// LE PARCOURS : une page Rails RÉELLE, rendue dans le cadre, cliquée, soumise, relue à froid
// (#192, ADR 0038 ; prérequis de l'épique #195).
//
// C'est le premier vrai « utilisateur » du dépôt. Tous les scénarios qui précèdent mesurent ce que
// le produit FAIT — il boote, il écrit, il scelle, il rouvre — ; celui-ci mesure ce que l'utilisateur
// VOIT, et ce qu'il obtient quand il clique.
//
// ## Ce qu'il prouve, dans l'ordre où il le prouve
//
//  1. la coquille se monte, encadre le courtier sur l'origine distincte et lui transfère un port ;
//  2. un geste ouvre le coffre par une phrase ; un second DÉMARRE l'application ;
//  3. le cadre imbriqué reçoit ce que RAILS rend : le document, sa feuille de style, son script
//     EXÉCUTÉ et son image. Quatre requêtes, quatre natures, zéro octet servi par l'origine
//     applicative — tout vient du guest, par le port restreint ;
//  4. un CLIC dans la page réelle ouvre une seconde page. Une SOUMISSION de formulaire crée une
//     note, rend une redirection 303 que le navigateur suit, et la note se lit sur la page d'arrivée ;
//  5. la SESSION Rails tient : le compteur de vues de la page avance, ce qui n'est possible que si
//     le cookie a fait l'aller-retour. Et le document, lui, ne le voit jamais : `document.cookie`
//     est vide des deux côtés de la frontière ;
//  6. le VERROUILLAGE retire le cadre, et une réponse EN VOL est ABANDONNÉE : elle n'est jamais
//     rendue. C'est la moitié que `tests/browser/coquille-service-applicatif.spec.mjs` ne peut pas
//     mesurer, faute d'une réponse qui mette trois cents millisecondes à revenir ;
//  7. la page est FERMÉE puis rouverte, le coffre rouvert, l'application redémarrée : la note
//     saisie dans le formulaire est RELUE, après un boot à froid. C'est la reprise de #7, jouée pour
//     la première fois sur une mutation faite par un utilisateur au lieu d'une fixture.
//
// ## Ce qu'il ne prouve PAS
//
//  - il tourne sur CHROMIUM seul, comme tous les scénarios de ce dossier. La frontière du relais est
//    mesurée sur les trois moteurs sans machine virtuelle par
//    `tests/browser/coquille-service-applicatif.spec.mjs` ; sous Firefox, Rails n'a jamais répondu
//    dans le guest (voir `tests/vm/mesure-pont-serie-http.spec.mjs`, où l'écart est daté et publié) ;
//  - il ne mesure aucun authentificateur réel : la passkey n'est pilotable que sous Chromium
//    (ADR 0021), et le moyen employé ici est la PHRASE ;
//  - il ne dit rien de la MISE EN FORME. La page servie est celle de l'application de référence,
//    volontairement nue : ce que l'utilisateur lira appartient à P2 et P3 de l'épique #195.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE, E2E_ORIGIN_COQUILLE_APP } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** La PHRASE du scénario. Publique, sans valeur : elle ouvre un coffre que l'épreuve fabrique. */
const PHRASE = "une phrase de parcours assez longue pour la calibration argon";

/** Ce que l'utilisateur tape dans le formulaire. C'est la MUTATION que le boot à froid doit relire. */
const LIBELLE = "note saisie par un utilisateur";

/** Budget d'un boot Rails DANS la coquille, geste compris. */
const BUDGET_DEMARRAGE_MS = 600_000;
/** Budget du geste de déverrouillage : Argon2id calibré, plus l'ouverture du volume. */
const BUDGET_DEVERROUILLAGE_MS = 120_000;
/** Budget d'apparition de la première page servie, réessais compris (le cadre REDEMANDE). */
const BUDGET_PREMIERE_PAGE_MS = 180_000;

/** Décrit ce qui manque pour jouer ce scénario, ou `null` si tout est là. */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image #5 absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:manifest »`;
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

/** Le journal de chaque exécution, relu par le crochet de fin. */
const journauxParEpreuve = new Map();

/** Ce qui sait lire le cadre servi, posé quand il existe et relu SEULEMENT sur un échec. */
const cadresParEpreuve = new Map();

/** Ce qui sait lire la COQUILLE, pour la même raison et au même moment. */
const coquillesParEpreuve = new Map();

/** Le relevé public de la coquille. */
async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Ouvre la coquille et attend qu'elle se déclare prête. */
async function ouvrirLaCoquille(contexte, journal = []) {
  const page = await contexte.newPage();
  const erreurs = [];
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  // Le JOURNAL de console de toutes les fenêtres — coquille, courtier, page servie — et du
  // Service Worker. Il est joint à CHAQUE exécution, réussie ou non : un scénario de trois cents
  // secondes qui échoue sans une ligne de ce que les quatre contextes ont dit coûte une seconde
  // exécution pour apprendre ce que la première savait déjà.
  page.on("console", (message) => {
    journal.push(`${message.type()} ${message.text()}`.slice(0, 400));
  });
  page.on("requestfailed", (requete) => {
    journal.push(
      `requete-echouee ${requete.method()} ${requete.url()} — ${requete.failure()?.errorText ?? "?"}`,
    );
  });
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60_000 });
  return { page, erreurs };
}

/** OUVRE le coffre par la phrase — le geste de l'utilisateur, sur le chemin de produit. */
async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: BUDGET_DEVERROUILLAGE_MS })
    .toBe("ouvert");
}

/** DÉMARRE l'application, et rend ce que la coquille en publie. */
async function demarrerLApplication(page) {
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText("cycle:application-demarree", {
    timeout: BUDGET_DEMARRAGE_MS,
  });
  return (await releve(page)).application;
}

/** Le CADRE IMBRIQUÉ où vit ce que Rails rend : dans le courtier, lui-même dans la coquille. */
function pageServie(page) {
  return page.frameLocator("#document-applicatif").frameLocator("#application-servie");
}

/**
 * La CLÉ sous laquelle ce scénario range le relevé publié JUSTE AVANT le rechargement.
 *
 * Elle appartient à l'ÉPREUVE : le produit n'écrit rien dans `sessionStorage`, et la sonde
 * d'exfiltration de #162 le mesure. Le procédé est celui de
 * `tests/e2e/reprise-coquille-boot-froid.spec.mjs`, pour la même raison : le verrouillage se termine
 * par un rechargement, et le relevé qui décrit cette session disparaît avec le document.
 */
const CLE_DE_CAPTURE = "epreuve-parcours-192";

/** ARME la capture, sur le CONTEXTE : elle doit survivre à la navigation du rechargement. */
async function armerLaCapture(contexte) {
  await contexte.addInitScript((cle) => {
    // Le script d'initialisation s'exécute dans CHAQUE document du contexte, y compris ceux qui
    // n'ont pas encore d'élément racine. Le branchement est donc DIFFÉRÉ, et il ne jette jamais :
    // une erreur de page ferait rougir ce scénario pour une raison qui n'est pas la sienne.
    const brancher = () => {
      const racine = document?.documentElement;
      if (!racine) return false;
      new MutationObserver(() => {
        if (racine.dataset.coquille !== "verrouille") return;
        const noeud = document.querySelector("#coquille-rapport");
        if (noeud !== null) sessionStorage.setItem(cle, noeud.textContent);
      }).observe(racine, { attributes: true, attributeFilter: ["data-coquille"] });
      return true;
    };
    try {
      if (brancher()) return;
    } catch {
      /* un document qui refuse l'observation n'est pas celui de la coquille */
    }
    addEventListener(
      "DOMContentLoaded",
      () => {
        try {
          brancher();
        } catch {
          /* idem */
        }
      },
      { once: true },
    );
  }, CLE_DE_CAPTURE);
}

/**
 * ATTEND le verrouillage, et dit où il en était s'il n'arrive pas.
 *
 * L'évaluation est GARDÉE : le verrouillage se termine par un rechargement, et une évaluation posée
 * pendant la navigation voit son contexte d'exécution détruit. L'échec n'est pas un défaut — c'est
 * ce que le scénario mesure —, et la question se repose au tour suivant.
 */
async function attendreLeVerrouillage(session, budgetMs) {
  const limite = Date.now() + budgetMs;
  const vus = [];
  while (Date.now() < limite) {
    const capture = await session.page
      .evaluate((cle) => sessionStorage.getItem(cle), CLE_DE_CAPTURE)
      .catch(() => null);
    if (capture !== null) return JSON.parse(capture);
    const dit = await session.page
      .evaluate(() => ({
        coquille: document.documentElement.dataset.coquille ?? null,
        cycle: document.querySelector("#cycle-etat")?.textContent ?? null,
      }))
      .catch(() => null);
    const trace = JSON.stringify(dit);
    if (dit !== null && vus.at(-1) !== trace) vus.push(trace);
    await session.page.waitForTimeout(1_000).catch(() => {});
  }
  throw new Error(
    `Aucun verrouillage capturé en ${budgetMs} ms. Ce que la coquille a dit : ${vus.join(" → ")}`,
  );
}

/** Ce que le cadre SERVI affiche, tronqué. Il ne jette jamais : un cadre absent est un fait. */
async function texteDuCadre(cadre) {
  try {
    return (await cadre.locator("body").innerText()).slice(0, 600);
  } catch (erreur) {
    return `illisible (${erreur?.message?.split("\n")[0] ?? "?"})`;
  }
}

/** Le relevé du COURTIER, tel que le document applicatif le publie. */
async function releveDuCourtier(page) {
  const texte = await page
    .frameLocator("#document-applicatif")
    .locator("#document-applicatif-rapport")
    .textContent();
  return JSON.parse(texte);
}

/**
 * ATTEND que la page d'accueil de Rails soit rendue dans le cadre imbriqué.
 *
 * Le cadre REDEMANDE tant que l'application n'est pas démarrée — c'est la conduite du courtier, et
 * c'est pour cela que le budget est celui d'un boot et non celui d'une navigation.
 */
async function attendreLaPremierePage(page) {
  const depart = Date.now();
  await expect(pageServie(page).locator("body")).toHaveAttribute(
    "data-application-de-reference",
    "rendue",
    { timeout: BUDGET_PREMIERE_PAGE_MS },
  );
  return Date.now() - depart;
}

test("une page Rails réelle est servie dans le cadre, cliquée, soumise, et relue après un boot à froid", async ({
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "parcours-page-rails.spec.mjs");
  test.setTimeout(1_500_000);

  const mesures = {};
  /** Ce que les fenêtres et le Service Worker ont dit, joint en fin d'exécution quoi qu'il arrive. */
  const journal = [];
  journauxParEpreuve.set(testInfo.testId, journal);

  await armerLaCapture(context);

  // --- 1 à 3. La coquille, le coffre, l'application, puis la PAGE ---------------------------------
  let session = await ouvrirLaCoquille(context, journal);
  coquillesParEpreuve.set(testInfo.testId, () => session);
  await expect(session.page.frameLocator("#document-applicatif").locator("html")).toHaveAttribute(
    "data-document-applicatif",
    "servi",
    { timeout: 30_000 },
  );
  const initial = await releve(session.page);
  expect(initial.origineApplicative).toBe(E2E_ORIGIN_COQUILLE_APP);

  // La COQUILLE DE CADRE s'est installée, et son Service Worker est ACTIF. C'est le mécanisme que
  // l'ADR 0038 retient, et il ne s'installe que là où la frontière existe vraiment.
  await expect
    .poll(async () => (await releveDuCourtier(session.page)).coquilleDeCadre.serviceWorker, {
      timeout: 60_000,
    })
    .toBe("actif");
  const courtierInitial = await releveDuCourtier(session.page);
  expect(courtierInitial.coquilleDeCadre.installee).toBe(true);
  expect(courtierInitial.coquilleDeCadre.cadreServi).toBe("/");

  await ouvrirParLaPhrase(session.page);
  const demarrage = await demarrerLApplication(session.page);
  expect(demarrage.demarree).toBe(true);
  mesures.bootMs = demarrage.bootMs;

  mesures.premierePageMs = await attendreLaPremierePage(session.page);

  // CE QUE RAILS REND, et rien d'autre. Les quatre natures de requête, mesurées chacune par ce
  // qu'elle PRODUIT plutôt que par sa présence : un actif servi sous le mauvais type est un actif
  // qui ne s'applique pas, et l'épreuve le verrait.
  const servie = pageServie(session.page);
  await expect(servie.locator("h1")).toHaveText("Application de référence");
  // Le SCRIPT s'est exécuté : servi sous un type que le navigateur refuse, il ne l'aurait pas fait.
  await expect(servie.locator("html")).toHaveAttribute("data-script-applicatif", "execute", {
    timeout: 30_000,
  });
  // La FEUILLE DE STYLE s'applique : la couleur de fond vient d'elle, et elle seule.
  const fond = await servie
    .locator("body")
    .evaluate((corps) => getComputedStyle(corps).backgroundColor);
  expect(fond, "la feuille de style servie par le guest ne s'applique pas").toBe(
    "rgb(244, 244, 239)",
  );
  // L'IMAGE est arrivée entière : un PNG tronqué ou servi sous le mauvais type rendrait 0.
  const largeurDeLImage = await servie.locator("#marque").evaluate((image) => image.naturalWidth);
  expect(largeurDeLImage, "l'image servie par le guest n'a pas été décodée").toBe(32);

  // --- 4. Le CLIC et la SOUMISSION, dans la page réelle -------------------------------------------
  const departSoumission = Date.now();
  await servie.locator("#libelle").fill(LIBELLE);
  await servie.locator("#enregistrer").click();
  // Ce que le cadre PORTERA si l'assertion suivante échoue est relevé par le crochet de fin, et
  // non ici : une attente de diagnostic posée dans l'intervalle mesuré ferait publier huit
  // secondes pour un geste qui en coûte quelques centaines.
  cadresParEpreuve.set(testInfo.testId, () => texteDuCadre(servie));
  // La REDIRECTION 303 est suivie par le navigateur : la page d'arrivée est celle de la note.
  await expect(servie.locator("#libelle-note")).toHaveText(LIBELLE, { timeout: 120_000 });
  mesures.soumissionMs = Date.now() - departSoumission;
  const identifiantDeLaNote = (await servie.locator("#identifiant-note").textContent()).trim();
  expect(identifiantDeLaNote).toMatch(/^[0-9a-f-]{36}$/);

  // Un CLIC ordinaire, sur un lien ordinaire : la page suivante est servie par le même chemin.
  const departPageSuivante = Date.now();
  await servie.locator("#retour").click();
  await expect(servie.locator(`[data-note="${identifiantDeLaNote}"]`)).toHaveText(LIBELLE, {
    timeout: 120_000,
  });
  mesures.pageSuivanteMs = Date.now() - departPageSuivante;

  // --- 5. La SESSION Rails tient, et le document ne voit JAMAIS son cookie ------------------------
  const vues = Number.parseInt(
    (await servie.locator("#vues").textContent()).replace(/\D+/g, ""),
    10,
  );
  expect(
    vues,
    "le compteur de vues n'a pas avancé : le cookie de session n'a pas tenu",
  ).toBeGreaterThan(1);

  const cookies = {
    coquille: await session.page.evaluate(() => document.cookie),
    courtier: await session.page
      .frameLocator("#document-applicatif")
      .locator("body")
      .evaluate(() => document.cookie),
    servie: await servie.locator("body").evaluate(() => document.cookie),
  };
  expect(
    cookies,
    "un cookie est visible quelque part : le bocal devait rester dans le Worker de confiance",
  ).toEqual({ coquille: "", courtier: "", servie: "" });
  // Et le bocal du navigateur est vide sur les DEUX origines : `document.cookie` ne voit pas un
  // cookie `HttpOnly`, mais le contexte, lui, le verrait.
  const bocalDuContexte = await context.cookies();
  expect(
    bocalDuContexte,
    `le contexte porte des cookies : ${JSON.stringify(bocalDuContexte)}`,
  ).toEqual([]);

  // --- 6. Le VERROUILLAGE : le cadre part, et une réponse EN VOL est ABANDONNÉE -------------------
  //
  // La course est PROVOQUÉE : une requête part, et le verrouillage la suit sans l'attendre. Elle met
  // quelques centaines de millisecondes à revenir — la mesure du 12 septembre 2026 publie 351,5 ms
  // pour la page d'accueil —, si bien qu'elle arrive APRÈS. Ce qu'elle ne doit jamais faire est
  // d'être rendue : le verrouillage a retiré le cadre, et des pixels du coffre s'y peindraient.
  //
  // Le lien CLIQUÉ est celui de la note, qui existe sur la page où le scénario se trouve — et le
  // clic porte une BORNE : une action « au mieux » sans borne attend pour toujours un élément
  // absent, et c'est ce qui a fait expirer ce scénario à vingt-cinq minutes le 12 septembre 2026.
  await servie
    .locator(`[data-note="${identifiantDeLaNote}"]`)
    .click({ timeout: 10_000 })
    .catch(() => {});
  await session.page.click("#verrouiller-le-coffre");

  // Le CADRE RETIRÉ se lit dans le RELEVÉ publié au moment du verrouillage, et non dans le DOM.
  //
  // La différence n'est pas un détail de technique d'épreuve : le verrouillage retire le cadre PUIS
  // recharge la coquille, laquelle en recrée un. Guetter « zéro cadre » dans le DOM revient donc à
  // courir après un état qui dure le temps d'un tour de boucle — mesuré le 12 septembre 2026 : la
  // même assertion a passé une fois et expiré la suivante, sur un produit identique. Ce que la
  // coquille PUBLIE, lui, est stable : `cadreApplicatif: "retire"`, dans le relevé qu'elle pose
  // avant de recharger.
  const ferme = await attendreLeVerrouillage(session, 120_000);
  expect(ferme.cadreApplicatif, "le verrouillage n'a pas retiré le cadre").toBe("retire");
  expect(ferme.etat).toBe("verrouille");
  expect(ferme.verrouillage.workerTermine).toBe(true);
  // Ce que le RELAIS a fait de la requête lancée juste avant : servie si elle est revenue à temps,
  // ABANDONNÉE sinon — et jamais rendue après coup. Les deux comptes sont publiés ; leur somme ne
  // dépasse jamais ce qui a été demandé, et c'est la propriété qui compte.
  expect(ferme.relais.servies + ferme.relais.abandonnees).toBeLessThanOrEqual(
    ferme.relais.demandees,
  );
  expect(CODES_REFUS_COQUILLE.relaisAbandonne).toBe("VAULT_COQUILLE_RELAIS_ABANDONNE");

  await expect(session.page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 120_000,
  });
  const rechargee = await releve(session.page);
  expect(rechargee.etat).toBe("verrouille");
  // Et le cadre ne revient pas tout seul : la coquille rouverte est VERROUILLÉE, sans application.
  await expect(session.page.locator("#document-applicatif")).toHaveCount(1, { timeout: 60_000 });
  // Et la coquille rouverte NE SERT PLUS RIEN : le cadre redemande, et le relais lui répond que
  // l'application n'est pas démarrée. C'est la preuve par le produit que le verrouillage a bien
  // coupé le service, et non seulement retiré des pixels.
  await expect
    .poll(async () => (await releveDuCourtier(session.page)).coquilleDeCadre.attente, {
      timeout: 60_000,
    })
    .toMatch(/^application-non-demarree/);

  await session.page.close();
  expect(session.erreurs, "aucune erreur de page pendant la première session").toEqual([]);

  // --- 7. BOOT À FROID : la note saisie par l'utilisateur est RELUE -------------------------------
  session = await ouvrirLaCoquille(context, journal);
  expect((await releve(session.page)).etat, "la coquille rouvre VERROUILLÉE").toBe("verrouille");
  await ouvrirParLaPhrase(session.page);
  const second = await demarrerLApplication(session.page);
  expect(second.demarree).toBe(true);
  expect(second.installation.installee, "le disque applicatif n'est pas réinstallé").toBe(false);
  mesures.secondBootMs = second.bootMs;

  const apresFroid = await attendreLaPremierePage(session.page);
  mesures.premierePageApresFroidMs = apresFroid;
  const servieAFroid = pageServie(session.page);
  // LE POINT DU SCÉNARIO : ce qu'un utilisateur a tapé dans un formulaire, dans une page rendue par
  // le guest, survit à la fermeture complète et se relit après un boot à froid.
  await expect(
    servieAFroid.locator(`[data-note="${identifiantDeLaNote}"]`),
    "la note saisie par l'utilisateur n'a pas survécu au boot à froid",
  ).toHaveText(LIBELLE, { timeout: 120_000 });
  // La SESSION Rails, elle, n'a PAS survécu — et c'est la conduite juste : le bocal meurt avec le
  // Worker, et le guest qui vient de booter ne connaît aucune des anciennes sessions.
  const vuesAFroid = Number.parseInt(
    (await servieAFroid.locator("#vues").textContent()).replace(/\D+/g, ""),
    10,
  );
  expect(vuesAFroid, "une session Rails a survécu au verrouillage").toBe(1);

  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const rapport = {
    mesureLe: new Date().toISOString(),
    navigateur: await session.page.evaluate(() => navigator.userAgent),
    note: { identifiant: identifiantDeLaNote, libelle: LIBELLE },
    mesures,
  };
  writeFileSync(
    join(DOSSIER_RAPPORTS, "parcours-page-rails.json"),
    `${JSON.stringify(rapport, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("parcours-page-rails.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });
  process.stdout.write(
    `\n[parcours] première page ${mesures.premierePageMs} ms · page suivante ` +
      `${mesures.pageSuivanteMs} ms · soumission ${mesures.soumissionMs} ms · ` +
      `boot ${Math.round(mesures.bootMs)} ms puis ${Math.round(mesures.secondBootMs)} ms · ` +
      `première page après boot à froid ${mesures.premierePageApresFroidMs} ms\n`,
  );

  await session.page.close();
  expect(session.erreurs, "aucune erreur de page pendant la seconde session").toEqual([]);
});

test.afterEach(async ({ page: _page }, testInfo) => {
  void _page;
  // Le journal est attaché par le crochet plutôt que par le corps : un scénario qui échoue au
  // milieu n'atteint jamais sa dernière ligne, et c'est précisément là qu'on a besoin de lire ce
  // que les fenêtres ont dit.
  const journal = journauxParEpreuve.get(testInfo.testId) ?? [];
  // Sur un ÉCHEC seulement : ce que le cadre servi affichait au moment où l'épreuve a renoncé.
  // C'est la seule chose qu'un « élément introuvable » ne dit jamais, et c'est celle qui manque.
  if (testInfo.status !== "passed") {
    const lireLeCadre = cadresParEpreuve.get(testInfo.testId);
    if (lireLeCadre) journal.push(`cadre-a-l-echec ${await lireLeCadre()}`);
    const lireLaSession = coquillesParEpreuve.get(testInfo.testId);
    const session = lireLaSession?.();
    if (session) {
      const dit = await session.page
        .evaluate(() => {
          const noeud = document.querySelector("#coquille-rapport");
          const releve = noeud === null ? {} : JSON.parse(noeud.textContent);
          return {
            workerMort: releve.workerMort ?? null,
            application: releve.application ?? null,
            relais: releve.relais ?? null,
            refusDeRequete: releve.refusDeRequete ?? null,
            cycle: (releve.cycle ?? []).map((etape) => `${etape.etape}:${etape.issue}`),
          };
        })
        .catch((erreur) => ({ illisible: erreur?.message?.slice(0, 120) ?? null }));
      journal.push(`coquille-a-l-echec ${JSON.stringify(dit)}`);
      journal.push(`erreurs-de-page ${JSON.stringify(session.erreurs)}`);
    }
  }
  if (journal.length === 0) return;
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(join(DOSSIER_RAPPORTS, "journal-parcours.txt"), journal.join("\n"), "utf8");
  await testInfo.attach("journal-des-fenetres.txt", {
    body: journal.join("\n"),
    contentType: "text/plain",
  });
});
