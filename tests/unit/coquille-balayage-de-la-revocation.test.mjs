// Les BALAYAGES STATIQUES de C2 (#265, ADR 0049, C2-1′ et C2-3) : ce que le texte des sources interdit.
// Un balayage ne remplace pas une épreuve de comportement — celles-ci sont dans les épreuves du câblage
// et du navigateur —, il garde ce qu'aucune épreuve ne peut énumérer : « aucun autre chemin ».

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const RACINE = new URL("../../", import.meta.url);
const lire = (chemin) => readFileSync(new URL(chemin, RACINE), "utf8");

/** Tous les modules de la page : `src/coquille/` et `public/coquille/`, plus `public/main.mjs`. */
function sources() {
  const fichiers = [];
  for (const dossier of ["src/coquille/", "public/coquille/"]) {
    for (const nom of readdirSync(new URL(dossier, RACINE))) {
      if (nom.endsWith(".mjs")) fichiers.push(`${dossier}${nom}`);
    }
  }
  fichiers.push("public/main.mjs");
  return fichiers.map((chemin) => ({ chemin, texte: lire(chemin) }));
}

/** Le code sans commentaires : on ne juge que ce qui s'exécute. */
function codeSeul(texte) {
  return texte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const fichiersQuiContiennent = (motif) =>
  sources()
    .filter(({ texte }) => motif.test(codeSeul(texte)))
    .map(({ chemin }) => chemin)
    .sort();

test("[C2-1′ a] le canal n'écrit plus le constat de la feuille ni la taille d'une sauvegarde", () => {
  const canal = codeSeul(lire("public/coquille/canal-de-confiance.mjs"));
  assert.doesNotMatch(canal, /feuilleEprouvee/);
  assert.doesNotMatch(canal, /tailleDeSauvegarde/);
});

test("[C2-1′ b] seul le câblage écrit `rapport.feuilleEprouvee` et `rapport.tailleDeSauvegarde` (effet `publier`)", () => {
  assert.deepEqual(fichiersQuiContiennent(/\.feuilleEprouvee\s*=[^=]/), [
    "src/coquille/cablage-de-la-revocation.mjs",
  ]);
  assert.deepEqual(fichiersQuiContiennent(/\.tailleDeSauvegarde\s*=[^=]/), [
    "src/coquille/cablage-de-la-revocation.mjs",
  ]);
  // …et dans le câblage, uniquement dans l'effet `publier`.
  const cablage = lire("src/coquille/cablage-de-la-revocation.mjs");
  const debut = cablage.indexOf("function publierLeMiroir");
  const fin = cablage.indexOf("\n}\n", debut);
  const hors = cablage.slice(0, debut) + cablage.slice(fin);
  assert.doesNotMatch(codeSeul(hors), /\.(feuilleEprouvee|tailleDeSauvegarde)\s*=[^=]/);
});

test("[C2-1′ b] les miroirs de l'interface (moyens, compte des codes, types inconnus) ne s'écrivent que dans `refleter`", () => {
  const interfaceDeverrouillage = lire("src/coquille/interface-de-deverrouillage.mjs");
  const debut = interfaceDeverrouillage.indexOf("function refleter");
  const fin = interfaceDeverrouillage.indexOf("\n}\n", debut);
  const hors = interfaceDeverrouillage.slice(0, debut) + interfaceDeverrouillage.slice(fin);
  assert.doesNotMatch(
    codeSeul(hors),
    /releve\.(moyensProposes|nombreDeCodes|typesInconnus)\s*=[^=]/,
  );
  assert.deepEqual(fichiersQuiContiennent(/releve\.(moyensProposes|nombreDeCodes)\s*=[^=]/), [
    "src/coquille/interface-de-deverrouillage.mjs",
  ]);
});

test("[C2-1′ c] aucune DÉCISION ne lit un miroir : ni `rapport.feuilleEprouvee`, ni le relevé de l'interface", () => {
  const lecteurs = fichiersQuiContiennent(
    /(?:rapport|lireJson\([^)]*\))\.feuilleEprouvee(?!\s*=[^=])|releve\.(?:moyensProposes|nombreDeCodes|typesInconnus)(?!\s*=[^=])/,
  );
  assert.deepEqual(
    lecteurs,
    [],
    "le miroir n'est écrit que pour être lu par une personne ou un test",
  );
});

test("[C2-1′ c] le parcours ne lit pas le texte de `#deverrouillage-moyens` ni `deverrouillage-releve` pour décider", () => {
  const parcours = codeSeul(lire("public/coquille/parcours-de-la-page.mjs"));
  assert.doesNotMatch(parcours, /deverrouillage-moyens|deverrouillage-releve/);
  assert.doesNotMatch(parcours, /coffreObserve/);
});

