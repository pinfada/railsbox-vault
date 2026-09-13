/**
 * Le CLIQUET des TYPES de la coquille : chaque type du canal privilégié et du port restreint est
 * NOMMÉ au § 10.5 de `docs/format-de-volume-v3.md` (#207, ADR 0039).
 *
 * L'ADR 0028 exige, pour tout type neuf, un ADR et une entrée au § 10.5. Les CODES avaient leur
 * cliquet (`dossier-de-revue.test.mjs`) ; les TYPES n'en avaient pas, et un geste pouvait donc naître
 * dans le contrat sans qu'un relecteur en soit prévenu. Il vit à part pour la raison de
 * `coquille-refus-du-cadre-documentes.test.mjs` : la campagne de mutation rejoue dans une copie du
 * dépôt qui n'emporte pas `docs/`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TYPES_APPLICATIFS,
  TYPES_PRIVILEGIES,
  TYPES_RELAIS,
} from "../../src/coquille/contrat-de-messages.mjs";

async function paragraphe105() {
  const format = await readFile(
    new URL("../../docs/format-de-volume-v3.md", import.meta.url),
    "utf8",
  );
  const debut = format.indexOf("### 10.5 ");
  assert.notEqual(debut, -1, "le § 10.5 a disparu de la spécification");
  const suite = format.indexOf("\n### ", debut + 1);
  const fin = format.indexOf("\n## ", debut + 1);
  const bornes = [suite, fin].filter((indice) => indice !== -1);
  return format.slice(debut, bornes.length === 0 ? undefined : Math.min(...bornes));
}

test("chaque type de la coquille est NOMMÉ au § 10.5 (cliquet)", async () => {
  const section = await paragraphe105();
  const types = [
    ...Object.values(TYPES_PRIVILEGIES),
    ...Object.values(TYPES_APPLICATIFS),
    ...Object.values(TYPES_RELAIS),
  ];
  assert.ok(types.length >= 30, `trop peu de types relevés (${types.length})`);
  const absents = types.filter((type) => !section.includes(`\`${type}\``));
  assert.deepEqual(absents, [], "ces types existent dans le contrat sans entrée au § 10.5");
});
