// SAUVEGARDER, RESTAURER, RÉVOQUER EN URGENCE — le branchement dans le Worker de confiance (#207,
// ADR 0039).
//
// Il vit à part de `runtime-worker.mjs` pour la raison du relais HTTP (`relais-du-worker.mjs`) : le
// Worker de confiance est à son plafond de lignes, et ces trois gestes forment un sujet entier. Ce
// module ne DÉCIDE rien — `src/coquille/portabilite-du-coffre.mjs` tranche l'état de l'emplacement,
// le refus pendant un geste long et le bilan d'une révocation — et il n'écrit aucun format :
// `writeArchive`, `importArchive` et `revoquerToutSauf` sont APPELÉS tels quels.
//
// ## Ce qui franchit un port, et dans quel sens
//
//  - la SAUVEGARDE rend à la page un `File` — les octets de l'archive, figés — et des nombres. Elle
//    ne rend jamais rien au document applicatif : le port restreint ne connaît pas ces types, et
//    `evaluerRequete` les refuse sous `VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE` ;
//  - la RESTAURATION reçoit de la page le `File` que l'utilisateur a choisi. Aucune clé n'entre : le
//    coffre restauré s'ouvre ensuite par le code, par le geste de déverrouillage existant ;
//  - la RÉVOCATION ne transporte rien d'autre que des noms de moyens et des nombres.

import {
  CHAMP_DE_L_ARCHIVE,
  TYPES_PRIVILEGIES,
  estUneArchive,
} from "/src/coquille/contrat-de-messages.mjs";
import {
  lireLeDescripteur,
  NOM_DU_VOLUME_APPLICATIF,
} from "/src/coquille/application-de-reference.mjs";
import { ETATS_DU_VOLUME } from "/src/coquille/etat-de-la-coquille.mjs";
import {
  IDENTIFIANT_DU_COFFRE,
  VOLUME_DE_LA_COQUILLE,
} from "/src/coquille/identites-du-coffre.mjs";
import {
  COHERENCE_DE_LA_SAUVEGARDE,
  ENVELOPPE_DU_COFFRE,
  FICHIER_DE_SAUVEGARDE,
  GESTES_LONGS,
  bilanDeRevocation,
  cibleDuCoffre,
  constaterLEmplacement,
  decisionDeRestauration,
  enTeteDArchive,
  refusDOuverture,
  refusPendantUnGesteLong,
} from "/src/coquille/portabilite-du-coffre.mjs";
import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";
import { inventorierEnveloppe, revoquerToutSauf } from "/src/vm/enveloppe-de-cle.mjs";
import {
  construireEnveloppeDeRecuperation,
  fichierDEnveloppeDepuisLaPage,
} from "/src/vm/enveloppe-de-recuperation.mjs";
import { BlockJournal } from "/src/vm/block-journal.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { ouvrirVolumeBrut } from "/src/vm/opfs-volume-brut.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "/src/vm/storage-errors.mjs";
import { createOpfsArchiveSink } from "/src/vm/opfs-archive-sink.mjs";
import { createOpfsImportTarget } from "/src/vm/opfs-import-target.mjs";
import {
  manifestSidecarName,
  openOpfsSyncAccess,
  openOpfsVolumeFile,
  removeOpfsVolume,
  statOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { readSidecarBytes, writeSidecarBytes } from "/src/vm/opfs-volume-open.mjs";
import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_COURANT,
  decoderEnTeteDeVolume,
  identifiantVolumeEnTexte,
  tailleDeFichier,
} from "/src/vm/volume-chiffre-format.mjs";
import {
  ARCHIVE_MAGIC,
  PREAMBLE_BYTES,
  backendSource,
  writeArchive,
} from "/src/vm/volume-export.mjs";
import { importArchive } from "/src/vm/volume-import.mjs";
import { parseManifest } from "/src/vm/volume-manifest.mjs";

