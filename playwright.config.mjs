import { defineConfig } from "@playwright/test";

import {
  ORIGINE_APPLICATIVE_B_HOTE,
  ORIGINE_APPLICATIVE_B_PORT,
  ORIGINE_APPLICATIVE_C_HOTE,
  ORIGINE_APPLICATIVE_C_PORT,
} from "./public/spike/origin/apps-topologie.mjs";
import { APP_HOST, APP_PORT, SHELL_HOST, SHELL_PORT } from "./src/spike/origin-topology.mjs";

const MOTEURS_CONNUS = ["chromium", "firefox", "webkit"];

/**
 * Épreuves de frontière de la CSP et du diagnostic qu'elle commande (#52) : exécutées sur les trois
 * moteurs, jamais sur un seul. Une politique de sécurité ne s'applique pas de la même façon d'un
 * moteur à l'autre, et le diagnostic du runtime dépend de ce que chacun expose.
 *
 * Depuis #74, la famine des minuteries sous la boucle d'ordonnancement de Vault rejoint la liste,
 * pour la même raison : elle mesure un comportement d'ORDONNANCEMENT qui diffère d'un moteur à
 * l'autre — mesuré, WebKit affame ses minuteries là où Chromium et Firefox ne le font pas — et dont
 * dépend la cadence du chien de garde du runtime.
 */
const FRONTIERE_CSP = [
  "**/csp-frontiere.spec.mjs",
  "**/runtime-diagnostic.spec.mjs",
  "**/ordonnancement-famine.spec.mjs",
];

/**
 * La frontière de la HIÉRARCHIE DE CLÉS (#182, ADR 0033, décision 6).
 *
 * L'ADR y écrit un GARANTI qui repose sur la PLATE-FORME — « une `CryptoKey` dont les usages ne
 * portent pas `encrypt` fait rejeter `crypto.subtle.encrypt` » —, et un garanti pareil se mesure sur
 * les trois moteurs, pas sur celui du développeur. Si un seul acceptait, la phrase serait fausse
 * pour un tiers des utilisateurs et le dépôt l'écrirait quand même.
 *
 * Comme la frontière de CSP : aucun artefact v86, aucun stockage, quelques secondes. Les trois
 * moteurs sont donc TOUJOURS exécutés, indépendamment de `VAULT_MOTEURS`.
 */
const FRONTIERE_HIERARCHIE = ["**/hierarchie-de-cles-frontiere.spec.mjs"];

/**
 * Frontière entre deux applications partageant l'origine applicative (#46, ADR 0018). Exécutée sur
 * les trois moteurs pour le même motif que la frontière de CSP, et pour un motif de plus : le
 * partitionnement du stockage n'est pas identique d'un moteur à l'autre — l'OPFS et
 * `indexedDB.databases` manquent à certains —, si bien qu'un relevé mono-moteur publierait une
 * garantie que les deux autres ne tiendraient peut-être pas.
 */
const FRONTIERE_APPLICATIONS = ["**/apps-frontiere.spec.mjs"];

/**
 * Frontière de l'ENVELOPPE DE CLÉ (#21, ADR 0020). Exécutée sur les trois moteurs pour le motif des
 * deux précédentes, et pour un motif de plus qui lui est propre : elle mesure ce qui franchit un
 * `postMessage` depuis le Worker de confiance, et la sérialisation structurée n'est pas identique
 * d'un moteur à l'autre. Une garantie « aucune clé ne franchit le port » relevée sur un seul moteur
 * ne serait pas une garantie.
 *
 * Elle n'a besoin d'aucun artefact v86 et dure quelques secondes : rien ne justifierait de la
 * réserver au moteur par défaut.
 */
const FRONTIERE_ENVELOPPE = ["**/enveloppe-frontiere.spec.mjs"];

