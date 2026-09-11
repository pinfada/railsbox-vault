// DATER une CRÉATION dont le fichier vient d'atteindre son état final (#181, #182).
//
// Extrait de `opfs-volume-ouverture.mjs`, qui a franchi le seuil d'alerte de 700 lignes en accueillant
// le REPORT du compte versé (revue de format de la PR #186, constat 2). La scission suit une ligne
// de partage nette : ce module-ci ne sait pas OUVRIR un volume, il sait en DATER un — c'est-à-dire
// décider ce qu'une racine écrite après coup a le droit de bénir, et avec quels compteurs.

import { BlockJournal } from "./block-journal.mjs";
import { JournalDeGeneration } from "./generation-journal.mjs";
import { constaterOuverture } from "./generation-recuperation.mjs";
import { rendreSansMasquer, saisirVoisin } from "./opfs-generation-voisins.mjs";
import {
  ecarterLeJournalDeCreation,
  motifDeServiceEventuel,
  MOTIFS_DE_RACINE_INITIALE,
} from "./opfs-racine-initiale.mjs";
import { generationJournalName, openOpfsSyncAccess, statOpfsVolume } from "./opfs-sync-access.mjs";
import { ouvrirVolumeBrut } from "./opfs-volume-brut.mjs";
import { geometryMismatch } from "./storage-errors.mjs";
import { EN_TETE_OCTETS, FORMAT_VOLUME_V4, decoderEnTeteV4 } from "./volume-chiffre-format.mjs";
import { openOpfsVolume, raisonDUnEnTeteRefuse } from "./opfs-volume-ouverture.mjs";

/**
 * DATE la CRÉATION d'un volume dont le fichier vient d'atteindre son état final (#181).
 *
 * ## Pourquoi ce geste existe
 *
 * `openOpfsVolume` écrit la racine initiale À LA NAISSANCE, sur le fichier de zéros que la création
 * vient de sceller. Deux appelants écrivent ENSUITE le fichier entier hors transaction — la coquille
 * de produit, qui verse le disque applicatif (ADR 0030, décision 1), et le banc de référence — et
 * cette écriture change la RÉGION D'AUTHENTIFICATION, donc périme l'empreinte que la racine
 * initiale scelle. Leur création n'est achevée qu'après le versement, et c'est ce geste qui la date.
 *
 * **Sans cet appel, le volume est REFUSÉ à sa première ouverture** par la garde de fraîcheur : un
 * oubli coûte un refus, jamais un silence. C'est la direction sûre, et elle est écrite ici pour être
 * relue.
 *
 * ## Ce que ce geste BÉNIT, et ce qui l'y autorise
 *
 * Le versement ferme le fichier ; cette datation le rouvre. **L'intervalle n'appartient à personne**,
 * et un adversaire qui sait écrire dans l'OPFS peut y poser le fichier d'un AUTRE volume : dater le
 * fichier « tel qu'on le trouve » bénirait alors un état que ce produit n'a jamais produit, sous un
 * motif — `creation` — qui, lui, ne prouve rien. C'est le constat 1 de la revue de sécurité de la
 * PR #184, et c'est le CRITICAL de #181 déplacé sur le chemin de la création.
 *
 * Ce qui referme la fenêtre est `empreinteVersee` : le versement rend l'empreinte SHA-256 du fichier
 * qu'il vient d'écrire, prise AVANT de relâcher son exclusivité, et la datation la confronte à ce
 * qu'elle trouve — `backend.empreinteDuFichier()` — AVANT d'écrire la racine. Sans empreinte, ou sur
 * une empreinte qui ne concorde pas, le refus est `VAULT_STORAGE_CREATION_NON_CONFIRMEE` et aucune
 * racine n'est écrite.
 *
 * ## Il ne peut pas dater autre chose qu'une création
 *
 * Il EXIGE le journal d'une création qui vient de naître : la racine de naissance PRÉSENTE, séquence
 * zéro, génération zéro, aucune entrée, aucune charge, aucune racine abîmée. Un journal VIDE est
 * refusé comme les autres — c'est l'état que laisse une RESTAURATION, pas une création (constat 2 de
 * la revue de sécurité, constat 1 de la revue de format). Sans cette garde, un appel malencontreux
 * sur un volume en service écarterait une génération validée, c'est-à-dire une écriture acquittée :
 * `SEC-DURABLE-001` l'interdit.
 *
 * @param {{ name: string, cle: Uint8Array, identifiantVolume?: string, journal?: BlockJournal,
 *           empreinteVersee?: string | null,
 *           openHandle?: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 * @returns {Promise<object>} le rapport d'ouverture, qui publie la racine écrite et son motif
 */
