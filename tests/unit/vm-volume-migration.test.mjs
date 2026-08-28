import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { VolumeChiffre } from "../../src/vm/volume-chiffre.mjs";
import { dispositionV3, tailleSupportV3 } from "../../src/vm/volume-chiffre-format.mjs";
import { createFaultPlan, FAULT_KINDS } from "../../src/vm/fault-plan.mjs";
import { MANIFEST_ERROR_CODES, isManifestError } from "../../src/vm/manifest-errors.mjs";
import { MIGRATION_ERROR_CODES, isMigrationError } from "../../src/vm/migration-errors.mjs";
import { CONSISTENCY_KINDS, exportVolumeToBytes } from "../../src/vm/volume-export.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  parseManifest,
  serializeManifest,
  MIN_WRITER_FORMAT_VERSION,
} from "../../src/vm/volume-manifest.mjs";
import {
  MIGRATION_JOURNAL_MAGIC,
  MIGRATION_JOURNAL_VERSION,
  migrateVolume,
  planMigration,
} from "../../src/vm/volume-migration.mjs";

// Preuve unitaire des MIGRATIONS DE FORMAT et du REFUS DE DOWNGRADE (#13, `VAULT-COMPAT-001`).
//
// Elle éprouve l'ORDRE des gestes, qui est le contrat (ADR 0011), avec des doubles déterministes :
// aucun OPFS, aucun navigateur, aucune VM. Ce que la suite exige, geste par geste : la sauvegarde
// contrôlée AVANT toute mutation, le journal de reprise inscrit avant la révocation, le manifeste
// cible inscrit en DERNIER et relu depuis le support, et — à chaque point de rupture — un volume
// qui reste NON IDENTIFIÉ plutôt que présenté comme valide à moitié.

const TAILLE = SECTOR_SIZE * 8;
const APP = { id: "railsbox/reference", version: "3.1.0" };

/** Manifeste v1 d'un volume : le format que ce dépôt sait encore lire, mais plus écrire. */
function manifesteV1(surcharge = {}) {
  return createManifest({
    formatVersion: 1,
    runtime: { version: "1.4.2", artifact: null },
    app: APP,
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    ...surcharge,
  });
}

/**
 * Format que la CHAÎNE sait réellement atteindre aujourd'hui.
 *
 * Le format COURANT du runtime est v3 (#18), mais l'étape v2 → v3 est DÉCLARÉE sans être
 * exécutable : elle doit agrandir le fichier et rechiffrer chaque secteur, ce qu'une cible à
 * géométrie fixe ne sait pas faire. L'épreuve « l'étape v3 est déclarée » le tient ; les
 * épreuves d'ORDRE et de REPRISE ci-dessous portent, elles, sur le palier atteignable — sans quoi
 * elles mesureraient le refus au lieu du protocole.
 */
const CIBLE = MIN_WRITER_FORMAT_VERSION;

/** Manifeste au palier atteignable, tel que la migration doit finir par l'inscrire. */
function manifesteCourant(surcharge = {}) {
  return createManifest({
    formatVersion: CIBLE,
    runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
    app: APP,
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    ...surcharge,
  });
}

/**
 * Attentes du runtime en cours : celles que le boot fournit à l'ouverture en écriture.
 *
 * `supportedFormat` y borne la cible au palier atteignable, exactement comme un runtime plus ancien
 * le ferait. Ce n'est pas un contournement : `migrateVolume` prend sa version cible de là.
 */
function attentes(surcharge = {}) {
  return {
    runtime: { version: "1.4.2", artifact: null },
    app: { id: APP.id },
    supportedFormat: { current: CIBLE, minReadable: 1 },
    ...surcharge,
  };
}

/** Contenu déterministe d'un volume : la migration ne doit pas en changer un octet. */
function contenu() {
  const octets = new Uint8Array(TAILLE);
  for (let i = 0; i < TAILLE; i += 1) octets[i] = (i * 7 + 3) & 0xff;
  return octets;
}

/**
 * Cible de migration EN MÉMOIRE. Elle journalise chaque geste dans l'ordre : c'est ce qui permet
 * d'affirmer non pas « la migration a échoué » mais « la cible n'a même pas été ouverte ».
 * `faults` injecte une panne dans les E/S du volume ; les deux autres coupent la migration à un
 * geste NOMMÉ, et ils ne décrivent pas le même sinistre :
 *
 * - `pannes` coupe AVANT l'effet du geste — rien n'a été modifié sur le support ;
 * - `apres` coupe APRÈS : le geste a porté, PUIS la migration s'arrête. C'est ce qu'un onglet fermé
 *   laisse derrière lui, et c'est ce que `interrompreApres` injecte dans
 *   `public/vm/reference-worker.mjs`. Sans ce second mode, la matrice de pannes unitaire ne dirait
 *   rien de la moitié des états réellement atteignables.
 */
