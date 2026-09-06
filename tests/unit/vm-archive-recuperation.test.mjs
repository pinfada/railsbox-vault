/**
 * L'ARCHIVE V2 PORTE UNE ENVELOPPE DE RÉCUPÉRATION SEULE (#149, ADR 0027).
 *
 * L'ADR 0020, décision 6, disait « l'archive n'emporte pas l'enveloppe ». L'ADR 0027 la révise, et
 * ces épreuves sont ce qui distingue la révision d'un renoncement. Elles établissent, dans l'ordre :
 *
 *  1. **ce qui reste vrai** — le CODE n'entre jamais dans l'archive, et l'archive ne porte JAMAIS un
 *     emplacement `phrase` ni `webauthn-prf`. C'est l'épreuve de l'ADR 0020 TRANSFORMÉE : elle ne
 *     cherche plus l'absence du marqueur `VLTKEY01`, elle décode la page embarquée et vérifie que
 *     tous ses emplacements sont de type 4, et que le marqueur n'apparaît qu'à l'offset déclaré ;
 *  2. **la disposition v2** — `[RBVAULT1][longueur][en-tête][contenu N][récupération R]`, l'en-tête
 *     déclarant `recovery`, et la taille valant 12 + H + N + R ;
 *  3. **le refus AVANT toute écriture** — une empreinte d'enveloppe altérée, une page portant un
 *     emplacement d'un autre type, une section tronquée sont des refus TYPÉS rendus par la
 *     vérification, donc avant que la restauration n'ouvre la moindre cible ;
 *  4. **la compatibilité** — une archive v1 reste lisible, et une archive v2 sans moyen de
 *     récupération (`recovery: null`) est admise, avec ce qu'elle implique écrit dans son verdict.
 *
 * Ce que ces épreuves ne mesurent PAS : la restauration elle-même, qui vit dans
 * `vm-restauration-recuperation.test.mjs`, et l'ancre de version, qui y vit aussi.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ARCHIVE_ERROR_CODES, isArchiveError } from "../../src/vm/archive-errors.mjs";
import { ajouterEmplacement } from "../../src/vm/enveloppe-de-cle.mjs";
import {
  construireEnveloppeDeRecuperation,
  exigerEnveloppeDeRecuperationSeule,
} from "../../src/vm/enveloppe-de-recuperation.mjs";
import {
  MARQUEUR_ENVELOPPE,
  PAGE_OCTETS,
  decoderPage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { exportVolumeToBytes, verifyArchive } from "../../src/vm/archive-en-memoire.mjs";
import { ARCHIVE_FORMAT_VERSION, PREAMBLE_BYTES } from "../../src/vm/volume-export.mjs";
import {
  ATTENTES,
  DEK,
  KEK,
  VOLUME_A,
  descripteurDeManifeste,
  magasin,
  poserVolume,
  sourceDuVolume,
} from "./support-archive-recuperation.mjs";
import { suiteDOctets } from "./support-enveloppe-double.mjs";

const decodeur = new TextDecoder();

/** Prépare un volume, son enveloppe et son moyen de récupération, puis rend l'archive écrite. */
async function archiveDUnVolume({ avecRecuperation = true } = {}) {
  const banc = magasin();
  const pose = await poserVolume(banc, { avecRecuperation });
  const recuperation = await construireEnveloppeDeRecuperation({
    support: pose.support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
  });
  const ecrite = await exportVolumeToBytes({
    source: sourceDuVolume(banc, pose.nom),
    manifest: descripteurDeManifeste(),
    consistency: { kind: "handle-exclusif", detail: "volume fermé pour l'épreuve" },
    recovery: recuperation,
  });
  return { banc, pose, recuperation, ...ecrite };
}

/** L'en-tête JSON d'une archive, relu depuis ses octets — jamais depuis le verdict du produit. */
function enTeteDe(archive) {
  const longueur = new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(
    8,
    false,
  );
  return {
    longueur,
    objet: JSON.parse(decodeur.decode(archive.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + longueur))),
  };
}

