// La PURETÉ des modules de la révocation (#310, ADR 0049, I7, I12) : aucun DOM, aucune horloge, aucun
// hasard, aucun import de `public/`, aucun état de module — donc aucun texte final et aucune entrée
// d'écran. Un test STATIQUE des sources : un jeton interdit ajouté fait échouer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const MODULES = Object.freeze([
  "phases-de-la-revocation",
  "cles-de-la-revocation",
  "vue-de-la-revocation",
  "modele-de-la-revocation",
  "projection-de-la-revocation",
  "reponse-de-la-revocation",
  "magasin-de-la-revocation",
]);

const source = (nom) =>
  readFileSync(new URL(`../../src/coquille/${nom}.mjs`, import.meta.url), "utf8");

/** Le code sans commentaires ni chaînes : on ne juge que ce qui s'exécute. */
function codeSeul(texte) {
  return texte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const INTERDITS = Object.freeze([
  [/\bdocument\b/, "document"],
  [/\bwindow\b/, "window"],
  [/\bglobalThis\b/, "globalThis"],
  [/\bnavigator\b/, "navigator"],
  [/\blocation\b/, "location"],
  [/\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b/, "minuterie"],
  [/\bDate\b/, "Date"],
  [/Math\.random|crypto\./, "hasard"],
  [/\bperformance\b/, "horloge"],
  [/\bprocess\b|\brequire\b/, "environnement"],
  [/from\s+"[^"]*public\//, "import de public/"],
  [/\bfetch\b|\bXMLHttpRequest\b|\blocalStorage\b|\bsessionStorage\b/, "entrée-sortie"],
]);

test("[I12] sept modules, aucun DOM, aucune horloge, aucun hasard, aucun import de `public/`", () => {
  assert.equal(MODULES.length, 7);
  for (const nom of MODULES) {
    const code = codeSeul(source(nom));
    assert.ok(code.length > 200, `${nom} : source introuvable ou vide`);
    for (const [motif, libelle] of INTERDITS)
      assert.doesNotMatch(code, motif, `${nom} : « ${libelle} » interdit`);
  }
});

test("[I1] aucun état de module : pas de `let` ni de `var` au niveau du module, pas de collection non gelée", () => {
  for (const nom of MODULES) {
    const code = codeSeul(source(nom));
    assert.doesNotMatch(
      code,
      /^(?:export\s+)?(?:let|var)\s/m,
      `${nom} : variable de module muable`,
    );
    assert.doesNotMatch(
      code,
      /^(?:export\s+)?const\s+\w+\s*=\s*(?:new (?:Map|WeakMap|WeakSet)|\[\s*\]|\{\s*\})/m,
      `${nom} : collection de module muable`,
    );
  }
});

test("[I12] le modèle n'exporte aucun texte final : les seules chaînes sont des CLÉS du catalogue", () => {
  const catalogue = readFileSync(
    new URL("../../src/coquille/cles-de-la-revocation.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    catalogue.replace(/\/\/.*$/gm, ""),
    /[.!?] [A-Z]/,
    "le catalogue contient une phrase",
  );
  for (const nom of MODULES) {
    const brut = source(nom)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(
      brut,
      /« révoqué|rien n'a été révoqué|tous vos moyens/i,
      `${nom} : un texte final y est écrit`,
    );
  }
});
