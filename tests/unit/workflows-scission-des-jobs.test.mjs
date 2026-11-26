// CLIQUET de la scission des jobs lourds de `ci.yml` (#328).
//
// « Campagnes de mutation » et « Vérifications du produit » ont été annulés à leur plafond sur
// `main` (run 45778067983). La réponse est de SCINDER, jamais de relever un plafond : ce cliquet
// garde que (1) chaque lot de mutation est une ligne de la matrice, (2) le job qui porte le nom
// requis par la protection de branche n'est vert que si TOUS les lots le sont, (3) « Qualité et
// tests » exige chaque job de produit, (4) aucun `timeout-minutes` ne dépasse son plafond d'avant,
// (5) `npm run check` rejoue la même union de commandes que les deux moitiés.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LOTS } from "../../tools/rejouer-les-campagnes.mjs";

const ci = (
  await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const paquet = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

const bloc = (id) =>
  ci.match(new RegExp(`^ {2}${id}:\\n(?<b>[\\s\\S]*?)(?=^ {2}[\\w-]+:|(?![\\s\\S]))`, "mu"))?.groups
    .b;
const code = (b) => b.match(/node --input-type=module <<'JS'\n(?<c>[\s\S]*?)\n\s+JS\n/u)?.groups.c;
const executer = (b, resultats) =>
  spawnSync(process.execPath, ["--input-type=module", "--eval", code(b)], {
    env: { ...process.env, VAULT_RESULTATS_CI: JSON.stringify(resultats) },
    encoding: "utf8",
    timeout: 10_000,
  });

/** Plafonds d'AVANT #328 : on peut les abaisser, jamais les relever. */
const PLAFONDS_AVANT = {
  couverture: 10,
  qualite: 2,
  "check-navigateur": 36,
  "check-parcours": 36,
  "mutations-lot": 15,
  mutations: 15,
};

test("la matrice des lots de mutation est exactement la liste des lots du lanceur", () => {
  const lots = bloc("mutations-lot");
  assert.ok(lots, "le job matriciel `mutations-lot` doit exister");
  const matrice = lots.match(/^ {8}lot: \[(?<l>[\d, ]+)\]$/mu)?.groups.l;
  assert.ok(matrice, "la matrice déclare `lot: [1, 2, …]`");
  assert.deepEqual(
    matrice.split(",").map(Number),
    LOTS.map((_, i) => i + 1),
  );
  assert.match(lots, /^ {6}fail-fast: false$/mu);
  assert.match(lots, /npm run check:mutations -- --lot=\$\{\{ matrix\.lot \}\}/u);
});

test("le job requis « Campagnes de mutation » reste un seul statut, vert si et seulement si tous les lots le sont", () => {
  const final = bloc("mutations");
  assert.ok(final);
  assert.match(final, /^ {4}name: Campagnes de mutation$/mu);
  assert.match(final, /^ {4}needs: \[mutations-lot\]$/mu);
  assert.match(final, /^ {4}if: \$\{\{ always\(\) \}\}$/mu);
  assert.match(final, /VAULT_RESULTATS_CI: \$\{\{ toJSON\(needs\) \}\}/u);
  assert.equal((ci.match(/^ {4}name: Campagnes de mutation$/gmu) ?? []).length, 1);
  assert.equal(executer(final, { "mutations-lot": { result: "success" } }).status, 0);
  for (const etat of ["failure", "cancelled", "skipped", ""]) {
    const r = executer(final, { "mutations-lot": { result: etat } });
    assert.equal(r.status, 1, `état ${etat}`);
    assert.match(r.stderr, /mutations-lot/u);
  }
  assert.equal(executer(final, {}).status, 1, "lot absent");
});

test("les rapports des lots sont fusionnés en un seul artefact", () => {
  const final = bloc("mutations");
  assert.match(final, /uses: actions\/upload-artifact\/merge@[0-9a-f]{40}/u);
  assert.match(final, /pattern: campagnes-de-mutation-lot-\*/u);
  assert.match(final, /name: campagnes-de-mutation$/mu);
});

test("« Qualité et tests » exige chacun des deux jobs de produit, en plus de la couverture et des audits", () => {
  const gate = bloc("qualite");
  const attendus = ["check-navigateur", "check-parcours", "couverture", "audits"];
  assert.match(gate, /^ {4}name: Qualité et tests$/mu);
  assert.match(gate, new RegExp(`^ {4}needs: \\[${attendus.join(", ")}\\]$`, "mu"));
  assert.ok(
    code(gate).includes(`const attendus = ${JSON.stringify(attendus).replaceAll(",", ", ")};`),
  );
  const tous = Object.fromEntries(attendus.map((n) => [n, { result: "success" }]));
  assert.equal(executer(gate, tous).status, 0);
  for (const nom of attendus) {
    for (const etat of ["failure", "cancelled", "skipped"]) {
      const r = executer(gate, { ...tous, [nom]: { result: etat } });
      assert.equal(r.status, 1, `${nom} ${etat}`);
    }
    const sans = { ...tous };
    delete sans[nom];
    assert.equal(executer(gate, sans).status, 1, `${nom} absent`);
  }
});

test("aucun plafond n'est relevé, et chaque job en porte un", () => {
  for (const [id, avant] of Object.entries(PLAFONDS_AVANT)) {
    const b = bloc(id);
    assert.ok(b, `le job ${id} doit exister`);
    const plafond = /^ {4}timeout-minutes: (\d+)$/mu.exec(b);
    assert.ok(plafond, `${id} : pas de timeout-minutes`);
    assert.ok(Number(plafond[1]) <= avant, `${id} : ${plafond[1]} > ${avant}`);
  }
  assert.doesNotMatch(ci, /^ {2}check:\n/mu, "l'ancien job unique `check` ne doit pas subsister");
});

test("`npm run check` rejoue exactement l'union des deux moitiés, sans rien perdre", () => {
  const etapes = (script) => paquet.scripts[script].split(" && ").map((s) => s.trim());
  const decomposer = (script) =>
    etapes(script).flatMap((e) => {
      const m = /^npm run (check:[\w-]+)$/u.exec(e);
      return m ? decomposer(m[1]) : [e];
    });
  assert.deepEqual(decomposer("check"), [
    "npm run lint",
    "npm run format:check",
    "npm test",
    "npm run test:apparence",
    "npm run test:compat",
    "npm run test:fins-d-onglet",
    "npm run publier:check",
  ]);
  assert.ok(paquet.scripts["check:navigateur"]);
  assert.ok(paquet.scripts["check:parcours"]);
  assert.match(bloc("check-navigateur"), /npm run check:navigateur/u);
  assert.match(bloc("check-parcours"), /npm run check:parcours/u);
});
