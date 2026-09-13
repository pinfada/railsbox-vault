/**
 * Les DÉCISIONS de portabilité de la coquille, et la dérogation d'archive du contrat (#207, ADR 0039).
 *
 * Fonctions pures, primitives injectées : ce que `tools/muter-gardes-coquille.mjs` mute se mesure ici.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAMP_DE_L_ARCHIVE,
  TYPES_PRIVILEGIES,
  enveloppeDeMessage,
  enveloppePrivilegiee,
} from "../../src/coquille/contrat-de-messages.mjs";
import {
  IDENTIFIANT_DU_COFFRE,
  IDENTIFIANT_DU_VOLUME_COQUILLE,
} from "../../src/coquille/identites-du-coffre.mjs";
import {
  ETATS_DE_L_EMPLACEMENT,
  bilanDeRevocation,
  cibleDuCoffre,
  constaterLEmplacement,
  decisionDeRestauration,
  enTeteDArchive,
  refusDOuverture,
  refusPendantUnGesteLong,
} from "../../src/coquille/portabilite-du-coffre.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import { manifestSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { EN_TETE_OCTETS } from "../../src/vm/volume-chiffre-format.mjs";
import { parseManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import { identifiantDeVolume } from "./support-enveloppe-double.mjs";
import {
  KEK,
  installerLeDisque,
  magasin,
  poserLEnveloppe,
  poserLeVolumeCoquille,
} from "./support-coffre-de-la-coquille.mjs";
import { DEK, sourceDuVolume } from "./support-archive-recuperation.mjs";

function primitives(banc) {
  return {
    observer: banc.stat,
    lireEnTete: async (nom) =>
      banc.store.sizeOf(nom) > 0 ? banc.store.snapshot(nom).subarray(0, EN_TETE_OCTETS) : null,
    lireVoisin: async (nom) => banc.lire(nom),
  };
}

const constater = (banc) => constaterLEmplacement(primitives(banc));

test("un emplacement VIDE est vide, et un coffre de cette version est un coffre", async () => {
  const banc = magasin();
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.vide);
  await installerLeDisque(banc);
  await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.coffre);
});

test("un coffre créé par la coquille d'AVANT est reconnu à son volume coquille", async () => {
  const banc = magasin();
  await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_COFFRE);
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.anterieur);
});

test("un coffre d'AVANT est aussi reconnu au manifeste de son disque, tiré sous une autre identité", async () => {
  const banc = magasin();
  await installerLeDisque(banc);
  await poserLEnveloppe(banc);
  const manifeste = parseManifest(banc.lire(manifestSidecarName("application")));
  const ancien = { ...manifeste, volume: { ...manifeste.volume, id: identifiantDeVolume(0x33) } };
  await banc.ecrire(manifestSidecarName("application"), serializeManifest(ancien));
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.anterieur);
});

test("une restauration COUPÉE est reconnue, et une installation coupée ne l'est PAS", async () => {
  // Disque sans enveloppe ni manifeste : coupée avant l'enveloppe.
  const avantLEnveloppe = magasin();
  await installerLeDisque(avantLEnveloppe);
  await avantLEnveloppe.retirer(manifestSidecarName("application"));
  assert.equal(await constater(avantLEnveloppe), ETATS_DE_L_EMPLACEMENT.restaurationInterrompue);

  // Disque sans manifeste, enveloppe du domaine `enveloppe` : c'est une INSTALLATION coupée, que la
  // reprise de #173 connaît. La portabilité ne la réclame pas.
  const installation = magasin();
  await installerLeDisque(installation);
  await installation.retirer(manifestSidecarName("application"));
  await poserLEnveloppe(installation);
  assert.equal(await constater(installation), ETATS_DE_L_EMPLACEMENT.coffre);

  // Disque sans manifeste, enveloppe du domaine `recuperation` : la page d'une archive, jamais mutée.
  const apresLEnveloppe = magasin();
  await installerLeDisque(apresLEnveloppe);
  const { support } = await poserLEnveloppe(magasin());
  const page = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  const fichier = new Uint8Array(4 * page.octets.byteLength);
  fichier.set(page.octets, 0);
  await apresLEnveloppe.ecrire("coquille.cles", fichier);
  await apresLEnveloppe.retirer(manifestSidecarName("application"));
  assert.equal(await constater(apresLEnveloppe), ETATS_DE_L_EMPLACEMENT.restaurationInterrompue);
});

test("ce que l'ouverture et la restauration font de chaque état", () => {
  const E = ETATS_DE_L_EMPLACEMENT;
  assert.equal(refusDOuverture(E.vide), null);
  assert.equal(refusDOuverture(E.coffre), null);
  assert.equal(refusDOuverture(E.anterieur), CODES_REFUS_COQUILLE.coffreAnterieur);
  assert.equal(
    refusDOuverture(E.restaurationInterrompue),
    CODES_REFUS_COQUILLE.restaurationInterrompue,
  );
  assert.deepEqual(decisionDeRestauration(E.vide), { code: null, reparer: false });
  assert.deepEqual(decisionDeRestauration(E.restaurationInterrompue), {
    code: null,
    reparer: true,
  });
  assert.deepEqual(decisionDeRestauration(E.coffre), {
    code: CODES_REFUS_COQUILLE.emplacementOccupe,
    reparer: false,
  });
  assert.deepEqual(decisionDeRestauration(E.anterieur), {
    code: CODES_REFUS_COQUILLE.coffreAnterieur,
    reparer: false,
  });
});

test("pendant un geste long, seuls les gestes de portabilité sont refusés", () => {
  assert.equal(refusPendantUnGesteLong(TYPES_PRIVILEGIES.revoquerEnUrgence, 0), null);
  assert.equal(
    refusPendantUnGesteLong(TYPES_PRIVILEGIES.revoquerEnUrgence, 1),
    CODES_REFUS_COQUILLE.gesteEnCours,
  );
  assert.equal(refusPendantUnGesteLong(TYPES_PRIVILEGIES.inventaire, 3), null);
});

test("l'en-tête d'une archive dit si elle emporte une récupération, et ne devine rien d'illisible", async () => {
  const banc = magasin();
  await installerLeDisque(banc);
  const { support } = await poserLEnveloppe(banc);
  const manifest = parseManifest(banc.lire(manifestSidecarName("application")));
  const ecrire = async (recovery) =>
    (
      await exportVolumeToBytes({
        source: sourceDuVolume(banc, "application"),
        manifest,
        consistency: { kind: "handle-exclusif" },
        cle: DEK,
        recovery,
      })
    ).archive;
  const recovery = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  assert.deepEqual(enTeteDArchive(await ecrire(recovery)), {
    lisible: true,
    emporteUneRecuperation: true,
  });
  assert.deepEqual(enTeteDArchive(await ecrire(null)), {
    lisible: true,
    emporteUneRecuperation: false,
  });
  const illisible = { lisible: false, emporteUneRecuperation: false };
  assert.deepEqual(enTeteDArchive(new Uint8Array(64)), illisible);
  assert.deepEqual(enTeteDArchive((await ecrire(recovery)).subarray(0, 40)), illisible);
});

test("la cible du coffre pose l'enveloppe là où le Worker la lit, et refuse une archive qui n'en porte pas", async () => {
  const ecrites = [];
  const base = { commitRecoveryEnvelope: async () => ecrites.push("a-cote-du-disque"), open: 1 };
  const cible = cibleDuCoffre(base, { ecrireLEnveloppe: async (octets) => ecrites.push(octets) });
  assert.equal(cible.open, 1, "les autres gestes de la cible sont ceux de createOpfsImportTarget");
  const page = new Uint8Array([1, 2, 3]);
  await cible.commitRecoveryEnvelope(page);
  assert.deepEqual(ecrites, [page]);
  await assert.rejects(cible.commitRecoveryEnvelope(null), {
    code: CODES_REFUS_COQUILLE.archiveSansRecuperation,
  });
});

test("le bilan d'une révocation porte des noms et des nombres, et compte juste", () => {
  const bilan = bilanDeRevocation({
    avant: { emplacements: [{ typeKek: 1 }, { typeKek: 2 }, { typeKek: 4 }, { typeKek: 1 }] },
    apres: { version: 9, emplacements: [{ typeKek: 4 }] },
  });
  assert.deepEqual(bilan, {
    versionEnveloppe: 9,
    restants: { recuperation: 1 },
    retires: { phrase: 2, "webauthn-prf": 1 },
    nombreRetires: 3,
    nombreRestants: 1,
  });
});

test("une ARCHIVE franchit le canal privilégié sur deux types, et nulle part ailleurs", () => {
  const archive = new File([new Uint8Array(8)], "coffre.rbvault");
  for (const type of [TYPES_PRIVILEGIES.sauvegarderReponse, TYPES_PRIVILEGIES.restaurer]) {
    assert.equal(
      enveloppePrivilegiee(type, { [CHAMP_DE_L_ARCHIVE]: archive })[CHAMP_DE_L_ARCHIVE],
      archive,
    );
    assert.ok(enveloppePrivilegiee(type, { [CHAMP_DE_L_ARCHIVE]: new Blob(["x"]) }));
  }
  const capacite = { code: CODES_REFUS_COQUILLE.capaciteDansUnMessage };
  // Sur un autre type du canal privilégié : refusée.
  assert.throws(
    () => enveloppePrivilegiee(TYPES_PRIVILEGIES.etatReponse, { [CHAMP_DE_L_ARCHIVE]: archive }),
    capacite,
  );
  // Sous un autre constructeur : refusée, même sur le bon type.
  assert.throws(
    () =>
      enveloppePrivilegiee(TYPES_PRIVILEGIES.restaurer, {
        [CHAMP_DE_L_ARCHIVE]: new Uint8Array(8).buffer,
      }),
    capacite,
  );
  // Sous un autre NOM de champ : refusée, `sansCapacite` s'applique.
  assert.throws(
    () => enveloppePrivilegiee(TYPES_PRIVILEGIES.restaurer, { fichier: archive }),
    capacite,
  );
  // Hors du canal privilégié : `enveloppeDeMessage` n'a aucune dérogation.
  assert.throws(() => enveloppeDeMessage(TYPES_PRIVILEGIES.restaurer, { archive }), capacite);
});
