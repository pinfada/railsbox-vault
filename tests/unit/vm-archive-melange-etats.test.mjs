/**
 * LE MÉLANGE A/C : une archive ne transporte pas un état que le volume n'a jamais produit
 * (#181, CRITICAL de la revue externe du 10 septembre 2026).
 *
 * ## Ce que le relecteur a exécuté, et ce que cette épreuve rejoue
 *
 * Six étapes, reprises de l'issue #181 :
 *
 *  1. produire l'état A : secteurs (ancien0, ancien1) ;
 *  2. produire ensuite B : (nouveau0, ancien1) ;
 *  3. produire ensuite C : (nouveau0, nouveau1) ;
 *  4. partir du fichier C et y remettre le chiffré, le nonce, l'étiquette et la génération du
 *     secteur 0 provenant de A ;
 *  5. construire une archive au format public, donc recalculer ses empreintes SHA-256 ;
 *  6. vérifier et rouvrir le contenu restauré.
 *
 * Le relecteur obtenait alors, sans un refus :
 *
 *     { "archiveVerifiee": true, "fraicheur": "sans-racine", "secteur0Ancien": true,
 *       "secteur1Nouveau": true, "etatJamaisProduit": true }
 *
 * Chaque secteur reste authentique isolément — son sceau et son identité viennent du même endroit —
 * mais leur combinaison ne correspond à AUCUN état validé du volume. C'est le mélange que le § 8 du
 * format prétend refuser, et ce n'est pas le retour arrière COMPLET du § 9.1.
 *
 * ## L'adversaire n'a PAS la clé, et l'épreuve le respecte
 *
 * L'étape 5 est prise au mot : l'adversaire part de l'archive LÉGITIME de l'état C, y remplace la
 * section de contenu par le fichier mélangé, et recalcule les empreintes SHA-256 publiques — celle
 * de l'en-tête et celle du manifeste. Il ne touche pas à l'engagement, et il ne le peut pas : le
 * refabriquer exigerait la clé du volume. C'est exactement ce qui rend le mélange détectable.
 *
 * ## Les quatre propriétés établies ici
 *
 *  1. **le mélange est REFUSÉ**, par un code typé, avant que le moindre octet en clair ne sorte ;
 *  2. **le témoin positif** : l'archive de C, intacte, se restaure et s'ouvre — sans lui, un refus
 *     universel passerait pour une correction ;
 *  3. **la seconde épreuve rouge** : retirer `<volume>.engagement` après la restauration ne rend pas
 *     le volume ouvrable, il le fait REFUSER. Sans elle, la correction serait contournable par une
 *     commande `rm` ;
 *  4. **le témoin de consommation** : après la première ouverture, le voisin n'existe plus, et la
 *     seconde ouverture passe par le chemin normal.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { importArchive } from "../../src/vm/volume-import.mjs";
import { engagementSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { GENERATION_ETATS } from "../../src/vm/generation-recuperation.mjs";
import {
  SCEAU_OCTETS,
  dispositionV3,
  offsetDeCharge,
  offsetDeSceau,
} from "../../src/vm/volume-chiffre-format.mjs";
import {
  ATTENTES,
  DEK,
  TAILLE,
  VOLUME_A,
  cibleDe,
  descripteurDeManifeste,
  magasin,
  sourceDArchive,
} from "./support-archive-recuperation.mjs";

const NOM = "coffre";
const CIBLE = "restaure";
const DISPOSITION = dispositionV3(TAILLE);
const PREAMBULE_OCTETS = 12;

/** Un secteur entier rempli d'un motif reconnaissable : c'est le CLAIR qu'on suivra. */
function secteurDe(motif) {
  return new Uint8Array(SECTOR_SIZE).fill(motif);
}

const ANCIEN_0 = secteurDe(0xa0);
const ANCIEN_1 = secteurDe(0xa1);
const NOUVEAU_0 = secteurDe(0xc0);
const NOUVEAU_1 = secteurDe(0xc1);

