import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  TAR_BLOCK_SIZE,
  describeVerdict,
  extractTarEntries,
  extractTgzEntries,
  planDownloads,
  sha256,
  verifyArtifact,
} from "../../tools/v86-manifest.mjs";
import { MANIFEST_PATH } from "../../tools/v86-paths.mjs";

const encoder = new TextEncoder();

/** Construit une archive tar minimale ; la somme de contrôle d'en-tête n'est pas exigée. */
function buildTar(entries) {
  const blocks = [];
  for (const [name, content, typeFlag = "0"] of entries) {
    const header = new Uint8Array(TAR_BLOCK_SIZE);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode(content.byteLength.toString(8).padStart(11, "0")), 124);
    header[156] = typeFlag.charCodeAt(0);
    blocks.push(header);

    const padded = new Uint8Array(Math.ceil(content.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE);
    padded.set(content);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));

  const total = blocks.reduce((somme, bloc) => somme + bloc.byteLength, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const bloc of blocks) {
    archive.set(bloc, offset);
    offset += bloc.byteLength;
  }
  return archive;
}

test("le lecteur tar extrait les entrées demandées et ignore les autres", () => {
  const archive = buildTar([
    ["package/LICENSE", encoder.encode("BSD-2")],
    ["package/build/libv86.mjs", encoder.encode("export const V86 = 1;")],
  ]);

  const trouvees = extractTarEntries(archive, new Set(["package/build/libv86.mjs"]));
  assert.equal(trouvees.size, 1);
  assert.equal(
    new TextDecoder().decode(trouvees.get("package/build/libv86.mjs")),
    "export const V86 = 1;",
  );
});

test("une entrée absente fait échouer l'extraction au lieu de rendre un résultat partiel", () => {
  const archive = buildTar([["package/LICENSE", encoder.encode("BSD-2")]]);
  assert.throws(
    () => extractTarEntries(archive, new Set(["package/build/v86.wasm"])),
    /Entrées absentes de l'archive/,
  );
});

test("une entrée demandée qui n'est pas un fichier régulier est refusée", () => {
  const archive = buildTar([["package/lien", encoder.encode(""), "2"]]);
  assert.throws(() => extractTarEntries(archive, new Set(["package/lien"])), /seuls les fichiers/);
});

test("l'archive compressée est lue de bout en bout", () => {
  const archive = buildTar([["package/build/v86.wasm", encoder.encode("\0asm")]]);
  const trouvees = extractTgzEntries(gzipSync(archive), new Set(["package/build/v86.wasm"]));
  assert.equal(trouvees.get("package/build/v86.wasm").byteLength, 4);
});

test("la vérification distingue absence, taille et empreinte", () => {
  const contenu = encoder.encode("contenu");
  const artefact = { name: "essai.bin", bytes: contenu.byteLength, sha256: sha256(contenu) };

  assert.equal(verifyArtifact(artefact, contenu).status, "ok");
  assert.equal(verifyArtifact(artefact, null).status, "missing");
  assert.equal(verifyArtifact(artefact, encoder.encode("contenu plus long")).status, "size");
  assert.equal(verifyArtifact({ ...artefact, sha256: "0".repeat(64) }, contenu).status, "digest");
});

test("chaque verdict porte un message exploitable", () => {
  assert.match(
    describeVerdict({ name: "a", status: "missing", expected: "", actual: "" }),
    /vm:fetch/,
  );
  assert.match(
    describeVerdict({ name: "a", status: "digest", expected: "x", actual: "y" }),
    /empreinte SHA-256 inattendue/,
  );
  assert.throws(() => describeVerdict({ name: "a", status: "inconnu" }), /Verdict inconnu/);
});

test("le plan de téléchargement regroupe les entrées d'une même archive npm", () => {
  const { tarballs, direct } = planDownloads([
    {
      name: "a",
      source: { kind: "npm-tarball-entry", url: "https://exemple/x.tgz", entry: "p/a" },
    },
    {
      name: "b",
      source: { kind: "npm-tarball-entry", url: "https://exemple/x.tgz", entry: "p/b" },
    },
    { name: "c", source: { kind: "github-raw", url: "https://exemple/c" } },
  ]);
  assert.equal(tarballs.size, 1);
  assert.equal(tarballs.get("https://exemple/x.tgz").length, 2);
  assert.equal(direct.length, 1);
  assert.throws(
    () => planDownloads([{ name: "d", source: { kind: "magie" } }]),
    /Type de source inconnu/,
  );
});

test("le manifeste versionné décrit une provenance complète pour chaque artefact", async () => {
  const manifeste = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assert.equal(manifeste.contract.id, "railsbox-vault-vendor-v86");
  assert.match(manifeste.pins.upstreamCommit, /^[0-9a-f]{40}$/);
  assert.ok(manifeste.artifacts.length >= 5);

  for (const artefact of manifeste.artifacts) {
    assert.match(artefact.sha256, /^[0-9a-f]{64}$/, `${artefact.name} : empreinte malformée`);
    assert.ok(Number.isInteger(artefact.bytes) && artefact.bytes > 0, `${artefact.name} : taille`);
    assert.ok(artefact.license, `${artefact.name} : licence absente`);
    assert.match(artefact.source.url, /^https:\/\//, `${artefact.name} : source non HTTPS`);
    assert.ok(artefact.role, `${artefact.name} : rôle non documenté`);
  }
});
