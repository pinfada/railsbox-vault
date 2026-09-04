/**
 * Épreuves de la POLITIQUE DE CACHE, décidée par NATURE D'ARTEFACT (#103, ADR 0023).
 *
 * Le risque résiduel n°1 de l'ADR 0017 relevait que `Cache-Control: no-store` partait en production
 * sur les deux origines — non par décision, mais par conséquence mécanique de la règle « la
 * publication ne sert rien de plus que `tools/serve-headers.mjs` ». Or l'ADR 0002 prévoit DEUX
 * Service Workers pour le mode hors ligne, et `no-store` retire au niveau HTTP toute contribution à
 * ce mode.
 *
 * Ces épreuves fixent la décision là où elle est prise — dans la source de vérité — et non dans la
 * publication : trois natures d'artefact, trois politiques, et une seule dimension qui a le droit
 * de varier selon le chemin. Le reste du durcissement (ADR 0013, ADR 0022) ne bouge PAS d'un
 * chemin à l'autre, et la dernière épreuve de ce fichier est celle qui le mesure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { NATURES_RELEVEES_PAR_LE_TEMOIN, verdict } from "../../tools/publier-temoin.mjs";
import {
  DUREE_EPINGLAGE_V86_SECONDES,
  NATURES_DARTEFACT,
  POLITIQUES_DE_CACHE,
  PREFIXE_EPINGLAGE_V86,
  natureDArtefact,
  politiqueDeCache,
  securityHeaders,
} from "../../tools/serve-headers.mjs";

const ORIGINE_APPLICATIVE = "http://localhost:4174";

/** Un chemin de chaque nature, nommé une fois pour que les épreuves parlent de la même chose. */
const DOCUMENT_DE_COQUILLE = "/index.html";
const MODULE_DE_COQUILLE = "/src/vm/volume-manifest.mjs";
const ARTEFACT_EPINGLE = "/vendor/v86/artefacts/v86.wasm";
const MANIFESTE_EPINGLAGE = "/vendor/v86/MANIFEST.json";
const TERRITOIRE_APPLICATIF = "/spike/origin/app-inter.html";
const SONDE_DE_CAPACITES = "/compat.html";

function enTetes(role, pathname) {
  return securityHeaders({ role, pathname, isolation: null, appOrigin: ORIGINE_APPLICATIVE });
}

// --- Les trois natures, et le fait qu'elles se distinguent ---------------------------------------

test("trois natures d'artefact sont nommées, et elles rendent trois politiques DISTINCTES", () => {
  const valeurs = Object.values(NATURES_DARTEFACT).map((nature) => POLITIQUES_DE_CACHE[nature]);
  assert.equal(valeurs.length, 3, "l'ADR 0023 décide trois natures, pas une de plus");
  assert.equal(
    new Set(valeurs).size,
    3,
    "deux natures qui reçoivent la même valeur ne sont pas deux natures : la table serait décorative",
  );
  for (const valeur of valeurs) assert.ok(typeof valeur === "string" && valeur.length > 0);
});

test("la nature est décidée par le CHEMIN et le rôle, pas par l'origine seule", () => {
  assert.equal(
    natureDArtefact({ role: "shell", pathname: DOCUMENT_DE_COQUILLE }),
    NATURES_DARTEFACT.coquille,
  );
  assert.equal(
    natureDArtefact({ role: "shell", pathname: ARTEFACT_EPINGLE }),
    NATURES_DARTEFACT.epinglageV86,
  );
  // Le territoire applicatif reste le territoire du guest même servi par le rôle `shell` : c'est
  // ainsi que le banc du spike #35 le sert, et la nature ne doit pas dépendre du port qui écoute.
  assert.equal(
    natureDArtefact({ role: "shell", pathname: TERRITOIRE_APPLICATIF }),
    NATURES_DARTEFACT.territoireApplicatif,
  );
  assert.equal(
    natureDArtefact({ role: "app", pathname: DOCUMENT_DE_COQUILLE }),
    NATURES_DARTEFACT.territoireApplicatif,
  );
});

// --- Coquille : revalidation, et surtout PLUS de `no-store` --------------------------------------

test("la coquille et ses modules sont revalidés, jamais interdits de stockage", () => {
  for (const chemin of [DOCUMENT_DE_COQUILLE, MODULE_DE_COQUILLE, SONDE_DE_CAPACITES]) {
    const politique = enTetes("shell", chemin)["Cache-Control"];
    assert.equal(politique, "no-cache", `${chemin} ne reçoit pas la politique de la coquille`);
    assert.ok(
      !politique.includes("no-store"),
      "`no-store` sur la coquille retire au niveau HTTP toute contribution au mode hors ligne de " +
        "l'ADR 0002 : c'est le risque résiduel n°1 de l'ADR 0017, et il est fermé ici",
    );
  }
});

