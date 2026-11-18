// SUPPORT : une archive de sauvegarde réelle, fabriquée par la coquille (#311, C5).
//
// Les courses de restauration ont besoin d'une archive que le Worker de produit accepte — celle d'un
// coffre complet, avec sa récupération. Elle est fabriquée comme `coquille-portabilite.spec.mjs` le
// fait : un petit disque servi par une route, la coquille l'INSTALLE, le boot échoue faute de noyau,
// et la sauvegarde emporte ce coffre-là. Les constantes sont celles de cette suite, recopiées plutôt
// qu'importées : une suite ne s'importe pas d'une autre, ses épreuves s'enregistreraient deux fois.

import { createHash } from "node:crypto";

import { expect } from "../support/test.mjs";

import {
  DELAI,
  ouvrirEtImprimerUnCode,
  ouvrirLaCoquille,
  releve,
} from "./support-course-onglets.mjs";

const OCTETS_DU_DISQUE = 16 * 512;
const GRAINE = Buffer.alloc(OCTETS_DU_DISQUE, 0x42);

const DESCRIPTEUR = {
  descripteurVersion: 2,
  application: { id: "portabilite-test", version: "1.0.0", schema: "20260101000002" },
  runtime: { version: "0.1.0" },
  rootfs: { nom: "r.ext4", octets: 4096, sha256: "a".repeat(64) },
  paquet: { nom: "p.ext4", octets: 4096, sha256: "b".repeat(64) },
  graine: {
    nom: "graine-de-portabilite.ext4",
    octets: OCTETS_DU_DISQUE,
    sha256: createHash("sha256").update(GRAINE).digest("hex"),
    disqueOctets: OCTETS_DU_DISQUE,
  },
  boot: {
    cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
    memoireOctets: 33554432,
    kernel: "k",
    initrd: "i",
    bios: "seabios.bin",
    vgaBios: "vgabios.bin",
  },
  prefixeDesArtefacts: "/artifacts/portabilite-test/",
};

/** Sert le descripteur et le disque, sur toutes les origines du contexte. */
export async function servirLApplication(contexte) {
  await contexte.route("**/artifacts/application.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DESCRIPTEUR),
    }),
  );
  await contexte.route(`**${DESCRIPTEUR.prefixeDesArtefacts}${DESCRIPTEUR.graine.nom}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/octet-stream", body: GRAINE }),
  );
}

/**
 * FABRIQUE l'archive d'un coffre complet dans un contexte à part (un autre OPFS), et la range dans
 * `chemin`. Rend le code de récupération et la version de sa feuille.
 *
 * @param {import("@playwright/test").Browser} navigateur
 * @param {string} chemin
 * @param {string} baseURL
 */
export async function fabriquerUneArchive(navigateur, chemin, baseURL) {
  const contexte = await navigateur.newContext({ baseURL });
  try {
    await servirLApplication(contexte);
    const page = await contexte.newPage();
    await ouvrirLaCoquille(page);
    const feuille = await ouvrirEtImprimerUnCode(page);
    await page.click("#demarrer-application");
    await expect(page.locator("#cycle-etat")).not.toHaveText(/au-repos|demarrage-en-cours/, {
      timeout: DELAI,
    });
    const telechargement = page.waitForEvent("download", { timeout: DELAI });
    await page.click("#sauvegarder-le-coffre");
    const fichier = await telechargement;
    await expect(page.locator("#portabilite-etat")).toContainText("portabilite:sauvegarde-prete", {
      timeout: DELAI,
    });
    await fichier.saveAs(chemin);
    return { feuille, rapport: (await releve(page)).portabilite.sauvegarde };
  } finally {
    await contexte.close();
  }
}
