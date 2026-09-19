/**
 * La COMPRESSION des morceaux servis (#236 T2) : gzip standard, DÉTERMINISTE — deux fabrications d'un
 * même disque rendent les mêmes octets, quel que soit le système qui compresse (#212).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { compresserDeterministe, nomServi } from "../../tools/paquet/compression.mjs";

test("deux compressions d'un même disque rendent les mêmes octets, et l'image se relit exacte", async (t) => {
  const dossier = mkdtempSync(join(tmpdir(), "vault-compression-"));
  t.after(() => rmSync(dossier, { recursive: true, force: true }));
  const image = Buffer.alloc(256 * 1024);
  image.fill(0x5a, 4096, 12288);
  writeFileSync(join(dossier, "disque.ext4"), image);
  const a = await compresserDeterministe(join(dossier, "disque.ext4"), join(dossier, "a.gz"));
  const b = await compresserDeterministe(join(dossier, "disque.ext4"), join(dossier, "b.gz"));
  assert.deepEqual(a, b);
  const octets = readFileSync(join(dossier, "a.gz"));
  assert.deepEqual([octets[0], octets[1]], [0x1f, 0x8b], "un gzip RFC 1952");
  assert.equal(octets.readUInt32LE(4), 0, "aucune date dans l'en-tête");
  assert.equal(octets[3] & 0x08, 0, "aucun nom de fichier dans l'en-tête");
  assert.equal(octets[9], 0xff, "l'octet OS ne dépend pas de la machine qui compresse");
  assert.deepEqual(gunzipSync(octets), image);
  assert.ok(a.byteSize < image.byteLength / 10);
});

test("le nom servi porte l'empreinte de l'image DÉCOMPRESSÉE", () => {
  const sha = "ccf1f18c" + "0".repeat(56);
  assert.equal(nomServi("reference-rootfs.ext4", sha), "reference-rootfs-ccf1f18c.ext4.gz");
  assert.equal(nomServi("app-1.0.0-ccf1f18c.ext4", sha), "app-1.0.0-ccf1f18c.ext4.gz");
});
