/**
 * Épreuves des DÉCISIONS de publication : ce qui est servi, ce qui ne l'est pas, et sous quels
 * en-têtes (#45, ADR 0017).
 *
 * L'épreuve centrale est la première, et elle est de nature différente des autres : elle relève le
 * dépôt RÉEL et exige que chaque fichier de `public/` et de `src/` soit soit publié, soit exclu par
 * un motif écrit. C'est un CLIQUET, sur le modèle de `tests/unit/taille-des-fichiers.test.mjs` : un
 * banc ajouté demain sous `public/` fera échouer cette épreuve tant que personne n'aura décidé s'il
 * est du produit. `docs/release-policy.md` exige que « les surfaces de mesure soient exclues de
 * l'artefact publié » ; une liste que rien ne mesure ne tiendrait pas trois tranches.
 *
 * Les épreuves d'en-têtes, elles, vérifient une propriété d'ARCHITECTURE : la publication ne
 * réécrit pas la politique de sécurité, elle la dérive de `tools/serve-headers.mjs`. Une CSP
 * recopiée à la main dans un fichier de configuration divergerait de celle que
 * `tests/browser/csp-frontiere.spec.mjs` mesure, et les deux vérités auraient l'air vraies.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARBRES,
  EXCLUSIONS,
  RACINES_SOUS_INVENTAIRE,
  estPublie,
  motifDExclusion,
} from "../../tools/publier-arborescences.mjs";
import {
  DIMENSION_NON_UNIFORME,
  EN_TETES_AJOUTES_PAR_LA_PUBLICATION,
  MARQUE_ORIGINE,
  cheminsHorsFideliteDuFichier,
  cheminsHorsPolitiqueUniforme,
  cheminsHorsUniformite,
  enTetesDePublication,
  origineDeLArbre,
  rendreFichierHeaders,
  signatureDeComparaison,
} from "../../tools/publier-en-tetes.mjs";
import { empreinte } from "../../tools/publier-inventaire.mjs";
import { analyserHeaders, enTetesPour } from "../../tools/publier-servir.mjs";
import { estUnBanc } from "../../tools/publier.mjs";
import {
  PREFIXE_EPINGLAGE_V86,
  securityHeaders,
  shellContentSecurityPolicy,
} from "../../tools/serve-headers.mjs";

/** Origines de démonstration, distinctes des valeurs par défaut : le test ne doit pas passer par
 *  accident parce qu'il compare deux fois la même constante. */
const ORIGINES = Object.freeze({
  origineCoquille: "https://coquille.epreuve",
  origineApplication: "https://app.epreuve",
});

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Relève tous les fichiers d'une racine du dépôt, chemins à séparateurs « / ». */
async function relever(racine) {
  const entrees = await readdir(path.join(REPO_ROOT, racine), {
    recursive: true,
    withFileTypes: true,
  });
  return entrees
    .filter((entree) => entree.isFile())
    .map((entree) => {
      const absolu = path.join(entree.parentPath ?? entree.path, entree.name);
      return path.relative(REPO_ROOT, absolu).replaceAll("\\", "/");
    });
}

const releve = (await Promise.all(RACINES_SOUS_INVENTAIRE.map(relever))).flat();

test("le relevé porte bien sur les surfaces servies par le dépôt", () => {
  assert.ok(releve.length > 0, "aucun fichier relevé : le périmètre est inopérant");
  assert.ok(
    releve.some((chemin) => chemin.startsWith("public/")),
    "aucun fichier de `public/` relevé",
  );
});

test("aucune surface de `public/` ni de `src/` n'échappe à la décision de publication", () => {
  const sansDecision = releve
    .filter((chemin) => !estPublie(chemin) && motifDExclusion(chemin) === null)
    .sort();

  assert.deepEqual(
    sansDecision,
    [],
    "Ces fichiers ne sont ni publiés ni exclus. Décidez : ajoutez-les à `SOURCES_COQUILLE` si ce " +
      "sont des artefacts du produit, ou à `EXCLUSIONS` avec le motif qui les en retire.",
  );
});

test("chaque exclusion décidée retire une surface qui existe encore", () => {
  const perimees = EXCLUSIONS.filter(
    ({ prefixe }) => !releve.some((chemin) => chemin === prefixe || chemin.startsWith(prefixe)),
  ).map(({ prefixe }) => prefixe);

  assert.deepEqual(
    perimees,
    [],
    "Ces exclusions ne retirent plus rien : la surface a disparu. Retirez l'inscription.",
  );
});

