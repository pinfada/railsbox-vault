// Épreuves de l'EFFET des en-têtes de durcissement de la coquille (#104, ADR 0022).
//
// L'unitaire montre ce que `tools/serve-headers.mjs` DÉCIDE ; il ne peut pas montrer ce que le
// moteur en FAIT. Or la propriété visée par `Referrer-Policy: no-referrer` est une propriété de
// frontière : la seule requête inter-origine que la CSP de la coquille autorise est le CADRE du
// territoire applicatif, et sous la politique par défaut des moteurs cette requête porte l'origine
// de la coquille jusqu'à une origine dont le contenu vient du guest (ADR 0002).
//
// Le relevé est accompagné de son TÉMOIN NÉGATIF, sans lequel un « pas de Referer » ne prouverait
// rien — il pourrait venir d'une sonde cassée ou d'un moteur qui n'en émet jamais dans ces
// conditions. Le témoin est la MÊME manipulation — un document encadre `canary.txt` sur une autre
// origine — émise depuis un document servi par le rôle `app`, qui ne reçoit PAS de
// `Referrer-Policy` : c'est la décision par rôle de l'ADR 0022 qui devient ici la variable.

import { expect, test } from "@playwright/test";

import { ORIGINE_APPLICATIVE_B } from "../../public/spike/origin/apps-topologie.mjs";
import { APP_ORIGIN, CANARY_PATH, SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/** Politique de permissions attendue, recopiée EXPRÈS : une épreuve qui importerait la constante
 *  du serveur passerait même si la valeur servie changeait des deux côtés à la fois. */
const PERMISSIONS_ATTENDUES = "camera=(), microphone=(), geolocation=()";

/**
 * Encadre `cible` depuis le document courant et rend l'en-tête `Referer` de la requête émise.
 *
 * L'iframe est le mécanisme réel de la topologie de l'ADR 0002, et le seul que la CSP de la
 * coquille laisse sortir : `connect-src 'self'` et `img-src 'self'` ferment les autres.
 *
 * @returns {Promise<string | null>}
 */
async function refererDuCadre(page, cible) {
  const attendue = page.waitForRequest(cible);
  await page.evaluate((url) => {
    const cadre = document.createElement("iframe");
    cadre.src = url;
    document.body.append(cadre);
  }, cible);
  const enTetes = await (await attendue).allHeaders();
  return enTetes.referer ?? null;
}

test("la coquille sert le durcissement, l'origine applicative ne le sert pas", async ({
  request,
}) => {
  const coquille = (await request.get(`${SHELL_ORIGIN}/index.html`)).headers();
  const application = (await request.get(`${APP_ORIGIN}/index.html`)).headers();

  expect(coquille["referrer-policy"]).toBe("no-referrer");
  expect(coquille["permissions-policy"]).toBe(PERMISSIONS_ATTENDUES);

  // La décision est par RÔLE, pas une valeur unique posée par confort : `Referrer-Policy` et
  // `Permissions-Policy` gouvernent ce que le document ÉMET et ce qu'il PEUT, donc son contenu —
  // que l'ADR 0002 refuse de contraindre sur le territoire du guest.
  expect(application["referrer-policy"]).toBeUndefined();
  expect(application["permissions-policy"]).toBeUndefined();

  // HSTS est écarté par l'ADR 0022 : sur `http:` il serait ignoré par construction.
  expect(coquille["strict-transport-security"]).toBeUndefined();
  expect(application["strict-transport-security"]).toBeUndefined();
});

test("la coquille n'émet pas son URL vers l'origine applicative qu'elle encadre", async ({
  page,
}) => {
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  expect(await refererDuCadre(page, `${APP_ORIGIN}${CANARY_PATH}`)).toBeNull();
});

test("témoin négatif : sans `Referrer-Policy`, la même requête porte l'origine émettrice", async ({
  page,
}) => {
  await page.goto(`${APP_ORIGIN}/index.html`);
  const referer = await refererDuCadre(page, `${ORIGINE_APPLICATIVE_B}${CANARY_PATH}`);
  expect(referer).not.toBeNull();
  expect(referer).toContain(APP_ORIGIN);
});
