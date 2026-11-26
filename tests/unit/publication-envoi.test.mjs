/**
 * L'ÉTAPE D'ENVOI inerte (#45) : sans secrets, ou en répétition, RIEN n'est envoyé ; wrangler est épinglé ;
 * le jeton n'est jamais imprimé.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.equal(envoi.PROFIL_D_ENVOI, "cloudflare-pages", "le profil d'envoi n'est pas un choix");
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
/** Un `npx` de FAÇADE : il consigne ses arguments dans un journal, et c'est ainsi que « zéro appel » se prouve. */
async function fauxNpx() {
  const dossier = await mkdtemp(join(tmpdir(), "faux-npx-"));
  const journal = join(dossier, "appels.txt");
  await writeFile(join(dossier, "npx"), `#!/bin/sh\necho "$@" >> "${journal}"\n`, { mode: 0o755 });
  const appels = async () =>
    existsSync(journal) ? (await readFile(journal, "utf8")).trim().split("\n") : [];
  return { dossier, appels };
}
const lancer = (args, env) =>
  spawnSync(process.execPath, [OUTIL, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
const SECRETS = { CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "y" };

test("répétition à blanc : rapporte le fichier en dépassement, rend 0, n'envoie rien, n'imprime pas le jeton", async (t) => {
  const racine = await arbre(26 * MIO);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const secrets = {
    CLOUDFLARE_API_TOKEN: "JETON-SECRET-NE-PAS-IMPRIMER",
    CLOUDFLARE_ACCOUNT_ID: "compte-secret",
  };
  for (const args of [["--repetition"], ["--envoyer"]]) {
    const env = args[0] === "--repetition" ? secrets : {};
    const r = lancer(["--cible", `${racine}=mon-projet`, ...args], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RÉPÉTITION À BLANC/);
    assert.match(r.stdout, /DÉPASSEMENT\s+octets-par-fichier\s+artifacts\/gros\.bin/);
    assert.match(r.stdout, /RIEN N'A ÉTÉ ENVOYÉ/);
    assert.match(r.stdout, /wrangler@\d+\.\d+\.\d+ pages deploy/);
    assert.ok(!r.stdout.includes("JETON-SECRET") && !r.stdout.includes("compte-secret"));
  }
});

test("le profil d'envoi n'est PAS un choix : --profil est refusé, même netlify (aucun envoi Netlify n'existe)", async (t) => {
  const racine = await arbre(1);
  t.after(() => rm(racine, { recursive: true, force: true }));
  const r = lancer(
    ["--cible", `${racine}=mon-projet`, "--envoyer", "--profil", "netlify"],
    SECRETS,
  );
  assert.equal(r.status, envoi.CODES_ENVOI.usage);
});

test("DEUX cibles conformes : deux appels d'envoi, l'application d'abord, dans l'ordre donné", async (t) => {
  const a = await arbre(1);
  const c = await arbre(1);
  const faux = await fauxNpx();
  t.after(() =>
    Promise.all([a, c, faux.dossier].map((d) => rm(d, { recursive: true, force: true }))),
  );
  const r = lancer(["--envoyer", "--cible", `${a}=projet-app`, "--cible", `${c}=projet-coq`], {
    ...SECRETS,
    PATH: faux.dossier,
  });
  assert.equal(r.status, 0, r.stderr);
  const appels = await faux.appels();
  assert.equal(appels.length, 2);
  assert.match(appels[0], /--project-name projet-app /);
  assert.match(appels[1], /--project-name projet-coq /);
});

test("un dépassement sur la SECONDE cible : code 7 et ZÉRO appel d'envoi, pas même pour la première", async (t) => {
  const bon = await arbre(1);
  const gros = await arbre(26 * MIO);
  const faux = await fauxNpx();
  t.after(() =>
    Promise.all([bon, gros, faux.dossier].map((d) => rm(d, { recursive: true, force: true }))),
  );
  const r = lancer(["--envoyer", "--cible", `${bon}=projet-app`, "--cible", `${gros}=projet-coq`], {
    ...SECRETS,
    PATH: faux.dossier,
  });
  assert.equal(r.status, envoi.CODES_ENVOI.limites, r.stderr);
  assert.deepEqual(await faux.appels(), [], "aucun appel");
});

test("un nom de projet invalide sur la seconde cible : usage invalide et ZÉRO appel", async (t) => {
  const bon = await arbre(1);
  const faux = await fauxNpx();
  t.after(() =>
    Promise.all([bon, faux.dossier].map((d) => rm(d, { recursive: true, force: true }))),
  );
  const r = lancer(["--envoyer", "--cible", `${bon}=projet-app`, "--cible", `${bon}=--x`], {
    ...SECRETS,
    PATH: faux.dossier,
  });
  assert.equal(r.status, envoi.CODES_ENVOI.usage);
  assert.deepEqual(await faux.appels(), []);
});

test("usages invalides : --repetition et --envoyer ensemble, aucune cible, cible sans projet", async (t) => {
  const racine = await arbre(1);
  t.after(() => rm(racine, { recursive: true, force: true }));
  assert.equal(lancer(["--cible", `${racine}=p-p`, "--repetition", "--envoyer"], {}).status, 3);
  assert.equal(lancer(["--repetition"], {}).status, 3);
  assert.equal(lancer(["--repetition", "--cible", racine], {}).status, 3);
});
