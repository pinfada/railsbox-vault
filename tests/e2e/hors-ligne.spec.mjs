// LA PREUVE du DÉMARRAGE HORS CONNEXION sur l'ARBRE PUBLIÉ (#247, lot D1g ; #299, lot D1h-b ; ADR 0046,
// ADR 0048) : un coffre déjà démarré une fois, origine ARRÊTÉE, s'ouvre, se déverrouille et démarre depuis
// la réserve du Service Worker de la coquille et le magasin OPFS, **sous les en-têtes de production, sans
// harnais**.
//
// Ce que ce fichier ne fait PAS : il ne passe plus par `tools/serve.mjs` (serveur du dépôt vivant, en-têtes
// calculés à la volée). Il PUBLIE l'arbre (`tools/publier.mjs`), puis démarre lui-même ses deux origines
// (`tools/publier-servir.mjs`, qui applique le `_headers` produit) — c'est ce qui lui permet d'ARRÊTER une
// origine pour de vrai (jamais `setOffline` : Firefox et WebKit ne le tiennent pas avec un Service Worker,
// ADR 0048 § 14), de la faire mentir, et de COMPTER ce qu'elle reçoit.
//
// Premier test, dans l'ordre :
//  (a) première visite EN LIGNE → installation du SW → navigation → déverrouillage → boot Rails → page rendue ;
//  (b) origine ARRÊTÉE → NOUVELLE navigation → déverrouillage → boot depuis la réserve ;
//  (c) descripteur rangé ALTÉRÉ, origine arrêtée : refus typé, aucun boot ;
//  (d) le démarrage en ligne suivant le remplace ;
//  (e) l'origine RÉPOND mal (500, portail captif) : pas de repli.
// Second test : les refus du portail, chacun avec son code typé et ZÉRO requête de boot.
//
// Ce que ce fichier ne prouve PAS : Firefox et WebKit (boot Rails non prouvé sous Firefox, OPFS absent du
// build WebKit de Playwright : `tests/browser/reserve-*.spec.mjs` porte ce qui ne dépend pas du guest) ;
// l'éviction réelle, Safari réel, l'hébergeur réel (ADR 0048 § 14).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import {
  E2E_HOST,
  E2E_HOST_B,
  E2E_ORIGIN_PUBLIEE,
  E2E_ORIGIN_PUBLIEE_APP,
  E2E_PUBLIE_APP_PORT,
  E2E_PUBLIE_PORT,
} from "../../playwright.e2e.config.mjs";
import { demarrer } from "../../tools/publier-servir.mjs";
import { fabriquerLeScriptDeRetrait } from "../../tools/publier-reserve.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const SORTIE_PUBLICATION = join(RACINE, "artifacts", "publication-e2e");

