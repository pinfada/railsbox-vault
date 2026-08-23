import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { GUEST_MARKER, HOST_MARKER } from "../../src/vm/guest-scenarios.mjs";
import { ARTIFACT_DIRECTORY } from "../../tools/v86-paths.mjs";

// Preuve « intégration VM » du backend OPFS (#6, `VAULT-PERSIST-001`). Un vrai guest Linux i386
// démarre sur un disque IDE dont le tampon est le backend OPFS de Vault, et la mesure porte sur les
// DEUX directions du support :
//
//  - l'hôte écrit une marque dans le fichier OPFS AVANT le boot ; le guest doit la relire sur
//    `/dev/sda`. Cela prouve que ce que le guest voit vient du fichier ;
//  - le guest écrit sa propre marque puis `sync` ; l'hôte ferme le handle, rouvre le volume et doit
//    la retrouver. Cela prouve que ce que le guest écrit atteint le fichier et lui survit.
//
// Une seule direction ne prouverait qu'une moitié. Ce que cette suite n'affirme PAS : que la
// barrière du guest garantisse la durabilité avant son acquittement — c'est #14 —, ni la reprise
// d'une application Rails après fermeture complète, qui est #7.

test.beforeAll(() => {
  const missing = ["libv86.mjs", "v86.wasm", "seabios.bin", "vgabios.bin", "linux4.iso"].filter(
    (name) => !existsSync(join(ARTIFACT_DIRECTORY, name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Artefacts v86 absents (${missing.join(", ")}). Exécuter « npm run vm:fetch » avant « npm run test:vm ».`,
    );
  }
});

test("le guest lit et écrit un volume OPFS qui survit à la fermeture du handle", async ({
  page,
}, testInfo) => {
  await page.goto("/vm/");
  await expect(page.locator("#etat")).toHaveText("Worker runtime prêt.");

  const rapport = await page.evaluate(() =>
    globalThis.bancVault.executer({ scenario: "opfs-persistence" }),
  );
  await testInfo.attach("vm-opfs-persistance.json", {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });

  // Aucune erreur de support n'a été absorbée en route.
  expect(rapport.failures).toEqual([]);

  // Direction hôte → guest : le noyau lit sur `/dev/sda` ce que le backend a déposé dans OPFS.
  expect(rapport.guestReadOfHostMarker).toContain(HOST_MARKER);

  // Direction guest → hôte, après fermeture et réouverture du handle exclusif.
  expect(rapport.guestReadOfOwnMarker).toContain(GUEST_MARKER);
  expect(rapport.hostReadOfGuestMarker).toBe(GUEST_MARKER);
  expect(rapport.hostReadOfHostMarker).toBe(HOST_MARKER);

  // La géométrie relue du fichier est celle de la session, sans qu'elle ait été redéclarée.
  expect(rapport.reopenedSize).toBe(rapport.volumeBytes);

  // La barrière est comptée SUR L'ÉTAPE du guest : le total inclurait le flush que l'hôte émet
  // avant le boot, et prouverait donc quelque chose que le guest n'a pas fait.
  const ecriture = rapport.steps.find((step) => step.label === "ecrire-marque-guest");
  expect(ecriture.writes).toBeGreaterThan(0);
  expect(ecriture.flushes).toBeGreaterThan(0);
  expect(ecriture.flushAcks).toBe(ecriture.flushes);
  expect(ecriture.ata["0xE7"] ?? 0).toBeGreaterThan(0);
  expect(rapport.verdict.satisfied).toBe(true);
});