test("[C2-3] chaque écriture d'enveloppe passe par `modifierEtAttendre` ou `modifier`", () => {
  const ecritures = /demander(?:AuWorker)?\(\s*"(creerRecuperation|restaurer)"/;
  assert.deepEqual(fichiersQuiContiennent(ecritures), [
    "src/coquille/gestes-de-portabilite.mjs",
    "src/coquille/interface-de-deverrouillage.mjs",
  ]);
  for (const chemin of [
    "src/coquille/gestes-de-portabilite.mjs",
    "src/coquille/interface-de-deverrouillage.mjs",
  ]) {
    const texte = codeSeul(lire(chemin));
    const position = texte.search(ecritures);
    const avant = texte.slice(Math.max(0, position - 400), position);
    assert.match(
      avant,
      /modifierEtAttendre\(/,
      `${chemin} : l'écriture est dans un lanceur de modifier`,
    );
  }
});

test("[C2-4] `envoyer` est le seul appel de `revoquerEnUrgence` ; l'indice n'est écrit qu'à `noter`", () => {
  assert.deepEqual(fichiersQuiContiennent(/"revoquerEnUrgence"/), [
    "src/coquille/cablage-de-la-revocation.mjs",
  ]);
  const cablage = codeSeul(lire("src/coquille/cablage-de-la-revocation.mjs"));
  const envoyer = cablage.slice(cablage.indexOf("envoyer:"), cablage.indexOf("relire:"));
  assert.match(envoyer, /demander\("revoquerEnUrgence"/);
  // l'indice persisté : `pas("revocation-faite")` n'existe que dans `noterLaRevocation`
  const ecritures = sources().filter(({ texte }) => /"revocation-faite"/.test(codeSeul(texte)));
  assert.deepEqual(
    ecritures.map(({ chemin }) => chemin).filter((chemin) => !chemin.endsWith("parcours.mjs")),
    ["public/coquille/parcours-de-la-page.mjs"],
  );
  const parcours = codeSeul(lire("public/coquille/parcours-de-la-page.mjs"));
  assert.equal(parcours.match(/"revocation-faite"/g).length, 1);
  assert.match(parcours, /noterLaRevocation = \(\) => pas\("revocation-faite"\)/);
});

test("[C2-7] aucun second drapeau de révocation dans la page : ni `revocationFaite` d'état, ni observateur de ligne", () => {
  const parcours = codeSeul(lire("public/coquille/parcours-de-la-page.mjs"));
  assert.doesNotMatch(parcours, /etat\.revocationFaite|revocationFaite:/);
  const observateurs = codeSeul(lire("public/coquille/observateurs-du-parcours.mjs"));
  assert.doesNotMatch(observateurs, /etat\.revocationFaite/);
  assert.doesNotMatch(observateurs, /pas\("revocation-faite"\)/);
});

test("[C2-11] aucune affirmation de révocation écrite hors du conteneur par un module de la page", () => {
  // Les nœuds qui portaient l'avertissement et le compte des codes ne sont plus des nœuds statiques.
  const page = lire("public/index.html");
  for (const id of [
    "parcours-avertissement-revocation",
    "parcours-codes",
    "revoquer-en-urgence",
    "parcours-sans-revoquer",
  ]) {
    assert.doesNotMatch(page, new RegExp(`id="${id}"`), `${id} n'est plus du HTML statique`);
  }
  const dire = codeSeul(lire("public/coquille/parcours-de-la-page.mjs"));
  assert.doesNotMatch(dire, /dire\("parcours-(codes|avertissement-revocation)"/);
});

test("[C2-2] les gestes de la vue ne lisent jamais `disabled` ni `aria-disabled` pour décider", () => {
  for (const chemin of [
    "src/coquille/cablage-de-la-revocation.mjs",
    "src/coquille/construction-de-la-vue.mjs",
  ]) {
    const texte = codeSeul(lire(chemin));
    assert.doesNotMatch(texte, /getAttribute\("aria-disabled"\)|\.disabled\b/, chemin);
  }
});

test("[C2-13] `masquer()` relit ce qu'il a écrit : il ne rend jamais `true` sans avoir lu le DOM", () => {
  const texte = codeSeul(lire("src/coquille/affichage-de-la-revocation.mjs"));
  assert.match(texte, /isConnected === true/);
  assert.match(texte, /hasAttribute\("data-vue"\)/);
  assert.match(texte, /conteneur\.hidden === true/);
});

test("[#321 point 2] la page branche le cycle PAR la liaison de `src/`, et l'acquit par `creerLAcquit`", () => {
  const cycle = codeSeul(lire("public/coquille/cycle-de-la-page.mjs"));
  assert.match(cycle, /brancherLeCycleSurLaRevocation\(/);
  assert.doesNotMatch(
    cycle,
    /brancherLesGestesDuCycle/,
    "aucun appel direct, sans la décision de la table",
  );
  const revocation = codeSeul(lire("public/coquille/revocation-de-la-page.mjs"));
  assert.match(revocation, /creerLAcquit\(/);
  assert.doesNotMatch(
    revocation,
    /portabilite-etat"\)\.textContent\s*=/,
    "la ligne d'état est dite par l'acquit",
  );
  // Seul le module de liaison (et les épreuves) appellent `brancherLesGestesDuCycle`.
  assert.deepEqual(fichiersQuiContiennent(/brancherLesGestesDuCycle\(/), [
    "src/coquille/cycle-sur-la-revocation.mjs",
    "src/coquille/gestes-du-cycle.mjs",
  ]);
});
