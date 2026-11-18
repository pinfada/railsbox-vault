/**
 * Le HARNAIS de cache du code (`VAULT_E2E_CODE_MAX_AGE`) est BORNÉ au banc de l'E2E hors ligne (#247, D1g ;
 * revue de #298, second tour, constat 4).
 *
 * Il donne au code de la coquille une fraîcheur que les en-têtes de production n'ont pas (ADR 0023 : `no-cache`).
 * Lue seule de l'environnement, la variable changerait les en-têtes de `npm start` dès qu'elle y serait présente.
 * Elle exige désormais le drapeau `--harnais-e2e-hors-ligne`, que SEUL `playwright.e2e.config.mjs` passe, au serveur
 * de la coquille ; l'un sans l'autre, le serveur REFUSE de démarrer. Lu à un seul endroit : `tools/serve.mjs`.
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

test("témoin : sans variable ni drapeau, le code est `no-cache` (les en-têtes de production)", async (t) => {
  const { port } = await lancer(t, {});
  assert.equal(await entete(port, "/index.html"), "no-cache");
});

test("la variable SEULE (un `npm start` dont l'environnement la porte) : le serveur REFUSE de démarrer", async (t) => {
  const { sortie } = await lancer(t, { env: { VAULT_E2E_CODE_MAX_AGE: "3600" } });
  assert.ok(sortie, "le serveur ne doit pas démarrer avec la variable seule");
  assert.notEqual(sortie.code, 0);
  assert.match(sortie.erreur, /VAULT_E2E_CODE_MAX_AGE/);
  assert.match(sortie.erreur, /harnais-e2e-hors-ligne/);
});

test("le drapeau SEUL, sans durée : le serveur REFUSE de démarrer", async (t) => {
  const { sortie } = await lancer(t, { arguments_: [FANION] });
  assert.ok(sortie, "le drapeau seul ne dit pas quelle fraîcheur donner");
  assert.notEqual(sortie.code, 0);
});

test("une durée illisible (non positive, texte) avec le drapeau : refus", async (t) => {
  for (const valeur of ["0", "-5", "abc", "3600s"]) {
    const { sortie } = await lancer(t, {
      env: { VAULT_E2E_CODE_MAX_AGE: valeur },
      arguments_: [FANION],
    });
    assert.ok(sortie, `« ${valeur} » doit être refusée`);
  }
});

test("la variable ET le drapeau : le CODE est mis en cache, mais pas /artifacts/ (l'origine « injoignable »)", async (t) => {
  const { port } = await lancer(t, {
    env: { VAULT_E2E_CODE_MAX_AGE: "3600" },
    arguments_: [FANION],
  });
  assert.equal(await entete(port, "/index.html"), "public, max-age=3600");
  assert.equal(await entete(port, "/artifacts/application.json"), "no-cache");
});