test("les bancs de mesure nommés par `release-policy.md` sont exclus, avec leur motif", () => {
  for (const banc of [
    "public/csp/frontiere.html",
    "public/spike/origin/app.html",
    "public/vm/index.html",
    "public/compat.html",
  ]) {
    const motif = motifDExclusion(banc);
    assert.ok(motif !== null, `${banc} n'est retiré par aucun motif`);
    assert.ok(motif.length > 20, `le motif de ${banc} n'explique rien`);
    assert.equal(estPublie(banc), false, `${banc} est à la fois publié et exclu`);
  }
});

test("le runtime et le contrat page ↔ Worker sont publiés, eux", () => {
  for (const artefact of [
    "public/index.html",
    "public/main.mjs",
    "public/runtime-worker.mjs",
    "src/runtime-contract.mjs",
    "src/vm/volume-manifest.mjs",
  ]) {
    assert.equal(estPublie(artefact), true, `${artefact} n'est publié par aucune source`);
    assert.equal(motifDExclusion(artefact), null, `${artefact} est aussi exclu`);
  }
});

test("l'origine applicative ne publie aucun artefact du dépôt (ADR 0002)", () => {
  const application = ARBRES.find(({ nom }) => nom === "application");
  assert.deepEqual([...application.sources], []);
  assert.ok(
    application.placeTenante.contenu.includes("place tenante"),
    "le document de l'origine applicative doit se déclarer comme place tenante",
  );
});