function creerCible({
  volume = contenu(),
  manifestBytes = serializeManifest(manifesteV1()),
  journalBytes = null,
  pannes = {},
  apres = {},
  faults = createFaultPlan(),
  couperEcritureApres = null,
} = {}) {
  /** Coupure d'écriture du VOLUME, mutable : l'épreuve coupe, puis désarme pour reprendre. */
  const coupure = { apres: couperEcritureApres, ecritures: 0 };
  const etat = {
    manifestBytes,
    journalBytes,
    ouvertures: 0,
    fermetures: 0,
    /** Les octets du volume, tels qu'ils sont MAINTENANT : le retaillage remplace le tampon. */
    get volume() {
      return volume;
    },
  };
  const gestes = [];
  const trace = (nom) => {
    gestes.push(nom);
    if (pannes[nom]) throw pannes[nom];
  };
  const puisEchouer = (nom) => {
    if (apres[nom]) throw apres[nom];
  };

  // Le backend rendu par la cible a la forme d'un ACCÈS BRUT (`opfs-volume-brut.mjs`) : une
  // migration travaille sur le FICHIER, et depuis #101 elle l'écrit et le retaille. Les deux gestes
  // manquaient tant qu'aucune étape ne touchait un octet.
  const backend = {
    name: "cible",
    size: () => volume.byteLength,
    async read(offset, length) {
      const faute = faults.consume("read");
      const rendus = faute?.kind === FAULT_KINDS.shortRead ? (faute.bytes ?? 0) : length;
      return volume.slice(offset, offset + rendus);
    },
    async write(offset, octets) {
      coupure.ecritures += 1;
      // Une coupure PENDANT la conversion : le support garde ce qui a été écrit avant, et rien de
      // plus. C'est ce qu'une mort d'onglet laisse, et le seul état sur lequel une reprise se juge.
      if (coupure.apres !== null && coupure.ecritures > coupure.apres) {
        throw new Error(`coupure programmée à la ${coupure.ecritures}e écriture du volume`);
      }
      volume.set(octets, offset);
    },
    async retailler(taille) {
      const neuf = new Uint8Array(taille);
      neuf.set(volume.subarray(0, Math.min(taille, volume.byteLength)));
      volume = neuf;
    },
    async flush() {
      trace("flush");
      puisEchouer("flush");
    },
    async close() {
      etat.fermetures += 1;
      gestes.push("close");
      puisEchouer("close");
    },
  };

  return {
    gestes,
    etat,
    /** Écritures du volume acceptées depuis la construction. */
    get ecrituresVolume() {
      return coupure.ecritures;
    },
    /** Arme ou désarme la coupure d'écriture. `null` désarme, ce que fait une reprise. */
    armerCoupure(apres) {
      coupure.apres = apres;
    },
    async inspect() {
      trace("inspect");
      return { present: true, size: volume.byteLength };
    },
    async readManifest() {
      trace("read-manifest");
      return etat.manifestBytes;
    },
    async readJournal() {
      trace("read-journal");
      return etat.journalBytes;
    },
    async open() {
      trace("open");
      etat.ouvertures += 1;
      return backend;
    },
    async writeJournal(bytes) {
      trace("write-journal");
      etat.journalBytes = bytes;
      puisEchouer("write-journal");
    },
    async revokeManifest() {
      trace("revoke");
      etat.manifestBytes = null;
      puisEchouer("revoke");
    },
    async commitManifest(bytes) {
      trace("commit");
      etat.manifestBytes = bytes;
      puisEchouer("commit");
    },
    async removeJournal() {
      trace("remove-journal");
      etat.journalBytes = null;
      puisEchouer("remove-journal");
    },
  };
}

/** Archive de sauvegarde du volume, telle que #11 la produit — la preuve que la migration exige. */
async function sauvegardeDe(octets, manifest = manifesteV1()) {
  const source = {
    size: octets.byteLength,
    read: (offset, length) => octets.slice(offset, offset + length),
  };
  const { archive } = await exportVolumeToBytes({
    source,
    manifest,
    consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "double déterministe" },
  });
  return { byteLength: archive.byteLength, read: (o, l) => archive.slice(o, o + l) };
}

const CONSENTEMENT = { acknowledgedBy: "exploitant-de-test", reason: "épreuve unitaire" };

// --- Chaîne de migrations ----------------------------------------------------------------------

test("la chaîne va d'un format au suivant, un PAS à la fois, jamais par saut arbitraire", () => {
  const chaine = planMigration(1, MANIFEST_FORMAT_VERSION);
  assert.equal(chaine.length, MANIFEST_FORMAT_VERSION - 1);
  chaine.forEach((etape, rang) => {
    assert.equal(etape.from, 1 + rang);
    assert.equal(etape.to, 2 + rang);
  });
});