/**
 * Relit la taille LOGIQUE que l'en-tête v3 du volume déclare, avant qu'il ne soit ouvert.
 *
 * Elle est nécessaire au constat du journal : une racine est décodée SOUS une taille de volume, et
 * la lui refuser ferait passer toute racine authentique pour abîmée. L'en-tête est un localisateur,
 * pas une autorité — et c'est exactement l'usage qu'on en fait ici : le retrouver, ou refuser.
 */
export async function tailleLogiqueDuFichier(name, openHandle) {
  const brut = await ouvrirVolumeBrut({ name, openHandle });
  try {
    const octets = await brut.read(0, EN_TETE_OCTETS);
    const lu = decoderEnTeteV4(octets);
    if (lu.valide) return lu.enTete.tailleLogique;
    throw geometryMismatch(name, {
      observed: brut.size(),
      expected: null,
      reason: `${lu.raison} Une création ne se date pas sans son en-tête v${FORMAT_VOLUME_V4}. ${raisonDUnEnTeteRefuse(octets)}`,
    });
  } finally {
    await brut.close();
  }
}

/**
 * Le PLUS HAUT des deux relevés de scellements : celui de la racine ÉCARTÉE, et celui que le
 * VERSEMENT a rendu (#182, revue de format de la PR #186, constat 2).
 *
 * ## Pourquoi deux, et pourquoi le plus haut
 *
 * La racine écartée est celle de la NAISSANCE : elle publie ce que la création a consommé, et rien
 * de ce que le versement a consommé après elle — cette session-là se ferme sans écrire de racine.
 * Pour un disque applicatif de 512 Mio, la création scelle 2^20 secteurs et le versement 2^20 de
 * plus : n'en reporter qu'un revient à perdre la moitié du budget de la clé à l'installation, sur
 * le chemin même que la règle de clôture prétend fermer.
 *
 * Le versement, lui, rend le compteur de SA session — qui a commencé à la naissance —, donc un
 * nombre qui couvre les deux. Prendre le plus haut plutôt que le versement seul est la direction
 * sûre : un versement d'avant cette garde ne rend rien, et l'ancien report vaut alors encore. Un
 * budget ne se REND jamais ; il ne peut que monter.
 */
function leplusHautDesDeux(reportes, verses) {
  if (verses === null || verses === undefined) return reportes;
  if (reportes === null || reportes === undefined) return verses;
  return {
    volume: Math.max(reportes.volume ?? 0, verses.volume ?? 0),
    journal: Math.max(reportes.journal ?? 0, verses.journal ?? 0),
  };
}

export async function daterLaCreation({
  name,
  cle,
  identifiantVolume,
  journal = new BlockJournal(),
  empreinteVersee = null,
  scellementsVerses = null,
  openHandle = openOpfsSyncAccess,
}) {
  // Les compteurs de la racine ÉCARTÉE sont REPORTÉS sur celle que la datation écrit (#182) : elle
  // était le seul endroit où vivaient les scellements de la création, et repartir de zéro perdrait
  // un deux-millième du budget de la clé en un geste, sans que rien ne le signale.
  const reportes = await ecarterLeJournalDeCreation(
    name,
    openHandle,
    await tailleLogiqueDuFichier(name, openHandle),
  );
  const backend = await openOpfsVolume({
    name,
    cle,
    identifiantVolume,
    journal,
    openHandle,
    creation: MOTIFS_DE_RACINE_INITIALE.creation,
    empreinteVersee,
    scellementsReportes: leplusHautDesDeux(reportes, scellementsVerses),
  });
  try {
    return backend.generation.rapport;
  } finally {
    await backend.close();
  }
}

