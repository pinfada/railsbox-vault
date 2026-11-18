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

// --- Les collections EXPORTÉES sont réellement immuables (#315) -----------------------------------------
// `Object.freeze(new Set(...))` n'empêche pas `add`, `delete`, `clear` : un appelant pouvait faire dire
// « révoqué » à la phase I, pour toutes les instances. Aucune collection exportée n'est un Set ou une Map ;
// toute valeur exportée est gelée en profondeur.

const EXPORTS = await Promise.all(MODULES.map((nom) => import(`../../src/coquille/${nom}.mjs`)));
const exportsDeLaCollection = EXPORTS.flatMap((module, rang) =>
  Object.entries(module).map(([nom, valeur]) => [`${MODULES[rang]}.${nom}`, valeur]),
);

function gelee(valeur) {
  if (valeur === null || (typeof valeur !== "object" && typeof valeur !== "function")) return true;
  if (typeof valeur === "function") return true;
  return Object.isFrozen(valeur) && Object.values(valeur).every(gelee);
}

test("[I1] aucune collection exportée n'est un Set, une Map ni une valeur non gelée", () => {
  assert.ok(exportsDeLaCollection.length >= 25, "trop peu d'exports examinés");
  for (const [nom, valeur] of exportsDeLaCollection) {
    for (const interdit of [Set, Map, WeakSet, WeakMap]) {
      assert.ok(
        !(valeur instanceof interdit),
        `${nom} est un ${interdit.name} : muable par add/set/delete/clear`,
      );
    }
    assert.ok(gelee(valeur), `${nom} n'est pas gelé en profondeur`);
  }
});

test("[I1] aucun Set ni Map n'est créé au niveau du module (même gelé)", () => {
  for (const nom of MODULES) {
    const code = codeSeul(source(nom));
    assert.doesNotMatch(
      code,
      /^(?:export\s+)?const\s+\w+\s*=\s*(?:Object\.freeze\(\s*)?new (?:Set|Map)\b/m,
      `${nom} : Set ou Map de module`,
    );
  }
});

test("[I1] tenter de MUTER chaque export ne fausse aucune affirmation et ne contamine aucune instance", async () => {
  const { affirmationsDe } = await import("../../src/coquille/vue-de-la-revocation.mjs");
  const { LISTE_DES_PHASES: phases, etatDeLaPhase } = await import("./support-revocation.mjs");
  const attendu = () => phases.map((phase) => affirmationsDe(etatDeLaPhase(phase)).revoque);
  const avant = attendu();
  const instance = (await import("./support-magasin-revocation.mjs")).fabriquer();
  const phaseAvant = instance.magasin.etat().phase;
  for (const [, valeur] of exportsDeLaCollection) {
    for (const mutation of [
      (v) => v.add?.("I"),
      (v) => v.set?.("I", true),
      (v) => v.delete?.("RL"),
      (v) => v.clear?.(),
      (v) => v.push?.("I"),
      (v) => v.splice?.(0, 1),
      (v) => {
        v.I = "pirate";
      },
      (v) => {
        v[0] = "pirate";
      },
    ]) {
      try {
        if (valeur !== null && typeof valeur === "object") mutation(valeur);
      } catch {
        // un objet gelé refuse : c'est le comportement attendu
      }
    }
  }
  assert.deepEqual(attendu(), avant, "une mutation d'un export a changé une affirmation");
  assert.equal(affirmationsDe(etatDeLaPhase("I")).revoque, false, "« révoqué » est dit en I");
  const autre = (await import("./support-magasin-revocation.mjs")).fabriquer();
  assert.equal(autre.magasin.etat().phase, "F0", "une instance neuve ne démarre pas à F0");
  assert.equal(instance.magasin.etat().phase, phaseAvant);
});
