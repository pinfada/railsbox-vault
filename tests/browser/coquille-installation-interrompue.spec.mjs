// UN PREMIER DÉMARRAGE INTERROMPU (#250), et un refus à l'étape 4 (#252), dans la page du PARCOURS.
//
// Reproduction de la recette QA de la PR #249 (défaut 11) : la GRAINE refusée par l'origine (403).
// Avant #250, la page disait « Aucune application n'est livrée avec ce coffre à cette adresse » — faux,
// l'origine en sert une — et le détail publiait `cycle:sans-application`. La signature de l'ADR 0037,
// elle, TENAIT : c'est la mesure de cette suite (403, gzip, 64 Mio, puis verrouillage et réouverture).
//
// Aucune machine virtuelle ne démarre ici : les artefacts du boot (noyau, initrd…) ne sont pas servis,
// et c'est exactement le second cas de #250 — un premier boot dont un morceau manque, sur un volume
// installé et jamais démarré. Le boot complet après une reprise est l'affaire de
// `tests/e2e/reprise-installation.spec.mjs` (#197), sous `reprise.yml`.

import { createHash } from "node:crypto";

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { IDENTIFIANT_DU_COFFRE } from "../../src/coquille/identites-du-coffre.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";

const DELAI = 90_000;
const PHRASE = "marqueur-de-phrase-du-parcours-250-une-phrase-assez-longue";
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const INSTALLATION_INACHEVEE = "L'installation de votre application n'a pas pu se terminer.";
const AUCUNE_APPLICATION = "Aucune application n'est livrée";

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });
const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

/** Un descripteur valide, dont la graine pèse `octets`, éventuellement servie en gzip. */
function descripteurDEpreuve(octets, { gzip = false } = {}) {
  return {
    descripteurVersion: 2,
    application: { id: "installation-interrompue", version: "1.0.0", schema: "20260101000002" },
    runtime: { version: "0.1.0" },
    rootfs: { nom: "r.ext4", octets: 4096, sha256: "a".repeat(64) },
    paquet: { nom: "p.ext4", octets: 4096, sha256: "b".repeat(64) },
    graine: {
      nom: "graine-interrompue.ext4",
      octets,
      sha256: createHash("sha256").update(Buffer.alloc(octets, 0x42)).digest("hex"),
      disqueOctets: octets,
      ...(gzip ? { compression: "gzip", transfertOctets: 1000 } : {}),
    },
    boot: {
      cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
      memoireOctets: 33554432,
      kernel: "k",
      initrd: "i",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    prefixeDesArtefacts: "/artifacts/installation-interrompue/",
  };
}

async function servirLeDescripteur(page, descripteur) {
  await page.context().route("**/artifacts/application.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(descripteur),
    }),
  );
}

/** La graine : REFUSÉE (403) tant que `etat.refusee`, servie ENTIÈRE ensuite. */
async function servirLaGraine(page, descripteur, etat) {
  await page
    .context()
    .route(`**${descripteur.prefixeDesArtefacts}${descripteur.graine.nom}`, (route) =>
      etat.refusee
        ? route.fulfill({ status: 403, body: "interdit" })
        : route.fulfill({
            status: 200,
            contentType: "application/octet-stream",
            body: Buffer.alloc(descripteur.graine.octets, 0x42),
          }),
    );
}

/** Crée le coffre par la phrase, éprouve la feuille par son code : mène à l'étape 4. */
async function jusquALEtape4(page) {
  await expect(ecran(page, "Créer votre coffre")).toBeVisible({ timeout: DELAI });
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: DELAI });
  const code = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
  await bouton(page, "J'ai recopié mon code").click();
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  await page.getByLabel("Code de récupération", { exact: true }).fill(code, { timeout: DELAI });
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
}

async function ouvrirLeParcours(page) {
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
}

/**
 * Ce qu'une personne peut faire sous un refus à l'étape 4 : mettre son coffre à l'abri. Sans données
 * d'application (installation inachevée), la sauvegarde n'a rien à emporter : elle n'est pas offerte.
 */
async function gestesDAbriVisibles(page, { sauvegarde = true } = {}) {
  await expect(bouton(page, "Verrouiller mon coffre")).toBeVisible();
  const attendu = expect(bouton(page, "Sauvegarder mon coffre"));
  await (sauvegarde ? attendu.toBeVisible() : attendu.toBeHidden());
}

