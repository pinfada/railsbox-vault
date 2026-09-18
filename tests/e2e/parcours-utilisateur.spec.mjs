// Le PARCOURS UTILISATEUR, joué comme une personne le joue (#193, ADR 0040).
//
// ## Ce qu'il prouve
//
// Les neuf étapes de la Definition of Ready, dans l'ordre, sur la coquille réelle et Rails réel, en
// ne touchant la page QUE par ce qu'une personne voit : les titres (`getByRole('heading')`), les
// libellés des champs (`getByLabel`), le nom des boutons (`getByRole('button')`) et les messages
// annoncés (`getByRole('alert')`, `getByRole('status')`). Aucun identifiant technique, aucun relevé
// JSON : si un bouton perd son nom ou un écran son titre, ce scénario rougit.
//
// Les deux cadres de l'application sont atteints par leur TITRE (« document applicatif », puis
// « application servie par le guest ») : c'est leur nom accessible, lu par `getByTitle` — aucun
// sélecteur CSS (revue de la PR #213, constat 13) —, et ils appartiennent à P1 (#192).
//
// ## Un blocage échoue VITE (revue de la PR #213, constat 14)
//
// Le délai du scénario est de quinze minutes, et non de quarante : un démarrage figé doit rougir tôt
// et laisser ses artefacts — la chronologie et la série du guest, attachées par la fixture — plutôt
// que d'occuper le lot trois quarts d'heure. Sur le chemin, le scénario exige aussi ce que la revue a
// trouvé en défaut : aucune alerte pendant le boot (constat 6), le bouton « Démarrer » fermé pendant
// le geste (8), Entrée qui valide un champ (12), et aucun code en clair laissé dans la page (3).
//
// Sur le chemin, les TROIS échecs les plus probables, chacun à l'endroit où une personne le
// rencontre, et chacun rend la conduite écrite pour elle :
//
//  1. un code MAL RECOPIÉ à l'épreuve de la feuille (étape 3) — la somme de contrôle le voit ;
//  2. une MAUVAISE PHRASE à la réouverture (étape 5) ;
//  3. une archive ALTÉRÉE à la restauration (étape 7).
//
// ## L'usage, et non plus seulement la visite (#239)
//
// La feuille s'éprouve à l'étape 3 en VERROUILLANT puis en rouvrant par son code ; l'étape 5 se rouvre
// par la PHRASE ; après l'étape 6, « Revenir à mon application » la redémarre et la note est relue ;
// après « Parcours terminé », sur l'origine restaurée, on revient à l'application, qui démarre à froid
// et relit la même note. Les durées de ces deux retours sont publiées avec les autres.
//
// ## Ce qu'il ne prouve pas
//
//  - la passkey (aucun authentificateur dans l'exécutant) ;
//  - un autre moteur que Chromium en CI ; Firefox est joué en local, une fois, et son coût publié
//    dans `docs/testing.md` ;
//  - que le texte est COMPRIS : c'est la relecture par une personne non technique
//    (`docs/parcours/relecture-p2.md`), un gate humain.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE, E2E_ORIGIN_COQUILLE_B } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/** La PHRASE du scénario. Publique, sans valeur : elle ouvre un coffre que l'épreuve fabrique. */
const PHRASE = "une phrase de parcours utilisateur assez longue pour la calibration";
const MAUVAISE_PHRASE = "une phrase qui ressemble mais qui n'est pas la bonne du tout";
const LIBELLE = "note écrite pendant le parcours utilisateur";

/** Le délai du SCÉNARIO : un blocage échoue en quinze minutes au plus (constat 14). */
const DELAI_DU_SCENARIO_MS = 900_000;
const BUDGET_DEMARRAGE_MS = 420_000;
const BUDGET_DEVERROUILLAGE_MS = 120_000;
const BUDGET_PREMIERE_PAGE_MS = 120_000;
const BUDGET_PORTABILITE_MS = 180_000;
const BUDGET_ECRAN_MS = 60_000;

