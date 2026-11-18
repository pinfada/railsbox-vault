/**
 * Le HARNAIS de cache du code (`VAULT_E2E_CODE_MAX_AGE`) est BORNÉ au banc de l'E2E hors ligne (#247, D1g ;
 * revue de #298, second tour, constat 4).
 *
 * Il donne au code de la coquille une fraîcheur que les en-têtes de production n'ont pas (ADR 0023 : `no-cache`).
 * Lue de l'environnement, la variable changerait les en-têtes de `npm start` dès qu'elle y serait présente, et un serveur
 * lancé par la config Playwright pour une autre raison la recevrait aussi. La fraîcheur n'est donc lue que de
 * l'ARGUMENT `--harnais-e2e-hors-ligne <secondes>`, que SEUL `playwright.e2e.config.mjs` passe, au seul serveur de la
 * coquille ; `tools/serve.mjs` ne lit aucune variable. Un argument sans durée entière positive fait refuser le démarrage.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVEUR = fileURLToPath(new URL("../../tools/serve.mjs", import.meta.url));

/** Lance le serveur ; rend `{ port }` s'il démarre, ou `{ sortie: { code, erreur } }` s'il refuse. */
async function lancer(t, { env = {}, arguments_ = [] }) {
  const racine = await mkdtemp(join(tmpdir(), "vault-serve-harnais-"));
  for (const dossier of ["public", "src", "vendor", "artifacts"]) {
    await mkdir(join(racine, dossier), { recursive: true });
  }
  await writeFile(join(racine, "public/index.html"), "coquille");
  await writeFile(join(racine, "artifacts/application.json"), "{}");
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const environnement = { ...process.env, ...env };
  delete environnement.VAULT_E2E_CODE_MAX_AGE;
  Object.assign(environnement, env);
  const enfant = spawn(
    process.execPath,
    [SERVEUR, "--host", "127.0.0.1", "--port", String(port), ...arguments_],
    { cwd: racine, env: environnement, stdio: ["ignore", "pipe", "pipe"] },
  );
  let erreur = "";
  enfant.stderr.on("data", (morceau) => (erreur += morceau));
  t.after(async () => {
    if (enfant.exitCode === null && enfant.signalCode === null) {
      const fin = once(enfant, "exit");
      enfant.kill();
      await fin;
    }
    await rm(racine, { recursive: true, force: true });
  });
  const issue = await Promise.race([
    once(enfant.stdout, "data").then(() => ({ demarre: true })),
    once(enfant, "exit").then(([code]) => ({ demarre: false, code })),
  ]);
  return issue.demarre ? { port } : { sortie: { code: issue.code, erreur } };
}

function entete(port, chemin) {
  return new Promise((resolve, reject) => {
    request({ hostname: "127.0.0.1", port, path: chemin, method: "GET" }, (reponse) => {
      reponse.resume();
      resolve(reponse.headers["cache-control"]);
    })
      .on("error", reject)
      .end();
  });
}

const FANION = "--harnais-e2e-hors-ligne";

test("témoin : sans argument, le code est `no-cache` (les en-têtes de production)", async (t) => {
  const { port } = await lancer(t, {});
  assert.equal(await entete(port, "/index.html"), "no-cache");
});

test("la variable d'environnement SEULE n'a AUCUN effet : un `npm start` dont l'environnement la porte garde ses en-têtes", async (t) => {
  const { port } = await lancer(t, { env: { VAULT_E2E_CODE_MAX_AGE: "3600" } });
  assert.equal(await entete(port, "/index.html"), "no-cache");
  assert.equal(await entete(port, "/artifacts/application.json"), "no-cache");
});

test("l'argument SANS durée, ou avec une durée illisible (non positive, texte) : le serveur REFUSE de démarrer", async (t) => {
  for (const arguments_ of [
    [FANION],
    [FANION, "0"],
    [FANION, "-5"],
    [FANION, "abc"],
    [FANION, "3600s"],
  ]) {
    const { sortie } = await lancer(t, { arguments_ });
    assert.ok(sortie, `${arguments_.join(" ")} doit être refusé`);
    assert.notEqual(sortie.code, 0);
    assert.match(sortie.erreur, /harnais-e2e-hors-ligne/);
  }
});

test("l'argument avec une durée : le CODE est mis en cache, mais pas /artifacts/ (l'origine « injoignable »)", async (t) => {
  const { port } = await lancer(t, { arguments_: [FANION, "3600"] });
  assert.equal(await entete(port, "/index.html"), "public, max-age=3600");
  assert.equal(await entete(port, "/artifacts/application.json"), "no-cache");
});