/** Tous les offsets où le marqueur d'enveloppe apparaît dans l'archive. */
function offsetsDuMarqueur(archive) {
  const trouves = [];
  for (let offset = 0; offset + MARQUEUR_ENVELOPPE.byteLength <= archive.byteLength; offset += 1) {
    if (MARQUEUR_ENVELOPPE.every((attendu, rang) => archive[offset + rang] === attendu)) {
      trouves.push(offset);
    }
  }
  return trouves;
}

test("le format d'archive écrit est la version 2, et sa disposition est 12 + H + N + R", async () => {
  const { archive, recuperation, contentLength, headerLength } = await archiveDUnVolume();
  const entete = enTeteDe(archive);

  assert.equal(ARCHIVE_FORMAT_VERSION, 2);
  assert.equal(entete.objet.archiveFormatVersion, 2);
  assert.equal(entete.longueur, headerLength);
  assert.equal(recuperation.octets.byteLength, PAGE_OCTETS);
  assert.equal(
    archive.byteLength,
    PREAMBLE_BYTES + headerLength + contentLength + PAGE_OCTETS,
    "une archive v2 fait 12 + H + N + R",
  );
  assert.deepEqual(entete.objet.recovery, {
    length: PAGE_OCTETS,
    digest: recuperation.digest,
    envelopeVersion: recuperation.version,
    slots: 1,
  });
});

test("l'archive porte EXACTEMENT UNE page d'enveloppe, et le marqueur n'est qu'à l'offset déclaré", async () => {
  const { archive, headerLength, contentLength } = await archiveDUnVolume();
  const attendu = PREAMBLE_BYTES + headerLength + contentLength;
  assert.deepEqual(
    offsetsDuMarqueur(archive),
    [attendu],
    "le marqueur d'enveloppe apparaît ailleurs qu'à l'offset de la section de récupération",
  );
});

test("tous les emplacements de la page embarquée sont de type 4 : ni phrase, ni passkey, ni harnais", async () => {
  const { archive, headerLength, contentLength } = await archiveDUnVolume();
  const offset = PREAMBLE_BYTES + headerLength + contentLength;
  const lue = decoderPage(archive.subarray(offset, offset + PAGE_OCTETS));

  assert.equal(lue.valide, true, lue.raison ?? "");
  assert.equal(lue.page.identifiantVolume, VOLUME_A);
  assert.ok(lue.page.emplacements.length >= 1);
  for (const emplacement of lue.page.emplacements) {
    assert.equal(
      emplacement.typeKek,
      TYPES_KEK.recuperation,
      "un emplacement d'un autre type que 4 est parti dans l'archive",
    );
  }
  assert.deepEqual(
    [TYPES_KEK.phrase, TYPES_KEK["webauthn-prf"], TYPES_KEK.harnais].filter((type) =>
      lue.page.emplacements.some((emplacement) => emplacement.typeKek === type),
    ),
    [],
  );
});

test("le CODE de récupération n'entre jamais dans l'archive, sous aucune de ses formes", async () => {
  const { archive, pose } = await archiveDUnVolume();
  const enHex = Buffer.from(archive).toString("hex");
  const code = pose.code;

  assert.match(code, /^[0-9A-Z-]+$/);
  for (const forme of [code, code.replaceAll("-", ""), code.toLowerCase()]) {
    assert.equal(
      enHex.includes(Buffer.from(forme, "utf8").toString("hex")),
      false,
      `le code de récupération est dans l'archive sous la forme « ${forme} »`,
    );
  }
  // Et la CLÉ DE VOLUME non plus : la page embarquée ne porte que la DEK ENVELOPPÉE.
  assert.equal(enHex.includes(Buffer.from(DEK).toString("hex")), false);
});

test("une enveloppe SANS emplacement de type 4 ne produit aucune section : l'archive le DIT", async () => {
  const banc = magasin();
  const pose = await poserVolume(banc, { avecRecuperation: false });
  const recuperation = await construireEnveloppeDeRecuperation({
    support: pose.support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
  });
  assert.equal(recuperation, null, "une enveloppe sans moyen de récupération n'en fabrique pas un");

  const { archive } = await exportVolumeToBytes({
    source: sourceDuVolume(banc, pose.nom),
    manifest: descripteurDeManifeste(),
    consistency: { kind: "handle-exclusif" },
    recovery: recuperation,
  });
  assert.equal(enTeteDe(archive).objet.recovery, null);

  const verdict = await verifyArchive(archive, { expectations: ATTENTES });
  assert.equal(verdict.recovery, null);
  assert.deepEqual(offsetsDuMarqueur(archive), []);
});

