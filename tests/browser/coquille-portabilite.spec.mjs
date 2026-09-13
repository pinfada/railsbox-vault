// SAUVEGARDER, RESTAURER, RÉVOQUER depuis la coquille RÉELLE (#207, ADR 0039).
//
// Ce que cette suite mesure, dans un vrai navigateur et sous la CSP servie : le `File` de l'archive
// franchit le canal privilégié et devient un TÉLÉCHARGEMENT ; il se restaure sur une AUTRE origine
// (`127.0.0.1` → `localhost`, deux OPFS distincts) et le coffre s'y ouvre par le CODE ; une archive
// altérée et une archive tronquée sont refusées sous leur code ; après une révocation d'urgence, la
// phrase n'ouvre plus et le code ouvre ; un coffre créé par la coquille d'AVANT est refusé dès
// l'inventaire.
//
// **Aucune machine virtuelle.** Le disque applicatif est un petit disque servi par une route : la
// coquille l'INSTALLE — volume, datation, manifeste — puis le boot échoue faute de noyau, ce qui
// laisse exactement un coffre avec une application installée. Que Rails RELISE une mutation après
// restauration est prouvé par `tests/e2e/portabilite-coquille.spec.mjs`, sur l'image de référence.
//
// **WebKit** n'offre pas l'OPFS synchrone dans un Worker : la coquille y publie `indisponible`, et le
// geste qui touche un volume rend son refus typé. La limite est EXIGÉE, pas sautée.

import { readFile, writeFile } from "node:fs/promises";

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { SHELL_ORIGIN, SHELL_PORT } from "../../src/spike/origin-topology.mjs";
import { ARCHIVE_ERROR_CODES } from "../../src/vm/archive-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

/** L'AUTRE origine de confiance : le même serveur, un autre nom, donc un autre OPFS. */
const AUTRE_ORIGINE = `http://localhost:${SHELL_PORT}`;
const PHRASE = "une phrase de portabilité assez longue pour la calibration";
const DELAI = 120_000;
const OCTETS_DU_DISQUE = 16 * 512;

const DESCRIPTEUR = {
  descripteurVersion: 1,
  application: { id: "portabilite-test", version: "1.0.0" },
  runtime: { version: "0.1.0" },
  disque: { nom: "disque-de-portabilite.ext2", octets: OCTETS_DU_DISQUE },
  boot: {
    cmdline: "root=/dev/sda rw",
    memoireOctets: 33554432,
    kernel: "k",
    initrd: "i",
    rootfs: "r",
    bios: "seabios.bin",
    vgaBios: "vgabios.bin",
  },
  prefixeDesArtefacts: "/artifacts/portabilite-test/",
};