const PHRASE = "une phrase de reseau coupe assez longue pour la calibration argon";
const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_DEVERROUILLAGE_MS = 120_000;
const BUDGET_REFUS_MS = 60_000;

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:manifest »`;
  }
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  if (descripteur.boot?.empreintes === undefined) {
    return "le descripteur ne porte pas `boot.empreintes` (noyau, initrd, BIOS) : « npm run image:manifest »";
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

const releve = async (page) => JSON.parse(await page.locator("#coquille-rapport").textContent());

async function ouvrirLaCoquille(contexte, erreurs) {
  const page = await contexte.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${E2E_ORIGIN_PUBLIEE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60_000 });
  return page;
}

async function attendreLEtat(page, etat, budget) {
  await expect.poll(async () => (await releve(page)).etat, { timeout: budget }).toBe(etat);
}

async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await attendreLEtat(page, "ouvert", BUDGET_DEVERROUILLAGE_MS);
}

/** Attend le verdict d'un démarrage, quel qu'il soit, et rend la ligne d'état. */
async function verdictDuDemarrage(page, budget) {
  await expect(page.locator("#cycle-etat")).toHaveText(
    /^cycle:(application-demarree|demarrage-refuse)/,
    { timeout: budget },
  );
  return page.locator("#cycle-etat").textContent();
}

/** VERROUILLE : la coquille est rechargée — EN LIGNE — et l'on attend le document prêt. */
async function verrouiller(page) {
  const rechargement = page.waitForEvent("load", { timeout: 300_000 });
  await page.click("#verrouiller-le-coffre");
  await rechargement;
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 120_000,
  });
  await attendreLEtat(page, "verrouille", 60_000);
}

/** Le descripteur rangé, tel que l'OPFS de l'origine de confiance le garde : ses octets, ou `null`. */
const lireLeRange = (page) =>
  page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    try {
      const dossier = await racine.getDirectoryHandle("vault-artefacts");
      const fichier = await (await dossier.getFileHandle("descripteur.scelle")).getFile();
      return Array.from(new Uint8Array(await fichier.arrayBuffer()));
    } catch {
      return null;
    }
  });

/** ALTÈRE un octet du descripteur rangé — ce que ferait quelqu'un qui écrit dans l'OPFS sans la clé. */
const alterer = (page) =>
  page.evaluate(async () => {
    const racine = await navigator.storage.getDirectory();
    const dossier = await racine.getDirectoryHandle("vault-artefacts");
    const poignee = await dossier.getFileHandle("descripteur.scelle");
    const octets = new Uint8Array(await (await poignee.getFile()).arrayBuffer());
    octets[Math.floor(octets.byteLength / 2)] ^= 0x01;
    const flux = await poignee.createWritable();
    await flux.write(octets);
    await flux.close();
  });

/** Un démarrage qui doit être REFUSÉ, sans boot, avec ce code. */
async function exigerLeRefusAuDemarrage(page, code) {
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_REFUS_MS)).toBe(`cycle:demarrage-refuse:${code}`);
  const application = (await releve(page)).application;
  expect(application.demarree).toBe(false);
  expect(application.bootMs, "aucun boot n'a eu lieu").toBeUndefined();
  expect(application.horsConnexion ?? null, "aucun repli hors connexion").toBeNull();
}

// --- Les origines : publiées, servies sous les en-têtes de production, ARRÊTABLES ---------------------

/** Une surcharge par chemin : `null` = l'origine répond normalement. Posée par l'épreuve, jamais en production. */
let imposee = () => null;
let coquille = null;
let application = null;
/** Toutes les requêtes reçues par la coquille depuis le début du cas, origines redémarrées comprises. */
const journaux = [];

function publier() {
  execFileSync(
    process.execPath,
    [
      "tools/publier.mjs",
      "--sortie",
      SORTIE_PUBLICATION,
      "--origine-coquille",
      E2E_ORIGIN_PUBLIEE,
      "--origine-application",
      E2E_ORIGIN_PUBLIEE_APP,
      "--sequence",
      "1",
    ],
    { cwd: RACINE, stdio: "pipe" },
  );
}

async function demarrerLesOrigines() {
  coquille = await demarrer({
    arbre: join(SORTIE_PUBLICATION, "coquille"),
    host: E2E_HOST,
    port: E2E_PUBLIE_PORT,
    retires: [],
    artefacts: join(RACINE, "artifacts"),
    surcharge: (chemin) => imposee(chemin),
  });
  journaux.push(coquille.journal);
  application = await demarrer({
    arbre: join(SORTIE_PUBLICATION, "application"),
    host: E2E_HOST_B,
    port: E2E_PUBLIE_APP_PORT,
    retires: [],
  });
}
/** « Réseau coupé » : les DEUX origines s'arrêtent pour de vrai (les ports refusent). */
async function couperLeReseau() {
  await Promise.all([coquille?.arreter(), application?.arreter()]);
  coquille = null;
  application = null;
}

const estUneRequeteDeBoot = ({ chemin }) =>
  chemin.startsWith("/artifacts/reference-image/") ||
  /^\/vendor\/v86\/artefacts\/.*\.(wasm|bin)$/.test(chemin);

test.beforeEach(() => {
  imposee = () => null;
  journaux.length = 0;
  if (raison === null) publier();
});
test.afterEach(async () => {
  await couperLeReseau();
});

test("un coffre déjà démarré redémarre ORIGINE ARRÊTÉE, depuis la réserve ; un descripteur altéré ou une origine qui répond mal n'ouvrent aucun repli (arbre publié, sans harnais)", async ({
  context,
  chronologie,
}) => {
  exigerLesPrealables(raison, "hors-ligne.spec.mjs");
  test.setTimeout(4_800_000);
  const erreurs = [];
  const noter = (etape, detail = {}) => chronologie.etape(etape, detail);
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  await demarrerLesOrigines();

  // --- (a) EN LIGNE, première visite : installation du SW, navigation, déverrouillage, boot, page -------
  let page = await ouvrirLaCoquille(context, erreurs);
  const reserve = (await releve(page)).reserve;
  expect(reserve.refus, "la réserve est installée et le portail a ouvert").toBeNull();
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    "la page est contrôlée par le SW de la coquille",
  ).toBe(`${E2E_ORIGIN_PUBLIEE}/sw-coquille.mjs`);
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  const premier = (await releve(page)).application;
  expect(premier.horsConnexion ?? null, "en ligne, aucune mention hors connexion").toBeNull();
  await expect(page.locator("#parcours-reussite")).not.toContainText(/hors connexion/i);
  // Le rangement suit le verdict de quelques instants (écriture OPFS après l'acquisition complète) : on le lit
  // quand il est là, borné.
  await expect
    .poll(() => lireLeRange(page), {
      message: "le descripteur scellé est rangé après l'acquisition complète",
      timeout: 30_000,
    })
    .not.toBeNull();
  const range = await lireLeRange(page);
  expect(String.fromCharCode(...range.slice(0, 8)), "magie du format v1").toBe("VLTDSC01");
  noter("premier-demarrage-en-ligne");

  // --- (b) ORIGINE ARRÊTÉE : NOUVELLE navigation, déverrouillage, boot depuis la réserve ------------------
  await verrouiller(page);
  await page.close();
  await couperLeReseau();
  page = await context.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  const echecs = [];
  page.on("requestfailed", (requete) => echecs.push(new URL(requete.url()).pathname));
  await page.goto(`${E2E_ORIGIN_PUBLIEE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60_000 });
  const horsLigneReserve = (await releve(page)).reserve;
  expect(horsLigneReserve.refus, "la coquille s'ouvre sans origine").toBeNull();
  expect(horsLigneReserve.fraicheur, "elle dit qu'elle ne sait pas").toBe(
    "version-courante-non-verifiable",
  );
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  const horsLigne = (await releve(page)).application;
  expect(horsLigne.demarree, "l'application répond, origine arrêtée").toBe(true);
  expect(horsLigne.horsConnexion, "la version et la date sont dites").toMatchObject({
    version: descripteur.application.version,
  });
  expect(Number.isInteger(horsLigne.horsConnexion.rangeLe)).toBe(true);
  await expect(page.locator("#parcours-reussite")).toContainText(
    /Hors connexion, version du .+\d{4}/,
  );
  expect(echecs, "le descripteur n'a pas été atteint").toContain("/artifacts/application.json");
  noter("demarrage-hors-ligne", { rangeLe: horsLigne.horsConnexion.rangeLe });

  // --- (c) CONTRE-ÉPREUVE : descripteur rangé ALTÉRÉ, origine arrêtée : refus typé, pas de boot ---------
  await verrouiller(page);
  await ouvrirParLaPhrase(page);
  await alterer(page);
  const altere = await lireLeRange(page);
  await exigerLeRefusAuDemarrage(page, "VAULT_COQUILLE_HORS_LIGNE_DESCRIPTEUR_REFUSE");
  noter("descripteur-altere-refuse");

  // --- (d) Le démarrage EN LIGNE suivant remplace le descripteur refusé par un descripteur sain --------
  await demarrerLesOrigines();
  await verrouiller(page);
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  const refait = await lireLeRange(page);
  expect(String.fromCharCode(...refait.slice(0, 8))).toBe("VLTDSC01");
  expect(refait, "le descripteur altéré a été remplacé").not.toEqual(altere);
  noter("descripteur-refait-en-ligne");

  // --- (e) L'origine RÉPOND mal : 500, puis HTML de portail captif — jamais de repli -------------------
  for (const [nom, reponse] of [
    ["http-500", { statut: 500, corps: "" }],
    [
      "portail-captif",
      {
        statut: 200,
        type: "text/html; charset=utf-8",
        corps: "<html>Connectez-vous au Wi-Fi</html>",
      },
    ],
  ]) {
    await verrouiller(page);
    await ouvrirParLaPhrase(page);
    imposee = (chemin) => (chemin === "/artifacts/application.json" ? reponse : null);
    await exigerLeRefusAuDemarrage(page, "VAULT_COQUILLE_APPLICATION_NON_SERVIE");
    imposee = () => null;
    noter(`origine-${nom}-sans-repli`);
  }
  expect(erreurs, "aucune erreur de page").toEqual([]);
  await page.close();
});

