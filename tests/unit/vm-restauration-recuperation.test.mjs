/**
 * LA RESTAURATION REND LA CAPACITÉ D'OUVRIR (#149, ADR 0027).
 *
 * C'est le résultat que la tranche 3 de #23 doit livrer, et il tient en une phrase : un volume
 * chiffré, exporté puis restauré sur un support qui n'a jamais vu la source, s'ouvre par le CODE de
 * récupération. Avant cette tranche, il ne s'ouvrait nulle part — l'archive portait le coffre sans
 * la serrure (ADR 0020, décision 6).
 *
 * Quatre propriétés sont établies ici, et aucune ne se déduit des autres :
 *
 *  1. **le cycle entier** — exporter, restaurer, ouvrir par le code, lire le clair. C'est la seule
 *     épreuve qui traverse les trois modules et le voisin `.cles` d'un bout à l'autre ;
 *  2. **l'ORDRE des gestes** — contenu, puis enveloppe, puis manifeste. Une coupure à n'importe quel
 *     rang ne doit JAMAIS laisser un volume déclaré complet sans son enveloppe : le manifeste est
 *     ce qui déclare, et il vient en dernier ;
 *  3. **le refus AVANT la mutation** — une section de récupération altérée ou d'un mauvais type est
 *     refusée alors que la cible n'a pas été ouverte, encore moins écrite ;
 *  4. **l'ancre et l'archive** — une archive est par nature ANTÉRIEURE. Si la version notée sur la
 *     feuille de récupération dépasse celle de l'enveloppe embarquée, la restaurer exige un
 *     CONSENTEMENT NOMMÉ, et la version restaurée devient la nouvelle référence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ARCHIVE_ERROR_CODES, isArchiveError } from "../../src/vm/archive-errors.mjs";
import { derivateurRecuperation } from "../../src/vm/derivation/derivateur-recuperation.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import {
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { IMPORT_ERROR_CODES, isImportError } from "../../src/vm/import-errors.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { ouvrirVolumeParDerivateur } from "../../src/vm/ouverture-par-enveloppe.mjs";
import { exportVolumeToBytes } from "../../src/vm/volume-export.mjs";
import { importArchive } from "../../src/vm/volume-import.mjs";
import {
  ATTENTES,
  DEK,
  KEK,
  VOLUME_A,
  cibleDe,
  descripteurDeManifeste,
  magasin,
  poserVolume,
  sourceDArchive,
  sourceDuVolume,
  supportDe,
} from "./support-archive-recuperation.mjs";

const CIBLE = "restaure";

/** Exporte un volume neuf, et rend l'archive avec ce qu'il faut pour la comparer ensuite. */
async function archiveExportee({ avecRecuperation = true } = {}) {
  const origine = magasin();
  const pose = await poserVolume(origine, { avecRecuperation });
  const recuperation = await construireEnveloppeDeRecuperation({
    support: pose.support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
  });
  const ecrite = await exportVolumeToBytes({
    source: sourceDuVolume(origine, pose.nom),
    manifest: descripteurDeManifeste(),
    consistency: { kind: "handle-exclusif", detail: "volume fermé pour l'épreuve" },
    recovery: recuperation,
  });
  return { origine, pose, recuperation, ...ecrite };
}

/** Lit un secteur EN CLAIR d'un volume du magasin, sous la clé de volume donnée. */
async function clairDuSecteur(banc, nom, cle, rang = 0) {
  const backend = await openOpfsVolume({
    name: nom,
    size: null,
    cle,
    identifiantVolume: VOLUME_A,
    openHandle: banc.store.openHandle,
    transactionnel: false,
  });
  try {
    return await backend.read(rang * 512, 512);
  } finally {
    await backend.close();
  }
}

test("le cycle entier : exporté, restauré ailleurs, le volume s'ouvre PAR LE CODE", async () => {
  const { origine, pose, archive, recuperation } = await archiveExportee();
  // Ce que le volume porte en clair AVANT de partir : c'est cela qu'on doit retrouver.
  const clairAvant = await clairDuSecteur(origine, pose.nom, DEK);

  const destination = magasin();
  const { cible, gestes } = cibleDe(destination, CIBLE);
  const rapport = await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: ATTENTES,
  });

  assert.equal(rapport.restored, true);
  assert.deepEqual(rapport.recovery, {
    length: PAGE_OCTETS,
    digest: recuperation.digest,
    envelopeVersion: recuperation.version,
    slots: 1,
  });
  assert.deepEqual(
    gestes,
    ["revoque-manifeste", "ecrit:.cles", "ecrit:.manifest"],
    "l'ordre de l'ADR 0027 : contenu, puis enveloppe, puis manifeste",
  );

  // Le voisin `.cles` porte DEUX pages : la page embarquée, puis une page à zéro.
  const fichier = destination.lire(`${CIBLE}.cles`);
  assert.equal(fichier.byteLength, TAILLE_FICHIER_ENVELOPPE);
  assert.deepEqual(
    Array.from(fichier.subarray(0, PAGE_OCTETS)),
    Array.from(recuperation.octets),
    "la page embarquée est écrite telle quelle en page 0",
  );
  assert.deepEqual(
    Array.from(fichier.subarray(PAGE_OCTETS)),
    Array.from(new Uint8Array(PAGE_OCTETS)),
    "la page 1 est à zéro : rien de l'ancienne enveloppe de la cible ne survit",
  );

  // ET LE VOLUME S'OUVRE PAR LE CODE. C'est la phrase de la tranche, exécutée.
  const backend = await ouvrirVolumeParDerivateur({
    name: CIBLE,
    derivateur: derivateurRecuperation(),
    geste: { code: pose.code },
    expectations: ATTENTES,
    support: supportDe(destination, CIBLE),
    stat: destination.stat,
    readFile: destination.readFile,
    openVolume: (options) =>
      openOpfsVolume({
        ...options,
        openHandle: destination.store.openHandle,
        transactionnel: false,
      }),
  });
  try {
    assert.deepEqual(Array.from(await backend.read(0, 512)), Array.from(clairAvant));
  } finally {
    await backend.close();
  }
});

