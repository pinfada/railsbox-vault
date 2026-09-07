// Le WORKER DE CONFIANCE de la coquille de produit (#161, ADR 0028 ; #162, ADR 0029).
//
// ## Le jeton du harnais a QUITTÉ ce fichier
//
// La tranche 1 ouvrait le volume sous le jeton de `src/vm/cle-de-volume.mjs` : c'était la réserve
// écrite de `SEC-ORIGIN-001` côté produit, et ce fichier était le PREMIER — et le seul — chemin de
// production inscrit à `tests/unit/harnais-portes.test.mjs`. L'inscription portait la date de sa
// sortie : « Provisoire : #162 le retire ». Elle est retirée, et l'épreuve rougit désormais si un
// chemin de produit franchit de nouveau cette porte.
//
// Ce qui l'a remplacée est un GESTE DE L'UTILISATEUR, sous trois formes (ADR 0021, ADR 0025) :
//
//  - **phrase** — dérivée ICI, par Argon2id calibré. La phrase franchit le port page → Worker, à
//    l'intérieur de l'origine de CONFIANCE : ce n'est pas la frontière que `SEC-ORIGIN-001`
//    protège, et c'est la limite 4 de l'ADR 0021, nommée plutôt que niée. La dériver dans la page
//    figerait l'interface pendant deux secondes sur le moteur le plus lent ;
//  - **webauthn-prf** — dérivée dans la PAGE, qui n'envoie ici que la `CryptoKey` non extractible
//    (`enveloppePrivilegiee`, seule dérogation à `sansCapacite`). Ce Worker ne voit ni la sortie
//    PRF, ni les octets de la KEK ;
//  - **recuperation** — le code est contrôlé DANS LA PAGE avant tout envoi (somme ISO 7064), puis
//    dérivé ici par HKDF. Le contrôle en direct évite qu'un code mal recopié coûte une dérivation ;
//    le refus qu'il rend, `VAULT_DERIVATION_CODE_MAL_RECOPIE`, reste distinct de
//    `VAULT_ENVELOPPE_CLE_REFUSEE`, qui dit tout autre chose.
//
// ## Ce qu'il détient, et ce qui n'en sort pas
//
// Il détient le port privilégié, la KEK de la session ouverte, la clé de volume développée et le
// handle du volume. Rien de cela ne franchit un `postMessage` vers l'origine applicative : ce que
// le port restreint reçoit est un ÉTAT — quatre valeurs et un compte de barrières —, construit par
// `src/coquille/etat-de-la-coquille.mjs` et contrôlé par `sansCapacite` avant d'être posté.
//
// **La KEK est RETENUE, et c'est une décision** (ADR 0029, limite 2). Créer un moyen de
// récupération exige de détenir une clé qui ouvre déjà (ADR 0020) ; sans rétention, la coquille
// devrait redemander la phrase — donc la faire vivre une seconde fois, et payer une seconde
// dérivation de deux secondes — pour un geste que l'utilisateur vient de rendre possible. Elle vit
// dans le Worker de confiance, du même côté de la frontière que la DEK, et ne franchit aucun port.
//
// ## Une seule chose est ÉCRITE sans qu'on le demande : l'enveloppe d'un coffre neuf
//
// Quand aucune enveloppe n'existe, le premier geste de déverrouillage la CRÉE sous le moyen
// présenté, et tire une clé de volume RÉELLE (`tirerCleDeVolume`, l'aléa du moteur). C'est ce que
// faisait la tranche 1 — avec les clés du harnais — et c'est ce qui rend un coffre neuf ouvrable.
// Le code de récupération, lui, ne crée rien : il n'y a rien à secourir dans un coffre qui n'existe
// pas, et le lui laisser créer un coffre ferait naître un volume dont l'unique clé est un papier.

import {
  TYPES_PRIVILEGIES,
  correlationAdmise,
  decoderMessage,
  enveloppeDeMessage,
  sansCapacite,
} from "/src/coquille/contrat-de-messages.mjs";
import { compteRenduPublie, demarrerLaVm } from "/src/coquille/application-de-reference.mjs";
import { constaterLExclusivite } from "/src/coquille/exclusivite-du-volume.mjs";
import { exigerLeBackend } from "/src/coquille/cycle-de-vie.mjs";
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { exigerKekDeLaPage, moyenParNom } from "/src/coquille/moyens-de-deverrouillage.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";
import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import {
  CALIBRATION_PHRASE,
  parametresDePhrase,
  tirerSelDePhrase,
} from "/src/vm/derivation/derivateur-phrase.mjs";
import { derivateurRecuperation } from "/src/vm/derivation/derivateur-recuperation.mjs";
import { catalogueDeDerivateurs } from "/src/vm/derivation/derivateurs.mjs";
import {
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
} from "/src/vm/enveloppe-de-cle.mjs";
import {
  TYPES_KEK,
  tirerCleDeVolume,
  tirerIdentifiantEmplacement,
} from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "/src/vm/format-chiffre/octets.mjs";
import { creerMoyenDeRecuperation } from "/src/vm/moyen-de-recuperation.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "/src/vm/storage-errors.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";