test("la SONDE de comptage des Workers MORD : sans elle, le témoin positif fait ÉCHOUER l'épreuve", async ({
  browserName,
}, testInfo) => {
  void browserName;
  // Un contexte SANS sonde (ou à la sonde cassée) : `verifierLaSonde` doit jeter, jamais rendre le contexte.
  const sans = await contexteNeuf(testInfo, "sans-sonde", { compterLesWorkers: false });
  try {
    await expect(verifierLaSonde(sans)).rejects.toThrow(/ne compte pas/);
  } finally {
    await sans.close();
  }
  const cassee = await contexteNeuf(testInfo, "sonde-cassee", { compterLesWorkers: false });
  try {
    await cassee.addInitScript(() => {
      window.__workers = 0; // une sonde qui reste à zéro : elle ne compte rien
    });
    await expect(verifierLaSonde(cassee)).rejects.toThrow(/ne compte pas/);
  } finally {
    await cassee.close();
  }
  // Et la sonde saine passe : le témoin n'est pas un échec systématique.
  const saine = await contexteNeuf(testInfo, "sonde-saine");
  await saine.close();
});

// --- FERMER puis ROUVRIR le navigateur : profil PERSISTANT, origine arrêtée (critère 1) ------------------

test("PROFIL PERSISTANT : le navigateur est FERMÉ puis rouvert, l'origine ARRÊTÉE ; le coffre se déverrouille et démarre depuis la réserve", async ({
  browserName,
}, testInfo) => {
  void browserName;
  exigerLesPrealables(raison, "hors-ligne.spec.mjs");
  test.setTimeout(2_400_000);
  const erreurs = [];
  await demarrerLesOrigines();

  // Premier navigateur : en ligne, installation du SW, déverrouillage, premier boot (le magasin se remplit).
  const premier = await contexteNeuf(testInfo, "redemarrage", { compterLesWorkers: false });
  let page = await ouvrirLaCoquille(premier, erreurs);
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
  await expect
    .poll(() => lireLeRange(page), { message: "le descripteur est rangé", timeout: 30_000 })
    .not.toBeNull();
  await verrouiller(page);
  // Le navigateur est FERMÉ (le processus meurt, pas seulement la page), et l'origine est ARRÊTÉE.
  await premier.close();
  await couperLeReseau();

  // Second navigateur : MÊME profil, aucune origine. Rien n'est servi que par la réserve et l'OPFS.
  const second = await contexteNeuf(testInfo, "redemarrage", { compterLesWorkers: false });
  try {
    page = await second.newPage();
    page.on("pageerror", (erreur) => erreurs.push(erreur.message));
    await page.goto(`${E2E_ORIGIN_PUBLIEE}/index.html?vue=complete`, { waitUntil: "load" });
    await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
      timeout: 60_000,
    });
    const reserve = (await releve(page)).reserve;
    expect(
      reserve.refus,
      "la coquille s'ouvre sans origine, après un redémarrage du navigateur",
    ).toBeNull();
    expect(reserve.fraicheur).toBe("version-courante-non-verifiable");
    await ouvrirParLaPhrase(page);
    await page.click("#demarrer-application");
    expect(await verdictDuDemarrage(page, BUDGET_DEMARRAGE_MS)).toBe("cycle:application-demarree");
    const application = (await releve(page)).application;
    expect(application.demarree, "l'application répond, origine arrêtée, navigateur rouvert").toBe(
      true,
    );
    expect(application.horsConnexion).not.toBeNull();
    expect(erreurs, "aucune erreur de page").toEqual([]);
  } finally {
    await second.close();
  }
});

