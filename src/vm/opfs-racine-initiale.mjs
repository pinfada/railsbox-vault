// La RACINE INITIALE, et ce qui autorise une ouverture sans racine (#181, ADR 0033).
//
// Depuis #181, **aucun volume légitime n'est sans racine** : c'est ce qui rend refusable un volume
// restauré dont on a retiré l'engagement, et donc ce qui referme le CRITICAL de la revue externe du
// 10 septembre 2026. Trois motifs autorisent une ouverture à écrire cette racine, et il n'y en a pas
// de quatrième :
//
//  - une NAISSANCE — le fichier vient d'être alloué et scellé par ce geste même ;
//  - une MIGRATION — le fichier vient d'être réécrit en v3 par ce geste même ;
//  - un ENGAGEMENT d'archive déposé par la restauration, vérifié ici sous la clé, AVANT tout clair.
//
// Les deux premiers sont des gestes du PRODUIT, et depuis la revue de sécurité de la PR #184 il faut
// dire à quelle condition : « celui qui vient d'écrire le fichier entier SAIT que ces octets sont les
// siens » n'est vrai que tant que le geste qui a ÉCRIT et le geste qui DATE sont le même, ou qu'une
// EMPREINTE les relie. La migration tient le fichier d'un bout à l'autre ; une naissance aussi. Un
// versement hors transaction, LUI, ferme le fichier avant que la datation ne le rouvre — et cette
// fenêtre n'appartient à personne. C'est pourquoi le versement rend l'empreinte de ce qu'il a écrit,
// prise sous SA propre exclusivité, et pourquoi la datation la confronte avant d'écrire la racine.
// Le troisième motif est celui qui se prouve de bout en bout, et il se prouve sous la clé.
//
// Extrait de `opfs-volume-ouverture.mjs`, qui a franchi le plafond de 800 lignes en accueillant
// cette tranche. Ce module ne SAISIT aucun fichier de volume : il reçoit un backend déjà ouvert, ou
// un accès brut, et il ne connaît des voisins que ceux que `opfs-generation-voisins.mjs` lui ouvre.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { createFaultPlan } from "./fault-plan.mjs";
import { JournalDeGeneration } from "./generation-journal.mjs";
import { autorisationDeCreation, constaterOuverture } from "./generation-recuperation.mjs";
import { ouvrirGeneration, rendreSansMasquer, saisirVoisin } from "./opfs-generation-voisins.mjs";
import { readCountFailure } from "./opfs-error-mapping.mjs";
import {
  engagementSidecarName,
  generationJournalName,
  temoinSequenceName,
} from "./opfs-sync-access.mjs";
import {
  ENGAGEMENT_FICHIER_OCTETS,
  decoderFichierDEngagement,
  ouvrirEngagement,
} from "./archive-engagement.mjs";
import { octetsEnHex } from "./format-chiffre/octets.mjs";
import { STORAGE_ERROR_CODES, StorageError, creationNonConfirmee } from "./storage-errors.mjs";
import { dispositionDuVolume } from "./volume-chiffre-format.mjs";

/**
 * MOTIFS qui autorisent une ouverture sans racine (#181). Il n'y en a pas d'autre.
 *
 * `creation` et `migration` sont des gestes du PRODUIT : ils écrivent le fichier de volume entier et
 * savent donc, sans rien vérifier, que ces octets-là sont ceux qu'ils viennent de poser.
 * `engagement` est le seul motif qui se PROUVE, et il se prouve sous la clé.
 */
export const MOTIFS_DE_RACINE_INITIALE = Object.freeze({
  creation: "creation",
  migration: "migration",
  engagement: "engagement",
});