/** Nom du volume que la coquille de produit ouvre. Un seul, tant qu'une seule application existe. */
const VOLUME = "coquille";

/** Trente-deux secteurs : de quoi écrire et relire, sans faire du démarrage une mesure de disque. */
const TAILLE = 32 * SECTOR_SIZE;

/** Identifiant de volume, POSÉ EN OCTETS : un long littéral hexadécimal ressemble à une clé. */
const IDENTIFIANT_VOLUME = octetsEnHex(
  Uint8Array.from({ length: 16 }, (_, index) => (0x21 + index * 0x07) % 256),
);

/**
 * Le CATALOGUE que ce Worker pose : les types qu'il sait servir, et rien d'autre.
 *
 * Il n'en sert plus qu'UN, et c'est le sujet de la décision 5 réécrite : `webauthn-prf` se dérive
 * dans la page parce que `navigator.credentials` n'existe pas dans un Worker, et `phrase` s'y dérive
 * désormais aussi — dans un Worker DÉDIÉ que la page crée — parce qu'Argon2id est un appel
 * WebAssembly SYNCHRONE, et qu'il bloquait ce fil-ci pendant deux secondes. Le catalogue dit donc ce
 * que le WORKER DE CONFIANCE sert, ce qui est exactement la question que `catalogue.pour` pose. Un
 * type absent rend `VAULT_DERIVATION_TYPE_INCONNU` — jamais une tentative sous un dérivateur
 * approchant.
 */
const CATALOGUE = catalogueDeDerivateurs({
  [TYPES_KEK.recuperation]: derivateurRecuperation(),
});

/**
 * Ce moteur peut-il atteindre un volume ? Constaté UNE FOIS, à l'évaluation du module.
 *
 * L'OPFS et son accès synchrone manquent à un moteur de la matrice #2 (WebKit). Cette question ne
 * dépend d'aucun état et ne change pas en cours de vie : la poser une seule fois est ce qui rend
 * l'état PUBLIÉ déterministe. Elle était posée à chaque geste, et `publierLInventaire` MUTAIT
 * `interne.etat` en passant — si bien que la page n'apprenait `indisponible` que si le document
 * applicatif posait sa question d'état, c'est-à-dire à un instant que personne ne contrôle. Une
 * COURSE, qui rendait la suite verte en local et rouge en intégration continue (constat 3 de la
 * revue de sécurité de la PR #167).
 *
 * L'absence est rendue comme un ÉTAT — `indisponible` — et non comme un refus de déverrouillage,
 * parce que ce n'est pas le geste qui a échoué. Confondre les deux ferait redemander à
 * l'utilisateur une phrase qui n'ouvrirait rien.
 */
const PEUT_OUVRIR =
  typeof navigator?.storage?.getDirectory === "function" &&
  typeof FileSystemFileHandle !== "undefined" &&
  typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function";

/**
 * Ce que le Worker sait de lui-même. Rien de tout cela ne franchit un `postMessage`.
 */
const interne = {
  // L'état de DÉPART dit déjà ce que ce moteur sait faire : la toute première réponse d'état est
  // donc juste, avant qu'aucun geste n'ait eu lieu et sans qu'aucune course ne puisse l'inverser.
  etat: PEUT_OUVRIR ? ETATS_DU_VOLUME.verrouille : ETATS_DU_VOLUME.indisponible,
  barrieres: 0,
  /** Backend du volume ouvert. Il tient le handle exclusif ; il n'est jamais posté. */
  backend: null,
  /** La KEK de la session, retenue pour les gestes qui exigent un volume ouvert. Voir l'en-tête. */
  kek: null,
  /** La version d'enveloppe observée à la dernière ouverture ou au dernier ajout. */
  version: null,
  /**
   * La SESSION de l'application, quand la VM tourne. Elle porte la poignée de fermeture rendue par
   * `bootEtVerifier` — une FONCTION, donc quelque chose que `sansCapacite` refuse de poster : la
   * poignée reste du côté qui tient le handle, par construction et non par discipline.
   */
  application: null,
};

/** Le port privilégié, transféré UNE fois par la coquille avant tout document applicatif. */
let portPrivilegie = null;

// --- Canal privilégié ---------------------------------------------------------------------------