/**
 * La frontière de l'ENGAGEMENT D'ARCHIVE (#181, ADR 0034), sur les trois moteurs. Elle rejoue le
 * mélange de secteurs de la revue externe sur l'OPFS RÉEL : le voisin d'engagement est un fichier,
 * et sa consommation en est une suppression — deux faits qu'aucun double en mémoire n'établit.
 */
const FRONTIERE_ENGAGEMENT = ["**/archive-engagement-frontiere.spec.mjs"];

/**
 * Frontière du DÉVERROUILLAGE (#22, ADR 0021). Les trois moteurs, pour les motifs des précédentes
 * et pour deux qui lui sont propres :
 *
 *  - elle mesure une DÉRIVATION dont le coût et la disponibilité diffèrent d'un moteur à l'autre —
 *    Argon2id compilé en WebAssembly n'a pas le même rendement partout, et l'extension WebAuthn
 *    « prf » n'est pilotable que sous Chromium. Un relevé mono-moteur publierait une matrice de
 *    prise en charge que rien n'aurait mesurée ;
 *  - elle fouille TOUS les stockages de l'origine, et ni IndexedDB, ni Cache Storage, ni l'OPFS ne
 *    sont offerts par les trois. Ce que la sonde ne peut pas lire, elle le dit.
 */
const FRONTIERE_DEVERROUILLAGE = ["**/deverrouillage-frontiere.spec.mjs"];

/**
 * Frontière de la COQUILLE DE PRODUIT (#161, tranche 1 de #24, ADR 0028). Les trois moteurs, pour
 * les motifs des précédentes et pour un qui lui est propre : elle mesure une frontière d'ORIGINE
 * mise à l'épreuve par une application malveillante, et l'issue #24 exige les trois moteurs
 * nommément — « l'application malveillante tente la liste complète des refus sur les trois moteurs ».
 * Un relevé mono-moteur publierait une frontière que les deux autres ne tiendraient peut-être pas.
 *
 * Elle n'a besoin d'aucun artefact v86 : le Worker de confiance ouvre un volume de trente-deux
 * secteurs, et rien de plus.
 */
const FRONTIERE_COQUILLE = ["**/coquille-frontiere.spec.mjs"];

/**
 * DÉVERROUILLAGE depuis la coquille de produit (#162, tranche 2 de #24, ADR 0029). Les trois
 * moteurs, pour les motifs de `FRONTIERE_DEVERROUILLAGE` — une dérivation dont le coût et la
 * disponibilité diffèrent d'un moteur à l'autre, une fouille de stockages que les trois n'offrent
 * pas également — et pour un motif qui lui est propre : c'est le CHEMIN DE PRODUIT qui est mesuré,
 * et l'issue #24 exige les trois moteurs nommément. La suite de #22 mesure les mêmes propriétés sur
 * les BANCS ; les deux ne se remplacent pas, puisqu'un banc n'est pas un chemin qu'un utilisateur
 * emprunte.
 */
const DEVERROUILLAGE_COQUILLE = [
  "**/coquille-deverrouillage.spec.mjs",
  // SAUVEGARDER, RESTAURER, RÉVOQUER depuis la coquille (#207, ADR 0039) : même chemin de produit,
  // mêmes motifs, mêmes trois moteurs.
  "**/coquille-portabilite.spec.mjs",
];

/**
 * CYCLE DE VIE assemblé (#163, tranche 3 de #24, ADR 0030) et EN-TÊTES de durcissement (#104, #163).
 * Les trois moteurs, pour les motifs des précédentes et pour deux qui leur sont propres :
 *
 *  - ce qu'un moteur fait d'un Worker qui MEURT — quel événement il livre, dans quel ordre, et s'il
 *    en livre un — n'est écrit dans aucune norme que trois implémentations liraient pareil ;
 *  - `Cross-Origin-Opener-Policy` est un en-tête que le moteur applique ou n'applique pas, et
 *    l'attester par `window.opener === null` sur un seul d'entre eux publierait une garantie que les
 *    deux autres ne tiendraient peut-être pas. La suite de durcissement rejoint donc les trois
 *    moteurs, alors qu'elle n'en mesurait qu'un : elle mesure désormais un EFFET, pas une valeur.
 */
