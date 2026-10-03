/**
 * L'empreinte d'image alimentée par les empreintes VÉRIFIÉES (#247, point 4) : même valeur, au bit
 * près, que le hachage des octets — la liaison d'instantané et le gate « reprise » ne bougent pas.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { empreinteDeLImage } from "../../src/vm/instantane-du-boot.mjs";

const NOMS = ["wasm", "bios", "vgaBios", "kernel", "initrd", "rootfs", "paquet"];

function jeuFixe() {
  return Object.fromEntries(
    NOMS.map((nom, rang) => [
      nom,
      Uint8Array.from({ length: 1000 + rang * 77 }, (_, i) => (i * 31 + rang) % 256),
    ]),
  );
}

const hex = (octets) => createHash("sha256").update(octets).digest("hex");

test("rootfs et paquet pris par leur empreinte vérifiée rendent la même empreinte d'image", async () => {
  const artifacts = jeuFixe();
  const deReference = await empreinteDeLImage(artifacts);
  const parEmpreintes = await empreinteDeLImage(artifacts, {
    rootfs: hex(artifacts.rootfs),
    paquet: hex(artifacts.paquet),
  });
  assert.deepEqual(parEmpreintes, deReference);
});

test("une empreinte vérifiée différente change l'empreinte d'image (elle est bien employée)", async () => {
  const artifacts = jeuFixe();
  const deReference = await empreinteDeLImage(artifacts);
  const autre = await empreinteDeLImage(artifacts, { paquet: "0".repeat(64) });
  assert.notDeepEqual(autre, deReference);
});

test("une empreinte vérifiée mal formée est ignorée : les octets sont hachés", async () => {
  const artifacts = jeuFixe();
  assert.deepEqual(
    await empreinteDeLImage(artifacts, { rootfs: "pas-une-empreinte" }),
    await empreinteDeLImage(artifacts),
  );
});