test("migrer vers le format déjà porté rend une chaîne VIDE", () => {
  assert.deepEqual(planMigration(MANIFEST_FORMAT_VERSION, MANIFEST_FORMAT_VERSION), []);
});

test("un format cible sans étape enregistrée est refusé, jamais deviné", () => {
  assert.throws(
    () => planMigration(1, MANIFEST_FORMAT_VERSION + 5),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.noPath),
  );
});

test("revenir à un format antérieur est refusé : une migration ne descend pas", () => {
  assert.throws(
    () => planMigration(MANIFEST_FORMAT_VERSION, 1),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.downgradeRefused),
  );
});

// --- Migration nominale ------------------------------------------------------------------------

test("la migration inscrit le manifeste cible EN DERNIER, après le journal et la révocation", async () => {
  const cible = creerCible();
  const rapport = await migrateVolume({
    target: cible,
    expectations: attentes(),
    consent: CONSENTEMENT,
  });

  assert.equal(rapport.migrated, true);
  assert.equal(rapport.fromVersion, 1);
  assert.equal(rapport.toVersion, CIBLE);
  // L'ordre EST le contrat, et il n'est énoncé qu'à UN endroit : l'ADR 0011 (« Ordre des gestes »),
  // dont l'en-tête de `src/vm/volume-migration.mjs` est la transcription. La liste ci-dessous n'en
  // est pas une seconde définition : c'est la TRACE que cet ordre laisse sur la cible.
  assert.deepEqual(cible.gestes, [
    "inspect",
    "read-journal",
    "read-manifest",
    "open",
    "write-journal",
    "revoke",
    "flush",
    "commit",
    "read-manifest",
    "close",
    "remove-journal",
  ]);
  assert.equal(cible.etat.journalBytes, null, "le journal est retiré en dernier geste");
  const inscrit = parseManifest(cible.etat.manifestBytes);
  assert.equal(inscrit.formatVersion, CIBLE);
  assert.equal(inscrit.app.id, APP.id);
  assert.equal(inscrit.geometry.volumeSize, TAILLE);
});

test("la migration v1 → v2 traduit la règle de downgrade v1 en une déclaration portée par le volume", async () => {
  const cible = creerCible({
    manifestBytes: serializeManifest(
      manifesteV1({ runtime: { version: "2.7.3", artifact: null } }),
    ),
  });
  await migrateVolume({
    target: cible,
    expectations: attentes({ runtime: { version: "2.7.3", artifact: null } }),
    consent: CONSENTEMENT,
  });

  // v1 refusait l'écriture à un runtime de MAJEUR inférieur : le plus ancien écrivain admis était
  // donc « ce majeur, minimal ». v2 l'inscrit au lieu de le redevenir à chaque ouverture.
  const inscrit = parseManifest(cible.etat.manifestBytes);
  assert.equal(inscrit.runtime.minWriter, "2.0.0");
  assert.equal(inscrit.runtime.version, "2.7.3");
});

test("la migration ne touche AUCUN octet du volume et rend le handle exclusif", async () => {
  const octets = contenu();
  const cible = creerCible({ volume: octets });
  await migrateVolume({ target: cible, expectations: attentes(), consent: CONSENTEMENT });
  assert.deepEqual(octets, contenu());
  assert.equal(cible.etat.fermetures, 1);
});

test("migrer un volume DÉJÀ au format courant ne mute rien (idempotence)", async () => {
  const cible = creerCible({ manifestBytes: serializeManifest(manifesteCourant()) });
  const rapport = await migrateVolume({
    target: cible,
    expectations: attentes(),
    consent: CONSENTEMENT,
  });
  assert.equal(rapport.migrated, false);
  assert.equal(rapport.fromVersion, CIBLE);
  assert.deepEqual(cible.gestes, ["inspect", "read-journal", "read-manifest"]);
});

// --- Sauvegarde obligatoire --------------------------------------------------------------------

test("sans sauvegarde vérifiée ni consentement nommé, la migration est refusée SANS ouvrir la cible", async () => {
  const cible = creerCible();
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes() }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.backupRequired),
  );
  assert.ok(!cible.gestes.includes("open"), "la cible n'est même pas ouverte");
  assert.notEqual(cible.etat.manifestBytes, null, "le manifeste du volume reste intact");
});

test("une archive de sauvegarde est VÉRIFIÉE contre le volume, pas seulement annoncée", async () => {
  const octets = contenu();
  const cible = creerCible({ volume: octets });
  const rapport = await migrateVolume({
    target: cible,
    expectations: attentes(),
    backup: { source: await sauvegardeDe(octets) },
  });
  assert.equal(rapport.migrated, true);
  assert.equal(rapport.evidence.kind, "sauvegarde-verifiee");
  assert.match(rapport.evidence.contentDigest, /^[0-9a-f]{64}$/);
});

