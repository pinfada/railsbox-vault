// LA COURSE ENTRE ONGLETS AU DÉVERROUILLAGE, sur le Worker de PRODUIT (#311, tranche C5 du lot C ;
// ADR 0020, 0026, 0029 ; `SECURITY.md`, limites 8 et 12).
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
// pas du code de produit : l'épreuve sert, à l'onglet B seulement, une copie de
// `opfs-sync-access.mjs` dont `openOpfsSyncAccess` attend un signal avant d'ouvrir le volume
// `coquille` — le « point d'arrêt d'épreuve ». L'onglet A reçoit le module tel quel.
//
// **WebKit** n'offre pas l'OPFS synchrone dans un Worker : la coquille y publie `indisponible`, et la
// limite est EXIGÉE, pas sautée.

import { expect, test } from "../support/test.mjs";

import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

const DELAI = 120_000;
const PHRASE = "une phrase de course entre onglets assez longue pour la calibration";
const CANAL = "c5-311-point-d-arret";

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

async function ouvrirLaCoquille(page) {
  await page.goto(new URL("/index.html?vue=complete", SHELL_ORIGIN).toString(), {
    waitUntil: "commit",
  });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", /prete|sans-cadre/, {
    timeout: DELAI,
  });
}

async function attendreLEtat(page, etat) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: DELAI }).toBe(etat);
}

/**
 * Le POINT D'ARRÊT : la copie de `opfs-sync-access.mjs` que l'épreuve sert à UN onglet.
 *
 * `openOpfsSyncAccess("coquille")` — la prise du handle exclusif du volume — attend « reprendre »
 * quand l'épreuve l'a « armé », une seule fois, et annonce « atteint » avant d'attendre. L'armement
 * vient APRÈS le démarrage du Worker : la sonde d'exclusivité qu'il lance au chargement ouvre ce même
 * fichier, et ne doit pas être retenue. Une source qui ne contient plus la déclaration visée fait
 * ÉCHOUER l'épreuve : un point d'arrêt qui ne s'applique pas ne mesurerait rien.
 */
async function poserLePointDArret(page) {
  const cible = "export async function openOpfsSyncAccess(name) {";
  await page.route("**/src/vm/opfs-sync-access.mjs", async (route) => {
    const reponse = await route.fetch();
    const source = await reponse.text();
    if (!source.includes(cible)) {
      return route.fulfill({ status: 500, body: "point d'arrêt inapplicable : source changée" });
    }
    const pause = `
const __canal = new BroadcastChannel(${JSON.stringify(CANAL)});
let __arme = false;
let __reprendre = null;
__canal.onmessage = (evenement) => {
  if (evenement.data === "armer") __arme = true;
  if (evenement.data === "reprendre") __reprendre?.();
};
export async function openOpfsSyncAccess(name) {
  if (name === "coquille" && __arme) {
    __arme = false;
    await new Promise((reprise) => {
      __reprendre = reprise;
      __canal.postMessage("atteint");
    });
  }
  return openOpfsSyncAccessOrigine(name);
}
`;
    return route.fulfill({
      response: reponse,
      body: source.replace(cible, "async function openOpfsSyncAccessOrigine(name) {") + pause,
    });
  });
}

/** L'écouteur de la PAGE, posé APRÈS la navigation : un `goto` détruit le contexte d'avant. */
async function ecouterLePointDArret(page) {
  await page.evaluate((canal) => {
    globalThis.__pointDArret = { atteint: false, canal: new BroadcastChannel(canal) };
    globalThis.__pointDArret.canal.onmessage = (evenement) => {
      if (evenement.data === "atteint") globalThis.__pointDArret.atteint = true;
    };
  }, CANAL);
}

const armer = (page) => page.evaluate(() => globalThis.__pointDArret.canal.postMessage("armer"));
const reprendre = (page) =>
  page.evaluate(() => globalThis.__pointDArret.canal.postMessage("reprendre"));
const pauseAtteinte = (page) =>
  expect
    .poll(() => page.evaluate(() => globalThis.__pointDArret.atteint), { timeout: DELAI })
    .toBe(true);

/** A : ouvre par la phrase, imprime un code de récupération, et rend ce code avec sa version. */
async function ouvrirEtImprimerUnCode(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await attendreLEtat(page, ETATS_DU_VOLUME.ouvert);
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

/** A révoque tout sauf lui-même, puis VERROUILLE : le Worker meurt, le handle est libre. */
async function revoquerPuisVerrouiller(page, { dejaRevoque = false } = {}) {
  if (!dejaRevoque) {
    await page.click("#revoquer-en-urgence");
    await expect(page.locator("#portabilite-etat")).toContainText("portabilite:revoque:1-retires", {
      timeout: DELAI,
    });
  }
  await page.evaluate(() => {
    globalThis.__documentDAvantLeVerrouillage = true;
  });
  await page.locator("#verrouiller-le-coffre").click();
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() => globalThis.__documentDAvantLeVerrouillage === undefined);
        } catch {
          return false; // contexte détruit par la navigation : c'est le rechargement
        }
      },
      { timeout: DELAI },
    )
    .toBe(true);
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
}

/** Met en place la course jusqu'à la pause de B : A tient le coffre, B attend avant le handle. */
async function courseJusquALaPause(context, browserName) {
  const a = await context.newPage();
  await ouvrirLaCoquille(a);
  if ((await releve(a)).etat === ETATS_DU_VOLUME.indisponible) return { limite: true, a };
  const feuille = await ouvrirEtImprimerUnCode(a);

  const b = await context.newPage();
  await poserLePointDArret(b);
  await ouvrirLaCoquille(b);
  await ecouterLePointDArret(b);
  await attendreLEtat(b, ETATS_DU_VOLUME.verrouille);
  await armer(b);
  await ouvrirParLeCode(b, feuille);
  await pauseAtteinte(b);
  return { limite: false, a, b, feuille, navigateur: browserName };
}

test("WebKit : sans OPFS synchrone, la limite est exigée", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "mesure propre aux moteurs sans OPFS synchrone");
  await ouvrirLaCoquille(page);
  expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.indisponible);
  await page.click("#sauvegarder-le-coffre");
  await expect(page.locator("#portabilite-refus")).toContainText(STORAGE_ERROR_CODES.unsupported, {
    timeout: DELAI,
  });
});

test("C5 : B retardé entre l'enveloppe et le handle est REFUSÉ quand A a révoqué sa clé", async ({
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "pas d'OPFS synchrone dans un Worker");
  test.setTimeout(300_000);
  const course = await courseJusquALaPause(context, browserName);
  const { a, b } = course;

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
  const { a, b, feuille } = await courseJusquALaPause(context, browserName);

  // B meurt AVANT d'avoir pris le handle : son Worker est détruit avec son onglet.
  await b.close();

  // Sa passe 1 était en lecture seule : la révocation de A trouve l'enveloppe telle qu'elle l'a
  // laissée, et avance d'UNE version — pas d'une de plus parce que B aurait écrit entre-temps.
  await a.click("#revoquer-en-urgence");
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