test("#250 : la graine refusée, puis reprise — la page dit l'installation inachevée, jamais « aucune application »", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "requête HTTP et OPFS réels : un moteur suffit");
  test.setTimeout(240_000);
  const descripteur = descripteurDEpreuve(8 * 4096);
  const graine = { refusee: true };
  await servirLeDescripteur(page, descripteur);
  await servirLaGraine(page, descripteur, graine);
  await ouvrirLeParcours(page);
  await jusquALEtape4(page);

  // PREMIER démarrage : la graine est refusée. Reconnu TOUT DE SUITE, sans second clic.
  await bouton(page, "Démarrer l'application").click();
  const alerte = page.locator("#parcours-refus");
  await expect(alerte).toContainText(INSTALLATION_INACHEVEE, { timeout: DELAI });
  await expect(alerte).toContainText("Rien n'est perdu");
  await expect(alerte).not.toContainText(AUCUNE_APPLICATION);
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${C.volumeApplicatifSansManifeste}`,
  );
  expect((await releve(page)).application.installationInterrompue).toBe(true);
  await expect(bouton(page, "Reprendre l'installation")).toBeVisible();
  // Un seul geste pour terminer : « Démarrer » n'est plus offert, et aucun texte ne le nomme.
  await expect(bouton(page, "Démarrer l'application")).toBeHidden();
  await expect(page.locator("#cycle-description")).toContainText("Reprendre l'installation");
  await expect(page.locator("#parcours-attendu")).toContainText("Reprendre l'installation");
  // Aucune donnée d'application : rien à sauvegarder, donc aucun bouton pour échouer (#252).
  await gestesDAbriVisibles(page, { sauvegarde: false });
  await expect(page.locator("#parcours-refus")).not.toContainText("sauvegarder");

  // La REPRISE, l'origine refusant TOUJOURS : redit, bouton compris.
  await bouton(page, "Reprendre l'installation").click();
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:reprise-refusee:${C.volumeApplicatifSansManifeste}`,
    { timeout: DELAI },
  );
  await expect(alerte).toContainText(INSTALLATION_INACHEVEE);
  await expect(alerte).toContainText("cette adresse ne sert pas correctement l'application");
  await expect(bouton(page, "Reprendre l'installation")).toBeVisible();

  // La REPRISE, l'origine servant enfin la graine : installée. Le boot, lui, ne trouve pas son noyau
  // (non servi ici) — un morceau du premier boot qui manque, sur un volume jamais démarré : c'est
  // encore une installation inachevée, et « Reprendre » redémarre sans rien retirer.
  graine.refusee = false;
  await bouton(page, "Reprendre l'installation").click();
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${C.installationInachevee}`,
    { timeout: DELAI },
  );
  expect((await releve(page)).application.installee).toBe(true);
  await expect(alerte).toContainText(INSTALLATION_INACHEVEE);
  await expect(bouton(page, "Reprendre l'installation")).toBeVisible();
  await gestesDAbriVisibles(page, { sauvegarde: false });
  await bouton(page, "Reprendre l'installation").click();
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${C.installationInachevee}`,
    { timeout: DELAI },
  );
  // TÉMOIN : la reprise d'un volume INSTALLÉ n'a rien retiré — le manifeste est toujours là.
  const manifestePresent = await page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes");
    const fichier = await (await dossier.getFileHandle("application.manifest")).getFile();
    return fichier.size > 0;
  });
  expect(manifestePresent).toBe(true);
});

test("#250 : la signature TIENT avec une graine gzip de 64 Mio refusée, et après verrouillage", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "requête HTTP et OPFS réels : un moteur suffit");
  test.setTimeout(240_000);
  const descripteur = descripteurDEpreuve(64 * 1024 * 1024, { gzip: true });
  await servirLeDescripteur(page, descripteur);
  await servirLaGraine(page, descripteur, { refusee: true });
  await page.goto(`${SHELL_ORIGIN}/index.html?vue=complete`, { waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  const ouvrir = async () => {
    await page.fill("#saisie-phrase", PHRASE);
    await page.click("#ouvrir-par-phrase");
    await expect
      .poll(async () => (await releve(page)).etat, { timeout: DELAI })
      .toBe(ETATS_DU_VOLUME.ouvert);
  };
  const demarrer = async () => {
    await page.click("#demarrer-application");
    await expect(page.locator("#cycle-etat")).toHaveText(
      `cycle:demarrage-refuse:${C.volumeApplicatifSansManifeste}`,
      { timeout: DELAI },
    );
    return (await releve(page)).application.installationInterrompue;
  };
  await ouvrir();
  expect(await demarrer()).toBe(true);
  const recharge = page.waitForEvent("load");
  await page.click("#verrouiller-le-coffre");
  await recharge;
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  await ouvrir();
  expect(await demarrer()).toBe(true);
  await expect(page.locator("#reprendre-l-installation")).toBeVisible();
});

/** Le manifeste d'une AUTRE application, que le coffre aurait porté : refus de déphasage. */
function manifesteDUneAutreApplication() {
  return new TextDecoder().decode(
    serializeManifest(
      createManifest({
        runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
        app: { id: "une-autre-application", version: "1.0.0", schema: "20260101000002" },
        volumeSize: SECTOR_SIZE * 16,
        volume: { id: IDENTIFIANT_DU_COFFRE, algorithm: "aes-256-gcm" },
      }),
    ),
  );
}

