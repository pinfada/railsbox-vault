// Le PARCOURS GUIDÉ sur la coquille réelle, sans machine virtuelle : l'ORDRE et ce qu'il laisse dans
// la page (#193, ADR 0040 ; revue de la PR #213, constats 1, 2, 3, 9 et 12).
//
// L'E2E `tests/e2e/parcours-utilisateur.spec.mjs` joue le chemin nominal avec Rails. Cette suite-ci
// joue ce que la revue a ATTAQUÉ, là où aucun boot n'est nécessaire :
//
//  1. **un rechargement après l'affichage du code** ne fait créer aucun second code DE LUI-MÊME :
//     l'écran demande d'abord de vérifier le code rendu, et c'est lui qui rouvre le coffre. La
//     personne qui n'a plus sa feuille en demande une nouvelle, et les DEUX codes ouvrent (#214) ;
//  2. **l'URL ne saute pas la confirmation** : `?etape=4` et `?etape=6` ramènent à l'étape atteinte,
//     et la page du produit n'offre plus de lien vers la vue complète ;
//  3. **aucun code en clair ne subsiste** dans `document.body.innerHTML` ni dans `parcours.json`
//     après le verrouillage qui éprouve la feuille, ni après l'ouverture par le code ;
//  4. **Firefox** : l'étape 4 dit sa limite avant toute attente, et n'offre pas « Démarrer » ;
//  5. **#239** : la feuille s'éprouve en rouvrant par le code, UNE fois ; ensuite la phrase rouvre,
//     l'étape 5 se joue par la phrase, et « Revenir à mon application » ramène à l'étape 4 ; un
//     `parcours.json` falsifié n'ouvre rien ; un coffre d'avant la correction demande son code une
//     fois, puis plus ; une enveloppe pleine dit sa sortie, et la sortie marche.
//
// Les gestes sont joués par les libellés visibles. Le compte des `creer-recuperation` est pris par un
// enregistreur posé par l'ÉPREUVE (`addInitScript`) et tenu dans `sessionStorage` pour survivre aux
// rechargements : le produit n'en tient aucun.

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { TYPES_PRIVILEGIES } from "../../src/coquille/contrat-de-messages.mjs";
import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

const PHRASE = "marqueur-de-phrase-du-parcours-193-une-phrase-assez-longue";
const DELAI = 60_000;

/** Un code de récupération en clair, tel que la revue le cherche dans la page. */
const CODE_EN_CLAIR = /[0-9A-Z]{4}(-[0-9A-Z]{4}){6}/;
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });

async function installerLeCompteur(page, type) {
  await page.addInitScript((typeCompte) => {
    const posteur = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (donnee, ...reste) {
      if (donnee?.type === typeCompte) {
        const avant = Number(sessionStorage.getItem("epreuve-parcours-creations") ?? "0");
        sessionStorage.setItem("epreuve-parcours-creations", String(avant + 1));
      }
      return posteur.call(this, donnee, ...reste);
    };
  }, type);
}

const creations = (page) =>
  page.evaluate(() => Number(sessionStorage.getItem("epreuve-parcours-creations") ?? "0"));

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

async function ouvrirLaCoquille(page, requete = "") {
  await page.goto(new URL(`/index.html${requete}`, SHELL_ORIGIN).toString(), {
    waitUntil: "commit",
  });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
}

/**
 * WebKit n'offre pas l'OPFS synchrone dans un Worker : aucun coffre ne s'y crée. La convention du
 * dépôt n'est pas un `skip` : l'état DIT l'absence, et le geste de création rend un refus lu par la
 * personne dans l'alerte du parcours.
 */
async function exigerLaLimiteDuMoteur(page) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBeTruthy();
  if ((await releve(page)).etat !== ETATS_DU_VOLUME.indisponible) return false;
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await expect(page.getByRole("alert")).toContainText("navigateur", { timeout: DELAI });
  return true;
}

/** Étapes 1 à 3 jusqu'à la feuille : rend le code affiché. */
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

async function aucunCodeEnClair(page, moment) {
  const html = await page.evaluate(() => document.body.innerHTML);
  expect(CODE_EN_CLAIR.exec(html)?.[0] ?? null, `aucun code en clair ${moment}`).toBeNull();
}

