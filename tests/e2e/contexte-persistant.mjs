// Contexte de navigateur à PROFIL PERSISTANT pour les scénarios de bout en bout (#73).
//
// Playwright fabrique ses contextes par `browser.newContext()`, qui crée un profil **hors
// enregistrement** — un profil « navigation privée ». Chromium n'adosse alors PAS OPFS à un disque :
// il l'adosse à un système de fichiers EN MÉMOIRE. Mesuré sur ce dépôt le 26/08/2026 : le scénario
// d'export écrit plus d'un gigaoctet dans OPFS, et les profils temporaires de Playwright grossissent
// pendant ce temps de moins d'un mébioctet. Les octets ne touchent jamais le disque.
//
// Deux conséquences, et c'est pour elles que ce module existe.
//
//  - **La preuve portait sur le mauvais support.** `VAULT-PERSIST-001` promet une reprise depuis un
//    volume OPFS ; un utilisateur l'exécute dans un profil de navigateur ORDINAIRE, dont l'OPFS est
//    sur disque. Prouver la reprise contre un système de fichiers en mémoire est une promesse plus
//    étroite que celle qu'on affiche. Ce que les scénarios prouvaient reste vrai — la donnée survit
//    à la fermeture de la page, du Worker et des handles — mais le support n'était pas celui du
//    produit.
//  - **La mémoire de l'exécutant devenait le quota.** C'est la cause de #73 : sur les exécutants
//    GitHub, le backend en mémoire finissait par refuser une allocation et rendait
//    `FILE_ERROR_NO_SPACE`, pendant que `navigator.storage.estimate()` — qui, lui, se calcule sur le
//    disque — annonçait plusieurs gibioctets disponibles. Les deux mesures parlaient de supports
//    différents.
//
// Un profil persistant vit dans le répertoire de sortie du test, donc UN PAR TEST : l'isolation
// entre scénarios est celle d'avant, et le cloisonnement d'OPFS par origine (ADR 0002) est celui du
// navigateur, que ce module ne touche pas.
//
// Ce module ne change AUCUNE assertion. Il change le support sous les scénarios, et le rapproche de
// celui du produit.

import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, test as base } from "@playwright/test";

import { creerChronologie } from "./chronologie.mjs";

export { expect } from "@playwright/test";

/** Où les relevés montent dans l'artefact du run, à côté de ceux que les scénarios publient. */
const DOSSIER_RAPPORTS = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  "reports",
  "e2e",
);

/**
 * `test` étendu : la fixture `context` rend un contexte à profil persistant, sur disque.
 *
 * **Ce que cette fixture honore du bloc `use` du projet, et rien d'autre :** `baseURL` et `headless`,
 * repris nommément ci-dessous, plus `trace` — que Playwright applique lui-même, parce qu'il
 * instrumente TOUT contexte créé pendant un test, y compris celui-ci. (Le démarrer à la main lève
 * « Tracing has been already started » ; c'est ainsi que nous l'avons vérifié.)
 *
 * C'est exactement ce que `playwright.e2e.config.mjs` déclare aujourd'hui. Mais un contexte lancé
 * par nous n'hérite de RIEN automatiquement : toute option ajoutée plus tard à ce bloc — `viewport`,
 * `permissions`, `locale`, `extraHTTPHeaders`, `offline`, `storageState`… — serait ignorée ici **sans
 * erreur ni avertissement**. Elle doit être ajoutée à la main juste en dessous.
 *
 * De même, le navigateur est Chromium **nommément**, et non `testInfo.project.use.browserName` : le
 * projet n'en déclare qu'un. Ajouter un projet Firefox ou WebKit sans toucher à ce fichier ferait
 * tourner ses scénarios sur Chromium sans le dire.
 */
