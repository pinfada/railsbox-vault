import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { creerEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import { ENVELOPPE_SIDECAR_SUFFIX, enveloppeSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import {
  ouvrirVolumeParKek,
  preparerEnveloppeDeVolume,
  supportEnveloppeOpfs,
} from "../../src/vm/ouverture-par-enveloppe.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { CONSISTENCY_KINDS, exportVolumeToBytes } from "../../src/vm/volume-export.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import { suiteDOctets } from "./support-enveloppe-double.mjs";

// La COUCHE de déverrouillage au-dessus de l'ouvreur unique (#21, ADR 0020, décision 5).
//
// Ce que ces épreuves doivent établir, et qui n'est pas « ça marche » :
//
//  - l'ORDRE des refus. Un volume sans manifeste, un volume sans enveloppe et une clé qui n'ouvre
//    rien sont TROIS états distincts, avec trois remèdes distincts, et aucun ne doit se dégrader en
//    un autre. Le point 5 du contrat de #21 le demande nommément : « aucune enveloppe » n'est pas
//    « clé invalide » ;
//  - l'identifiant de volume attendu vient du MANIFESTE. Le confronter à celui de l'enveloppe n'a
//    de sens que si les deux sources sont réellement distinctes ;
//  - rien n'est ouvert avant que tout ne soit vérifié. Un refus ne doit pas laisser derrière lui un
//    handle pris ou un fichier créé — la règle de l'ADR 0009, que cette couche hérite plutôt que
//    de la réécrire ;
//  - l'ARCHIVE n'emporte pas l'enveloppe, et c'est une décision, pas un oubli.

const TAILLE = 8 * SECTOR_SIZE;
const NOM = "coffre";
const VOLUME_A = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const VOLUME_B = "ffeeddccbbaa99887766554433221100";
const KEK = suiteDOctets(0x80, 32);
const KEK_INCONNUE = suiteDOctets(0x11, 32);

const ATTENTES = {
  app: { id: "railsbox-vault-reference" },
  runtime: { version: "0.1.0" },
};

function manifeste(identifiantVolume = VOLUME_A) {
  return serializeManifest(
    createManifest({
      runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
      app: { id: "railsbox-vault-reference", version: "1.0.0" },
      volumeSize: TAILLE,
      identity: { algorithm: "sha-256", digest: null },
      volume: { id: identifiantVolume, algorithm: "aes-256-gcm" },
    }),
  );
}

/**
 * Un banc complet : un magasin de fichiers, le manifeste voisin, et le compte des OUVERTURES DE
 * VOLUME réellement tentées. C'est cette dernière mesure qui distingue « refusé » de « refusé après
 * avoir ouvert », et sans elle un refus ne dirait rien de ce qu'il a laissé derrière lui.
 */
function banc({ avecManifeste = true, identifiantDeclare = VOLUME_A } = {}) {
  const store = createSyncAccessStore();
  const fichiers = new Map();
  if (avecManifeste) fichiers.set(`${NOM}.manifest`, manifeste(identifiantDeclare));
  const ouvertures = [];

  const stat = async (nom) =>
    fichiers.has(nom)
      ? { present: true, size: fichiers.get(nom).byteLength }
      : { present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) };
  const readFileDouble = async (nom, taille) => fichiers.get(nom).subarray(0, taille);

  return {
    store,
    stat,
    readFile: readFileDouble,
    ouvertures,
    support: supportEnveloppeOpfs(NOM, { openHandle: store.openHandle, stat }),
    openVolume: async (options) => {
      // La clé est COPIÉE au moment de l'appel : la couche l'efface aussitôt après, et une
      // référence gardée telle quelle ne mesurerait plus que le tampon vidé.
      ouvertures.push({ ...options, cle: Uint8Array.from(options.cle), tampon: options.cle });
      return { ferme: false, close: async () => {} };
    },
  };
}

/** Prépare l'enveloppe d'un volume sur un banc, et rend la clé de volume tirée. */
async function enveloppePreparee(courant, { identifiantVolume = VOLUME_A } = {}) {
  return preparerEnveloppeDeVolume({
    name: NOM,
    identifiantVolume,
    kek: KEK,
    support: courant.support,
  });
}

test("sans manifeste : le refus est celui du MANIFESTE, et aucun volume n'est ouvert", async () => {
  const courant = banc({ avecManifeste: false });
  await assert.rejects(
    ouvrirVolumeParKek({ name: NOM, kek: KEK, ...courant, expectations: ATTENTES }),
    (erreur) => isManifestError(erreur, MANIFEST_ERROR_CODES.unidentified),
  );
  assert.deepEqual(courant.ouvertures, []);
});

test("manifeste sans enveloppe : « aucune enveloppe », jamais « clé invalide »", async () => {
  const courant = banc();
  await assert.rejects(
    ouvrirVolumeParKek({ name: NOM, kek: KEK, ...courant, expectations: ATTENTES }),
    (erreur) => {
      assert.ok(isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.absente));
      assert.notEqual(erreur.code, ENVELOPPE_ERROR_CODES.cleRefusee);
      assert.match(erreur.message, /PAS une clé invalide/);
      return true;
    },
  );
  assert.deepEqual(courant.ouvertures, [], "un volume a été ouvert alors qu'aucune clé n'existait");
});

