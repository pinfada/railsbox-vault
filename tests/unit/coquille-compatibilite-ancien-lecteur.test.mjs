/**
 * COMPATIBILITÉ « ancien lecteur × nouveau descripteur » (#247, D1g ; revue de #298, constat 1 ; ADR 0046 § 6).
 *
 * `boot.empreintes` est OBLIGATOIRE : un descripteur qui les porte n'a de sens que pour un lecteur qui les
 * confronte. Le lecteur d'AVANT (`86ae8dc`, importé ici tel quel : `tests/support/lecteur-de-main-86ae8dc/`)
 * accepte une v2 et IGNORE `boot.empreintes` : un onglet resté ouvert, ou une coquille en cache, aurait donc
 * démarré sans les nouvelles vérifications. La barrière est la VERSION du descripteur servi : le nouveau est
 * en version 3, que l'ancien refuse (« version de descripteur inconnue »), et que le nouveau lecteur est seul à lire.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formeDuDescripteur as formeDuNouveau } from "../../src/coquille/descripteur-applicatif.mjs";
import { sceller, ouvrirLeDescripteurScelle } from "../../src/coquille/descripteur-scelle.mjs";
import { deriverCleDeScellementDuDescripteur } from "../../src/vm/derivation/cle-du-descripteur-scelle.mjs";
import { descripteurApplicatif } from "../../tools/build-reference-image/manifest.mjs";
import { formeDuDescripteur as formeDeLAncien } from "../support/lecteur-de-main-86ae8dc/descripteur-applicatif.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const E = (c) => c.repeat(64);

/** Un manifeste d'image complet, tel que `image:manifest` le lit. */
function manifeste() {
  const a = (name, byteSize, sha256) => ({ name, byteSize, sha256 });
  return {
    application: { id: "app", version: "1.0.0", schema: "20260815120000" },
    artifacts: [
      a("rootfs.ext4", 4096, E("a")),
      a("app.ext4", 4096, E("b")),
      a("graine.ext4", 4096, E("c")),
      a("vmlinuz", 6_000_000, E("1")),
      a("initrd.img", 9_000_000, E("2")),
      a("seabios.bin", 131_072, E("3")),
      a("vgabios.bin", 38_912, E("4")),
    ],
    boot: {
      rootfs: "rootfs.ext4",
      paquet: "app.ext4",
      graine: "graine.ext4",
      kernel: "vmlinuz",
      initrd: "initrd.img",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
      cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
      memoryMiB: 32,
    },
    donnees: { disqueOctets: 4096 },
  };
}

test("le descripteur NEUF (celui que `image:manifest` émet) est refusé par l'ANCIEN lecteur : version inconnue", () => {
  const neuf = descripteurApplicatif(manifeste(), "1.0.0");
  assert.ok(neuf.boot.empreintes, "le descripteur neuf porte les empreintes");
  const verdict = formeDeLAncien(neuf);
  assert.equal(verdict.valide, false, "l'ancien lecteur ne doit pas consommer le nouveau contrat");
  assert.match(verdict.motif, /version de descripteur inconnue : 3/);
});

test("le NOUVEAU lecteur lit le descripteur neuf", () => {
  const neuf = descripteurApplicatif(manifeste(), "1.0.0");
  assert.deepEqual(formeDuNouveau(neuf), { valide: true, motif: null });
});

test("un descripteur v2 — l'ancienne émission, même complet — est refusé par le NOUVEAU lecteur : version inconnue", () => {
  const v2 = { ...descripteurDEpreuve(), descripteurVersion: 2 };
  assert.equal(formeDeLAncien(v2).valide, true, "l'ancien lecteur lisait bien la v2 (le témoin)");
  const verdict = formeDuNouveau(v2);
  assert.equal(verdict.valide, false);
  assert.match(verdict.motif, /version de descripteur inconnue : 2/);
});

test("un descripteur v2 RANGÉ ET SCELLÉ avant la règle est refusé à l'ouverture (contenu) : le démarrage en ligne le remplace", async () => {
  const cle = await deriverCleDeScellementDuDescripteur({
    cleMaitresse: new Uint8Array(32).fill(1),
    identifiantVolume: "21282f363d444b525960676e757c838a",
  });
  const octets = await sceller({
    descripteur: { ...descripteurDEpreuve(), descripteurVersion: 2 },
    manifesteV86: { artifacts: [{ name: "v86.wasm", bytes: 10, sha256: E("8") }] },
    rangeLe: 5,
    cle,
  });
  await assert.rejects(ouvrirLeDescripteurScelle({ octets, cle }), {
    contexte: { raison: "contenu" },
  });
});
