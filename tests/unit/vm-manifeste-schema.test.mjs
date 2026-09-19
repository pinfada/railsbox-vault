import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { MANIFEST_ERROR_CODES } from "../../src/vm/manifest-errors.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  manifesteAvecApplication,
  manifesteAvecIntention,
  parseManifest,
  serializeManifest,
} from "../../src/vm/volume-manifest.mjs";

// Le champ `app.schema` du manifeste de volume (#236 T2, ADR 0042, note datée de l'ADR 0007) : le
// schéma CONSTATÉ des données. Facultatif, sans changement de format ; un manifeste d'avant se relit
// à l'identique et se resérialise octet pour octet.

function champs(app) {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app,
    volumeSize: SECTOR_SIZE * 8,
    identity: { algorithm: "sha-256", digest: null },
    volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" },
  };
}

test("un manifeste porte le schéma constaté, et le relit tel quel", () => {
  const m = createManifest(champs({ id: "ref", version: "1.1.0", schema: "20260919000001" }));
  assert.equal(m.app.schema, "20260919000001");
  const relu = parseManifest(serializeManifest(m));
  assert.deepEqual(relu.app, { id: "ref", version: "1.1.0", schema: "20260919000001" });
});

test("relecture ASCENDANTE : un manifeste de T1, sans schéma, se relit et se resérialise à l'octet", () => {
  // Les octets qu'un runtime de T1 écrivait : aucun champ `schema`.
  const avant = serializeManifest(createManifest(champs({ id: "ref", version: "1.0.0" })));
  assert.equal(new TextDecoder().decode(avant).includes("schema"), false);
  const relu = parseManifest(avant);
  assert.equal(
    "schema" in relu.app,
    false,
    "l'absence n'est pas remplacée par une valeur inventée",
  );
  assert.deepEqual(serializeManifest(relu), avant);
});

test("un schéma qui n'est pas un entier en chiffres est un manifeste MALFORMÉ", () => {
  for (const schema of ["", "2026-09-19", "v3", "12".repeat(17), 20260919, null]) {
    const brut = JSON.parse(
      new TextDecoder().decode(
        serializeManifest(createManifest(champs({ id: "a", version: "1" }))),
      ),
    );
    brut.app.schema = schema;
    assert.throws(
      () => parseManifest(brut),
      (erreur) => erreur.code === MANIFEST_ERROR_CODES.malformed,
      `schéma ${JSON.stringify(schema)}`,
    );
  }
});

test("à la CRÉATION, un schéma invalide est une faute de programmation", () => {
  assert.throws(() => createManifest(champs({ id: "a", version: "1", schema: "x" })), TypeError);
});

test("manifesteAvecApplication ne change QUE la version et le schéma, jamais l'identité", () => {
  const avant = createManifest(champs({ id: "ref", version: "1.0.0" }));
  const apres = manifesteAvecApplication(avant, { version: "1.1.0", schema: "20260919000001" });
  assert.deepEqual(apres.app, { id: "ref", version: "1.1.0", schema: "20260919000001" });
  assert.deepEqual(apres.runtime, avant.runtime);
  assert.deepEqual(apres.geometry, avant.geometry);
  assert.deepEqual(apres.volume, avant.volume);
  assert.equal(apres.formatVersion, avant.formatVersion);
  assert.equal(Object.isFrozen(apres.app), true);
  assert.equal(avant.app.version, "1.0.0", "le manifeste d'origine n'est pas muté");
});

test("l'INTENTION de migration s'inscrit, se relit, et s'efface quand le manifeste a suivi", () => {
  const avant = createManifest(champs({ id: "ref", version: "1.0.0", schema: "20260101000002" }));
  const intention = manifesteAvecIntention(avant, "20260919000002");
  assert.equal(parseManifest(serializeManifest(intention)).app.migration, "20260919000002");
  assert.equal(intention.app.schema, "20260101000002", "l'intention ne change pas le constat");
  const suivi = manifesteAvecApplication(intention, {
    version: "1.1.0",
    schema: "20260919000002",
  });
  assert.equal("migration" in suivi.app, false);
  const brut = JSON.parse(new TextDecoder().decode(serializeManifest(avant)));
  brut.app.migration = "N";
  assert.throws(
    () => parseManifest(brut),
    (e) => e.code === MANIFEST_ERROR_CODES.malformed,
  );
});
