import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { adresseDe } from "../../src/v86-adresses.mjs";

const SERVEUR = fileURLToPath(new URL("../../tools/serve.mjs", import.meta.url));
const TYPE_DE_LIEN = process.platform === "win32" ? "junction" : "dir";

async function lancerServeur(t, argumentsSupplementaires = []) {
  const racine = await mkdtemp(join(tmpdir(), "vault-serve-securite-"));
  let enfant;
  t.after(async () => {
    if (enfant && enfant.exitCode === null && enfant.signalCode === null) {
      const fin = once(enfant, "exit");
      enfant.kill();
      await fin;
    }
    await rm(racine, { recursive: true, force: true });
  });
  for (const dossier of ["public", "src", "vendor", "artifacts", "prive", "public/interne"]) {
    await mkdir(join(racine, dossier), { recursive: true });
  }
  await writeFile(join(racine, "public/index.html"), "coquille publique");
  await writeFile(join(racine, "prive/secret.txt"), "secret hors des racines servies");
  await writeFile(join(racine, "public/interne/index.html"), "document de confiance");
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  enfant = spawn(
    process.execPath,
    [SERVEUR, "--host", "127.0.0.1", "--port", String(port), ...argumentsSupplementaires],
    {
      cwd: racine,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    enfant.once("error", reject);
    enfant.once("exit", (code) => reject(new Error(`Serveur arrêté : ${code}`)));
    enfant.stdout.once("data", resolve);
  });
  return { racine, port };
}

function lire(port, path, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const requete = request({ hostname: "127.0.0.1", port, path, method, headers }, (reponse) => {
      let corps = "";
      reponse.setEncoding("utf8");
      reponse.on("data", (morceau) => (corps += morceau));
      reponse.on("error", reject);
      reponse.on("end", () =>
        resolve({ statut: reponse.statusCode, entetes: reponse.headers, corps }),
      );
    });
    requete.on("error", reject);
    requete.setTimeout(5000, () => requete.destroy(new Error("Réponse absente")));
    requete.end();
  });
}

test("serveur — les alias localhost ne servent pas la coquille dans un autre jar de cookies", async (t) => {
  const { port } = await lancerServeur(t);
  for (const host of [`localhost:${port}`, `vault.localhost:${port}`, `127.0.0.1:${port + 1}`]) {
    const reponse = await lire(port, "/index.html", "GET", { Host: host });
    assert.equal(reponse.statut, 421);
    assert.equal(reponse.entetes["cache-control"], "no-store");
  }
  const normal = await lire(port, "/index.html");
  assert.equal(normal.statut, 200);
  assert.equal(normal.entetes["x-frame-options"], "DENY");
  assert.equal(normal.entetes["set-cookie"], undefined);
});

test("serveur — un alias DÉCLARÉ est servi, sur son port seulement ; les autres restent refusés", async (t) => {
  // Les épreuves WebAuthn joignent la coquille par `localhost` (un `rpId` ne peut pas être une
  // IP) et la portabilité veut un second hôte : l'alias est déclaré au lancement, et lui seul.
  const { port } = await lancerServeur(t, ["--alias", "localhost"]);
  const alias = await lire(port, "/index.html", "GET", { Host: `localhost:${port}` });
  assert.equal(alias.statut, 200);
  assert.equal(alias.corps, "coquille publique");
  for (const host of [`vault.localhost:${port}`, `localhost:${port + 1}`, "localhost"]) {
    const reponse = await lire(port, "/index.html", "GET", { Host: host });
    assert.equal(reponse.statut, 421, host);
  }
});

test("serveur — aucune des quatre racines ne suit un lien vers des fichiers privés", async (t) => {
  const { racine, port } = await lancerServeur(t);
  for (const dossier of ["public", "src", "vendor", "artifacts"]) {
    await symlink(join(racine, "prive"), join(racine, dossier, "lien"), TYPE_DE_LIEN);
    const prefixe = dossier === "public" ? "" : `/${dossier}`;
    const reponse = await lire(port, `${prefixe}/lien/secret.txt`);
    assert.equal(reponse.statut, 403, dossier);
    assert.equal(reponse.entetes["cache-control"], "no-store");
    assert.equal(reponse.entetes["x-content-type-options"], "nosniff");
    assert.doesNotMatch(reponse.corps, /secret hors/);
  }
});

test("serveur — un alias interne ne contourne pas la politique CSP du chemin", async (t) => {
  const { racine, port } = await lancerServeur(t);
  await symlink(join(racine, "public/interne"), join(racine, "public/compat-alias"), TYPE_DE_LIEN);
  assert.equal((await lire(port, "/compat-alias/index.html")).statut, 403);
  const normal = await lire(port, "/interne/index.html");
  assert.equal(normal.statut, 200);
  assert.match(normal.entetes["content-security-policy"], /default-src 'none'/);
});

