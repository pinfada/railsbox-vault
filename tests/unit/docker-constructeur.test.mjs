/**
 * Le choix du constructeur Docker pour les images i386 (#295) : ce qui se vérifie sans Docker.
 *
 * L'épreuve d'acceptation, elle, exige Docker : `tests/vm/sockets-i386.test.mjs`. Ici on tient les
 * trois propriétés qui ne dépendent pas du démon — l'épinglage du constructeur isolé, la forme des
 * arguments, et la sonde qui doit pouvoir dire « non » à un constructeur qui refuse les sockets.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  argumentsDeBuild,
  DOCKERFILE_SONDE,
  NOM_CONSTRUCTEUR,
} from "../../tools/docker-constructeur.mjs";
import {
  analyserDockerfile,
  analyserSources,
  digestsDeclares,
} from "../../tools/build-reference-image/pinning-contract.mjs";

const sources = JSON.parse(
  readFileSync(new URL("../../tools/build-reference-image/sources.json", import.meta.url), "utf8"),
);

test("le constructeur isolé est épinglé par empreinte et déclaré dans sources.json", () => {
  const { buildkit } = sources.images;
  assert.match(buildkit.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(buildkit.reference, /^moby\/buildkit:v\d+\.\d+\.\d+$/);
  assert.deepEqual(analyserSources(sources), []);
  assert.ok(digestsDeclares(sources).some((d) => d.endsWith(buildkit.digest)));
});

test("sans constructeur isolé, `docker build` garde le démon et charge l'image", () => {
  assert.deepEqual(argumentsDeBuild(null, ["-t", "x", "."]), ["build", "--load", "-t", "x", "."]);
});

test("avec le constructeur isolé, la construction le nomme et charge l'image dans le démon", () => {
  assert.deepEqual(argumentsDeBuild(NOM_CONSTRUCTEUR, ["-t", "x", "."]), [
    "build",
    "--builder",
    NOM_CONSTRUCTEUR,
    "--load",
    "-t",
    "x",
    ".",
  ]);
});

test("la sonde est un Dockerfile épinglé par empreinte, 32 bits, qui échoue sur ENOSYS et EPERM", () => {
  assert.deepEqual(
    analyserDockerfile(DOCKERFILE_SONDE, { digestsConnus: digestsDeclares(sources) }),
    [],
  );
  assert.match(DOCKERFILE_SONDE, /SHELL \["linux32"/);
  assert.match(DOCKERFILE_SONDE, /Function not implemented/);
  assert.match(DOCKERFILE_SONDE, /Operation not permitted/);
  assert.match(DOCKERFILE_SONDE, /exit 1/);
});