/**
 * RÉCUPÈRE le disque applicatif, puis en rend un accès BRUT — le chemin v4 de `ouvrirPourExport`,
 * écrit ici plutôt qu'importé.
 *
 * `src/vm/export-du-fichier.mjs` importe le lecteur de la migration (`migration-source-chiffree.mjs`)
 * pour solder un volume v3, et aucun chemin SERVI ne doit l'atteindre, même transitivement
 * (`tests/unit/vm-perimetre-du-sans-racine.test.mjs`, ADR 0037). La coquille n'écrit que du v4 :
 * elle n'a besoin que de la moitié v4 — ouvrir transactionnellement pour rejouer la génération
 * validée, refermer, reprendre un handle brut, et CONSTATER que le fichier repris est celui qu'on
 * vient de refermer (taille et identifiant d'en-tête).
 */
export async function ouvrirLeDisque({ name, cle, openHandle }) {
  const backend = await openOpfsVolume({
    name,
    cle,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    journal: new BlockJournal(),
    openHandle,
  });
  let taille;
  try {
    taille = tailleDeFichier({
      formatVersion: FORMAT_VOLUME_COURANT,
      tailleLogique: backend.size(),
    });
  } finally {
    await backend.close();
  }
  const brut = await ouvrirVolumeBrut({ name, openHandle });
  const lu = decoderEnTeteDeVolume(await brut.read(0, EN_TETE_OCTETS), {
    formatVersion: FORMAT_VOLUME_COURANT,
  });
  const porte = lu.valide ? identifiantVolumeEnTexte(lu.enTete.identifiantVolume) : null;
  if (brut.size() === taille && porte === IDENTIFIANT_DU_COFFRE) return brut;
  await brut.close();
  throw new StorageError(
    STORAGE_ERROR_CODES.identiteVolume,
    "Sauvegarde refusée : le disque a changé entre la récupération et la copie.",
    { volume: name },
  );
}

/** Plafond de l'en-tête lu pour le refus anticipé : celui que `readArchive` admet. */
const EN_TETE_D_ARCHIVE_MAX = 1024 * 1024;

/** Les primitives du SUPPORT réel. Une épreuve sous Node les remplace par un magasin double. */
export const PRIMITIVES_OPFS = Object.freeze({
  observer: statOpfsVolume,
  async lireEnTete(nom) {
    try {
      const fichier = await openOpfsVolumeFile(nom);
      return new Uint8Array(await fichier.slice(0, EN_TETE_OCTETS).arrayBuffer());
    } catch {
      return null;
    }
  },
  async lireVoisin(nom) {
    try {
      return await readSidecarBytes(nom);
    } catch {
      return null;
    }
  },
  retirer: removeOpfsVolume,
  ecrireVoisin: writeSidecarBytes,
  ouvrirLeDisque,
  async ouvrirLePuits(nom) {
    const handle = await openOpfsSyncAccess(nom);
    return { handle, puits: createOpfsArchiveSink(handle, { volume: nom }) };
  },
  fichier: openOpfsVolumeFile,
  cibleDImport: (nom) => createOpfsImportTarget(nom),
  budget: () =>
    globalThis.navigator?.storage === undefined
      ? null
      : createStorageBudget(bindNavigatorStorage(globalThis.navigator.storage)),
  lireLeDescripteur,
});

/**
 * Branche les trois gestes sur le Worker de confiance.
 *
 * @param {{ interne: object, support: () => object, cleDeVolume: () => Promise<Uint8Array>,
 *           enBattant: (correlation: string | null, geste: () => Promise<unknown>) => Promise<unknown>,
 *           repondre: (type: string, correlation: string | null, corps: object) => void,
 *           repondreAvecArchive: (type: string, correlation: string | null, corps: object) => void,
 *           arreterLApplication: () => Promise<unknown>, oublierLeMoyenRetenu: () => void,
 *           exigerUnVolumeAtteignable: () => void, primitives?: object }} dependances
 */
export function brancherLaPortabilite(dependances) {
  const prim = dependances.primitives ?? PRIMITIVES_OPFS;
  let gestesLongsEnCours = 0;
  const contexte = { ...dependances, prim };

  return Object.freeze({
    /** Constate l'emplacement : l'inventaire et le déverrouillage en ont besoin AVANT d'agir. */
    constater: () => constaterLEmplacement(prim),

    /** Le refus d'un message arrivé pendant un geste long, jugé HORS de la file. */
    refusALArrivee: (type) => refusPendantUnGesteLong(type, gestesLongsEnCours),

    /** Compte un geste long dès son ARRIVÉE, et rend de quoi le décompter à sa fin. */
    entrer(type) {
      if (!GESTES_LONGS.has(type)) return () => {};
      gestesLongsEnCours += 1;
      return () => {
        gestesLongsEnCours -= 1;
      };
    },

    /** Sert un geste de portabilité, ou rend `null` si le type n'en est pas un. */
    servir(type, message, correlation) {
      if (type === TYPES_PRIVILEGIES.sauvegarder) return sauvegarder(contexte, correlation);
      if (type === TYPES_PRIVILEGIES.restaurer) return restaurer(contexte, message, correlation);
      if (type === TYPES_PRIVILEGIES.revoquerEnUrgence) return revoquer(contexte, correlation);
      return null;
    },
  });
}

