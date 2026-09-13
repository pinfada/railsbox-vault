import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  ARTEFACTS_ATTENDUS,
  VERSION_MANIFESTE,
  comparerArtefacts,
  construireManifeste,
  validerManifeste,
} from "../../tools/build-reference-image/manifest-contract.mjs";

const racineDepot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sources = JSON.parse(
  readFileSync(join(racineDepot, "tools", "build-reference-image", "sources.json"), "utf8"),
);
const invariant = JSON.parse(
  readFileSync(join(racineDepot, "apps", "reference", "vault-invariant.json"), "utf8"),
);

/** @param {number} index */
const empreinte = (index) =>
  String(index)
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");

const artefacts = ARTEFACTS_ATTENDUS.map((name, index) => ({
  name,
  role: "essai",
  byteSize: (index + 1) * 1024,
  sha256: empreinte(index + 1),
  license: "MIT",
  origin: "construction locale",
}));

const manifesteDEssai = () =>
  construireManifeste({
    sources,
    artefacts,
    invariant,
    rails: "8.1.3.1",
    environnement: { os: "linux", node: "22.0.0", docker: "29.0.0" },
    genereLe: "2026-08-23T12:00:00.000Z",
  });

test("le manifeste construit décrit l'application, la chaîne et le boot", () => {
  const manifeste = manifesteDEssai();

  assert.equal(manifeste.manifestVersion, VERSION_MANIFESTE);
  assert.equal(manifeste.application.id, invariant.application.id);
  assert.equal(manifeste.application.invariantRecordId, invariant.record.id);
  assert.equal(manifeste.application.attachmentSha256, invariant.attachment.sha256);
  assert.equal(manifeste.toolchain.ruby, sources.ruby.version);
  assert.equal(manifeste.boot.cmdline, sources.guest.cmdline);
  assert.match(manifeste.toolchain.images.rootfs, /@sha256:[0-9a-f]{64}$/);
});

test("le manifeste construit est valide et totalise les tailles", () => {
  const manifeste = manifesteDEssai();

  assert.deepEqual(validerManifeste(manifeste), []);
  assert.equal(
    manifeste.totals.byteSize,
    artefacts.reduce((somme, artefact) => somme + artefact.byteSize, 0),
  );
});

test("les artefacts sont ordonnés par nom, quel que soit l'ordre de production", () => {
  const manifeste = construireManifeste({
    sources,
    artefacts: [...artefacts].reverse(),
    invariant,
    rails: "8.1.3.1",
    environnement: {},
    genereLe: "2026-08-23T12:00:00.000Z",
  });

  assert.deepEqual(
    manifeste.artifacts.map((artefact) => artefact.name),
    [...ARTEFACTS_ATTENDUS].sort((gauche, droite) => gauche.localeCompare(droite)),
  );
});

test("le disque applicatif est un ext4 journalisé, monté avec barrières, et son nom le dit (#209)", () => {
  // Sur ext2, `fsync` ne rend durables ni les bitmaps d'allocation ni les descripteurs de groupe :
  // verrouillé juste après une écriture acquittée, le coffre rouvre un système de fichiers où
  // l'allocation suivante reprend un inode déjà utilisé (#209, EIO mesuré sous v86). Le journal
  // valide ces métadonnées à chaque barrière.
  assert.equal(sources.disk.appDiskFilesystem, "ext4");
  assert.ok(ARTEFACTS_ATTENDUS.includes(`reference-app.${sources.disk.appDiskFilesystem}`));
  assert.equal(manifesteDEssai().boot.hdb, `reference-app.${sources.disk.appDiskFilesystem}`);

  const init = readFileSync(
    join(racineDepot, "tools", "build-reference-image", "guest", "guest-init.sh"),
    "utf8",
  );
  const montages = init.split("\n").filter((ligne) => /^\s*mount\b.*\/dev\/sdb/.test(ligne));
  assert.equal(montages.length, 1, "un seul montage du disque applicatif");
  assert.match(montages[0], /-t ext4\b/);
  assert.doesNotMatch(montages[0], /ext2|nobarrier|barrier=0|data=writeback|noload/);
});

