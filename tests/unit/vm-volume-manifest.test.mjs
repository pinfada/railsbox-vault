import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE, V86_BLOCK_SIZE } from "../../src/vm/block-geometry.mjs";
import {
  MANIFEST_ERROR_CODES,
  ManifestError,
  isManifestError,
} from "../../src/vm/manifest-errors.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_MAGIC,
  assertReadable,
  assertVolumeWritable,
  assertWritable,
  createManifest,
  evaluateCompatibility,
  parseManifest,
  serializeManifest,
} from "../../src/vm/volume-manifest.mjs";

// Preuve unitaire du MANIFESTE VERSIONNÉ d'un volume (#10, `VAULT-PORT-001`, `VAULT-COMPAT-001`).
// Elle éprouve un CONTRAT DE FORMAT pur : structure v1 figée, sérialisation déterministe (empreinte
// reproductible), parse strict (jamais un objet à moitié valide), et règle de compatibilité —
// format futur refusé, downgrade refusé, écriture refusée sans identité connue (`SEC-UPDATE-001`).
// Le calcul d'empreinte du CONTENU du volume est réservé à #11 ; ici, la structure et la
// vérification de version/identité. Aucun OPFS, aucun navigateur, aucune VM : un format se prouve en
// unitaire.

/** Champs valides d'un volume neuf, réutilisés par les épreuves. */
function champsValides(surcharge = {}) {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    runtime: { version: "1.4.2", artifact: "sha256:abcdef" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize: SECTOR_SIZE * 8,
    identity: { algorithm: "sha-256", digest: null },
    ...surcharge,
  };
}

