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
  EN_TETE_AJOUTE_PAR_LA_PUBLICATION,
  cheminsHorsPolitiqueUniforme,
  enTetesDePublication,
  rendreFichierHeaders,
} from "../../tools/publier-en-tetes.mjs";
import { analyserHeaders, enTetesPour } from "../../tools/publier-servir.mjs";
import { securityHeaders, shellContentSecurityPolicy } from "../../tools/serve-headers.mjs";

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
  const enTetes = enTetesDePublication("coquille", { origineApplication: "https://app.exemple" });
  assert.equal(
    enTetes["Content-Security-Policy"],
    shellContentSecurityPolicy("https://app.exemple"),
  );
  assert.match(enTetes["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(enTetes["Content-Security-Policy"], /worker-src 'self';/);
  assert.ok(
    !enTetes["Content-Security-Policy"].includes("blob:"),
    "la politique élargie du harnais de mesure ne doit jamais atteindre une publication",
  );
});

test("la publication n'ajoute QUE COOP à ce que sert le serveur de test", () => {
  const servis = securityHeaders({
    role: "shell",
    pathname: "/index.html",
    isolation: null,
    appOrigin: "https://app.exemple",
  });
  const publies = enTetesDePublication("coquille", { origineApplication: "https://app.exemple" });

  const ajoutes = Object.keys(publies).filter((nom) => !(nom in servis));
  assert.deepEqual(ajoutes, [EN_TETE_AJOUTE_PAR_LA_PUBLICATION.nom]);
  assert.equal(
    publies[EN_TETE_AJOUTE_PAR_LA_PUBLICATION.nom],
    EN_TETE_AJOUTE_PAR_LA_PUBLICATION.valeur,
  );
  for (const [nom, valeur] of Object.entries(servis)) {
    assert.equal(publies[nom], valeur, `${nom} diverge de ce que sert le serveur de test`);
  }
});

test("l'origine applicative ne reçoit ni CSP ni COOP, et garde CORP `cross-origin`", () => {
  const enTetes = enTetesDePublication("application");
  assert.equal(enTetes["Content-Security-Policy"], undefined);
  assert.equal(enTetes["Cross-Origin-Opener-Policy"], undefined);
  assert.equal(enTetes["Cross-Origin-Resource-Policy"], "cross-origin");
});

test("aucun COEP n'est publié : l'ADR 0010 l'écarte, l'ADR 0017 ne le rouvre pas", () => {
  for (const arbre of ["coquille", "application"]) {
    assert.equal(enTetesDePublication(arbre)["Cross-Origin-Embedder-Policy"], undefined);
  }
});

test("un arbre inconnu est refusé plutôt que servi sans politique", () => {
  assert.throws(() => enTetesDePublication("banc"), /Arbre inconnu/u);
});

test("le fichier `_headers` produit est relu à l'identique par le serveur qui l'applique", () => {
  const rendu = rendreFichierHeaders("coquille", { origineApplication: "https://app.exemple" });
  const relu = enTetesPour(analyserHeaders(rendu), "/index.html");
  assert.deepEqual(
    relu,
    enTetesDePublication("coquille", { origineApplication: "https://app.exemple" }),
  );
});

test("le serveur du témoin sait retirer un en-tête, ce qui rend le témoin négatif possible", () => {
  const regles = analyserHeaders(rendreFichierHeaders("coquille"));
  const sansCoop = enTetesPour(regles, "/index.html", ["Cross-Origin-Opener-Policy"]);
  assert.equal(sansCoop["Cross-Origin-Opener-Policy"], undefined);
  assert.ok(sansCoop["Content-Security-Policy"], "seul l'en-tête nommé doit disparaître");
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