/**
 * ÉPROUVE la feuille affichée (#239) : « J'ai recopié », verrouiller — la page se recharge et le code
 * part avec elle —, puis rouvrir par le code, lu sur la feuille. Mène à l'étape 4.
 */
async function eprouverLaFeuille(page, code) {
  await bouton(page, "J'ai recopié mon code").click();
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible();
  await expect(bouton(page, "Revoir mon code")).toBeVisible();
  // Le verrouillage RECHARGE la page : l'écran d'après porte le même titre, et c'est le champ du code,
  // absent avant, qui dit que le nouveau document est là.
  await verrouillerEtRecharger(page);
  await expect(page.getByLabel("Code de récupération", { exact: true })).toBeVisible({
    timeout: DELAI,
  });
  await page.waitForLoadState("load");
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible();
  await expect(bouton(page, "Revoir mon code")).toBeHidden();
  await aucunCodeEnClair(page, "après le verrouillage qui éprouve la feuille");
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  await expect(page.getByText(/Votre feuille est juste/)).toBeVisible();
}

/** Rouvre par la PHRASE depuis « Rouvrir votre coffre ». */
async function rouvrirParLaPhrase(page) {
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Ouvrir mon coffre").click();
}

/** Écrit `parcours.json` tel qu'un script de l'origine le réécrirait (VULN-04). */
async function ecrireLaProgression(page, progression) {
  await page.evaluate(async (texte) => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await racine.getFileHandle("parcours.json", { create: true });
    const flux = await fichier.createWritable();
    await flux.write(texte);
    await flux.close();
  }, JSON.stringify(progression));
}

test("un rechargement après l'affichage du code ne crée aucun second code : le code rendu rouvre le coffre", async ({
  page,
}) => {
  await installerLeCompteur(page, TYPES_PRIVILEGIES.creerRecuperation);
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const code = await creerEtAfficherLeCode(page);
  expect(await creations(page)).toBe(1);

  // Le rechargement perd la feuille : l'écran ne propose PAS d'en afficher une autre.
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  await expect(bouton(page, "Afficher mon code de récupération")).toHaveCount(0);
  // L'écran nomme les deux sorties — en demander une nouvelle, ou révoquer si quelqu'un l'a vue —
  // et il ne conseille plus d'abandonner le coffre, ce qui n'était vrai que faute de mieux (#214).
  await expect(page.getByText(/afficher un nouveau code/).first()).toBeVisible();
  await expect(page.getByText(/ouvrirez donc d'abord avec votre phrase/)).toBeVisible();

  // Le code rendu, tapé depuis la feuille et validé par Entrée, rouvre le coffre et vaut confirmation.
  const champ = page.getByLabel("Code de récupération", { exact: true });
  await champ.fill(code.toLowerCase().replaceAll("-", " "));
  await expect(bouton(page, "Ouvrir mon coffre avec le code")).toBeEnabled();
  await champ.press("Enter");
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  await aucunCodeEnClair(page, "après l'ouverture par le code");
  expect(await creations(page), "un seul geste « créer un moyen de récupération »").toBe(1);
});

test("« je n'ai plus cette feuille » affiche un SECOND code, et les DEUX ouvrent le coffre", async ({
  page,
}) => {
  await installerLeCompteur(page, TYPES_PRIVILEGIES.creerRecuperation);
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const premier = await creerEtAfficherLeCode(page);

  // Le rechargement perd la feuille ET verrouille le coffre. La personne ne l'a plus : elle demande
  // une nouvelle feuille, et le coffre s'ouvre d'abord par la phrase — verrouillé, il n'affiche
  // aucun code.
  await page.reload({ waitUntil: "commit" });
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  expect(await creations(page)).toBe(1);
  await bouton(page, "Je n'ai plus cette feuille — afficher un nouveau code").click();
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Ouvrir mon coffre").click();

  // La sortie ne crée RIEN d'un clic : elle mène à l'annonce, qui dit de préparer son papier.
  await expect(ecran(page, "Recevoir votre code de récupération")).toBeVisible({ timeout: DELAI });
  await expect(page.getByText(/porte déjà un code de récupération/)).toBeVisible();
  expect(await creations(page), "le retour à l'annonce n'a créé aucun code").toBe(1);
  await bouton(page, "Afficher mon code de récupération").click();
  await expect(ecran(page, "Recopier votre code de récupération")).toBeVisible({ timeout: DELAI });
  const second = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
  expect(second).toMatch(FORME_DU_CODE);
  expect(second, "deux gestes rendent deux codes distincts").not.toBe(premier);
  expect(await creations(page)).toBe(2);

  // Le second code s'éprouve comme le premier : verrouiller, puis rouvrir par ce code (#239).
  await eprouverLaFeuille(page, second);
  await aucunCodeEnClair(page, "après l'ouverture par le second code");

  // `parcours.json` porte le NOUVEAU rendu, et n'a pas perdu l'origine du coffre. L'écran de
  // l'étape 4 peut précéder l'écriture du fichier : la lecture est ATTENDUE, sans délai fixe (revue
  // de la PR #219, constat 3 — intermittent sur Firefox).
  const resume = async () => {
    const progression = await lireLaProgression(page).catch(() => null);
    return {
      origine: progression?.origine,
      feuilleEprouvee: progression?.feuilleEprouvee,
      etapeQuatreAtteinte: (progression?.etapeAtteinte ?? 0) >= 4,
    };
  };
  await expect
    .poll(resume, { timeout: DELAI })
    .toEqual({ origine: "creation", feuilleEprouvee: true, etapeQuatreAtteinte: true });

  // Les DEUX codes ouvrent, dans les deux ordres : le second d'abord, l'ancien ensuite.
  for (const code of [second, premier]) {
    await recupererParLeCode(page, code);
  }
});

/** Relit `parcours.json` dans l'OPFS de l'origine de confiance, comme la page l'y écrit. */
async function lireLaProgression(page) {
  return page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const fichier = await (await racine.getFileHandle("parcours.json")).getFile();
    return JSON.parse(await fichier.text());
  });
}