test("la CSP publiée est CELLE de `tools/serve-headers.mjs`, pas une copie", () => {
  const enTetes = enTetesDePublication("coquille", ORIGINES);
  assert.equal(
    enTetes["Content-Security-Policy"],
    shellContentSecurityPolicy(ORIGINES.origineApplication),
  );
  assert.match(enTetes["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(enTetes["Content-Security-Policy"], /worker-src 'self';/);
  assert.ok(
    !enTetes["Content-Security-Policy"].includes("blob:"),
    "la politique élargie du harnais de mesure ne doit jamais atteindre une publication",
  );
});

test("la publication n'ajoute que les en-têtes DÉCLARÉS, et rien d'autre", () => {
  for (const arbre of ["coquille", "application"]) {
    const servis = securityHeaders({
      role: arbre === "coquille" ? "shell" : "app",
      pathname: "/index.html",
      isolation: null,
      appOrigin: ORIGINES.origineApplication,
    });
    const publies = enTetesDePublication(arbre, ORIGINES);

    const attendus = EN_TETES_AJOUTES_PAR_LA_PUBLICATION.filter(
      (ajout) => ajout.arbre === arbre,
    ).map(({ nom }) => nom);
    assert.deepEqual(
      Object.keys(publies)
        .filter((nom) => !(nom in servis))
        .sort(),
      [...attendus].sort(),
      `l'arbre « ${arbre} » ajoute un en-tête que la table ne déclare pas — il lui faut un ADR`,
    );
    for (const [nom, valeur] of Object.entries(servis)) {
      const remplace = attendus.includes(nom);
      if (!remplace) {
        assert.equal(publies[nom], valeur, `${nom} diverge de ce que sert le serveur de test`);
      }
    }
  }
});

test("chaque en-tête ajouté porte l'ADR qui l'a décidé et le motif qui le justifie", () => {
  assert.equal(EN_TETES_AJOUTES_PAR_LA_PUBLICATION.length, 2);
  for (const ajout of EN_TETES_AJOUTES_PAR_LA_PUBLICATION) {
    assert.match(ajout.decidePar, /ADR \d{4}/u);
    assert.ok(ajout.motif.length > 80, `le motif de ${ajout.nom} n'argumente rien`);
  }
});

test("COOP est posé sur la coquille SEULE : il serait sans effet sur un document encadré", () => {
  assert.equal(
    enTetesDePublication("coquille", ORIGINES)["Cross-Origin-Opener-Policy"],
    "same-origin",
  );
  assert.equal(
    enTetesDePublication("application", ORIGINES)["Cross-Origin-Opener-Policy"],
    undefined,
  );
});

test("l'origine applicative reçoit `frame-ancestors` nommant la coquille, et RIEN d'autre", () => {
  const enTetes = enTetesDePublication("application", ORIGINES);
  assert.equal(
    enTetes["Content-Security-Policy"],
    `frame-ancestors ${ORIGINES.origineCoquille}`,
    "sans elle, le document applicatif — qui porte les cookies de session — est encadrable par " +
      "n'importe quel site",
  );
  // Une directive de plus signifierait que la politique de la coquille a débordé sur le territoire
  // applicatif, ce que l'ADR 0002 refuse : `frame-ancestors` ne contraint pas ce que le guest rend.
  assert.deepEqual(enTetes["Content-Security-Policy"].split(";").length, 1);
  assert.equal(enTetes["Cross-Origin-Resource-Policy"], "cross-origin");
});

test("`frame-ancestors` de l'application suit l'origine de la coquille, jamais une constante", () => {
  const autre = enTetesDePublication("application", {
    ...ORIGINES,
    origineCoquille: "https://ailleurs.exemple",
  });
  assert.equal(autre["Content-Security-Policy"], "frame-ancestors https://ailleurs.exemple");
});

test("aucun COEP n'est publié : l'ADR 0010 l'écarte, l'ADR 0017 ne le rouvre pas", () => {
  for (const arbre of ["coquille", "application"]) {
    assert.equal(enTetesDePublication(arbre)["Cross-Origin-Embedder-Policy"], undefined);
  }
});

// --- En-têtes de durcissement générique (#104, ADR 0022) ---------------------------------------
//
// Le risque résiduel n°7 de l'ADR 0017 relevait qu'aucun n'était publié, et que cette absence
// n'était pas une décision mais la conséquence mécanique de la règle « rien de plus que ce que sert
// le serveur de test ». L'ADR 0022 les décide DANS la source de vérité ; ces épreuves vérifient que
// la publication les en DÉRIVE, et qu'elle n'en a pas fait un troisième ajout à sa propre table.

test("les en-têtes de durcissement publiés sont CEUX du serveur de test, pas une copie", () => {
  const servis = securityHeaders({
    role: "shell",
    pathname: "/index.html",
    isolation: null,
    appOrigin: ORIGINES.origineApplication,
  });
  const publies = enTetesDePublication("coquille", ORIGINES);
  assert.equal(publies["Referrer-Policy"], servis["Referrer-Policy"]);
  assert.equal(publies["Permissions-Policy"], servis["Permissions-Policy"]);
  // La valeur elle-même est éprouvée par `tests/unit/entetes-de-durcissement.test.mjs` ; ici, ce
  // qui est éprouvé est qu'elle TRAVERSE la publication sans être réécrite.
  assert.equal(publies["Referrer-Policy"], "no-referrer");
  assert.equal(publies["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
});

test("le durcissement n'est PAS un ajout de la publication : il vient de la source de vérité", () => {
  // Si ces en-têtes figuraient dans `EN_TETES_AJOUTES_PAR_LA_PUBLICATION`, ils seraient servis en
  // production sans l'être en développement — la divergence exacte que l'ADR 0017 § 2 évite, et
  // qui rendrait muettes les épreuves de frontière qui mesurent `tools/serve-headers.mjs`.
  const ajoutes = EN_TETES_AJOUTES_PAR_LA_PUBLICATION.map(({ nom }) => nom);
  assert.ok(!ajoutes.includes("Referrer-Policy"));
  assert.ok(!ajoutes.includes("Permissions-Policy"));
});

test("l'origine applicative ne publie ni `Referrer-Policy` ni `Permissions-Policy` (ADR 0022)", () => {
  const application = enTetesDePublication("application", ORIGINES);
  assert.equal(application["Referrer-Policy"], undefined);
  assert.equal(application["Permissions-Policy"], undefined);
});

test("aucun HSTS n'est publié : l'ADR 0022 l'écarte, et c'est une obligation d'exploitant", () => {
  for (const arbre of ["coquille", "application"]) {
    assert.equal(enTetesDePublication(arbre, ORIGINES)["Strict-Transport-Security"], undefined);
  }
});

test("une valeur d'en-tête portant des virgules survit à l'aller-retour du `_headers`", () => {
  // `Permissions-Policy: camera=(), microphone=(), geolocation=()` est la première valeur publiée
  // qui contient des virgules et des parenthèses. Le format `_headers` n'est pas un standard : la
  // relire par l'analyseur qui la sert est la seule façon de savoir qu'elle traverse.
  const relu = enTetesPour(
    analyserHeaders(rendreFichierHeaders("coquille", ORIGINES)),
    "/index.html",
  );
  assert.equal(relu["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(relu["Referrer-Policy"], "no-referrer");
});

test("un arbre inconnu est refusé plutôt que servi sans politique", () => {
  assert.throws(() => enTetesDePublication("banc"), /Arbre inconnu/u);
});

test("le fichier `_headers` produit est relu à l'identique par le serveur qui l'applique", () => {
  for (const arbre of ["coquille", "application"]) {
    const rendu = rendreFichierHeaders(arbre, ORIGINES);
    assert.deepEqual(
      enTetesPour(analyserHeaders(rendu), "/index.html"),
      enTetesDePublication(arbre, ORIGINES),
    );
  }
});

test("le serveur du témoin sait retirer un en-tête, ce qui rend le témoin négatif possible", () => {
  const regles = analyserHeaders(rendreFichierHeaders("coquille", ORIGINES));
  const sansCoop = enTetesPour(regles, "/index.html", ["Cross-Origin-Opener-Policy"]);
  assert.equal(sansCoop["Cross-Origin-Opener-Policy"], undefined);
  assert.ok(sansCoop["Content-Security-Policy"], "seul l'en-tête nommé doit disparaître");
});

// --- L'origine de l'arbre entre dans l'empreinte (revue de sécurité de #45) ------------------
//
// La revue a mesuré que deux constructions d'origines de coquille DIFFÉRENTES rendaient la même
// empreinte de racine : l'origine propre d'un arbre n'apparaissait que dans `inventaire.json`,
// fichier explicitement hors de sa propre empreinte. Une bascule d'origine — une MIGRATION au sens
// de l'ADR 0009, où l'OPFS de l'ancienne origine devient inatteignable — passait donc inaperçue à
// la comparaison d'empreintes de la procédure de retour arrière.

test("le fichier `_headers` inscrit l'origine de SON arbre, dans un octet servi", () => {
  for (const arbre of ["coquille", "application"]) {
    const rendu = rendreFichierHeaders(arbre, ORIGINES);
    assert.ok(
      rendu.includes(`${MARQUE_ORIGINE}${origineDeLArbre(arbre, ORIGINES)}`),
      `l'arbre « ${arbre} » ne déclare pas son origine dans un octet publié`,
    );
  }
});

test("changer l'origine de la COQUILLE change l'empreinte des DEUX fichiers `_headers`", () => {
  const ailleurs = { ...ORIGINES, origineCoquille: "https://ailleurs.exemple" };
  for (const arbre of ["coquille", "application"]) {
    assert.notEqual(
      empreinte(rendreFichierHeaders(arbre, ORIGINES)),
      empreinte(rendreFichierHeaders(arbre, ailleurs)),
      `l'arbre « ${arbre} » rend la même empreinte sous deux origines de coquille : une bascule ` +
        "d'origine passerait pour un redéploiement",
    );
  }
});

test("changer l'origine de l'APPLICATION change l'empreinte des deux fichiers `_headers`", () => {
  const ailleurs = { ...ORIGINES, origineApplication: "https://autre-app.exemple" };
  for (const arbre of ["coquille", "application"]) {
    assert.notEqual(
      empreinte(rendreFichierHeaders(arbre, ORIGINES)),
      empreinte(rendreFichierHeaders(arbre, ailleurs)),
    );
  }
});

test("le commentaire d'origine est un commentaire : il ne devient pas un en-tête servi", () => {
  const relu = enTetesPour(
    analyserHeaders(rendreFichierHeaders("coquille", ORIGINES)),
    "/index.html",
  );
  assert.ok(
    !Object.keys(relu).some((nom) => nom.toLowerCase().includes("origine")),
    "la marque d'origine doit rester inerte pour l'hébergeur",
  );
});

test("un arbre est un BANC dès qu'une de ses origines n'est pas https", () => {
  assert.equal(estUnBanc(ORIGINES), false);
  assert.equal(
    estUnBanc({
      origineCoquille: "http://127.0.0.1:4193",
      origineApplication: "https://app.exemple",
    }),
    true,
  );
  assert.equal(
    estUnBanc({
      origineCoquille: "https://vault.exemple",
      origineApplication: "http://localhost:4194",
    }),
    true,
  );
  assert.equal(
    estUnBanc({ origineCoquille: "pas-une-url", origineApplication: "https://a.b" }),
    true,
  );
});

test("aucun chemin publiable ne reçoit du serveur de test une politique différente de la racine", () => {
  const cheminsCoquille = [
    "index.html",
    "main.mjs",
    "runtime-worker.mjs",
    "src/vm/volume-manifest.mjs",
    "vendor/v86/artefacts/v86.wasm",
  ];
  assert.deepEqual(cheminsHorsPolitiqueUniforme("coquille", cheminsCoquille), []);
});

test("un chemin de banc, s'il se glissait dans l'arbre, briserait l'uniformité annoncée", () => {
  assert.deepEqual(cheminsHorsPolitiqueUniforme("coquille", ["compat.html"]), ["compat.html"]);
});

// --- Politique de cache par nature d'artefact (#103, ADR 0023) ----------------------------------
//
// Le risque résiduel n°1 de l'ADR 0017 relevait que `Cache-Control: no-store` partait en production
// par conséquence mécanique, non par décision. L'ADR 0023 la décide par NATURE D'ARTEFACT, dans la
// source de vérité — donc le fichier `_headers` doit désormais porter PLUSIEURS blocs. Ces épreuves
// vérifient trois choses : que le fichier les porte, que le serveur qui l'applique en tire la règle
// la plus précise, et que la seule dimension autorisée à varier est bien la seule qui varie.

/** Ne garde que le PREMIER bloc de motif d'un fichier `_headers`, en jetant les suivants. */
function garderLePremierBloc(texte) {
  const lignes = texte.split("\n");
  const debuts = lignes.reduce(
    (indices, ligne, index) => (ligne.startsWith("/") ? [...indices, index] : indices),
    [],
  );
  assert.ok(debuts.length >= 2, "le fichier n'a qu'un bloc : l'amputation ne prouverait rien");
  return `${lignes.slice(0, debuts[1]).join("\n")}\n`;
}

test("le fichier `_headers` de la coquille porte PLUSIEURS blocs, dont celui de l'épinglage", () => {
  const motifs = analyserHeaders(rendreFichierHeaders("coquille", ORIGINES)).map(
    ({ motif }) => motif,
  );
  assert.deepEqual(motifs, ["/*", `${PREFIXE_EPINGLAGE_V86}*`]);
  // L'arbre applicatif n'a qu'une nature à servir : un second bloc y serait une politique recopiée
  // d'un arbre à l'autre.
  assert.deepEqual(
    analyserHeaders(rendreFichierHeaders("application", ORIGINES)).map(({ motif }) => motif),
    ["/*"],
  );
});

test("chaque bloc du `_headers` est COMPLET : aucune sémantique de fusion n'est supposée", () => {
  // Le format `_headers` n'est pas un standard. Cloudflare Pages et Netlify cumulent les règles qui
  // correspondent, la dernière l'emportant ; rien ne garantit qu'un troisième hébergeur le fasse.
  // Un bloc précis qui ne porterait que `Cache-Control` retirerait alors la CSP aux artefacts v86
  // chez cet hébergeur-là. Chaque bloc porte donc TOUS les en-têtes, et le fichier rend le même
  // résultat sous les deux sémantiques.
  const attendus = Object.keys(enTetesDePublication("coquille", ORIGINES)).sort();
  for (const { motif, enTetes } of analyserHeaders(rendreFichierHeaders("coquille", ORIGINES))) {
    assert.deepEqual(
      enTetes.map(([nom]) => nom).sort(),
      attendus,
      `le bloc « ${motif} » est incomplet : il dépendrait de la fusion pour être correct`,
    );
  }
});

test("le serveur qui applique le fichier retient la règle la PLUS PRÉCISE", () => {
  const regles = analyserHeaders(rendreFichierHeaders("coquille", ORIGINES));
  assert.equal(enTetesPour(regles, "/index.html")["Cache-Control"], "no-cache");
  assert.equal(
    enTetesPour(regles, "/vendor/v86/MANIFEST.json")["Cache-Control"],
    "public, max-age=86400",
  );
  assert.equal(
    enTetesPour(regles, "/vendor/v86/artefacts/v86.wasm")["Cache-Control"],
    "public, max-age=86400",
  );
  // Un chemin qui commence par la même chaîne SANS être sous le préfixe ne doit pas l'attraper.
  assert.equal(enTetesPour(regles, "/vendor/v86-autre/x.mjs")["Cache-Control"], "no-cache");
});

test("les DEUX origines publient une politique de cache, et ce n'est pas la même", () => {
  const coquille = analyserHeaders(rendreFichierHeaders("coquille", ORIGINES));
  const application = analyserHeaders(rendreFichierHeaders("application", ORIGINES));
  assert.equal(enTetesPour(application, "/index.html")["Cache-Control"], "no-store");
  assert.notEqual(
    enTetesPour(coquille, "/index.html")["Cache-Control"],
    enTetesPour(application, "/index.html")["Cache-Control"],
  );
});

test("la dimension non uniforme est UNE, nommée, et ce n'est aucun en-tête de sécurité", () => {
  assert.equal(DIMENSION_NON_UNIFORME, "Cache-Control");
  const compares = Object.keys(enTetesDePublication("coquille", ORIGINES)).filter(
    (nom) => nom !== DIMENSION_NON_UNIFORME,
  );
  for (const nom of [
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Resource-Policy",
    "X-Content-Type-Options",
  ]) {
    assert.ok(compares.includes(nom), `${nom} est sorti de la comparaison du cliquet`);
  }
});

test("la comparaison du cliquet bouge si l'on altère N'IMPORTE LEQUEL des en-têtes gardés", () => {
  // Relevé par la campagne de mutation de #103 : sortir la SEULE CSP de la comparaison survivait à
  // toute la suite, parce que le seul chemin dissident du dépôt — `compat.html` — diverge sur trois
  // en-têtes à la fois. Un affaiblissement par en-tête passait donc inaperçu. Ici, chaque en-tête
  // est altéré SEUL, et la signature doit bouger pour chacun.
  const base = enTetesDePublication("coquille", ORIGINES);
  const reference = signatureDeComparaison(base);
  for (const nom of Object.keys(base)) {
    if (nom === DIMENSION_NON_UNIFORME) continue;
    assert.notEqual(
      signatureDeComparaison({ ...base, [nom]: "altéré" }),
      reference,
      `${nom} est sorti de la comparaison du cliquet : une divergence sur lui passerait`,
    );
  }
  // Et l'inverse, sans quoi la dimension déclarée non uniforme ne le serait pas vraiment.
  assert.equal(signatureDeComparaison({ ...base, [DIMENSION_NON_UNIFORME]: "altéré" }), reference);
});

test("le cliquet d'uniformité MORD ENCORE sur les en-têtes de sécurité", () => {
  // `compat.html` est exempté de la CSP, de `Referrer-Policy` et de `Permissions-Policy` par
  // `isShellDocument` (ADR 0022) et reçoit la MÊME politique de cache que la racine : si le cliquet
  // avait été affaibli en laissant passer toute divergence, ce chemin passerait.
  assert.deepEqual(cheminsHorsUniformite("coquille", ["compat.html"]), ["compat.html"]);
  assert.equal(
    securityHeaders({
      role: "shell",
      pathname: "/compat.html",
      isolation: null,
      appOrigin: ORIGINES.origineApplication,
    })["Cache-Control"],
    "no-cache",
    "si la politique de cache de `compat.html` différait, l'épreuve ci-dessus ne prouverait plus " +
      "que le cliquet mord sur les en-têtes de sécurité",
  );
});

test("le cliquet d'uniformité NE MORD PLUS sur la seule dimension déclarée non uniforme", () => {
  assert.deepEqual(cheminsHorsUniformite("coquille", ["vendor/v86/MANIFEST.json"]), []);
});

test("le cliquet de fidélité refuse un `_headers` qui ne rendrait pas ce que sert la source", () => {
  const complet = rendreFichierHeaders("coquille", ORIGINES);
  const ampute = garderLePremierBloc(complet);
  assert.deepEqual(
    cheminsHorsFideliteDuFichier("coquille", ["vendor/v86/MANIFEST.json"], ORIGINES, ampute),
    ["vendor/v86/MANIFEST.json"],
    "un fichier amputé de son bloc épinglé annoncerait `no-cache` là où le serveur sert un cache " +
      "long : la publication mentirait sur ce que l'hébergeur doit servir",
  );
  assert.deepEqual(
    cheminsHorsFideliteDuFichier("coquille", ["vendor/v86/MANIFEST.json"], ORIGINES, complet),
    [],
  );
});

test("le refus de publication réunit les deux cliquets", () => {
  assert.deepEqual(cheminsHorsPolitiqueUniforme("coquille", ["compat.html"]), ["compat.html"]);
  assert.deepEqual(
    cheminsHorsPolitiqueUniforme("coquille", [
      "index.html",
      "vendor/v86/MANIFEST.json",
      "vendor/v86/artefacts/v86.wasm",
    ]),
    [],
  );
});
