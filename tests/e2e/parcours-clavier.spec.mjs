import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE, E2E_ORIGIN_COQUILLE_B } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const phrase = "une phrase publique pour le parcours entier au clavier 194";
const titre = (page, nom) => page.getByRole("heading", { level: 2, name: nom, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });
const attendre = async (page, nom) => expect(titre(page, nom)).toBeVisible({ timeout: 120_000 });

// Tab traverse les vrais documents imbriqués ; aucun focus forcé ni clic de pointeur.
async function tabuler(page, cible) {
  for (let i = 0; i < 80; i += 1) {
    if (await cible.evaluate((node) => node === node.ownerDocument.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Cible inaccessible au clavier : ${await cible.textContent()}`);
}
async function activer(page, cible) {
  await expect(cible).toBeEnabled({ timeout: 120_000 });
  await tabuler(page, cible);
  await page.keyboard.press("Enter");
}
async function saisir(page, cible, valeur) {
  await tabuler(page, cible);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(valeur);
}
function prealableAbsent() {
  const chemin = resolve("tools/build-reference-image/manifest.json");
  if (!existsSync(chemin)) return "manifeste de l'image absent";
  const manifeste = JSON.parse(readFileSync(chemin, "utf8"));
  const absents = manifeste.artifacts.filter(
    (a) => !existsSync(resolve("artifacts/reference-image", a.name)),
  );
  if (absents.length) return `image absente : ${absents.map((a) => a.name).join(", ")}`;
  if (!existsSync("artifacts/application.json")) return "descripteur applicatif absent";
  const v86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  return v86.length ? `runtime absent : ${v86.join(", ")}` : null;
}

test("les neuf étapes sont traversées au clavier, y compris Rails et les refus", async ({
  context,
  chronologie,
}, testInfo) => {
  exigerLesPrealables(prealableAbsent(), "parcours-clavier.spec.mjs");
  test.setTimeout(900_000);
  const a = await context.newPage();
  await a.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await a.goto(`${E2E_ORIGIN_COQUILLE}/index.html`);
  await attendre(a, "Créer votre coffre");
  chronologie.etape("1-creation-clavier");
  await activer(a, bouton(a, "Commencer"));
  await attendre(a, "Choisir comment l'ouvrir");
  chronologie.etape("2-phrase-clavier");
  await saisir(a, a.getByLabel("Votre phrase", { exact: true }), phrase);
  await activer(a, bouton(a, "Créer mon coffre"));
  await attendre(a, "Recevoir votre code de récupération");
  chronologie.etape("3-feuille-clavier");
  await activer(a, bouton(a, "Afficher mon code de récupération"));
  await attendre(a, "Recopier votre code de récupération");
  const code = (await a.getByText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/).textContent()).trim();
  const consigne = await a.getByText(/Numéro de version à noter à côté du code/).textContent();
  const version = /: (\d+)\./.exec(consigne)[1];
  await activer(a, bouton(a, "J'ai recopié mon code"));
  await attendre(a, "Confirmer votre code de récupération");
  const confirmation = a.getByLabel("Code recopié depuis votre feuille", { exact: true });
  await saisir(a, confirmation, "0000-0000-0000-0000-0000-0000-0000");
  await activer(a, bouton(a, "Confirmer mon code"));
  await expect(a.getByRole("alert")).not.toBeEmpty();
  await saisir(a, confirmation, code);
  await a.keyboard.press("Enter");
  await attendre(a, "Travailler dans l'application");
  chronologie.etape("4-boot-clavier");
  await activer(a, bouton(a, "Démarrer l'application"));
  await expect(
    a.getByText("L'application est démarrée : elle s'affiche ci-dessous.", { exact: true }),
  ).toBeVisible({ timeout: 600_000 });
  const rails = a
    .getByTitle("document applicatif", { exact: true })
    .contentFrame()
    .getByTitle("application servie par le guest", { exact: true })
    .contentFrame();
  const libelle = rails.getByLabel("Libellé", { exact: true });
  await expect(libelle).toBeVisible({ timeout: 180_000 });
  await expect(bouton(a, "Démarrer l'application")).toBeHidden();
  await expect(titre(a, "Travailler dans l'application")).toBeFocused();
  const aide = a.locator("#parcours-aide");
  await expect(aide).not.toHaveAttribute("open", "");
  const positionCadre = await a.locator("#cadre-applicatif").boundingBox();
  expect(positionCadre.y, "l'application est visible près du haut de la page").toBeLessThan(380);
  await activer(a, a.getByText("Aide pour cette étape", { exact: true }));
  await expect(a.locator("#parcours-attente-annoncee")).toBeVisible();
  await activer(a, a.getByText("Aide pour cette étape", { exact: true }));
  // La même session Rails reste ouverte après les deux bascules de l'aide.
  await expect(libelle).toBeVisible();
  await saisir(a, libelle, "Une note écrite au clavier");
  await activer(a, rails.getByRole("button", { name: "Enregistrer", exact: true }));
  await expect(
    rails.getByRole("heading", { name: "Une note écrite au clavier", exact: true }),
  ).toBeVisible({ timeout: 120_000 });
  await activer(a, bouton(a, "Continuer : Verrouiller et rouvrir"));
  await attendre(a, "Verrouiller votre coffre");
  chronologie.etape("5-verrouillage-clavier");
  await activer(a, bouton(a, "Verrouiller mon coffre"));
  await attendre(a, "Rouvrir votre coffre");
  const secret = a.getByLabel("Votre phrase", { exact: true });
  await saisir(a, secret, "cette phrase publique ne correspond pas au coffre");
  await activer(a, bouton(a, "Ouvrir mon coffre"));
  await expect(a.getByRole("alert")).toContainText("n'ouvre pas ce coffre", { timeout: 120_000 });
  await saisir(a, secret, phrase);
  await activer(a, bouton(a, "Ouvrir mon coffre"));
  await attendre(a, "Sauvegarder votre coffre");
  chronologie.etape("6-sauvegarde-clavier");
  const fichier = testInfo.outputPath("coffre-clavier.rbvault");
  const telechargement = a.waitForEvent("download", { timeout: 180_000 });
  await activer(a, bouton(a, "Sauvegarder mon coffre"));
  await (await telechargement).saveAs(fichier);
  await expect(a.getByText(/^Sauvegarde prête\./)).toBeVisible({ timeout: 180_000 });
  await activer(a, bouton(a, "Continuer : Restaurer sur un autre appareil"));
  await a.close();
  const b = await context.newPage();
  await b.goto(`${E2E_ORIGIN_COQUILLE_B}/index.html`);
  await attendre(b, "Créer votre coffre");
  chronologie.etape("7-restauration-clavier");
  await activer(b, bouton(b, "J'ai déjà une sauvegarde"));
  await attendre(b, "Restaurer une sauvegarde");
  const entree = b.getByLabel("Fichier de sauvegarde", { exact: true });
  await tabuler(b, entree);
  // Le fichier est remis par Playwright au contrôle natif ; le dialogue du système n'est pas pilotable en CI.
  await entree.setInputFiles(fichier);
  await activer(b, bouton(b, "Restaurer ma sauvegarde sur cet appareil"));
  await attendre(b, "Récupérer votre coffre avec le code");
  chronologie.etape("8-recuperation-clavier");
  await saisir(
    b,
    b.getByLabel("Numéro de version noté sur votre feuille (facultatif)", { exact: true }),
    version,
  );
  await saisir(b, b.getByLabel("Code de récupération", { exact: true }), code);
  await activer(b, bouton(b, "Ouvrir mon coffre avec le code"));
  await attendre(b, "Révoquer en urgence");
  chronologie.etape("9-revocation-clavier");
  await activer(b, bouton(b, "Révoquer tous les autres moyens d'ouvrir ce coffre"));
  await attendre(b, "Parcours terminé");
  await activer(b, b.getByText("Où suis-je ?", { exact: true }));
  await expect(b.getByRole("listitem")).toHaveCount(9);
});