test("une section qui n'est pas une page d'enveloppe lisible est refusée, jamais devinée", () => {
  assert.throws(
    () => exigerEnveloppeDeRecuperationSeule(new Uint8Array(PAGE_OCTETS)),
    (erreur) => isArchiveError(erreur, ARCHIVE_ERROR_CODES.recuperationRefusee),
  );
});

test("une enveloppe embarquée dont un emplacement n'est pas de type 4 est refusée à la lecture", async () => {
  // La page est fabriquée à partir d'une enveloppe RÉELLE portant deux types, puis embarquée telle
  // quelle : c'est l'archive forgée qu'un adversaire produirait pour faire voyager une phrase.
  const banc = magasin();
  const pose = await poserVolume(banc);
  const complete = await lirePageCourante(banc, pose.nom);

  assert.throws(
    () => exigerEnveloppeDeRecuperationSeule(complete),
    (erreur) => {
      assert.ok(isArchiveError(erreur, ARCHIVE_ERROR_CODES.recuperationRefusee));
      assert.match(erreur.message, /type/);
      return true;
    },
  );
});

test("une empreinte de section de récupération altérée est refusée à la VÉRIFICATION", async () => {
  const { archive } = await archiveDUnVolume();
  const altere = Uint8Array.from(archive);
  altere[altere.byteLength - 40] ^= 0x01;

  await assert.rejects(verifyArchive(altere, { expectations: ATTENTES }), (erreur) => {
    assert.ok(isArchiveError(erreur, ARCHIVE_ERROR_CODES.recuperationAlteree));
    assert.notEqual(
      erreur.code,
      ARCHIVE_ERROR_CODES.digestMismatch,
      "une section de récupération altérée n'est pas un contenu altéré : les remèdes diffèrent",
    );
    return true;
  });
});

test("une archive v2 tronquée dans sa section de récupération est refusée, pas complétée", async () => {
  const { archive } = await archiveDUnVolume();
  await assert.rejects(
    verifyArchive(archive.subarray(0, archive.byteLength - 1), { expectations: ATTENTES }),
    (erreur) => isArchiveError(erreur, ARCHIVE_ERROR_CODES.truncated),
  );
});

test("une archive de version 1 reste lisible, et son verdict porte « aucune récupération »", async () => {
  const { archive, headerLength, contentLength } = await archiveDUnVolume({
    avecRecuperation: false,
  });
  // L'archive v1 est reconstruite depuis la v2 sans récupération : même contenu, en-tête ramené à
  // la version 1 et champ `recovery` retiré, comme une archive écrite avant cette tranche.
  const entete = enTeteDe(archive);
  delete entete.objet.recovery;
  entete.objet.archiveFormatVersion = 1;
  const octetsEnTete = new TextEncoder().encode(JSON.stringify(entete.objet));
  const v1 = new Uint8Array(PREAMBLE_BYTES + octetsEnTete.byteLength + contentLength);
  v1.set(archive.subarray(0, PREAMBLE_BYTES), 0);
  new DataView(v1.buffer).setUint32(8, octetsEnTete.byteLength, false);
  v1.set(octetsEnTete, PREAMBLE_BYTES);
  v1.set(
    archive.subarray(PREAMBLE_BYTES + headerLength, PREAMBLE_BYTES + headerLength + contentLength),
    PREAMBLE_BYTES + octetsEnTete.byteLength,
  );

  const verdict = await verifyArchive(v1, { expectations: ATTENTES });
  assert.equal(verdict.contentLength, contentLength);
  assert.equal(verdict.recovery, null);
  assert.equal(verdict.archiveLength, v1.byteLength);
});

