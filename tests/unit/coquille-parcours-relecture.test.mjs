/**
 * La PAGE DE RELECTURE ne peut plus dériver de ce qui est servi (revue de la PR #213, constat 7), et la
 * limite de Firefox est écrite de la même phrase partout où elle doit l'être (constat 10).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONDUITES_DU_PARCOURS,
  REFUS_SANS_CODE,
} from "../../src/coquille/conduites-du-parcours.mjs";
import { ECRANS, ETAPES, MESSAGES } from "../../src/coquille/parcours.mjs";
import {
  CHEMIN_DE_LA_RELECTURE,
  MESSAGES_DE_STRUCTURE,
  MESSAGES_PAR_ECRAN,
  QUESTIONS,
  genererLaRelecture,
} from "../../tools/relecture-parcours.mjs";

const lire = (chemin) => readFile(new URL(`../../${chemin}`, import.meta.url), "utf8");
const aPlat = (texte) => texte.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");

/** La limite de Firefox telle que la documentation l'écrit, mot pour mot, dans quatre documents. */
const LIMITE_DE_FIREFOX_DOCUMENTEE =
  "Sous Firefox, l'étape 4 du parcours guidé n'aboutit pas dans cette version : la machine " +
  "virtuelle y tourne environ six fois plus lentement que sous Chromium, et Rails n'y a jamais " +
  "répondu (ADR 0038) ; le parcours le dit avant toute attente et propose Chrome ou Edge.";

test("la page de relecture est À JOUR : la régénérer ne change rien", async () => {
  const actuelle = await readFile(CHEMIN_DE_LA_RELECTURE, "utf8");
  assert.equal(actuelle, await genererLaRelecture(), "« node tools/relecture-parcours.mjs »");
});

test("la page de relecture reproduit chaque texte servi : écrans, messages, conduites", async () => {
  const page = aPlat(await readFile(CHEMIN_DE_LA_RELECTURE, "utf8"));
  for (const [id, ecran] of Object.entries(ECRANS)) {
    for (const champ of ["titre", "ceQuiVaSePasser", "attendu"]) {
      assert.ok(page.includes(aPlat(ecran[champ])), `${id}.${champ} absent de la relecture`);
    }
    if (ecran.attente !== null) assert.ok(page.includes(aPlat(ecran.attente)), `${id}.attente`);
  }
  for (const conduite of Object.values(CONDUITES_DU_PARCOURS)) {
    assert.ok(page.includes(aPlat(conduite)), `conduite absente : ${conduite.slice(0, 40)}…`);
  }
  for (const { conduite } of Object.values(REFUS_SANS_CODE))
    assert.ok(page.includes(aPlat(conduite)));
});

test("chaque message de la page est rattaché à un écran, ou dit dans l'introduction", () => {
  const rattaches = new Set([
    ...Object.values(MESSAGES_PAR_ECRAN).flat(),
    ...MESSAGES_DE_STRUCTURE,
  ]);
  const orphelins = Object.keys(MESSAGES).filter((nom) => !rattaches.has(nom));
  assert.deepEqual(orphelins, [], "un message servi doit figurer dans la relecture");
  for (const id of Object.keys(MESSAGES_PAR_ECRAN)) assert.ok(id in ECRANS, id);
});

test("trois questions par étape, pour les neuf étapes", () => {
  assert.deepEqual(
    Object.keys(QUESTIONS).map(Number),
    ETAPES.map((etape) => etape.rang),
  );
  for (const questions of Object.values(QUESTIONS)) assert.equal(questions.length, 3);
});

test("CONSTAT 10 : la limite de Firefox est écrite de la même phrase dans les quatre documents", async () => {
  const phrase = aPlat(LIMITE_DE_FIREFOX_DOCUMENTEE);
  for (const document of [
    "docs/decisions/0040-le-parcours-est-un-ordre-pas-une-decision.md",
    "README.md",
    "docs/compatibility.md",
    "docs/testing.md",
  ]) {
    assert.ok(aPlat(await lire(document)).includes(phrase), `${document} ne porte pas la phrase`);
  }
});