// L'écouteur est inscrit à l'évaluation du module. C'est la première ligne exécutée du Worker : le
// canal est donc joignable avant que la coquille ait pu créer le moindre cadre.
self.addEventListener("message", (event) => {
  const decode = decoderMessage(event.data);
  if (!decode.ok) return refuserSurLeGlobal(decode.code);
  if (decode.type !== TYPES_PRIVILEGIES.canal) {
    return refuserSurLeGlobal(CODES_REFUS_COQUILLE.typeInconnu);
  }
  // Unicité : un second canal réclamé après coup est refusé, comme un second port restreint.
  if (portPrivilegie !== null) return refuserSurLeGlobal(CODES_REFUS_COQUILLE.annonceUnique);
  const [port] = event.ports;
  if (!port) return refuserSurLeGlobal(CODES_REFUS_COQUILLE.messageMalforme);
  portPrivilegie = port;
  // Les messages du canal privilégié sont traités EN SÉRIE. Un gestionnaire `async` ne retient pas
  // le message suivant : sans cette chaîne, une demande d'état posée juste après un déverrouillage
  // serait servie avant que le déverrouillage ait fini, et rendrait `verrouille` sur un volume qui
  // s'ouvre. Le sérialiser n'est pas une optimisation, c'est ce qui rend l'état lisible.
  port.addEventListener("message", (message) => {
    // La CORRÉLATION est relevée AVANT le traitement, pour qu'un refus la retrouve. Sans elle, une
    // dérivation qui échoue laisserait la page attendre une réponse qui ne vient jamais — le
    // SILENCE que « un refus typé, jamais un silence » interdit, sur le geste le plus long du
    // produit. C'est la même leçon que le constat 2 de la revue de la PR #166, appliquée à l'autre
    // canal avant qu'il ne la répète.
    const correlation = correlationDe(message.data);
    // La question d'ÉTAT sort de la file, et c'est une décision de #162 (ADR 0029, décision 5).
    //
    // C'est une LECTURE PURE de deux champs : elle ne touche ni l'enveloppe, ni le volume, ni
    // l'OPFS, et rien ne dépend de sa place dans l'ordre. La laisser dans la file la faisait
    // attendre derrière la dérivation en cours — deux mille cent millisecondes sur le moteur le
    // plus lent —, et la coquille relaie cette question pour le DOCUMENT APPLICATIF. La suite de
    // frontière de #161 l'a mesuré en rougissant : le geste ADMIS, le seul que la coquille serve,
    // dépassait le délai de la fixture pendant qu'un utilisateur tapait sa phrase.
    //
    // Ce que #161 craignait en sérialisant — « une demande d'état posée juste après un
    // déverrouillage serait servie avant que le déverrouillage ait fini, et rendrait `verrouille`
    // sur un volume qui s'ouvre » — ne s'applique plus : depuis #162 le déverrouillage rend SON
    // état dans sa propre réponse, et la coquille ne le redemande pas. Tout ce qui MUTE reste dans
    // la file, dans l'ordre d'arrivée.
    const decode = decoderMessage(message.data);
    if (decode.ok && decode.type === TYPES_PRIVILEGIES.etat) return publierLEtat(correlation);
    chaine = chaine
      .then(() => surMessagePrivilegie(message))
      .catch((erreur) => repondreRefus(erreur, correlation));
  });
  port.start();
});

/** File d'exécution du canal privilégié : un message à la fois, dans l'ordre d'arrivée. */
let chaine = Promise.resolve();

/**
 * L'identifiant de corrélation d'un message reçu, ou `null`.
 *
 * Il passe par `correlationAdmise` — l'alphabet clos et la borne de soixante-quatre caractères du
 * contrat — et non par un simple test de type. Il est RENDU TEL QUEL dans la réponse : c'est donc
 * une valeur de l'appelant qui revient à l'appelant, exactement le cas que cette garde borne sur le
 * port restreint depuis la revue de la PR #166. Le canal privilégié n'est pas atteignable depuis
 * l'origine applicative, mais une garde qui ne vaut que d'un côté d'une frontière est une garde
 * qu'on finit par déplacer sans elle (constat 14 de la revue de la PR #167).
 */
function correlationDe(donnee) {
  return correlationAdmise(donnee?.correlation);
}

/** @param {string} code */
function refuserSurLeGlobal(code) {
  self.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.refus, { code, message: messageDeRefus(code) }),
  );
}

/** @param {MessageEvent} event */
async function surMessagePrivilegie(event) {
  const decode = decoderMessage(event.data);
  if (!decode.ok) return repondreCode(decode.code, null);
  const correlation = correlationDe(decode.message);
  if (decode.type === TYPES_PRIVILEGIES.etat) return publierLEtat(correlation);
  if (decode.type === TYPES_PRIVILEGIES.inventaire) return publierLInventaire(correlation);
  if (decode.type === TYPES_PRIVILEGIES.deverrouiller) {
    return deverrouiller(decode.message, correlation);
  }
  if (decode.type === TYPES_PRIVILEGIES.preparation) {
    return preparerUnEmplacement(decode.message, correlation);
  }
  if (decode.type === TYPES_PRIVILEGIES.creerRecuperation) {
    return rendreUnMoyenDeRecuperation(correlation);
  }
  if (decode.type === TYPES_PRIVILEGIES.application) {
    return demarrerLApplication(decode.message, correlation);
  }
  if (decode.type === TYPES_PRIVILEGIES.fermeture) {
    return fermerLeCoffre(decode.message, correlation);
  }
  return repondreCode(CODES_REFUS_COQUILLE.typeInconnu, correlation);
}

