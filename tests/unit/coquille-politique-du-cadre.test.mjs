/**
 * LA POLITIQUE DU CADRE (#341, ADR 0052), mesurée sans navigateur.
 *
 * Ce fichier juge le SENS des deux politiques — celle que le Service Worker pose sur tout ce qu'il
 * sert, celle que le courtier porte par `<meta>` —, pas leur texte. Chaque voie de sortie est
 * gouvernée par une directive, et une directive absente se replie sur une autre (CSP niveau 3,
 * § 6.8) : l'évaluateur ci-dessous suit ces replis, si bien qu'une directive RETIRÉE qui laisserait
 * une voie sans garde rougit ici autant qu'une directive ÉLARGIE.
 *
 * Ce qu'il ne juge pas : que les trois moteurs appliquent ces politiques. C'est
 * `tests/browser/coquille-sorties-du-cadre.spec.mjs`, avec son témoin positif, qui le mesure — et
 * c'est lui seul qui tient le BRANCHEMENT du Service Worker (`avecLesEntetesDeLHebergeur`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ENTETES_DE_L_HEBERGEUR_APPLICATIF,
  ENTETES_IMPOSES_AU_CADRE,
  POLITIQUE_DU_CADRE,
  POLITIQUE_DU_COURTIER,
  entetesDeReponseRendues,
  imposerLesEntetesDuCadre,
} from "../../src/coquille/relais-http.mjs";

/** Une politique, directive → jetons. */
function lire(politique) {
  const directives = new Map();
  for (const brute of politique.split(";")) {
    const [nom, ...jetons] = brute.trim().split(/\s+/u);
    if (nom && !directives.has(nom.toLowerCase())) directives.set(nom.toLowerCase(), jetons);
  }
  return directives;
}

/**
 * Les REPLIS de CSP niveau 3 (§ 6.8.3), pour chaque directive qui gouverne une requête. La première
 * présente gouverne ; aucune présente, rien ne gouverne — la voie est OUVERTE.
 */
const REPLIS = Object.freeze({
  "connect-src": ["connect-src", "default-src"],
  "img-src": ["img-src", "default-src"],
  "font-src": ["font-src", "default-src"],
  "media-src": ["media-src", "default-src"],
  "manifest-src": ["manifest-src", "default-src"],
  "object-src": ["object-src", "default-src"],
  "script-src-elem": ["script-src-elem", "script-src", "default-src"],
  "script-src-attr": ["script-src-attr", "script-src", "default-src"],
  "style-src-elem": ["style-src-elem", "style-src", "default-src"],
  "style-src-attr": ["style-src-attr", "style-src", "default-src"],
  "frame-src": ["frame-src", "child-src", "default-src"],
  "worker-src": ["worker-src", "child-src", "script-src", "default-src"],
  // Ces deux-là n'ont AUCUN repli : absentes, elles n'interdisent rien.
  "form-action": ["form-action"],
  "base-uri": ["base-uri"],
});

/** Les jetons qui ne désignent AUCUNE origine tierce. */
const MOTS_CLES_SANS_SORTIE = new Set([
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
]);

/**
 * Les schémas LOCAUX : une ressource `data:` ou `blob:` ne quitte rien. Ils ne sont admis que là où
 * ils ne font naître ni contexte ni document — un cadre ou un worker `blob:` serait un royaume neuf.
 */
const SCHEMAS_LOCAUX = new Set(["data:", "blob:"]);
const ADMETTENT_LES_SCHEMAS_LOCAUX = new Set(["img-src", "font-src", "media-src"]);