test("une archive qui ne décrit PAS l'état courant du volume est refusée avant toute mutation", async () => {
  const autre = contenu();
  autre[0] ^= 0xff;
  const cible = creerCible();
  const backup = { source: await sauvegardeDe(autre) };
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes(), backup }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.backupMismatch),
  );
  assert.ok(!cible.gestes.includes("revoke"), "aucune révocation");
  assert.notEqual(cible.etat.manifestBytes, null);
  assert.equal(cible.etat.fermetures, 1, "le handle pris pour la vérification est rendu");
});

test("une lecture COURTE pendant la vérification de sauvegarde ne rend jamais un verdict conforme", async () => {
  const octets = contenu();
  const cible = creerCible({
    volume: octets,
    faults: createFaultPlan([
      { kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1, bytes: 512 },
    ]),
  });
  const backup = { source: await sauvegardeDe(octets) };
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes(), backup }),
    (e) => e instanceof TypeError || isMigrationError(e, MIGRATION_ERROR_CODES.backupMismatch),
  );
  assert.notEqual(cible.etat.manifestBytes, null, "le volume reste identifié");
});

// --- Refus propagés de #10 ---------------------------------------------------------------------

test("un volume sans manifeste n'est pas migré : il est NON IDENTIFIÉ", async () => {
  const cible = creerCible({ manifestBytes: null });
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes(), consent: CONSENTEMENT }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.unidentified),
  );
  assert.ok(!cible.gestes.includes("open"));
});