/** Poste une réponse APPARIÉE. Le contrôle de capacité a lieu à l'enveloppe. */
function repondre(type, correlation, corps) {
  portPrivilegie.postMessage(
    enveloppeDeMessage(type, sansCapacite({ ...corps, ...correlee(correlation) })),
  );
}

/** L'identifiant, quand il y en a un. Un champ `correlation: null` serait un champ de trop. */
function correlee(correlation) {
  return correlation === null ? {} : { correlation };
}

/**
 * Poste l'état sur le canal privilégié, et ce que l'ÉTAPE 2 a constaté de l'exclusivité.
 *
 * Les deux champs supplémentaires ne franchissent QUE ce canal : `chargeUtileDEtat` reste la forme
 * exacte de ce que le port restreint reçoit, et la coquille n'en relaie que ses deux champs
 * (`main.mjs`, `demanderLEtat`). Le document applicatif n'apprend donc rien de l'exclusivité.
 */
async function publierLEtat(correlation) {
  repondre(TYPES_PRIVILEGIES.etatReponse, correlation, {
    ...chargeUtileDEtat({ etat: interne.etat, barrieres: interne.barrieres }),
    exclusivite: await exclusiviteConstatee,
    application: interne.application === null ? "arretee" : "demarree",
  });
}

/** @param {string} code */
function repondreCode(code, correlation) {
  repondre(TYPES_PRIVILEGIES.refus, correlation, { code, message: messageDeRefus(code) });
}

/**
 * Rend un refus à partir d'une exception. Le CODE de l'erreur est repris tel quel quand il y en a
 * un — c'est ainsi que `VAULT_ENVELOPPE_CLE_REFUSEE`, `VAULT_ENVELOPPE_REJEU` et
 * `VAULT_DERIVATION_CODE_MAL_RECOPIE` remontent jusqu'à la coquille sans être traduits en un refus
 * générique —, et le message est celui de la famille, jamais celui de l'exception : une exception
 * peut nommer un chemin de fichier, un refus rendu n'a rien à en dire.
 *
 * @param {unknown} erreur
 * @param {string | null} correlation
 */
function repondreRefus(erreur, correlation) {
  const code = typeof erreur?.code === "string" ? erreur.code : CODES_REFUS_COQUILLE.typeInconnu;
  portPrivilegie.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.refus, {
      code,
      message: `Le Worker de confiance a refusé le geste (${code}).`,
      ...correlee(correlation),
    }),
  );
}

// --- L'inventaire, qui dit ce que ce coffre PORTE -------------------------------------------------

/** Le support de l'enveloppe. Chaque geste ouvre et referme le handle (ADR 0021). */
function support() {
  return supportEnveloppeOpfs(VOLUME);
}

/**
 * Publie l'inventaire PUBLIC de l'enveloppe, ou l'absence d'enveloppe.
 *
 * Ce que la page en reçoit : la version, et pour chaque emplacement son type, son identifiant, et
 * — pour `webauthn-prf` SEULEMENT — ses paramètres publics en hexadécimal. La restriction n'est pas
 * de la prudence décorative : la page n'a besoin des paramètres que du type qu'elle dérive
 * elle-même. Les paramètres d'Argon2id ne lui servent à rien, et un champ qui ne sert à rien
 * finit par servir à autre chose.
 *
 * Rien de tout cela n'est un secret — le fichier le porte en clair, c'est le canal auxiliaire
 * assumé de l'ADR 0020 —, et rien de tout cela ne franchit jamais le port RESTREINT.
 */
