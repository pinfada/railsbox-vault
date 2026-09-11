// OUVERTURE d'un volume OPFS, et RÉCUPÉRATION de sa dernière génération (#6, #16, ADR 0014 ;
// #18, ADR 0016).
//
// C'est le seul chemin admis vers un `OpfsBlockBackend` : le constructeur ne garantit ni géométrie
// ni exclusivité, et l'ouverture est précisément la suite de gestes qui les établit — réserver le
// nom, saisir le handle, lire l'en-tête v3 ou le poser si le volume naît, confronter la géométrie
// déclarée à celle du fichier, importer la clé de volume, puis ouvrir le journal voisin et récupérer.
//
// La règle qui traverse tout le module : **chaque refus survenant APRÈS l'ouverture rend ce qu'il a
// pris.** Un handle non rendu laisserait le fichier verrouillé par un volume que personne ne
// détient, et le nom occupé par un backend que personne ne peut fermer.
//
// ## Deux tailles, et il ne faut jamais les confondre
//
// La taille LOGIQUE est celle que v86 voit et que le manifeste déclare. La taille SUPPORT est celle
// du fichier : l'en-tête v3, la région d'authentification, puis la charge. `size()` du backend rend
// la première ; le contrôle de géométrie confronte la seconde. Les confondre ferait croire à v86
// qu'il dispose de 6,64 % de disque en plus, c'est-à-dire de secteurs qui sont des sceaux.

import { SECTOR_SIZE, assertBlockGeometry, isBlockGeometry } from "./block-geometry.mjs";
import { BlockJournal } from "./block-journal.mjs";
import { exigerCleDeVolume } from "./cle-de-volume.mjs";
import { createFaultPlan } from "./fault-plan.mjs";
import { OpfsBlockBackend } from "./opfs-block-backend.mjs";
import { ouvrirVolumeBrut } from "./opfs-volume-brut.mjs";
import { installerGenerationOuFermer, ouvrirGeneration } from "./opfs-generation-voisins.mjs";
import {
  MOTIFS_DE_RACINE_INITIALE,
  autorisationSansRacine,
  ecarterLeJournalDeCreation,
} from "./opfs-racine-initiale.mjs";
import { toStorageError, writeCountFailure } from "./opfs-error-mapping.mjs";
import {
  ENVELOPPE_SIDECAR_SUFFIX,
  migrationJournalName,
  openOpfsSyncAccess,
  voisinsDunVolume,
} from "./opfs-sync-access.mjs";
import { assertVolumeLibre, reserverVolume } from "./opfs-volume-registry.mjs";
import { Scellement } from "./scellement.mjs";
import { STORAGE_ERROR_CODES, StorageError, geometryMismatch } from "./storage-errors.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  MARQUEUR_SCELLEMENT_COMPLET,
  SCELLEMENT_COMPLET_OFFSET,
  decoderEnTeteV4,
  dispositionDuVolume,
  encoderEnTeteV4,
  versionDEnTeteDeVolume,
  identifiantVolumeEnTexte,
  nouvelIdentifiantDeVolume,
} from "./volume-chiffre-format.mjs";

/** Ferme un handle après une ouverture ratée, sans jamais masquer l'erreur d'origine. */
function abandonHandle(handle, name, original) {
  try {
    handle.close();
  } catch (cause) {
    return new StorageError(
      STORAGE_ERROR_CODES.supportFailure,
      `${original.message} La fermeture de secours du volume « ${name} » a elle aussi échoué : ${cause?.name ?? cause}.`,
      { volume: name, initial: original.code, cause: cause?.name ?? "Error" },
    );
  }
  return original;
}

/** Lit le premier secteur du fichier : l'en-tête v3, ou ce qui prétend l'être. */
function lireEnTete(handle, name) {
  const octets = new Uint8Array(EN_TETE_OCTETS);
  const lus = handle.read(octets, { at: 0 });
  if (lus !== EN_TETE_OCTETS) {
    throw geometryMismatch(name, {
      observed: lus,
      expected: EN_TETE_OCTETS,
      reason: "Le fichier ne rend pas son en-tête v3 entier ; il n'est pas ouvert.",
    });
  }
  return octets;
}