test("l'état du disque applicatif est observable à chaque boot (revue #211, constat 5)", () => {
  // `errors=continue` laissait un ext4 en erreur écrire encore, si bien que « l'écriture suivante
  // réussit » ne prouvait rien ; et `dmesg -n 1` AVANT le montage rendait muets le rejeu du journal
  // et toute erreur `EXT4-fs`. L'init relève donc l'état après le montage, le dit sur la série et le
  // dépose pour l'application, puis seulement fait taire la console avant le pont.
  const init = readFileSync(
    join(racineDepot, "tools", "build-reference-image", "guest", "guest-init.sh"),
    "utf8",
  );
  const lignes = init.split("\n");
  const rang = (motif) => lignes.findIndex((ligne) => motif.test(ligne));
  const montage = lignes[rang(/^\s*mount\b.*\/dev\/sdb/)];

  assert.match(montage, /errors=remount-ro/);
  assert.ok(
    rang(/^\s*dmesg -n 1\b/) > rang(/^\s*mount\b.*\/dev\/sdb/),
    "console muette APRÈS le montage",
  );
  assert.ok(rang(/^\s*dmesg -n 1\b/) < rang(/start-app\.sh/), "console muette AVANT l'application");
  assert.ok(
    rang(/^\s*dmesg -n 1\b/) > rang(/errors_count/),
    "état relevé avant de faire taire la console",
  );
  assert.match(init, /\/sys\/fs\/ext4\/sdb\/errors_count/);
  assert.match(init, /EXT4-fs error\|mounting unchecked/);
  assert.match(init, /\/run\/vault-disque-applicatif/);
});

test("un artefact attendu manquant est refusé", () => {
  const manifeste = manifesteDEssai();
  manifeste.artifacts = manifeste.artifacts.filter(
    (artefact) => artefact.name !== "reference-app.ext4",
  );
  manifeste.totals.byteSize = manifeste.artifacts.reduce((somme, a) => somme + a.byteSize, 0);

  const codes = validerManifeste(manifeste).map((anomalie) => anomalie.code);
  assert.ok(codes.includes("artefact-manquant"));
  assert.ok(codes.includes("boot-incoherent"));
});

test("une empreinte, une licence ou une origine absente est refusée", () => {
  const manifeste = manifesteDEssai();
  manifeste.artifacts[0] = { ...manifeste.artifacts[0], sha256: "court", license: "", origin: "" };

  assert.deepEqual(
    validerManifeste(manifeste)
      .map((anomalie) => anomalie.code)
      .sort(),
    ["empreinte-invalide", "licence-absente", "origine-absente"],
  );
});

test("un total incohérent est refusé : le manifeste ne se contredit pas", () => {
  const manifeste = manifesteDEssai();
  manifeste.totals.byteSize += 1;

  assert.deepEqual(
    validerManifeste(manifeste).map((anomalie) => anomalie.code),
    ["total-incoherent"],
  );
});

test("la comparaison au disque nomme l'artefact absent et l'empreinte divergente", () => {
  const manifeste = manifesteDEssai();
  const observes = new Map(
    manifeste.artifacts.map((artefact) => [
      artefact.name,
      { byteSize: artefact.byteSize, sha256: artefact.sha256 },
    ]),
  );
  observes.delete("seabios.bin");
  observes.set("reference-app.ext4", { byteSize: 1, sha256: empreinte(9) });

  const differences = comparerArtefacts(manifeste, observes);
  assert.deepEqual(differences.map((difference) => difference.code).sort(), [
    "artefact-absent",
    "empreinte-differente",
    "taille-differente",
  ]);
});

test("une comparaison sans écart ne rend rien", () => {
  const manifeste = manifesteDEssai();
  const observes = new Map(
    manifeste.artifacts.map((artefact) => [
      artefact.name,
      { byteSize: artefact.byteSize, sha256: artefact.sha256 },
    ]),
  );

  assert.deepEqual(comparerArtefacts(manifeste, observes), []);
});
