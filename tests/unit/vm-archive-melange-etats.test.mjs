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
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import {
  RACINE_OCTETS,
  ZONE_ENREGISTREMENTS,
  offsetDeRacine,
} from "../../src/vm/generation-format.mjs";
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

// --- Ce que les revues de la PR #184 ont demandé de MESURER ---------------------------------------

/**
 * Un magasin dont chaque geste sur un fichier est JOURNALISÉ, sans rien changer à sa conduite.
 *
 * C'est l'instrument des deux mesures d'ORDRE que la revue de sécurité réclame (constat 5) : sans
 * lui, la seule chose qui tienne l'ordre des trois gestes de `#recupererSansRacine` est la lecture,
 * et une campagne de mutation qui intervertirait ces gestes ne ferait rougir personne.
 */
function magasinObserve(banc) {
  const journal = [];
  const openHandle = async (nom) => {
    const handle = await banc.store.openHandle(nom);
    return {
      getSize: () => handle.getSize(),
      read(octets, options) {
        journal.push({ fichier: nom, geste: "read", octets: octets.byteLength });
        return handle.read(octets, options);
      },
      write(octets, options) {
        journal.push({ fichier: nom, geste: "write", octets: octets.byteLength });
        return handle.write(octets, options);
      },
      truncate(taille) {
        journal.push({ fichier: nom, geste: "truncate", octets: taille });
        return handle.truncate(taille);
      },
      flush: () => handle.flush(),
      close: () => handle.close(),
    };
  };
  return { journal, openHandle };
}

/** Ouvre le volume restauré à travers un magasin observé, et rend le journal des gestes. */
async function ouvrirEnObservant(banc, nom) {
  const observe = magasinObserve(banc);
  const issue = await openOpfsVolume({
    name: nom,
    size: TAILLE,
    cle: DEK,
    identifiantVolume: VOLUME_A,
    openHandle: observe.openHandle,
  }).then(
    async (backend) => {
      const rapport = backend.generation.rapport;
      await backend.close();
      return { rapport, refus: null };
    },
    (raison) => ({ rapport: null, refus: raison }),
  );
  return { ...issue, journal: observe.journal };
}

test("ÉPREUVE ROUGE — le mélange A/C RESTAURÉ ne peut pas être DATÉ", async () => {
  // Le second chemin vers la racine initiale, sous le motif `creation` — celui qui ne prouve rien.
  // `daterLaCreation` est exporté par la surface publique du module de volume : sans la garde, il
  // datait un volume restauré, et le mélange A/C se rouvrait EN CLAIR (constat 2 de la revue de
  // sécurité, constat 1 de la revue de format de la PR #184).
  const { archiveDeC, melange } = await melangeDuRelecteur();
  const forgee = await archiveMelangee(archiveDeC, melange);
  const { destination } = await restaurer(forgee);

  await assert.rejects(
    () =>
      daterLaCreation({
        name: CIBLE,
        cle: DEK,
        identifiantVolume: VOLUME_A,
        empreinteVersee: "0".repeat(64),
        openHandle: destination.store.openHandle,
      }),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.generationPending),
    "un journal SANS racine est l'état d'une restauration, jamais celui d'une création",
  );

  // Et le volume reste ce qu'il était : refusé, sans un octet de clair.
  await assert.rejects(
    () => ouvrirLeVolumeRestaure(destination, CIBLE),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.engagementInvalide),
  );
});

test("dater un volume RESTAURÉ INTACT est refusé aussi : la garde juge l'ÉTAT, pas l'intention", async () => {
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);
  await assert.rejects(
    () =>
      daterLaCreation({
        name: CIBLE,
        cle: DEK,
        identifiantVolume: VOLUME_A,
        empreinteVersee: "0".repeat(64),
        openHandle: destination.store.openHandle,
      }),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.generationPending),
  );
});

test("un voisin d'engagement PLUS LONG que 180 octets est REFUSÉ, jamais tronqué", async () => {
  // Lire `min(taille, 180)` puis décoder laissait passer un engagement légitime suivi d'une queue
  // arbitraire : le décodeur n'y voyait que ses 180 premiers octets (constat 4 de la revue de
  // sécurité). Ce dépôt tient la règle inverse pour l'archive (`assertRienEnQueue`).
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);

  const voisin = engagementSidecarName(CIBLE);
  const legitime = destination.store.snapshot(voisin);
  assert.equal(legitime.byteLength, 180, "un engagement fait 180 octets");
  const allonge = new Uint8Array(200);
  allonge.set(legitime, 0);
  allonge.fill(0x41, 180);
  await destination.ecrire(voisin, allonge);

  await assert.rejects(
    () => ouvrirLeVolumeRestaure(destination, CIBLE),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.engagementInvalide),
    "un voisin d'une AUTRE taille est présent et illisible, jamais amputé de sa queue",
  );
});