/**
 * Ouvre le volume TRANSACTIONNELLEMENT, écrit les secteurs demandés, franchit la barrière, puis
 * referme. Le seuil de point de contrôle est à un octet : la charge validée est rangée dans le
 * FICHIER dès la barrière, si bien que l'état produit est celui que l'archive transportera.
 */
async function produireEtat(banc, secteurs) {
  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: banc.store.openHandle,
    seuilPointDeControle: 1,
  });
  try {
    for (const [rang, octets] of secteurs) await backend.write(rang * SECTOR_SIZE, octets);
    await backend.flush();
  } finally {
    await backend.close();
  }
  return banc.store.snapshot(NOM).slice();
}

/**
 * ÉTAPE 4 — repose dans le fichier C le chiffré, le nonce, l'étiquette et la génération du secteur
 * `rang` provenant du fichier A. Les deux moitiés voyagent ENSEMBLE, et c'est ce qui rend le
 * secteur greffé authentique : son sceau et son identité viennent du même endroit.
 */
function greffer(fichierC, fichierA, rang) {
  const melange = fichierC.slice();
  const adresse = rang * SECTOR_SIZE;
  const charge = offsetDeCharge(DISPOSITION, adresse);
  const sceau = offsetDeSceau(DISPOSITION, adresse);
  melange.set(fichierA.subarray(charge, charge + SECTOR_SIZE), charge);
  melange.set(fichierA.subarray(sceau, sceau + SCEAU_OCTETS), sceau);
  return melange;
}

/** L'archive LÉGITIME d'un fichier de volume : celle que l'export du produit écrit. */
async function archiveLegitime(octets) {
  const { archive } = await exportVolumeToBytes({
    source: {
      size: octets.byteLength,
      read: async (offset, longueur) => octets.slice(offset, offset + longueur),
    },
    manifest: descripteurDeManifeste(VOLUME_A),
    consistency: { kind: "handle-exclusif", detail: "volume fermé pour l'épreuve" },
    cle: DEK,
  });
  return archive;
}

/** SHA-256 en hexadécimal minuscule, comme l'archive l'inscrit. */
async function empreinteHex(octets) {
  const brut = new Uint8Array(await crypto.subtle.digest("SHA-256", octets));
  return [...brut].map((o) => o.toString(16).padStart(2, "0")).join("");
}

/**
 * ÉTAPE 5 — l'archive de l'ADVERSAIRE : celle de l'état C, dont la section de contenu est remplacée
 * par le mélange et dont les empreintes SHA-256 PUBLIQUES sont recalculées. L'engagement, lui, reste
 * celui que l'export a scellé : le refabriquer exigerait la clé du volume.
 */
async function archiveMelangee(archiveDeC, melange) {
  const vue = new DataView(archiveDeC.buffer, archiveDeC.byteOffset, archiveDeC.byteLength);
  const longueurEnTete = vue.getUint32(8, false);
  const offsetDuContenu = PREAMBULE_OCTETS + longueurEnTete;
  const enTete = JSON.parse(
    new TextDecoder().decode(archiveDeC.subarray(PREAMBULE_OCTETS, offsetDuContenu)),
  );
  const empreinte = await empreinteHex(melange);
  enTete.content.digest = empreinte;
  enTete.manifest.identity.digest = empreinte;
  const enTeteOctets = new TextEncoder().encode(JSON.stringify(enTete));
  assert.equal(
    enTeteOctets.byteLength,
    longueurEnTete,
    "une empreinte SHA-256 fait toujours 64 hexadécimaux : l'en-tête ne change pas de taille",
  );
  const forgee = archiveDeC.slice();
  forgee.set(enTeteOctets, PREAMBULE_OCTETS);
  forgee.set(melange, offsetDuContenu);
  return forgee;
}

/** Les trois états du relecteur, l'archive de C, et le fichier mélangé qui n'est aucun état. */
async function melangeDuRelecteur() {
  const origine = magasin();
  const fichierA = await produireEtat(origine, [
    [0, ANCIEN_0],
    [1, ANCIEN_1],
  ]);
  await produireEtat(origine, [[0, NOUVEAU_0]]);
  const fichierC = await produireEtat(origine, [[1, NOUVEAU_1]]);
  return {
    origine,
    fichierC,
    archiveDeC: await archiveLegitime(fichierC),
    melange: greffer(fichierC, fichierA, 0),
  };
}