/** Ce qui OUVRE une voie dans une politique : `[voie, jeton]` pour chaque ouverture. */
function ouvertures(politique) {
  const directives = lire(politique);
  const ouvertes = [];
  for (const [voie, replis] of Object.entries(REPLIS)) {
    const gouvernante = replis.find((nom) => directives.has(nom));
    if (gouvernante === undefined) {
      ouvertes.push([voie, "(aucune directive)"]);
      continue;
    }
    for (const jeton of directives.get(gouvernante)) {
      if (MOTS_CLES_SANS_SORTIE.has(jeton)) continue;
      if (/^'(?:nonce|sha256|sha384|sha512)-/u.test(jeton)) continue;
      if (SCHEMAS_LOCAUX.has(jeton) && ADMETTENT_LES_SCHEMAS_LOCAUX.has(voie)) continue;
      ouvertes.push([voie, jeton]);
    }
  }
  return ouvertes;
}

test("l'évaluateur MORD : chaque façon d'ouvrir une voie est vue", () => {
  // Sans ces cas, un évaluateur qui ne verrait rien rendrait les épreuves suivantes vertes.
  const base = POLITIQUE_DU_CADRE;
  assert.deepEqual(ouvertures(base.replace("connect-src 'self'", "connect-src *")), [
    ["connect-src", "*"],
  ]);
  assert.deepEqual(
    ouvertures(base.replace("img-src 'self' data: blob:", "img-src 'self' https://tiers.test")),
    [["img-src", "https://tiers.test"]],
  );
  assert.deepEqual(ouvertures(base.replace("; form-action 'self'", "")), [
    ["form-action", "(aucune directive)"],
  ]);
  assert.ok(
    ouvertures(base.replace("default-src 'self'", "default-src *")).some(
      ([voie]) => voie === "frame-src",
    ),
  );
  assert.ok(
    ouvertures(base.replace("script-src 'self'", "script-src 'self' 'strict-dynamic'")).length > 0,
  );
  assert.deepEqual(ouvertures(`${base}; frame-src blob:`), [["frame-src", "blob:"]]);
});

test("la politique du CADRE ne laisse AUCUNE voie hors de l'origine (#341)", () => {
  assert.deepEqual(ouvertures(POLITIQUE_DU_CADRE), []);
  // Les deux directives sans repli sont posées, et sur l'origine seule.
  const directives = lire(POLITIQUE_DU_CADRE);
  assert.deepEqual(directives.get("form-action"), ["'self'"]);
  assert.deepEqual(directives.get("base-uri"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
});

test("la politique du cadre ne pose pas `frame-ancestors` : elle interdirait le cadre lui-même", () => {
  // Le cadre est encadré par la coquille, d'une AUTRE origine ; `frame-ancestors 'self'` juge
  // TOUS les ancêtres.
  assert.equal(lire(POLITIQUE_DU_CADRE).has("frame-ancestors"), false);
  assert.equal(lire(POLITIQUE_DU_COURTIER).has("frame-ancestors"), false);
});

test("la politique du COURTIER ne laisse aucune voie, et juge la navigation du cadre imbriqué", () => {
  assert.deepEqual(ouvertures(POLITIQUE_DU_COURTIER), []);
  const directives = lire(POLITIQUE_DU_COURTIER);
  // `frame-src` est NOMMÉ : c'est lui qui juge chaque navigation du cadre de l'application.
  assert.deepEqual(directives.get("frame-src"), ["'self'"]);
  assert.deepEqual(directives.get("worker-src"), ["'self'"]);
  // Le courtier est le code de ce dépôt : aucun script en ligne, aucun formulaire.
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  assert.deepEqual(directives.get("form-action"), ["'none'"]);
});

test("le courtier PORTE sa politique, avant toute ressource", () => {
  const html = readFileSync(new URL("../../public/document-applicatif.html", import.meta.url), {
    encoding: "utf8",
  });
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/u.exec(
    html,
  );
  assert.ok(meta, "le courtier ne porte aucune politique par <meta>");
  assert.equal(meta[1], POLITIQUE_DU_COURTIER);
  // Un `<meta>` ne gouverne que ce qui le SUIT.
  for (const ressource of ["<link", "<script"]) {
    assert.ok(meta.index < html.indexOf(ressource), `${ressource} précède la politique`);
  }
  assert.equal(html.match(/http-equiv="Content-Security-Policy"/gu).length, 1);
});

test("le Service Worker IMPOSE la politique du cadre avec les en-têtes de l'hébergeur", () => {
  assert.equal(ENTETES_IMPOSES_AU_CADRE["Content-Security-Policy"], POLITIQUE_DU_CADRE);
  for (const [nom, valeur] of Object.entries(ENTETES_DE_L_HEBERGEUR_APPLICATIF)) {
    assert.equal(ENTETES_IMPOSES_AU_CADRE[nom], valeur, nom);
  }
  const entetes = imposerLesEntetesDuCadre(new Headers({ "content-type": "image/svg+xml" }));
  assert.equal(entetes.get("content-security-policy"), POLITIQUE_DU_CADRE);
  // Le type ne décide de rien : un SVG ou un XHTML s'exécute aussi.
  assert.equal(entetes.get("content-type"), "image/svg+xml");
});

test("une CSP PERMISSIVE de Rails n'élargit pas celle du cadre (#341)", () => {
  const permissive = "default-src * 'unsafe-inline' 'unsafe-eval'; form-action *";
  // Première ligne : elle n'est pas rendue au cadre.
  const rendus = entetesDeReponseRendues({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": permissive,
    "content-security-policy-report-only": permissive,
  });
  assert.deepEqual(rendus, { "content-type": "text/html; charset=utf-8" });
  // Seconde ligne : même rendue, elle serait REMPLACÉE, jamais ajoutée ni conservée.
  const entetes = imposerLesEntetesDuCadre(
    new Headers({ "content-security-policy": permissive, "cache-control": "public" }),
  );
  assert.equal(entetes.get("content-security-policy"), POLITIQUE_DU_CADRE);
  assert.equal(entetes.get("cache-control"), "no-store");
});