/**
 * ROUVRE le coffre par le code présenté — le chemin de l'étape 8.
 *
 * Le rechargement suffit à verrouiller : le Worker de confiance meurt avec la page, et le coffre
 * avec lui. Selon l'étape déjà atteinte, la coquille montre « Rouvrir » (d'où l'on déclare la
 * phrase perdue) ou directement « Récupérer ».
 */
async function recupererParLeCode(page, code) {
  await ouvrirLaCoquille(page, "?etape=8");
  const entree = page.getByRole("heading", {
    level: 2,
    name: /^(Rouvrir votre coffre|Récupérer votre coffre avec le code|Vérifier votre code de récupération)$/,
  });
  await expect(entree).toBeVisible({ timeout: DELAI });
  const verification = (await entree.textContent()) === "Vérifier votre code de récupération";
  // L'étape 8 n'avance vers 9 que si la visite y est arrivée ; la phrase oubliée ramène à 4 (#244).
  const parLaVisite = (await entree.textContent()) === "Récupérer votre coffre avec le code";
  if ((await entree.textContent()) === "Rouvrir votre coffre") {
    await bouton(page, "J'ai oublié ma phrase : utiliser mon code de récupération").click();
  }
  await expect(
    ecran(
      page,
      verification ? "Vérifier votre code de récupération" : "Récupérer votre coffre avec le code",
    ),
  ).toBeVisible();
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(
    ecran(page, parLaVisite ? "Révoquer en urgence" : "Travailler dans l'application"),
  ).toBeVisible({ timeout: DELAI });
}

test("l'URL ne saute pas la confirmation, et la page n'offre aucun lien vers la vue complète", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  await expect(page.getByRole("link", { name: /vue complète/ })).toHaveCount(0);
  await creerEtAfficherLeCode(page);

  for (const etape of ["4", "6", "9"]) {
    await ouvrirLaCoquille(page, `?etape=${etape}`);
    await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({
      timeout: DELAI,
    });
    await expect(bouton(page, "Démarrer l'application")).toBeHidden();
    await expect(bouton(page, "Sauvegarder mon coffre")).toBeHidden();
    await expect(page).toHaveURL(/etape=3/);
  }
});