export const test = base.extend({
  /**
   * CHRONOLOGIE du scénario, ouverte pour lui seul et déposée à chaque étape (#165).
   *
   * Elle est `auto` : un scénario n'a rien à faire pour qu'un échec soit daté, et c'est le point.
   * Ce qu'elle porte sans qu'on lui dise rien — le début, l'issue, le message d'échec et la SÉRIE
   * DU GUEST quand il y en a une — suffit à dater un boot qui n'a jamais répondu. Les étapes
   * NOMMÉES (préparation, coupure, reprise, boot, santé, refus) sont poussées par les scénarios qui
   * les connaissent : `chronologie.etape("reprise", { … })`.
   *
   * Le relevé vit dans `reports/e2e/`, qui monte dans l'artefact `mesures-reprise` : il se lit sans
   * dézipper une trace Playwright, ce qui est exactement ce que l'instruction de #165 a dû faire.
   */
  chronologie: [
    // Playwright DÉDUIT les dépendances d'une fixture du motif de déstructuration de son premier
    // paramètre : celle-ci n'en a aucune, et le motif vide est la façon de le dire.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      // Le RANG de répétition entre dans le nom : sans lui, `--repeat-each 5` écrase quatre fois
      // son propre relevé et une campagne de mesure ne laisse que son dernier passage. C'est
      // exactement ce dont la distribution de #152 avait besoin, et le rang est absent du cas
      // ordinaire (un seul passage) pour que le nom de fichier reste celui que `docs/testing.md`
      // annonce.
      const rang = testInfo.repeatEachIndex > 0 ? `-${testInfo.repeatEachIndex}` : "";
      const chronologie = creerChronologie({
        scenario: `${basename(testInfo.file, ".spec.mjs")}${rang}`,
        dossier: DOSSIER_RAPPORTS,
      });
      chronologie.etape("ouverture", { titre: testInfo.title, tentative: testInfo.retry });
      await use(chronologie);
      // APRÈS le corps du scénario et ses `afterEach` : `testInfo.status` porte alors l'issue réelle.
      const message = testInfo.errors.map((erreur) => erreur.message ?? "").join("\n---\n");
      const serie = chronologie.clore({
        statut: testInfo.status ?? "inconnu",
        message: message === "" ? null : message,
      });
      await testInfo.attach("chronologie.json", {
        path: chronologie.chemins.releve,
        contentType: "application/json",
      });
      if (serie !== null) {
        await testInfo.attach("serie-guest.txt", {
          path: chronologie.chemins.serie,
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],

  context: async ({ baseURL }, use, testInfo) => {
    // Un contexte lancé par nous n'hérite plus des options `use` du projet : celles dont les
    // scénarios dépendent sont reprises explicitement. `headless` doit l'être en particulier — un
    // exécutant CI n'a pas d'affichage, et `--headed` doit rester utilisable pour déboguer.
    const headless = testInfo.project.use?.headless ?? true;
    // Un profil PAR TEST, dans le répertoire de sortie que Playwright nettoie déjà entre exécutions.
    // Les scénarios restent donc aussi isolés les uns des autres qu'avec un contexte éphémère.
    const context = await chromium.launchPersistentContext(
      testInfo.outputPath("profil-navigateur"),
      { baseURL, headless },
    );
    await use(context);
    await context.close();
  },
});

/**
 * Variable par laquelle une RECETTE déclare qu'elle a construit tous les préalables (#163).
 *
 * `reprise.yml` la pose : elle construit l'image de référence, récupère les artefacts v86, et n'a
 * donc AUCUNE raison de voir un scénario s'ignorer. En local, sans elle, le `skip` explicite reste —
 * un développeur sans Docker doit pouvoir jouer le reste de la suite.
 */
export const EXIGER = "VAULT_E2E_EXIGER";

/**
 * IGNORE un scénario faute de préalable — ou ÉCHOUE, quand la recette a déclaré les avoir tous.
 *
 * C'est la correction d'un vert par vacuité mesuré sur la PR #171 : `reprise.yml` a rendu
 * « 8 passed, 1 skipped » alors que le scénario ignoré était celui que la tranche livrait, et rien
 * dans le journal ne disait lequel ni pourquoi. Deux défauts d'un coup — l'ignorance silencieuse et
 * l'absence de motif —, et ils se corrigent au même endroit :
 *
 *  - la RAISON est imprimée sur la sortie standard, toujours. Un « 1 skipped » sans nom est ce qui a
 *    caché le défaut pendant une recette de deux heures ;
 *  - sous `VAULT_E2E_EXIGER=1`, l'ignorance devient un ÉCHEC avec la raison en clair. Une recette
 *    qui construit ses préalables et voit un scénario s'ignorer a un défaut de recette, pas un
 *    scénario indisponible.
 *
 * @param {string | null} raison ce qui manque, ou `null` si tout est là
 * @param {string} scenario le nom du fichier, pour que le journal dise LEQUEL
 */
export function exigerLesPrealables(raison, scenario) {
  if (raison === null) return;
  process.stdout.write(`[e2e] ${scenario} : préalable absent — ${raison}\n`);
  if (process.env[EXIGER] === "1") {
    throw new Error(
      `${scenario} s'ignore alors que ${EXIGER}=1 : ${raison}. La recette a déclaré avoir ` +
        `construit ses préalables ; un scénario ignoré est donc un défaut de recette.`,
    );
  }
  base.skip(true, raison);
}
