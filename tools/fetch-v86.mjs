#!/usr/bin/env node
// Récupère les artefacts v86 et l'image de guest décrits par `vendor/v86/MANIFEST.json`, en
// vérifiant chaque empreinte SHA-256. Aucun binaire n'est versionné dans le dépôt : c'est ce script
// qui rend l'expérience reproductible depuis un clone vierge.
//
//   node tools/fetch-v86.mjs          télécharge ce qui manque puis vérifie tout
//   node tools/fetch-v86.mjs --check  vérifie seulement, sans réseau

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  describeVerdict,
  extractTgzEntries,
  planDownloads,
  sha256,
  verifyArtifact,
} from "./v86-manifest.mjs";
import { ARTIFACT_DIRECTORY, MANIFEST_PATH } from "./v86-paths.mjs";

async function readIfPresent(path) {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Téléchargement refusé (${response.status} ${response.statusText}) : ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function verifyAll(manifest) {
  const verdicts = [];
  for (const artifact of manifest.artifacts) {
    const content = await readIfPresent(join(ARTIFACT_DIRECTORY, artifact.name));
    verdicts.push(verifyArtifact(artifact, content));
  }
  return verdicts;
}

async function fetchMissing(manifest, verdicts) {
  const pending = manifest.artifacts.filter(
    (artifact) => verdicts.find((verdict) => verdict.name === artifact.name).status !== "ok",
  );
  if (pending.length === 0) return;

  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  const { tarballs, direct } = planDownloads(pending);

  for (const [url, group] of tarballs) {
    process.stdout.write(`Téléchargement de ${url}\n`);
    const archive = await download(url);
    const expected = manifest.pins.npmTarballSha256;
    const actual = sha256(archive);
    if (expected && actual !== expected) {
      throw new Error(
        `Archive npm inattendue.\n  attendue ${expected}\n  obtenue  ${actual}\n  ${url}`,
      );
    }
    const entries = extractTgzEntries(archive, new Set(group.map((a) => a.source.entry)));
    for (const artifact of group) {
      await writeFile(join(ARTIFACT_DIRECTORY, artifact.name), entries.get(artifact.source.entry));
    }
  }

  for (const artifact of direct) {
    process.stdout.write(`Téléchargement de ${artifact.source.url}\n`);
    await writeFile(join(ARTIFACT_DIRECTORY, artifact.name), await download(artifact.source.url));
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

  let verdicts = await verifyAll(manifest);
  if (!checkOnly) {
    await fetchMissing(manifest, verdicts);
    verdicts = await verifyAll(manifest);
  }

  for (const verdict of verdicts) {
    process.stdout.write(`${describeVerdict(verdict)}\n`);
  }

  const failures = verdicts.filter((verdict) => verdict.status !== "ok");
  if (failures.length > 0) {
    process.stderr.write(
      `\n${failures.length} artefact(s) non conforme(s). Les mesures du spike #4 ne sont pas reproductibles en l'état.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n${verdicts.length} artefacts conformes dans ${ARTIFACT_DIRECTORY}\n`);
}

await main();
