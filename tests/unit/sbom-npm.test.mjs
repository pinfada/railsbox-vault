import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function atelier(t, programme) {
  const racine = await mkdtemp(join(tmpdir(), "vault sbom "));
  t.after(() => rm(racine, { recursive: true, force: true }));
  await mkdir(join(racine, "tools"));
  await writeFile(
    join(racine, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "fixture" }, "node_modules/@vault/temoin": { version: "1.2.3" } },
    }),
  );
  const script = join(racine, "tools", "generer-sbom-npm.mjs");
  await copyFile(new URL("../../tools/generer-sbom-npm.mjs", import.meta.url), script);
  const cli = join(racine, "npm temoin.cjs");
  await writeFile(cli, programme);
  const resultat = spawnSync(process.execPath, [script], {
    cwd: tmpdir(),
    env: { ...process.env, npm_execpath: cli, NODE_ENV: "production" },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { racine, resultat, sortie: join(racine, "reports", "supply-chain", "npm.cdx.json") };
}

test("le SBOM exige le verrou et toutes les dépendances, même depuis un autre répertoire", async (t) => {
  const { racine, resultat, sortie } = await atelier(
    t,
    `
    const assert = require('node:assert/strict');
    for (const flag of ['--package-lock-only', '--include=dev', '--include=optional', '--include=peer']) {
      assert.ok(process.argv.includes(flag), flag);
    }
    console.log(JSON.stringify({bomFormat: 'CycloneDX', components: [
      {group: '@vault', name: 'temoin', version: '1.2.3'}
    ], cwd: process.cwd()}));
  `,
  );
  assert.equal(resultat.status, 0, resultat.stderr);
  assert.equal(JSON.parse(await readFile(sortie, "utf8")).cwd, racine);
});

for (const [nom, programme, code] of [
  ["un échec npm", "process.stderr.write('échec témoin'); process.exit(7);", 7],
  ["une sortie tronquée", "console.log('{');", 1],
  ["un autre format", "console.log(JSON.stringify({bomFormat: 'autre', components: []}));", 1],
  [
    "un inventaire vide",
    "console.log(JSON.stringify({bomFormat: 'CycloneDX', components: []}));",
    1,
  ],
  [
    "une version substituée",
    "console.log(JSON.stringify({bomFormat: 'CycloneDX', components: [{group: '@vault', name: 'temoin', version: '9.9.9'}]}));",
    1,
  ],
]) {
  test(`le générateur refuse ${nom} sans publier de SBOM`, async (t) => {
    const { resultat, sortie } = await atelier(t, programme);
    assert.equal(resultat.status, code, resultat.stderr);
    await assert.rejects(readFile(sortie), { code: "ENOENT" });
  });
}