/** @param {string} code @param {string} [message] */
function refus(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** Exige un coffre OUVERT, avec sa clé de session. */
function exigerUnCoffreOuvert({ interne }) {
  if (interne.etat !== ETATS_DU_VOLUME.ouvert || interne.kek === null) {
    throw refus(CODES_REFUS_COQUILLE.volumeVerrouille);
  }
}

// --- SAUVEGARDER -----------------------------------------------------------------------------------

async function sauvegarder(contexte, correlation) {
  const { interne, prim } = contexte;
  contexte.exigerUnVolumeAtteignable();
  exigerUnCoffreOuvert(contexte);
  const refusDuCoffre = refusDOuverture(await constaterLEmplacement(prim));
  if (refusDuCoffre !== null) throw refus(refusDuCoffre);
  const octetsDuManifeste = await prim.lireVoisin(manifestSidecarName(NOM_DU_VOLUME_APPLICATIF));
  if (octetsDuManifeste === null) throw refus(CODES_REFUS_COQUILLE.applicationNonInstallee);
  const manifeste = parseManifest(octetsDuManifeste);

  return contexte.enBattant(correlation, async () => {
    // Le POINT DE CONTRÔLE (ADR 0039, décision 3) : l'application est arrêtée d'abord. Rails ne
    // peut plus écrire, `close()` a attendu toute E/S acceptée, et le handle exclusif est libre.
    const applicationArretee = interne.application !== null;
    if (applicationArretee) await contexte.arreterLApplication();
    const recuperation = await construireEnveloppeDeRecuperation({
      support: contexte.support(),
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      kek: interne.kek,
    });
    const { ecrite, archive } = await ecrireSansLaisserDeCopie(contexte, manifeste, recuperation);
    contexte.repondreAvecArchive(TYPES_PRIVILEGIES.sauvegarderReponse, correlation, {
      [CHAMP_DE_L_ARCHIVE]: archive,
      taille: ecrite.archiveLength,
      empreinte: ecrite.digest,
      coherence: { kind: ecrite.consistency.kind, detail: ecrite.consistency.detail },
      recuperationEmportee: recuperation !== null,
      versionEnveloppe: recuperation === null ? null : recuperation.version,
      applicationArretee,
      etat: interne.etat,
      barrieres: interne.barrieres,
    });
  });
}

/** La taille des tranches dans lesquelles l'archive est détachée de sa copie OPFS. */
const TRANCHE_DE_COPIE = 4 * 1024 * 1024;

/**
 * Écrit l'archive, la DÉTACHE de l'OPFS, puis retire la copie — AUCUNE copie ne survit au geste qui
 * l'a créée (revue de la PR #208, constat 4 ; ADR 0039, décision 3).
 *
 * La copie `coquille-sauvegarde` restait jusqu'à la sauvegarde suivante : un fichier de l'origine qui
 * porte la page de récupération et le disque, et que le code ouvrait encore après une révocation
 * d'urgence. Elle est retirée ici quoi qu'il arrive, et ce qui est rendu à la page n'en dépend pas :
 * un `File` issu de l'OPFS devient illisible quand son fichier disparaît, d'où la copie par
 * tranches dans un `Blob` du navigateur, hors de l'OPFS, qui vit tant que la page le tient.
 *
 * Une coupure entre la copie et son retrait — l'onglet fermé à cet instant — laisse un RÉSIDU. Deux
 * gestes le retirent : la sauvegarde suivante, avant d'écrire, et la révocation d'urgence, avant
 * d'acquitter.
 */
async function ecrireSansLaisserDeCopie(contexte, manifeste, recuperation) {
  const { prim } = contexte;
  let rendu;
  try {
    const ecrite = await ecrireLArchive(contexte, manifeste, recuperation);
    rendu = { ecrite, archive: await copieDetachee(await prim.fichier(FICHIER_DE_SAUVEGARDE)) };
  } catch (erreur) {
    // Le refus d'origine est celui qu'il faut rendre. Un retrait qui échoue à son tour laisse un
    // résidu que les deux gestes nommés plus haut retirent ; il ne doit pas masquer la cause.
    await prim.retirer(FICHIER_DE_SAUVEGARDE).catch(() => false);
    throw erreur;
  }
  await prim.retirer(FICHIER_DE_SAUVEGARDE);
  return rendu;
}

/** Recopie un fichier par tranches dans un `File` qui ne dépend plus de l'OPFS. */
async function copieDetachee(fichier) {
  const tranches = [];
  for (let debut = 0; debut < fichier.size; debut += TRANCHE_DE_COPIE) {
    const tranche = await fichier.slice(debut, debut + TRANCHE_DE_COPIE).arrayBuffer();
    tranches.push(new Blob([tranche]));
  }
  return new File(tranches, FICHIER_DE_SAUVEGARDE);
}

/**
 * Écrit l'archive dans le fichier OPFS de sauvegarde : récupérer, puis copier sous l'accès brut, en
 * flux. La clé de volume sert à rejouer la génération validée et à sceller l'ENGAGEMENT ; elle est
 * effacée quoi qu'il arrive.
 */
async function ecrireLArchive(contexte, manifeste, recuperation) {
  const { prim } = contexte;
  const cle = await contexte.cleDeVolume();
  try {
    await prim.retirer(FICHIER_DE_SAUVEGARDE);
    const brut = await prim.ouvrirLeDisque({ name: NOM_DU_VOLUME_APPLICATIF, cle });
    let ouvert;
    try {
      ouvert = await prim.ouvrirLePuits(FICHIER_DE_SAUVEGARDE);
      const resultat = await writeArchive({
        source: backendSource(brut),
        sink: ouvert.puits,
        manifest: manifeste,
        consistency: COHERENCE_DE_LA_SAUVEGARDE,
        cle,
        recovery: recuperation,
      });
      ouvert.handle.flush();
      return resultat;
    } finally {
      ouvert?.handle.close();
      await brut.close();
    }
  } finally {
    cle.fill(0);
  }
}

// --- RESTAURER -------------------------------------------------------------------------------------

async function restaurer(contexte, message, correlation) {
  const { interne, prim } = contexte;
  contexte.exigerUnVolumeAtteignable();
  const archive = message?.[CHAMP_DE_L_ARCHIVE];
  if (!estUneArchive(archive)) throw refus(CODES_REFUS_COQUILLE.messageMalforme);
  // Un coffre OUVERT dans ce Worker est un emplacement occupé, quoi que dise le support.
  if (interne.etat === ETATS_DU_VOLUME.ouvert) throw refus(CODES_REFUS_COQUILLE.emplacementOccupe);
  const decision = decisionDeRestauration(await constaterLEmplacement(prim));
  if (decision.code !== null) throw refus(decision.code);
  const tete = enTeteDArchive(await lireLaTete(archive));
  // L'IDENTITÉ d'abord, avant tout octet écrit (revue de la PR #208, constat 5) : rien n'est muré.
  if (tete.lisible && !tete.duCoffre) throw refus(CODES_REFUS_COQUILLE.archiveDUnAutreCoffre);
  if (tete.lisible && !tete.emporteUneRecuperation) {
    throw refus(CODES_REFUS_COQUILLE.archiveSansRecuperation);
  }
  const lu = await prim.lireLeDescripteur();
  const expectations = lu.present ? { app: { id: lu.descripteur.application.id } } : {};

  return contexte.enBattant(correlation, async () => {
    // La RÉPARATION d'une restauration coupée (ADR 0039, décision 5) : ce qu'elle a laissé ne
    // s'ouvre par rien — aucun manifeste —, et l'utilisateur tient encore l'archive qui le redonne.
    //
    // L'ORDRE est la garde (revue de la PR #208, constat 3) : `coquille` d'abord, qui emporte
    // l'enveloppe `coquille.cles`, puis le disque. Coupée entre les deux, la réparation laisse un
    // disque SANS enveloppe — une restauration interrompue, que le même geste reprend. Dans l'ordre
    // inverse, elle laissait une enveloppe sans disque : un « coffre » que le code ouvrait.
    if (decision.reparer) {
      await prim.retirer(VOLUME_DE_LA_COQUILLE);
      await prim.retirer(NOM_DU_VOLUME_APPLICATIF);
    }
    const cible = cibleDuCoffre(prim.cibleDImport(NOM_DU_VOLUME_APPLICATIF), {
      ecrireLEnveloppe: (page) =>
        prim.ecrireVoisin(ENVELOPPE_DU_COFFRE, fichierDEnveloppeDepuisLaPage(page)),
    });
    const rapport = await importArchive({
      source: sourceDuFichier(archive),
      target: cible,
      expectations,
      budget: prim.budget(),
    });
    interne.etat = ETATS_DU_VOLUME.verrouille;
    interne.kek = null;
    contexte.oublierLeMoyenRetenu();
    contexte.repondre(TYPES_PRIVILEGIES.restaurerReponse, correlation, {
      restauree: true,
      reparee: decision.reparer,
      taille: rapport.archiveLength,
      empreinte: rapport.contentDigest,
      empreinteRelue: rapport.verifiedDigest,
      coherence: rapport.archiveConsistency,
      versionEnveloppe: rapport.nouvelleReference,
      application: rapport.manifest.app?.id ?? null,
      etat: interne.etat,
      // Le volume `coquille` de cette origine n'existe pas encore : il naîtra NEUF au premier
      // déverrouillage, sous sa constante, et son compte de barrières part de celui de ce Worker.
      volumeCoquille: "a-naitre",
      barrieres: interne.barrieres,
    });
  });
}

/** Les premiers octets d'une archive : le préambule, puis l'en-tête qu'il annonce, borné. */
async function lireLaTete(archive) {
  const preambule = new Uint8Array(await archive.slice(0, PREAMBLE_BYTES).arrayBuffer());
  if (preambule.byteLength < PREAMBLE_BYTES) return preambule;
  const longueur = new DataView(preambule.buffer).getUint32(ARCHIVE_MAGIC.byteLength, false);
  const fin = PREAMBLE_BYTES + Math.min(longueur, EN_TETE_D_ARCHIVE_MAX);
  return new Uint8Array(await archive.slice(0, fin).arrayBuffer());
}

/** L'archive lue PAR TRANCHES, jamais chargée entière. */
function sourceDuFichier(archive) {
  return {
    byteLength: archive.size,
    async read(offset, longueur) {
      return new Uint8Array(await archive.slice(offset, offset + longueur).arrayBuffer());
    },
  };
}

// --- RÉVOQUER EN URGENCE ---------------------------------------------------------------------------

async function revoquer(contexte, correlation) {
  const { interne, prim } = contexte;
  exigerUnCoffreOuvert(contexte);
  const support = contexte.support();
  const avant = await inventorierEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE });
  // L'emplacement conservé est celui que la KEK de la session ouvre (ADR 0026) : c'est celui qui
  // vient d'ouvrir ce coffre, et aucun identifiant n'est fourni par la page.
  await revoquerToutSauf({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: interne.kek });
  const apres = await inventorierEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE });
  // Une copie de sauvegarde RÉSIDUELLE porte l'ancienne page de récupération : le code révoqué
  // l'ouvrirait encore. Elle part AVANT l'acquittement (revue de la PR #208, constat 4).
  const copieDeSauvegardeRetiree = (await prim.observer(FICHIER_DE_SAUVEGARDE)).present;
  if (copieDeSauvegardeRetiree) await prim.retirer(FICHIER_DE_SAUVEGARDE);
  const bilan = Object.freeze({
    ...bilanDeRevocation({ avant, apres }),
    copieDeSauvegardeRetiree,
  });
  interne.version = bilan.versionEnveloppe;
  interne.revocation = bilan;
  contexte.oublierLeMoyenRetenu();
  contexte.repondre(TYPES_PRIVILEGIES.revoquerEnUrgenceReponse, correlation, {
    ...bilan,
    etat: interne.etat,
    barrieres: interne.barrieres,
  });
}