test("un volume d'une AUTRE application est refusé, le refus de #10 remonte tel quel", async () => {
  const cible = creerCible();
  await assert.rejects(
    () =>
      migrateVolume({
        target: cible,
        expectations: attentes({ app: { id: "autre/app" } }),
        consent: CONSENTEMENT,
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.identityMismatch),
  );
  assert.ok(!cible.gestes.includes("revoke"));
});

test("un runtime qui ne connaît que le format 1 refuse un volume v2, en lecture comme en écriture", async () => {
  const cible = creerCible({ manifestBytes: serializeManifest(manifesteCourant()) });
  await assert.rejects(
    () =>
      migrateVolume({
        target: cible,
        expectations: attentes({ supportedFormat: { current: 1, minReadable: 1 } }),
        consent: CONSENTEMENT,
      }),
    (e) => isManifestError(e, MANIFEST_ERROR_CODES.formatTooNew),
  );
  assert.ok(!cible.gestes.includes("open"), "un format futur n'est même pas ouvert");
  assert.notEqual(cible.etat.manifestBytes, null);
});

// --- Défaillance en cours de migration ---------------------------------------------------------

/**
 * Chaque point de rupture, et l'état que la migration doit laisser derrière elle. `identifie` dit
 * si le volume reste ouvrable en écriture ; `journal` si la reprise est possible.
 */
const POINTS = [
  { geste: "open", description: "ouverture de la cible", identifie: true, journal: false },
  {
    geste: "write-journal",
    description: "inscription du journal de reprise",
    identifie: true,
    journal: false,
  },
  { geste: "revoke", description: "révocation du manifeste", identifie: true, journal: true },
  { geste: "flush", description: "barrière de durabilité", identifie: false, journal: true },
  {
    geste: "commit",
    description: "inscription du manifeste cible",
    identifie: false,
    journal: true,
  },
];

for (const { geste, description, identifie, journal } of POINTS) {
  test(`panne à « ${description} » : le volume n'est jamais présenté comme valide à moitié`, async () => {
    const cible = creerCible({ pannes: { [geste]: new Error(`panne injectée : ${geste}`) } });
    await assert.rejects(() =>
      migrateVolume({ target: cible, expectations: attentes(), consent: CONSENTEMENT }),
    );

    if (geste === "open") {
      assert.equal(cible.etat.fermetures, 0, "aucun handle n'a été pris");
    } else {
      assert.equal(cible.etat.fermetures, 1, "le handle exclusif est rendu quoi qu'il arrive");
    }
    assert.equal(
      cible.etat.manifestBytes !== null,
      identifie,
      identifie
        ? "aucun octet n'a pu être muté : le volume reste identifié"
        : "le volume reste NON IDENTIFIÉ, donc refusé au boot suivant",
    );
    assert.equal(cible.etat.journalBytes !== null, journal, "état du journal de reprise");
  });
}

// --- Défaillance APRÈS l'effet du geste ---------------------------------------------------------
//
// Les cinq points ci-dessus coupent AVANT l'effet : le geste n'a rien modifié. Un onglet fermé
// laisse l'état INVERSE — le geste a porté, puis plus rien n'est exécuté. Ces trois épreuves
// couvrent les ruptures où ce second mode produit un état que le premier n'atteint jamais.

test("panne APRÈS l'inscription du journal : le journal subsiste alors que le manifeste est intact", async () => {
  // État qu'une interruption entre le geste 6 et le geste 7 laisse : journal ET manifeste source,
  // qui doivent coïncider octet pour octet. C'est le cas nominal que `manifesteSource` autorise, et
  // aucune panne coupant AVANT l'effet ne le produit.
  const cible = creerCible({ apres: { "write-journal": new Error("onglet fermé") } });
  await assert.rejects(() =>
    migrateVolume({ target: cible, expectations: attentes(), consent: CONSENTEMENT }),
  );

  assert.equal(parseManifest(cible.etat.manifestBytes).formatVersion, 1, "le volume reste v1");
  assert.notEqual(
    cible.etat.journalBytes,
    null,
    "le journal est inscrit : la reprise est possible",
  );
  assert.equal(cible.etat.fermetures, 1, "le handle exclusif est rendu");
  assert.ok(!cible.gestes.includes("revoke"), "la révocation n'a pas été franchie");
});

test("la reprise CONSTATE un manifeste cible déjà inscrit mais jamais relu, et aboutit", async () => {
  // Le manifeste cible est sur le support ; l'onglet s'est fermé avant sa relecture. Rien ne
  // distingue cet état de celui d'une migration aboutie dont le dernier geste n'a pas été franchi :
  // la reprise doit le constater, retirer le journal et rendre la main — ni repartir de zéro (elle
  // redemanderait une preuve qu'elle n'a plus), ni refuser (le volume est valide).
  const interrompue = creerCible({ apres: { commit: new Error("onglet fermé") } });
  await assert.rejects(() =>
    migrateVolume({ target: interrompue, expectations: attentes(), consent: CONSENTEMENT }),
  );
  assert.equal(
    parseManifest(interrompue.etat.manifestBytes).formatVersion,
    CIBLE,
    "le manifeste cible EST sur le support",
  );
  assert.ok(!interrompue.gestes.includes("remove-journal"), "le journal n'a pas été retiré");

  const reprise = creerCible({
    manifestBytes: interrompue.etat.manifestBytes,
    journalBytes: interrompue.etat.journalBytes,
  });
  const rapport = await migrateVolume({ target: reprise, expectations: attentes() });
  assert.equal(rapport.migrated, false, "il n'y a plus rien à migrer");
  assert.equal(rapport.resumed, true);
  assert.equal(rapport.fromVersion, CIBLE);
  assert.equal(reprise.etat.journalBytes, null, "le dernier geste est franchi");
  assert.equal(reprise.etat.ouvertures, 0, "rien n'est rouvert : aucun octet n'est à muter");
});

test("une fermeture qui rate ne REMPLACE pas l'erreur qui a fait échouer la migration", async () => {
  const origine = new Error("panne injectée : barrière de durabilité");
  const fermeture = new Error("fermeture impossible : le handle est perdu");
  const cible = creerCible({ pannes: { flush: origine }, apres: { close: fermeture } });

  const rejet = await migrateVolume({
    target: cible,
    expectations: attentes(),
    consent: CONSENTEMENT,
  }).then(
    () => null,
    (echec) => echec,
  );

  // Le diagnostic rendu reste celui de ce qui a fait échouer la migration. La fermeture ratée est
  // une CIRCONSTANCE : elle est jointe en `cause`, jamais substituée — sinon l'exploitant lirait
  // « fermeture impossible » là où le volume a été laissé NON IDENTIFIÉ par la barrière, et le
  // remède (reprendre depuis le journal) ne se déduirait plus du message.
  assert.equal(rejet, origine, "l'erreur d'origine est celle qui remonte");
  assert.equal(rejet.cause, fermeture, "la fermeture ratée n'est pas perdue pour autant");
  assert.equal(cible.etat.fermetures, 1, "la fermeture a bien été tentée");
  assert.equal(cible.etat.manifestBytes, null, "le volume reste NON IDENTIFIÉ");
  assert.notEqual(cible.etat.journalBytes, null, "la reprise reste possible");
});

test("une fermeture qui rate SEULE fait échouer la migration : le journal n'est pas retiré", async () => {
  // Tout a abouti sauf la restitution du handle. Rendre « migré » ici serait affirmer un état que
  // personne n'a pu constater : le journal subsiste, et la reprise le retirera après relecture.
  const fermeture = new Error("fermeture impossible : le handle est perdu");
  const cible = creerCible({ apres: { close: fermeture } });
  const rejet = await migrateVolume({
    target: cible,
    expectations: attentes(),
    consent: CONSENTEMENT,
  }).then(
    () => null,
    (echec) => echec,
  );

  assert.equal(rejet, fermeture);
  assert.notEqual(cible.etat.journalBytes, null, "le dernier geste n'est pas franchi");
  assert.ok(!cible.gestes.includes("remove-journal"));
});

test("un manifeste relu qui diffère de l'inscrit laisse le volume non identifié", async () => {
  const cible = creerCible();
  const commitOriginal = cible.commitManifest.bind(cible);
  cible.commitManifest = async (bytes) => {
    await commitOriginal(bytes);
    // Le support n'a retenu qu'une partie des octets : écrire n'est pas persister.
    cible.etat.manifestBytes = bytes.slice(0, bytes.byteLength - 3);
  };
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes(), consent: CONSENTEMENT }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.verificationFailed),
  );
  assert.equal(cible.etat.manifestBytes, null, "un manifeste non relu est retiré, pas conservé");
  assert.notEqual(cible.etat.journalBytes, null, "la reprise reste possible");
});