// --- Les REFUS du portail : un code typé, ZÉRO requête de boot, aucun canal, aucune clé ----------------

/** Compte les `new Worker` de la page, dès le premier instant : « zéro Worker, zéro clé » se mesure. */
const SONDE_DES_WORKERS = () => {
  window.__workers = 0;
  const Natif = window.Worker;
  window.Worker = class extends Natif {
    constructor(...arguments_) {
      window.__workers += 1;
      super(...arguments_);
    }
  };
};

/**
 * TÉMOIN POSITIF de la sonde : dans une page de ce contexte, un `new Worker` est COMPTÉ. Sans lui, « zéro
 * constructeur appelé » passerait avec une sonde absente, désactivée ou cassée, qui reste à zéro. Il rend le
 * contexte, ou JETTE.
 */
async function verifierLaSonde(contexte) {
  const page = await contexte.newPage();
  try {
    await page.goto("about:blank");
    const compte = await page.evaluate(() => {
      const avant = window.__workers;
      try {
        new Worker("/temoin-de-la-sonde.mjs");
      } catch {
        /* l'adresse n'a pas d'importance : c'est le CONSTRUCTEUR qui est compté */
      }
      return [avant, window.__workers];
    });
    if (compte[0] !== 0 || compte[1] !== 1) {
      throw new Error(`la sonde de comptage des Workers ne compte pas : ${JSON.stringify(compte)}`);
    }
  } finally {
    await page.close();
  }
  return contexte;
}

