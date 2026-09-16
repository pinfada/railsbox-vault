import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const lire = (nom) =>
  readFile(new URL(`../../.github/workflows/${nom}.yml`, import.meta.url), "utf8");
const ci = (await lire("ci")).replaceAll("\r\n", "\n");
// Comme les autres cliquets de workflow : format local explicite, sans dépendance YAML ajoutée.
const gate = ci.match(/^ {2}qualite:\n(?<bloc>[\s\S]*?)(?=^ {2}\w+:)/mu)?.groups.bloc;
assert.ok(gate, "Le contrôle requis qualite doit exister.");
const code = gate.match(/node --input-type=module <<'JS'\n(?<code>[\s\S]*?)\n\s+JS\n/u)?.groups
  .code;
assert.ok(code, "Le code réellement exécuté dans le workflow doit être éprouvé.");

test("le contrôle déjà requis attend les tests, les deux couvertures et les audits", () => {
  assert.match(gate, /^ {4}name: Qualité et tests$/mu);
  assert.match(gate, /^ {4}needs: \[check, couverture, audits\]$/mu);
  assert.match(gate, /^ {4}if: \$\{\{ always\(\) \}\}$/mu);
  assert.match(gate, /VAULT_RESULTATS_CI: \$\{\{ toJSON\(needs\) \}\}/u);
  assert.match(ci, /^ {2}audits:\n {4}uses: \.\/\.github\/workflows\/security.yml$/mu);
  assert.match(ci, /node: \[22, 24\]/u);
});

const reussis = () =>
  Object.fromEntries(["check", "couverture", "audits"].map((nom) => [nom, { result: "success" }]));
function executer(resultats) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    env: { ...process.env, VAULT_RESULTATS_CI: JSON.stringify(resultats) },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("le gate accepte uniquement trois contrôles réussis", () => {
  const resultat = executer(reussis());
  assert.equal(resultat.status, 0, resultat.stderr);
});

for (const nom of ["check", "couverture", "audits"]) {
  for (const etat of ["failure", "cancelled", "skipped", "", undefined]) {
    test(`le gate refuse ${nom} : ${etat ?? "absent"}`, () => {
      const resultats = reussis();
      if (etat === undefined) delete resultats[nom];
      else resultats[nom].result = etat;
      const resultat = executer(resultats);
      assert.equal(resultat.status, 1, resultat.stderr);
      assert.match(resultat.stderr, new RegExp(nom, "u"));
    });
  }
}

test("le workflow de sécurité est réutilisé sans doubler les déclenchements PR et push", async () => {
  const securite = await lire("security");
  assert.match(securite, /^ {2}workflow_call:/mu);
  assert.match(securite, /^ {2}workflow_dispatch:/mu);
  assert.match(securite, /^ {2}schedule:/mu);
  assert.doesNotMatch(securite, /^ {2}(?:push|pull_request):/mu);
  assert.equal((securite.match(/ref: \$\{\{ inputs.ref \|\| github.sha \}\}/gu) ?? []).length, 2);
});

test("une publication attend aussi les audits", async () => {
  const publication = (await lire("publication")).replaceAll("\r\n", "\n");
  assert.match(publication, /^ {2}audits:\n {4}uses: \.\/\.github\/workflows\/security.yml$/mu);
  assert.match(publication, /^ {2}publier:\n {4}name: [^\n]+\n {4}needs: audits$/mu);
  assert.match(publication, /ref: \$\{\{ inputs.commit \|\| github.sha \}\}/u);
});
