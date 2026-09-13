/**
 * UN COFFRE = UNE IDENTITÉ (#207, ADR 0039) — l'épreuve qui a fait naître la décision.
 *
 * Elle rejoue, sur les modules RÉELS et un magasin en mémoire, la topologie du coffre de la coquille :
 * l'enveloppe posée sur le voisin `coquille.cles`, liée à `IDENTIFIANT_DU_COFFRE`, et le disque de
 * Rails installé dans le volume `application` par `installerSiNecessaire` — la fonction de production,
 * avec son choix d'identité et rien d'imposé par l'épreuve.
 *
 * Puis elle fait ce que la tranche promet : archiver le disque en emportant la page de récupération
 * du coffre, restaurer l'archive dans un AUTRE magasin, et rouvrir le volume par le CODE.
 *
 * **Rouge sur le code d'avant l'ADR 0039** : le volume `application` naissait sous un identifiant
 * tiré, la page emportée authentifiait l'identité du coffre, et `importArchive` refusait l'archive
 * par `VAULT_ARCHIVE_RECUPERATION_REFUSEE` (`assertEnveloppeDuMemeVolume`). C'était la sonde du
 * blocage du 13/09/2026 ; elle est gardée ici comme la preuve qu'il était réel et qu'il est levé.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  descripteurDeManifeste,
  installerSiNecessaire,
} from "../../src/coquille/application-de-reference.mjs";
import {
  IDENTIFIANT_DU_COFFRE,
  IDENTIFIANT_DU_VOLUME_COQUILLE,
} from "../../src/coquille/identites-du-coffre.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { derivateurRecuperation } from "../../src/vm/derivation/derivateur-recuperation.mjs";
import {
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { manifestSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { importArchive } from "../../src/vm/volume-import.mjs";
import { parseManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import {
  DEK,
  KEK,
  cibleDe,
  magasin,
  sourceDArchive,
  sourceDuVolume,
  supportDe,
} from "./support-archive-recuperation.mjs";

const OCTETS = 8 * SECTOR_SIZE;
const MOTIF = 0x5b;

function descripteur() {
  return {
    descripteurVersion: 1,
    application: { id: "railsbox-vault-reference", version: "1.0.0" },
    runtime: { version: "0.1.0" },
    disque: { nom: "app.ext2", octets: OCTETS },
    boot: {
      cmdline: "root=/dev/sda rw",
      memoireOctets: 33554432,
      kernel: "k",
      initrd: "i",
      rootfs: "r",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    prefixeDesArtefacts: "/artifacts/epreuve/",
  };
}

/** INSTALLE par la fonction de production : c'est elle qui choisit l'identité du volume. */
async function installer(banc) {
  const { store } = banc;
  await installerSiNecessaire({
    descripteur: descripteur(),
    cleDeVolume: async () => DEK.slice(),
    observer: banc.stat,
    ouvrir: (options) => openOpfsVolume({ ...options, openHandle: store.openHandle }),
    verser: async (backend) => {
      for (let rang = 0; rang < OCTETS / SECTOR_SIZE; rang += 1) {
        await backend.write(rang * SECTOR_SIZE, new Uint8Array(SECTOR_SIZE).fill(MOTIF));
      }
      await backend.flush();
      return { ecrits: OCTETS, empreinte: await backend.empreinteDuFichier() };
    },
    dater: (options) => daterLaCreation({ ...options, openHandle: store.openHandle }),
    revoquer: async () => {},
    inscrire: (nom, manifeste) =>
      banc.ecrire(manifestSidecarName(nom), serializeManifest(manifeste)),
    lireLeManifeste: async (nom) => banc.lire(manifestSidecarName(nom)),
  });
}

/** Le coffre de la coquille : son enveloppe sur `coquille.cles`, et un moyen de récupération. */
async function poserLeCoffre(banc) {
  const support = supportDe(banc, "coquille");
  await creerEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, dek: DEK, kek: KEK });
  const moyen = await creerMoyenDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  return { support, code: moyen.rendre() };
}

test("l'identité du volume coquille est DISTINCTE de celle du coffre (ADR 0015)", () => {
  assert.match(IDENTIFIANT_DU_COFFRE, /^[0-9a-f]{32}$/);
  assert.match(IDENTIFIANT_DU_VOLUME_COQUILLE, /^[0-9a-f]{32}$/);
  assert.notEqual(IDENTIFIANT_DU_COFFRE, IDENTIFIANT_DU_VOLUME_COQUILLE);
});

test("le disque de Rails, archivé avec la récupération du coffre, se restaure ailleurs et s'ouvre par le code", async () => {
  const source = magasin();
  await installer(source);
  const { support, code } = await poserLeCoffre(source);
  const manifeste = parseManifest(source.lire(manifestSidecarName("application")));
  assert.equal(
    manifeste.volume.id,
    IDENTIFIANT_DU_COFFRE,
    "le volume application doit naître sous l'identité que l'enveloppe authentifie",
  );

  const recovery = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  const { archive } = await exportVolumeToBytes({
    source: sourceDuVolume(source, "application"),
    manifest: manifeste,
    consistency: { kind: "handle-exclusif", detail: "épreuve" },
    cle: DEK,
    recovery,
  });

  const autre = magasin();
  const { cible } = cibleDe(autre, "application");
  const rapport = await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: { app: descripteurDeManifeste(descripteur()).app },
  });
  assert.equal(rapport.restored, true);

  // Ouvrir par le CODE, sur l'autre magasin, sous l'identité du coffre.
  const restaure = supportDe(autre, "application");
  const inventaire = await inventorierEnveloppe({
    support: restaure,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
  });
  const emplacement = inventaire.emplacements.find((e) => e.typeKek === TYPES_KEK.recuperation);
  const kek = await derivateurRecuperation().deriver({
    parametres: emplacement.parametres,
    identite: {
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      identifiantEmplacement: emplacement.identifiantEmplacement,
    },
    geste: { code },
  });
  const ouverte = await ouvrirEnveloppe({
    support: restaure,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek,
  });
  const backend = await openOpfsVolume({
    name: "application",
    size: OCTETS,
    cle: ouverte.dek,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    openHandle: autre.store.openHandle,
  });
  try {
    const secteur = await backend.read(3 * SECTOR_SIZE, SECTOR_SIZE);
    assert.ok(
      secteur.every((octet) => octet === MOTIF),
      "le disque restauré ne relit pas Rails",
    );
  } finally {
    await backend.close();
  }
});
