// Le BLOC « Mettre à jour l'application » et les REFUS de déphasage, sur les TROIS moteurs (#236 T2,
// ADR 0042 ; ADR 0040, note datée).
//
// Aucune machine virtuelle n'est démarrée : ce qui est mesuré ici est ce que la coquille DÉCIDE et
// MONTRE après le déverrouillage, avant tout boot. Le manifeste du coffre est posé dans l'OPFS de
// l'origine avant l'ouverture — c'est ce qu'y laisserait une installation antérieure —, et le
// descripteur est servi par interception. Le Worker de confiance est le vrai : il lit le manifeste,
// confronte, et publie sa décision ; un démarrage demandé ensuite REDÉCIDE de lui-même.
//
// Ce qui ne se mesure PAS ici : le boot qui migre, la note relue, la sauvegarde restaurée sur
// l'ancien paquet — `tests/e2e/mise-a-jour-du-paquet.spec.mjs`, sur l'image réelle.

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { IDENTIFIANT_DU_COFFRE } from "../../src/coquille/identites-du-coffre.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";

const DELAI = 120_000;
const M = "20260101000002";
const N = "20260919000002";

async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Un descripteur admis : 1.1.0 (N) servi, 1.0.0 (M) en précédent si demandé. */
function descripteur({ precedent = true, id = "reference-essai" } = {}) {
  return {
    descripteurVersion: 2,
    application: { id, version: "1.1.0", schema: N },
    runtime: { version: "0.1.0" },
    rootfs: { nom: "r.ext4", octets: 4096, sha256: "a".repeat(64) },
    paquet: { nom: "p110.ext4", octets: 4096, sha256: "b".repeat(64) },
    graine: { nom: "g.ext4", octets: 8192, sha256: "c".repeat(64), disqueOctets: 8192 },
    ...(precedent
      ? {
          precedent: {
            application: { version: "1.0.0", schema: M },
            paquet: { nom: "p100.ext4", octets: 4096, sha256: "d".repeat(64) },
          },
        }
      : {}),
    boot: {
      cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
      memoireOctets: 33554432,
      kernel: "k",
      initrd: "i",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    prefixeDesArtefacts: "/artifacts/essai/",
  };
}

/** Le manifeste qu'une installation antérieure aurait laissé à côté du volume `application`. */
function manifesteDuCoffre(app) {
  return new TextDecoder().decode(
    serializeManifest(
      createManifest({
        runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
        app,
        volumeSize: SECTOR_SIZE * 16,
        // L'identité du COFFRE (ADR 0039) : un manifeste qui en déclare une autre est un disque
        // d'un autre coffre, refusé dès le déverrouillage — ce n'est pas ce que ces épreuves mesurent.
        volume: { id: IDENTIFIANT_DU_COFFRE, algorithm: "aes-256-gcm" },
      }),
    ),
  );
}

/**
 * Sert le descripteur, pose le manifeste, ouvre la coquille, et déverrouille par la phrase.
 *
 * WebKit n'offre pas l'OPFS synchrone dans un Worker : la coquille y publie `indisponible` et rien ne
 * s'y ouvre (`coquille-portabilite.spec.mjs`, même règle). Ces épreuves ne s'y jouent donc pas ;
 * l'ordre attaqué, lui, s'y joue — il ne demande aucun volume.
 */
async function ouvrirSur(page, { servi, app }) {
  test.skip(
    test.info().project.use.browserName === "webkit",
    "rien ne s'y ouvre : pas d'OPFS synchrone",
  );
  await page
    .context()
    .route("**/artifacts/application.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(servi) }),
    );
  await page.goto(`${SHELL_ORIGIN}/index.html?vue=complete`, { waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  await page.evaluate(async (texte) => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes", { create: true });
    const fichier = await dossier.getFileHandle("application.manifest", { create: true });
    const flux = await fichier.createWritable();
    await flux.write(texte);
    await flux.close();
  }, manifesteDuCoffre(app));
  await page.fill("#saisie-phrase", "une phrase de scenario assez longue pour la calibration");
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .toBe(ETATS_DU_VOLUME.ouvert);
  await expect
    .poll(async () => (await releve(page)).dephasage?.issue ?? null, { timeout: DELAI })
    .not.toBeNull();
  return (await releve(page)).dephasage;
}

test("une version plus récente est PROPOSÉE à l'accueil, avant tout boot ; « Plus tard » laisse l'accueil", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const constat = await ouvrirSur(page, {
    servi: descripteur(),
    app: { id: "reference-essai", version: "1.0.0", schema: M },
  });
  expect(constat).toMatchObject({ issue: "mettre-a-jour", migration: true, plusTard: true });
  await expect(page.locator("#mise-a-jour")).toBeVisible();
  await expect(page.locator("#mise-a-jour-titre")).toHaveText("Mettre à jour l'application");
  await expect(page.locator("#mise-a-jour-texte")).toContainText("1.1.0");
  await expect(page.locator("#mise-a-jour-texte")).toContainText("1.0.0");
  await expect(page.locator("#mise-a-jour-texte")).toContainText("faites une sauvegarde");
  await expect(page.locator("#sauvegarder-avant-mise-a-jour")).toBeVisible();
  await expect(page.locator("#mettre-a-jour-l-application")).toBeVisible();
  await expect(page.locator("#plus-tard")).toBeVisible();
  expect((await releve(page)).application, "rien n'a démarré").toBeNull();

  await page.click("#plus-tard");
  await expect(page.locator("#mise-a-jour")).toBeHidden();
  expect((await releve(page)).dephasage.reportee).toBe(true);
  await expect(page.locator("#demarrer-application")).toBeVisible();
});

test("sans le précédent servi, « Plus tard » n'est pas offert, et démarrer sans le geste est refusé", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const constat = await ouvrirSur(page, {
    servi: descripteur({ precedent: false }),
    app: { id: "reference-essai", version: "1.0.0", schema: M },
  });
  expect(constat).toMatchObject({ issue: "mettre-a-jour", plusTard: false });
  await expect(page.locator("#mise-a-jour")).toBeVisible();
  await expect(page.locator("#plus-tard")).toBeHidden();
  await expect(page.locator("#mise-a-jour-plus-tard-texte")).toContainText(
    "ne sert plus votre version actuelle",
  );
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${C.applicationNonServie}`,
    { timeout: DELAI },
  );
  expect((await releve(page)).application.bootMs, "aucun boot").toBeUndefined();
});

for (const [titre, app, servi, code, conduite] of [
  [
    "des données plus récentes que le code servi",
    { id: "reference-essai", version: "1.2.0", schema: "20261001000001" },
    descripteur(),
    C.applicationAnterieure,
    "version plus récente",
  ],
  [
    "le retour arrière de version, même à schéma égal",
    { id: "reference-essai", version: "1.2.0", schema: N },
    descripteur(),
    C.applicationAnterieure,
    "version plus récente",
  ],
  [
    "le coffre d'une autre application",
    { id: "une-autre-application", version: "1.0.0", schema: M },
    descripteur(),
    C.applicationEtrangere,
    "une autre application",
  ],
]) {
  test(`REFUS avant tout boot : ${titre}`, async ({ page }) => {
    test.setTimeout(240_000);
    const constat = await ouvrirSur(page, { servi, app });
    expect(constat).toMatchObject({ issue: "refus", code });
    await expect(page.locator("#cycle-etat")).toHaveText(`cycle:application-refusee:${code}`);
    await expect(page.locator("#mise-a-jour")).toBeHidden();
    await expect(page.locator("#parcours-refus")).toContainText(conduite);
    await expect(page.locator("#parcours-refus")).toContainText("sauvegarde");
    // Le démarrage REDÉCIDE : la page n'est pas crue, le refus revient, et rien ne boote.
    await page.click("#demarrer-application");
    await expect(page.locator("#cycle-etat")).toHaveText(`cycle:demarrage-refuse:${code}`, {
      timeout: DELAI,
    });
    expect((await releve(page)).application.bootMs, "aucun boot").toBeUndefined();
  });
}

test("ORDRE ATTAQUÉ : « Mettre à jour » cliqué avant le déverrouillage est refusé par le Worker", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.context().route("**/artifacts/application.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(descripteur()),
    }),
  );
  await page.goto(`${SHELL_ORIGIN}/index.html?vue=complete`, { waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  // Le bloc est caché : le bouton est atteint AUTREMENT, comme un script de l'origine le ferait.
  await page.evaluate(() => document.querySelector("#mettre-a-jour-l-application").click());
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${C.etapeHorsOrdre}`,
    { timeout: DELAI },
  );
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(
    (await releve(page)).etat,
  );
});