/**
 * CONSTATE, SANS LEVER ET SANS RIEN MUTER, si le journal d'un volume ne porte QUE la racine
 * initiale d'une création (#173) — la SIGNATURE d'une installation interrompue, mesurée en
 * rejouant une interruption sur le double (`tests/unit/vm-dater-la-creation.test.mjs`).
 *
 * Deux surprises que la mesure a trouvées, contre l'hypothèse de départ :
 *
 *  1. le journal n'est JAMAIS absent ni vide en octets pendant l'installation — une création OUVRE
 *     le volume, donc écrit son journal, AVANT tout versement. Ce qui distingue n'est pas sa
 *     PRÉSENCE, c'est son CONTENU : séquence 0, génération 0, une seule racine — celle de naissance,
 *     aucune charge en attente ;
 *  2. cet état SURVIT au versement entier ET à la datation, tant que rien n'a ENSUITE rouvert le
 *     volume pour un usage normal — le versement du produit (`clotureParDatation: true`) ne ferme
 *     jamais le journal lui-même, et la datation écrit une racine dont le motif reste « creation ».
 *     La fenêtre couverte est donc celle qu'une interruption RÉELLE atteint, du premier octet du
 *     versement jusqu'au manifeste jamais inscrit — pas seulement le premier instant après
 *     l'ouverture. Seul un usage normal SUBSÉQUENT (une réouverture qui écrit) la referme.
 *
 * Contrairement à `ecarterLeJournalDeCreation`, dont c'est le premier geste avant de TRONQUER, cette
 * fonction ne consomme rien : #173 doit pouvoir DÉCIDER — proposer ou non un geste de réparation —
 * avant qu'aucun octet ne bouge. Elle n'ouvre le journal qu'après avoir constaté sa PRÉSENCE par une
 * observation qui ne crée rien (`observer`, `create: false`) : un journal absent est traité comme un
 * refus de la signature, jamais comme une invite à le fabriquer pour la lire.
 *
 * @param {{ name: string, openHandle: (name: string) => Promise<FileSystemSyncAccessHandle>,
 *           observer?: (name: string) => Promise<{ present: boolean, size: number }> }} options
 * @returns {Promise<{ creationSeule: boolean, motif: string | null, tailleLogique: number | null }>}
 *   `tailleLogique` est celle que l'EN-TÊTE du fichier déclare — lue, jamais devinée —, ou `null`
 *   quand elle n'a pas pu être établie.
 */
export async function constaterCreationSeule({ name, openHandle, observer = statOpfsVolume }) {
  const nomDuJournal = generationJournalName(name);
  const etatDuJournal = await observer(nomDuJournal);
  if (!etatDuJournal.present || etatDuJournal.size === 0) {
    return {
      creationSeule: false,
      tailleLogique: null,
      motif:
        "aucun journal de génération lisible : ce n'est pas ce qu'une création de ce produit " +
        "laisse derrière elle, qui en écrit un dès l'ouverture, avant tout versement",
    };
  }
  let tailleLogique;
  try {
    tailleLogique = await tailleLogiqueDuFichier(name, openHandle);
  } catch (cause) {
    return { creationSeule: false, tailleLogique: null, motif: cause?.message ?? String(cause) };
  }
  const handle = await saisirVoisin(openHandle, nomDuJournal, {
    operation: "open-generation",
    volume: name,
  });
  try {
    const journal = new JournalDeGeneration(name, handle);
    const constat = constaterOuverture({ journal, tailleVolume: tailleLogique });
    const motif = motifDeServiceEventuel(constat.racine, constat);
    return { creationSeule: motif === null, tailleLogique, motif };
  } finally {
    rendreSansMasquer(handle);
  }
}