async function publierLInventaire(correlation) {
  // La réponse porte l'ÉTAT, et c'est la correction du constat 3 : la page apprend dans le MÊME
  // message ce que le coffre porte et ce que ce moteur sait faire. Rien n'est muté ici — l'état de
  // ce Worker ne dépend pas de la lecture de l'enveloppe, et le laisser en dépendre était la course.
  const vide = { present: false, versionEnveloppe: null, emplacements: [] };
  if (!PEUT_OUVRIR) return repondre(TYPES_PRIVILEGIES.inventaireReponse, correlation, vide);
  const observe = await support().etat();
  if (!observe.present) return repondre(TYPES_PRIVILEGIES.inventaireReponse, correlation, vide);
  const inventaire = await inventorierEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
  });
  return repondre(TYPES_PRIVILEGIES.inventaireReponse, correlation, {
    present: true,
    identifiantVolume: IDENTIFIANT_VOLUME,
    versionEnveloppe: inventaire.version,
    emplacements: inventaire.emplacements.map((emplacement) => ({
      typeKek: emplacement.typeKek,
      identifiantEmplacement: emplacement.identifiantEmplacement,
      // Les paramètres publics des deux moyens que la PAGE dérive. Ils sont en clair dans le
      // fichier (ADR 0020, canal auxiliaire assumé), et la page en a besoin pour dériver — c'est la
      // seule raison de les lui rendre. Ceux du code de récupération restent ici : il se dérive ici.
      ...(emplacement.typeKek === TYPES_KEK.recuperation
        ? {}
        : { parametresHex: octetsEnHex(emplacement.parametres) }),
    })),
  });
}

/**
 * PRÉPARE un emplacement NEUF pour un moyen que la page dérive : sel tiré, identifiant tiré.
 *
 * Les deux sont PUBLICS — c'est ce que l'ADR 0020 écrit de tout ce que porte le fichier — et la page
 * en a besoin AVANT de dériver, puisque la KEK est liée à l'identifiant de l'emplacement par son
 * info HKDF. Ils sont tirés ICI plutôt que dans la page pour une raison unique : le sel d'une phrase
 * a sa calibration (ADR 0021), et la laisser choisir par l'appelant rouvrirait la porte que le
 * plancher de la RFC 9106 ferme.
 */
function preparerUnEmplacement(message, correlation) {
  const moyen = moyenParNom(message.moyen);
  if (moyen === null || moyen.derivePar !== "page") {
    return repondreCode(CODES_REFUS_COQUILLE.typeInconnu, correlation);
  }
  const parametres =
    moyen.typeKek === TYPES_KEK.phrase
      ? parametresDePhrase({ sel: tirerSelDePhrase(), ...CALIBRATION_PHRASE })
      : null;
  return repondre(TYPES_PRIVILEGIES.preparationReponse, correlation, {
    identifiantVolume: IDENTIFIANT_VOLUME,
    identifiantEmplacement: tirerIdentifiantEmplacement(),
    parametresHex: parametres === null ? null : octetsEnHex(parametres),
  });
}

// --- Déverrouillage ------------------------------------------------------------------------------

/**
 * OUVRE le volume par le moyen que l'utilisateur a présenté.
 *
 * L'ordre est celui de l'ADR 0020, sans raccourci : l'enveloppe est ouverte sous `versionMinimale`,
 * et seulement alors l'ouvreur unique reçoit la clé de volume.
 *
 * **La KEK d'une phrase et celle d'une passkey ARRIVENT déjà dérivées** (ADR 0029, décision 5
 * réécrite) : elles sont calculées dans la réalité de la page — pour la passkey parce que
 * `navigator.credentials` n'existe pas dans un Worker, pour la phrase parce qu'Argon2id est un
 * appel WebAssembly SYNCHRONE qui bloquait ce fil-ci pendant deux secondes. Ce Worker ne voit
 * jamais ni la phrase, ni la sortie PRF, ni les octets d'une KEK : il reçoit un handle opaque.
 * Le CODE de récupération, lui, se dérive ici — HKDF coûte zéro à deux millisecondes, et le faire
 * ailleurs ferait voyager le code une fois de plus pour rien.
 *
 * @param {{ moyen?: unknown, code?: unknown, kek?: unknown, parametresHex?: unknown,
 *           identifiantEmplacement?: unknown, versionMinimale?: unknown }} message
 * @param {string | null} correlation
 */
async function deverrouiller(message, correlation) {
  const moyen = moyenParNom(message.moyen);
  if (moyen === null) {
    return repondreCode(CODES_REFUS_COQUILLE.typeInconnu, correlation);
  }
  exigerUnVolumeAtteignable();
  const versionMinimale = ancre(message.versionMinimale);
  const observe = await support().etat();

  const ouverte = observe.present
    ? await ouvrirLExistante(moyen, message, versionMinimale)
    : await creerLeCoffre(moyen, message);

  // La DEK est effacée QUOI QU'IL ARRIVE, et c'est un `finally` parce que le chemin d'ÉCHEC est
  // celui qui compte : `openOpfsVolume` lève quand un volume est déjà ouvert
  // (`VAULT_STORAGE_BUSY`), et les octets en clair de la clé de volume restaient alors dans le tas
  // du Worker. Un second clic sur « Ouvrir par la phrase » y suffisait — un geste ordinaire, pas un
  // scénario. C'est le constat 5 de la revue de sécurité de la PR #167.
  try {
    await ouvrirLeVolume(ouverte.dek);
  } finally {
    ouverte.dek.fill(0);
  }
  interne.kek = ouverte.kek;
  interne.version = ouverte.version;
  interne.etat = ETATS_DU_VOLUME.ouvert;
  await ecrireEtAcquitter();
  return repondre(TYPES_PRIVILEGIES.deverrouillageReponse, correlation, {
    etat: interne.etat,
    barrieres: interne.barrieres,
    versionEnveloppe: interne.version,
  });
}

