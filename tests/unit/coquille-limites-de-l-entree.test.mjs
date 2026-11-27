/**
 * Ce que cette version NE PROMET PAS, dit à la personne sur l'écran d'entrée (#195, publication,
 * étape 4 du 26/11/2026).
 *
 * Le gate humain de #195 n'a de sens que si la personne sait, avant de commencer, ce qu'on ne lui
 * promet pas. Ces épreuves exigent la présence de sept limites sur l'écran d'entrée, qu'elles disent
 * des chiffres MESURÉS et que chaque chiffre soit retrouvable, avec sa source, dans la page de détail.
 * Elles ne corrigent rien : elles déclarent.
 */

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { LIMITES } from "../../src/coquille/limites-de-cette-version.mjs";

const lire = (chemin) => readFile(new URL(`../../${chemin}`, import.meta.url), "utf8");

/** Les sept limites que le mainteneur demande de dire, et le mot sans lequel elle ne le dirait pas. */
const ATTENDUES = Object.freeze({
  chromium: /Chrome ou Edge/,
  "premier-demarrage": /de 82 à 126 secondes/,
  telechargement: /200 Mo/,
  memoire: /512 Mo[\s\S]*1,5 Go[\s\S]*1,2 Go/,
  donnees: /aucune donnée (réelle|sensible)/i,
  paquet: /pas signée/,
  "hors-connexion": /premier démarrage[\s\S]*Internet/,
});

const phrases = (texte) => texte.split(/(?<=[.!?])\s+/).filter(Boolean);
const mots = (phrase) => phrase.split(/\s+/).filter(Boolean).length;

test("l'écran d'entrée dit les sept limites demandées, dans cet ordre", () => {
  assert.deepEqual(
    LIMITES.limites.map((limite) => limite.cle),
    Object.keys(ATTENDUES),
  );
  for (const limite of LIMITES.limites) {
    assert.match(
      limite.texte,
      ATTENDUES[limite.cle],
      `la limite « ${limite.cle} » ne dit pas ce qu'elle doit`,
    );
  }
});

test("les limites sont écrites pour un humain : phrases courtes, aucun jargon", () => {
  assert.equal(LIMITES.titre, "Ce que cette version ne promet pas");
  for (const { cle, titre, texte } of LIMITES.limites) {
    assert.ok(titre.length > 0 && titre.length <= 60, `${cle} : titre`);
    for (const phrase of phrases(texte)) {
      assert.ok(
        mots(phrase) <= 25,
        `${cle} : phrase trop longue (${mots(phrase)} mots) : ${phrase}`,
      );
    }
    assert.doesNotMatch(
      `${titre} ${texte}`,
      /\b(OPFS|Worker|ADR|v86|SHA|WebAssembly|COOP|CSP|hôte|gzip|Mio|Gio)\b/,
      `${cle} : un mot technique`,
    );
  }
});

test("chaque chiffre dit à la personne est retrouvable, avec sa source, dans la page de détail", async () => {
  const detail = await lire("docs/limites-de-cette-version.md");
  const dits = LIMITES.limites.flatMap(({ texte }) => texte.match(/\d+(?:,\d+)?/g) ?? []);
  assert.ok(dits.length >= 6, "les limites doivent porter des chiffres mesurés");
  for (const chiffre of new Set(dits)) {
    assert.ok(
      detail.includes(chiffre),
      `le chiffre « ${chiffre} » n'est pas dans la page de détail`,
    );
  }
  // Les sources que le mainteneur exige : la mesure, l'environnement, les issues, le jalon.
  for (const source of [
    "docs/quality-attributes.md",
    "Windows 11",
    "28 threads",
    "#238",
    "jalon 6",
    "SECURITY.md",
  ]) {
    assert.ok(detail.includes(source), `la page de détail ne cite pas « ${source} »`);
  }
});

test("#347 · aucun texte montré ne promet une signature : ni « jalon 6 », ni « prévue plus tard »", () => {
  for (const { cle, titre, texte } of LIMITES.limites) {
    assert.doesNotMatch(`${titre} ${texte}`, /jalon|prévue plus tard/i, `${cle} : promesse`);
  }
  const paquet = LIMITES.limites.find(({ cle }) => cle === "paquet");
  assert.match(paquet.texte, /Aucune signature n'est prévue à ce jour \(#347\)/);
});

test("le lien de détail désigne un fichier qui existe dans le dépôt", async () => {
  const motif =
    /^https:\/\/github\.com\/pinfada\/railsbox-vault\/blob\/main\/(docs\/[a-z0-9-]+\.md)$/;
  const [, chemin] = LIMITES.detail.lien.match(motif) ?? [];
  assert.ok(chemin, `lien inattendu : ${LIMITES.detail.lien}`);
  await access(new URL(`../../${chemin}`, import.meta.url));
});

test("le document porte la section des limites, nommée par son titre", async () => {
  const html = await lire("public/index.html");
  assert.match(html, /<section id="limites"[^>]*aria-labelledby="limites-titre"/);
  assert.match(html, /<h2 id="limites-titre"/);
});
