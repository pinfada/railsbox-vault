// Le PARCOURS GUIDÉ sur la coquille réelle, sans machine virtuelle : l'ORDRE et ce qu'il laisse dans
// la page (#193, ADR 0040 ; revue de la PR #213, constats 1, 2, 3, 9 et 12).
//
// L'E2E `tests/e2e/parcours-utilisateur.spec.mjs` joue le chemin nominal avec Rails. Cette suite-ci
// joue ce que la revue a ATTAQUÉ, là où aucun boot n'est nécessaire :
//
//  1. **un rechargement après l'affichage du code** ne fait créer AUCUN second code (#214) : l'écran
//     demande de vérifier le code rendu, et c'est lui qui rouvre le coffre ;
//  2. **l'URL ne saute pas la confirmation** : `?etape=4` et `?etape=6` ramènent à l'étape atteinte,
//     et la page du produit n'offre plus de lien vers la vue complète ;
//  3. **aucun code en clair ne subsiste** dans `document.body.innerHTML` après un geste qui consomme
//     un code — la confirmation, l'ouverture par le code ;
//  4. **Firefox** : l'étape 4 dit sa limite avant toute attente, et n'offre pas « Démarrer ».
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
  await page.goto(new URL(`/index.html${requete}`, SHELL_ORIGIN).toString(), { waitUntil: "commit" });
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

async function aucunCodeEnClair(page, moment) {
  const html = await page.evaluate(() => document.body.innerHTML);
  expect(CODE_EN_CLAIR.exec(html)?.[0] ?? null, `aucun code en clair ${moment}`).toBeNull();
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
  await expect(page.getByText(/effacez les données de ce site/)).toBeVisible();

  // Le code rendu, tapé depuis la feuille et validé par Entrée, rouvre le coffre et vaut confirmation.
  const champ = page.getByLabel("Code de récupération", { exact: true });
  await champ.fill(code.toLowerCase().replaceAll("-", " "));
  await expect(bouton(page, "Ouvrir mon coffre avec le code")).toBeEnabled();
  await champ.press("Enter");
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  await aucunCodeEnClair(page, "après l'ouverture par le code");
  expect(await creations(page), "un seul geste « créer un moyen de récupération »").toBe(1);
});

test("l'URL ne saute pas la confirmation, et la page n'offre aucun lien vers la vue complète", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  await expect(page.getByRole("link", { name: /vue complète/ })).toHaveCount(0);
  await creerEtAfficherLeCode(page);

  for (const etape of ["4", "6", "9"]) {
    await ouvrirLaCoquille(page, `?etape=${etape}`);
    await expect(ecran(page, "Vérifier votre code de récupération")).toBeVisible({ timeout: DELAI });
    await expect(bouton(page, "Démarrer l'application")).toBeHidden();
    await expect(bouton(page, "Sauvegarder mon coffre")).toBeHidden();
    await expect(page).toHaveURL(/etape=3/);
  }
});

test("aucun code en clair ne subsiste après la confirmation ni après l'ouverture par le code ; Firefox dit sa limite à l'étape 4", async ({
  page,
  browserName,
}) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const code = await creerEtAfficherLeCode(page);
  await bouton(page, "J'ai recopié mon code").click();
  await page.getByLabel("Code recopié depuis votre feuille", { exact: true }).fill(code);
  await bouton(page, "Confirmer mon code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
  await aucunCodeEnClair(page, "après la confirmation");

  if (browserName === "firefox") {
    // La limite est DITE avant toute attente, et rien n'y envoie attendre dix minutes.
    await expect(page.getByText(/l'application ne démarre pas dans Firefox/)).toBeVisible();
    await expect(bouton(page, "Démarrer l'application")).toBeHidden();
    return;
  }
  await expect(bouton(page, "Démarrer l'application")).toBeVisible();

  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await expect(ecran(page, "Verrouiller votre coffre")).toBeVisible();
  await bouton(page, "Verrouiller mon coffre").click();
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
  await bouton(page, "J'ai oublié ma phrase : utiliser mon code de récupération").click();
  await expect(ecran(page, "Récupérer votre coffre avec le code")).toBeVisible();
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Révoquer en urgence")).toBeVisible({ timeout: DELAI });
  await aucunCodeEnClair(page, "après l'ouverture par le code, à l'étape 8");
});