// --- Reprise après interruption ----------------------------------------------------------------

test("la reprise repart du manifeste SOURCE porté par le journal, sans redemander la sauvegarde", async () => {
  // État exact que laisse une migration interrompue après la révocation : plus de manifeste, un
  // journal.
  const interrompue = creerCible({ pannes: { flush: new Error("onglet fermé") } });
  await assert.rejects(() =>
    migrateVolume({ target: interrompue, expectations: attentes(), consent: CONSENTEMENT }),
  );
  assert.equal(interrompue.etat.manifestBytes, null);

  const reprise = creerCible({ manifestBytes: null, journalBytes: interrompue.etat.journalBytes });
  // Aucune preuve de sauvegarde n'est fournie : le journal porte celle qui a été retenue. Exiger
  // une archive au moment de la reprise transformerait une interruption en impasse.
  const rapport = await migrateVolume({ target: reprise, expectations: attentes() });
  assert.equal(rapport.migrated, true);
  assert.equal(rapport.resumed, true);
  assert.equal(rapport.fromVersion, 1);
  assert.equal(parseManifest(reprise.etat.manifestBytes).formatVersion, CIBLE);
  assert.equal(reprise.etat.journalBytes, null);
});

test("un journal laissé derrière un manifeste DÉJÀ migré est simplement retiré", async () => {
  const interrompue = creerCible({ pannes: { "remove-journal": new Error("onglet fermé") } });
  await assert.rejects(() =>
    migrateVolume({ target: interrompue, expectations: attentes(), consent: CONSENTEMENT }),
  );
  assert.notEqual(interrompue.etat.manifestBytes, null, "le manifeste cible EST inscrit");

  const reprise = creerCible({
    manifestBytes: interrompue.etat.manifestBytes,
    journalBytes: interrompue.etat.journalBytes,
  });
  const rapport = await migrateVolume({ target: reprise, expectations: attentes() });
  assert.equal(rapport.migrated, false);
  assert.equal(rapport.resumed, true);
  assert.equal(reprise.etat.journalBytes, null);
  assert.deepEqual(reprise.gestes, ["inspect", "read-journal", "read-manifest", "remove-journal"]);
});

test("un journal illisible est refusé, jamais supprimé ni deviné", async () => {
  const cible = creerCible({ journalBytes: new TextEncoder().encode('{"magic":"autre-chose"}') });
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes(), consent: CONSENTEMENT }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.journalMalformed),
  );
  assert.notEqual(cible.etat.journalBytes, null, "le journal n'est pas effacé");
  assert.ok(!cible.gestes.includes("open"));
});

test("le journal porte son propre marqueur, sa chaîne et la preuve retenue", async () => {
  const interrompue = creerCible({ pannes: { revoke: new Error("panne") } });
  await assert.rejects(() =>
    migrateVolume({ target: interrompue, expectations: attentes(), consent: CONSENTEMENT }),
  );
  const journal = JSON.parse(new TextDecoder().decode(interrompue.etat.journalBytes));
  assert.equal(journal.magic, MIGRATION_JOURNAL_MAGIC);
  assert.equal(journal.from, 1);
  assert.equal(journal.to, CIBLE);
  assert.equal(journal.evidence.kind, "consentement-nomme");
  assert.equal(journal.evidence.acknowledgedBy, CONSENTEMENT.acknowledgedBy);
  assert.equal(parseManifest(journal.sourceManifest).formatVersion, 1);
});

// --- Un journal n'est pas une AUTORITÉ ----------------------------------------------------------
//
// Le journal de reprise est un indice laissé par une migration inachevée, pas une source de vérité
// supérieure au volume. Trois épreuves l'imposent, parce que rien ne garantit qu'un journal trouvé
// à côté d'un volume décrive CE volume : ni `createOpfsImportTarget` (#12) ni la préparation d'un
// volume neuf ne retirent le voisin `.migration`, si bien qu'un journal PÉRIMÉ peut survivre à la
// recréation du volume qu'il prétend décrire.

/** Journal FORGÉ, tel qu'un support pourrait en porter un — périmé, contradictoire ou menteur. */
function journalForge({ from = 1, to = CIBLE, sourceManifest, evidence }) {
  return new TextEncoder().encode(
    JSON.stringify({
      magic: MIGRATION_JOURNAL_MAGIC,
      journalVersion: MIGRATION_JOURNAL_VERSION,
      from,
      to,
      sourceManifest,
      evidence: evidence ?? { kind: "sauvegarde-verifiee", contentDigest: "00".repeat(32) },
    }),
  );
}

