/**
 * La racine des tranches calculée à la FABRICATION (#247, lot D1c) est celle que le magasin
 * d'artefacts calcule sur les mêmes octets, et le descripteur servi la porte.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { creerMagasinDArtefacts, TRANCHE_OCTETS } from "../../src/vm/magasin-d-artefacts.mjs";
import { tranchesEtRacineDeFichier } from "../../tools/paquet/racine-des-tranches.mjs";
import { construirePaquet, validerPaquet } from "../../tools/paquet/contrat-du-paquet.mjs";
import { descripteurApplicatif } from "../../tools/build-reference-image/manifest.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";

function octetsDeTest(taille) {
  const octets = new Uint8Array(taille);
  for (let i = 0; i < taille; i += 1) octets[i] = (i * 31 + 7) & 0xff;
  return octets;
}

test("la racine de fabrication égale celle du magasin, sur plusieurs tranches", async () => {
  const octets = octetsDeTest(2 * TRANCHE_OCTETS + 1234);
  const dossier = mkdtempSync(join(tmpdir(), "racine-"));
  try {
    const chemin = join(dossier, "image.ext4");
    writeFileSync(chemin, octets);
    const fabrication = tranchesEtRacineDeFichier(chemin);

    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(octets).digest("hex");
    const magasin = creerMagasinDArtefacts({ primitives: primitivesEnMemoire() });
    const admis = await magasin.admettre({ sha256, octets });

    assert.equal(fabrication.tranches.length, 3);
    assert.deepEqual(fabrication.tranches, admis.tranches);
    assert.equal(fabrication.racine, admis.racine);

    // Le magasin SERT l'artefact contre la racine de fabrication.
    const cible = new Uint8Array(octets.byteLength);
    const morceau = { sha256, octets: octets.byteLength, racine: fabrication.racine };
    assert.equal(await magasin.servir(morceau, cible), true);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test("le contrat du paquet garde la racine de l'image et refuse une racine mal formée", () => {
  const servi = { name: "a.ext4.gz", compression: "gzip", byteSize: 10, sha256: "b".repeat(64) };
  const entrees = {
    application: { id: "app", version: "1.0.0", schema: "20260101000000" },
    image: { byteSize: 100, sha256: "a".repeat(64), racine: "c".repeat(64), servi },
    graine: { byteSize: 100, sha256: "d".repeat(64), disqueOctets: 1024, servi },
    exigences: { ruby: "3.3", rails: "8.0", debianSuite: "trixie" },
    secretKeyBase: { derivation: "x" },
    licence: "MIT",
    genereLe: "2026-10-04T00:00:00.000Z",
  };
  const paquet = construirePaquet(entrees);
  assert.equal(paquet.image.racine, "c".repeat(64));
  assert.equal(paquet.graine.racine, undefined);
  const abime = { ...paquet, image: { ...paquet.image, racine: "zz" } };
  assert.ok(validerPaquet(abime).some((a) => /racine mal formée/.test(a.message)));
});

test("le descripteur servi porte la racine des images qui en ont une, et seulement celles-là", () => {
  const artefact = (name, extra = {}) => ({ name, byteSize: 10, sha256: "e".repeat(64), ...extra });
  const manifeste = {
    application: { id: "app", version: "1.0.0", schema: "s" },
    artifacts: [
      artefact("rootfs.ext4", { racine: "1".repeat(64) }),
      artefact("rootfs.ext4.gz"),
      artefact("app.ext4", { racine: "2".repeat(64) }),
      artefact("graine.ext4"),
    ],
    boot: {
      rootfs: "rootfs.ext4",
      paquet: "app.ext4",
      graine: "graine.ext4",
      servis: { rootfs: "rootfs.ext4.gz" },
      cmdline: "",
      memoryMiB: 1,
    },
    donnees: { disqueOctets: 1 },
  };
  const descripteur = descripteurApplicatif(manifeste, "1.0.0");
  assert.equal(descripteur.rootfs.racine, "1".repeat(64));
  assert.equal(descripteur.rootfs.compression, "gzip");
  assert.equal(descripteur.paquet.racine, "2".repeat(64));
  assert.equal("racine" in descripteur.graine, false);
});