test("une archive v1 qui DÉCLARE une récupération est malformée : la version décide de la disposition", async () => {
  const { archive } = await archiveDUnVolume();
  const entete = enTeteDe(archive);
  entete.objet.archiveFormatVersion = 1;
  const octetsEnTete = new TextEncoder().encode(JSON.stringify(entete.objet));
  const forge = new Uint8Array(
    PREAMBLE_BYTES +
      octetsEnTete.byteLength +
      (archive.byteLength - PREAMBLE_BYTES - entete.longueur),
  );
  forge.set(archive.subarray(0, PREAMBLE_BYTES), 0);
  new DataView(forge.buffer).setUint32(8, octetsEnTete.byteLength, false);
  forge.set(octetsEnTete, PREAMBLE_BYTES);
  forge.set(
    archive.subarray(PREAMBLE_BYTES + entete.longueur),
    PREAMBLE_BYTES + octetsEnTete.byteLength,
  );

  await assert.rejects(verifyArchive(forge, { expectations: ATTENTES }), (erreur) =>
    isArchiveError(erreur, ARCHIVE_ERROR_CODES.malformed),
  );
});

test("un module d'ARCHIVE ne connaît toujours pas le voisin d'enveloppe, et UN SEUL la construit", async () => {
  // L'épreuve de l'ADR 0020 décision 6, TRANSFORMÉE par l'ADR 0027. Ce qui est mesuré a changé de
  // nature : ce n'est plus « aucun module ne connaît `.cles` » — un module doit désormais l'écrire —
  // mais « les modules d'archive restent aveugles, et la construction vit à UN endroit nommé ».
  const racine = fileURLToPath(new URL("../../src/vm/", import.meta.url));
  const aveugles = [
    "volume-export.mjs",
    "volume-import.mjs",
    "archive-recuperation.mjs",
    "opfs-archive-sink.mjs",
    "opfs-volume-brut.mjs",
    "export-du-fichier.mjs",
  ];
  const coupables = [];
  for (const module of aveugles) {
    const contenu = await readFile(`${racine}${module}`, "utf8");
    if (/enveloppeSidecarName|ENVELOPPE_SIDECAR_SUFFIX|\.cles\b/.test(contenu)) {
      coupables.push(module);
    }
  }
  assert.deepEqual(coupables, [], "un module d'archive a appris à nommer le voisin d'enveloppe");

  // Et la CONSTRUCTION vit dans un seul module, qui est celui que l'ADR 0027 nomme.
  const constructeurs = [];
  for (const module of [...aveugles, "enveloppe-de-recuperation.mjs", "opfs-import-target.mjs"]) {
    const contenu = await readFile(`${racine}${module}`, "utf8");
    if (/export (async )?function construireEnveloppeDeRecuperation/.test(contenu)) {
      constructeurs.push(module);
    }
  }
  assert.deepEqual(constructeurs, ["enveloppe-de-recuperation.mjs"]);
});

/** Relit la page qui fait autorité dans le fichier d'enveloppes d'un volume du banc. */
async function lirePageCourante(banc, nom) {
  const fichier = banc.lire(`${nom}.cles`);
  const pages = [0, 1]
    .map((index) => decoderPage(fichier.subarray(index * PAGE_OCTETS, (index + 1) * PAGE_OCTETS)))
    .filter((lue) => lue.valide);
  const autorite = pages.reduce((a, b) => (b.page.version > a.page.version ? b : a));
  const offset = pages.indexOf(autorite) === 0 ? 0 : PAGE_OCTETS;
  return fichier.subarray(offset, offset + PAGE_OCTETS);
}

test("un emplacement ajouté APRÈS la construction ne rejoint pas la page déjà construite", async () => {
  // La page de récupération est un INSTANTANÉ : elle porte la version de l'enveloppe au moment de
  // l'export, et rien de ce qui vient après. C'est ce qui rend le § « restauration et ancre » de
  // l'ADR 0027 nécessaire, et le dire ici évite qu'on le croie autrement.
  const banc = magasin();
  const pose = await poserVolume(banc);
  const avant = await construireEnveloppeDeRecuperation({
    support: pose.support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
  });
  await ajouterEmplacement({
    support: pose.support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
    kekNouvelle: suiteDOctets(0x40, 32),
  });
  const apres = await construireEnveloppeDeRecuperation({
    support: pose.support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
  });

  assert.equal(apres.version, avant.version + 1, "la version suit l'enveloppe, elle ne stagne pas");
  assert.equal(apres.emplacements, 1, "l'emplacement ajouté n'est pas de type 4 : il reste dehors");
  assert.notDeepEqual(Array.from(apres.octets), Array.from(avant.octets));
});