test("un journal qui CONTREDIT le manifeste présent est refusé, jamais préféré à lui", async () => {
  // Le volume porte un manifeste v1 parfaitement valide. À côté traîne un journal périmé qui
  // annonce un AUTRE volume — huit fois plus grand, avec une empreinte inventée — et une sauvegarde
  // « vérifiée » qui ne l'a jamais été. Sans contrôle de cohérence, ce journal supplanterait le
  // manifeste ET tiendrait lieu de preuve de sauvegarde : la migration inscrirait une géométrie et
  // une identité forgées, puis effacerait le journal — sans laisser de trace.
  const cible = creerCible({
    journalBytes: journalForge({
      sourceManifest: manifesteV1({
        volumeSize: TAILLE * 8,
        identity: { algorithm: "sha-256", digest: "ab".repeat(32) },
      }),
    }),
  });
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes() }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.journalMalformed),
  );
  // Le volume est INTACT : son manifeste v1 est toujours là, et la cible n'a pas été ouverte.
  assert.equal(parseManifest(cible.etat.manifestBytes).formatVersion, 1);
  assert.equal(cible.etat.ouvertures, 0);
  assert.equal(cible.gestes.includes("open"), false);
  // Le journal n'est pas supprimé : l'écarter reste un geste explicite d'exploitant.
  assert.notEqual(cible.etat.journalBytes, null);
});

test("un manifeste source dont la GÉOMÉTRIE ne décrit pas le support est refusé avant ouverture", async () => {
  // Migration REPRISE : plus de manifeste, seul le journal parle. Il annonce un volume de 32 768 o
  // alors que le support en porte 4 096. Rien ne doit être ouvert : appliquer une étape ici
  // inscrirait une géométrie qui ne décrit pas les octets réellement présents.
  const cible = creerCible({
    manifestBytes: null,
    journalBytes: journalForge({ sourceManifest: manifesteV1({ volumeSize: TAILLE * 8 }) }),
  });
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes() }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.geometryMismatch),
  );
  assert.equal(cible.etat.ouvertures, 0);
  assert.equal(cible.etat.manifestBytes, null);
});

test("un journal dont la cible ne correspond PAS au format porté n'est pas retiré en silence", async () => {
  // Le volume est déjà au format courant. Un journal traîne, mais il visait un autre format : il ne
  // peut pas être le reliquat de la migration qui a produit ce manifeste. Le retirer serait effacer
  // l'indice d'une migration inachevée portant sur autre chose.
  const cible = creerCible({
    manifestBytes: serializeManifest(manifesteCourant()),
    journalBytes: journalForge({
      from: 1,
      to: CIBLE + 3,
      sourceManifest: manifesteV1(),
    }),
  });
  await assert.rejects(
    () => migrateVolume({ target: cible, expectations: attentes() }),
    (e) => isMigrationError(e, MIGRATION_ERROR_CODES.journalMalformed),
  );
  assert.notEqual(cible.etat.journalBytes, null);
  assert.equal(parseManifest(cible.etat.manifestBytes).formatVersion, CIBLE);
});

test("la chaîne 1 → 3 aboutit : le volume est CONVERTI et rend le même clair", async () => {
  // La migration v2 → v3 ne réécrit pas un manifeste, elle réécrit le VOLUME. L'épreuve la fait
  // porter sur un vrai fichier — celui de la cible en mémoire — et la juge sur ce que le chemin de
  // production relit ensuite : le clair d'avant, à l'octet près.
  const octets = contenu();
  const cible = creerCible({ volume: octets });
  const rapport = await migrateVolume({
    target: cible,
    expectations: attentes({
      supportedFormat: { current: MANIFEST_FORMAT_VERSION, minReadable: 1 },
    }),
    consent: CONSENTEMENT,
    cle: CLE_DE_TEST,
  });

  assert.equal(rapport.migrated, true);
  assert.equal(rapport.toVersion, MANIFEST_FORMAT_VERSION);
  assert.equal(rapport.steps.length, 2, "un PAS à la fois : v1 → v2, puis v2 → v3");

  const inscrit = parseManifest(cible.etat.manifestBytes);
  assert.equal(inscrit.formatVersion, MANIFEST_FORMAT_VERSION);
  assert.match(inscrit.volume.id, /^[0-9a-f]{32}$/, "l'identifiant est TIRÉ : un v2 n'en a pas");
  assert.equal(inscrit.geometry.volumeSize, TAILLE, "la géométrie reste LOGIQUE");

  // Le FICHIER, lui, a grandi de sa région d'authentification.
  assert.equal(cible.etat.volume.byteLength, tailleSupportV3(TAILLE));

  // Et le clair relu par le chemin de production est celui d'avant la migration.
  const volume = new VolumeChiffre({
    volume: "migre",
    scellement: await Scellement.ouvrir({
      volume: inscrit.volume.id,
      cleOctets: CLE_DE_TEST,
      formatVersion: 3,
    }),
    disposition: dispositionV3(TAILLE),
    lireSupport: (offset, longueur) => cible.etat.volume.slice(offset, offset + longueur),
    ecrireSupport: () => {
      throw new Error("la relecture n'écrit pas");
    },
  });
  assert.deepEqual([...(await volume.lireSecteurs(0, TAILLE))], [...contenu()]);
});