/** Refus typé d'un engagement présent qui n'autorise pas cette ouverture. Une seule cause rendue. */
function engagementInvalide(name, detail, contexte = {}) {
  return new StorageError(
    STORAGE_ERROR_CODES.engagementInvalide,
    `Volume « ${name} » refusé : l'engagement déposé à côté de lui n'autorise pas cette ouverture — ${detail} Il atteste qu'une archive s'est engagée sur un fichier précis ; ce qui est sur le support n'est pas ce fichier-là. Le remède est de restaurer de nouveau depuis l'archive. Aucun octet n'est lu.`,
    { volume: name, ...contexte },
  );
}

/**
 * L'AUTORISATION d'écrire la racine initiale, telle que l'ouverture d'un volume OPFS la construit.
 *
 * Trois motifs, et le troisième est le seul qui exige une preuve :
 *
 *  - une NAISSANCE — le fichier vient d'être alloué et scellé par ce geste même ;
 *  - une MIGRATION — le fichier vient d'être réécrit en v3 par ce geste même ;
 *  - un ENGAGEMENT d'archive déposé par la restauration, vérifié ici sous la clé, AVANT tout clair.
 *
 * Hors de ces trois cas, l'autorisation rend `null` et le magasin REFUSE le volume : depuis #181,
 * un volume sans racine n'est plus un état légitime.
 */
export function autorisationSansRacine({
  name,
  motif,
  backend,
  cle,
  openHandle,
  empreinteVersee = null,
  tientLeFichier = false,
}) {
  if (motif === MOTIFS_DE_RACINE_INITIALE.migration) return autorisationDeCreation(motif);
  if (motif === MOTIFS_DE_RACINE_INITIALE.creation) {
    // Une NAISSANCE tient son fichier : elle vient de l'allouer et de le sceller sous CETTE
    // exclusivité, et personne n'a pu s'y glisser. Une DATATION de création, non : le versement a
    // relâché le fichier avant elle. L'empreinte est ce qui referme cette fenêtre.
    if (tientLeFichier) return autorisationDeCreation(motif);
    return { autoriser: () => confronterLEmpreinteVersee({ name, backend, empreinteVersee }) };
  }
  return {
    autoriser: () => verifierLEngagementDepose({ name, backend, cle, openHandle }),
    // Une racine fait autorité : le voisin d'engagement n'a plus de rôle, et un voisin qui traîne
    // est un reliquat ou un geste. On le VIDE, et le rapport d'ouverture le publie (revue de
    // sécurité de la PR #184, constat 9) : un contrôle qu'on ne publie pas finit par être supposé
    // actif, et un état qu'on laisse sans le dire finit par être cru voulu.
    ecarter: () => viderLeVoisinDEngagement({ name, openHandle }),
  };
}

/**
 * CONFRONTE l'empreinte que le VERSEMENT a rendue à celle du fichier que la datation trouve (#181,
 * revue de sécurité de la PR #184, constat 1).
 *
 * ## Ce que cette confrontation achète
 *
 * `installerSiNecessaire` verse le disque hors transaction, FERME le backend, puis date. Entre les
 * deux, le fichier de volume n'est tenu par personne : un adversaire qui sait écrire dans l'OPFS
 * (ADR 0019 § 6.9) peut y poser le fichier d'un AUTRE volume, et la datation bénissait alors des
 * octets que le produit n'a jamais écrits — le CRITICAL de #181, déplacé du chemin de restauration
 * vers le chemin de création.
 *
 * Le versement rend l'empreinte du fichier qu'il vient d'écrire, PRISE SOUS SA PROPRE EXCLUSIVITÉ,
 * c'est-à-dire avant de relâcher le handle : ce n'est pas une relecture qu'un tiers aurait pu
 * influencer, c'est le constat de ce que ce geste-là a laissé. La datation rouvre le fichier sous
 * une exclusivité NEUVE et le rehache. Deux empreintes égales disent que l'intervalle n'a rien
 * changé ; c'est ce qui rend vraie la phrase « celui qui vient d'écrire le fichier entier SAIT que
 * ces octets sont les siens ».
 *
 * ## Une empreinte ABSENTE est un refus, jamais un laissez-passer
 *
 * Un appelant qui ne rend pas d'empreinte — un versement d'avant cette garde — n'atteste rien. Le
 * traiter comme « rien à confronter, donc autorisé » rouvrirait la fenêtre pour quiconque oublie un
 * paramètre. La direction sûre est le refus.
 */
