// Les OUTILS communs aux épreuves d'apparence du parcours (#194 ; revue de la PR #216).
//
// Une vérification d'écran = axe (règles A et AA jusqu'à WCAG 2.2), aucun débordement horizontal, puis
// une capture pleine page, pointeur écarté. La SOBRIÉTÉ d'un contexte = aucune requête hors des
// origines servies ET aucune violation de CSP relevée dans aucun de ses documents (constat 8) : une
// requête refusée par la politique n'arrive jamais au réseau, et l'écouteur `request` seul ne la voit
// pas.

import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";

import { expect, test as base } from "../support/test.mjs";

export { expect };

export const RACINE = "reports/apparence";
export const PHRASE = "une phrase publique pour les captures du parcours utilitaire";

/** Les deux origines de la suite : la coquille et son territoire applicatif. */
export const ORIGINE_A = "http://127.0.0.1:4205";
export const ORIGINES_SERVIES = Object.freeze([ORIGINE_A, "http://localhost:4206"]);

/**
 * Résultats `incomplete` d'axe 4.14 qui valent échec, par règle (journal des changements de 4.14.0, #290) :
 * - `scrollable-region-focusable` : une région défilante dont le contenu n'est focalisable que par
 *   programme (`tabindex="-1"`), dequelabs/axe-core#5364 ; toute son `incomplete` est ce cas ;
 * - `color-contrast`, `messageKey` `emptyValue` seulement : un champ de saisie VIDE dont le contraste
 *   échouerait une fois une valeur saisie, dequelabs/axe-core#5359. La `messageKey` `bgImage` (texte sur
 *   fond image) reste un `incomplete` sans échec : la rendre bloquante ferait tomber les vraies pages.
 */
export const INCOMPLETS_BLOQUANTS = Object.freeze([
  Object.freeze({ regle: "scrollable-region-focusable" }),
  Object.freeze({ regle: "color-contrast", messageKey: "emptyValue" }),
]);

/** Les noeuds `incomplete` qui valent échec, groupés par règle. Un nœud vaut échec si une de ses vérifications porte la `messageKey` visée. */
export function incompletesBloquants(incomplete) {
  return incomplete.flatMap((regle) => {
    const specs = INCOMPLETS_BLOQUANTS.filter((spec) => spec.regle === regle.id);
    const noeuds = regle.nodes.filter((noeud) =>
      specs.some(
        (spec) =>
          !spec.messageKey ||
          [...noeud.any, ...noeud.all, ...noeud.none].some(
            (verification) => verification.data?.messageKey === spec.messageKey,
          ),
      ),
    );
    return noeuds.length > 0 ? [{ ...regle, nodes: noeuds }] : [];
  });
}

export const titre = (page, nom) => page.getByRole("heading", { level: 2, name: nom, exact: true });
export const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });

