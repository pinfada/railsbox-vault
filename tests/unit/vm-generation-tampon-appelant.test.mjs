import assert from "node:assert/strict";
import test from "node:test";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";

for (const modifierUnOctet of [false, true]) {
  test(`un tampon réutilisé après write ne change pas le journal (écriture partielle : ${modifierUnOctet})`, async () => {
    const store = createSyncAccessStore();
    const ouvrir = () =>
      openOpfsVolume({
        name: "tampon-appelant",
        size: 4 * 512,
        cle: CLE_DE_TEST,
        openHandle: store.openHandle,
      });
    let backend = await ouvrir();
    const attendu = new Uint8Array(4 * 512).fill(0x53);
    const tampon = attendu.slice();
    try {
      await backend.write(0, tampon);
      await backend.flush();
      tampon.fill(0); // Réemploi ordinaire du buffer, ou effacement du clair après migration.
      if (modifierUnOctet) {
        await backend.write(19, Uint8Array.of(0x71));
        await backend.flush();
        attendu[19] = 0x71;
      }
      const lu = await backend.read(0, attendu.length);
      assert.equal(
        lu.findIndex((octet, rang) => octet !== attendu[rang]),
        -1,
        "la relecture ne doit jamais dépendre du tampon de l'appelant",
      );
      await backend.close();
      backend = await ouvrir();
      assert.deepEqual(await backend.read(0, attendu.length), attendu);
    } finally {
      await backend.close();
    }
  });
}