async function confronterLEmpreinteVersee({ name, backend, empreinteVersee }) {
  if (typeof empreinteVersee !== "string" || empreinteVersee.length === 0) {
    throw creationNonConfirmee(
      name,
      "le versement n'a rendu aucune empreinte de ce qu'il a écrit.",
    );
  }
  const empreinte = await backend.empreinteDuFichier();
  if (empreinte !== empreinteVersee) {
    throw creationNonConfirmee(name, "le fichier trouvé n'est pas celui que le versement a écrit.");
  }
  return { motif: MOTIFS_DE_RACINE_INITIALE.creation, consommer: async () => {} };
}

/**
 * VIDE le voisin d'engagement d'un volume dont une racine fait autorité, et dit s'il portait
 * quelque chose.
 *
 * Vidé, et non supprimé : c'est exactement le geste de la CONSOMMATION (`consommer`), et pour la
 * même raison — un Worker n'a pas de handle de répertoire, donc pas de suppression d'entrée, et la
 * troncature est de toute façon le geste sûr sous coupure. Un voisin de zéro octet EST absent pour
 * `lireLeVoisinDEngagement`, `voisinsDunVolume` le connaît toujours, et le balayage des orphelins
 * de #145 ne réécrit pas un voisin déjà vide.
 */
async function viderLeVoisinDEngagement({ name, openHandle }) {
  const handle = await saisirVoisin(openHandle, engagementSidecarName(name), {
    operation: "ecarter-engagement",
    volume: name,
  });
  try {
    if (handle.getSize() === 0) return false;
    handle.truncate(0);
    handle.flush();
    return true;
  } finally {
    rendreSansMasquer(handle);
  }
}

/**
 * LIT le voisin `<volume>.engagement`, le CONFRONTE au fichier, et rend l'autorisation ou `null`.
 *
 * ## L'ordre, et ce qu'il achète
 *
 * Le voisin est lu, décodé, puis son descripteur est confronté au volume qu'on ouvre — identité,
 * géométrie — AVANT que la moindre empreinte ne soit calculée : un engagement qui parle d'un autre
 * volume ne mérite pas qu'on relise un demi-gibioctet pour s'en apercevoir. L'empreinte du fichier
 * vient ensuite, et l'ouverture GCM en dernier. Rien de tout cela ne déchiffre un secteur : le
 * fichier est haché tel qu'il est sur le support, c'est-à-dire tel que l'archive le transportait.
 *
 * ## Une seule cause de refus est rendue
 *
 * Étiquette forgée, sel modifié, descripteur contredit, empreinte qui ne concorde pas : tout cela
 * dit « cet engagement ne vaut pas pour ce fichier-ci ». Les distinguer donnerait à un adversaire un
 * oracle sur ce qu'il a manqué. Le CONTEXTE de l'erreur porte le détail pour l'exploitant ; le CODE
 * est le même.
 */
