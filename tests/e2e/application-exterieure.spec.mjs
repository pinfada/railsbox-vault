// Une application Rails EXTÉRIEURE, NON MODIFIÉE, démarre dans un coffre et GARDE ses données (#351).
//
// Toutes les autres épreuves de ce dossier tournent sur `apps/reference`, qui connaît Vault : elle
// porte `/vault/health`, `/vault/invariant`, une clé de signature dérivée, ses bases sous `var/` et
// `synchronous = EXTRA` dans son `database.yml`. Celle-ci tourne sur une application ORDINAIRE, que
// les générateurs de Rails ont écrite et que personne n'a touchée depuis
// (`tests/fixtures/application-rails-new/`) :
//
//  - ses fichiers texte sont versionnés en CRLF, comme un clone Windows (`core.autocrlf=true`) ;
//  - son `Gemfile.lock` ne connaît que `x86_64-linux` ;
//  - elle porte `config/credentials.yml.enc` sans `config/master.key` ;
//  - son `db/schema.rb` écrit sa version à soulignés ;
//  - ses bases SQLite sont celles de `rails new`, sous `storage/`, sans pragma ;
//  - elle n'a aucune route `/vault/…` ni aucun `secret_key_base` en production.
//
// ## Ce qu'elle prouve
//
//  1. le paquet FABRIQUÉ depuis cette source est celui que l'origine sert (préalable vérifié) ;
//  2. la coquille l'installe et le démarre sous Chromium, sur le chemin de produit ;
//  3. Rails RÉPOND : 404 de Rails sur le relevé, et sa page 404 dans le cadre pour `/` ;
//  4. une ÉCRITURE ordinaire — le formulaire du scaffold, soumis dans le cadre — survit au
//     verrouillage, à l'instantané ÉCARTÉ et au boot à froid : la note est relue.
//
// ## Comment le paquet est fabriqué
//
// L'épreuve ne fabrique pas le paquet elle-même : la fabrication REMPLACE le paquet servi, et les
// autres épreuves de ce dossier exigent la référence. Elle a donc son lot (`reprise.yml`, lot 6), qui
// la fabrique d'abord :
//
//     npm run app:paquet -- --retirer-precedent
//     npm run app:paquet -- --source tests/fixtures/application-rails-new --id rails-new --version 1.0.0
//     npm run image:manifest
//
// Pour revenir à la référence ensuite : `npm run image:build`.
//
// ## Comment la fixture a été écrite
//
// `rails new application-rails-new` (Rails 8.1.4.1, Ruby 3.3.12, `linux/amd64`), puis
// `bundle lock --remove-platform` de toutes les plateformes sauf `x86_64-linux` (le verrou de l'essai
// réel), puis `bin/rails generate scaffold Note body:text` et `bin/rails db:migrate` en développement,
// qui écrit `db/schema.rb` — l'application ORDINAIRE : `rails new` seul n'a rien qui écrive. Enfin le
// dépôt tel qu'un clone Windows le donne : fichiers suivis seulement (`master.key` et les bases de
// développement sont ignorés par le `.gitignore` de `rails new`), textes en CRLF, binaires intacts.
// `.gitattributes` la marque `-text` : git n'en normalise aucun octet.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE } from "../../playwright.e2e.config.mjs";
import { INSTANTANE_SIDECAR_SUFFIX } from "../../src/vm/opfs-sync-access.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const FIXTURE = join(RACINE, "tests", "fixtures", "application-rails-new");
/** L'identité que le lot donne au paquet, par la ligne de commande : la source n'en déclare aucune. */
const ID_DU_PAQUET = "rails-new";
const PHRASE = "une phrase de scenario assez longue pour la calibration";
const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_GESTE_MS = 120_000;
/** Ce que la personne écrit dans le formulaire du scaffold : la MUTATION que le boot à froid relit. */
const NOTE = `note ecrite avant le boot a froid ${Date.now()}`;

const FABRIQUER =
  "« npm run app:paquet -- --retirer-precedent », « npm run app:paquet -- --source " +
  `tests/fixtures/application-rails-new --id ${ID_DU_PAQUET} --version 1.0.0 », puis ` +
  "« npm run image:manifest »";

