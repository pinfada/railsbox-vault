/**
 * Les EMPREINTES des artefacts du démarrage dans le descripteur (#247, D1g) : noyau, initrd, BIOS et
 * VGA BIOS ne portaient qu'un nom. Pour passer par le magasin — et pour être vérifiés — chacun a
 * besoin d'une empreinte et d'une taille épinglées. `boot.empreintes` est facultatif (un descripteur
 * antérieur reste lisible, sans le hors ligne) mais TOUT OU RIEN.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { descripteurApplicatif } from "../../tools/build-reference-image/manifest.mjs";
import { formeDuDescripteur } from "../../src/coquille/descripteur-applicatif.mjs";
import { adressesDuRuntime } from "../../src/coquille/application-de-reference.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const E = (c) => c.repeat(64);
const EMPREINTES = {
  kernel: { sha256: E("1"), octets: 6_000_000 },
  initrd: { sha256: E("2"), octets: 9_000_000 },
  bios: { sha256: E("3"), octets: 131_072 },
  vgaBios: { sha256: E("4"), octets: 38_912 },
};
const avec = (empreintes) => {
  const d = descripteurDEpreuve();
  d.boot = { ...d.boot, empreintes };
  return d;
};

test("des empreintes complètes et bien formées sont admises", () => {
  assert.equal(formeDuDescripteur(avec(EMPREINTES)).valide, true);
});

test("sans empreintes, le descripteur reste admis (sans le hors ligne)", () => {
  assert.equal(formeDuDescripteur(descripteurDEpreuve()).valide, true);
});

test("tout ou rien : un artefact sans empreinte est refusé", () => {
  for (const manque of Object.keys(EMPREINTES)) {
    const reste = Object.fromEntries(Object.entries(EMPREINTES).filter(([cle]) => cle !== manque));
    const forme = formeDuDescripteur(avec(reste));
    assert.equal(forme.valide, false, manque);
    assert.match(forme.motif, new RegExp(manque));
  }
});

test("une empreinte mal formée, une taille hors bornes ou un champ étranger sont refusés", () => {
  const cas = [
    { ...EMPREINTES, kernel: { sha256: "xyz", octets: 10 } },
    { ...EMPREINTES, kernel: { sha256: E("A"), octets: 10 } },
    { ...EMPREINTES, initrd: { sha256: E("2"), octets: 0 } },
    { ...EMPREINTES, initrd: { sha256: E("2"), octets: -5 } },
    { ...EMPREINTES, initrd: { sha256: E("2"), octets: 1.5 } },
    { ...EMPREINTES, bios: { sha256: E("3"), octets: 2 ** 40 } },
    { ...EMPREINTES, autre: { sha256: E("5"), octets: 1 } },
    { ...EMPREINTES, bios: { sha256: E("3"), octets: 1, url: "https://example.test/" } },
    "pas un objet",
    null,
  ];
  for (const empreintes of cas) {
    assert.equal(formeDuDescripteur(avec(empreintes)).valide, false, JSON.stringify(empreintes));
  }
});

test("la fabrication reprend noyau, initrd, BIOS et VGA BIOS du manifeste d'image, avec leur taille", () => {
  const artefact = (name, byteSize, sha256, extra = {}) => ({ name, byteSize, sha256, ...extra });
  const manifeste = {
    application: { id: "app", version: "1.0.0", schema: "s" },
    artifacts: [
      artefact("rootfs.ext4", 10, E("a")),
      artefact("app.ext4", 10, E("b")),
      artefact("graine.ext4", 10, E("c")),
      artefact("vmlinuz", 6_000_000, E("1")),
      artefact("initrd.img", 9_000_000, E("2")),
      artefact("seabios.bin", 131_072, E("3")),
      artefact("vgabios.bin", 38_912, E("4")),
    ],
    boot: {
      rootfs: "rootfs.ext4",
      paquet: "app.ext4",
      graine: "graine.ext4",
      kernel: "vmlinuz",
      initrd: "initrd.img",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
      cmdline: "",
      memoryMiB: 1,
    },
    donnees: { disqueOctets: 1 },
  };
  assert.deepEqual(descripteurApplicatif(manifeste, "1.0.0").boot.empreintes, EMPREINTES);
});

test("un manifeste qui ne décrit pas l'un des quatre artefacts ne produit AUCUNE empreinte", () => {
  const manifeste = {
    application: { id: "app", version: "1.0.0", schema: "s" },
    artifacts: [
      { name: "rootfs.ext4", byteSize: 10, sha256: E("a") },
      { name: "app.ext4", byteSize: 10, sha256: E("b") },
      { name: "graine.ext4", byteSize: 10, sha256: E("c") },
      { name: "vmlinuz", byteSize: 1, sha256: E("1") },
    ],
    boot: {
      rootfs: "rootfs.ext4",
      paquet: "app.ext4",
      graine: "graine.ext4",
      kernel: "vmlinuz",
      initrd: "absent.img",
      bios: "b",
      vgaBios: "v",
      cmdline: "",
      memoryMiB: 1,
    },
    donnees: { disqueOctets: 1 },
  };
  assert.equal(descripteurApplicatif(manifeste, "1.0.0").boot.empreintes, undefined);
});

// --- adressesDuRuntime : en ligne, le manifeste v86 est lu ; hors connexion, il est donné --------

const MANIFESTE_V86 = {
  artifacts: [
    { name: "libv86.mjs", bytes: 356131, sha256: "4".repeat(64) },
    { name: "v86.wasm", bytes: 2096474, sha256: "8".repeat(64) },
  ],
};

test("en ligne, adressesDuRuntime lit le manifeste v86 et le rend avec les empreintes du boot", async () => {
  const demandes = [];
  const recuperer = async (url) => {
    demandes.push(url);
    return { ok: true, json: async () => MANIFESTE_V86 };
  };
  const runtime = await adressesDuRuntime(avec(EMPREINTES), { recuperer });
  assert.deepEqual(demandes, ["/vendor/v86/MANIFEST.json"]);
  assert.deepEqual(runtime.manifesteV86, MANIFESTE_V86);
  assert.deepEqual(runtime.empreintes, EMPREINTES);
  assert.equal(runtime.horsConnexion, undefined);
  assert.match(runtime.wasm, /^\/vendor\/v86\/artefacts\/v86-8888888888888888\.wasm$/);
});

test("hors connexion, adressesDuRuntime n'appelle PAS le réseau : le manifeste vient du descripteur scellé", async () => {
  const runtime = await adressesDuRuntime(avec(EMPREINTES), {
    recuperer: () => assert.fail("aucune requête hors connexion"),
    horsConnexion: { manifesteV86: MANIFESTE_V86 },
  });
  assert.equal(runtime.horsConnexion, true);
  assert.deepEqual(runtime.manifesteV86, MANIFESTE_V86);
  assert.match(runtime.lib, /libv86-4444444444444444\.mjs$/);
});

test("sans empreintes au descripteur, le runtime les rend nulles", async () => {
  const runtime = await adressesDuRuntime(descripteurDEpreuve(), {
    recuperer: async () => ({ ok: true, json: async () => MANIFESTE_V86 }),
  });
  assert.equal(runtime.empreintes, null);
});