/** Attentes de compatibilité par défaut : le runtime et l'application en cours d'exécution. */
function attentesCourantes(surcharge = {}) {
  return {
    runtime: { version: "1.4.2", artifact: "sha256:abcdef" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    supportedFormat: { current: MANIFEST_FORMAT_VERSION, minReadable: MANIFEST_FORMAT_VERSION },
    ...surcharge,
  };
}

test("createManifest fige un manifeste v1 complet et immuable", () => {
  const m = createManifest(champsValides());
  assert.equal(m.magic, MANIFEST_MAGIC);
  assert.equal(m.formatVersion, MANIFEST_FORMAT_VERSION);
  assert.equal(m.runtime.version, "1.4.2");
  assert.equal(m.app.id, "railsbox/reference");
  assert.equal(m.geometry.volumeSize, SECTOR_SIZE * 8);
  assert.equal(m.geometry.sectorSize, SECTOR_SIZE);
  assert.equal(m.geometry.blockSize, V86_BLOCK_SIZE);
  assert.equal(Object.isFrozen(m), true);
  assert.equal(Object.isFrozen(m.geometry), true);
  assert.equal(Object.isFrozen(m.runtime), true);
});

test("createManifest refuse une géométrie inadmissible", () => {
  assert.throws(
    () => createManifest(champsValides({ volumeSize: SECTOR_SIZE + 1 })),
    /Taille de volume invalide/,
  );
});

test("createManifest refuse un runtime hors SemVer et une application sans identité", () => {
  assert.throws(() => createManifest(champsValides({ runtime: { version: "1.4" } })), TypeError);
  assert.throws(
    () => createManifest(champsValides({ app: { id: "", version: "1.0.0" } })),
    TypeError,
  );
});

test("serializeManifest est déterministe : aller-retour stable octet à octet", () => {
  const m = createManifest(champsValides());
  const octets1 = serializeManifest(m);
  const relu = parseManifest(octets1);
  const octets2 = serializeManifest(relu);
  assert.deepEqual([...octets2], [...octets1], "la re-sérialisation reproduit les mêmes octets");
});

test("serializeManifest ignore l'ordre d'insertion des clés", () => {
  const a = createManifest(champsValides());
  // Mêmes valeurs, ordre d'insertion différent des attributs de premier niveau.
  const b = createManifest({
    identity: { algorithm: "sha-256", digest: null },
    volumeSize: SECTOR_SIZE * 8,
    app: { version: "3.1.0", id: "railsbox/reference" },
    runtime: { artifact: "sha256:abcdef", version: "1.4.2" },
    formatVersion: MANIFEST_FORMAT_VERSION,
  });
  assert.deepEqual([...serializeManifest(b)], [...serializeManifest(a)]);
});

test("parseManifest accepte une chaîne, des octets et un objet équivalents", () => {
  const octets = serializeManifest(createManifest(champsValides()));
  const texte = new TextDecoder().decode(octets);
  const parObjet = parseManifest(JSON.parse(texte));
  const parTexte = parseManifest(texte);
  const parOctets = parseManifest(octets);
  assert.deepEqual([...serializeManifest(parObjet)], [...serializeManifest(parOctets)]);
  assert.deepEqual([...serializeManifest(parTexte)], [...serializeManifest(parOctets)]);
});

test("parseManifest rejette une entrée malformée par une erreur typée", () => {
  const cas = [
    ["ceci n'est pas du JSON {", "JSON invalide"],
    [JSON.stringify({ formatVersion: 1 }), "magie absente"],
    [serialiserBrut({ magic: "autre", formatVersion: 1 }), "mauvaise magie"],
    [serialiserBrut(sansChamp("formatVersion")), "formatVersion absent"],
    [serialiserBrut(avecChamp("formatVersion", 1.5)), "formatVersion non entier"],
    [serialiserBrut(sansChamp("runtime")), "runtime absent"],
    [serialiserBrut(sansChamp("app")), "app absente"],
    [serialiserBrut(avecGeometrie({ sectorSize: 500 })), "secteur incohérent"],
  ];
  for (const [entree, raison] of cas) {
    assert.throws(
      () => parseManifest(entree),
      (e) => isManifestError(e, MANIFEST_ERROR_CODES.malformed),
      `attendu MALFORMED pour : ${raison}`,
    );
  }
});

test("parseManifest tolère des champs futurs inconnus sans les rejeter", () => {
  const objet = JSON.parse(
    new TextDecoder().decode(serializeManifest(createManifest(champsValides()))),
  );
  objet.champInconnu = { futur: true };
  const m = parseManifest(objet);
  assert.equal(m.formatVersion, MANIFEST_FORMAT_VERSION);
});

test("un manifeste courant compatible est lisible et inscriptible", () => {
  const m = createManifest(champsValides());
  const verdict = evaluateCompatibility(m, attentesCourantes());
  assert.equal(verdict.readable, true);
  assert.equal(verdict.writable, true);
  assert.equal(verdict.refusal, null);
  assert.doesNotThrow(() => assertReadable(m, attentesCourantes()));
  assert.doesNotThrow(() => assertWritable(m, attentesCourantes()));
});

test("un format FUTUR inconnu est refusé en lecture comme en écriture", () => {
  const m = createManifest(champsValides({ formatVersion: MANIFEST_FORMAT_VERSION + 1 }));
  const verdict = evaluateCompatibility(m, attentesCourantes());
  assert.equal(verdict.readable, false);
  assert.equal(verdict.writable, false);
  assert.equal(verdict.refusal, MANIFEST_ERROR_CODES.formatTooNew);
  assert.throws(
    () => assertReadable(m, attentesCourantes()),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.formatTooNew),
  );
  assert.throws(
    () => assertWritable(m, attentesCourantes()),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.formatTooNew),
  );
});

test("un format trop ANCIEN pour ce runtime est refusé", () => {
  const m = createManifest(champsValides({ formatVersion: 1 }));
  const attentes = attentesCourantes({ supportedFormat: { current: 3, minReadable: 2 } });
  assert.throws(
    () => assertReadable(m, attentes),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.formatTooOld),
  );
});

test("un format LISIBLE mais antérieur tolère la lecture et refuse l'écriture (migration #13)", () => {
  const m = createManifest(champsValides({ formatVersion: 2 }));
  const attentes = attentesCourantes({ supportedFormat: { current: 3, minReadable: 1 } });
  const verdict = evaluateCompatibility(m, attentes);
  assert.equal(verdict.readable, true);
  assert.equal(verdict.writable, false);
  assert.equal(verdict.refusal, MANIFEST_ERROR_CODES.migrationRequired);
  assert.doesNotThrow(() => assertReadable(m, attentes));
  assert.throws(
    () => assertWritable(m, attentes),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.migrationRequired),
  );
});

