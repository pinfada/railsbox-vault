// LA RESTAURATION ET LA COURSE ENTRE ONGLETS, sur le Worker de PRODUIT (#311, C5 ; revue de sécurité
// de la PR #314, constat 1).
//
// ## Le scénario
//
//  1. L'utilisateur choisit une archive dans l'onglet B : B constate un emplacement VIDE, et sa
//     restauration est admise. B est retardé (onglet gelé, fil chargé) avant sa première prise de
//     handle — le point d'arrêt du harnais (`tools/harnais-point-d-arret.mjs`).
//  2. Dans l'onglet A, de la même origine, l'utilisateur CRÉE son coffre, l'ouvre, et fait imprimer
//     un code de récupération : l'enveloppe de A, avec sa récupération, est sur le disque.
//  3. B reprend. Avant le correctif, il écrivait `coquille.cles` sans prendre le handle du volume
//     `coquille` ni revaliser l'emplacement : l'enveloppe de A était remplacée par celle de l'archive,
//     et le code de A n'ouvrait plus rien.
//
// Le correctif : la restauration prend l'exclusion du volume `coquille` — le verrou de l'ouverture —
// AVANT d'écrire, revalide sous ce verrou que l'emplacement est vide, et ne la relâche qu'après.
//
// Deux variantes, parce que le verrou et la revalidation sont deux gardes : A a FERMÉ (le verrou est
// libre : c'est la revalidation qui refuse), ou A tient encore son volume (c'est le verrou qui refuse).
//
// L'archive vient d'un AUTRE contexte (un autre OPFS, même serveur) ; la course se joue dans le contexte
// de l'épreuve, deux onglets d'une même origine. WebKit (session éphémère) : seul
// l'ÉTAT INITIAL est mesuré — indéterminé (ADR 0047), aucun volume ouvert ; la course n'y est pas jouée.

import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { fabriquerUneArchive } from "./support-archive-de-banc.mjs";
import {
  DELAI,
  PHRASE,
  armer,
  attendreLEtat,
  desarmer,
  ecouterLePointDArret,
  ouvrirEtImprimerUnCode,
  ouvrirLaCoquille,
  ouvrirParLeCode,
  pauseAtteinte,
  releve,
  reprendre,
  stockageIndetermine,
  verrouiller,
} from "./support-course-onglets.mjs";

let archive = null;

test.beforeAll(async ({ browser, browserName }, testInfo) => {
  test.setTimeout(300_000);
  if (browserName === "webkit") return;
  archive = join(tmpdir(), `archive-course-${browserName}-${process.pid}.vault`);
  await fabriquerUneArchive(browser, archive, testInfo.project.use.baseURL);
});

/** B restaure ; il est retenu à sa première prise de handle, après son constat. */
async function restaurationRetenue(context) {
  const a = await context.newPage();
  await ouvrirLaCoquille(a);
  const b = await context.newPage();
  await ouvrirLaCoquille(b);
  await ecouterLePointDArret(b);
  await armer(b, "*");
  await b.setInputFiles("#archive-a-restaurer", archive);
  await b.click("#restaurer-le-coffre");
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

test("RESTAURATION : B suspendu, A crée et ferme — B est refusé, l'enveloppe de A est intacte, son code ouvre", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b } = await restaurationRetenue(context);

  // A crée son coffre, imprime son code, puis se verrouille : le handle est libre.
  const feuilleDeA = await ouvrirEtImprimerUnCode(a);
  await verrouiller(a);

  await reprendre(b);
  await expect(b.locator("#portabilite-refus")).toContainText(
    CODES_REFUS_COQUILLE.emplacementOccupe,
    {
      timeout: DELAI,
    },
  );
  expect((await releve(b)).etat).toBe(ETATS_DU_VOLUME.verrouille);

  // L'enveloppe de A est intacte : son code, ET sa phrase, ouvrent encore.
  await ouvrirParLeCode(a, feuilleDeA);
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
  await verrouiller(a);
  await a.fill("#saisie-phrase", PHRASE);
  await a.click("#ouvrir-par-phrase");
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
});

test("RESTAURATION : B suspendu, A tient encore son volume — B est refusé, l'enveloppe de A est intacte", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b } = await restaurationRetenue(context);

  const feuilleDeA = await ouvrirEtImprimerUnCode(a); // A reste OUVERT

  await reprendre(b);
  await expect(b.locator("#portabilite-refus")).toContainText(STORAGE_ERROR_CODES.busy, {
    timeout: DELAI,
  });
  expect((await releve(a)).etat).toBe(ETATS_DU_VOLUME.ouvert);

  await verrouiller(a);
  await ouvrirParLeCode(a, feuilleDeA);
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
});
