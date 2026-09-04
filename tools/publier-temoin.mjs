#!/usr/bin/env node
// TÉMOIN D'EN-TÊTES de la chaîne de publication (#45).
//
//   node tools/publier-temoin.mjs                    Chromium
//   VAULT_MOTEURS=chromium,firefox,webkit node tools/publier-temoin.mjs
//
// Il répond à trois questions, sur les ARBRES PUBLIÉS et non sur le dépôt :
//
//  1. l'hébergement sert-il exactement les en-têtes que `tools/serve-headers.mjs` définit, plus le
//     COOP ajouté par l'ADR 0017 ? Comparaison littérale, en-tête par en-tête, par origine. Depuis
//     l'ADR 0022 la comparaison porte aussi sur les DEUX MOITIÉS des en-têtes de durcissement : les
//     valeurs servies à la coquille, et l'absence décidée sur l'origine applicative et pour HSTS ;
//  2. ce COOP a-t-il l'effet qu'on lui prête ? L'ADR 0010 a nommé la preuve attendue : « un témoin
//     `window.opener === null`, relevé depuis une fenêtre ouverte par un document d'une autre
//     origine ». C'est ce qui est relevé ici, avec son TÉMOIN NÉGATIF — la même manipulation sur un
//     serveur d'où COOP a été retiré, où `window.opener` doit SURVIVRE. Sans lui, un `null` ne
//     prouverait rien : il pourrait venir d'une sonde cassée ;
//  3. l'arbre publié fonctionne-t-il encore ? Une coquille aux en-têtes parfaits qui ne démarre pas
//     n'est pas une publication. Le document est chargé et son Worker doit s'annoncer.
//
// Ce témoin ne rejoue PAS la frontière de CSP : `tests/browser/csp-frontiere.spec.mjs` la mesure
// déjà sur les trois moteurs, à chaque `npm run check`, et la dupliquer ici ferait deux vérités.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, firefox, webkit } from "@playwright/test";

import { enTetesDePublication } from "./publier-en-tetes.mjs";
import { demarrer } from "./publier-servir.mjs";
import { POLITIQUES_DE_CACHE, PREFIXE_EPINGLAGE_V86 } from "./serve-headers.mjs";
import { REPOSITORY_ROOT } from "./v86-paths.mjs";

const MOTEURS = { chromium, firefox, webkit };

/** Ports du témoin, distincts de ceux du serveur de test (4173/4174) et des bancs. */
export const PORTS = Object.freeze({ coquille: 4193, application: 4194, coquilleSansCoop: 4195 });
export const HOTE_COQUILLE = "127.0.0.1";
export const HOTE_APPLICATION = "localhost";

export const ORIGINE_COQUILLE = `http://${HOTE_COQUILLE}:${PORTS.coquille}`;
export const ORIGINE_APPLICATION = `http://${HOTE_APPLICATION}:${PORTS.application}`;
export const ORIGINE_COQUILLE_SANS_COOP = `http://${HOTE_COQUILLE}:${PORTS.coquilleSansCoop}`;

/**
 * Le témoin lit les arbres du BANC, pas ceux de la publication.
 *
 * Les deux ne peuvent pas être le même répertoire : le témoin exige des origines de test — c'est
 * ainsi qu'il obtient deux origines réelles sans DNS — et un arbre construit pour lui porte donc un
 * `frame-src http://localhost:4194` qui n'a rien à faire dans un artefact publiable. Les mélanger
 * laissait `npm run check` écraser `artifacts/publication/` par un hybride : inventaire d'allure
 * normale, en-têtes de banc.
 */
const RACINE_ARBRES = join(REPOSITORY_ROOT, "artifacts", "publication-check");
const RAPPORT = join(REPOSITORY_ROOT, "reports", "publication", "temoin-en-tetes.json");

/**
 * Confronte les en-têtes reçus à ceux que la publication déclare.
 *
 * La comparaison est littérale et exhaustive dans un sens : chaque en-tête attendu doit être là,
 * avec sa valeur exacte. Elle ne l'est pas dans l'autre — un hébergeur réel ajoute `Date`, `ETag`,
 * `Server`, et exiger l'égalité des ensembles ferait échouer le témoin sur du bruit.
 */
export function confronter(attendus, recus) {
  const ecarts = [];
  for (const [nom, valeur] of Object.entries(attendus)) {
    const recu = recus[nom.toLowerCase()];
    if (recu !== valeur) ecarts.push({ enTete: nom, attendu: valeur, recu: recu ?? null });
  }
  return ecarts;
}