test("avec enveloppe : l'ouvreur unique reçoit la clé de volume, et rien d'autre ne la voit", async () => {
  const courant = banc();
  const preparee = await enveloppePreparee(courant);
  const attendue = Uint8Array.from(preparee.dek);

  const rendu = await ouvrirVolumeParKek({
    name: NOM,
    kek: KEK,
    size: TAILLE,
    ...courant,
    expectations: ATTENTES,
  });

  assert.equal(courant.ouvertures.length, 1);
  assert.deepEqual(courant.ouvertures[0].cle, attendue, "l'ouvreur n'a pas reçu la clé développée");
  assert.equal(courant.ouvertures[0].name, NOM);
  assert.equal(rendu.ferme, false, "la couche rend le backend, pas la clé");
  assert.equal(Object.hasOwn(rendu, "dek"), false, "la couche a rendu la clé de volume");
  assert.deepEqual(
    courant.ouvertures[0].tampon,
    new Uint8Array(attendue.byteLength),
    "le tampon de la clé n'a pas été effacé après l'ouverture",
  );
});

test("clé inconnue : refus de clé, et le volume n'est pas ouvert pour autant", async () => {
  const courant = banc();
  await enveloppePreparee(courant);
  await assert.rejects(
    ouvrirVolumeParKek({ name: NOM, kek: KEK_INCONNUE, ...courant, expectations: ATTENTES }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );
  assert.deepEqual(courant.ouvertures, []);
});

test("l'identifiant attendu vient du MANIFESTE : une enveloppe d'un autre volume est refusée", async () => {
  const courant = banc({ identifiantDeclare: VOLUME_B });
  await enveloppePreparee(courant, { identifiantVolume: VOLUME_A });

  await assert.rejects(
    ouvrirVolumeParKek({ name: NOM, kek: KEK, ...courant, expectations: ATTENTES }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.identite),
  );
  assert.deepEqual(courant.ouvertures, []);
});

test("préparer une enveloppe n'écrit QUE l'enveloppe : le volume n'existe pas encore", async () => {
  const courant = banc();
  const preparee = await enveloppePreparee(courant);

  assert.equal(courant.store.sizeOf(enveloppeSidecarName(NOM)) > 0, true);
  assert.equal(
    courant.store.sizeOf(NOM),
    0,
    "le volume a été créé avant que sa clé ne soit durable",
  );
  assert.equal(preparee.dek.byteLength, 32);
  assert.equal(preparee.identifiantVolume, VOLUME_A);
});

test("une enveloppe est un VOISIN réservé : aucun volume ne peut porter son suffixe", () => {
  assert.equal(ENVELOPPE_SIDECAR_SUFFIX, ".cles");
  assert.throws(() => enveloppeSidecarName(`donnees${ENVELOPPE_SIDECAR_SUFFIX}`), TypeError);
});

test("l'ARCHIVE n'emporte pas l'enveloppe : ni son marqueur, ni un octet de DEK enveloppée", async () => {
  const store = createSyncAccessStore();
  const stat = async (nom) => ({ present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) });
  const dek = suiteDOctets(0x20, 32);

  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: dek,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await backend.close();
  await creerEnveloppe({
    support: supportEnveloppeOpfs(NOM, { openHandle: store.openHandle, stat }),
    identifiantVolume: VOLUME_A,
    dek,
    kek: KEK,
  });

  // L'archive porte le FICHIER du volume, tel quel (ADR 0008/0016). Le voisin `.cles` est un autre
  // fichier, et il n'entre pas dans la source de l'export.
  const octetsDuVolume = store.snapshot(NOM);
  const { archive } = await exportVolumeToBytes({
    source: {
      size: octetsDuVolume.byteLength,
      read: async (offset, longueur) => octetsDuVolume.slice(offset, offset + longueur),
    },
    manifest: JSON.parse(new TextDecoder().decode(manifeste())),
    consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "volume fermé pour l'épreuve" },
  });

  const enHex = Buffer.from(archive).toString("hex");
  const enveloppe = store.snapshot(enveloppeSidecarName(NOM));
  assert.equal(
    enHex.includes(Buffer.from("VLTKEY01", "utf8").toString("hex")),
    false,
    "le marqueur du fichier d'enveloppes est dans l'archive",
  );
  assert.equal(
    enHex.includes(Buffer.from(enveloppe.subarray(108, 180)).toString("hex")),
    false,
    "des octets de l'enveloppe sont dans l'archive",
  );
});

test("aucun module du chemin d'ARCHIVE ne connaît le voisin d'enveloppe", async () => {
  // Décision 6 de l'ADR 0020 : l'archive reste SANS clé, et la question de savoir si elle devrait
  // en porter une est posée à #23. Une décision qu'aucune épreuve ne relit se défait toute seule ;
  // celle-ci la relit là où elle se déferait — dans le chemin d'export et d'import.
  const racine = fileURLToPath(new URL("../../src/vm/", import.meta.url));
  const chemin = [
    "volume-export.mjs",
    "volume-import.mjs",
    "opfs-archive-sink.mjs",
    "opfs-volume-brut.mjs",
    "export-du-fichier.mjs",
  ];
  const coupables = [];
  for (const module of chemin) {
    const contenu = await readFile(`${racine}${module}`, "utf8");
    if (/enveloppeSidecarName|ENVELOPPE_SIDECAR_SUFFIX|\.cles\b/.test(contenu)) {
      coupables.push(module);
    }
  }
  assert.deepEqual(coupables, []);
});
