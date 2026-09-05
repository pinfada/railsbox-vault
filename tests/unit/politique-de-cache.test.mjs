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

import {
  ADRESSE_ABSENTE_DU_TEMOIN,
  NATURES_RELEVEES_PAR_LE_TEMOIN,
  verdict,
} from "../../tools/publier-temoin.mjs";
import { ADRESSE_MANIFESTE_V86, adresseDe } from "../../src/v86-adresses.mjs";
import {
  DUREE_EPINGLAGE_V86_SECONDES,
  POLITIQUE_DABSENCE,
  NATURES_DARTEFACT,
  POLITIQUES_DE_CACHE,
  PREFIXE_EPINGLAGE_V86,
  natureDArtefact,
  enTetesDAbsence,
  politiqueDeCache,
  securityHeaders,
} from "../../tools/serve-headers.mjs";

const ORIGINE_APPLICATIVE = "http://localhost:4174";

/** Un chemin de chaque nature, nommé une fois pour que les épreuves parlent de la même chose. */
const DOCUMENT_DE_COQUILLE = "/index.html";
const MODULE_DE_COQUILLE = "/src/vm/volume-manifest.mjs";
const ARTEFACT_EPINGLE = adresseDe("v86.wasm", "8a".repeat(32));
const MANIFESTE_EPINGLAGE = ADRESSE_MANIFESTE_V86;
const LICENCE_V86 = "/vendor/v86/LICENSE-v86.txt";
const TERRITOIRE_APPLICATIF = "/spike/origin/app-inter.html";
const SONDE_DE_CAPACITES = "/compat.html";
/** Un chemin qu'aucune règle ne nomme : la nature qu'il reçoit est celle du DÉFAUT. */
const CHEMIN_INCONNU = "/inconnu/futur.bin";

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