test("#239 : la feuille s'éprouve UNE fois ; ensuite la phrase rouvre, l'étape 5 se joue par la phrase, et l'on revient à l'application ; Firefox dit sa limite", async ({
  page,
  browserName,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const code = await creerEtAfficherLeCode(page);
  await eprouverLaFeuille(page, code);
  await aucunCodeEnClair(page, "après l'ouverture par le code");
  const progression = await lireLaProgression(page);
  expect(JSON.stringify(progression)).not.toMatch(CODE_EN_CLAIR);

  if (browserName === "firefox") {
    // La limite est DITE avant toute attente, et rien n'y envoie attendre dix minutes.
    await expect(page.getByText(/l'application ne démarre pas dans Firefox/)).toBeVisible();
    await expect(bouton(page, "Démarrer l'application")).toBeHidden();
    return;
  }
  await expect(bouton(page, "Démarrer l'application")).toBeVisible();

  // L'étape 5 : verrouiller, puis rouvrir par la PHRASE — la feuille éprouvée ne se redemande pas.
  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await expect(ecran(page, "Verrouiller votre coffre")).toBeVisible();
  await verrouillerEtRecharger(page);
  await rouvrirParLaPhrase(page);
  await expect(ecran(page, "Sauvegarder votre coffre")).toBeVisible({ timeout: DELAI });

  // De l'étape 6, l'application est à un geste ; « Continuer » mène à l'étape non jouée.
  await bouton(page, "Revenir à mon application").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible();
  await expect(bouton(page, "Démarrer l'application")).toBeVisible();
  await expect(bouton(page, "Continuer : Sauvegarder votre coffre")).toBeVisible();

  // Une ouverture de ROUTINE, de n'importe quelle étape : l'application.
  await ouvrirLaCoquille(page, "?etape=6");
  await rouvrirParLaPhrase(page);
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
});

test("QA de #244 : « J'ai oublié ma phrase » ouvre par le code et ramène à l'application, sans rien marquer de la visite", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const code = await creerEtAfficherLeCode(page);
  await eprouverLaFeuille(page, code);
  // Verrouillé depuis l'étape 4 : la phrase est oubliée.
  await ouvrirLaCoquille(page, "?etape=4");
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
  await expect(page.getByText(/^Étape \d sur 9$/)).toHaveCount(0);
  await bouton(page, "J'ai oublié ma phrase : utiliser mon code de récupération").click();
  await expect(ecran(page, "Récupérer votre coffre avec le code")).toBeVisible();
  await expect(page.getByText("Étape 8 sur 9", { exact: true })).toHaveCount(0);
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  await expect.poll(async () => (await lireLaProgression(page)).etapeAtteinte).toBe(4);
  await page.getByText("Où suis-je ?").click();
  await expect(page.getByRole("listitem").nth(4)).toHaveText(/à venir/);
  await expect(page.getByRole("listitem").nth(8)).toHaveText(/à venir/);
});

test("#239 : un coffre d'avant la correction demande son code UNE fois, puis la phrase suffit", async ({
  page,
  browserName,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const code = await creerEtAfficherLeCode(page);
  await expect.poll(async () => (await lireLaProgression(page)).code.rendu).toBe(true);
  // Le coffre porte un code, mais son secteur 1 n'a jamais été écrit : c'est l'état exact d'un coffre
  // d'avant #239. Son `parcours.json` est du format 1, et disait « confirmé ».
  await ecrireLaProgression(page, {
    version: 1,
    etapeAtteinte: 9,
    origine: "creation",
    code: { rendu: true, version: 2, confirme: true },
  });
  await ouvrirLaCoquille(page);
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  await expect(page.getByText(/cela ne vous est demandé qu'une fois/)).toBeVisible();
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });

  // Puis plus : verrouillé, le coffre se rouvre par la phrase, et la preuve tient.
  await ouvrirLaCoquille(page);
  await rouvrirParLaPhrase(page);
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  // Sous Firefox, l'étape 4 dit sa limite et n'offre aucun « Continuer » (constat 9).
  if (browserName !== "firefox") {
    await expect(bouton(page, "Continuer : Révoquer en urgence")).toBeVisible();
  }
});

test("#239 : une enveloppe pleine dit sa sortie, et la révocation fait de la place", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  await creerEtAfficherLeCode(page);
  // La phrase et un code : deux emplacements sur huit. Six codes de plus remplissent l'enveloppe ;
  // le suivant est refusé. Chaque code demande une page neuve : un même Worker n'en rend qu'un.
  for (let rendus = 1; rendus <= 7; rendus += 1) {
    await ouvrirLaCoquille(page);
    await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({
      timeout: DELAI,
    });
    await bouton(page, "Je n'ai plus cette feuille — afficher un nouveau code").click();
    await rouvrirParLaPhrase(page);
    await expect(ecran(page, "Recevoir votre code de récupération")).toBeVisible({
      timeout: DELAI,
    });
    if (rendus === 1) {
      // L'annonce offre de revenir : la feuille retrouvée ne coûte aucun emplacement.
      await bouton(page, "Revenir : j'ai toujours ma feuille").click();
      await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible();
      await bouton(page, "Je n'ai plus cette feuille — afficher un nouveau code").click();
      await expect(ecran(page, "Recevoir votre code de récupération")).toBeVisible();
    }
    await bouton(page, "Afficher mon code de récupération").click();
    if (rendus < 7) {
      await expect(ecran(page, "Recopier votre code de récupération")).toBeVisible({
        timeout: DELAI,
      });
    }
  }
  // Le huitième code : l'enveloppe est pleine, la conduite dit la sortie, et la sortie est là.
  await expect(page.getByRole("alert")).toContainText("huit moyens de l'ouvrir", {
    timeout: DELAI,
  });
  await expect(page.getByRole("alert")).not.toContainText("Rechargez la page");
  await expect(ecran(page, "Recevoir votre code de récupération")).toBeVisible();
  await bouton(page, "Révoquer tous les autres moyens d'ouvrir ce coffre").click();
  await expect(page.getByText(/^7 moyen\(s\) retiré\(s\)/)).toBeVisible({ timeout: DELAI });
  await bouton(page, "Afficher mon code de récupération").click();
  await expect(ecran(page, "Recopier votre code de récupération")).toBeVisible({ timeout: DELAI });
});

test("une phrase trop courte est refusée avant la création, avec un conseil à chaque saisie", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  await bouton(page, "Commencer").click();
  const phrase = page.getByLabel("Votre phrase", { exact: true });
  await expect(phrase).toHaveAttribute("minlength", "12");
  for (const faible of ["a", "aaaaaaaaaaaa"]) {
    await phrase.fill(faible);
    await bouton(page, "Créer mon coffre").click();
    await expect(page.locator("#deverrouillage-refus")).toContainText(
      /12 caractères|trop prévisible/,
    );
    await expect(page.locator("#deverrouillage-moyens")).toContainText("Aucun coffre");
    // #240 : la personne lit la règle, jamais « rechargez la page… demandez de l'aide ».
    await expect(page.getByRole("alert")).toContainText("au moins 12");
    await expect(page.getByRole("alert")).not.toContainText("Rechargez la page");
  }
  await phrase.fill(PHRASE);
  await expect(page.locator("#phrase-conseil")).toContainText("Longueur suffisante");
});

test("#239, VULN-04 : falsifier parcours.json n'ouvre aucun écran de travail", async ({
  page,
  browserName,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const code = await creerEtAfficherLeCode(page);
  await expect.poll(async () => (await lireLaProgression(page)).code.rendu).toBe(true);
  await ecrireLaProgression(page, {
    version: 2,
    etapeAtteinte: 9,
    origine: "creation",
    code: { rendu: true, version: 2 },
    feuilleEprouvee: true,
    visiteTerminee: true,
  });
  // L'indice falsifié choisit le premier formulaire — « Rouvrir » —, et rien d'autre : ouvert par la
  // phrase, le coffre n'a aucune feuille éprouvée, et le Worker le dit.
  await ouvrirLaCoquille(page, "?etape=6");
  await rouvrirParLaPhrase(page);
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  await expect(bouton(page, "Sauvegarder mon coffre")).toBeHidden();
  await expect(bouton(page, "Démarrer l'application")).toBeHidden();
  // Et l'indice est corrigé : le prochain verrouillage redemande le code.
  await expect.poll(async () => (await lireLaProgression(page)).feuilleEprouvee).toBe(false);
  await ouvrirLaCoquille(page, "?etape=6");
  await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  // L'indice « visite finie » falsifié ne change que la présentation de l'étape 4 : l'accueil porte
  // des gestes qu'un coffre éprouvé offre déjà.
  const etape4 = browserName === "firefox" ? "Travailler dans l'application" : "Votre application";
  await expect(ecran(page, etape4)).toBeVisible({ timeout: DELAI });
});