test("un voisin REPOSÉ alors qu'une racine fait autorité est VIDÉ, et l'ouverture le PUBLIE", async () => {
  // Il n'est jamais consulté sur ce chemin — la décision 5 le dit — mais un voisin qu'on ignore
  // sans le dire finit par être cru actif (constat 9 de la revue de sécurité).
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);
  const voisin = engagementSidecarName(CIBLE);
  const legitime = destination.store.snapshot(voisin);

  const premiere = await ouvrirLeVolumeRestaure(destination, CIBLE);
  assert.equal(premiere.rapport.motifDeLaRacine, "engagement");
  assert.equal(premiere.rapport.voisinIgnore, false, "il a été CONSOMMÉ, pas ignoré");

  // L'adversaire repose le voisin : une racine fait désormais autorité, il n'obtient rien.
  await destination.ecrire(voisin, legitime);
  const seconde = await ouvrirLeVolumeRestaure(destination, CIBLE);
  assert.equal(seconde.rapport.etat, GENERATION_ETATS.aucune, "chemin normal : une racine décide");
  assert.equal(seconde.rapport.voisinIgnore, true, "un voisin écarté est publié, jamais tu");
  assert.equal(
    destination.store.sizeOf(voisin),
    0,
    "vidé (0 octet), comme la consommation le fait",
  );

  // Et une troisième ouverture ne publie plus rien : il n'y a plus rien à écarter.
  const troisieme = await ouvrirLeVolumeRestaure(destination, CIBLE);
  assert.equal(troisieme.rapport.voisinIgnore, false);
});

test("ORDRE — une racine ABÎMÉE refuse AVANT l'autorisation, et ne coûte pas l'empreinte du fichier", async () => {
  // Mutant visé : déplacer `exigerRacineLisible` APRÈS `this.#sansRacine.autoriser()`. Ce qui le tue
  // est la MESURE : l'empreinte du fichier relit tout le support, et une racine abîmée ne doit pas
  // la payer — l'inverse offrirait un déni de service à une relecture complète par tentative.
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);

  // La restauration n'écrit AUCUNE racine : on en pose donc deux ILLISIBLES — ni vierges, ni
  // décodables —, ce qui est l'état « une racine existe et elle est abîmée ».
  const journalVoisin = `${CIBLE}.gen`;
  const handle = await destination.store.openHandle(journalVoisin);
  try {
    handle.truncate(ZONE_ENREGISTREMENTS);
    handle.write(new Uint8Array(RACINE_OCTETS).fill(0xa5), { at: offsetDeRacine(0) });
    handle.write(new Uint8Array(RACINE_OCTETS).fill(0x5a), { at: offsetDeRacine(1) });
    handle.flush();
  } finally {
    handle.close();
  }

  const observe = await ouvrirEnObservant(destination, CIBLE);
  assert.ok(
    isStorageError(observe.refus, STORAGE_ERROR_CODES.generationRootCorrupt),
    `racine abîmée attendue, reçu ${observe.refus?.code}`,
  );
  const relecturesEntieres = observe.journal.filter(
    (geste) => geste.fichier === CIBLE && geste.geste === "read" && geste.octets > TAILLE,
  );
  assert.deepEqual(
    relecturesEntieres,
    [],
    "aucune relecture du fichier ENTIER : l'autorisation n'a pas été demandée",
  );
});

test("ORDRE — la racine initiale est ÉCRITE avant que l'engagement ne soit consommé", async () => {
  // Mutant visé : déplacer `autorisation.consommer()` AVANT `this.#vider(...)`. Ce qui le tue est la
  // MESURE de l'ordre des gestes : retirer le voisin avant que le volume ne porte de quoi s'en
  // passer laisserait, sur coupure, un volume irrécupérable.
  const { archiveDeC } = await melangeDuRelecteur();
  const { destination } = await restaurer(archiveDeC);

  const observe = await ouvrirEnObservant(destination, CIBLE);
  assert.equal(observe.rapport?.motifDeLaRacine, "engagement");

  const journalVoisin = `${CIBLE}.gen`;
  const voisin = engagementSidecarName(CIBLE);
  const ecritureDeRacine = observe.journal.findIndex(
    (geste) => geste.fichier === journalVoisin && geste.geste === "write",
  );
  const consommation = observe.journal.findIndex(
    (geste) => geste.fichier === voisin && geste.geste === "truncate" && geste.octets === 0,
  );
  assert.notEqual(ecritureDeRacine, -1, "la racine initiale est ÉCRITE");
  assert.notEqual(consommation, -1, "le voisin est CONSOMMÉ");
  assert.ok(
    ecritureDeRacine < consommation,
    "la racine initiale est écrite AVANT que le voisin ne soit vidé, jamais l'inverse",
  );
});