/** Un code de récupération tel que la feuille l'affiche : sept groupes de quatre symboles. */
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;

/** Un code en clair, tel que la revue le cherche dans `document.body.innerHTML`. */
const CODE_EN_CLAIR = /[0-9A-Z]{4}(-[0-9A-Z]{4}){6}/;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) return "manifeste de l'image absent : « npm run image:build »";
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) return `artefacts de l'image absents (${absents.join(", ")})`;
  if (!existsSync(CHEMIN_DESCRIPTEUR))
    return "descripteur applicatif absent : « npm run image:manifest »";
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) return `artefacts v86 absents (${manquantsV86.join(", ")})`;
  return null;
}

const raison = raisonDIndisponibilite();

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });
const alerte = (page) => page.getByRole("alert");
const pageServie = (page) =>
  page
    .getByTitle("document applicatif", { exact: true })
    .contentFrame()
    .getByTitle("application servie par le guest", { exact: true })
    .contentFrame();

async function attendreLEcran(page, titre, budget = BUDGET_ECRAN_MS) {
  await expect(ecran(page, titre)).toBeVisible({ timeout: budget });
}

/**
 * VERROUILLE et attend le NOUVEAU document : le verrouillage recharge la coquille, mais l'ancien
 * document voit le coffre verrouillé un instant avant — et y montre déjà l'écran d'après. Attendre un
 * titre ou un champ laissait l'épreuve agir dans un document condamné (#239, Firefox en CI).
 */
async function verrouillerEtRecharger(a) {
  const recharge = a.waitForEvent("load");
  await bouton(a, "Verrouiller mon coffre").click();
  await recharge;
}

async function aucunCodeEnClair(page, moment) {
  const html = await page.evaluate(() => document.body.innerHTML);
  expect(CODE_EN_CLAIR.exec(html)?.[0] ?? null, `aucun code en clair ${moment}`).toBeNull();
}

/**
 * « Démarrer l'application » depuis l'étape 4 ou l'accueil, puis RELIRE la note écrite à l'étape 4 :
 * le démarrage choisit seul entre installation, instantané et boot à froid (#239).
 */
async function relireLaNote(page) {
  await expect(page.getByText(/L'application n'est pas encore démarrée/)).toBeVisible();
  await bouton(page, "Démarrer l'application").click();
  await expect(
    page.getByText("L'application est démarrée : elle s'affiche ci-dessous."),
  ).toBeVisible({ timeout: BUDGET_DEMARRAGE_MS });
  await expect(pageServie(page).getByText(LIBELLE).first()).toBeVisible({
    timeout: BUDGET_PREMIERE_PAGE_MS,
  });
}

