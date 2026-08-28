// L'archive d'un volume CHIFFRÉ porte son FICHIER, tel quel (#101, ADR 0016, décision 7).
//
// La tranche (a) refusait d'exporter un volume v3, et le refus était juste : son chemin lisait par la
// voie autorisée, qui DÉCHIFFRE, si bien qu'il aurait produit une archive en clair d'un volume
// chiffré. Cette tranche lève le refus en fournissant ce qui manquait — la lecture et l'écriture
// BRUTES — et fige ici ce que « tel quel » veut dire, octet par octet.
//
// Trois propriétés, et la troisième est celle qu'on oublie :
//
//  1. la LONGUEUR de contenu d'une archive de volume v3 est celle du FICHIER (en-tête, région
//     d'authentification, charge), pas celle du volume logique ;
//  2. l'EMPREINTE porte sur ces mêmes octets, donc sur du chiffré. Deux exports d'un même contenu
//     logique ne sont plus comparables par empreinte — c'est voulu, et c'est éprouvé ;
//  3. la restauration recopie SANS CLÉ. Rien dans ce chemin n'ouvre un secteur, et une archive
//     restaurée reste inerte tant que personne n'apporte la clé.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import {
  CONSISTENCY_KINDS,
  exportVolumeToBytes,
  verifyArchive,
} from "../../src/vm/volume-export.mjs";
import { importArchive } from "../../src/vm/volume-import.mjs";
import { createManifest } from "../../src/vm/volume-manifest.mjs";
import { VolumeChiffre } from "../../src/vm/volume-chiffre.mjs";
import {
  dispositionV3,
  encoderEnTeteV3,
  tailleDeFichier,
  tailleSupportV3,
} from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE_LOGIQUE = 8 * SECTOR_SIZE;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";
const COHERENCE = {
  kind: CONSISTENCY_KINDS.exclusiveHandle,
  detail: "volume lu via le handle exclusif",
};

function manifeste(formatVersion, tailleLogique = TAILLE_LOGIQUE) {
  return createManifest({
    formatVersion,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: { id: "railsbox/reference", version: "3.1.0" },
    volumeSize: tailleLogique,
    identity: { algorithm: "sha-256", digest: null },
    ...(formatVersion >= 3 ? { volume: { id: IDENTIFIANT, algorithm: "aes-256-gcm" } } : {}),
  });
}

/** Fabrique un FICHIER v3 complet en mémoire, scellé par le chemin de production. */
async function fichierV3(graine) {
  const disposition = dispositionV3(TAILLE_LOGIQUE);
  const octets = new Uint8Array(disposition.tailleSupport);
  octets.set(encoderEnTeteV3({ tailleLogique: TAILLE_LOGIQUE, identifiantVolume: IDENTIFIANT }), 0);
  const volume = new VolumeChiffre({
    volume: "eprouve",
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT,
      cleOctets: CLE_DE_TEST,
      formatVersion: 3,
    }),
    disposition,
    lireSupport: (offset, longueur) => octets.slice(offset, offset + longueur),
    ecrireSupport: (offset, source) => octets.set(source, offset),
  });
  await volume.scellerTout(0);
  await volume.ecrireSecteurs(
    0,
    Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index + graine) % 256),
    1,
  );
  return { octets, disposition, volume };
}

function source(octets) {
  return {
    size: octets.byteLength,
    read: (offset, length) => Promise.resolve(octets.slice(offset, offset + length)),
  };
}

/** Vrai si `motif` apparaît quelque part dans `octets`. Recherche naïve : l'épreuve est petite. */
function contient(octets, motif) {
  for (let debut = 0; debut + motif.byteLength <= octets.byteLength; debut += 1) {
    let identique = true;
    for (let index = 0; index < motif.byteLength; index += 1) {
      if (octets[debut + index] !== motif[index]) {
        identique = false;
        break;
      }
    }
    if (identique) return true;
  }
  return false;
}

/** Cible de restauration qui COMPTE ses gestes : ce qu'on veut savoir est ce qui n'a pas eu lieu. */
function cibleQuiCompte() {
  const gestes = [];
  return {
    gestes,
    async inspect() {
      gestes.push("inspect");
      return { present: false, size: 0 };
    },
    async open() {
      gestes.push("open");
      throw new Error("la cible ne devait pas être ouverte");
    },
    async revokeManifest() {
      gestes.push("revoke");
    },
    async commitManifest() {
      gestes.push("commit");
    },
    async readManifest() {
      gestes.push("read-manifest");
      return null;
    },
  };
}