/**
 * Résout la disposition d'un volume EXISTANT à partir de son en-tête.
 *
 * Un fichier non vide qui ne porte pas d'en-tête v3 est refusé, et le message dit ce qui est vrai :
 * son MANIFESTE se lit encore — c'est ce que `MIN_READABLE_FORMAT_VERSION` couvre —, mais le
 * FICHIER ne s'ouvre pas ici, faute de région d'authentification où loger le sceau d'un secteur.
 * Le message a longtemps promis trois remèdes de plus — « se lit, s'exporte et se migre » —, dont
 * aucun n'existait : l'export passe par cet ouvreur, qui refuse, et la migration vers v3 est
 * l'objet de #101.
 */
function dispositionExistante({ name, handle, declared, observed, identifiantVolume }) {
  const octets = lireEnTete(handle, name);
  const lu = decoderEnTeteV4(octets);
  if (!lu.valide) {
    throw geometryMismatch(name, {
      observed,
      expected: null,
      reason: `${lu.raison} ${raisonDUnEnTeteRefuse(octets)}`,
    });
  }
  if (!lu.enTete.scellementComplet) throw creationInachevee(name, observed);
  const disposition = dispositionDuVolume(lu.enTete.tailleLogique);
  if (observed !== disposition.tailleSupport) {
    throw geometryMismatch(name, {
      observed,
      expected: disposition.tailleSupport,
      reason: "Le fichier ne fait pas la taille que son propre en-tête impose.",
    });
  }
  if (declared !== undefined && declared !== disposition.tailleLogique) {
    throw geometryMismatch(name, {
      observed: disposition.tailleLogique,
      expected: declared,
      reason: "Un volume existant n'est jamais retaillé en silence ; exporter puis migrer.",
    });
  }
  const surLeDisque = identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
  // Deux sources qui divergent ne se départagent pas, elles se refusent. L'en-tête n'est pas
  // authentifié — c'est un localisateur —, et l'identité qui entrera dans les données associées est
  // celle que le MANIFESTE déclare. Confronter les deux ici sert au diagnostic : « ce fichier n'est
  // pas le volume que le manifeste décrit » se corrige autrement qu'un sceau refusé.
  if (identifiantVolume !== undefined && identifiantVolume !== surLeDisque) {
    throw new StorageError(
      STORAGE_ERROR_CODES.identiteVolume,
      `Volume « ${name} » refusé : son en-tête v3 porte l'identifiant ${surLeDisque}, le manifeste en déclare un autre. Aucun octet n'est lu.`,
      { volume: name, surLeDisque, declare: identifiantVolume },
    );
  }
  return { disposition, identifiantVolume: surLeDisque };
}

/**
 * Refus d'un volume dont la CRÉATION n'a pas abouti.
 *
 * Le remède nommé est le seul qui soit vrai. « Restaurer une sauvegarde » — ce que le refus de
 * sceau proposait — envoie chercher la sauvegarde d'un volume qui n'a jamais servi.
 *
 * **Pourquoi ce volume n'est PAS re-scellé automatiquement**, alors que ce serait sans perte : la
 * marque vit dans l'en-tête, qui n'est pas authentifié. Un re-scellement automatique donnerait à
 * quiconque peut effacer huit octets du fichier le moyen de faire écraser tout le volume par des
 * zéros scellés — c'est-à-dire de le détruire par un geste que rien ne distingue d'une réparation.
 * Le refus, lui, ne laisse à cet adversaire qu'un déni de service qu'il avait déjà.
 */
function creationInachevee(name, observed) {
  return new StorageError(
    STORAGE_ERROR_CODES.volumeIncomplet,
    `Volume « ${name} » refusé : sa création n'est pas allée jusqu'au bout — l'en-tête est posé, mais le scellement initial ne s'est jamais achevé. Ce fichier n'a jamais porté de données : le remède est de le supprimer et de le recréer, pas de restaurer une sauvegarde. Aucun octet n'est lu.`,
    { volume: name, observed },
  );
}