test("un DOWNGRADE de runtime majeur est lisible mais refuse l'écriture", () => {
  // Le volume a été écrit par un runtime 2.x ; on tourne en 1.x : écriture dangereuse.
  const m = createManifest(champsValides({ runtime: { version: "2.0.1", artifact: null } }));
  const attentes = attentesCourantes({ runtime: { version: "1.9.9", artifact: null } });
  const verdict = evaluateCompatibility(m, attentes);
  assert.equal(verdict.readable, true);
  assert.equal(verdict.writable, false);
  assert.equal(verdict.refusal, MANIFEST_ERROR_CODES.runtimeDowngrade);
  assert.throws(
    () => assertWritable(m, attentes),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.runtimeDowngrade),
  );
});

test("une application différente est refusée en lecture comme en écriture", () => {
  const m = createManifest(champsValides());
  const attentes = attentesCourantes({ app: { id: "autre/app", version: "3.1.0" } });
  assert.throws(
    () => assertReadable(m, attentes),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.identityMismatch),
  );
});

test("une version d'application différente reste compatible : ses migrations sont distinctes", () => {
  const m = createManifest(champsValides());
  const attentes = attentesCourantes({ app: { id: "railsbox/reference", version: "9.9.9" } });
  assert.doesNotThrow(() => assertWritable(m, attentes));
});

test("assertVolumeWritable refuse un volume sans manifeste (jamais d'écriture non identifiée)", () => {
  for (const absent of [null, undefined]) {
    assert.throws(
      () => assertVolumeWritable({ manifestBytes: absent, expectations: attentesCourantes() }),
      (e) => isManifestError(e, MANIFEST_ERROR_CODES.unidentified),
      `octets absents : ${absent}`,
    );
  }
});

test("assertVolumeWritable propage le refus typé d'un manifeste malformé", () => {
  assert.throws(
    () =>
      assertVolumeWritable({
        manifestBytes: new TextEncoder().encode("{"),
        expectations: attentesCourantes(),
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.malformed),
  );
});

test("assertVolumeWritable refuse un format futur avant toute écriture", () => {
  const octets = serializeManifest(
    createManifest(champsValides({ formatVersion: MANIFEST_FORMAT_VERSION + 1 })),
  );
  assert.throws(
    () => assertVolumeWritable({ manifestBytes: octets, expectations: attentesCourantes() }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.formatTooNew),
  );
});

test("assertVolumeWritable rend le manifeste validé quand l'identité et la version sont connues", () => {
  const octets = serializeManifest(createManifest(champsValides()));
  const m = assertVolumeWritable({ manifestBytes: octets, expectations: attentesCourantes() });
  assert.equal(m.app.id, "railsbox/reference");
  assert.equal(Object.isFrozen(m), true);
});

test("l'algorithme d'empreinte est ÉPINGLÉ à sha-256, à la création comme à la relecture", () => {
  // Le manifeste n'atteste que ce que le dépôt calcule réellement. Accepter une autre étiquette la
  // rendrait persistante sans qu'aucun code ne l'honore — une affirmation fausse gravée sur disque.
  assert.throws(
    () => createManifest({ ...champsValides(), identity: { algorithm: "sha-1", digest: null } }),
    TypeError,
  );
  assert.throws(
    () => parseManifest(avecChamp("identity", { algorithm: "sha-1", digest: null })),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.malformed),
  );
});

test("ManifestError porte un code stable et une forme transportable", () => {
  const e = new ManifestError(MANIFEST_ERROR_CODES.formatTooNew, "message", { a: 1 });
  assert.equal(e.name, "ManifestError");
  assert.equal(e.code, "VAULT_MANIFEST_FORMAT_TOO_NEW");
  assert.deepEqual(e.toJSON(), {
    name: "ManifestError",
    code: "VAULT_MANIFEST_FORMAT_TOO_NEW",
    message: "message",
    context: { a: 1 },
  });
  assert.throws(
    () => new ManifestError("VAULT_INCONNU", "x"),
    /Code d'erreur de manifeste inconnu/,
  );
});

// --- utilitaires de fabrication d'entrées malformées ------------------------------------------

function serialiserBrut(objet) {
  return new TextEncoder().encode(JSON.stringify(objet));
}

function manifesteBrut() {
  return JSON.parse(new TextDecoder().decode(serializeManifest(createManifest(champsValides()))));
}

function sansChamp(champ) {
  const o = manifesteBrut();
  delete o[champ];
  return o;
}

function avecChamp(champ, valeur) {
  const o = manifesteBrut();
  o[champ] = valeur;
  return o;
}

function avecGeometrie(surcharge) {
  const o = manifesteBrut();
  o.geometry = { ...o.geometry, ...surcharge };
  return o;
}