test("migrer SANS CLÉ est refusé, et le volume reste non identifié plutôt qu'à moitié converti", async () => {
  // Le produit ne fabrique aucune clé de volume avant #21 (ADR 0016, décision 6). Une migration qui
  // en inventerait une chiffrerait le volume sous un secret que personne ne connaît — c'est-à-dire
  // le perdrait. Le refus est typé, et il tombe pendant l'application : le manifeste est déjà
  // révoqué, ce que l'ADR 0011 exige d'une migration interrompue.
  const octets = contenu();
  const cible = creerCible({ volume: octets });
  await assert.rejects(
    () =>
      migrateVolume({
        target: cible,
        expectations: attentes({
          supportedFormat: { current: MANIFEST_FORMAT_VERSION, minReadable: 1 },
        }),
        consent: CONSENTEMENT,
      }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.cleRequise),
  );
  assert.equal(cible.etat.manifestBytes, null, "le volume reste NON IDENTIFIÉ");
  assert.notEqual(cible.etat.journalBytes, null, "le journal de reprise porte le manifeste source");
});

test("une migration v1 → v3 COUPÉE pendant la conversion REPREND, et rend le clair d'origine", async () => {
  // La revue de #110 a trouvé ici un défaut qui rendait toute la machinerie de reprise de
  // `migration-v3.mjs` inatteignable depuis la production : le contrôle de géométrie comparait la
  // taille LOGIQUE du manifeste source à la taille du FICHIER, alors que le premier geste de la
  // conversion agrandit ce fichier de sa région d'authentification. Une migration coupée après la
  // moindre écriture laissait donc un volume au manifeste révoqué, au journal complet — et REFUSÉ
  // à la reprise par `VAULT_MIGRATION_GEOMETRY_MISMATCH` : ni v2, ni v3, ni reprenable.
  //
  // L'épreuve coupe à CHAQUE rang d'écriture du volume et exige, à chaque fois, que la reprise
  // aboutisse et rende le clair d'origine.
  const attendu = contenu();
  const options = (cible) => ({
    target: cible,
    expectations: attentes({
      supportedFormat: { current: MANIFEST_FORMAT_VERSION, minReadable: 1 },
    }),
    consent: CONSENTEMENT,
    cle: CLE_DE_TEST,
  });

  const temoin = creerCible({ volume: contenu() });
  await migrateVolume(options(temoin));
  const ecrituresCompletes = temoin.ecrituresVolume;
  assert.ok(ecrituresCompletes > 2, "une conversion écrit plusieurs fois dans le fichier");

  // Jusqu'à l'AVANT-DERNIÈRE : couper après la dernière écriture n'est pas une coupure.
  for (let rang = 1; rang < ecrituresCompletes; rang += 1) {
    const cible = creerCible({ volume: contenu(), couperEcritureApres: rang });
    await assert.rejects(() => migrateVolume(options(cible)), `coupure au rang ${rang}`);
    assert.equal(cible.etat.manifestBytes, null, `rang ${rang} : le manifeste est révoqué`);
    assert.notEqual(cible.etat.journalBytes, null, `rang ${rang} : le journal de reprise subsiste`);

    cible.armerCoupure(null);
    const rapport = await migrateVolume(options(cible));
    assert.equal(rapport.resumed, true, `rang ${rang} : la reprise repart du journal`);
    assert.equal(rapport.toVersion, MANIFEST_FORMAT_VERSION);

    const inscrit = parseManifest(cible.etat.manifestBytes);
    const volume = new VolumeChiffre({
      volume: "migre",
      scellement: await Scellement.ouvrir({
        volume: inscrit.volume.id,
        cleOctets: CLE_DE_TEST,
        formatVersion: 3,
      }),
      disposition: dispositionV3(TAILLE),
      lireSupport: (offset, longueur) => cible.etat.volume.slice(offset, offset + longueur),
      ecrireSupport: () => {
        throw new Error("la relecture n'écrit pas");
      },
    });
    assert.deepEqual(
      [...(await volume.lireSecteurs(0, TAILLE))],
      [...attendu],
      `rang ${rang} : la reprise doit rendre le clair d'origine`,
    );
  }
});