// --- Épinglage v86 : cachable longtemps, mais jamais `immutable` ---------------------------------

test("l'épinglage v86 est cachable, borné par la borne que la plate-forme s'impose déjà", () => {
  assert.equal(DUREE_EPINGLAGE_V86_SECONDES, 86400);
  for (const chemin of [ARTEFACT_EPINGLE, MANIFESTE_EPINGLAGE, "/vendor/v86/LICENSE-v86.txt"]) {
    assert.equal(enTetes("shell", chemin)["Cache-Control"], `public, max-age=86400`);
  }
});

test("aucune nature ne reçoit `immutable` : aucune URL publiée ne nomme son empreinte", () => {
  // L'ADR 0003 épingle les artefacts v86 par SHA-256 dans `vendor/v86/MANIFEST.json`, pas dans leur
  // URL. `/vendor/v86/artefacts/v86.wasm` rend d'autres octets après une montée de version, à la
  // MÊME adresse : `immutable` y interdirait au navigateur de jamais s'en apercevoir. La condition
  // de réouverture est écrite dans l'ADR 0023.
  for (const valeur of Object.values(POLITIQUES_DE_CACHE)) {
    assert.ok(!valeur.includes("immutable"), `« ${valeur} » promet une immuabilité non tenue`);
  }
});

test("le manifeste d'épinglage vieillit AVEC les octets qu'il décrit, pas séparément", () => {
  // Un manifeste frais devant des octets d'hier décrirait un runtime que le navigateur n'exécute
  // pas. Les deux relèvent du même préfixe, donc de la même règle, donc de la même fenêtre.
  assert.ok(MANIFESTE_EPINGLAGE.startsWith(PREFIXE_EPINGLAGE_V86));
  assert.ok(ARTEFACT_EPINGLE.startsWith(PREFIXE_EPINGLAGE_V86));
  assert.equal(
    politiqueDeCache({ role: "shell", pathname: MANIFESTE_EPINGLAGE }),
    politiqueDeCache({ role: "shell", pathname: ARTEFACT_EPINGLE }),
  );
});

// --- Territoire applicatif : `no-store` devient une DÉCISION --------------------------------------

test("le territoire applicatif garde `no-store`, et c'est décidé plutôt qu'hérité", () => {
  // Ce que l'origine applicative sert en production porte les cookies de session Rails. Ce n'est
  // pas au dépôt de la coquille de décider ce que le guest met en cache de SES réponses ; ce que
  // nous servons de cette origine, en revanche — la place tenante —, ne doit pas s'attarder dans un
  // cache partagé.
  assert.equal(enTetes("app", DOCUMENT_DE_COQUILLE)["Cache-Control"], "no-store");
  assert.equal(enTetes("app", "/quelconque.html")["Cache-Control"], "no-store");
  assert.equal(enTetes("shell", TERRITOIRE_APPLICATIF)["Cache-Control"], "no-store");
});

// --- La dimension de cache est la SEULE qui varie selon le chemin --------------------------------

test("seul `Cache-Control` varie d'un chemin à l'autre pour un rôle donné", () => {
  // C'est la garantie que le cliquet de publication traduit en refus. Ici, elle est mesurée à la
  // source : deux chemins du MÊME rôle, dont la nature de cache diffère, ne diffèrent QUE par elle.
  const coquille = enTetes("shell", DOCUMENT_DE_COQUILLE);
  const epingle = enTetes("shell", ARTEFACT_EPINGLE);
  assert.notEqual(coquille["Cache-Control"], epingle["Cache-Control"]);
  for (const nom of Object.keys(coquille)) {
    if (nom === "Cache-Control") continue;
    assert.equal(
      epingle[nom],
      coquille[nom],
      `${nom} diverge entre deux chemins de la coquille : la politique de cache a débordé`,
    );
  }
  assert.deepEqual(Object.keys(epingle).sort(), Object.keys(coquille).sort());
});