/** Sert le descripteur et le disque, sur toutes les origines du contexte. */
async function servirLApplication(contexte) {
  await contexte.route("**/artifacts/application.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DESCRIPTEUR),
    }),
  );
  await contexte.route(`**${DESCRIPTEUR.prefixeDesArtefacts}${DESCRIPTEUR.disque.nom}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.alloc(OCTETS_DU_DISQUE, 0x42),
    }),
  );
}

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

async function ouvrirLaCoquille(page, origine = SHELL_ORIGIN) {
  await page.goto(new URL("/index.html", origine).toString(), { waitUntil: "commit" });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", /prete|sans-cadre/, {
    timeout: DELAI,
  });
}

/** WebKit : l'état DIT l'absence, et le geste de sauvegarde rend son refus typé. */
async function exigerLaLimiteDuMoteur(page) {
  if ((await releve(page)).etat !== ETATS_DU_VOLUME.indisponible) return false;
  await page.click("#sauvegarder-le-coffre");
  await expect(page.locator("#portabilite-refus")).toContainText(STORAGE_ERROR_CODES.unsupported, {
    timeout: DELAI,
  });
  return true;
}

async function attendreLEtat(page, etat) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe(etat);
}

async function ouvrirParLaPhrase(page, phrase = PHRASE) {
  await page.fill("#saisie-phrase", phrase);
  await page.click("#ouvrir-par-phrase");
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
}

/** INSTALLE l'application : le versement aboutit, le boot échoue faute de noyau. */
async function installerLApplication(page) {
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).not.toHaveText(/au-repos|demarrage-en-cours/, {
    timeout: DELAI,
  });
}

/** SAUVEGARDE, et rend le chemin du fichier téléchargé avec ce que le relevé en dit. */
async function sauvegarder(page) {
  const telechargement = page.waitForEvent("download", { timeout: DELAI });
  await page.click("#sauvegarder-le-coffre");
  const fichier = await telechargement;
  await expect(page.locator("#portabilite-etat")).toContainText("portabilite:sauvegarde-prete", {
    timeout: DELAI,
  });
  return { chemin: await fichier.path(), rapport: (await releve(page)).portabilite.sauvegarde };
}

/** Un coffre ouvert par la phrase, avec sa feuille, son application installée, et sa sauvegarde. */
async function coffreSauvegarde(page) {
  await ouvrirParLaPhrase(page);
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
  const feuille = await creerLaFeuille(page);
  await installerLApplication(page);
  return { feuille, ...(await sauvegarder(page)) };
}

async function restaurer(page, fichier) {
  await page.setInputFiles("#archive-a-restaurer", fichier);
  await page.click("#restaurer-le-coffre");
  await expect(page.locator("#portabilite-etat")).not.toHaveText(/restauration-en-cours|au-repos/, {
    timeout: DELAI,
  });
}

test.beforeEach(async ({ context }) => {
  await servirLApplication(context);
});

test("SAUVEGARDER puis RESTAURER sur une AUTRE origine, et ouvrir par le CODE", async ({
  context,
  page,
}, info) => {
  test.setTimeout(300_000);
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const { feuille, chemin, rapport } = await coffreSauvegarde(page);
  expect(rapport.recuperationEmportee).toBe(true);
  expect(rapport.coherence.kind).toBe("handle-exclusif");
  expect((await readFile(chemin)).byteLength).toBe(rapport.taille);

  const ailleurs = await context.newPage();
  await ouvrirLaCoquille(ailleurs, AUTRE_ORIGINE);
  expect((await releve(ailleurs)).etat).toBe(ETATS_DU_VOLUME.verrouille);
  await restaurer(ailleurs, chemin);
  await expect(ailleurs.locator("#portabilite-etat")).toContainText("portabilite:restauree");
  const restauration = (await releve(ailleurs)).portabilite.restauration;
  await info.attach(`portabilite-${info.project.name}.json`, {
    body: JSON.stringify({ sauvegarde: rapport, restauration }, null, 2),
    contentType: "application/json",
  });
  expect(restauration.empreinte).toBe(rapport.empreinte);
  expect(restauration.empreinteRelue).toBe(rapport.empreinte);
  expect(restauration.reparee).toBe(false);
  expect(restauration.volumeCoquille).toBe("a-naitre");

  // L'inventaire a été redemandé : le coffre restauré s'ouvre par le code, et par rien d'autre.
  await expect(ailleurs.locator("#deverrouillage-moyens")).toContainText("code de récupération");
  await ouvrirParLeCode(ailleurs, feuille);
  await attendreLEtat(ailleurs, ETATS_DU_VOLUME.ouvert);

  // Et on ne restaure jamais par-dessus : la même archive, sur ce coffre maintenant présent.
  await restaurer(ailleurs, chemin);
  await expect(ailleurs.locator("#portabilite-refus")).toContainText(
    CODES_REFUS_COQUILLE.emplacementOccupe,
  );
});

test("une archive ALTÉRÉE et une archive TRONQUÉE sont refusées, chacune sous son code", async ({
  context,
  page,
}, info) => {
  test.setTimeout(300_000);
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  const { chemin } = await coffreSauvegarde(page);
  const octets = await readFile(chemin);
  const debutDuContenu = 12 + octets.readUInt32BE(8);
  const alteree = Buffer.from(octets);
  alteree[debutDuContenu + 700] ^= 0x01;
  const tronquee = octets.subarray(0, octets.byteLength - 512);

  for (const [nom, contenu, code] of [
    ["alteree", alteree, ARCHIVE_ERROR_CODES.digestMismatch],
    ["tronquee", tronquee, ARCHIVE_ERROR_CODES.truncated],
  ]) {
    const fichier = info.outputPath(`${nom}.rbvault`);
    await writeFile(fichier, contenu);
    const ailleurs = await context.newPage();
    await ouvrirLaCoquille(ailleurs, AUTRE_ORIGINE);
    await restaurer(ailleurs, fichier);
    await expect(ailleurs.locator("#portabilite-refus"), nom).toContainText(code);
    // Rien n'est né : l'inventaire dit toujours qu'aucun coffre n'existe ici.
    await ailleurs.reload();
    await expect(ailleurs.locator("#deverrouillage-moyens")).toContainText("Aucun coffre", {
      timeout: DELAI,
    });
    await ailleurs.close();
  }
});

test("après une RÉVOCATION d'urgence, la phrase est refusée et le code ouvre", async ({ page }) => {
  test.setTimeout(300_000);
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page)) return;
  await ouvrirParLaPhrase(page);
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
  const feuille = await creerLaFeuille(page);

  // Rouvrir par le CODE : c'est lui que la révocation gardera.
  await page.reload();
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await ouvrirParLeCode(page, feuille);
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
  await page.click("#revoquer-en-urgence");
  await expect(page.locator("#portabilite-etat")).toContainText("portabilite:revoque:1-retires", {
    timeout: DELAI,
  });
  const bilan = (await releve(page)).portabilite.revocation;
  expect(bilan.retires).toEqual({ phrase: 1 });
  expect(bilan.restants).toEqual({ recuperation: 1 });

  await page.reload();
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await ouvrirParLaPhrase(page);
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    ENVELOPPE_ERROR_CODES.cleRefusee,
    { timeout: DELAI },
  );
  expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.verrouille);
  await ouvrirParLeCode(page, { ...feuille, version: String(bilan.versionEnveloppe) });
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
});

/** Rejoue, dans l'OPFS de la coquille, les fichiers qu'a laissés la coquille d'AVANT. */
async function poserLeCoffreAnterieur(page) {
  const { fichiers } = JSON.parse(
    await readFile(
      new URL("../fixtures/coffre-anterieur/coffre-anterieur.json", import.meta.url),
      "utf8",
    ),
  );
  await page.goto(new URL("/src/coquille/identites-du-coffre.mjs", SHELL_ORIGIN).toString());
  await page.evaluate(async (aPoser) => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes", { create: true });
    for (const [nom, base64] of Object.entries(aPoser)) {
      const binaire = atob(base64);
      const octets = Uint8Array.from(binaire, (caractere) => caractere.charCodeAt(0));
      const handle = await dossier.getFileHandle(nom, { create: true });
      const ecrivain = await handle.createWritable();
      await ecrivain.write(octets);
      await ecrivain.close();
    }
  }, fichiers);
}

test("un coffre créé par la coquille d'AVANT est refusé dès l'inventaire, sans dériver", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  if (browserName === "webkit") {
    // Sous WebKit la coquille ne lit aucun volume : elle publie `indisponible`, et le refus ne peut
    // pas être rendu. La limite est exigée plutôt que sautée.
    await ouvrirLaCoquille(page);
    expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.indisponible);
    return;
  }
  await poserLeCoffreAnterieur(page);
  await ouvrirLaCoquille(page);
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.coffreAnterieur,
    { timeout: DELAI },
  );
  await expect(page.locator("#deverrouillage-refus")).toContainText("13/09/2026");

  // Le geste ne dérive rien : le refus est rendu tout de suite, et le coffre reste fermé.
  await ouvrirParLaPhrase(page, "une phrase de coffre antérieur, pour la fixture de #207");
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.coffreAnterieur,
  );
  const rapport = await releve(page);
  expect(rapport.mesures.deverrouillageMs).toBeNull();
  expect(rapport.etat).toBe(ETATS_DU_VOLUME.verrouille);

  // Ni sauvegarde, ni restauration par-dessus.
  await page.setInputFiles("#archive-a-restaurer", {
    name: "x.rbvault",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(64),
  });
  await page.click("#restaurer-le-coffre");
  await expect(page.locator("#portabilite-refus")).toContainText(
    CODES_REFUS_COQUILLE.coffreAnterieur,
    { timeout: DELAI },
  );
});