async function ouvrirLaCoquille(contexte, origine, erreurs) {
  const page = await contexte.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${origine}/index.html`, { waitUntil: "load" });
  return page;
}

test("une personne suit les neuf étapes, de la création à la révocation, par les libellés visibles", async ({
  context,
  chronologie,
}, testInfo) => {
  exigerLesPrealables(raison, "parcours-utilisateur.spec.mjs");
  test.setTimeout(DELAI_DU_SCENARIO_MS);
  const depart = Date.now();
  const durees = {};
  const erreurs = [];
  const noter = (evenement, detail = {}) => chronologie.etape(evenement, detail);
  const chrono = async (nom, geste) => {
    const debut = Date.now();
    noter(nom);
    await geste();
    durees[nom] = Date.now() - debut;
  };

  const a = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE, erreurs);
  let code = "";
  let version = "";

  // --- 1. Créer ------------------------------------------------------------------------------------
  await chrono("1-creer", async () => {
    await attendreLEcran(a, "Créer votre coffre");
    await expect(a.getByText("Étape 1 sur 9")).toBeVisible();
    await bouton(a, "Commencer").click();
  });

  // --- 2. Choisir comment l'ouvrir -----------------------------------------------------------------
  await chrono("2-choisir", async () => {
    await attendreLEcran(a, "Choisir comment l'ouvrir");
    await expect(a.getByText(/Durée : Après votre clic/)).toBeVisible();
    await a.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await bouton(a, "Créer mon coffre").click();
    await attendreLEcran(a, "Recevoir votre code de récupération", BUDGET_DEVERROUILLAGE_MS);
  });

  // --- 3. Recevoir le code et ÉPROUVER la feuille — avec l'échec « code mal recopié » --------------
  await chrono("3-code", async () => {
    await expect(a.getByText(/QU'UNE SEULE FOIS/)).toBeVisible();
    await bouton(a, "Afficher mon code de récupération").click();
    await attendreLEcran(a, "Recopier votre code de récupération");
    code = ((await a.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
    expect(code).toMatch(FORME_DU_CODE);
    const consigne = await a.getByText(/Numéro de version à noter à côté du code/).textContent();
    version = /: (\d+)\./.exec(consigne ?? "")?.[1] ?? "";
    expect(version).toMatch(/^\d+$/);
    await bouton(a, "J'ai recopié mon code").click();
    await attendreLEcran(a, "Vérifier votre code de récupération");
    await expect(a.getByText(/verrouillez votre coffre/)).toBeVisible();

    // La feuille s'éprouve en S'EN SERVANT : verrouiller recharge la page, et le code part avec elle.
    await verrouillerEtRecharger(a);
    const champ = a.getByLabel("Code de récupération", { exact: true });
    await expect(champ).toBeVisible({ timeout: BUDGET_DEVERROUILLAGE_MS });
    await a.waitForLoadState("load");
    await aucunCodeEnClair(a, "après le verrouillage de l'étape 3");

    // ÉCHEC 1 : un symbole mal recopié. La somme de contrôle le voit, et rien ne part.
    const symboles = code.replaceAll("-", "").split("");
    symboles[5] = symboles[5] === "7" ? "8" : "7";
    await champ.fill(symboles.join(""));
    await expect(a.getByText(/faute de recopie/).first()).toBeVisible();
    await expect(bouton(a, "Ouvrir mon coffre avec le code")).toBeDisabled();
    await expect(ecran(a, "Vérifier votre code de récupération")).toBeVisible();
    noter("echec-code-mal-recopie-conduit");

    // Entrée valide le champ, comme le bouton (constat 12).
    await champ.fill(code);
    await champ.press("Enter");
    await attendreLEcran(a, "Travailler dans l'application", BUDGET_DEVERROUILLAGE_MS);
    await expect(a.getByText(/Votre feuille est juste/)).toBeVisible();
    await aucunCodeEnClair(a, "après l'ouverture par le code");
  });

  // --- 4. Travailler -------------------------------------------------------------------------------
  await chrono("4-travailler", async () => {
    await expect(a.getByText(/Durée : Le premier démarrage installe l'application/)).toBeVisible();
    await expect(alerte(a), "aucune alerte en arrivant à l'étape 4").toBeEmpty();
    await bouton(a, "Démarrer l'application").click();
    await expect(a.getByText(/Démarrage en cours depuis/)).toBeVisible({
      timeout: BUDGET_ECRAN_MS,
    });
    // Pendant le boot : le bouton est fermé (constat 8), et l'écran d'attente seul parle (constat 6).
    await expect(bouton(a, "Démarrer l'application")).toBeDisabled();
    await expect(alerte(a), "aucune alerte pendant le boot").toBeEmpty();
    await expect(
      a.getByText("L'application est démarrée : elle s'affiche ci-dessous."),
    ).toBeVisible({ timeout: BUDGET_DEMARRAGE_MS });
    const servie = pageServie(a);
    await servie
      .getByLabel("Libellé", { exact: true })
      .fill(LIBELLE, { timeout: BUDGET_PREMIERE_PAGE_MS });
    await servie.getByRole("button", { name: "Enregistrer" }).click();
    await expect(servie.getByRole("heading", { name: LIBELLE })).toBeVisible({ timeout: 120_000 });
    await bouton(a, "Continuer : Verrouiller et rouvrir").click();
  });

  // --- 5. Verrouiller et rouvrir — avec l'échec « mauvaise phrase » --------------------------------
  await chrono("5-verrouiller-rouvrir", async () => {
    await attendreLEcran(a, "Verrouiller votre coffre");
    await verrouillerEtRecharger(a);
    await attendreLEcran(a, "Rouvrir votre coffre", BUDGET_DEVERROUILLAGE_MS);

    // ÉCHEC 2 : une mauvaise phrase. Le coffre reste fermé, et la conduite le dit.
    await a.getByLabel("Votre phrase", { exact: true }).fill(MAUVAISE_PHRASE);
    await bouton(a, "Ouvrir mon coffre").click();
    await expect(alerte(a)).toContainText("n'ouvre pas ce coffre", {
      timeout: BUDGET_DEVERROUILLAGE_MS,
    });
    await expect(ecran(a, "Rouvrir votre coffre")).toBeVisible();
    noter("echec-mauvaise-phrase-conduit");

    // La bonne phrase rouvre : la feuille éprouvée à l'étape 3 ne se redemande pas (#239).
    await a.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await bouton(a, "Ouvrir mon coffre").click();
    await attendreLEcran(a, "Sauvegarder votre coffre", BUDGET_DEVERROUILLAGE_MS);
  });

  // --- 6. Sauvegarder ------------------------------------------------------------------------------
  const archive = testInfo.outputPath("coffre-parcours.rbvault");
  await chrono("6-sauvegarder", async () => {
    const telechargement = a.waitForEvent("download", { timeout: BUDGET_PORTABILITE_MS });
    await bouton(a, "Sauvegarder mon coffre").click();
    await (await telechargement).saveAs(archive);
    await expect(a.getByText(/^Sauvegarde prête\./)).toBeVisible({
      timeout: BUDGET_PORTABILITE_MS,
    });
    await bouton(a, "Continuer : Restaurer sur un autre appareil").click();
    await attendreLEcran(a, "Restaurer sur un autre appareil");
  });

  // --- Après l'étape 6 : revenir à l'application, qui redémarre et relit la note (#239) ------------
  await chrono("6-retour-application", async () => {
    await bouton(a, "Revenir à mon application").click();
    await attendreLEcran(a, "Travailler dans l'application");
    await relireLaNote(a);
    await bouton(a, "Continuer : Restaurer sur un autre appareil").click();
    await attendreLEcran(a, "Restaurer sur un autre appareil");
  });

  // --- Sur A : les étapes 8 et 9, et la sortie SANS révoquer (décision du 19/09/2026) -------------
  await chrono("8-9-sans-revoquer", async () => {
    await bouton(a, "Continuer : Récupérer votre coffre avec le code").click();
    await attendreLEcran(a, "Récupérer votre coffre avec le code");
    await verrouillerEtRecharger(a);
    await a.getByLabel("Code de récupération", { exact: true }).fill(code);
    await bouton(a, "Ouvrir mon coffre avec le code").click();
    await attendreLEcran(a, "Révoquer en urgence", BUDGET_DEVERROUILLAGE_MS);
    await expect(a.getByText(/votre phrase et votre passkey ne fonctionneront plus/)).toBeVisible();
    await bouton(a, "Terminer sans révoquer").click();
    await attendreLEcran(a, "Parcours terminé");
    await expect(a.getByText(/ouvrent toujours/)).toBeVisible();
    // La phrase ouvre TOUJOURS : la visite n'a rien détruit.
    await bouton(a, "Revenir à mon application").click();
    await attendreLEcran(a, "Votre application");
    await verrouillerEtRecharger(a);
    await attendreLEcran(a, "Rouvrir votre coffre", BUDGET_DEVERROUILLAGE_MS);
    await a.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
    await bouton(a, "Ouvrir mon coffre").click();
    await attendreLEcran(a, "Votre application", BUDGET_DEVERROUILLAGE_MS);
  });
  await a.close();

  // --- 7. Restaurer ailleurs — avec l'échec « archive altérée » ------------------------------------
  const b = await ouvrirLaCoquille(context, E2E_ORIGIN_COQUILLE_B, erreurs);
  await chrono("7-restaurer", async () => {
    await attendreLEcran(b, "Créer votre coffre");
    await bouton(b, "J'ai déjà une sauvegarde").click();
    await attendreLEcran(b, "Restaurer une sauvegarde");

    // ÉCHEC 3 : un octet du contenu retourné. Rien n'est écrit, et la conduite le dit.
    const octets = readFileSync(archive);
    const alteree = Buffer.from(octets);
    alteree[12 + octets.readUInt32BE(8) + 700] ^= 0x01;
    const cheminAltere = testInfo.outputPath("coffre-parcours-altere.rbvault");
    writeFileSync(cheminAltere, alteree);
    await b.getByLabel("Fichier de sauvegarde", { exact: true }).setInputFiles(cheminAltere);
    await bouton(b, "Restaurer ma sauvegarde sur cet appareil").click();
    await expect(alerte(b)).toContainText("abîmée ou modifiée", { timeout: BUDGET_PORTABILITE_MS });
    await expect(ecran(b, "Restaurer une sauvegarde")).toBeVisible();
    noter("echec-archive-alteree-conduit");

    await b.getByLabel("Fichier de sauvegarde", { exact: true }).setInputFiles(archive);
    await bouton(b, "Restaurer ma sauvegarde sur cet appareil").click();
    await attendreLEcran(b, "Récupérer votre coffre avec le code", BUDGET_PORTABILITE_MS);
  });

  // --- 8. Récupérer par le code --------------------------------------------------------------------
  await chrono("8-recuperer", async () => {
    await b
      .getByLabel("Numéro de version noté sur votre feuille (facultatif)", { exact: true })
      .fill(version);
    await b
      .getByLabel("Code de récupération", { exact: true })
      .fill(code.toLowerCase().replaceAll("-", " "));
    await bouton(b, "Ouvrir mon coffre avec le code").click();
    await attendreLEcran(b, "Révoquer en urgence", BUDGET_DEVERROUILLAGE_MS);
    await aucunCodeEnClair(b, "après l'ouverture par le code");
  });

  // --- 9. Révoquer en urgence ----------------------------------------------------------------------
  await chrono("9-revoquer", async () => {
    await expect(b.getByText(/sauvegardes déjà faites restent ouvrables/)).toBeVisible();
    await bouton(b, "Révoquer tous les autres moyens d'ouvrir ce coffre").click();
    await attendreLEcran(b, "Parcours terminé", BUDGET_DEVERROUILLAGE_MS);
    // Le coffre restauré ne s'ouvre que par le code qui vient de servir : il n'y a rien d'autre à
    // retirer, et la page ne fait pas noter un numéro pour rien (revue #213, constat 15).
    await expect(
      b.getByText(
        "Aucun autre moyen n'ouvrait ce coffre : rien n'a été retiré, et votre feuille reste juste.",
      ),
    ).toBeVisible();
  });

  // --- Après « Parcours terminé » : l'application, sur l'origine RESTAURÉE, à froid (#239) ----------
  await chrono("9-retour-application", async () => {
    await bouton(b, "Revenir à mon application").click();
    await attendreLEcran(b, "Votre application");
    await expect(b.getByText(/La visite est finie/)).toBeVisible();
    await expect(bouton(b, "Verrouiller mon coffre")).toBeVisible();
    await expect(bouton(b, "Sauvegarder mon coffre")).toBeVisible();
    await relireLaNote(b);
  });

  // « Où suis-je ? » résume les neuf étapes.
  await b.getByText("Où suis-je ?").click();
  await expect(b.getByRole("listitem")).toHaveCount(9);
  expect(erreurs, "aucune erreur de page").toEqual([]);

  const totalMs = Date.now() - depart;
  const rapport = { mesureLe: new Date().toISOString(), durees, totalMs };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "parcours-utilisateur.json"),
    `${JSON.stringify(rapport, null, 2)}\n`,
  );
  await testInfo.attach("parcours-utilisateur.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });
});