test("le durcissement de l'ADR 0022 traverse l'épinglage v86 sans être entamé", () => {
  const epingle = enTetes("shell", ARTEFACT_EPINGLE);
  assert.match(epingle["Content-Security-Policy"], /worker-src 'self';/);
  assert.equal(epingle["Referrer-Policy"], "no-referrer");
  assert.equal(epingle["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(epingle["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(epingle["Strict-Transport-Security"], undefined);
});

// --- Ce que le TÉMOIN doit relever pour que le critère de l'issue ne soit pas décoratif ----------
//
// `npm run publier:check` doit vérifier la politique « sur les deux origines ». Un témoin qui ne
// relèverait qu'une nature d'artefact — ou qui en relèverait trois portant la même valeur — dirait
// « conforme » sans avoir jamais mesuré ce que la décision a de particulier : qu'elle DISTINGUE.
// Ces épreuves tiennent le verdict du témoin par le bas, sans navigateur.

/** Une mesure conforme du témoin, dont chaque épreuve ne dégrade qu'un point. */
function mesureConforme() {
  return {
    moteur: "chromium",
    coquille: { ecarts: [], recus: {} },
    application: { ecarts: [], cspApplicativeSolitaire: ["frame-ancestors http://x"], recus: {} },
    demarrage: "worker:ready",
    openerAvecCoop: true,
    openerSansCoop: false,
    politiqueDeCache: NATURES_RELEVEES_PAR_LE_TEMOIN.map((releve) => ({
      ...releve,
      attendu: POLITIQUES_DE_CACHE[releve.nature],
      recu: POLITIQUES_DE_CACHE[releve.nature],
    })),
  };
}

test("le témoin relève CHAQUE nature décidée, sur les deux arbres, dont une hors de la racine", () => {
  const arbres = new Set(NATURES_RELEVEES_PAR_LE_TEMOIN.map(({ arbre }) => arbre));
  const natures = new Set(NATURES_RELEVEES_PAR_LE_TEMOIN.map(({ nature }) => nature));
  assert.deepEqual([...arbres].sort(), ["application", "coquille"]);
  // Relevé par la campagne de mutation de #103 : retirer le relevé de l'épinglage v86 survivait,
  // parce que les deux natures restantes suffisaient au verdict. Or c'est la SEULE dont la règle
  // dépend du chemin — sans elle, rien de ce que l'ADR 0023 apporte n'est mesuré sur HTTP réel.
  assert.deepEqual(
    [...natures].sort(),
    Object.keys(POLITIQUES_DE_CACHE).sort(),
    "une nature décidée que le témoin ne relève pas n'est publiée que sur parole",
  );
  assert.ok(
    NATURES_RELEVEES_PAR_LE_TEMOIN.some(({ chemin }) => chemin !== "/index.html"),
    "sans un chemin autre que la racine, le témoin ne mesurerait jamais la règle la plus précise",
  );
  for (const { chemin } of NATURES_RELEVEES_PAR_LE_TEMOIN) {
    assert.ok(chemin.startsWith("/"), "le témoin relève un CHEMIN servi, pas une intention");
  }
});

test("le témoin est CONFORME quand chaque nature reçoit la politique de sa nature", () => {
  assert.deepEqual(verdict(mesureConforme()), { moteur: "chromium", conforme: true, motifs: [] });
});

test("un écart de politique de cache sur UNE nature suffit à faire échouer le témoin", () => {
  for (let index = 0; index < NATURES_RELEVEES_PAR_LE_TEMOIN.length; index += 1) {
    const mesure = mesureConforme();
    // `max-age=600` n'est pas une valeur inventée : c'est celle que le spike #45 a mesurée sur
    // GitHub Pages, hébergeur qui impose sa propre politique de cache. C'est le mode de panne réel
    // que ce relevé doit attraper — pas une valeur absurde qu'aucun hébergeur ne servirait.
    mesure.politiqueDeCache[index].recu = "max-age=600";
    const { conforme, motifs } = verdict(mesure);
    assert.equal(conforme, false, `l'écart sur la nature ${index} passe inaperçu`);
    assert.ok(motifs.some((motif) => motif.includes(mesure.politiqueDeCache[index].chemin)));
  }
});

test("un témoin qui ne relèverait qu'une seule nature est REFUSÉ, pas conforme", () => {
  const mesure = mesureConforme();
  mesure.politiqueDeCache = mesure.politiqueDeCache.slice(0, 1);
  const { conforme, motifs } = verdict(mesure);
  assert.equal(conforme, false);
  assert.ok(
    motifs.some((motif) => motif.includes("au moins DEUX natures")),
    "le motif doit nommer ce qui manque : une nature d'artefact de plus",
  );
});

test("un témoin dont toutes les natures porteraient la MÊME valeur est refusé", () => {
  // C'est le mode de panne d'une décision « par nature » qui n'en serait pas une : trois relevés,
  // une seule politique, et un témoin vert qui ne mesure rien.
  const mesure = mesureConforme();
  mesure.politiqueDeCache = mesure.politiqueDeCache.map((releve) => ({
    ...releve,
    attendu: "no-store",
    recu: "no-store",
  }));
  const { conforme, motifs } = verdict(mesure);
  assert.equal(conforme, false);
  assert.ok(motifs.some((motif) => motif.includes("politique(s) de cache distincte(s)")));
});
