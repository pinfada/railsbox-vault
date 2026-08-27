// Manifeste v3 : identifiant de volume opaque et algorithme épinglé (#18, ADR 0016).
//
// L'ADR 0015 a constaté que le manifeste v2 ne distingue pas deux volumes de la même application :
// « aucun champ ne distingue deux volumes […] tant qu'il n'existe pas, la propriété P2 ne refuse un
// déplacement inter-volumes que si les deux volumes portent des identifiants distincts — c'est-à-dire
// pas encore ». Le format v3 ajoute ce champ, et cette épreuve fige sa forme : SEIZE octets, rendus
// par TRENTE-DEUX caractères hexadécimaux MINUSCULES. La conversion est celle que l'ADR 0015 fixe
// (`identifiantVolumeEnTexte`), parce que deux conventions donneraient deux étiquettes différentes
// pour le même volume.

import assert from "node:assert/strict";
import test from "node:test";

import { ALGORITHME } from "../../src/vm/format-chiffre/identite-logique.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  MIN_READABLE_FORMAT_VERSION,
  assertWritable,
  createManifest,
  evaluateCompatibility,
  parseManifest,
} from "../../src/vm/volume-manifest.mjs";

const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

const BASE = {
  runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
  app: { id: "railsbox/reference", version: "0.1.0" },
  volumeSize: 32 * 512,
  volume: { id: IDENTIFIANT, algorithm: ALGORITHME },
};

test("le format écrit par ce runtime est v3, et v1 reste lisible", () => {
  assert.equal(MANIFEST_FORMAT_VERSION, 3);
  assert.equal(MIN_READABLE_FORMAT_VERSION, 1);
});

test("un manifeste v3 porte l'identifiant de volume et l'algorithme, et les rend tels quels", () => {
  const manifeste = createManifest(BASE);
  assert.equal(manifeste.formatVersion, 3);
  assert.equal(manifeste.volume.id, IDENTIFIANT);
  assert.equal(manifeste.volume.algorithm, ALGORITHME);
  assert.deepEqual(parseManifest(manifeste).volume, manifeste.volume);
});

test("un identifiant de volume qui n'est pas 32 hex MINUSCULES est refusé, jamais normalisé", () => {
  for (const mauvais of [
    IDENTIFIANT.toUpperCase(),
    IDENTIFIANT.slice(0, 30),
    `${IDENTIFIANT}00`,
    "0123456789abcdef0123456789abcdeg",
    "",
    null,
    42,
  ]) {
    assert.throws(
      () => createManifest({ ...BASE, volume: { id: mauvais, algorithm: ALGORITHME } }),
      TypeError,
      `« ${String(mauvais)} » aurait dû être refusé`,
    );
  }
});

test("un algorithme autre que le seul admis est refusé : l'agilité passe par une version", () => {
  assert.throws(
    () => createManifest({ ...BASE, volume: { id: IDENTIFIANT, algorithm: "chacha20-poly1305" } }),
    TypeError,
  );
  assert.throws(() => createManifest({ ...BASE, volume: { id: IDENTIFIANT } }), TypeError);
});

test("un manifeste v3 SANS bloc `volume` est malformé : le champ n'est pas facultatif", () => {
  const sansVolume = { ...createManifest(BASE), volume: undefined };
  assert.throws(
    () => parseManifest({ ...sansVolume, volume: undefined }),
    (erreur) => isManifestError(erreur, MANIFEST_ERROR_CODES.malformed),
  );
});

test("un manifeste v2 reste LISIBLE et sans bloc `volume` : son format n'en connaît pas", () => {
  const v2 = createManifest({
    formatVersion: 2,
    runtime: BASE.runtime,
    app: BASE.app,
    volumeSize: BASE.volumeSize,
  });
  assert.equal(v2.formatVersion, 2);
  assert.equal(v2.volume, undefined);

  const verdict = evaluateCompatibility(v2);
  assert.equal(verdict.readable, true, "un v2 s'exporte et se migre");
  assert.equal(verdict.writable, false, "un v2 n'a ni région d'authentification ni nonce");
  assert.equal(verdict.refusal, MANIFEST_ERROR_CODES.migrationRequired);
});

test("un runtime qui ne connaît que v2 refuse un v3 comme FORMAT FUTUR", () => {
  const v3 = createManifest(BASE);
  const verdict = evaluateCompatibility(v3, {
    supportedFormat: { current: 2, minReadable: 1 },
  });
  assert.equal(verdict.readable, false);
  assert.equal(verdict.writable, false);
  assert.equal(verdict.refusal, MANIFEST_ERROR_CODES.formatTooNew);
});

test("le refus de migration DIT pourquoi un v2 ne s'écrit pas, plutôt que d'invoquer sa version", () => {
  // « format antérieur, migrez » n'apprend rien. La raison est physique : un volume v2 n'a ni
  // région d'authentification ni nonce, donc le sceau d'un secteur n'aurait nulle part où aller.
  const v2 = createManifest({
    formatVersion: 2,
    runtime: BASE.runtime,
    app: BASE.app,
    volumeSize: BASE.volumeSize,
  });
  assert.throws(
    () => assertWritable(v2),
    (erreur) => {
      assert.ok(isManifestError(erreur, MANIFEST_ERROR_CODES.migrationRequired), erreur.message);
      assert.match(erreur.message, /authentification|nonce|sceau/i);
      return true;
    },
  );
});