async function verifierLEngagementDepose({ name, backend, cle, openHandle }) {
  const nom = engagementSidecarName(name);
  const octets = await lireLeVoisinDEngagement(name, openHandle, nom);
  // ABSENT : il n'y a rien à vérifier, et rien n'autorise. Le magasin rendra `VOLUME_SANS_RACINE`,
  // qui nomme l'état — « ce volume n'a ni racine ni engagement » — plutôt que de laisser croire
  // qu'un engagement a été présenté et refusé.
  if (octets === null) return null;

  const lu = decoderFichierDEngagement(octets);
  if (!lu.valide) throw engagementInvalide(name, lu.raison, { voisin: nom });
  const declare = lu.engagement.descripteur;
  const disposition = backend.disposition;
  const porte = {
    identifiantVolume: backend.identifiantVolume,
    tailleSupport: disposition.tailleSupport,
    tailleLogique: disposition.tailleLogique,
    tailleDeSecteur: SECTOR_SIZE,
  };
  for (const champ of Object.keys(porte)) {
    if (declare[champ] !== porte[champ]) {
      throw engagementInvalide(name, `il décrit un autre volume (« ${champ} »).`, {
        voisin: nom,
        champ,
      });
    }
  }

  // L'EMPREINTE du fichier entier : c'est ce que l'engagement scelle, et le seul geste coûteux de
  // cette vérification. Elle est calculée par le backend, qui ne rend qu'un verdict — jamais du
  // chiffré (`empreinteDuFichier`).
  const empreinte = await backend.empreinteDuFichier();
  const scellee = await ouvrirEngagement({ cleMaitresse: cle, engagement: lu.engagement });
  if (scellee === null)
    throw engagementInvalide(name, "son étiquette ne vérifie pas.", { voisin: nom });
  if (octetsEnHex(scellee) !== empreinte) {
    throw engagementInvalide(name, "l'empreinte du fichier n'est pas celle qu'il scelle.", {
      voisin: nom,
    });
  }
  return {
    motif: MOTIFS_DE_RACINE_INITIALE.engagement,
    // CONSOMMÉ une fois, et seulement une fois la racine initiale durable. Un engagement relu à
    // chaque ouverture serait une fenêtre de plus ; une fois la racine écrite, c'est la fraîcheur
    // (ADR 0019) qui prend le relais, et le voisin n'a plus de rôle.
    consommer: async () => {
      const handle = await saisirVoisin(openHandle, nom, {
        operation: "consommer-engagement",
        volume: name,
      });
      try {
        handle.truncate(0);
        handle.flush();
      } finally {
        rendreSansMasquer(handle);
      }
    },
  };
}

/**
 * Lit le voisin d'engagement, ou rend `null` s'il n'y en a pas. Un fichier VIDE est un voisin absent.
 *
 * **Une TAILLE qui n'est pas exactement celle du fichier d'engagement est REFUSÉE d'emblée**, et
 * c'est le constat 4 de la revue de sécurité de la PR #184 : lire `min(taille, 180)` puis décoder
 * laissait passer un voisin PLUS LONG — engagement légitime suivi d'une queue arbitraire —, que
 * `decoderFichierDEngagement` acceptait sans réserve. La queue n'était ni lue ni authentifiée, donc
 * la promesse tenait ; mais ce dépôt tient la règle inverse pour l'archive (`assertRienEnQueue`), et
 * une garde qui promet plus que le code ne fait est une garde qu'on cesse de relire.
 *
 * Un voisin absent et un voisin illisible restent DISTINCTS : le premier rend `null`, et le magasin
 * refusera par `VOLUME_SANS_RACINE` — « rien n'a été présenté » ; le second refuse ici, par
 * `ENGAGEMENT_INVALIDE` — « ce qui est présenté ne tient pas ».
 */
async function lireLeVoisinDEngagement(name, openHandle, nom) {
  const handle = await saisirVoisin(openHandle, nom, {
    operation: "open-engagement",
    volume: nom,
  });
  try {
    const taille = handle.getSize();
    if (taille === 0) return null;
    if (taille !== ENGAGEMENT_FICHIER_OCTETS) {
      throw engagementInvalide(
        name,
        `il fait ${taille} octets, et un engagement en fait ${ENGAGEMENT_FICHIER_OCTETS}.`,
        { voisin: nom, taille },
      );
    }
    const octets = new Uint8Array(ENGAGEMENT_FICHIER_OCTETS);
    const lus = handle.read(octets, { at: 0 });
    // Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite (#73) : un support qui rend
    // un code d'échec casté en non signé n'a pas fait une lecture courte, il n'a rien lu.
    const echec = readCountFailure(lus, {
      requested: octets.byteLength,
      volume: nom,
      offset: 0,
      operation: "read-engagement",
    });
    if (echec !== null) throw echec;
    return octets;
  } finally {
    rendreSansMasquer(handle);
  }
}