/**
 * Un profil NEUF par cas : l'isolation entre refus est totale (inscriptions, caches, OPFS).
 *
 * `compterLesWorkers: false` pour les scénarios qui BOOTENT : mesuré, la sonde (une sous-classe de `Worker`)
 * fait mourir le Worker de confiance pendant un vrai boot (`VAULT_COQUILLE_WORKER_MORT`) ; elle ne sert qu'aux
 * refus, où aucun Worker ne doit exister.
 */
async function contexteNeuf(testInfo, nom, { compterLesWorkers = true } = {}) {
  const profil = join(testInfo.outputDir, `profil-${nom}`);
  const contexte = await chromium.launchPersistentContext(profil, {
    headless: testInfo.project.use?.headless ?? true,
  });
  if (compterLesWorkers) {
    await contexte.addInitScript(SONDE_DES_WORKERS);
    await verifierLaSonde(contexte);
  }
  return contexte;
}

async function visiter(contexte, initScript) {
  const page = await contexte.newPage();
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`${E2E_ORIGIN_PUBLIEE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect
    .poll(async () => page.locator("html").getAttribute("data-coquille"), { timeout: 60_000 })
    .toMatch(/^(prete|reserve-refusee)$/);
  return page;
}

async function exigerUnRefusDePortail(page, journal, code, cause) {
  const etat = await releve(page);
  expect(await page.locator("html").getAttribute("data-coquille")).toBe("reserve-refusee");
  expect(etat.reserve.refus).toEqual({ code, cause });
  expect(etat.canalPrivilegie, "aucun canal : aucun Worker, aucune clé").toBe("absent");
  expect(journal.filter(estUneRequeteDeBoot), "zéro requête de boot").toEqual([]);
  // La sonde est active dans CE contexte (témoin positif à la création) : aucun constructeur n'a été appelé.
  expect(await page.evaluate(() => window.__workers), "zéro constructeur de Worker appelé").toBe(0);
}

/** Le texte du SW tel que l'origine le sert, modifié : une faute injectée, jamais la configuration nominale. */
const scriptPublie = () =>
  readFileSync(join(SORTIE_PUBLICATION, "coquille", "sw-coquille.mjs"), "utf8");
const script = (texte) => (chemin) =>
  chemin === "/sw-coquille.mjs"
    ? {
        statut: 200,
        type: "text/javascript; charset=utf-8",
        corps: texte,
        entetes: { "Cache-Control": "no-cache" },
      }
    : null;

const CAS = [
  {
    nom: "entree-alteree",
    code: "VAULT_COQUILLE_RESERVE_ALTEREE",
    cause: "entrees-alterees",
    prepare: async (contexte, page) => {
      await page.evaluate(async () => {
        const nom = (await caches.keys()).find((n) => n.startsWith("reserve-"));
        const cache = await caches.open(nom);
        const cle = new Request(new URL("/battement-du-worker.mjs", location.origin));
        const octets = new Uint8Array(await (await cache.match(cle)).arrayBuffer());
        octets[octets.length - 2] ^= 0xff;
        await cache.put(cle, new Response(octets));
      });
      await couperLeReseau();
    },
  },
  {
    nom: "entree-supprimee",
    code: "VAULT_COQUILLE_RESERVE_INCOMPLETE",
    cause: "entrees-manquantes",
    prepare: async (contexte, page) => {
      await page.evaluate(async () => {
        const nom = (await caches.keys()).find((n) => n.startsWith("reserve-"));
        await (
          await caches.open(nom)
        ).delete(new Request(new URL("/battement-du-worker.mjs", location.origin)));
      });
      await couperLeReseau();
    },
  },
  {
    nom: "api-absente",
    code: "VAULT_COQUILLE_RESERVE_ABSENTE",
    cause: "api-absente",
    initScript: () => {
      delete Navigator.prototype.serviceWorker;
    },
    sansInstallation: true,
  },
  {
    nom: "sw-absent",
    code: "VAULT_COQUILLE_RESERVE_ABSENTE",
    cause: "installation-impossible",
    initScript: () => {
      navigator.serviceWorker.register = () =>
        Promise.reject(new DOMException("refusé", "SecurityError"));
    },
    sansInstallation: true,
  },
  {
    nom: "sw-muet",
    code: "VAULT_COQUILLE_RESERVE_ABSENTE",
    cause: "silence-du-sw",
    sansInstallation: true,
    imposeAvant: () =>
      script(
        scriptPublie().replace(
          'self.addEventListener("message", (evenement) => {',
          'self.addEventListener("message", (evenement) => {\n  return;',
        ),
      ),
  },
  {
    nom: "version-perimee",
    code: "VAULT_COQUILLE_RESERVE_PERIMEE",
    cause: "plancher",
    prepare: async (contexte, page) => {
      imposee = script(scriptPublie().replace('"plancher":0', '"plancher":99'));
      await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistration("/")).update(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(
              async () =>
                (await navigator.serviceWorker.getRegistration("/")).waiting?.state ?? null,
            ),
          { timeout: 30_000 },
        )
        .toBe("installed");
    },
  },
  {
    nom: "retrait",
    code: "VAULT_COQUILLE_RESERVE_PERIMEE",
    cause: "retrait",
    prepare: async (contexte, page) => {
      imposee = script(fabriquerLeScriptDeRetrait());
      await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistration("/")).update(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(
              async () =>
                (await navigator.serviceWorker.getRegistration("/")).waiting?.state ?? null,
            ),
          { timeout: 30_000 },
        )
        .toBe("installed");
    },
  },
  {
    nom: "controleur-change",
    code: "VAULT_COQUILLE_RESERVE_DIVERGENTE",
    cause: "controleur-change",
    // Un SW qui se donnerait `skipWaiting` et `claim` : le contrôleur change PENDANT la session. La page le dit
    // (sans interrompre la session) ; c'est la MÊME page qui porte le refus, il n'y a pas de navigation neuve.
    memePage: true,
    prepare: async (contexte, page) => {
      imposee = script(
        scriptPublie()
          .replace(
            "evenement.waitUntil(installer());",
            "evenement.waitUntil(installer().then(() => self.skipWaiting()));",
          )
          .replace(
            "evenement.waitUntil(CONFIG.retrait ? retirer() : nettoyer());",
            "evenement.waitUntil((CONFIG.retrait ? retirer() : nettoyer()).then(() => self.clients.claim()));",
          ),
      );
      await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistration("/")).update(),
      );
    },
  },
];

for (const cas of CAS) {
  test(`REFUS typé « ${cas.nom} » : ${cas.code} (${cas.cause}), aucun Worker, aucune clé, zéro requête de boot`, async ({
    browserName,
  }, testInfo) => {
    void browserName;
    exigerLesPrealables(raison, "hors-ligne.spec.mjs");
    test.setTimeout(180_000);
    await demarrerLesOrigines();
    const contexte = await contexteNeuf(testInfo, cas.nom);
    try {
      if (cas.imposeAvant) imposee = cas.imposeAvant();
      let page;
      if (cas.sansInstallation) {
        // Pas de SW sain installé : la première visite est celle qui refuse (ou qui installe un SW muet,
        // qu'un rechargement contrôle).
        page = await visiter(contexte, cas.initScript);
        if ((await page.locator("html").getAttribute("data-coquille")) !== "reserve-refusee") {
          await page.reload({ waitUntil: "load" });
          await expect
            .poll(async () => page.locator("html").getAttribute("data-coquille"), {
              timeout: 60_000,
            })
            .toBe("reserve-refusee");
        }
      } else {
        page = await visiter(contexte);
        expect(await page.locator("html").getAttribute("data-coquille")).toBe("prete");
        await cas.prepare(contexte, page);
        if (cas.memePage) {
          await expect
            .poll(async () => (await releve(page)).reserve.refus?.cause ?? null, {
              timeout: 30_000,
            })
            .toBe(cas.cause);
          expect((await releve(page)).reserve.refus.code).toBe(cas.code);
          expect(
            (await releve(page)).canalPrivilegie,
            "la session n'est pas interrompue : le canal reste établi",
          ).toBe("etabli");
          // La sonde est VIVANTE (témoin positif) : le Worker de confiance de cette page a été compté. Sans
          // quoi « zéro nouveau Worker » passerait avec une sonde cassée qui reste à zéro.
          const workersAvant = await page.evaluate(() => window.__workers);
          expect(workersAvant, "le Worker de confiance initial a été compté").toBeGreaterThan(0);
          const requetesAvant = journaux.flat().length;
          // Rien ne naît de l'anomalie : on laisse à la page le temps de faire une bêtise, puis on compte.
          await page.waitForTimeout(3_000);
          expect(await page.evaluate(() => window.__workers), "zéro nouveau Worker").toBe(
            workersAvant,
          );
          expect(
            journaux.flat().slice(requetesAvant).filter(estUneRequeteDeBoot),
            "zéro requête de démarrage",
          ).toEqual([]);
          expect((await releve(page)).reserve.refus).toEqual({ code: cas.code, cause: cas.cause });
          // Le chemin EXISTANT d'une nouvelle ouverture est le rechargement (le verrouillage recharge la
          // coquille) : la page repasse par son portail normal, sans l'anomalie — le drapeau de changement de
          // contrôleur est PAR PAGE. Le contrôleur est alors le même que celui de la page, et le portail ouvre.
          // (« Plus aucun Worker n'est créé » dans une même page par un second portail est éprouvé en unitaire :
          // `reserve-portail.test.mjs`, état partagé entre portails ; aucun second portail n'existe dans une page.)
          await page.reload({ waitUntil: "load" });
          await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
            timeout: 60_000,
          });
          expect(await page.evaluate(() => window.__workers), "un Worker, par le portail").toBe(1);
          return;
        }
        // La page d'avant reste OUVERTE : tant qu'elle l'est, la version en attente n'est pas active (ADR 0048 § 6).
        page = await contexte.newPage();
        await page
          .goto(`${E2E_ORIGIN_PUBLIEE}/index.html?vue=complete`, { waitUntil: "load" })
          .catch(() => {});
        await expect
          .poll(async () => page.locator("html").getAttribute("data-coquille"), { timeout: 60_000 })
          .toBe("reserve-refusee");
      }
      await exigerUnRefusDePortail(page, journaux.flat(), cas.code, cas.cause);
    } finally {
      await contexte.close();
    }
  });
}