test("la longueur d'archive d'un volume v3 est celle du FICHIER, pas du volume logique", () => {
  // Elle est DÉRIVÉE du format et de la géométrie, jamais reçue : deux sources de vérité
  // divergeraient, et c'est l'archive qui deviendrait invérifiable.
  assert.equal(
    tailleDeFichier({ formatVersion: 1, tailleLogique: TAILLE_LOGIQUE }),
    TAILLE_LOGIQUE,
  );
  assert.equal(
    tailleDeFichier({ formatVersion: 2, tailleLogique: TAILLE_LOGIQUE }),
    TAILLE_LOGIQUE,
  );
  assert.equal(
    tailleDeFichier({ formatVersion: 3, tailleLogique: TAILLE_LOGIQUE }),
    tailleSupportV3(TAILLE_LOGIQUE),
  );
  assert.ok(tailleSupportV3(TAILLE_LOGIQUE) > TAILLE_LOGIQUE, "le fichier v3 est plus grand");
});

test("un volume v3 s'exporte TEL QUEL : l'archive porte ses octets chiffrés", async () => {
  const { octets } = await fichierV3(7);
  const { archive, manifest, digest } = await exportVolumeToBytes({
    source: source(octets),
    manifest: manifeste(3),
    consistency: COHERENCE,
  });

  const verdict = await verifyArchive(archive);
  assert.equal(verdict.contentLength, octets.byteLength, "le contenu est le FICHIER");
  assert.equal(verdict.contentDigest, digest);
  assert.equal(manifest.formatVersion, 3);
  assert.equal(manifest.volume.id, IDENTIFIANT, "l'archive décrit le volume qu'elle porte");
  assert.equal(
    manifest.geometry.volumeSize,
    TAILLE_LOGIQUE,
    "la géométrie reste LOGIQUE : c'est ce que v86 verra",
  );

  // Les octets de l'archive sont ceux du fichier, en-tête v3 compris.
  const contenu = archive.subarray(
    verdict.contentOffset,
    verdict.contentOffset + octets.byteLength,
  );
  assert.deepEqual([...contenu], [...octets]);
});

test("l'empreinte porte sur le CHIFFRÉ : deux exports d'un même contenu ne se comparent plus", async () => {
  // Conséquence assumée de la décision 7, et il vaut mieux l'éprouver que l'affirmer : les nonces
  // sont tirés, donc deux volumes portant le même clair portent des octets différents.
  const premier = await fichierV3(7);
  const second = await fichierV3(7);
  const a = await exportVolumeToBytes({
    source: source(premier.octets),
    manifest: manifeste(3),
    consistency: COHERENCE,
  });
  const b = await exportVolumeToBytes({
    source: source(second.octets),
    manifest: manifeste(3),
    consistency: COHERENCE,
  });

  assert.notEqual(a.digest, b.digest, "même clair, empreintes distinctes");
  // Et le CLAIR, lui, est bien le même : ce que l'empreinte ne dit plus, la lecture le dit encore.
  assert.deepEqual(
    [...(await premier.volume.lireSecteurs(0, SECTOR_SIZE))],
    [...(await second.volume.lireSecteurs(0, SECTOR_SIZE))],
  );
});

test("une archive de volume v3 se restaure SANS CLÉ, octet pour octet", async () => {
  const { octets, disposition } = await fichierV3(11);
  const { archive } = await exportVolumeToBytes({
    source: source(octets),
    manifest: manifeste(3),
    consistency: COHERENCE,
  });

  const cible = cibleBrute();
  const rapport = await importArchive({
    source: {
      byteLength: archive.byteLength,
      read: (o, l) => Promise.resolve(archive.slice(o, o + l)),
    },
    target: cible,
    blockBytes: SECTOR_SIZE * 4,
  });

  assert.equal(rapport.restored, true);
  assert.equal(rapport.volumeSize, disposition.tailleSupport, "la cible reçoit le FICHIER entier");
  assert.deepEqual([...cible.octets], [...octets], "recopie octet pour octet");
  assert.equal(
    cible.ouverturesChiffrees,
    0,
    "aucun secteur n'a été ouvert : la clé n'est pas requise",
  );
});

/** Cible de restauration BRUTE : elle recopie des octets et n'ouvre aucun secteur. */
function cibleBrute() {
  const etat = { octets: new Uint8Array(0), ouverturesChiffrees: 0, manifestBytes: null };
  const backend = {
    size: () => etat.octets.byteLength,
    read: async (offset, length) => etat.octets.slice(offset, offset + length),
    write: async (offset, bytes) => {
      etat.octets.set(bytes, offset);
    },
    flush: async () => {},
    close: async () => {},
  };
  return {
    volume: "cible",
    get octets() {
      return etat.octets;
    },
    get ouverturesChiffrees() {
      return etat.ouverturesChiffrees;
    },
    async inspect() {
      return { present: false, size: 0, manifestBytes: null };
    },
    async open({ size }) {
      etat.octets = new Uint8Array(size);
      return backend;
    },
    async revokeManifest() {},
    async discardGeneration() {},
    async commitManifest(bytes) {
      etat.manifestBytes = bytes;
    },
  };
}

