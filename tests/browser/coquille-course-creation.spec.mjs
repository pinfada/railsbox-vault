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
// WebKit : pas d'OPFS synchrone dans un Worker, la limite est exigée.

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
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
  sansOpfsSynchrone,
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

test("WebKit : sans OPFS synchrone, la limite est exigée", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "mesure propre aux moteurs sans OPFS synchrone");
  await ouvrirLaCoquille(page);
  expect(await sansOpfsSynchrone(page)).toBe(true);
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
  await expect(b.locator("#deverrouillage-refus")).toContainText(ENVELOPPE_ERROR_CODES.presente, {
    timeout: DELAI,
  });
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