test("une archive SANS récupération restaure le volume, et laisse la cible SANS enveloppe", async () => {
  const { archive } = await archiveExportee({ avecRecuperation: false });
  const destination = magasin();
  const { cible, gestes } = cibleDe(destination, CIBLE);
  const rapport = await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: ATTENTES,
  });

  assert.equal(rapport.restored, true);
  assert.equal(rapport.recovery, null);
  assert.deepEqual(gestes, ["revoque-manifeste", "ecrit:.manifest"]);
  assert.equal(destination.lire(`${CIBLE}.cles`), null);
});

test("l'enveloppe d'un volume ÉCRASÉ ne survit pas à la restauration", async () => {
  // Une enveloppe qui survivrait décrirait un volume qui n'existe plus : ses emplacements
  // n'ouvriraient rien, et le refus serait `VAULT_ENVELOPPE_IDENTITE` — un diagnostic exact pour
  // une cause qu'on aurait fabriquée soi-même.
  const { archive } = await archiveExportee({ avecRecuperation: false });
  const destination = magasin();
  await poserVolume(destination, { nom: CIBLE });
  assert.notEqual(destination.lire(`${CIBLE}.cles`), null);

  const { cible } = cibleDe(destination, CIBLE);
  await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: ATTENTES,
    overwrite: true,
  });
  assert.equal(destination.lire(`${CIBLE}.cles`), null);
});

test("une section de récupération altérée est refusée SANS que la cible soit ouverte", async () => {
  const { archive } = await archiveExportee();
  const altere = Uint8Array.from(archive);
  altere[altere.byteLength - 200] ^= 0x01;

  const destination = magasin();
  const { cible, gestes } = cibleDe(destination, CIBLE);
  await assert.rejects(
    importArchive({ source: sourceDArchive(altere), target: cible, expectations: ATTENTES }),
    (erreur) => isArchiveError(erreur, ARCHIVE_ERROR_CODES.recuperationAlteree),
  );
  assert.deepEqual(gestes, []);
  assert.equal(destination.store.sizeOf(CIBLE), 0, "aucun octet n'est écrit sur la cible");
});

test("une page embarquée portant un emplacement d'un autre type est refusée avant toute mutation", async () => {
  // L'archive est FORGÉE : sa section de récupération est la page complète de l'enveloppe — celle
  // qui porte le harnais ET le code. Son empreinte est recalculée, si bien que seule la garde de
  // type peut la refuser.
  const { origine, pose, archive } = await archiveExportee();
  const complete = origine.lire(`${pose.nom}.cles`).subarray(0, PAGE_OCTETS);
  const lue = decoderPage(complete);
  assert.ok(
    lue.page.emplacements.some((emplacement) => emplacement.typeKek === TYPES_KEK.harnais),
    "la page complète doit bien porter un emplacement d'un autre type",
  );

  const forge = await reforger(archive, complete);
  const destination = magasin();
  const { cible, gestes } = cibleDe(destination, CIBLE);
  await assert.rejects(
    importArchive({ source: sourceDArchive(forge), target: cible, expectations: ATTENTES }),
    (erreur) => isArchiveError(erreur, ARCHIVE_ERROR_CODES.recuperationRefusee),
  );
  assert.deepEqual(gestes, []);
});

/** Remplace la section de récupération d'une archive et remet l'en-tête d'accord avec elle. */
async function reforger(archive, page) {
  const vue = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const longueurEnTete = vue.getUint32(8, false);
  const entete = JSON.parse(
    new TextDecoder().decode(archive.subarray(12, 12 + longueurEnTete)),
  );
  const empreinte = Buffer.from(
    await crypto.subtle.digest("SHA-256", page.slice()),
  ).toString("hex");
  entete.recovery = { ...entete.recovery, digest: empreinte };
  const octetsEnTete = new TextEncoder().encode(JSON.stringify(entete));
  const contenu = archive.subarray(
    12 + longueurEnTete,
    archive.byteLength - entete.recovery.length,
  );
  const forge = new Uint8Array(12 + octetsEnTete.byteLength + contenu.byteLength + page.byteLength);
  forge.set(archive.subarray(0, 12), 0);
  new DataView(forge.buffer).setUint32(8, octetsEnTete.byteLength, false);
  forge.set(octetsEnTete, 12);
  forge.set(contenu, 12 + octetsEnTete.byteLength);
  forge.set(page, 12 + octetsEnTete.byteLength + contenu.byteLength);
  return forge;
}

