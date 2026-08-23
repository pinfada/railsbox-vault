import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  analyserDockerfile,
  analyserSources,
  digestsDeclares,
} from "../../tools/build-reference-image/pinning-contract.mjs";
import { verifierEpinglage } from "../../tools/build-reference-image/verify-pinning.mjs";

const racineDepot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dossierConstruction = join(racineDepot, "tools", "build-reference-image");
const sources = JSON.parse(readFileSync(join(dossierConstruction, "sources.json"), "utf8"));

const DIGEST_CONNU = sources.images.rootfs.digest;

/** @param {import("../../tools/build-reference-image/pinning-contract.mjs").Anomalie[]} anomalies */
const codes = (anomalies) => anomalies.map((anomalie) => anomalie.code);

test("la chaîne de construction réelle est intégralement épinglée", () => {
  const { anomalies, fichiers } = verifierEpinglage();

  assert.deepEqual(anomalies, [], anomalies.map((anomalie) => anomalie.message).join("\n"));
  assert.ok(fichiers.length >= 3, `Dockerfiles analysés : ${fichiers.join(", ")}`);
});

test("un FROM sans empreinte est refusé", () => {
  const anomalies = analyserDockerfile("FROM debian:bookworm-slim\nRUN true\n");

  assert.deepEqual(codes(anomalies), ["from-non-epingle"]);
});

test("une empreinte absente de sources.json est refusée", () => {
  const inconnue = `sha256:${"0".repeat(64)}`;
  const anomalies = analyserDockerfile(`FROM debian:bookworm-slim@${inconnue}\n`, {
    digestsConnus: [DIGEST_CONNU],
  });

  assert.deepEqual(codes(anomalies), ["from-hors-sources"]);
});

test("un étage interne référencé par son nom n'a pas à être épinglé", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU} AS socle`,
    "FROM socle AS application",
    "RUN true",
    "",
  ].join("\n");

  assert.deepEqual(analyserDockerfile(texte, { digestsConnus: [DIGEST_CONNU] }), []);
});

test("un ARG ou un ENV de secret fait échouer la vérification", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU}`,
    "ARG SECRET_KEY_BASE",
    "ENV API_TOKEN=abcdef",
    "",
  ].join("\n");

  assert.deepEqual(codes(analyserDockerfile(texte)), ["secret-exige", "secret-exige"]);
});

test("un montage de secret BuildKit est refusé", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU}`,
    "RUN --mount=type=secret,id=cle cat /run/secrets/cle",
    "",
  ].join("\n");

  assert.deepEqual(codes(analyserDockerfile(texte)), ["secret-exige"]);
});

test("copier une clé maîtresse Rails est refusé", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU}`,
    "COPY config/master.key /app/",
    "",
  ].join("\n");

  assert.deepEqual(codes(analyserDockerfile(texte)), ["secret-copie"]);
});

test("un téléchargement sans vérification d'empreinte est refusé", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU}`,
    "RUN curl -fsSL https://exemple.test/archive.tar.gz -o /tmp/a.tgz && tar -xf /tmp/a.tgz",
    "",
  ].join("\n");

  assert.deepEqual(codes(analyserDockerfile(texte)), ["telechargement-non-verifie"]);
});

test("le même téléchargement suivi d'un sha256sum -c est accepté", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU}`,
    "RUN curl -fsSL https://exemple.test/archive.tar.gz -o /tmp/a.tgz \\",
    '    && echo "abc  /tmp/a.tgz" | sha256sum -c -',
    "",
  ].join("\n");

  assert.deepEqual(analyserDockerfile(texte), []);
});

test("ADD depuis une URL est refusé même avec une empreinte ailleurs", () => {
  const texte = [
    `FROM debian:bookworm-slim@${DIGEST_CONNU}`,
    "ADD https://exemple.test/x /x",
    "",
  ].join("\n");

  assert.ok(codes(analyserDockerfile(texte)).includes("telechargement-non-verifie"));
});

test("sources.json réel est complet, licences comprises", () => {
  assert.deepEqual(analyserSources(sources), []);
  assert.ok(digestsDeclares(sources).length >= 3);
});

test("une source privée de licence ou d'empreinte est refusée", () => {
  const ampute = structuredClone(sources);
  delete ampute.images.rootfs.license;
  ampute.ruby.sha256 = "trop-court";
  ampute.firmware.files[0].url = "http://exemple.test/seabios.bin";

  assert.deepEqual(codes(analyserSources(ampute)).sort(), [
    "licence-absente",
    "source-non-epinglee",
    "source-non-epinglee",
  ]);
});