const CYCLE_DE_VIE = ["**/coquille-cycle-de-vie.spec.mjs", "**/entetes-durcissement.spec.mjs"];

/**
 * LE CHEMIN SERVI (#192, tranche P1 de l'épique #195, ADR 0038) : la frontière du relais HTTP.
 *
 * Les trois moteurs, et le motif est celui des précédentes : le refus du relais est calculé sur le
 * TYPE reçu, AVANT que le moindre état soit consulté (ADR 0028), si bien qu'un moteur sans OPFS
 * rend exactement les mêmes codes qu'un moteur qui en a. Mesurer cette frontière-là sur Chromium
 * seul publierait une garantie de frontière sur un tiers du terrain qu'elle couvre.
 *
 * Ce que cette suite ne fait PAS : rendre une page Rails. Aucune machine virtuelle n'y tourne —
 * c'est `tests/e2e/parcours-page-rails.spec.mjs` qui mesure le service, sur Chromium et avec
 * l'image de référence.
 */
const SERVICE_APPLICATIF = [
  "**/coquille-service-applicatif.spec.mjs",
  // Deux coffres, un seul Service Worker (revue de sécurité de la PR #203, constats 1 et 2).
  "**/coquille-deux-coffres.spec.mjs",
];

/**
 * PERSISTANCE de stockage : le budget (#9) et la conduite (#42), sur les trois moteurs et sur les
 * TROIS réponses possibles de l'invite Firefox (#168, ADR 0006).
 *
 * Ces deux suites vivaient dans le projet de base, donc sur Chromium seul — et c'est exactement ce
 * que #168 reproche : `navigator.storage.persist()` est la capacité dont le verdict DIFFÈRE le plus
 * d'un moteur à l'autre, et elle était mesurée sur celui qui répond le plus vite. Mesuré le
 * 9 septembre 2026, dix essais par configuration, Firefox 153 sans fenêtre :
 *
 *  - Chromium rend `false` en 0–1 ms — refus tranché ;
 *  - WebKit n'expose pas `persist()` du tout — absence, jamais un refus ;
 *  - Firefox NU ne rend RIEN : la promesse reste pendante derrière une invite au-delà de 15 s, avec
 *    ou sans geste utilisateur préalable. C'est le verdict `pending` du produit, borné à quatre
 *    secondes par `src/vm/storage-budget.mjs` ;
 *  - Firefox sous les préférences d'ESSAI de l'invite rend `true` en 6–8 ms (`…prompt.testing.allow`
 *    à vrai) ou `false` en 0–2 ms (à faux). Ces deux projets ne simulent pas une absence de geste :
 *    ils répondent à l'invite À LA PLACE de l'utilisateur, ce que seul un harnais peut faire.
 *
 * Cinq projets, donc, et aucun `skip` : les trois verdicts que la conduite distingue — accordée,
 * refusée, indéterminée — sont réellement JOUÉS, plus l'absence d'API.
 */
const PERSISTANCE = ["**/storage-budget.spec.mjs", "**/persistence-conduct.spec.mjs"];

/** Les épreuves dont le résultat dépend de la RÉPONSE du moteur à l'invite de persistance. */
const VERDICT_DE_PERSISTANCE = /@verdict-de-persistance/;

/**
 * Préférences d'ESSAI de l'invite de persistance de Firefox. Elles n'existent que pour les harnais :
 * elles court-circuitent l'invite et posent la réponse. Hors de ces deux projets, rien ne les pose,
 * et la mesure nue reste la mesure nue.
 */
const invitePersistanceFirefox = (accordee) => ({
  launchOptions: {
    firefoxUserPrefs: {
      "dom.storageManager.prompt.testing": true,
      "dom.storageManager.prompt.testing.allow": accordee,
    },
  },
});