/**
 * OUVRE le volume sous la clé développée, en refermant d'abord celui qui l'était.
 *
 * Le backend précédent était ÉCRASÉ sans être fermé : le handle exclusif restait tenu par un objet
 * que plus personne ne référençait, et l'ouverture suivante rendait `VAULT_STORAGE_BUSY` — sur le
 * volume que l'utilisateur venait d'ouvrir lui-même. Constat 6 de la même revue.
 */
async function ouvrirLeVolume(dek) {
  const precedent = interne.backend;
  interne.backend = null;
  interne.etat = ETATS_DU_VOLUME.verrouille;
  if (precedent !== null) await precedent.close();
  interne.backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
}

/**
 * EXIGE que ce moteur puisse atteindre un volume, ou refuse TYPÉ.
 *
 * L'absence reste un ÉTAT — `indisponible` dit « ce moteur ne sait pas », là où `verrouille` dirait
 * « il faut un geste » —, mais le GESTE, lui, reçoit un refus. Il recevait l'état, et la coquille le
 * prenait pour un succès : elle affichait « Coffre ouvert » sur un moteur où rien ne s'était ouvert.
 * Le code est celui que le dépôt emploie déjà partout pour cette absence, et que
 * `deverrouillage-frontiere.spec.mjs` EXIGE des scénarios qui touchent un volume.
 */
function exigerUnVolumeAtteignable() {
  if (PEUT_OUVRIR) return;
  throw new StorageError(
    STORAGE_ERROR_CODES.unsupported,
    "Ce navigateur n'offre pas l'accès synchrone à l'OPFS dans un Worker : aucun volume n'est atteignable ici. Le geste n'a pas échoué — il n'a pas pu être tenté.",
    { volume: VOLUME },
  );
}

/**
 * L'ANCRE de version, telle qu'elle arrive de la SAISIE (ADR 0027, décision 3).
 *
 * Elle est refusée plutôt que corrigée : une version n'est pas un nombre approché, et « 12a » n'est
 * pas 12. La page la contrôle déjà à la frappe ; ce contrôle-ci existe parce que la page n'est pas
 * l'unique appelant possible de ce canal, et qu'une garde qui n'existe que du côté de l'interface
 * n'est pas une garde.
 */
function ancre(valeur) {
  if (valeur === null || valeur === undefined || valeur === "") return null;
  const entier = typeof valeur === "number" ? valeur : Number(valeur);
  if (!Number.isInteger(entier) || entier < 1) {
    const erreur = new Error("L'ancre de version est un entier ≥ 1, ou rien.");
    erreur.code = CODES_REFUS_COQUILLE.messageMalforme;
    throw erreur;
  }
  return entier;
}

/**
 * Ouvre une enveloppe EXISTANTE.
 *
 * Pour une phrase ou une passkey, la KEK est déjà là : ce Worker ne relit RIEN de ce que la page lui
 * dit des paramètres publics, et c'est ce qui rend la question de confiance sans objet — l'enveloppe
 * tranche seule, par `VAULT_ENVELOPPE_CLE_REFUSEE`. Pour un code, l'emplacement est cherché ici, et
 * la dérivation a lieu ici.
 */
async function ouvrirLExistante(moyen, message, versionMinimale) {
  const kek =
    moyen.derivePar === "page"
      ? exigerKekDeLaPage(message.kek)
      : await deriverLeCode(moyen, message);
  const ouverte = await ouvrirEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek,
    versionMinimale,
  });
  return { dek: ouverte.dek, kek, version: ouverte.version };
}

/** DÉRIVE la KEK d'un code de récupération, ICI : HKDF coûte zéro à deux millisecondes. */
async function deriverLeCode(moyen, message) {
  const inventaire = await inventorierEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
  });
  const emplacement = inventaire.emplacements.find(
    (candidat) => candidat.typeKek === moyen.typeKek,
  );
  if (emplacement === undefined) {
    const erreur = new Error(`Aucun emplacement de type « ${moyen.nom} » dans cette enveloppe.`);
    erreur.code = CODES_REFUS_COQUILLE.typeInconnu;
    throw erreur;
  }
  return CATALOGUE.pour(moyen.typeKek).deriver({
    parametres: emplacement.parametres,
    identite: {
      identifiantVolume: IDENTIFIANT_VOLUME,
      identifiantEmplacement: emplacement.identifiantEmplacement,
    },
    geste: { code: String(message.code ?? "") },
  });
}