/** Résout la disposition d'un volume qui NAÎT. Sa taille logique est celle qu'on déclare. */
function dispositionNeuve({ name, declared, identifiantVolume }) {
  if (declared === undefined) {
    throw geometryMismatch(name, {
      observed: 0,
      expected: null,
      reason: "Volume absent ou vide et aucune géométrie déclarée : rien à ouvrir.",
    });
  }
  if (!isBlockGeometry(declared)) {
    throw geometryMismatch(name, {
      observed: 0,
      expected: declared,
      reason: `La taille déclarée n'est pas un multiple de ${SECTOR_SIZE} octets.`,
    });
  }
  return {
    disposition: dispositionDuVolume(declared),
    identifiantVolume: identifiantVolume ?? nouvelIdentifiantDeVolume(),
  };
}

/**
 * DIT ce qu'un en-tête refusé est, quand on peut le dire, et ce qu'il faut en faire.
 *
 * Un volume v3 présenté à un produit v4 n'est pas un fichier abîmé : c'est un volume qui demande sa
 * MIGRATION, et la lui refuser sans le nommer enverrait l'exploitant chercher une sauvegarde. Le
 * fichier n'est pas lu pour autant — **un volume v3 n'est JAMAIS lu par le produit v4 en lecture
 * directe** (ADR 0033, décision 5, point 2) : on nomme, on refuse, et c'est la migration qui ouvre.
 */
function raisonDUnEnTeteRefuse(octets) {
  const version = versionDEnTeteDeVolume(octets);
  if (version === FORMAT_VOLUME_V3) {
    return `Ce fichier est un volume au format v${FORMAT_VOLUME_V3}. Il ne s'ouvre pas ici : depuis #182, un volume v${FORMAT_VOLUME_V3} n'est lu que par la MIGRATION, qui rescelle chaque secteur sous la clé du domaine « volume » de la v${FORMAT_VOLUME_V4}. Le remède est de migrer, jamais de restaurer.`;
  }
  return `Le manifeste d'un volume antérieur au format v${FORMAT_VOLUME_V3} se lit encore, mais son fichier ne s'ouvre pas ici — il n'a pas de région d'authentification — et il n'a de chemin vers v${FORMAT_VOLUME_V4} que par la chaîne de migration.`;
}

/** Alloue le fichier à sa taille support et y pose l'en-tête v4. Le scellement vient après. */
function poserEnTete(handle, name, disposition, identifiantVolume) {
  handle.truncate(disposition.tailleSupport);
  const entete = encoderEnTeteV4({
    tailleLogique: disposition.tailleLogique,
    identifiantVolume,
  });
  // Une valeur de retour est INTERPRÉTÉE, jamais comparée à la va-vite (#73) : un support qui rend
  // `FILE_ERROR_NO_SPACE` casté en non signé n'a pas écrit un en-tête trop court, il n'a rien
  // écrit — et « manque de place » n'appelle pas le même remède que « géométrie incohérente ».
  const echec = writeCountFailure(handle.write(entete, { at: 0 }), {
    requested: EN_TETE_OCTETS,
    volume: name,
    offset: 0,
    operation: "write-header",
  });
  if (echec !== null) throw echec;
  handle.flush();
}

/**
 * Pose l'en-tête d'un volume qui naît, et REND le handle si la pose échoue.
 *
 * C'est le premier geste qui ÉCRIT, et il vient délibérément après le contrôle de la clé : un
 * volume qu'on ne saura pas sceller ne doit pas laisser derrière lui un fichier alloué à sa taille
 * support et porteur d'un en-tête.
 */
function poserEnTeteOuRendre(handle, name, disposition, identifiantVolume) {
  try {
    poserEnTete(handle, name, disposition, identifiantVolume);
  } catch (cause) {
    throw abandonHandle(
      handle,
      name,
      toStorageError(cause, { operation: "allocate", volume: name }),
    );
  }
}

