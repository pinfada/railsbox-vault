#!/usr/bin/env node
// Récupère les artefacts v86 et l'image de guest décrits par `vendor/v86/MANIFEST.json`, en
// vérifiant chaque empreinte SHA-256. Aucun binaire n'est versionné dans le dépôt : c'est ce script
// qui rend l'expérience reproductible depuis un clone vierge.
//
//   node tools/fetch-v86.mjs          télécharge ce qui manque puis vérifie tout
//   node tools/fetch-v86.mjs --check  vérifie seulement, sans réseau
//
// DEUX vérifications post-récupération, indépendantes et toutes deux rapportées :
//
//  - l'EMPREINTE dit d'où vient l'octet. Code de sortie 1 si elle ne correspond pas ;
//  - la GARDE DE MÉMOIRE PARTAGÉE dit ce que l'octet réclame de la plateforme. L'ADR 0010 décide de
//    ne pas imposer l'isolation multi-origine, sur un fait daté : `v86.wasm` de `v86@0.5.432` ne
//    déclare ni n'importe de mémoire `shared`. Une montée de version peut invalider ce fait sans
//    aucun autre signal — une empreinte mise à jour reste conforme. Ce script étant le seul point
//    par lequel un artefact v86 entre dans le dépôt, la garde y est rattachée (#75). Code 2 sur une
//    mémoire partagée, 3 si l'artefact est absent, illisible ou disparu du manifeste.
//
// La garde ne masque pas la vérification d'empreinte et ne s'y substitue pas : les deux verdicts
// sont imprimés à chaque exécution, la première qui échoue n'avalant pas l'autre.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CODES_DE_SORTIE, verdictGardeMemoire } from "./isolation-analyse-wasm.mjs";
import {
  describeVerdict,
  extractTgzEntries,
  planDownloads,
  sha256,
  verifyArtifact,
} from "./v86-manifest.mjs";
import {
  ARTIFACT_DIRECTORY,
  MANIFEST_PATH,
  cheminDeLArtefact,
  nomDeFichier,
} from "./v86-paths.mjs";

/** Nom de l'artefact que la garde de l'ADR 0010 doit lire. */
const WASM_ARTIFACT_NAME = "v86.wasm";
/** Code de sortie historique d'un défaut d'empreinte. Il reste le sien. */
const DIGEST_EXIT_CODE = 1;

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

/**
 * Lit chaque artefact une fois et rend son verdict d'empreinte AVEC son contenu. Le contenu est
 * conservé parce que la garde de mémoire partagée doit relire les mêmes octets : le fichier est
 * déjà en mémoire pour son empreinte, et le relire serait admettre qu'il ait pu changer entre les
 * deux vérifications.
 */
async function readAll(manifest) {
  const entries = [];
  for (const artifact of manifest.artifacts) {
    const content = await readIfPresent(cheminDeLArtefact(artifact));
    entries.push({ artifact, content, verdict: verifyArtifact(artifact, content) });
  }
  return entries;
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
      await writeFile(cheminDeLArtefact(artifact), entries.get(artifact.source.entry));
    }
  }

  for (const artifact of direct) {
    process.stdout.write(`Téléchargement de ${artifact.source.url}\n`);
    await writeFile(cheminDeLArtefact(artifact), await download(artifact.source.url));
  }
}

/**
 * Retire de `vendor/v86/artefacts/` ce que le manifeste ne déclare plus.
 *
 * C'est la moitié « l'ancienne adresse cesse d'exister » d'un ré-épinglage (#123). Depuis que le
 * nom de fichier porte l'empreinte, une montée de version n'ÉCRASE plus les octets d'hier : elle
 * écrit à côté. Sans élagage, `vendor/v86/artefacts/` accumulerait les versions, et la publication
 * les emporterait — la vérification d'épinglage les refuse (code 5), ce qui est le bon refus mais
 * pas le bon geste : le poste qui publie doit être NETTOYÉ, pas seulement grondé.
 *
 * L'élagage est bruyant et borné : il ne touche que ce répertoire, ignoré par git et peuplé par ce
 * script seul, et il nomme chaque fichier retiré. `--check` n'élague rien — il ne modifie rien.
 */
async function elaguer(manifest) {
  const attendus = new Set(manifest.artifacts.map((artifact) => nomDeFichier(artifact)));
  let presents;
  try {
    presents = await readdir(ARTIFACT_DIRECTORY);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const perimes = presents.filter((nom) => !attendus.has(nom));
  for (const nom of perimes) await rm(join(ARTIFACT_DIRECTORY, nom), { force: true });
  return perimes;
}

/**
 * Garde de l'ADR 0010 sur l'artefact wasm du manifeste.
 *
 * Le cas « aucun artefact de ce nom » n'est pas théorique : renommer `v86.wasm` dans le manifeste
 * désarmerait la garde en silence, exactement pendant la montée de version qu'elle surveille.
 */
function guardSharedMemory(entries) {
  const entry = entries.find(({ artifact }) => artifact.name === WASM_ARTIFACT_NAME);
  if (entry === undefined) {
    return {
      statut: "absent",
      codeDeSortie: CODES_DE_SORTIE.artefactsAbsents,
      message: `le manifeste ne décrit aucun ${WASM_ARTIFACT_NAME} : la garde de mémoire partagée (ADR 0010) n'a rien à lire.`,
    };
  }
  return verdictGardeMemoire(entry.content);
}

/**
 * Code de sortie global. Une mémoire partagée l'emporte parce qu'elle rouvre une décision
 * d'architecture, là où une empreinte fautive ne fait qu'invalider un téléchargement — mais les
 * deux échecs sont écrits, quel que soit le code retenu.
 */
function exitCode(failureCount, guard) {
  if (guard.codeDeSortie === CODES_DE_SORTIE.memoirePartagee) return guard.codeDeSortie;
  if (failureCount > 0) return DIGEST_EXIT_CODE;
  return guard.codeDeSortie;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

  let entries = await readAll(manifest);
  if (!checkOnly) {
    await fetchMissing(
      manifest,
      entries.map(({ verdict }) => verdict),
    );
    entries = await readAll(manifest);
    for (const perime of await elaguer(manifest)) {
      process.stdout.write(`Retiré (adresse plus épinglée) : ${perime}
`);
    }
  }

  for (const { verdict } of entries) {
    process.stdout.write(`${describeVerdict(verdict)}\n`);
  }

  const guard = guardSharedMemory(entries);
  process.stdout.write(`${WASM_ARTIFACT_NAME} : ${guard.message}\n`);

  const failures = entries.filter(({ verdict }) => verdict.status !== "ok");
  if (failures.length > 0) {
    process.stderr.write(
      `\n${failures.length} artefact(s) non conforme(s). Les mesures du spike #4 ne sont pas reproductibles en l'état.\n`,
    );
  }
  if (guard.codeDeSortie !== CODES_DE_SORTIE.succes) {
    // Le verdict est déjà écrit sur la sortie standard : cette ligne dit la suite, pas la même
    // chose. Une montée de version ne se contourne pas, elle se décide.
    process.stderr.write(
      `\nGarde de mémoire WebAssembly (ADR 0010) — ÉCHEC, code ${guard.codeDeSortie}. ` +
        `Voir le verdict ci-dessus et « Monter v86 de version » dans docs/development.md.\n`,
    );
  }

  process.exitCode = exitCode(failures.length, guard);
  if (process.exitCode === CODES_DE_SORTIE.succes) {
    process.stdout.write(`\n${entries.length} artefacts conformes dans ${ARTIFACT_DIRECTORY}\n`);
  }
}

await main();