test("serveur — une URL invalide est refusée sans arrêter le processus", async (t) => {
  const { port } = await lancerServeur(t);
  const invalide = await lire(port, "http://[");
  assert.equal(invalide.statut, 400);
  assert.equal(invalide.entetes["cache-control"], "no-store");
  assert.equal((await lire(port, "/index.html")).corps, "coquille publique");
});

test("serveur — les fichiers ordinaires restent lisibles sous les quatre racines", async (t) => {
  const { racine, port } = await lancerServeur(t);
  for (const dossier of ["public", "src", "vendor", "artifacts"]) {
    await writeFile(join(racine, dossier, "témoin local.txt"), `contenu ${dossier}`);
    const prefixe = dossier === "public" ? "" : `/${dossier}`;
    const reponse = await lire(port, `${prefixe}/t%C3%A9moin%20local.txt?version=1`);
    assert.equal(reponse.statut, 200);
    assert.equal(reponse.corps, `contenu ${dossier}`);
    assert.equal(reponse.entetes["content-type"], "text/plain; charset=utf-8");
  }
  assert.equal((await lire(port, "/interne/")).statut, 200);
  assert.equal((await lire(port, "/interne")).statut, 404);
});

test("serveur — les chemins ambigus et les flux Windows sont refusés", async (t) => {
  const { port } = await lancerServeur(t);
  for (const chemin of [
    "//ailleurs.test/index.html",
    "/%ZZ",
    "/%00",
    "/index.html::$DATA",
    "/%5cprive",
    "/%2e%2e%2fprive/secret.txt",
  ]) {
    assert.equal((await lire(port, chemin)).statut, 400, chemin);
  }
  assert.equal((await lire(port, "/index.html")).statut, 200);
});

test("serveur — seules GET et HEAD lisent un fichier, les absences restent non cachables", async (t) => {
  const { port } = await lancerServeur(t);
  const refus = await lire(port, "/index.html", "POST");
  assert.equal(refus.statut, 405);
  assert.equal(refus.entetes.allow, "GET, HEAD");
  const tete = await lire(port, "/index.html", "HEAD");
  assert.equal(tete.statut, 200);
  assert.equal(tete.corps, "");
  const absent = await lire(port, adresseDe("v86.wasm", "0".repeat(64)));
  assert.equal(absent.statut, 404);
  assert.equal(absent.entetes["cache-control"], "no-store");
});

test("serveur — un vrai tube nommé n'est jamais lu, et ne bloque jamais la réponse (décision (a) de #225)", async (t) => {
  // `mkfifo` n'existe que sous des systèmes POSIX ; la CI est sous Ubuntu, c'est elle qui compte
  // (voir le brief). Sous Windows, aucun tube nommé ne vit dans l'arbre servi : l'épreuve saute
  // avec un motif nommé, plutôt qu'un silence.
  if (process.platform === "win32") {
    t.skip("mkfifo indisponible sous Windows ; la CI (Ubuntu) rejoue cette épreuve.");
    return;
  }
  const { racine, port } = await lancerServeur(t);
  const cheminFifo = join(racine, "public", "tube-nomme");
  await new Promise((resolve, reject) => {
    execFile("mkfifo", [cheminFifo], (erreur) => (erreur ? reject(erreur) : resolve()));
  });
  // Avant la décision (a), un `stat` bloquant sur un tube SANS écrivain n'aurait posé aucun
  // problème ici (c'est justement ce que ce `stat` évitait) ; ce qui est vérifié est l'ABSENCE de
  // fenêtre et de blocage une fois ouvert en `O_NONBLOCK` : la réponse revient, refusée, sans
  // qu'un écrivain n'ouvre jamais l'autre bout.
  const reponse = await lire(port, "/tube-nomme");
  assert.equal(reponse.statut, 404);
  assert.equal(reponse.entetes["cache-control"], "no-store");
});

test("serveur — un morceau gzip est servi TEL QUEL : octet-stream, sans Content-Encoding (#236 T2)", async (t) => {
  // La coquille décompresse elle-même, par `DecompressionStream`, et hache l'image DÉCOMPRESSÉE : un
  // `Content-Encoding: gzip` ferait décompresser le navigateur d'abord, et la coquille recevrait des
  // octets qui ne sont plus du gzip.
  const { racine, port } = await lancerServeur(t);
  await mkdir(join(racine, "artifacts", "reference-image"), { recursive: true });
  await writeFile(
    join(racine, "artifacts", "reference-image", "graine-08c78ce3.ext4.gz"),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
  );
  const reponse = await lire(port, "/artifacts/reference-image/graine-08c78ce3.ext4.gz");
  assert.equal(reponse.statut, 200);
  assert.equal(reponse.entetes["content-type"], "application/octet-stream");
  assert.equal(reponse.entetes["content-encoding"], undefined);
  // La politique de cache ne change PAS dans #236 T2 : `no-cache`, comme tout `/artifacts/`.
  assert.equal(reponse.entetes["cache-control"], "no-cache");
});
