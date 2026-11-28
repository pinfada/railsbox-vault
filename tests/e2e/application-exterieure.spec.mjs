// Une application Rails EXTÉRIEURE, NON MODIFIÉE, démarre dans un coffre (#351).
//
// Toutes les autres épreuves de ce dossier tournent sur `apps/reference`, qui connaît Vault : elle
// porte `/vault/health`, `/vault/invariant` et une clé de signature dérivée. Celle-ci tourne sur une
// application que `rails new` a écrite et que personne n'a touchée depuis
// (`tests/fixtures/application-rails-new/`) :
//
//  - ses fichiers texte sont versionnés en CRLF, comme un clone Windows (`core.autocrlf=true`) ;
//  - son `Gemfile.lock` ne connaît que `x86_64-linux` ;
//  - elle porte `config/credentials.yml.enc` sans `config/master.key` ;
//  - elle n'a aucune migration, aucune route `/vault/…`, aucun `secret_key_base` en production.
//
// ## Ce qu'elle prouve
//
//  1. le paquet FABRIQUÉ depuis cette source est celui que l'origine sert (préalable vérifié) ;
//  2. la coquille l'installe et le démarre sous Chromium, sur le chemin de produit ;
//  3. Rails RÉPOND : la requête du relevé obtient la page 404 de Rails, et le cadre affiche la page
//     que Rails rend pour `/`.
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
// réel), puis le dépôt tel qu'un clone Windows le donne : fichiers suivis seulement (`master.key` est
// ignoré par le `.gitignore` de `rails new`), textes en CRLF, binaires intacts. `.gitattributes` la
// marque `-text` : git n'en normalise aucun octet.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { E2E_ORIGIN_COQUILLE } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const FIXTURE = join(RACINE, "tests", "fixtures", "application-rails-new");
/** L'identité que le lot donne au paquet, par la ligne de commande : la source n'en déclare aucune. */
const ID_DU_PAQUET = "rails-new";
const PHRASE = "une phrase de scenario assez longue pour la calibration";
const BUDGET_DEMARRAGE_MS = 600_000;
const BUDGET_GESTE_MS = 120_000;

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

test("#351 : une application `rails new` non modifiée, en CRLF, démarre dans un coffre et répond", async ({
  context,
}) => {
  exigerLesPrealables(raison, "application-exterieure.spec.mjs");
  test.setTimeout(1_200_000);

  // --- 0. La source est bien celle qu'on dit : CRLF, verrou x86_64-linux seul, aucune clé ----------
  expect(readFileSync(join(FIXTURE, "bin", "rails"), "utf8")).toMatch(
    /^#!\/usr\/bin\/env ruby\r\n/,
  );
  expect(readFileSync(join(FIXTURE, "Gemfile.lock"), "utf8")).toMatch(
    /\r\nPLATFORMS\r\n {2}x86_64-linux\r\n\r\n/,
  );
  expect(existsSync(join(FIXTURE, "config", "credentials.yml.enc"))).toBe(true);
  expect(existsSync(join(FIXTURE, "config", "master.key"))).toBe(false);

  // --- 1. La coquille, le coffre ------------------------------------------------------------------
  const page = await context.newPage();
  const erreurs = [];
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

  // --- 2. Le démarrage : installation, boot, sonde ------------------------------------------------
  await page.click("#demarrer-application");
  // Un démarrage refusé doit se lire AVEC sa cause, pas après dix minutes d'attente.
  await expect(page.locator("#cycle-etat")).toHaveText(
    /^cycle:(application-demarree|demarrage-refuse)/,
    { timeout: BUDGET_DEMARRAGE_MS },
  );
  const application = (await releve(page)).application;
  expect(
    application.demarree,
    `démarrage refusé : ${application.code} — ${application.motif ?? "sans motif"}`,
  ).toBe(true);
  expect(application.bootMs, "Rails a booté").toBeGreaterThan(0);

  // --- 3. Rails RÉPOND ---------------------------------------------------------------------------
  // La requête du relevé (`/vault/invariant`) n'existe pas dans cette application : c'est RAILS qui
  // rend 404, et le compte rendu le publie. Aucune route de l'application n'a été ajoutée.
  expect(application.invariantStatut).toBe(404);
  // Le cadre affiche ce que Rails rend pour `/` : une application `rails new` n'a pas de racine, et
  // Rails sert sa propre page 404, par le relais du Worker de confiance.
  const servie = page.frameLocator("#document-applicatif").frameLocator("#application-servie");
  await expect(servie.locator("body")).toContainText("doesn't exist", {
    timeout: BUDGET_GESTE_MS,
  });

  expect(erreurs, "aucune erreur de page").toEqual([]);
});