/**
 * Les voisins ORPHELINS qu'une NAISSANCE retire (#145), dérivés de `voisinsDunVolume` — jamais
 * recopiés — pour rester la MÊME liste que `removeOpfsVolume`, à deux différences près :
 *
 *  - l'ENVELOPPE DE CLÉ (`.cles`) est EXCLUE. La création d'un volume chiffré l'écrit AVANT le
 *    volume (`preparerEnveloppeDeVolume`, ADR 0020 : « une coupure laisse au pire une enveloppe
 *    orpheline, jamais un volume qu'aucune clé n'ouvre »), et une naissance qui la retirerait
 *    détruirait l'enveloppe qu'on vient de poser pour CE volume ;
 *  - le JOURNAL DE MIGRATION est AJOUTÉ. Il n'est pas dans `voisinsDunVolume` — c'est le geste qui
 *    inscrit le manifeste restauré ou créé (`writeVolumeManifest`) qui le retire d'ordinaire —, mais
 *    un volume qui NAÎT n'a hérité d'aucune migration en cours.
 */
function voisinsOrphelinsALaNaissance(name) {
  return [
    ...voisinsDunVolume(name).filter((voisin) => !voisin.endsWith(ENVELOPPE_SIDECAR_SUFFIX)),
    migrationJournalName(name),
  ];
}

/**
 * RETIRE, à la naissance, chaque voisin orphelin qui porte encore des octets — un témoin, un journal
 * de génération, un instantané ou un journal de migration laissés par un volume du MÊME NOM,
 * supprimé sans passer par `removeOpfsVolume` (#145). Sans ce retrait, un témoin périmé fait refuser
 * le volume neuf par `VAULT_STORAGE_SCEAU_REFUSE` dès la récupération de sa génération, puisqu'il
 * atteste une identité que ce volume-ci n'a jamais portée.
 *
 * Un voisin déjà VIDE n'est pas ÉCRIT : c'est ce qu'un voisin qui n'a jamais existé laisse dans ce
 * même support (`lireTemoinDuSupport`), et une naissance sans aucun orphelin — le cas le plus
 * fréquent, de loin — ne doit tronquer et barrer aucun fichier pour rien.
 *
 * Rend la liste des voisins RÉELLEMENT retirés — jamais celle des voisins visés — pour que le compte
 * rendu de l'ouverture ne publie qu'un retrait qui a eu lieu.
 */
async function retirerVoisinsOrphelins(name, openHandle) {
  const retires = [];
  for (const voisin of voisinsOrphelinsALaNaissance(name)) {
    let handle;
    try {
      handle = await openHandle(voisin);
    } catch (cause) {
      throw toStorageError(cause, { operation: "open-orphelin", volume: voisin });
    }
    try {
      if (handle.getSize() > 0) {
        handle.truncate(0);
        handle.flush();
        retires.push(voisin);
      }
    } catch (cause) {
      throw abandonHandle(
        handle,
        voisin,
        toStorageError(cause, { operation: "retirer-orphelin", volume: voisin }),
      );
    }
    handle.close();
  }
  return Object.freeze(retires);
}

/**
 * Pose la marque de SCELLEMENT COMPLET, et la matérialise.
 *
 * Huit octets écrits dans la réserve de l'en-tête déjà allouée, puis une barrière. Ce geste est le
 * DERNIER de la création, et c'est tout son intérêt : tant qu'il n'a pas eu lieu, le fichier se
 * relit comme une création inachevée. Une coupure entre le scellement et cette marque refuse un
 * volume pourtant complet — un faux refus, sans perte, contre un faux succès qui coûtait le volume.
 */
function marquerScellementComplet(handle, name) {
  const echec = writeCountFailure(
    handle.write(MARQUEUR_SCELLEMENT_COMPLET, { at: SCELLEMENT_COMPLET_OFFSET }),
    {
      requested: MARQUEUR_SCELLEMENT_COMPLET.byteLength,
      volume: name,
      offset: SCELLEMENT_COMPLET_OFFSET,
      operation: "write-seal-mark",
    },
  );
  if (echec !== null) throw echec;
  handle.flush();
}

/**
 * SAISIT le support : handle exclusif, en-tête v3 LU, géométrie confrontée. L'ouvreur peut être le
 * vrai OPFS, qui rend déjà des erreurs typées, ou un double qui rend des `DOMException` brutes : les
 * deux passent par la même traduction. Chaque refus survenant APRÈS l'ouverture rend le handle, sans
 * quoi le fichier resterait verrouillé par un volume que personne ne détient.
 *
 * Elle n'écrit RIEN, pas même l'en-tête d'un volume qui naît : la pose est faite par l'appelant,
 * après le contrôle de la clé. Voir `poserEnTeteOuRendre`.
 */