test("#252 : un refus pendant la visite, à l'étape 4, OFFRE « Sauvegarder » et « Verrouiller » qu'il nomme", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "OPFS réel : un moteur suffit");
  test.setTimeout(240_000);
  await servirLeDescripteur(page, descripteurDEpreuve(8 * 4096));
  await ouvrirLeParcours(page);
  await expect(ecran(page, "Créer votre coffre")).toBeVisible({ timeout: DELAI });
  // Le coffre portera les données d'une AUTRE application : le refus tient dès l'ouverture.
  await page.evaluate(async (texte) => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes", { create: true });
    const fichier = await dossier.getFileHandle("application.manifest", { create: true });
    const flux = await fichier.createWritable();
    await flux.write(texte);
    await flux.close();
  }, manifesteDUneAutreApplication());
  await jusquALEtape4(page);

  await expect(page.locator("#parcours-attendu")).toContainText(
    "vous pouvez le sauvegarder ou le verrouiller",
    { timeout: DELAI },
  );
  await expect(bouton(page, "Démarrer l'application")).toBeHidden();
  await gestesDAbriVisibles(page);
  // Le geste est RÉEL : « Verrouiller mon coffre » verrouille, d'ici même. (La sauvegarde, elle, est
  // jouée par l'épreuve de #250 sur un coffre réel : le manifeste posé ici n'a pas de volume.)
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  await expect(ecran(page, "Rouvrir votre coffre")).toBeVisible({ timeout: DELAI });
});

// --- #255 : un artefact refusé sur un coffre qui a SERVI -------------------------------------------
//
// Le contrôle QA du 20/09/2026 l'a lu en 1,0 s, rootfs en 403, sur un coffre ayant porté une note et
// une pièce jointe : « L'opération n'a pas abouti, sans cause identifiée. Rechargez la page puis
// réessayez. » — le fourre-tout que #240 et #244 ont banni ailleurs, et un conseil faux tant que
// l'origine est en défaut. La garde avait raison de ne proposer aucune reprise ; c'étaient les mots
// qui manquaient.
//
// Ce qu'une VM ferait ici, personne ne peut l'obtenir sans elle : « ce volume a déjà démarré » se lit
// dans son journal de génération, que seul un boot avance. La décision, elle, est mesurée SANS VM par
// `tests/unit/coquille-installation-interrompue.test.mjs` (chaque artefact × refusé / coupé / empreinte
// fausse). Ce qui se mesure ICI est ce qu'une personne LIT et ce qu'elle peut CLIQUER quand la réponse
// est publiée — la réponse est donc posée comme le Worker la poserait, exactement comme
// `tests/browser/coquille-premier-clic.spec.mjs` pose l'application affichée.
test("#255 : un artefact refusé sur un coffre qui a servi nomme l'adresse, et n'offre JAMAIS de reprendre", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "OPFS réel : un moteur suffit");
  test.setTimeout(240_000);
  await servirLeDescripteur(page, descripteurDEpreuve(8 * 4096));
  await ouvrirLeParcours(page);
  await jusquALEtape4(page);

  await page.evaluate((code) => {
    const noeud = document.getElementById("coquille-rapport");
    const rapport = JSON.parse(noeud.textContent);
    rapport.application = {
      demarree: false,
      code,
      motif:
        "Un artefact du démarrage n'a pas pu être acquis : Artefact rootfs indisponible (403).",
      installationInterrompue: false,
    };
    noeud.textContent = JSON.stringify(rapport);
    document.getElementById("cycle-etat").textContent = `cycle:demarrage-refuse:${code}`;
  }, C.artefactDuDemarrageRefuse);

  const alerte = page.locator("#parcours-refus");
  await expect(alerte).toContainText("Cette adresse n'a pas pu fournir l'application", {
    timeout: DELAI,
  });
  await expect(alerte).toContainText("Vos données sont intactes dans votre coffre");
  await expect(alerte).toContainText("rien n'a été démarré ni modifié");
  // Plus jamais le fourre-tout, ni le conseil faux qui l'accompagnait.
  await expect(alerte).not.toContainText("sans cause identifiée");
  await expect(alerte).not.toContainText("Rechargez la page");
  await expect(alerte).not.toContainText(AUCUNE_APPLICATION);
  await expect(alerte).not.toContainText(INSTALLATION_INACHEVEE);
  // La GARDE : une reprise écraserait ce que le guest a écrit. Elle n'est pas offerte.
  await expect(bouton(page, "Reprendre l'installation")).toBeHidden();
  // Les données sont là, et la sauvegarde se fait sans démarrer : les deux gestes d'abri sont offerts.
  await gestesDAbriVisibles(page, { sauvegarde: true });
});
