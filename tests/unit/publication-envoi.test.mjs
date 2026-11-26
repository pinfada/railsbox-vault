/**
 * L'ÉTAPE D'ENVOI inerte (#45) : sans secrets, ou en répétition, RIEN n'est envoyé ; wrangler est épinglé ;
 * le jeton n'est jamais imprimé.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as envoi from "../../tools/publier-envoi.mjs";

const OUTIL = fileURLToPath(new URL("../../tools/publier-envoi.mjs", import.meta.url));
const MIO = 1024 * 1024;

test("wrangler est épinglé à une version EXACTE", () => {
  assert.match(envoi.VERSION_DE_WRANGLER, /^\d+\.\d+\.\d+$/);
  const { arguments: args } = envoi.commandeDeWrangler({ arbre: "/a", projet: "mon-projet" });
  assert.ok(args.includes(`wrangler@${envoi.VERSION_DE_WRANGLER}`));
  assert.deepEqual(args.slice(2, 4), ["pages", "deploy"]);
  assert.ok(!args.some((arg) => /latest|\^|~/.test(arg)));
});

test("un nom de projet douteux est refusé (pas d'injection d'option)", () => {
  for (const mauvais of ["--x", "A", "a b", "a;b", "", undefined]) {
    assert.throws(
      () => envoi.commandeDeWrangler({ arbre: "/a", projet: mauvais }),
      /Nom de projet/,
    );
  }
});

test("décision : l'envoi exige la demande ET les deux secrets ; une valeur vide est une absence", () => {
  const tous = { CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "y" };
  assert.equal(envoi.decider({ envoyer: true, environnement: tous }).mode, "envoi");
  assert.equal(envoi.decider({ envoyer: false, environnement: tous }).mode, "repetition");
  assert.equal(envoi.decider({ envoyer: true, environnement: {} }).mode, "repetition");
  assert.equal(
    envoi.decider({ envoyer: true, environnement: { ...tous, CLOUDFLARE_API_TOKEN: "  " } }).mode,
    "repetition",
  );
  assert.deepEqual(
    envoi.decider({ envoyer: true, environnement: { CLOUDFLARE_ACCOUNT_ID: "y" } }).manquants,
    ["CLOUDFLARE_API_TOKEN"],
  );
});

async function arbre(octets) {
  const racine = await mkdtemp(join(tmpdir(), "envoi-"));
  await mkdir(join(racine, "artifacts"), { recursive: true });
  await writeFile(join(racine, "_headers"), "/*\n  X-A: 1\n");
  await writeFile(join(racine, "artifacts", "gros.bin"), Buffer.alloc(octets, 1));
  return racine;
}
const lancer = (args, env) =>
  spawnSync(process.execPath, [OUTIL, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

test("répétition à blanc : rapporte le fichier en dépassement, rend 0, n'envoie rien, n'imprime pas le jeton", async (t) => {
  const racine = await arbre(26 * MIO);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const secrets = {
    CLOUDFLARE_API_TOKEN: "JETON-SECRET-NE-PAS-IMPRIMER",
    CLOUDFLARE_ACCOUNT_ID: "compte-secret",
  };
  for (const args of [["--repetition"], ["--envoyer"]]) {
    const env = args[0] === "--repetition" ? secrets : {};
    const r = lancer(["--arbre", racine, "--projet", "mon-projet", ...args], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RÉPÉTITION À BLANC/);
    assert.match(r.stdout, /DÉPASSEMENT\s+octets-par-fichier\s+artifacts\/gros\.bin/);
    assert.match(r.stdout, /RIEN N'A ÉTÉ ENVOYÉ/);
    assert.match(r.stdout, /wrangler@\d+\.\d+\.\d+ pages deploy/);
    assert.ok(!r.stdout.includes("JETON-SECRET") && !r.stdout.includes("compte-secret"));
  }
});

test("avec secrets et --envoyer, un dépassement REFUSE l'envoi (code 7) avant d'appeler wrangler", async (t) => {
  const racine = await arbre(26 * MIO);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const r = lancer(["--arbre", racine, "--projet", "mon-projet", "--envoyer"], {
    CLOUDFLARE_API_TOKEN: "x",
    CLOUDFLARE_ACCOUNT_ID: "y",
    // Un `npx` qui échouerait bruyamment s'il était appelé : le refus doit précéder tout appel.
    PATH: "/nonexistent",
  });
  assert.equal(r.status, envoi.CODES_ENVOI.limites, r.stderr);
  assert.match(r.stderr, /Envoi REFUSÉ/);
});

test("usages invalides : --repetition et --envoyer ensemble, projet absent", async (t) => {
  const racine = await arbre(1);
  t.after(() => rm(racine, { recursive: true, force: true }));
  assert.equal(
    lancer(["--arbre", racine, "--projet", "p-p", "--repetition", "--envoyer"], {}).status,
    3,
  );
  assert.equal(lancer(["--arbre", racine], {}).status, 3);
});
