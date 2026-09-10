import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { ZONE_ENREGISTREMENTS } from "../../src/vm/generation-format.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// La NAISSANCE retire ses voisins ORPHELINS (#145) : un témoin, un journal de génération, un
// instantané ou un journal de migration laissés à côté d'un volume supprimé sans passer par
// `removeOpfsVolume` ne décrivent plus rien, et les garder fait refuser le volume neuf par
// `VAULT_STORAGE_SCEAU_REFUSE` — le témoin atteste une identité que ce volume-ci n'a jamais portée.
//
// « Supprimer et recréer », c'est retirer le fichier de volume SEUL, à la main, sans passer par
// `removeOpfsVolume` : c'est exactement ce que le constat de #145 décrit, et ce que `store.resize`
// reproduit ici — le volume revient à zéro octet, ses voisins restent intacts à côté.

const TAILLE = 8 * SECTOR_SIZE;

/** Écrit des octets ARBITRAIRES dans un voisin, comme le ferait un journal ou un instantané réel. */
async function ecrireVoisin(store, nom, octets) {
  const handle = await store.openHandle(nom);
  handle.truncate(0);
  handle.write(octets, { at: 0 });
  handle.close();
}

test("une naissance sans aucun orphelin ne publie et ne retire rien", async () => {
  const store = createSyncAccessStore();
  const backend = await openOpfsVolume({
    name: "sain",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  assert.deepEqual(backend.describe().voisinsRetires, []);
  await backend.close();
});

test("la naissance retire les voisins orphelins .gen, .temoin et .instantane, et rouvre sans refus", async () => {
  const store = createSyncAccessStore();

  // Un premier volume laisse un témoin RÉEL, lié à SA propre identité — celle-là même que la
  // reproduction du constat #145 met en défaut.
  const premier = await openOpfsVolume({
    name: "orphelins",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  await premier.write(0, new Uint8Array(SECTOR_SIZE).fill(7));
  await premier.flush();
  await premier.close();

  assert.ok(store.sizeOf("orphelins.temoin") > 0, "le témoin réel doit porter des octets");

  // Des voisins orphelins supplémentaires, comme en laisserait un journal ou un instantané périmés.
  await ecrireVoisin(store, "orphelins.gen", new Uint8Array([1, 2, 3, 4]));
  await ecrireVoisin(store, "orphelins.instantane", new Uint8Array([9, 9, 9, 9]));

  // « Supprimer et recréer » sans passer par `removeOpfsVolume` : le volume disparaît, ses voisins
  // restent.
  store.resize("orphelins", 0);

  const second = await openOpfsVolume({
    name: "orphelins",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  assert.deepEqual([...second.describe().voisinsRetires].sort(), [
    "orphelins.gen",
    "orphelins.instantane",
    "orphelins.temoin",
  ]);
  // **Ce que « retiré » veut dire depuis #181, et ce qu'il ne veut plus dire.** La naissance retire
  // bien les trois orphelins — c'est ce que `voisinsRetires` publie —, mais elle écrit ENSUITE sa
  // propre racine initiale, donc son journal et son témoin. Un journal à ZÉRO ne prouverait donc
  // plus rien ; ce qui se mesure est que les octets présents sont ceux de la naissance, pas ceux
  // des orphelins : un journal à la taille exacte de sa zone de racines, un témoin neuf, et un
  // INSTANTANÉ à zéro — celui-là, la naissance ne le réécrit pas.
  assert.equal(store.sizeOf("orphelins.gen"), ZONE_ENREGISTREMENTS);
  assert.ok(store.sizeOf("orphelins.temoin") > 0, "le témoin est celui de la naissance");
  assert.equal(store.sizeOf("orphelins.instantane"), 0);
  await second.close();

  // Et il se réouvre sans refus : la génération neuve n'a hérité d'aucun témoin périmé (rouge
  // d'abord sur `main` : ce second appel y échoue par `VAULT_STORAGE_SCEAU_REFUSE`).
  const troisieme = await openOpfsVolume({
    name: "orphelins",
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  assert.deepEqual(troisieme.describe().voisinsRetires, []);
  await troisieme.close();
});

test("la naissance retire un journal de migration périmé, absent de voisinsDunVolume", async () => {
  const store = createSyncAccessStore();
  await ecrireVoisin(store, "migre.migration", new Uint8Array([5, 6, 7, 8]));

  const backend = await openOpfsVolume({
    name: "migre",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });
  assert.deepEqual(backend.describe().voisinsRetires, ["migre.migration"]);
  assert.equal(store.sizeOf("migre.migration"), 0);
  await backend.close();
});

test("la naissance NE retire PAS l'enveloppe de clé, écrite avant elle (ADR 0020)", async () => {
  const store = createSyncAccessStore();
  const enveloppe = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await ecrireVoisin(store, "chiffre.cles", enveloppe);

  const backend = await openOpfsVolume({
    name: "chiffre",
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle: store.openHandle,
  });

  assert.deepEqual(
    store.snapshot("chiffre.cles"),
    enveloppe,
    "l'enveloppe écrite avant la naissance doit rester INTACTE après elle",
  );
  assert.ok(
    !backend.describe().voisinsRetires.includes("chiffre.cles"),
    "l'enveloppe de clé n'est jamais un voisin ORPHELIN",
  );
  await backend.close();
});
