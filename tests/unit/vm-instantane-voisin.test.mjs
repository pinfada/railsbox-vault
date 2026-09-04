import assert from "node:assert/strict";
import test from "node:test";

import { createOpfsImportTarget } from "../../src/vm/opfs-import-target.mjs";
import { createOpfsMigrationTarget } from "../../src/vm/opfs-migration-target.mjs";
import {
  INSTANTANE_SIDECAR_SUFFIX,
  MAX_STORAGE_NAME,
  MAX_VOLUME_NAME,
  RESERVED_SIDECAR_SUFFIXES,
  instantaneSidecarName,
  voisinsDunVolume,
} from "../../src/vm/opfs-sync-access.mjs";

// L'INSTANTANÉ est un VOISIN de volume (#65, ADR 0024, décisions 1 et 8).
//
// Ce que cette épreuve tient, et pourquoi chaque point compte :
//
//  - le suffixe est RÉSERVÉ, sans quoi supprimer « donnees » détruirait un volume légitime nommé
//    « donnees.instantane » ;
//  - c'est le plus long suffixe du dépôt, donc c'est LUI qui borne désormais `MAX_VOLUME_NAME`. Un
//    volume créable doit rester restaurable, migrable ET capturable ;
//  - il part avec le volume, avec la RESTAURATION et avec la MIGRATION. Un instantané survivant
//    décrirait un état mémoire lié à une génération que le volume réécrit n'a jamais portée.

test("le suffixe « .instantane » est réservé, et c'est le plus long du dépôt", () => {
  assert.equal(INSTANTANE_SIDECAR_SUFFIX, ".instantane");
  assert.ok(RESERVED_SIDECAR_SUFFIXES.includes(INSTANTANE_SIDECAR_SUFFIX));
  const plusLong = Math.max(...RESERVED_SIDECAR_SUFFIXES.map((suffixe) => suffixe.length));
  assert.equal(plusLong, INSTANTANE_SIDECAR_SUFFIX.length);
});

test("un volume ne peut pas porter le suffixe d'un instantané", () => {
  assert.throws(() => instantaneSidecarName("donnees.instantane"), TypeError);
});

test("la borne de nommage laisse la place au plus long voisin", () => {
  assert.equal(MAX_VOLUME_NAME, MAX_STORAGE_NAME - INSTANTANE_SIDECAR_SUFFIX.length);
  const limite = "v".repeat(MAX_VOLUME_NAME);
  assert.equal(instantaneSidecarName(limite).length, MAX_STORAGE_NAME);
  assert.throws(() => instantaneSidecarName("v".repeat(MAX_VOLUME_NAME + 1)), TypeError);
});

test("les voisins d'un volume sont nommés en un seul endroit, instantané compris", () => {
  const voisins = voisinsDunVolume("donnees");
  assert.deepEqual(voisins, [
    "donnees.gen",
    "donnees.temoin",
    "donnees.cles",
    "donnees.instantane",
  ]);
});

test("un VOISIN n'a pas de voisins : la récursion du retrait s'arrête", () => {
  for (const suffixe of RESERVED_SIDECAR_SUFFIXES) {
    assert.deepEqual(
      voisinsDunVolume(`donnees${suffixe}`),
      [],
      `« donnees${suffixe} » est un voisin : il ne doit pas en avoir lui-même`,
    );
  }
});

/** Recueille les noms passés à `removeSidecar` par une cible de restauration ou de migration. */
function espionDeRetraits() {
  const retires = [];
  return { retires, removeSidecar: async (nom) => void retires.push(nom) };
}

test("la RESTAURATION retire l'instantané avec le journal et le témoin", async () => {
  const espion = espionDeRetraits();
  const cible = createOpfsImportTarget("donnees", {
    removeSidecar: espion.removeSidecar,
    revoke: async () => {},
  });
  await cible.discardGeneration();
  assert.deepEqual(espion.retires, ["donnees.gen", "donnees.temoin", "donnees.instantane"]);
});

test("la MIGRATION retire l'instantané avec le journal et le témoin", async () => {
  const espion = espionDeRetraits();
  const cible = createOpfsMigrationTarget("donnees", { removeSidecar: espion.removeSidecar });
  await cible.removeGenerationJournal();
  assert.deepEqual(espion.retires, ["donnees.gen", "donnees.temoin", "donnees.instantane"]);
});
