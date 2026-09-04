import assert from "node:assert/strict";
import test from "node:test";

import { supportInstantaneOpfs } from "../../src/vm/instantane/support-opfs.mjs";
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

// OBSERVER NE FABRIQUE RIEN (#65, revue de la PR #133).
//
// `openOpfsSyncAccess` ouvre avec `create: true` — c'est ce qu'il faut pour capturer, et c'est
// exactement ce qu'il ne faut pas pour DEMANDER s'il y a quelque chose. Chaque ouverture de volume
// pose la question ; la poser en saisissant un handle créait un `<volume>.instantane` vide sur tout
// support qui n'en avait pas, prenait un verrou exclusif pour rien, et laissait derrière elle un
// fichier de zéro octet que rien ne vient jamais retirer.

test("demander l'état d'un instantané ABSENT ne le crée pas", async () => {
  let saisies = 0;
  const support = supportInstantaneOpfs("donnees", {
    openHandle: async () => {
      saisies += 1;
      return { getSize: () => 0 };
    },
    observer: async (nom) => {
      assert.equal(nom, "donnees.instantane", "on observe le VOISIN, pas le volume");
      return { present: false, size: 0 };
    },
  });

  assert.deepEqual(await support.etat(), { present: false, taille: 0 });
  assert.equal(saisies, 0, "aucun handle saisi : `openOpfsSyncAccess` aurait CRÉÉ le fichier");
});

test("l'observation rend la taille d'un instantané PRÉSENT, toujours sans le saisir", async () => {
  let saisies = 0;
  const support = supportInstantaneOpfs("donnees", {
    openHandle: async () => {
      saisies += 1;
      return { getSize: () => 0 };
    },
    observer: async () => ({ present: true, size: 4096 }),
  });

  assert.deepEqual(await support.etat(), { present: true, taille: 4096 });
  assert.equal(saisies, 0);
});

test("une fois le handle SAISI, l'état vient de lui : c'est la source la plus fraîche", async () => {
  // Après une capture, la taille inscrite dans le handle est celle qui vaut : l'observation, elle,
  // interroge le support et peut décrire un fichier d'avant la troncature.
  let taille = 0;
  const support = supportInstantaneOpfs("donnees", {
    openHandle: async () => ({
      getSize: () => taille,
      truncate: (t) => {
        taille = t;
      },
    }),
    observer: async () => ({ present: false, size: 0 }),
  });

  await support.allouer(8192);
  assert.deepEqual(await support.etat(), { present: true, taille: 8192 });
});
