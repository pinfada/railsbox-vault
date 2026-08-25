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