/**
 * VIDE le journal et le témoin d'une création, après avoir CONSTATÉ qu'ils n'en portent pas d'autre.
 *
 * Le constat lit les racines sans clé — marqueur, format, séquence, génération, nombre d'entrées —
 * exactement comme l'ouverture le fait au pas 4 du § 7.3, et sous la même taille LOGIQUE. Ces champs ne sont pas authentifiés ; ils
 * suffisent ici, parce que la garde protège contre une MÉPRISE d'appelant, pas contre un adversaire :
 * qui peut écrire le journal peut de toute façon l'effacer.
 */
export async function ecarterLeJournalDeCreation(name, openHandle, tailleLogique) {
  const nomDuJournal = generationJournalName(name);
  const handle = await saisirVoisin(openHandle, nomDuJournal, {
    operation: "open-generation",
    volume: name,
  });
  const journal = new JournalDeGeneration(name, handle);
  let compteurs;
  try {
    // La taille LOGIQUE est présentée au décodeur, et il la faut : une racine authentique écrite
    // pour un volume d'une autre taille est refusée par `decoderRacine`, et lui présenter `null`
    // ferait donc passer TOUTE racine pour abîmée — c'est-à-dire refuser toute datation.
    const constat = constaterOuverture({ journal, tailleVolume: tailleLogique });
    exigerCreationSeule(name, constat);
    compteurs = compteursDeLaRacineEcartee(constat.racine);
    journal.tronquer(0);
  } finally {
    rendreSansMasquer(handle);
  }
  const temoin = await saisirVoisin(openHandle, temoinSequenceName(name), {
    operation: "open-temoin",
    volume: name,
  });
  try {
    temoin.truncate(0);
    temoin.flush();
  } finally {
    rendreSansMasquer(temoin);
  }
  return compteurs;
}

/**
 * Les COMPTEURS que la racine de naissance publiait, RENDUS avant qu'elle ne soit écartée (#182).
 *
 * ## Pourquoi ce geste existe
 *
 * Dater une création tronque le journal, donc écarte la racine de la naissance — et cette racine
 * était le seul endroit où vivaient les 2^20 scellements que la création venait de consommer. Sans
 * ce report, la racine que la datation écrit repartirait de ZÉRO, et le budget de la clé du volume
 * perdrait en une fois un deux-millième de son plafond sans que rien ne le signale.
 *
 * C'est exactement la sous-estimation que #182 a trouvée ailleurs, et elle se refermait ici par le
 * geste même qui prétendait la fermer. Le report est ce qui rend la règle de clôture vraie sur le
 * chemin 2 de `tests/unit/vm-cloture-par-racine.test.mjs`.
 *
 * Une racine qui ne publie qu'un compteur — celle d'un volume antérieur à la v4 — rend `null` pour
 * le second : l'ouverture qui suit décidera, et zéro aurait été un budget qu'on croit neuf.
 */
function compteursDeLaRacineEcartee(racine) {
  if (racine === null || racine === undefined) return null;
  return Object.freeze({
    volume: racine.scellementsCumulesVolume,
    journal: racine.scellementsCumulesJournal,
  });
}

/**
 * Refuse un journal qui porte autre chose que LA SEULE racine initiale d'une création.
 *
 * **La racine de naissance est EXIGÉE, jamais tolérée absente**, et c'est le constat 2 de la revue
 * de sécurité et le constat 1 de la revue de format de la PR #184. La première rédaction ne jugeait
 * la racine que `si elle existe` : un journal VIDE passait donc la garde — c'est-à-dire exactement
 * l'état qu'une RESTAURATION laisse derrière elle, et le mélange A/C de #181 se faisait dater puis
 * rendre en clair par un geste que `opfs-block-backend.mjs` exporte.
 *
 * Le discriminant est exact et il est gratuit : une création écrit toujours sa racine de naissance
 * — séquence 0, génération 0, aucune entrée — avant de verser, et une restauration n'en écrit
 * aucune. Aucun chemin du produit ne menait au défaut ; la garde est ce qui empêche la prochaine
 * tranche d'y mener sans le voir.
 */