test("le CLAIR d'un secteur connu n'apparaît nulle part dans l'archive exportée", async () => {
  // `SECURITY.md` affirmait qu'une épreuve le montrait. Elle n'existait pas — la revue de #110 l'a
  // relevé, et le remède n'est pas de retirer la phrase.
  //
  // Le motif cherché est un secteur ENTIER, écrit par le chemin de production dans le volume, puis
  // cherché dans les octets de l'archive. Un motif court se rencontrerait par hasard dans du
  // chiffré ; cinq cent douze octets consécutifs, non.
  const motif = Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index * 13 + 5) % 256);
  const disposition = dispositionV3(TAILLE_LOGIQUE);
  const octets = new Uint8Array(disposition.tailleSupport);
  octets.set(encoderEnTeteV3({ tailleLogique: TAILLE_LOGIQUE, identifiantVolume: IDENTIFIANT }), 0);
  const volume = new VolumeChiffre({
    volume: "eprouve",
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT,
      cleOctets: CLE_DE_TEST,
      formatVersion: 3,
    }),
    disposition,
    lireSupport: (offset, longueur) => octets.slice(offset, offset + longueur),
    ecrireSupport: (offset, source_) => octets.set(source_, offset),
  });
  await volume.scellerTout(0);
  await volume.ecrireSecteurs(2 * SECTOR_SIZE, motif, 1);

  // Le témoin POSITIF d'abord : le motif est bien dans le volume, par la lecture autorisée. Sans
  // lui, une épreuve qui ne trouve rien ne prouverait rien.
  assert.deepEqual(
    [...(await volume.lireSecteurs(2 * SECTOR_SIZE, SECTOR_SIZE))],
    [...motif],
    "le motif est bien le clair de ce secteur",
  );

  const { archive } = await exportVolumeToBytes({
    source: source(octets),
    manifest: manifeste(3),
    consistency: COHERENCE,
  });

  assert.equal(
    contient(archive, motif),
    false,
    "le clair d'un secteur connu n'est nulle part dans l'archive",
  );
  // Et le témoin NÉGATIF de la méthode : la même recherche TROUVE ce motif dans un fichier qui le
  // porte en clair. Sans elle, une recherche qui ne trouve jamais rien passerait pour une preuve.
  const enClair = new Uint8Array(disposition.tailleSupport);
  enClair.set(motif, 2 * SECTOR_SIZE);
  assert.equal(contient(enClair, motif), true, "la recherche sait trouver ce qu'elle cherche");
});

test("une archive dont le MANIFESTE et le FICHIER déclarent des volumes différents est refusée AVANT d'écrire", async () => {
  // L'ADR 0009 pose la règle : vérifier avant d'écrire. Une telle archive passait toute la
  // restauration — l'empreinte porte sur les octets, pas sur leur cohérence avec le manifeste —, et
  // le volume restauré était refusé À L'OUVERTURE par `VAULT_STORAGE_IDENTITE_VOLUME`. Le refus
  // était juste ; son MOMENT ne l'était pas, puisque la cible avait déjà été écrasée.
  const { octets } = await fichierV3(3);
  const autre = "fedcba9876543210fedcba9876543210";
  const { archive } = await exportVolumeToBytes({
    source: source(octets),
    // Le manifeste déclare un AUTRE volume que celui dont l'en-tête est dans le fichier.
    manifest: createManifest({
      formatVersion: 3,
      runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
      app: { id: "railsbox/reference", version: "3.1.0" },
      volumeSize: TAILLE_LOGIQUE,
      identity: { algorithm: "sha-256", digest: null },
      volume: { id: autre, algorithm: "aes-256-gcm" },
    }),
    consistency: COHERENCE,
  });

  const cible = cibleQuiCompte();
  await assert.rejects(
    () =>
      importArchive({
        source: { byteLength: archive.byteLength, read: (o, l) => archive.slice(o, o + l) },
        target: cible,
        enforceCompatibility: false,
      }),
    (erreur) => {
      assert.match(erreur.message, /déclare le volume/, erreur.message);
      assert.match(erreur.message, /Aucun octet n'est écrit/);
      return true;
    },
  );
  // Le refus tombe même avant l'inspection : la cible n'est pas touchée du tout.
  assert.deepEqual(cible.gestes, [], "la cible n'est ni inspectée ni ouverte");
});