test("un chemin qu'aucune règle ne nomme tombe dans le SÛR, pas dans le permissif", () => {
  // La table est une liste de cas particuliers autour d'un défaut, et c'est le défaut qui décide du
  // sort de tout ce qui sera ajouté au dépôt demain sans que personne y pense. `no-cache` autorise
  // le stockage mais interdit le réemploi muet : un chemin non classé est revalidé, jamais servi
  // vingt-quatre heures depuis un cache partagé. Une table dont le défaut serait `epinglage-v86`
  // aurait le comportement inverse, et rien ne le dirait.
  assert.equal(
    natureDArtefact({ role: "shell", pathname: CHEMIN_INCONNU }),
    NATURES_DARTEFACT.coquille,
  );
  assert.equal(politiqueDeCache({ role: "shell", pathname: CHEMIN_INCONNU }), "no-cache");
  assert.equal(politiqueDeCache({ role: "app", pathname: CHEMIN_INCONNU }), "no-store");
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

test("les artefacts adressés par empreinte sont IMMUABLES, et pour un an", () => {
  // C'est le renversement de #123, et il ne tient qu'à une chose : l'adresse nomme l'empreinte.
  // Un ré-épinglage DÉPLACE l'artefact, si bien qu'un navigateur qui garderait l'ancienne adresse
  // pour toujours ne la demanderait plus jamais. `tests/unit/v86-reepinglage.test.mjs` déroule
  // cette séquence, et `verifierEpinglageV86` la mesure sur l'arbre publié avant qu'il ne parte.
  assert.equal(DUREE_EPINGLAGE_V86_SECONDES, 31536000);
  assert.equal(
    enTetes("shell", ARTEFACT_EPINGLE)["Cache-Control"],
    "public, max-age=31536000, immutable",
  );
});

test("`immutable` n'est servi QUE sous le préfixe dont chaque adresse nomme son empreinte", () => {
  // La moitié dangereuse de la décision. `immutable` promet qu'aucune revalidation n'aura jamais
  // lieu : servi à une adresse stable, il interdirait au navigateur de s'apercevoir d'une mise à
  // jour, y compris de sécurité. Une seule nature a le droit de le porter.
  const immuables = Object.entries(POLITIQUES_DE_CACHE).filter(([, valeur]) =>
    valeur.includes("immutable"),
  );
  assert.deepEqual(
    immuables.map(([nature]) => nature),
    [NATURES_DARTEFACT.epinglageV86],
  );
  assert.ok(ARTEFACT_EPINGLE.startsWith(PREFIXE_EPINGLAGE_V86));
});

test("le MANIFESTE et les licences ne sont PAS immuables : ils sont revalidés", () => {
  // Le manifeste est l'INDIRECTION par laquelle un chargeur apprend les adresses. Une copie gardée
  // désignerait des adresses qui ne sont plus servies — un 404 franc, pas une exécution périmée —,
  // et c'est ce qui l'exclut du préfixe immuable. `no-cache` autorise le stockage et impose la
  // revalidation : le coût d'une montée de version est un aller-retour de cinq kibioctets, pas le
  // re-téléchargement des 9,9 Mio qu'il décrit.
  for (const chemin of [MANIFESTE_EPINGLAGE, LICENCE_V86]) {
    assert.ok(!chemin.startsWith(PREFIXE_EPINGLAGE_V86));
    assert.equal(enTetes("shell", chemin)["Cache-Control"], "no-cache");
  }
  assert.notEqual(
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
    absence: { chemin: ADRESSE_ABSENTE_DU_TEMOIN, statut: 404, recu: "no-store" },
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

// --- Une ADRESSE ABSENTE sous le préfixe immuable (constat 1 de la revue de sécurité) -------------

test("une absence n'est JAMAIS cachable, quel que soit le chemin", () => {
  // `Cache-Control` gouverne une RÉPONSE ; le format `_headers` associe des en-têtes à un CHEMIN.
  // Sous le préfixe immuable, un chemin qui n'existe pas encore relève donc de la règle d'un an
  // comme s'il existait — et un 404 est stockable par défaut, qu'un `max-age` rend frais et
  // qu'`immutable` dispense de revalider jusqu'au rechargement forcé. Les serveurs du dépôt
  // refusent de rendre une absence cachable, sur TOUS les chemins.
  assert.equal(POLITIQUE_DABSENCE, "no-store");
  assert.deepEqual(enTetesDAbsence(), { "Cache-Control": "no-store" });
  // Elle rejoint celle du territoire applicatif, et c'est cohérent : dans les deux cas, rien de ce
  // qui est rendu ne doit s'attarder. Ce dont elle doit se distinguer est la politique IMMUABLE,
  // celle du chemin sous lequel l'absence est servie — sans quoi ce refus ne refuserait rien.
  assert.notEqual(POLITIQUE_DABSENCE, POLITIQUES_DE_CACHE[NATURES_DARTEFACT.epinglageV86]);
  assert.ok(!POLITIQUE_DABSENCE.includes("immutable"));
});

test("le témoin RELÈVE l'absence, et un 404 cachable le fait échouer", () => {
  const conforme = mesureConforme();
  assert.ok(conforme.absence.chemin.startsWith(PREFIXE_EPINGLAGE_V86));
  assert.equal(verdict(conforme).conforme, true);

  // Le mode de panne exact : l'hébergeur applique la règle du chemin avant de constater l'absence.
  const cachable = mesureConforme();
  cachable.absence.recu = "public, max-age=31536000, immutable";
  const refus = verdict(cachable);
  assert.equal(refus.conforme, false);
  assert.ok(refus.motifs.some((motif) => motif.includes("récupération côté client")));
});

test("un témoin qui ne relèverait PAS l'absence est refusé, pas conforme", () => {
  // Sans cette garde, retirer le relevé rendrait le témoin vert sans avoir mesuré ce que le
  // constat 1 a coûté à écrire.
  const mesure = mesureConforme();
  delete mesure.absence;
  const { conforme, motifs } = verdict(mesure);
  assert.equal(conforme, false);
  assert.ok(motifs.some((motif) => motif.includes("aucun relevé d'adresse absente")));
});

test("une adresse « absente » qui rendrait 200 est refusée : elle ne mesurerait rien", () => {
  const mesure = mesureConforme();
  mesure.absence.statut = 200;
  const { conforme, motifs } = verdict(mesure);
  assert.equal(conforme, false);
  assert.ok(motifs.some((motif) => motif.includes("devait être ABSENTE")));
});