// Le harnais mesure une frontière d'origine : il lui faut DEUX serveurs, donc deux origines
// réelles. `127.0.0.1` et `localhost` en fournissent sans DNS ni certificat, et restent tous deux
// des contextes sécurisés.
const moteurs = (process.env.VAULT_MOTEURS ?? "chromium")
  .split(",")
  .map((nom) => nom.trim())
  .filter(Boolean);

for (const moteur of moteurs) {
  if (!MOTEURS_CONNUS.includes(moteur)) {
    throw new Error(
      `Moteur inconnu dans VAULT_MOTEURS : ${moteur}. Valeurs admises : ${MOTEURS_CONNUS.join(", ")}.`,
    );
  }
}

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  // Les relevés du spike #35 exécutent dix-neuf sondes dont plusieurs attendent volontairement un
  // silence de l'API (origine opaque) : le délai par défaut de 30 s ne leur suffit pas.
  timeout: 120000,
  // La frontière fautive de #178 est attribuée au suivi de navigation Playwright ↔ Firefox et sa
  // signature exacte est récupérée par `tests/support/test.mjs`. Une autre panne doit rougir dès
  // son premier essai : aucune reprise globale ne la masque plus, en CI comme en local.
  retries: 0,
  // Le rapport JSON publie les récupérations Firefox annotées par la fixture. Il conserve aussi le
  // compte historique des reprises : avec `retries: 0`, une valeur non nulle signalerait une
  // configuration du gate qui a divergé de cette règle.
  reporter: process.env.CI
    ? [
        ["html", { open: "never" }],
        ["github"],
        ["json", { outputFile: "playwright-report/rapport.json" }],
      ]
    : "list",
  use: {
    baseURL: `http://${SHELL_HOST}:${SHELL_PORT}`,
    trace: "retain-on-failure",
    // BORNE DE NAVIGATION (#178). Une navigation vers un document servi en local prend, mesurée
    // isolément sur cent essais, une centaine de millisecondes et jamais plus de 487 ms. Quand le
    // flottement Firefox la saisit, elle ne prend pas « plus longtemps » : elle ne rend JAMAIS la
    // main, et emporte alors tout le budget de l'épreuve — cent vingt secondes ici, cinq minutes dans
    // `playwright.fins-d-onglet.config.mjs`. Le run 34395610878 l'a payé sept fois : sept épreuves
    // reprises, sept premiers essais expirés à 120 s, quatorze minutes de temps de test sur deux
    // ouvriers, et le job tué au plafond de vingt-huit minutes.
    //
    // Soixante secondes sont donc une borne, pas un raccourci : elles valent cent vingt fois la plus
    // lente navigation saine jamais relevée, et c'est la valeur que ce dépôt emploie déjà là où il
    // veut être généreux sous charge (`toHaveAttribute` de `coquille-frontiere.spec.mjs`). Elle ne
    // cache rien : l'épreuve échoue quand même, la reprise est comptée, et le compte est publié à
    // chaque run. Elle empêche seulement UN blocage du harnais de manger la marge du gate.
    navigationTimeout: 60_000,
  },
  webServer: [
    {
      command: `node tools/serve.mjs --role shell --host ${SHELL_HOST} --port ${SHELL_PORT}`,
      url: `http://${SHELL_HOST}:${SHELL_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node tools/serve.mjs --role app --host ${APP_HOST} --port ${APP_PORT}`,
      url: `http://${APP_HOST}:${APP_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    // Seconde origine APPLICATIVE (#46). L'hôte change, et pas seulement le port : les cookies
    // ignorent le port, et deux origines qui n'en différeraient que par lui partageraient leur
    // bocal — la mesure conclurait à une isolation que la topologie visée n'aurait pas non plus.
    {
      command: `node tools/serve.mjs --role app --host ${ORIGINE_APPLICATIVE_B_HOTE} --port ${ORIGINE_APPLICATIVE_B_PORT}`,
      url: `http://${ORIGINE_APPLICATIVE_B_HOTE}:${ORIGINE_APPLICATIVE_B_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    // Troisième origine applicative (#46), sur le MÊME hôte que la première et n'en différant que
    // par le port : elle mesure l'écart entre la frontière d'origine, qui compte le port, et la
    // frontière de cookies, qui ne le compte pas.
    {
      command: `node tools/serve.mjs --role app --host ${ORIGINE_APPLICATIVE_C_HOTE} --port ${ORIGINE_APPLICATIVE_C_PORT}`,
      url: `http://${ORIGINE_APPLICATIVE_C_HOTE}:${ORIGINE_APPLICATIVE_C_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    ...moteurs.map((nom) => ({
      name: nom,
      use: { browserName: nom },
      testIgnore: [
        ...FRONTIERE_CSP,
        ...FRONTIERE_HIERARCHIE,
        ...FRONTIERE_APPLICATIONS,
        ...FRONTIERE_ENVELOPPE,
        ...FRONTIERE_ENGAGEMENT,
        ...FRONTIERE_DEVERROUILLAGE,
        ...FRONTIERE_COQUILLE,
        ...DEVERROUILLAGE_COQUILLE,
        ...CYCLE_DE_VIE,
        ...SERVICE_APPLICATIF,
        ...PERSISTANCE,
      ],
    })),
    // La frontière de CSP (#52) est une frontière de SÉCURITÉ, et une politique ne s'applique pas de
    // la même façon d'un moteur à l'autre : la mesurer sur le seul moteur par défaut publierait une
    // garantie que les deux autres ne tiennent peut-être pas. Ces épreuves n'ont besoin d'aucun
    // artefact v86 et durent quelques secondes ; les trois moteurs de la matrice #2 sont donc
    // TOUJOURS exécutés, indépendamment de `VAULT_MOTEURS`, qui gouverne les relevés du spike #35.
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-csp-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_CSP,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-hierarchie-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_HIERARCHIE,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-applications-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_APPLICATIONS,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-enveloppe-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_ENVELOPPE,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-engagement-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_ENGAGEMENT,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-deverrouillage-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_DEVERROUILLAGE,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `frontiere-coquille-${nom}`,
      use: { browserName: nom },
      testMatch: FRONTIERE_COQUILLE,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `deverrouillage-coquille-${nom}`,
      use: { browserName: nom },
      testMatch: DEVERROUILLAGE_COQUILLE,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `cycle-de-vie-${nom}`,
      use: { browserName: nom },
      testMatch: CYCLE_DE_VIE,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `service-applicatif-${nom}`,
      use: { browserName: nom },
      testMatch: SERVICE_APPLICATIF,
    })),
    ...MOTEURS_CONNUS.map((nom) => ({
      name: `persistance-${nom}`,
      use: { browserName: nom },
      testMatch: PERSISTANCE,
    })),
    // Les deux projets d'INVITE ne font varier qu'une chose : la réponse donnée à l'invite de
    // Firefox. Ils ne jouent donc que les épreuves dont le résultat en dépend — deux, marquées
    // `@verdict-de-persistance`. Rejouer l'estimation, la réservation, la classification de quota et
    // les verdicts synthétiques du rendu n'apprendrait rien du moteur (c'est le même Firefox que le
    // projet nu) et ajouterait douze navigations à une suite dont les navigations Firefox flottent
    // (#178). Les trois projets NUS, eux, jouent tout : là, le moteur change.
    {
      name: "persistance-firefox-invite-accordee",
      use: { browserName: "firefox", ...invitePersistanceFirefox(true) },
      testMatch: PERSISTANCE,
      grep: VERDICT_DE_PERSISTANCE,
    },
    {
      name: "persistance-firefox-invite-refusee",
      use: { browserName: "firefox", ...invitePersistanceFirefox(false) },
      testMatch: PERSISTANCE,
      grep: VERDICT_DE_PERSISTANCE,
    },
  ],
});
