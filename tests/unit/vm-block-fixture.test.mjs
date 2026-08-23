import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_BLOCK_SIZE,
  FIXTURE_DIGEST,
  FIXTURE_LABEL,
  FIXTURE_SIZE,
  buildBlockFixture,
  digestHex,
} from "../../src/vm/block-fixture.mjs";

// La fixture binaire de #6 n'est pas un fichier opaque : c'est une RÈGLE. Chaque bloc de 32 octets
// vaut `SHA-256(label + index)`. Ce test réapplique la règle et compare le résultat à l'empreinte
// publiée dans le module. Une empreinte recopiée à la main ne prouverait rien ; celle-ci est
// vérifiée à chaque exécution, comme l'invariant de `apps/reference/`.

test("la fixture est reconstruite à partir de sa règle et non d'un binaire versionné", async () => {
  const fixture = await buildBlockFixture(FIXTURE_SIZE);

  assert.equal(fixture.byteLength, FIXTURE_SIZE);
  assert.equal(await digestHex(fixture), FIXTURE_DIGEST);
});

test("chaque bloc de la fixture vaut l'empreinte de son étiquette indexée", async () => {
  const fixture = await buildBlockFixture(4 * FIXTURE_BLOCK_SIZE);

  for (let index = 0; index < 4; index += 1) {
    const attendu = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${FIXTURE_LABEL}${index}`)),
    );
    const bloc = fixture.subarray(index * FIXTURE_BLOCK_SIZE, (index + 1) * FIXTURE_BLOCK_SIZE);
    assert.deepEqual([...bloc], [...attendu], `bloc ${index}`);
  }
});

test("deux blocs consécutifs diffèrent : la fixture n'est pas une répétition", async () => {
  const fixture = await buildBlockFixture(2 * FIXTURE_BLOCK_SIZE);
  const premier = fixture.subarray(0, FIXTURE_BLOCK_SIZE);
  const second = fixture.subarray(FIXTURE_BLOCK_SIZE);

  assert.notDeepEqual([...premier], [...second]);
});

test("une taille non multiple du bloc est refusée plutôt qu'arrondie", async () => {
  await assert.rejects(() => buildBlockFixture(33), RangeError);
  await assert.rejects(() => buildBlockFixture(0), RangeError);
});