async function saisirSupport({ name, size, identifiantVolume, openHandle }) {
  let handle;
  try {
    handle = await openHandle(name);
  } catch (cause) {
    throw toStorageError(cause, { operation: "open", volume: name });
  }

  let observed;
  try {
    observed = handle.getSize();
  } catch (cause) {
    throw abandonHandle(handle, name, toStorageError(cause, { operation: "size", volume: name }));
  }

  const naissance = observed === 0;
  let resolue;
  try {
    resolue = naissance
      ? dispositionNeuve({ name, declared: size, identifiantVolume })
      : dispositionExistante({ name, handle, declared: size, observed, identifiantVolume });
  } catch (error) {
    throw abandonHandle(handle, name, error);
  }

  return { handle, ...resolue, naissance };
}

/**
 * Scelle ENTIÈREMENT un volume qui vient de naître, secteurs de zéros compris.
 *
 * « Un secteur jamais écrit n'existe pas en v3 » (ADR 0015) : si la région d'authentification était
 * à zéro pour un secteur vierge, il suffirait de la zéroter pour faire lire un secteur comme blanc.
 * Le coût est un scellement par secteur, mesuré dans `docs/quality-attributes.md`, et il se paie une
 * fois — à la création.
 */
async function scellerLeVolumeNeuf(backend, name) {
  try {
    await backend.chiffre.scellerTout(0);
    await backend.barriereSupportBrute();
  } catch (cause) {
    await backend.close().catch(() => {});
    throw toStorageError(cause, { operation: "seal-volume", volume: name });
  }
}

/**
 * POSE la marque `VLTSEAL1`, DERNIER geste de la création (§ 7.1).
 *
 * Elle vient APRÈS la barrière des sceaux — une marque posée avant attesterait d'un état qui n'est
 * peut-être jamais arrivé jusqu'au disque — et, depuis #181, APRÈS la RACINE INITIALE : la création
 * a gagné un geste, et la marque reste le dernier. Une coupure entre les deux laisse un volume
 * refusé par `VAULT_STORAGE_VOLUME_INCOMPLET`, c'est-à-dire un faux refus sans perte, contre un faux
 * succès qui coûterait le volume.
 */
async function marquerLaCreationAchevee(backend, name, handle) {
  try {
    marquerScellementComplet(handle, name);
  } catch (cause) {
    await backend.close().catch(() => {});
    throw toStorageError(cause, { operation: "seal-mark", volume: name });
  }
}

/**
 * ÉCRIT la RACINE INITIALE d'un volume qui naît SANS transaction (#181).
 *
 * Un volume ouvert hors transaction n'a pas de magasin, et n'en aura pas : ce chemin est celui du
 * VERSEMENT d'un disque applicatif (ADR 0030) et des bancs, qui écrivent le fichier entier sans
 * passer par le journal. Sa création doit pourtant écrire sa racine, comme toute autre — sans quoi
 * le volume serait refusé à sa première ouverture transactionnelle.
 *
 * Le magasin est donc ouvert le temps d'un geste, puis refermé. Il n'est pas installé sur le
 * backend : le volume reste NON transactionnel, et `describe()` continue de le dire.
 *
 * **Un appelant qui ÉCRIT le fichier ensuite doit le RE-DATER** par `daterLaCreation` : cette racine
 * scelle l'empreinte de la région telle qu'elle est à cet instant, et une écriture hors transaction
 * la périme. L'oubli coûte un REFUS à la première ouverture, jamais un silence.
 */
async function racineInitialeHorsTransaction(backend, options) {
  let magasin;
  try {
    magasin = await ouvrirGeneration(options);
  } catch (cause) {
    await backend.close().catch(() => {});
    throw cause;
  }
  magasin.close();
}