/**
 * CRÉE le coffre : une clé de volume tirée, une enveloppe posée sous le moyen présenté.
 *
 * `recuperation` est refusé ici, et le refus est de fond : un code de récupération secourt un
 * coffre existant ; en laisser créer un ferait naître un volume dont l'unique clé est un papier —
 * perdu ce papier, tout est perdu, et l'utilisateur n'aurait jamais choisi cela.
 *
 * La DEK est effacée par `deverrouiller`, dans son `finally` : elle est RENDUE à l'appelant, et
 * l'effacer ici la lui retirerait avant qu'il n'ouvre le volume.
 */
async function creerLeCoffre(moyen, message) {
  if (moyen.derivePar !== "page") {
    const erreur = new Error(
      "Aucun coffre n'existe encore : un code de récupération secourt, il ne crée pas.",
    );
    erreur.code = CODES_REFUS_COQUILLE.recuperation;
    throw erreur;
  }
  const kek = exigerKekDeLaPage(message.kek);
  const parametres = hexEnOctets(String(message.parametresHex ?? ""));
  const dek = tirerCleDeVolume();
  const creee = await creerEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek,
    typeKek: moyen.typeKek,
    parametres,
    identifiantEmplacement: String(message.identifiantEmplacement ?? ""),
  });
  return { dek, kek, version: creee.version };
}

// --- Le moyen de récupération, et son code rendu UNE fois -----------------------------------------

/**
 * CRÉE un moyen de récupération et rend son code, une seule fois.
 *
 * Le second appel n'est pas gardé ici : c'est `creerMoyenDeRecuperation` qui rend un PORTEUR dont
 * `rendre()` relâche la chaîne au premier appel et lève `VAULT_DERIVATION_CODE_DEJA_RENDU` ensuite
 * (ADR 0025, décision 3). Le porteur est retenu pour que la garde porte sur LA MÊME instance : la
 * recréer à chaque demande rendrait un code NEUF à chaque clic, ce qui est exactement le défaut que
 * « rendu une seule fois » prétend fermer.
 */
async function rendreUnMoyenDeRecuperation(correlation) {
  if (interne.etat !== ETATS_DU_VOLUME.ouvert || interne.kek === null) {
    return repondreCode(CODES_REFUS_COQUILLE.volumeVerrouille, correlation);
  }
  if (moyenRetenu === null) {
    moyenRetenu = await creerMoyenDeRecuperation({
      support: support(),
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: interne.kek,
    });
    interne.version = moyenRetenu.version;
  }
  // `rendre()` LÈVE au second appel, et la chaîne du canal transforme la levée en refus typé,
  // apparié à sa corrélation. C'est ce chemin-là que l'épreuve mesure depuis la coquille.
  const code = moyenRetenu.rendre();
  return repondre(TYPES_PRIVILEGIES.recuperationRendue, correlation, {
    code,
    versionEnveloppe: moyenRetenu.version,
    typeKek: moyenRetenu.typeKek,
  });
}

/** Le porteur du code de la session. Une seule création par Worker, une seule reddition. */
let moyenRetenu = null;

/**
 * Écrit un secteur connu, puis acquitte une BARRIÈRE. C'est ce compte-là que l'application reçoit :
 * elle ne peut dire « enregistré » qu'après une barrière, jamais après une écriture.
 */
async function ecrireEtAcquitter() {
  const secteur = Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index * 5 + 7) & 0xff);
  await interne.backend.write(0, secteur);
  await interne.backend.flush();
  interne.barrieres += 1;
  annoncerLaBarriere();
}

/** Annonce la barrière sur le canal privilégié. La coquille la relaie au port restreint. */
function annoncerLaBarriere() {
  portPrivilegie.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.barriere, { barrieres: interne.barrieres }),
  );
}

// --- Étape 2 : ce que la coquille constate de l'EXCLUSIVITÉ, avant tout document ------------------

/**
 * Le constat, lancé À L'ÉVALUATION du module — donc avant que la coquille ait pu créer le moindre
 * cadre, puisque le cadre attend l'établissement du canal, qui attend une réponse d'état, qui attend
 * cette promesse. L'ordre de l'étape 2 est ainsi tenu par une DÉPENDANCE, non par une convention.
 */
const exclusiviteConstatee = constaterLExclusivite({ volume: VOLUME, peutOuvrir: PEUT_OUVRIR });

// --- Étape 3 : le backend, PUIS la machine virtuelle ----------------------------------------------

/**
 * DÉVELOPPE la clé de volume depuis l'enveloppe, sous la KEK RETENUE de la session.
 *
 * La KEK est retenue depuis #162 (ADR 0029, limite 2) ; c'est elle qui rend ce geste possible sans
 * redemander la phrase — donc sans la faire vivre une seconde fois et sans payer une seconde
 * dérivation de deux secondes. Ce que ce chemin ajoute est un DÉPLIAGE de plus par geste
 * d'application : AES-KW, quelques microsecondes, et aucune dérivation.
 *
 * Les octets rendus appartiennent à l'appelant, qui les efface dès l'ouverture faite.
 */