/**
 * Natures d'artefact dont le témoin relève la politique de cache RÉELLEMENT servie (#103, ADR 0023).
 *
 * Trois relevés, sur les DEUX arbres, et sur des chemins qui existent dans tout arbre publié — y
 * compris quand `vendor/v86/artefacts/` est absent, ce qui est le cas ordinaire d'un clone vierge.
 * C'est pourquoi la nature « épinglage v86 » est relevée sur son MANIFESTE : il est versionné, il
 * relève du même préfixe donc de la même règle, et il est publié dans tous les cas. Sans lui, la
 * seule nature dont la valeur est particulière ne serait jamais mesurée là où elle est servie, et
 * le critère « `npm run publier:check` vérifie la politique sur les deux origines » serait décoratif.
 *
 * @type {readonly { nature: string, arbre: string, chemin: string }[]}
 */
export const NATURES_RELEVEES_PAR_LE_TEMOIN = Object.freeze([
  Object.freeze({ nature: "coquille", arbre: "coquille", chemin: "/index.html" }),
  Object.freeze({
    nature: "epinglage-v86",
    arbre: "coquille",
    chemin: `${PREFIXE_EPINGLAGE_V86}MANIFEST.json`,
  }),
  Object.freeze({
    nature: "territoire-applicatif",
    arbre: "application",
    chemin: "/index.html",
  }),
]);

/** Un en-tête qui ne doit PAS être servi. L'origine applicative n'en reçoit aucune CSP (ADR 0002). */
export function confronterAbsences(absents, recus) {
  return absents
    .filter((nom) => recus[nom.toLowerCase()] !== undefined)
    .map((nom) => ({ enTete: nom, attendu: null, recu: recus[nom.toLowerCase()] }));
}

async function relevePage(page, url) {
  const reponse = await page.goto(url, { waitUntil: "load" });
  return reponse.headers();
}

/**
 * Ouvre la coquille depuis un document de l'AUTRE origine et relève `window.opener`.
 *
 * L'ouverture est faite par `window.open` depuis le document applicatif : c'est exactement la
 * relation que COOP gouverne, et que `frame-ancestors` ne couvre pas (ADR 0010).
 */
async function releverOpener(contexte, urlCoquille) {
  const ouvreur = await contexte.newPage();
  await ouvreur.goto(`${ORIGINE_APPLICATION}/index.html`, { waitUntil: "load" });
  const [popup] = await Promise.all([
    contexte.waitForEvent("page"),
    ouvreur.evaluate((url) => globalThis.open(url, "_blank"), urlCoquille),
  ]);
  await popup.waitForLoadState("load");
  const openerEstNul = await popup.evaluate(() => globalThis.opener === null);
  await popup.close();
  await ouvreur.close();
  return openerEstNul;
}

/**
 * Relève la politique de cache RÉELLEMENT reçue, pour chaque nature servie par l'arbre courant.
 *
 * Le relevé passe par un `fetch` émis DEPUIS la page, c'est-à-dire par la pile réseau du moteur, et
 * non par le client HTTP du harnais : c'est ce qui distingue « l'hébergeur envoie cet en-tête » de
 * « le navigateur le reçoit ». `cache: "no-store"` sur le fetch lui-même empêche qu'une réponse
 * déjà gardée par le moteur — désormais possible, c'est tout l'objet de l'ADR 0023 — masque ce que
 * le serveur envoie.
 */
async function releverPolitiqueDeCache(page, arbre) {
  const releves = [];
  for (const releve of NATURES_RELEVEES_PAR_LE_TEMOIN.filter(
    (candidat) => candidat.arbre === arbre,
  )) {
    const recu = await page.evaluate(async (chemin) => {
      const reponse = await fetch(chemin, { cache: "no-store" });
      return reponse.headers.get("cache-control");
    }, releve.chemin);
    releves.push({ ...releve, attendu: POLITIQUES_DE_CACHE[releve.nature], recu });
  }
  return releves;
}

async function releverDemarrage(page) {
  await page.waitForFunction(
    () => globalThis.document.documentElement.dataset.vaultReady === "true",
    undefined,
    { timeout: 15000 },
  );
  return page.textContent("#worker-status");
}