/**
 * Saisit le support, EXIGE la clé, puis alloue si le volume naît. L'ordre est le sujet.
 *
 * L'en-tête est lu avant que la clé ne soit exigée, et c'est un diagnostic : un fichier d'un format
 * antérieur n'a pas besoin d'une clé pour qu'on sache qu'il ne s'ouvre pas ici, et lui répondre
 * « aucune clé de volume n'a été remise » désignait un remède qui n'était pas le sien.
 *
 * Rien n'est ÉCRIT tant que la clé n'est pas là : un volume qu'on ne saura pas sceller ne doit pas
 * laisser derrière lui un fichier alloué et porteur d'un en-tête. Rien n'est rendu de la charge non
 * plus — seul l'en-tête est lu, et il est un localisateur.
 *
 * À la naissance, les voisins ORPHELINS sont retirés ici, AVANT tout le reste (#145) : c'est avant
 * ce point que `installerGenerationOuFermer` ouvrirait `.gen` et `.temoin`, et un témoin périmé lu
 * après ce point ferait refuser un volume qui vient de naître.
 */
async function saisirLireEtAllouer({ name, size, cle, identifiantVolume, openHandle }) {
  const saisi = await saisirSupport({ name, size, identifiantVolume, openHandle });
  try {
    exigerCleDeVolume(name, cle);
  } catch (refus) {
    throw abandonHandle(saisi.handle, name, refus);
  }
  if (!saisi.naissance) return { ...saisi, voisinsRetires: Object.freeze([]) };
  poserEnTeteOuRendre(saisi.handle, name, saisi.disposition, saisi.identifiantVolume);
  const voisinsRetires = await retirerVoisinsOrphelins(name, openHandle);
  return { ...saisi, voisinsRetires };
}

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
async function tailleLogiqueDuFichier(name, openHandle) {
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

export async function daterLaCreation({
  name,
  cle,
  identifiantVolume,
  journal = new BlockJournal(),
  empreinteVersee = null,
  openHandle = openOpfsSyncAccess,
}) {
  await ecarterLeJournalDeCreation(
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
  });
  try {
    return backend.generation.rapport;
  } finally {
    await backend.close();
  }
}

/** Assemble le backend : taille LOGIQUE d'un côté, disposition du support de l'autre. */
function construireBackend({ name, saisi, scellement, journal, faults, flushDelay }) {
  return new OpfsBlockBackend({
    name,
    handle: saisi.handle,
    size: saisi.disposition.tailleLogique,
    disposition: saisi.disposition,
    scellement,
    journal,
    faults,
    flushDelay,
    voisinsRetires: saisi.voisinsRetires,
  });
}

/**
 * Ouvre un volume OPFS en exclusivité.
 *
 * @param {{ name?: string, size?: number, cle?: Uint8Array, identifiantVolume?: string,
 *           journal?: BlockJournal, faults?: import("./fault-plan.mjs").FaultPlan,
 *           flushDelay?: number,
 *           openHandle?: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 *   `size` est la taille LOGIQUE, facultative : à la réouverture, elle est RELUE de l'en-tête v3 au
 *   lieu d'être supposée. Fournie, elle doit correspondre exactement.
 *   `cle` est la clé de volume, OBLIGATOIRE : le format v3 est chiffré, et un volume sans clé est
 *   refusé par `VAULT_STORAGE_CLE_REQUISE` avant toute lecture. Aucun chemin du produit n'en
 *   fabrique une avant #21 ; les bancs la reçoivent du harnais sous jeton (`cle-de-volume.mjs`).
 *   `identifiantVolume` est l'identifiant que le MANIFESTE déclare. À la création il est inscrit
 *   dans l'en-tête ; à la réouverture il est confronté à celui du fichier.
 *   `openHandle` est le point d'injection du support : le vrai OPFS en production, un double
 *   déterministe dans les tests unitaires.
 *   `fautesFraicheur` vise les VOISINS de fraîcheur (#19) — la région d'authentification et le
 *   témoin — et il est SÉPARÉ de `faults`, qui vise les gestes du guest : mêler les deux décalerait
 *   les occurrences de la matrice de coupures de #15.
 *   `empreinteVersee` est l'empreinte SHA-256 du fichier que le VERSEMENT a rendue, et elle n'a de
 *   sens qu'avec `creation` : elle est ce qui relie le geste qui a écrit le fichier hors transaction
 *   au geste qui le date, par-dessus la fenêtre où personne ne le tient (#181, revue de sécurité de
 *   la PR #184).
 * @returns {Promise<OpfsBlockBackend>}
 */
