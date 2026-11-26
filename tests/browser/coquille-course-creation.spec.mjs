// LA CRÉATION DU COFFRE ET LA COURSE ENTRE ONGLETS, sur le Worker de PRODUIT (#311, C5 ; #313).
//
// Deux onglets d'une même origine, sans coffre. B déverrouille par la phrase : son Worker constate
// l'absence d'enveloppe, et est retardé avant sa première prise de handle (le point d'arrêt du harnais,
// `tools/harnais-point-d-arret.mjs`). A crée son coffre — enveloppe, récupération, volume — et l'ouvre.
// B reprend.
//
// Avant le correctif, B écrivait SA PROPRE enveloppe par-dessus celle de A (le refus d'un fichier déjà
// présent est jugé avant la suspension) : le volume de A, scellé sous sa clé, ne s'ouvrait plus sous
// aucune clé de l'enveloppe. Le correctif : la création prend le handle du volume `coquille` AVANT
// d'écrire l'enveloppe, y revalide que l'enveloppe est absente, et le PASSE à l'ouvreur — aucun trou
// entre l'enveloppe et la naissance du volume.
//
// WebKit (session éphémère) : seul l'ÉTAT INITIAL est mesuré — indéterminé (ADR 0047), aucun volume
// ouvert. Un geste relancerait la sonde ; la course elle-même n'y est pas jouée.

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import {
  DELAI,
  PHRASE,
  armer,
  attendreLEtat,
  desarmer,
  ecouterLePointDArret,
  ouvrirEtImprimerUnCode,
  ouvrirLaCoquille,
  ouvrirParLaPhrase,
  ouvrirParLeCode,
  pauseAtteinte,
  releve,
  reprendre,
  stockageIndetermine,
  verrouiller,
} from "./support-course-onglets.mjs";

/** B crée son coffre ; il est retenu à sa première prise de handle, après avoir constaté le vide. */
async function creationRetenue(context) {
  const a = await context.newPage();
  await ouvrirLaCoquille(a);
  const b = await context.newPage();
  await ouvrirLaCoquille(b);
  await ecouterLePointDArret(b);
  await armer(b, "*");
  await ouvrirParLaPhrase(b);
  await pauseAtteinte(b);
  await desarmer(b);
  return { a, b };
}

test("WebKit éphémère : l'état initial est indéterminé, aucun volume n'est ouvert", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "webkit", "mesure propre à la session éphémère WebKit");
  await ouvrirLaCoquille(page);
  expect(await stockageIndetermine(page)).toBe(true);
});

test("CRÉATION : B suspendu, A crée et ferme — B est refusé, l'enveloppe de A est intacte, son code ouvre", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b } = await creationRetenue(context);

  const feuilleDeA = await ouvrirEtImprimerUnCode(a);
  await verrouiller(a);

  await reprendre(b);
  await expect(b.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.emplacementOccupe,
    {
      timeout: DELAI,
    },
  );
  expect((await releve(b)).etat).toBe(ETATS_DU_VOLUME.verrouille);

  // L'enveloppe de A — sa phrase ET sa récupération — est intacte, et son volume s'ouvre.
  await ouvrirParLeCode(a, feuilleDeA);
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
  await verrouiller(a);
  await a.fill("#saisie-phrase", PHRASE);
  await a.click("#ouvrir-par-phrase");
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
});

test("CRÉATION : B suspendu, A tient encore son volume — B est refusé BUSY, A est intact", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b } = await creationRetenue(context);

  const feuilleDeA = await ouvrirEtImprimerUnCode(a); // A reste OUVERT
  await reprendre(b);

  await expect(b.locator("#deverrouillage-refus")).toContainText(STORAGE_ERROR_CODES.busy, {
    timeout: DELAI,
  });
  expect((await releve(a)).etat).toBe(ETATS_DU_VOLUME.ouvert);
  await verrouiller(a);
  await ouvrirParLeCode(a, feuilleDeA);
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
});

test("CRÉATION : B suspendu, une restauration s'INTERROMPT après le disque — B est refusé, aucune enveloppe n'est écrite", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b } = await creationRetenue(context);

  // Ce qu'une restauration coupée entre le disque et l'enveloppe laisse : le disque versé, sans
  // manifeste ni enveloppe. Posé par la page A dans l'OPFS de l'origine, pendant l'attente de B.
  await a.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes", { create: true });
    const fichier = await dossier.getFileHandle("application", { create: true });
    const ecrivain = await fichier.createWritable();
    await ecrivain.write(new Uint8Array(4096).fill(0x5b));
    await ecrivain.close();
  });

  await reprendre(b);
  await expect(b.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.restaurationInterrompue,
    { timeout: DELAI },
  );
  expect((await releve(b)).etat).toBe(ETATS_DU_VOLUME.verrouille);
  // Rien n'est né : ni enveloppe, ni volume `coquille` (un fichier vide n'est pas un volume).
  const fichiers = await a.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-volumes");
    const tailles = {};
    for await (const [nom, poignee] of dossier.entries()) {
      tailles[nom] = (await poignee.getFile()).size;
    }
    return tailles;
  });
  expect(fichiers["coquille.cles"] ?? 0).toBe(0);
  expect(fichiers.coquille ?? 0).toBe(0);
});
