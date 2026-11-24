// Les TEXTES de la révocation (#265, D4, C2-5′) : complétude, étiquettes, phrases interdites.
// Une phrase qui affirme une révocation n'existe que dans une clé étiquetée `revoque`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { CLES_DE_TEXTE, ETIQUETTES } from "../../src/coquille/cles-de-la-revocation.mjs";
import {
  TEXTES_PAR_CLE,
  avertissementDeRevocation,
  confirmationDeRevocation,
  etiquetteDe,
  texteDe,
} from "../../src/coquille/textes-de-la-revocation.mjs";

const INTERDITES = Object.freeze([
  /r[ée]voqu[ée]s?\b/i,
  /la r[ée]vocation a [ée]t[ée] faite/i,
  /tous vos moyens (ouvrent|ouvre) toujours/i,
  /rien n'a [ée]t[ée] r[ée]voqu[ée]/i,
  /chacun des moyens[^.]*l'ouvre toujours/i,
]);

const corps = (cle) => {
  const { titre, corps: texte } = TEXTES_PAR_CLE[cle];
  return `${titre ?? ""} ${texte}`;
};

test("[C2-5′] un texte exactement par clé du catalogue, ni plus ni moins", () => {
  assert.deepEqual(Object.keys(TEXTES_PAR_CLE).sort(), Object.keys(CLES_DE_TEXTE).sort());
});

test("[C2-5′] chaque clé porte son étiquette, et elle est de l'un des cinq genres connus", () => {
  const genres = new Set(Object.values(ETIQUETTES));
  for (const cle of Object.keys(CLES_DE_TEXTE)) {
    assert.ok(genres.has(etiquetteDe(cle)), `${cle} : étiquette connue`);
  }
});

test("[C2-5′] aucune phrase d'affirmation de révocation hors des clés étiquetées `revoque`", () => {
  for (const cle of Object.keys(TEXTES_PAR_CLE)) {
    if (etiquetteDe(cle) === ETIQUETTES.revoque) continue;
    for (const motif of INTERDITES) {
      assert.doesNotMatch(corps(cle), motif, `${cle} (${etiquetteDe(cle)}) dit ${motif}`);
    }
  }
});

test("[C2-5′] les clés étiquetées `revoque` DISENT bien la révocation (sinon l'étiquette est fausse)", () => {
  for (const cle of Object.keys(TEXTES_PAR_CLE)) {
    if (etiquetteDe(cle) !== ETIQUETTES.revoque) continue;
    assert.ok(
      INTERDITES.some((motif) => motif.test(corps(cle))) || /révocation/i.test(corps(cle)),
      `${cle} : parle de la révocation`,
    );
  }
});

test("[C2-5′] les clés `peut-etre` disent le doute, pas la certitude", () => {
  for (const cle of Object.keys(TEXTES_PAR_CLE)) {
    if (etiquetteDe(cle) !== ETIQUETTES.peutEtre) continue;
    assert.match(corps(cle), /peut-être/i, `${cle}`);
  }
});

test("[C2-5′] les clés `seance` disent « dans cette séance » ; `non-lancee` dit « n'a pas été lancée »", () => {
  for (const cle of Object.keys(TEXTES_PAR_CLE)) {
    if (etiquetteDe(cle) === ETIQUETTES.seance) assert.match(corps(cle), /dans cette séance/, cle);
    if (etiquetteDe(cle) === ETIQUETTES.nonLancee) assert.match(corps(cle), /pas été lancée/, cle);
  }
});

test("[D4] l'écran atteint par l'indice seul ne dit que « aucun geste de révocation dans cette séance »", () => {
  const texte = corps("termine-sans-attestation");
  assert.match(texte, /Aucun geste de révocation n'a été fait dans cette séance\./);
  for (const motif of INTERDITES) assert.doesNotMatch(texte, motif);
});

test("[D4] aucune clé « refusée », « rien n'a été révoqué » ni « tous vos moyens ouvrent toujours »", () => {
  for (const cle of Object.keys(TEXTES_PAR_CLE)) {
    assert.doesNotMatch(cle, /^revocation-refusee$|^rien-n-a-ete-revoque$/);
  }
  assert.equal(TEXTES_PAR_CLE["revocation-refusee"], undefined);
});

test("texteDe : une clé inconnue est une erreur de programmation", () => {
  assert.throws(() => texteDe("inconnue"), TypeError);
  assert.equal(texteDe("chargement").titre, "Lecture de votre coffre");
});

test("l'avertissement nomme le moyen de la séance et compte les autres feuilles", () => {
  const deux = avertissementDeRevocation("recuperation", ["recuperation"], { codes: 2 });
  assert.match(deux, /le code de votre feuille/);
  assert.match(deux, /Vos autres codes de récupération/);
  const un = avertissementDeRevocation("recuperation", ["recuperation"], { codes: 1 });
  assert.match(un, /Aucun autre moyen n'ouvre ce coffre/);
  assert.match(avertissementDeRevocation(null), /Seul le moyen avec lequel vous avez ouvert/);
});

test("la confirmation reprend l'avertissement et dit l'irréversible, sans rien retirer avant le « Oui »", () => {
  const texte = confirmationDeRevocation("phrase", ["phrase", "recuperation"], { codes: 1 });
  assert.match(texte, /irréversible/);
  assert.match(texte, /votre phrase/);
  assert.match(texte, /« Oui, révoquer les autres moyens »/);
  assert.match(texte, /« Annuler » ne change rien/);
});

test("aucun texte de `src/coquille/` hors des clés étiquetées ne contient les phrases interdites du catalogue", () => {
  // Balayage des autres sources de texte du parcours : `termine` et `revocationAnnulee` d'avant C2 ont disparu.
  const dossier = new URL("../../src/coquille/", import.meta.url);
  const fautifs = [];
  for (const nom of readdirSync(dossier)) {
    if (!nom.endsWith(".mjs") || nom === "textes-de-la-revocation.mjs") continue;
    const source = readFileSync(new URL(nom, dossier), "utf8");
    if (
      /rien n'a été révoqué|tous vos moyens ouvrent toujours|chacun des moyens[^"]*l'ouvre toujours/i.test(
        source,
      )
    ) {
      fautifs.push(nom);
    }
  }
  assert.deepEqual(
    fautifs,
    [],
    "ces fichiers disent une phrase interdite hors d'une clé étiquetée",
  );
});