export async function openOpfsVolume({
  name = "vault",
  size,
  cle,
  identifiantVolume,
  journal = new BlockJournal(),
  faults = createFaultPlan(),
  fautesFraicheur = createFaultPlan(),
  flushDelay = 0,
  openHandle = openOpfsSyncAccess,
  transactionnel = true,
  creation = null,
  empreinteVersee = null,
  seuilPointDeControle,
} = {}) {
  assertVolumeLibre(name);
  if (size !== undefined) assertBlockGeometry(size);

  const saisi = await saisirLireEtAllouer({ name, size, cle, identifiantVolume, openHandle });
  const scellement = await Scellement.ouvrir({
    volume: saisi.identifiantVolume,
    cleOctets: cle,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const backend = construireBackend({ name, saisi, scellement, journal, faults, flushDelay });
  if (saisi.naissance) await scellerLeVolumeNeuf(backend, name);
  await etablirLaGeneration(backend, {
    name,
    saisi,
    scellement,
    cle,
    openHandle,
    seuilPointDeControle,
    fautesFraicheur,
    transactionnel,
    creation,
    empreinteVersee,
  });

  // La MARQUE en dernier, et depuis #181 après la racine initiale : la création a gagné un geste, et
  // `VLTSEAL1` reste celui qui la clôt.
  if (saisi.naissance) await marquerLaCreationAchevee(backend, name, saisi.handle);

  reserverVolume(name, backend);
  return backend;
}

/**
 * INSTALLE le magasin de générations, ou — hors transaction — écrit la seule racine initiale d'une
 * naissance.
 *
 * Extrait de `openOpfsVolume` parce que c'est une DÉCISION entière : ce qui autorise une ouverture
 * sans racine (#181), et ce que le mode transactionnel fait de cette autorisation. Une naissance
 * s'autorise elle-même ; hors naissance, seul `creation` — posé par la migration, ou par le geste
 * qui date une création — ou l'engagement d'une archive restaurée le peut.
 *
 * ## Hors transaction ET sans naissance : la session est en LECTURE SEULE (#182)
 *
 * Une telle session ne clôra par AUCUNE racine, donc aucun de ses scellements ne serait publié dans
 * un compteur. Depuis le format v4, cela lui retire le droit de sceller (ADR 0033, décision 4), et
 * un scellement demandé sous ce régime est refusé par `VAULT_STORAGE_LECTURE_SEULE` plutôt que
 * consommé en silence.
 *
 * C'est la moitié du § 4.5 que la spécification AVOUAIT au lieu de la fermer : « le compteur est
 * sous-estimé hors transaction ». Les trois chemins qui scellaient ainsi closent désormais par une
 * racine — la création, l'installation initiale du volume applicatif (`daterLaCreation`) et
 * l'ouverture hors transaction de la coquille, qui est une naissance —, et ce qui reste est REFUSÉ
 * au lieu d'être compté à moitié.
 */
async function etablirLaGeneration(
  backend,
  {
    name,
    saisi,
    scellement,
    cle,
    openHandle,
    seuilPointDeControle,
    fautesFraicheur,
    transactionnel,
    creation,
    empreinteVersee,
  },
) {
  const motif = saisi.naissance ? MOTIFS_DE_RACINE_INITIALE.creation : creation;
  const generation = {
    name,
    size: saisi.disposition.tailleLogique,
    backend,
    scellement,
    openHandle,
    seuilPointDeControle,
    fautesFraicheur,
    // `tientLeFichier` dit ce que l'autorisation a le droit de croire sans rien vérifier : une
    // NAISSANCE vient d'allouer et de sceller ce fichier sous CETTE exclusivité. Une datation de
    // création, non — le versement l'a relâché avant elle, et c'est `empreinteVersee` qui relie les
    // deux gestes (revue de sécurité de la PR #184, constat 1).
    sansRacine: autorisationSansRacine({
      name,
      motif,
      backend,
      cle,
      openHandle,
      empreinteVersee,
      tientLeFichier: saisi.naissance,
    }),
  };
  if (transactionnel) return installerGenerationOuFermer(backend, generation);
  if (saisi.naissance) return racineInitialeHorsTransaction(backend, generation);
  scellement.interdireDeSceller();
  return undefined;
}
