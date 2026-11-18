/**
 * La lecture de `libv86` HORS CONNEXION ne touche jamais le réseau (#247, D1g ; revue de sécurité de
 * #298, constat 3 ; ADR 0046).
 *
 * `cache: "force-cache"` accepte une entrée périmée MAIS va au réseau quand le cache est vide : hors
 * connexion, « rien n'est téléchargé » n'était pas établi. `only-if-cached` (avec `mode: "same-origin"`,
 * que le navigateur exige) lit le cache ou échoue, sans requête. L'épreuve navigateur
 * (`tests/browser/descripteur-scelle.spec.mjs`) le mesure sur un vrai serveur et trois moteurs ; celle-ci
 * tient la demande, et le refus typé d'un cache vide.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { lireDuCacheHttp } from "../../src/vm/acquisition-des-artefacts.mjs";
import { CODE_ARTEFACT_ABSENT_HORS_CONNEXION } from "../../src/vm/artefact-absent-hors-connexion.mjs";
import { adresseDe } from "../../src/v86-adresses.mjs";

const ADRESSE = adresseDe("libv86.mjs", "4".repeat(64));

test("hors connexion, libv86 est lu en `only-if-cached` : jamais `force-cache`, qui va au réseau", async () => {
  const demandes = [];
  const recuperer = async (adresse, options) => {
    demandes.push({ adresse, options });
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };

  const octets = await lireDuCacheHttp(ADRESSE, recuperer);

  assert.deepEqual([...octets], [1, 2, 3]);
  assert.equal(demandes.length, 1);
  assert.equal(demandes[0].adresse, ADRESSE);
  assert.equal(demandes[0].options.cache, "only-if-cached");
  assert.equal(
    demandes[0].options.mode,
    "same-origin",
    "le navigateur l'exige avec only-if-cached",
  );
});

test("un cache vide (la lecture échoue, 504 ou TypeError) est le refus typé de l'artefact absent", async () => {
  for (const recuperer of [
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => ({ ok: false, status: 504 }),
  ]) {
    await assert.rejects(lireDuCacheHttp(ADRESSE, recuperer), {
      code: CODE_ARTEFACT_ABSENT_HORS_CONNEXION,
    });
  }
});