/** RESTAURE une archive sur un support neuf, et rend le magasin de destination. */
async function restaurer(archive) {
  const destination = magasin();
  const { cible } = cibleDe(destination, CIBLE);
  const rapport = await importArchive({
    source: sourceDArchive(archive),
    target: cible,
    expectations: ATTENTES,
  });
  return { destination, rapport };
}

/** Ouverture TRANSACTIONNELLE du volume restauré : c'est elle qui décide. */
async function ouvrirLeVolumeRestaure(banc, nom) {
  const backend = await openOpfsVolume({
    name: nom,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: banc.store.openHandle,
  });
  try {
    return {
      rapport: backend.generation.rapport,
      secteur0: await backend.read(0, SECTOR_SIZE),
      secteur1: await backend.read(SECTOR_SIZE, SECTOR_SIZE),
    };
  } finally {
    await backend.close();
  }
}

test("ÉPREUVE ROUGE — le mélange A/C est REFUSÉ par un code typé, avant tout clair", async () => {
  const { archiveDeC, melange } = await melangeDuRelecteur();
  const forgee = await archiveMelangee(archiveDeC, melange);

  // La restauration PASSE : elle n'a pas la clé, et l'archive forgée est cohérente pour tout ce qui
  // se vérifie sans clé. C'est l'OUVERTURE qui décide, et le § 7.5 le dit ainsi.
  const { destination } = await restaurer(forgee);

  // ÉTAPE 6 — rouvrir le contenu restauré. Le refus est le résultat attendu, et il tombe AVANT
  // qu'aucun secteur ne soit déchiffré : l'ouverture ne rend aucun backend.
  await assert.rejects(
    () => ouvrirLeVolumeRestaure(destination, CIBLE),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.engagementInvalide),
    "le mélange doit produire un refus typé, jamais un clair",
  );
});

test("TÉMOIN POSITIF — l'archive intacte de C se restaure, s'ouvre, et rend l'état de C", async () => {
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);

  const ouvert = await ouvrirLeVolumeRestaure(destination, CIBLE);
  assert.equal(ouvert.rapport.etat, GENERATION_ETATS.initialisee);
  assert.equal(ouvert.rapport.racineInitiale, true, "l'ouverture ÉCRIT, et elle le publie");
  assert.equal(ouvert.rapport.motifDeLaRacine, "engagement");
  assert.ok(
    ouvert.secteur0.every((octet) => octet === 0xc0),
    "le secteur 0 porte l'état de C",
  );
  assert.ok(
    ouvert.secteur1.every((octet) => octet === 0xc1),
    "le secteur 1 porte l'état de C",
  );
});

test("SECONDE ÉPREUVE ROUGE — restauration, PUIS voisin retiré : le volume est REFUSÉ", async () => {
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);

  // Le geste de l'adversaire, et il ne demande aucune clé : un `rm` sur le voisin.
  await destination.retirer(engagementSidecarName(CIBLE));

  await assert.rejects(
    () => ouvrirLeVolumeRestaure(destination, CIBLE),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.volumeSansRacine),
    "un volume sans racine ni engagement n'est plus un état légitime",
  );
});

test("TÉMOIN DE CONSOMMATION — le voisin disparaît, et la seconde ouverture est normale", async () => {
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);

  const voisin = engagementSidecarName(CIBLE);
  assert.ok(destination.store.sizeOf(voisin) > 0, "la restauration DÉPOSE l'engagement");

  await ouvrirLeVolumeRestaure(destination, CIBLE);
  assert.equal(
    destination.store.sizeOf(voisin),
    0,
    "l'engagement est CONSOMMÉ une fois, jamais relu à chaque ouverture",
  );

  const seconde = await ouvrirLeVolumeRestaure(destination, CIBLE);
  assert.equal(seconde.rapport.etat, GENERATION_ETATS.aucune, "chemin normal : une racine décide");
  assert.equal(seconde.rapport.racineInitiale, false);
  assert.ok(seconde.secteur1.every((octet) => octet === 0xc1));
});