async function cleDeVolume() {
  if (interne.kek === null || interne.etat !== ETATS_DU_VOLUME.ouvert) {
    const erreur = new Error("Aucune clé de session : le coffre n'est pas ouvert.");
    erreur.code = CODES_REFUS_COQUILLE.volumeVerrouille;
    throw erreur;
  }
  const ouverte = await ouvrirEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: interne.kek,
  });
  return ouverte.dek;
}

/**
 * DÉMARRE l'application, et retient la poignée de fermeture qu'elle rend.
 *
 * L'ORDRE est contrôlé avant toute autre chose : un boot demandé sur un volume qui n'est pas ouvert
 * est refusé par `VAULT_COQUILLE_ETAPE_HORS_ORDRE` (`cycle-de-vie.mjs`), et c'est la preuve par
 * l'échec de l'inverse que l'ADR 0030 demande.
 */
async function demarrerLApplication(message, correlation) {
  exigerLeBackend({ etatDuVolume: interne.etat });
  if (interne.application !== null) {
    const erreur = new Error("L'application tourne déjà : un second démarrage n'est pas un geste.");
    erreur.code = CODES_REFUS_COQUILLE.etapeHorsOrdre;
    throw erreur;
  }
  const demarrage = await demarrerLaVm({
    cleDeVolume,
    reprendreParInstantane: message?.reprendreParInstantane !== false,
  });
  if (!demarrage.demarree) {
    return repondre(TYPES_PRIVILEGIES.applicationReponse, correlation, {
      demarree: false,
      motif: demarrage.motif,
      code: CODES_REFUS_COQUILLE.applicationAbsente,
    });
  }
  interne.application = { fermer: demarrage.fermer };
  // Les barrières du GUEST entrent dans le compte que l'application reçoit : c'est l'étape 5 du
  // cycle de vie — « un flush traverse toutes les couches avant son acquittement » —, et jusqu'ici
  // la coquille ne comptait que la sienne, écrite pour prouver qu'elle savait en franchir une.
  interne.barrieres += demarrage.compte.counts?.["flush-ack"] ?? 0;
  annoncerLaBarriere();
  return repondre(TYPES_PRIVILEGIES.applicationReponse, correlation, {
    demarree: true,
    installation: demarrage.installation,
    etat: interne.etat,
    barrieres: interne.barrieres,
    ...compteRenduPublie(demarrage.compte),
  });
}

// --- Étape 7 : la fermeture propre ----------------------------------------------------------------

/**
 * FERME proprement : arrêter la VM, capturer l'instantané, `close()` les volumes.
 *
 * **L'ordre est le contrat, et il ne se réordonne pas.** `close()` attend les E/S déjà ACCEPTÉES
 * (#132) et libère le nom du volume ; le `terminate()` du Worker vient APRÈS, et il est le fait de
 * la page. Terminer avant `close()` laisserait le handle exclusif tenu par un objet que plus
 * personne ne référence, et l'ouverture suivante rendrait `VAULT_STORAGE_BUSY` — sur le volume que
 * l'utilisateur vient de rouvrir lui-même (constat 6 de la revue de sécurité de la PR #167).
 *
 * La CAPTURE a lieu avant l'arrêt, dans l'ordre de l'ADR 0024 décision 6 : suspension du guest,
 * quiescence, scellement. Elle ne peut pas faire échouer une fermeture par ailleurs propre — une
 * capture refusée rend son motif, jamais une exception.
 *
 * **Ce que ce geste NE décide pas** : ni quand il se déclenche, ni sous quel délai, ni ce que
 * « verrouillé » veut dire. #25 possède l'état et la règle, et réemploiera ce chemin (ADR 0030,
 * décision 3).
 */
async function fermerLeCoffre(message, correlation) {
  const capture =
    interne.application === null
      ? null
      : await interne.application.fermer({ capturer: message?.capturer !== false });
  interne.application = null;
  const precedent = interne.backend;
  interne.backend = null;
  // Les clés partent AVANT le `close()` : si la fermeture du handle échouait, la coquille aurait
  // déjà cessé de détenir de quoi ouvrir. C'est l'ordre dont l'échec ne laisse rien derrière.
  interne.kek = null;
  moyenRetenu = null;
  interne.etat = PEUT_OUVRIR ? ETATS_DU_VOLUME.verrouille : ETATS_DU_VOLUME.indisponible;
  if (precedent !== null) await precedent.close();
  return repondre(TYPES_PRIVILEGIES.fermetureReponse, correlation, {
    etat: interne.etat,
    barrieres: interne.barrieres,
    capture,
  });
}