export function contraste(a, b) {
  const luminance = (rgb) => {
    const composantes = rgb
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return composantes[0] * 0.2126 + composantes[1] * 0.7152 + composantes[2] * 0.0722;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export async function verifier(page, testInfo, nom) {
  const resultats = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  await mkdir(RACINE, { recursive: true });
  const prefixe = `${testInfo.project.name}-${testInfo.title.replaceAll(/[^a-z0-9-]/gi, "-")}-${nom}`;
  await writeFile(
    `${RACINE}/${prefixe}-axe.json`,
    JSON.stringify({ violations: resultats.violations, incomplete: resultats.incomplete }, null, 2),
  );
  expect(
    [...resultats.violations, ...incompletesBloquants(resultats.incomplete)],
    `accessibilité : ${nom}`,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
  // Le pointeur du dernier clic laisserait un bouton en survol dans la capture (constat 13).
  await page.mouse.move(0, 0);
  await capturer(page, { path: `${RACINE}/${prefixe}.png`, fullPage: true });
}

/**
 * Une capture, marquée comme geste du HARNAIS. WebKit insère une feuille `<style>` dans la page pour
 * prendre une capture (mesuré : ni la navigation, ni un clic, ni Tab n'en produisent ; une capture en
 * produit une, même avec `caret: "initial"`), et la CSP de la coquille la refuse à bon droit. Cette
 * violation-là est comptée à part ; toute autre reste une violation.
 */
export async function capturer(page, options) {
  await page.evaluate(() => {
    globalThis.__captureDuHarnais = true;
  });
  try {
    await page.screenshot(options);
  } finally {
    await page.evaluate(() => {
      globalThis.__captureDuHarnais = false;
    });
  }
}

/** Vérifie un écran à chacune des largeurs données, en finissant sur la dernière. */
export async function verifierAux(page, testInfo, nom, largeurs) {
  for (const largeur of largeurs) {
    await page.setViewportSize({ width: largeur, height: 900 });
    await verifier(page, testInfo, `${nom}-${largeur}`);
  }
}

export async function ouvrir(page) {
  await page.goto(`${ORIGINE_A}/index.html`);
  await expect(titre(page, "Créer votre coffre")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#parcours-attente-annoncee")).not.toHaveText(/calibration/, {
    timeout: 60_000,
  });
}

/**
 * Pose les deux écouteurs de sobriété sur un contexte, AVANT sa première page. La violation de CSP
 * est remontée par une liaison du contexte, qui survit aux rechargements (le verrouillage recharge
 * la coquille) et vaut pour chaque document, cadres compris.
 */
export async function surveiller(contexte) {
  const releve = { requetes: [], violations: [], feuillesDeCapture: 0 };
  contexte.on("request", (requete) => releve.requetes.push(requete.url()));
  await contexte.exposeBinding("__signalerViolationCsp", (source, texte, deCapture) => {
    if (deCapture) releve.feuillesDeCapture += 1;
    else releve.violations.push(`${source.frame.url()} : ${texte}`);
  });
  await contexte.addInitScript(() => {
    globalThis.addEventListener("securitypolicyviolation", (evenement) => {
      const deCapture =
        globalThis.__captureDuHarnais === true &&
        evenement.effectiveDirective === "style-src-elem" &&
        evenement.blockedURI === "inline";
      globalThis.__signalerViolationCsp?.(
        `${evenement.effectiveDirective} ${evenement.blockedURI}`,
        deCapture,
      );
    });
  });
  return releve;
}

/** Lu à la FIN de chaque scénario, pour chaque contexte qu'il a créé. */
export function exigerLaSobriete(releve) {
  const etrangeres = releve.requetes.filter(
    (url) => !ORIGINES_SERVIES.includes(new URL(url).origin),
  );
  expect(etrangeres, "aucune requête hors des origines servies").toEqual([]);
  expect(releve.violations, "aucune violation de CSP").toEqual([]);
}

/**
 * Aucun `group` sans nom dans la région de l'étape (constat 7) : un lecteur d'écran y annoncerait
 * « groupe » sans rien dire de plus.
 */
export async function aucunGroupeSansNom(page, moment) {
  const arbre = await page.locator("#parcours").ariaSnapshot();
  expect(arbre, `groupe sans nom dans la région de l'étape : ${moment}`).not.toMatch(
    /^\s*- group\s*(:|$)/m,
  );
}

/**
 * SIMULE une ligne d'état du cycle, publiée d'ordinaire par le module du cycle de vie. C'est la
 * seule entrée du branchement du parcours pour « Rails prêt » ou « démarrage en cours » : aucune
 * machine virtuelle ne tourne dans cette suite. La preuve réelle de l'étape 4 prête reste l'E2E
 * clavier (`tests/e2e/parcours-clavier.spec.mjs`).
 */
export async function simulerLigneDuCycle(page, ligne) {
  await page.locator("#cycle-etat").evaluate((noeud, texte) => {
    noeud.textContent = texte;
  }, ligne);
}

/**
 * Le `test` des épreuves d'apparence : la sobriété du contexte de la page est relevée pour CHAQUE
 * scénario et exigée à sa fin. Un contexte créé en cours de scénario est surveillé à part.
 */
export const test = base.extend({
  sobriete: [
    async ({ context }, use) => {
      const releve = await surveiller(context);
      await use(releve);
      exigerLaSobriete(releve);
    },
    { auto: true },
  ],
});

export const FORME_DU_CODE = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/;
export const LONG = { timeout: 180_000 };

/** Étapes 1 à 3 jusqu'à la feuille affichée ; rend le code et le numéro de feuille. */
export async function afficherLeCode(page) {
  await ouvrir(page);
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: 60_000 });
  await expect(page.locator("#feuille-code")).toHaveText(FORME_DU_CODE);
  const code = (await page.locator("#feuille-code").textContent()).trim();
  const consigne = await page.locator("#parcours-consigne-feuille").textContent();
  return { code, version: /: (\d+)\./.exec(consigne)[1] };
}