async function mesurerMoteur(nom) {
  const navigateur = await MOTEURS[nom].launch();
  const contexte = await navigateur.newContext();
  const page = await contexte.newPage();

  const enTetesCoquille = await relevePage(page, `${ORIGINE_COQUILLE}/index.html`);
  const demarrage = await releverDemarrage(page);
  const cacheCoquille = await releverPolitiqueDeCache(page, "coquille");
  const enTetesApplication = await relevePage(page, `${ORIGINE_APPLICATION}/index.html`);
  const cacheApplication = await releverPolitiqueDeCache(page, "application");
  await page.close();

  const origines = {
    origineCoquille: ORIGINE_COQUILLE,
    origineApplication: ORIGINE_APPLICATION,
  };
  const mesure = {
    moteur: nom,
    coquille: {
      ecarts: [
        ...confronter(enTetesDePublication("coquille", origines), enTetesCoquille),
        // HSTS est ÉCARTÉ par l'ADR 0022, et une décision d'écarter que rien ne relève redevient un
        // oubli. Le témoin sert en `http:`, là où l'en-tête serait de toute façon ignoré : ce qui
        // est vérifié ici n'est donc pas son effet, c'est qu'aucun maillon de la chaîne — table
        // d'ajouts, `_headers`, serveur de l'artefact — ne l'a réintroduit en route.
        ...confronterAbsences(["Strict-Transport-Security"], enTetesCoquille),
      ],
      recus: enTetesCoquille,
    },
    application: {
      ecarts: [
        ...confronter(enTetesDePublication("application", origines), enTetesApplication),
        // Quatre en-têtes n'ont rien à faire sur cette origine, et leur présence serait la marque
        // d'une politique recopiée d'un arbre à l'autre. COOP y serait sans effet — un document
        // encadré n'est pas un contexte de navigation de plus haut niveau (ADR 0017 § 3).
        // `Referrer-Policy` et `Permissions-Policy` y seraient pires que sans effet : ils
        // gouvernent ce que le document ÉMET et ce qu'il PEUT, donc le contenu rendu par le guest,
        // que l'ADR 0002 s'interdit de contraindre. HSTS est écarté des deux côtés. L'ADR 0022
        // décide les trois par RÔLE ; c'est ici que la moitié « écartée » de cette décision est
        // relevée, sur l'origine où elle s'applique.
        ...confronterAbsences(
          [
            "Cross-Origin-Opener-Policy",
            "Referrer-Policy",
            "Permissions-Policy",
            "Strict-Transport-Security",
          ],
          enTetesApplication,
        ),
      ],
      // La CSP de l'origine applicative doit être `frame-ancestors` et RIEN d'autre : l'ADR 0002
      // interdit d'imposer une politique au CONTENU rendu par le guest, et `frame-ancestors` ne le
      // fait pas. Une directive de plus — `default-src`, `script-src`, `connect-src` — trahirait
      // que la politique de la coquille a débordé sur le territoire applicatif.
      cspApplicativeSolitaire: (enTetesApplication["content-security-policy"] ?? "")
        .split(";")
        .map((directive) => directive.trim())
        .filter(Boolean),
      recus: enTetesApplication,
    },
    // La politique de cache est la SEULE dimension que l'ADR 0023 autorise à varier selon le
    // chemin : elle est donc relevée par nature d'artefact, et pas une fois par origine.
    politiqueDeCache: [...cacheCoquille, ...cacheApplication],
    demarrage,
    openerAvecCoop: await releverOpener(contexte, `${ORIGINE_COQUILLE}/index.html`),
    openerSansCoop: await releverOpener(contexte, `${ORIGINE_COQUILLE_SANS_COOP}/index.html`),
  };

  await navigateur.close();
  return mesure;
}

/**
 * Motifs de refus tirés du relevé de politique de cache (#103, ADR 0023).
 *
 * Trois conditions, et les deux dernières sont là pour que le relevé ne puisse pas être vert sans
 * avoir mesuré ce que la décision a de propre : qu'elle DISTINGUE. Un témoin qui ne relèverait
 * qu'une nature, ou trois natures portant la même valeur, dirait « conforme » d'une politique
 * uniforme — exactement l'état que cette tranche corrige.
 */
function motifsDePolitiqueDeCache(releves) {
  const motifs = releves
    .filter(({ recu, attendu }) => recu !== attendu)
    .map(
      ({ nature, chemin, attendu, recu }) =>
        `politique de cache « ${nature} » sur ${chemin} : attendu ${attendu}, reçu ${recu ?? "(absent)"}`,
    );
  // UNE garde, et pas deux. La campagne de mutation de #103 a relevé qu'une garde « au moins deux
  // natures » posée à côté de celle-ci ne pouvait JAMAIS échouer seule — un relevé mono-nature porte
  // par construction une seule politique — et qu'aucune épreuve ne pouvait donc la tuer. C'était du
  // code mort qui donnait l'apparence de deux protections.
  const politiques = new Set(releves.map(({ attendu }) => attendu));
  if (politiques.size < 2) {
    motifs.push(
      `le témoin a relevé ${releves.length} nature(s) d'artefact pour ${politiques.size} ` +
        "politique(s) de cache distincte(s) : il en faut au moins DEUX natures portant DEUX " +
        "politiques différentes, sans quoi une décision « par nature » serait déclarée conforme " +
        "sans avoir jamais été mesurée",
    );
  }
  return motifs;
}