function exigerCreationSeule(name, constat) {
  const racine = constat.racine;
  const enService =
    constat.abimees > 0 ||
    constat.chargePresente > 0 ||
    racine === null ||
    racine.sequence > 0 ||
    racine.generation > 0 ||
    racine.nombreEntrees > 0;
  if (!enService) return;
  const etat =
    racine === null
      ? "son journal ne porte AUCUNE racine, alors qu'une création en écrit une à la naissance — c'est l'état que laisse une restauration, pas une création"
      : "son journal ne porte pas la seule racine initiale d'une création";
  throw new StorageError(
    STORAGE_ERROR_CODES.generationPending,
    `Datation de création refusée sur le volume « ${name} » : ${etat}. Dater écarterait ce que ce journal contient, c'est-à-dire peut-être une écriture acquittée. Ce geste est réservé à une création qui vient d'écrire son fichier hors transaction.`,
    { volume: name },
  );
}

/**
 * ÉCRIT la RACINE INITIALE d'un volume tenu par un ACCÈS BRUT (#181).
 *
 * C'est le geste dont la MIGRATION v2 → v3 a besoin : elle réécrit le fichier entier par un accès
 * brut — le backend chiffré serait circulaire, puisqu'il exigerait l'en-tête v3 que la conversion a
 * justement pour objet d'écrire — et elle doit pourtant dater son résultat, comme une création.
 *
 * Il est appelé AVANT que le manifeste migré ne soit inscrit. Une coupure entre les deux laisse un
 * volume NON IDENTIFIÉ, que le boot refuse et qu'une seconde migration reprend : le seul état sûr
 * des deux. L'ordre inverse aurait laissé un volume déclaré migré et pourtant refusé faute de
 * racine, c'est-à-dire un volume sain qu'aucun remède ne rouvre.
 *
 * @param {{ name: string, brut: object, scellement: object, tailleLogique: number,
 *           openHandle: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 *   `brut` est le contrat de `ouvrirVolumeBrut` : `read`, `write`, `flush`.
 * @returns {Promise<object>} le rapport d'ouverture, qui publie la racine écrite et son motif
 */
export async function poserLaRacineInitialeSurAccesBrut({
  name,
  brut,
  scellement,
  tailleLogique,
  openHandle,
}) {
  // L'ADAPTATEUR donne à `sourceDeFraicheur` la seule chose qu'elle demande d'un backend : où vit la
  // région d'authentification, et comment la lire. Le construire ici plutôt que de recopier la
  // source de fraîcheur évite qu'une seconde copie diverge de la première.
  const adaptateur = {
    disposition: dispositionDuVolume(tailleLogique),
    lireRegionAuth: (offset, longueur) => brut.read(offset, longueur),
  };
  const magasin = await ouvrirGeneration({
    name,
    size: tailleLogique,
    backend: {
      ...adaptateur,
      lireSupportBrut: (offset, longueur) => brut.read(offset, longueur),
      ecrireSupportBrut: (offset, octets) => brut.write(offset, octets),
      barriereSupportBrute: () => brut.flush(),
    },
    scellement,
    openHandle,
    seuilPointDeControle: undefined,
    fautesFraicheur: createFaultPlan(),
    sansRacine: autorisationSansRacine({
      name,
      motif: MOTIFS_DE_RACINE_INITIALE.migration,
      backend: null,
      cle: null,
      openHandle,
      tientLeFichier: true,
    }),
  });
  try {
    return magasin.rapport;
  } finally {
    magasin.close();
  }
}