/**
 * VERROUILLE et attend le NOUVEAU document : le verrouillage recharge la coquille, mais l'ancien
 * document voit le coffre verrouillé un instant avant — et y montre déjà l'écran d'après. Attendre un
 * titre ou un champ laissait l'épreuve agir dans un document condamné (#239, Firefox en CI).
 */
export async function verrouillerEtRecharger(page) {
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
}

/** La feuille s'éprouve en verrouillant, puis en rouvrant par son code (#239). */
export async function eprouverLaFeuille(page, code) {
  await bouton(page, "J'ai recopié mon code").click();
  await verrouillerEtRecharger(page);
  const champ = page.getByLabel("Code de récupération", { exact: true });
  await expect(champ).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState("load");
  await champ.fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(titre(page, "Travailler dans l'application")).toBeVisible({ timeout: 60_000 });
}

export async function jusquAuTravail(page) {
  const feuille = await afficherLeCode(page);
  await eprouverLaFeuille(page, feuille.code);
  return feuille;
}

/**
 * Compte, dans le document de la coquille, les messages de révocation d'urgence envoyés au Worker de
 * confiance (#265). À poser AVANT la première navigation : le script revit à chaque chargement. Le
 * compte est celui de l'APPEL — ce que la personne a déclenché —, pas celui de ses effets.
 */
export async function compterLesRevocations(page) {
  await page.addInitScript(() => {
    globalThis.__revocationsEnvoyees = 0;
    const envoyer = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...reste) {
      if (typeof message?.type === "string" && message.type.endsWith("revoquer-en-urgence")) {
        globalThis.__revocationsEnvoyees += 1;
      }
      return envoyer.call(this, message, ...reste);
    };
  });
  return () => page.evaluate(() => globalThis.__revocationsEnvoyees ?? 0);
}

/** Des étapes 1 à 8, par le CODE, jusqu'à l'étape 9 « Révoquer en urgence » (coquille réelle, sans VM). */
export async function jusquALEtape9(page) {
  const { code, version } = await jusquAuTravail(page);
  await bouton(page, "Continuer : Verrouiller et rouvrir").click();
  await verrouillerEtRecharger(page);
  await expect(titre(page, "Rouvrir votre coffre")).toBeVisible(LONG);
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Ouvrir mon coffre").click();
  await expect(titre(page, "Sauvegarder votre coffre")).toBeVisible(LONG);
  await bouton(page, "Continuer : Restaurer sur un autre appareil").click();
  await bouton(page, "Continuer : Récupérer votre coffre avec le code").click();
  await verrouillerEtRecharger(page);
  await page
    .getByLabel("Numéro de feuille noté sur votre feuille (facultatif)", { exact: true })
    .fill(version);
  await page.getByLabel("Code de récupération", { exact: true }).fill(code);
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(titre(page, "Révoquer en urgence")).toBeVisible(LONG);
}