function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : ${FABRIQUER}`;
  }
  const descripteur = JSON.parse(readFileSync(CHEMIN_DESCRIPTEUR, "utf8"));
  if (descripteur.application?.id !== ID_DU_PAQUET) {
    return `l'origine sert « ${descripteur.application?.id} », pas l'application rails new : ${FABRIQUER}`;
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Ouvre la coquille et le coffre par la phrase, et rend la page. */
async function ouvrirLeCoffre(context, erreurs) {
  const page = await context.newPage();
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 60_000,
  });
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: BUDGET_GESTE_MS })
    .toBe("ouvert");
  return page;
}

/** Démarre l'application, et exige qu'elle ait démarré — sa cause en clair sinon. */
async function demarrer(page) {
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText(
    /^cycle:(application-demarree|demarrage-refuse)/,
    { timeout: BUDGET_DEMARRAGE_MS },
  );
  const application = (await releve(page)).application;
  expect(
    application.demarree,
    `démarrage refusé : ${application.code} — ${application.motif ?? "sans motif"}`,
  ).toBe(true);
  return application;
}

/** Le cadre imbriqué où vit ce que Rails rend. */
function pageServie(page) {
  return page.frameLocator("#document-applicatif").frameLocator("#application-servie");
}

/**
 * Fait naviguer le cadre servi vers un chemin de l'application, comme un lien le ferait. La
 * navigation part APRÈS le retour de l'évaluation : partie pendant, elle détruit le contexte que
 * Playwright attend encore (« Execution context was destroyed »).
 */
async function allerA(page, chemin) {
  await pageServie(page)
    .locator("body")
    .evaluate((corps, vers) => {
      const fenetre = corps.ownerDocument.defaultView;
      fenetre.setTimeout(() => fenetre.location.assign(vers), 0);
    }, chemin);
}

/** RETIRE les instantanés de l'OPFS : la reprise suivante est un boot à FROID, par construction. */
async function ecarterLesInstantanes(page) {
  return page.evaluate(async (suffixe) => {
    const retires = [];
    const parcourir = async (repertoire) => {
      for await (const [nom, poignee] of repertoire.entries()) {
        if (poignee.kind === "directory") await parcourir(poignee);
        else if (nom.endsWith(suffixe)) {
          await repertoire.removeEntry(nom);
          retires.push(nom);
        }
      }
    };
    await parcourir(await navigator.storage.getDirectory());
    return retires;
  }, INSTANTANE_SIDECAR_SUFFIX);
}

test("#351 : une application Rails ordinaire, non modifiée, en CRLF, démarre, écrit, et relit après un boot à froid", async ({
  context,
}) => {
  exigerLesPrealables(raison, "application-exterieure.spec.mjs");
  test.setTimeout(1_500_000);

  // --- 0. La source est bien celle qu'on dit : CRLF, verrou x86_64-linux seul, aucune clé ----------
  expect(readFileSync(join(FIXTURE, "bin", "rails"), "utf8")).toMatch(
    /^#!\/usr\/bin\/env ruby\r\n/,
  );
  expect(readFileSync(join(FIXTURE, "Gemfile.lock"), "utf8")).toMatch(
    /\r\nPLATFORMS\r\n {2}x86_64-linux\r\n\r\n/,
  );
  expect(existsSync(join(FIXTURE, "config", "credentials.yml.enc"))).toBe(true);
  expect(existsSync(join(FIXTURE, "config", "master.key"))).toBe(false);
  expect(readFileSync(join(FIXTURE, "config", "database.yml"), "utf8")).toMatch(
    /database: storage\/production\.sqlite3/,
  );

  // --- 1. Le coffre, l'installation, le démarrage --------------------------------------------------
  const erreurs = [];
  let page = await ouvrirLeCoffre(context, erreurs);
  const premier = await demarrer(page);
  expect(premier.bootMs, "Rails a booté").toBeGreaterThan(0);

  // --- 2. Rails RÉPOND -----------------------------------------------------------------------------
  // La requête du relevé (`/vault/invariant`) n'existe pas dans cette application : c'est RAILS qui
  // rend 404, et le compte rendu le publie. Le cadre affiche ce que Rails rend pour `/`, sa page 404.
  expect(premier.invariantStatut).toBe(404);
  await expect(pageServie(page).locator("body")).toContainText("doesn't exist", {
    timeout: BUDGET_GESTE_MS,
  });

  // --- 3. Une ÉCRITURE ordinaire : le formulaire du scaffold, soumis dans le cadre -------------------
  await allerA(page, "/notes/new");
  await pageServie(page).locator("#note_body").fill(NOTE, { timeout: BUDGET_GESTE_MS });
  await pageServie(page).locator("input[type=submit]").click();
  await expect(pageServie(page).locator("body")).toContainText("Note was successfully created", {
    timeout: BUDGET_GESTE_MS,
  });
  await expect(pageServie(page).locator("body")).toContainText(NOTE);

  // --- 4. Le VERROUILLAGE, puis l'instantané ÉCARTÉ --------------------------------------------------
  const recharge = page.waitForEvent("load", { timeout: BUDGET_GESTE_MS });
  await page.click("#verrouiller-le-coffre");
  await recharge;
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 60_000,
  });
  expect((await releve(page)).etat).toBe("verrouille");
  await page.close();
  page = await context.newPage();
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html?vue=complete`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 60_000,
  });
  const retires = await ecarterLesInstantanes(page);
  expect(retires.length, "un instantané avait été laissé par le verrouillage").toBeGreaterThan(0);
  await page.close();

  // --- 5. Le BOOT À FROID : la note est RELUE --------------------------------------------------------
  page = await ouvrirLeCoffre(context, erreurs);
  const second = await demarrer(page);
  expect(second.installation.installee, "le disque applicatif n'est pas réinstallé").toBe(false);
  expect(second.instantaneUtilise, "la reprise est un boot à FROID").toBe(false);
  await allerA(page, "/notes");
  await expect(
    pageServie(page).locator("body"),
    "la note écrite par l'application n'a pas survécu au boot à froid",
  ).toContainText(NOTE, { timeout: BUDGET_GESTE_MS });

  expect(erreurs, "aucune erreur de page").toEqual([]);
});
