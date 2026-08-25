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

import { chromium, test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * `test` étendu : la fixture `context` rend un contexte à profil persistant, sur disque.
 *
 * La capture de trace n'est PAS reprise ici : Playwright instrumente tout contexte créé pendant un
 * test, y compris celui-ci, si bien que `trace: "retain-on-failure"` de `playwright.e2e.config.mjs`
 * continue de s'appliquer. La démarrer à la main lève d'ailleurs « Tracing has been already
 * started » — c'est ainsi que nous l'avons vérifié.
 */
export const test = base.extend({
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
