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

import { expect, test } from "../support/test.mjs";

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

// --- COOP : servi, et ATTESTÉ (#163, ADR 0030, décision 4) ----------------------------------------
//
// `Cross-Origin-Opener-Policy: same-origin` était RECOMMANDÉ par l'ADR 0010 et posé par la seule
// chaîne de publication (ADR 0017 § 3). Le serveur de test ne le servait pas, si bien qu'aucune
// épreuve ne pouvait attester son effet : la décision reposait sur la lecture d'une table.
//
// Ce qu'il ferme, et que rien d'autre ne ferme : la relation d'OUVERTURE inter-fenêtres.
// `frame-ancestors 'none'` interdit d'ENCADRER la coquille ; il ne dit rien d'une fenêtre qu'elle
// ouvre, ni d'une fenêtre qui l'ouvrirait. Une coquille qui détient la KEK de la session pour toute
// sa durée (#162, ADR 0029) n'a aucune raison de laisser une référence `window.opener` vivante.
//
// Le TÉMOIN NÉGATIF est la même manipulation depuis le rôle `app`, qui ne reçoit pas l'en-tête :
// sans lui, un `opener === null` pourrait n'être que le `noopener` implicite d'un moteur, ou une
// sonde cassée.

/**
 * Ouvre la seconde fenêtre par un CLIC, sur la cible demandée, et rend ce que le moteur lui a
 * laissé de son ouvrante.
 *
 * @param {"#ouvrir-ici" | "#ouvrir-ailleurs"} bouton
 */
async function openerDeLaFenetreOuverte(page, origine, bouton) {
  await page.goto(`${origine}/coquille-epreuve/ouvrante.html`);
  const [ouverte] = await Promise.all([page.waitForEvent("popup"), page.click(bouton)]);
  await ouverte.waitForLoadState("domcontentloaded");
  const verdict = await ouverte.evaluate(() => ({
    opener: window.opener === null ? "nul" : "present",
    origine: location.origin,
  }));
  await ouverte.close();
  return verdict;
}

test("COOP est servi par la coquille, et par elle seule", async ({ request }) => {
  const coquille = (await request.get(`${SHELL_ORIGIN}/index.html`)).headers();
  const application = (await request.get(`${APP_ORIGIN}/index.html`)).headers();

  expect(coquille["cross-origin-opener-policy"]).toBe("same-origin");

  // Pas sur l'origine applicative, et ce n'est pas un oubli : un document ENCADRÉ n'est pas un
  // contexte de navigation de plus haut niveau, l'en-tête y serait sans effet. Le poser y ferait
  // croire à une protection que le moteur ignore.
  expect(application["cross-origin-opener-policy"]).toBeUndefined();

  // COEP reste ÉCARTÉ (ADR 0010) : il exigerait de chaque sous-ressource inter-origine un
  // consentement explicite, y compris du territoire du guest, ce que l'ADR 0002 refuse de
  // contraindre. COOP servi SEUL ne confère donc pas `crossOriginIsolated`, et ne le prétend pas.
  expect(coquille["cross-origin-embedder-policy"]).toBeUndefined();
  expect(application["cross-origin-embedder-policy"]).toBeUndefined();
});

test("une fenêtre INTER-ORIGINE ouverte depuis la coquille ne garde AUCUN opener", async ({
  page,
}, info) => {
  const verdict = await openerDeLaFenetreOuverte(page, SHELL_ORIGIN, "#ouvrir-ailleurs");
  await info.attach(`coop-${info.project.name}.json`, {
    body: JSON.stringify(verdict, null, 2),
    contentType: "application/json",
  });
  expect(verdict.origine, "la fenêtre ouverte est bien sur l'AUTRE origine").toBe(APP_ORIGIN);
  expect(verdict.opener, "COOP coupe la relation d'ouverture inter-origine").toBe("nul");
});

test("témoin POSITIF de la sonde : deux documents de la MÊME origine restent liés", async ({
  page,
}) => {
  // `Cross-Origin-Opener-Policy: same-origin` COMPARE deux documents avant de couper : deux
  // documents de la même origine portant la même politique restent liés, et c'est ce que la
  // directive dit. Ce relevé n'est donc pas un défaut — c'est ce qui montre que la sonde SAIT lire
  // un opener quand il y en a un. Sans lui, « opener nul » pourrait n'être qu'une lecture cassée.
  const verdict = await openerDeLaFenetreOuverte(page, SHELL_ORIGIN, "#ouvrir-ici");
  expect(verdict.origine).toBe(SHELL_ORIGIN);
  expect(verdict.opener).toBe("present");
});

test("témoin NÉGATIF : sans COOP, la MÊME fenêtre inter-origine garde son opener", async ({
  page,
}) => {
  // La variable est l'EN-TÊTE, et rien d'autre : même document, même geste, même moteur, même forme
  // de fenêtre — inter-origine des deux côtés —, servi cette fois par le rôle `app`, qui ne reçoit
  // pas COOP (décision par rôle de l'ADR 0022, reprise par l'ADR 0030).
  const verdict = await openerDeLaFenetreOuverte(page, APP_ORIGIN, "#ouvrir-ailleurs");
  expect(verdict.origine).toBe(ORIGINE_APPLICATIVE_B);
  expect(verdict.opener, "la fouille sait trouver un opener quand il y en a un").toBe("present");
});