/** Cible qui COUPE au geste nommé : le geste n'a aucun effet, et tout s'arrête. */
function cibleQuiCoupe(banc, nom, geste) {
  const { cible, gestes } = cibleDe(banc, nom);
  return {
    gestes,
    cible: {
      ...cible,
      inspect: () => cible.inspect(),
      open: (geometrie) => cible.open(geometrie),
      commitRecoveryEnvelope(octets) {
        if (geste === "enveloppe") throw new Error("Coupure simulée : enveloppe.");
        return cible.commitRecoveryEnvelope(octets);
      },
      commitManifest(octets) {
        if (geste === "manifeste") throw new Error("Coupure simulée : manifeste.");
        return cible.commitManifest(octets);
      },
    },
  };
}

test("coupée avant l'enveloppe : le volume n'est PAS déclaré complet", async () => {
  const { archive } = await archiveExportee();
  const destination = magasin();
  const coupee = cibleQuiCoupe(destination, CIBLE, "enveloppe");
  await assert.rejects(
    importArchive({
      source: sourceDArchive(archive),
      target: coupee.cible,
      expectations: ATTENTES,
    }),
    /Coupure simulée/,
  );
  assert.equal(destination.lire(`${CIBLE}.manifest`), null, "aucun manifeste : volume non identifié");
  assert.equal(destination.lire(`${CIBLE}.cles`), null);
});

test("coupée avant le manifeste : l'enveloppe est là, le manifeste non — jamais l'inverse", async () => {
  const { archive } = await archiveExportee();
  const destination = magasin();
  const coupee = cibleQuiCoupe(destination, CIBLE, "manifeste");
  await assert.rejects(
    importArchive({
      source: sourceDArchive(archive),
      target: coupee.cible,
      expectations: ATTENTES,
    }),
    /Coupure simulée/,
  );
  assert.notEqual(destination.lire(`${CIBLE}.cles`), null, "l'enveloppe précède le manifeste");
  assert.equal(destination.lire(`${CIBLE}.manifest`), null);
  assert.deepEqual(coupee.gestes, ["revoque-manifeste", "ecrit:.cles"]);
});

test("une archive plus ANCIENNE que la feuille exige un consentement NOMMÉ", async () => {
  const { archive, recuperation } = await archiveExportee();
  const feuille = recuperation.version + 3;

  const destination = magasin();
  const { cible, gestes } = cibleDe(destination, CIBLE);
  await assert.rejects(
    importArchive({
      source: sourceDArchive(archive),
      target: cible,
      expectations: ATTENTES,
      versionMinimale: feuille,
    }),
    (erreur) => {
      assert.ok(isImportError(erreur, IMPORT_ERROR_CODES.consentementRequis));
      assert.match(erreur.message, /révocation/);
      assert.equal(erreur.context.envelopeVersion, recuperation.version);
      assert.equal(erreur.context.versionMinimale, feuille);
      return true;
    },
  );
  assert.deepEqual(gestes, [], "rien n'est mué tant que le consentement manque");
});

test("consentement donné : la restauration aboutit, et la version restaurée devient la référence", async () => {
  const { archive, recuperation } = await archiveExportee();
  const feuille = recuperation.version + 3;
  const destination = magasin();
  const { cible } = cibleDe(destination, CIBLE);
  const rapport = await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: ATTENTES,
    versionMinimale: feuille,
    consent: { acknowledgedBy: "exploitant de l'épreuve", reason: "sauvegarde antérieure assumée" },
  });

  assert.equal(rapport.restored, true);
  assert.equal(rapport.consentement.acknowledgedBy, "exploitant de l'épreuve");
  assert.equal(
    rapport.nouvelleReference,
    recuperation.version,
    "la feuille est à re-noter : c'est la version restaurée qui fait référence",
  );
});

test("une feuille au niveau de l'archive, ou en deçà, ne demande aucun consentement", async () => {
  const { archive, recuperation } = await archiveExportee();
  const destination = magasin();
  const { cible } = cibleDe(destination, CIBLE);
  const rapport = await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: ATTENTES,
    versionMinimale: recuperation.version,
  });
  assert.equal(rapport.restored, true);
  assert.equal(rapport.consentement, null);
  assert.equal(rapport.nouvelleReference, recuperation.version);
});

test("un consentement ANONYME n'en est pas un", async () => {
  const { archive, recuperation } = await archiveExportee();
  const destination = magasin();
  const { cible } = cibleDe(destination, CIBLE);
  await assert.rejects(
    importArchive({
      source: sourceDArchive(archive),
      target: cible,
      expectations: ATTENTES,
      versionMinimale: recuperation.version + 1,
      consent: { acknowledgedBy: "   " },
    }),
    (erreur) => isImportError(erreur, IMPORT_ERROR_CODES.consentementRequis),
  );
});
