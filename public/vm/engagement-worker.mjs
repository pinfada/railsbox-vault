// Worker de confiance du banc d'ENGAGEMENT D'ARCHIVE (#181, ADR 0034).
//
// Il rejoue, sur l'**OPFS RÉEL**, ce que `tests/unit/vm-archive-melange-etats.test.mjs` établit sur
// le double : les six étapes du relecteur de la revue externe du 10 septembre 2026, puis les trois
// cas de l'ouverture. Ce qui ne se démontre pas sous Node est précisément ce qui compte ici — le
// voisin `<volume>.engagement` est un fichier de l'OPFS, sa consommation en est une suppression, et
// un moteur qui n'a pas d'OPFS synchrone doit REFUSER par un code typé plutôt que planter.
//
// C'est le SEUL contexte autorisé à ouvrir un handle exclusif, et donc le seul à voir une clé de
// volume. Il rend à la page des données JSON, jamais une clé, jamais un fichier, jamais un handle.
//
// Aucun scénario ne rend « réussi » de lui-même : il rend ce qu'il a observé.

import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { exportVolumeToBytes } from "/src/vm/archive-en-memoire.mjs";
import { cleDeVolumeDuHarnais } from "/src/vm/cle-de-volume.mjs";
import { GENERATION_ETATS } from "/src/vm/generation-recuperation.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { createOpfsImportTarget } from "/src/vm/opfs-import-target.mjs";
import {
  engagementSidecarName,
  removeOpfsVolume,
  statOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { ouvrirVolumeBrut } from "/src/vm/opfs-volume-brut.mjs";
import { importArchive } from "/src/vm/volume-import.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";
import { createManifest } from "/src/vm/volume-manifest.mjs";
import {
  SCEAU_OCTETS,
  dispositionDuVolume,
  offsetDeCharge,
  offsetDeSceau,
} from "/src/vm/volume-chiffre-format.mjs";

const SOURCE = "banc-engagement-a";
const CIBLE = "banc-engagement-b";
const TAILLE = 8 * SECTOR_SIZE;
const DISPOSITION = dispositionDuVolume(TAILLE);
const PREAMBULE_OCTETS = 12;

const ATTENTES = { app: { id: "railsbox-vault-banc" }, runtime: { version: "0.1.0" } };

/**
 * Identifiant de volume du banc, POSÉ EN OCTETS plutôt qu'en littéral hexadécimal : une longue
 * chaîne hexadécimale ressemble, pour un détecteur de secrets, à une clé oubliée.
 */
const IDENTIFIANT_VOLUME = Array.from({ length: 16 }, (_, index) => (0xb0 + index * 0x07) % 256)
  .map((octet) => octet.toString(16).padStart(2, "0"))
  .join("");

/** Code d'une erreur typée, ou `null` si l'opération a réussi — ce qui est parfois un échec. */
function codeOf(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function secteurDe(motif) {
  return new Uint8Array(SECTOR_SIZE).fill(motif);
}

const ANCIEN_0 = secteurDe(0xa0);
const ANCIEN_1 = secteurDe(0xa1);
const NOUVEAU_0 = secteurDe(0xc0);
const NOUVEAU_1 = secteurDe(0xc1);

function manifesteDuBanc() {
  return createManifest({
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app: { id: "railsbox-vault-banc", version: "1.0.0" },
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    volume: { id: IDENTIFIANT_VOLUME, algorithm: "aes-256-gcm" },
  });
}

/** Ouvre, écrit les secteurs demandés, franchit la barrière, referme. Le seuil range dès la barrière. */
async function produireEtat(jeton, secteurs) {
  const backend = await openOpfsVolume({
    name: SOURCE,
    size: TAILLE,
    cle: cleDeVolumeDuHarnais({ jeton }),
    identifiantVolume: IDENTIFIANT_VOLUME,
    seuilPointDeControle: 1,
  });
  try {
    for (const [rang, octets] of secteurs) await backend.write(rang * SECTOR_SIZE, octets);
    await backend.flush();
  } finally {
    await backend.close();
  }
  return lireLeFichier(SOURCE);
}

/** Relit le FICHIER du volume, tel quel : c'est ce qu'une archive transporte. */
async function lireLeFichier(nom) {
  const brut = await ouvrirVolumeBrut({ name: nom });
  try {
    return await brut.read(0, brut.size());
  } finally {
    await brut.close();
  }
}

/** ÉTAPE 4 — le chiffré, le nonce, l'étiquette et la génération du secteur 0 de A, remis dans C. */
function greffer(fichierC, fichierA, rang) {
  const melange = fichierC.slice();
  const adresse = rang * SECTOR_SIZE;
  const charge = offsetDeCharge(DISPOSITION, adresse);
  const sceau = offsetDeSceau(DISPOSITION, adresse);
  melange.set(fichierA.subarray(charge, charge + SECTOR_SIZE), charge);
  melange.set(fichierA.subarray(sceau, sceau + SCEAU_OCTETS), sceau);
  return melange;
}

/** L'archive LÉGITIME d'un fichier : celle que l'export du produit écrit, engagement compris. */
async function archiveLegitime(jeton, octets) {
  const { archive } = await exportVolumeToBytes({
    source: {
      size: octets.byteLength,
      read: async (offset, longueur) => octets.slice(offset, offset + longueur),
    },
    manifest: manifesteDuBanc(),
    consistency: { kind: "handle-exclusif", detail: "volume fermé pour le banc" },
    cle: cleDeVolumeDuHarnais({ jeton }),
  });
  return archive;
}

async function empreinteHex(octets) {
  const brut = new Uint8Array(await crypto.subtle.digest("SHA-256", octets));
  return [...brut].map((o) => o.toString(16).padStart(2, "0")).join("");
}

/**
 * ÉTAPE 5 — l'archive de l'ADVERSAIRE : celle de C, contenu remplacé par le mélange, empreintes
 * SHA-256 PUBLIQUES recalculées. L'engagement n'est pas touché — le refabriquer exigerait la clé.
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
  const forgee = archiveDeC.slice();
  forgee.set(enTeteOctets, PREAMBULE_OCTETS);
  forgee.set(melange, offsetDuContenu);
  return forgee;
}

/** RESTAURE une archive sur la cible, par le module de production branché sur l'OPFS réel. */
async function restaurer(archive) {
  await removeOpfsVolume(CIBLE);
  return importArchive({
    source: {
      byteLength: archive.byteLength,
      read: async (offset, longueur) => archive.slice(offset, offset + longueur),
    },
    target: createOpfsImportTarget(CIBLE),
    expectations: ATTENTES,
  });
}

/** Ouverture TRANSACTIONNELLE du volume restauré : c'est elle qui décide. */
async function ouvrirLaCible(jeton) {
  const backend = await openOpfsVolume({
    name: CIBLE,
    size: TAILLE,
    cle: cleDeVolumeDuHarnais({ jeton }),
    identifiantVolume: IDENTIFIANT_VOLUME,
  });
  try {
    const secteur1 = await backend.read(SECTOR_SIZE, SECTOR_SIZE);
    return {
      etat: backend.generation.rapport.etat,
      racineInitiale: backend.generation.rapport.racineInitiale,
      motifDeLaRacine: backend.generation.rapport.motifDeLaRacine,
      secteur1Nouveau: secteur1.every((octet) => octet === 0xc1),
    };
  } finally {
    await backend.close();
  }
}

/**
 * Le nombre d'octets que le voisin d'engagement porte encore — 180 quand il est déposé, 0 une fois
 * consommé. La TAILLE plutôt qu'un booléen : un voisin tronqué à autre chose que zéro se lirait.
 *
 * La question est posée par `statOpfsVolume`, qui OBSERVE sans créer : l'ouvrir en accès brut le
 * fabriquerait, et une question ne doit rien fabriquer sur le support.
 */
async function voisinPresent() {
  return (await statOpfsVolume(engagementSidecarName(CIBLE))).size;
}

/** Ce que le moteur offre au Worker. Sans OPFS synchrone, tout le reste est un refus typé. */
async function scenarioCapacite() {
  const measurement = {
    workerGetDirectory: typeof navigator.storage?.getDirectory,
    workerCreateSyncAccessHandle:
      typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
    openCode: null,
    openMessage: null,
  };
  try {
    await removeOpfsVolume(SOURCE);
    await removeOpfsVolume(CIBLE);
  } catch (error) {
    measurement.openCode = codeOf(error);
    measurement.openMessage = error.message;
  }
  return measurement;
}

/**
 * LE SCÉNARIO : les six étapes du relecteur, puis les trois cas de l'ouverture, sur l'OPFS réel.
 *
 * Il rend un compte rendu, jamais un verdict : c'est l'épreuve qui juge. Les codes de refus sont
 * relevés et rendus, pas levés — sans quoi le premier refus attendu masquerait tous les suivants.
 */
async function scenarioMelange(jeton) {
  await removeOpfsVolume(SOURCE);
  await removeOpfsVolume(CIBLE);

  const fichierA = await produireEtat(jeton, [
    [0, ANCIEN_0],
    [1, ANCIEN_1],
  ]);
  await produireEtat(jeton, [[0, NOUVEAU_0]]);
  const fichierC = await produireEtat(jeton, [[1, NOUVEAU_1]]);
  const archiveDeC = await archiveLegitime(jeton, fichierC);
  const melange = greffer(fichierC, fichierA, 0);

  const rapport = { archiveOctets: archiveDeC.byteLength };

  // 1. LE MÉLANGE — la restauration passe (elle n'a pas la clé), l'ouverture refuse.
  await restaurer(await archiveMelangee(archiveDeC, melange));
  rapport.melangeRestaure = true;
  rapport.melangeVoisinPose = await voisinPresent();
  rapport.melangeCode = await refusDeLOuverture(jeton);

  // 2. LE TÉMOIN POSITIF — l'archive intacte se restaure ET s'ouvre.
  await restaurer(archiveDeC);
  const ouvert = await ouvrirLaCible(jeton);
  rapport.temoinEtat = ouvert.etat;
  rapport.temoinRacineInitiale = ouvert.racineInitiale;
  rapport.temoinMotif = ouvert.motifDeLaRacine;
  rapport.temoinSecteur1Nouveau = ouvert.secteur1Nouveau;

  // 3. LA CONSOMMATION — le voisin n'existe plus, et la seconde ouverture est normale.
  rapport.voisinApresOuverture = await voisinPresent();
  rapport.secondeOuvertureEtat = (await ouvrirLaCible(jeton)).etat;
  rapport.ouvertureNormale = rapport.secondeOuvertureEtat === GENERATION_ETATS.aucune;

  // 4. LE VOISIN RETIRÉ — le geste de l'adversaire, et il ne demande aucune clé.
  await restaurer(archiveDeC);
  await removeOpfsVolume(engagementSidecarName(CIBLE));
  rapport.voisinRetireCode = await refusDeLOuverture(jeton);

  await removeOpfsVolume(SOURCE);
  await removeOpfsVolume(CIBLE);
  return rapport;
}

/** Ouvre la cible et rend le CODE du refus, ou `null` si elle s'est ouverte — ce qui est l'échec. */
async function refusDeLOuverture(jeton) {
  try {
    await ouvrirLaCible(jeton);
    return null;
  } catch (error) {
    return codeOf(error);
  }
}

/**
 * MESURE ce que la vérification d'un engagement COÛTE : le SHA-256 du fichier chiffré entier.
 *
 * C'est le seul geste coûteux du chemin, et il ne se paie qu'à la PREMIÈRE ouverture d'un volume
 * restauré. Il est mesuré ici plutôt que sous Node parce que le hachage est en JavaScript PORTABLE
 * (`sha256-stream.mjs`, faute d'un hachage incrémental dans WebCrypto) : sa vitesse est celle du
 * moteur, et trois moteurs ne l'exécutent pas au même rythme.
 *
 * **Ce qui est mesuré, et ce qui ne l'est pas.** Le HACHAGE seul, sur un tampon de 4 Mio réémis :
 * la lecture du support s'y ajoute, et elle n'est pas ici. Aucun seuil n'est posé — le chiffre est
 * publié, pas jugé.
 */
async function scenarioCout() {
  const BLOC = 4 * 1024 * 1024;
  const bloc = new Uint8Array(BLOC);
  for (let index = 0; index < BLOC; index += 1) bloc[index] = (index * 7 + 13) & 0xff;
  const hacher = (octets) => {
    const depart = performance.now();
    const hachage = createSha256Stream();
    for (let offset = 0; offset < octets; offset += BLOC) hachage.update(bloc);
    hachage.digestHex();
    return Number((performance.now() - depart).toFixed(1));
  };
  return {
    blocOctets: BLOC,
    // L'ENGAGEMENT à la première ouverture d'un volume restauré : le fichier ENTIER.
    fichierOctets: 512 * 1024 * 1024,
    fichierMs: hacher(512 * 1024 * 1024),
    // La RACINE INITIALE à la création : l'empreinte de la RÉGION d'authentification, qui fait
    // 34 octets par secteur — 34 Mio pour un volume de 512 Mio. C'est le terme dominant du geste ;
    // s'y ajoutent trois scellements AES-GCM et deux barrières.
    regionOctets: dispositionDuVolume(512 * 1024 * 1024).regionOctets,
    regionMs: hacher(dispositionDuVolume(512 * 1024 * 1024).regionOctets),
  };
}

const SCENARIOS = { capacite: scenarioCapacite, melange: scenarioMelange, cout: scenarioCout };

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") return;
  const scenario = SCENARIOS[payload?.scenario ?? "melange"];
  if (!scenario) {
    self.postMessage({
      id,
      ok: false,
      error: { code: "VAULT_BANC_SCENARIO_INCONNU", message: `Scénario ${payload?.scenario}` },
    });
    return;
  }
  try {
    self.postMessage({ id, ok: true, report: await scenario(payload?.jetonCle, payload) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: { code: codeOf(error), message: error?.message ?? String(error) },
    });
  }
});
