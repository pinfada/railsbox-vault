/**
 * Un processus 32 bits peut créer une socket pendant la construction de l'image (#295).
 *
 * Depuis le 29/10/2026 `ubuntu-latest` est ubuntu-26.04 : Docker 29.4.2 y resserre le profil seccomp
 * (moby#52494, CVE-2026-31431) et le constructeur intégré renvoie ENOSYS à `socket` pour les
 * binaires i386. `apt-get update` y dit « Temporary failure resolving », ce qui ressemble à un
 * défaut de DNS et n'en est pas un. Cette épreuve exerce le constructeur que l'outillage choisit
 * (`tools/docker-constructeur.mjs`) sur ce qui casse, et rien d'autre : elle n'a pas besoin du
 * réseau, et elle échoue en quelques secondes avec la cause, avant vingt minutes de construction.
 *
 * Elle exige Docker et s'ignore avec son motif sinon, comme les autres suites VM.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { DOCKERFILE_SONDE, obtenirConstructeur } from "../../tools/docker-constructeur.mjs";

function dockerDisponible() {
  const sonde = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return sonde.error === undefined && sonde.status === 0;
}

test(
  "un RUN i386 crée une socket avec le constructeur retenu par l'outillage",
  { skip: dockerDisponible() ? false : "Docker indisponible", timeout: 300_000 },
  () => {
    const { argumentsDeBuild } = obtenirConstructeur();
    const resultat = spawnSync(
      "docker",
      argumentsDeBuild(["--platform", "linux/386", "--no-cache", "--progress=plain", "-"]),
      { input: DOCKERFILE_SONDE, encoding: "utf8" },
    );
    assert.equal(resultat.status, 0, `${resultat.stdout}\n${resultat.stderr}`);
  },
);
