// LA COURSE ENTRE ONGLETS AU DÉVERROUILLAGE, sur le Worker de PRODUIT (#311, tranche C5 du lot C ;
// ADR 0020, 0026, 0029 ; `SECURITY.md`, limites 8, 12 et 13).
//
// ## Le scénario, tel que le spike `spike/c1-course-onglets` @ `3ca0c6c` l'a prouvé
//
//  1. A (onglet du propriétaire) ouvre le coffre par la phrase et fait imprimer un code de
//     récupération — la clé K_B, que B va présenter.
//  2. B déverrouille par ce code : son Worker ouvre l'enveloppe, obtient la clé de volume, et est
//     RETARDÉ juste avant de prendre le handle exclusif du volume (onglet gelé, fil chargé).
//  3. A révoque en urgence — la phrase de A est conservée, le code est retiré —, puis verrouille :
//     son Worker meurt, le handle est libre.
//  4. B reprend. Avant le correctif, il prenait le handle et OUVRAIT le volume sous une clé que
//     l'enveloppe refuse déjà : « coffre ouvert », clé révoquée.
//
// ## Ce que cette épreuve fait de DIFFÉRENT du spike
//
// Elle rejoue la séquence sur le Worker de produit lui-même (`runtime-worker.mjs`, son état
// `interne`, son canal), deux onglets réels d'un même contexte, donc d'un même OPFS. La PAUSE n'est
// pas du code de produit : le serveur de test de `playwright.course-onglets.config.mjs` sert une
// copie de `opfs-sync-access.mjs` dont `openOpfsSyncAccess` attend un signal quand l'épreuve l'a
// armé (`tools/harnais-point-d-arret.mjs`) — le « point d'arrêt d'épreuve », sur les trois moteurs.
//
// **WebKit (session éphémère)** : la course n'y est pas jouée. L'épreuve mesure l'état initial —
// `indetermine` (lot F, ADR 0047 : le rejet de `getDirectory()` n'y est plus classé « indisponible ») —
// puis le refus qu'un geste reçoit quand la sonde relancée reste indéterminée.

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
  ouvrirParLeCode,
  pauseAtteinte,
  releve,
  reprendre,
  revoquerPuisVerrouiller,
  stockageIndetermine,
} from "./support-course-onglets.mjs";

/** Met en place la course jusqu'à la pause de B : A tient le coffre, B attend avant le handle. */
async function courseJusquALaPause(context) {
  const a = await context.newPage();
  await ouvrirLaCoquille(a);
  const feuille = await ouvrirEtImprimerUnCode(a);

  const b = await context.newPage();
  await ouvrirLaCoquille(b);
  await ecouterLePointDArret(b);
  await attendreLEtat(b, ETATS_DU_VOLUME.verrouille);
  // B est retenu à la prise du handle du VOLUME, après avoir lu l'enveloppe.
  await armer(b, "coquille");
  await ouvrirParLeCode(b, feuille);
  expect(await pauseAtteinte(b)).toBe("coquille");
  await desarmer(b);
  return { a, b, feuille };
}

test("WebKit éphémère : l'état initial est indéterminé, et un geste reçoit le refus d'une capacité indéterminée", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "webkit", "mesure propre à la session éphémère WebKit");
  await ouvrirLaCoquille(page);
  expect(await stockageIndetermine(page)).toBe(true);
  // Un geste relance la sonde (ADR 0047, décision 5) : si elle reste indéterminée, le geste reçoit
  // `VAULT_STORAGE_INDETERMINE` — jamais `UNSUPPORTED`, réservé à une absence établie — et l'état reste
  // `indetermine`. Aucun volume n'est ouvert.
  await page.click("#sauvegarder-le-coffre");
  await expect(page.locator("#portabilite-refus")).toContainText(
    STORAGE_ERROR_CODES.indeterminate,
    { timeout: DELAI },
  );
  await expect(page.locator("#portabilite-refus")).not.toContainText(
    STORAGE_ERROR_CODES.unsupported,
  );
  expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.indetermine);
});

test("C5 : B retardé entre l'enveloppe et le handle est REFUSÉ quand A a révoqué sa clé", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b } = await courseJusquALaPause(context);

  await revoquerPuisVerrouiller(a);
  await reprendre(b);

  // B se POSE : soit il est ouvert, soit son refus est publié. Le verdict est lu ensuite, et c'est
  // l'ÉTAT qui parle d'abord — un refus absent ne dirait pas que B s'est ouvert.
  await expect
    .poll(
      async () =>
        (await releve(b)).etat === ETATS_DU_VOLUME.ouvert ||
        (await b.locator("#deverrouillage-refus").textContent()) !== "",
      { timeout: DELAI },
    )
    .toBe(true);
  const apres = await releve(b);
  expect(apres.etat, "B ne doit JAMAIS finir ouvert sous une clé que l'enveloppe refuse").toBe(
    ETATS_DU_VOLUME.verrouille,
  );
  // LE REFUS : le même que celui d'une clé inconnue.
  await expect(b.locator("#deverrouillage-refus")).toContainText(ENVELOPPE_ERROR_CODES.cleRefusee);
  expect(apres.barrieres, "aucun effet partiel : le secteur de serrure n'a pas été écrit").toBe(0);

  // Le handle a été RENDU : la phrase de A, conservée par la révocation, ouvre.
  await a.fill("#saisie-phrase", PHRASE);
  await a.click("#ouvrir-par-phrase");
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
});

test("C5 : le Worker de B TUÉ à la pause ne laisse aucun effet — ni écriture, ni handle", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const { a, b, feuille } = await courseJusquALaPause(context);

  // B meurt AVANT d'avoir pris le handle : son Worker est détruit avec son onglet.
  await b.close();

  // Sa passe 1 était en lecture seule : la révocation de A trouve l'enveloppe telle qu'elle l'a
  // laissée, et avance d'UNE version — pas d'une de plus parce que B aurait écrit entre-temps.
  // Deux temps (#265) : « Révoquer… » ouvre la confirmation, « Oui » envoie.
  await a.click("#revoquer-en-urgence");
  await a.click("#revocation-oui");
  await expect(a.locator("#portabilite-etat")).toContainText("portabilite:revoque:1-retires", {
    timeout: DELAI,
  });
  expect((await releve(a)).portabilite.revocation.versionEnveloppe).toBe(
    Number(feuille.version) + 1,
  );

  // Rien ne tient le volume que A : il se verrouille, puis la phrase rouvre.
  await revoquerPuisVerrouiller(a, { dejaRevoque: true });
  await a.fill("#saisie-phrase", PHRASE);
  await a.click("#ouvrir-par-phrase");
  await attendreLEtat(a, ETATS_DU_VOLUME.ouvert);
});

test("contrôle : sans pause, B est refusé tant que A tient le volume — le handle exclusif tient", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const a = await context.newPage();
  await ouvrirLaCoquille(a);
  const feuille = await ouvrirEtImprimerUnCode(a);
  const b = await context.newPage();
  await ouvrirLaCoquille(b);
  await ouvrirParLeCode(b, feuille);
  await expect(b.locator("#deverrouillage-refus")).toContainText(STORAGE_ERROR_CODES.busy, {
    timeout: DELAI,
  });
  expect((await releve(b)).etat).toBe(ETATS_DU_VOLUME.verrouille);
});