/** Un moteur passe si les en-têtes sont conformes, que la coquille démarre, et que COOP agit. */
export function verdict(mesure) {
  const motifs = [...motifsDePolitiqueDeCache(mesure.politiqueDeCache ?? [])];
  if (mesure.coquille.ecarts.length > 0) motifs.push("en-têtes de la coquille");
  if (mesure.application.ecarts.length > 0) motifs.push("en-têtes de l'origine applicative");
  const csp = mesure.application.cspApplicativeSolitaire;
  if (csp.length !== 1 || !csp[0].startsWith("frame-ancestors ")) {
    motifs.push(
      `la CSP de l'origine applicative doit être « frame-ancestors » SEUL (ADR 0002) ; reçu : ${
        csp.join(" ; ") || "(absente)"
      }`,
    );
  }
  if (mesure.demarrage !== "worker:ready") motifs.push(`démarrage : ${mesure.demarrage}`);
  if (mesure.openerAvecCoop !== true) motifs.push("COOP servi mais `window.opener` a survécu");
  if (mesure.openerSansCoop !== false) {
    motifs.push("témoin négatif cassé : `window.opener` est nul SANS COOP");
  }
  return { moteur: mesure.moteur, conforme: motifs.length === 0, motifs };
}

function decrire(mesure) {
  const { conforme, motifs } = verdict(mesure);
  const lignes = [
    `[${mesure.moteur}] ${conforme ? "CONFORME" : "ÉCART"}`,
    `  démarrage de la coquille        ${mesure.demarrage}`,
    `  CSP de l'origine applicative    ${mesure.application.cspApplicativeSolitaire.join(" ; ") || "(absente)"}`,
    `  window.opener avec COOP         ${mesure.openerAvecCoop ? "null (attendu)" : "SURVIT"}`,
    `  window.opener sans COOP         ${mesure.openerSansCoop ? "null (TÉMOIN CASSÉ)" : "survit (attendu)"}`,
  ];
  for (const releve of mesure.politiqueDeCache ?? []) {
    lignes.push(
      `  cache ${releve.nature.padEnd(24)} ${releve.recu ?? "(absent)"}   ${releve.chemin}`,
    );
  }
  for (const ecart of [...mesure.coquille.ecarts, ...mesure.application.ecarts]) {
    lignes.push(`  ÉCART ${ecart.enTete}`);
    lignes.push(`        attendu ${ecart.attendu ?? "(absent)"}`);
    lignes.push(`        reçu    ${ecart.recu ?? "(absent)"}`);
  }
  for (const motif of motifs) lignes.push(`  MOTIF ${motif}`);
  return lignes.join("\n");
}

async function principal() {
  const moteurs = (process.env.VAULT_MOTEURS ?? "chromium")
    .split(",")
    .map((nom) => nom.trim())
    .filter(Boolean);
  for (const moteur of moteurs) {
    if (!(moteur in MOTEURS)) {
      throw new Error(
        `Moteur inconnu : ${moteur}. Valeurs admises : ${Object.keys(MOTEURS).join(", ")}.`,
      );
    }
  }

  const serveurs = await Promise.all([
    demarrer({
      arbre: join(RACINE_ARBRES, "coquille"),
      host: HOTE_COQUILLE,
      port: PORTS.coquille,
      retires: [],
    }),
    demarrer({
      arbre: join(RACINE_ARBRES, "application"),
      host: HOTE_APPLICATION,
      port: PORTS.application,
      retires: [],
    }),
    // Témoin négatif : le MÊME arbre, servi sans COOP. La seule variable est l'en-tête.
    demarrer({
      arbre: join(RACINE_ARBRES, "coquille"),
      host: HOTE_COQUILLE,
      port: PORTS.coquilleSansCoop,
      retires: ["Cross-Origin-Opener-Policy"],
    }),
  ]);

  const mesures = [];
  try {
    for (const moteur of moteurs) mesures.push(await mesurerMoteur(moteur));
  } finally {
    await Promise.all(serveurs.map(({ arreter }) => arreter()));
  }

  const verdicts = mesures.map(verdict);
  for (const mesure of mesures) process.stdout.write(`${decrire(mesure)}\n`);
  await mkdir(join(RAPPORT, ".."), { recursive: true });
  await writeFile(RAPPORT, `${JSON.stringify({ mesures, verdicts }, null, 2)}\n`, "utf8");
  process.stdout.write(`\nRapport : ${RAPPORT}\n`);
  return verdicts.every(({ conforme }) => conforme) ? 0 : 1;
}

if (process.argv[1]?.endsWith("publier-temoin.mjs")) {
  process.exitCode = await principal();
}
