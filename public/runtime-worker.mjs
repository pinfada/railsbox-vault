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
  decoderMessage,
  enveloppeDeMessage,
  sansCapacite,
} from "/src/coquille/contrat-de-messages.mjs";
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { moyenParNom } from "/src/coquille/moyens-de-deverrouillage.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";
import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { argon2Vendu } from "/src/vm/derivation/argon2-vendu.mjs";
import {
  CALIBRATION_PHRASE,
  derivateurPhrase,
  parametresDePhrase,
  tirerSelDePhrase,
} from "/src/vm/derivation/derivateur-phrase.mjs";
import { derivateurRecuperation } from "/src/vm/derivation/derivateur-recuperation.mjs";
import { catalogueDeDerivateurs } from "/src/vm/derivation/derivateurs.mjs";
import { preparerEmplacementDerive } from "/src/vm/derivation/emplacement-derive.mjs";
import {
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
} from "/src/vm/enveloppe-de-cle.mjs";
import { TYPES_KEK, tirerCleDeVolume } from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "/src/vm/format-chiffre/octets.mjs";
import { creerMoyenDeRecuperation } from "/src/vm/moyen-de-recuperation.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
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
 * `webauthn-prf` n'y est pas, et ce n'est pas un oubli : cette dérivation-là se fait dans la page
 * (ADR 0021, décision 5), et le Worker n'en reçoit que la `CryptoKey`. Le catalogue dit donc ce que
 * le WORKER sert, ce qui est exactement la question que `catalogue.pour` pose. Un type absent rend
 * `VAULT_DERIVATION_TYPE_INCONNU` — jamais une tentative sous un dérivateur approchant.
 */
const CATALOGUE = catalogueDeDerivateurs({
  [TYPES_KEK.phrase]: derivateurPhrase({ argon2: argon2Vendu() }),
  [TYPES_KEK.recuperation]: derivateurRecuperation(),
});

/**
 * Ce que le Worker sait de lui-même. Rien de tout cela ne franchit un `postMessage`.
 */
const interne = {
  etat: ETATS_DU_VOLUME.verrouille,
  barrieres: 0,
  /** Backend du volume ouvert. Il tient le handle exclusif ; il n'est jamais posté. */
  backend: null,
  /** La KEK de la session, retenue pour les gestes qui exigent un volume ouvert. Voir l'en-tête. */
  kek: null,
  /** La version d'enveloppe observée à la dernière ouverture ou au dernier ajout. */
  version: null,
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

/** L'identifiant de corrélation d'un message reçu, ou `null`. Il est rendu TEL QUEL. */
function correlationDe(donnee) {
  const valeur = donnee?.correlation;
  return typeof valeur === "string" ? valeur : null;
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
  if (decode.type === TYPES_PRIVILEGIES.creerRecuperation) {
    return rendreUnMoyenDeRecuperation(correlation);
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

/** Poste l'état sur le canal privilégié. */
function publierLEtat(correlation) {
  repondre(
    TYPES_PRIVILEGIES.etatReponse,
    correlation,
    chargeUtileDEtat({ etat: interne.etat, barrieres: interne.barrieres }),
  );
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
  if (!capaciteDOuverture()) {
    interne.etat = ETATS_DU_VOLUME.indisponible;
    return repondre(TYPES_PRIVILEGIES.inventaireReponse, correlation, {
      present: false,
      versionEnveloppe: null,
      emplacements: [],
    });
  }
  const observe = await support().etat();
  if (!observe.present) {
    return repondre(TYPES_PRIVILEGIES.inventaireReponse, correlation, {
      present: false,
      versionEnveloppe: null,
      emplacements: [],
    });
  }
  const inventaire = await inventorierEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
  });
  interne.version = inventaire.version;
  return repondre(TYPES_PRIVILEGIES.inventaireReponse, correlation, {
    present: true,
    identifiantVolume: IDENTIFIANT_VOLUME,
    versionEnveloppe: inventaire.version,
    emplacements: inventaire.emplacements.map((emplacement) => ({
      typeKek: emplacement.typeKek,
      identifiantEmplacement: emplacement.identifiantEmplacement,
      ...(emplacement.typeKek === TYPES_KEK["webauthn-prf"]
        ? { parametresHex: octetsEnHex(emplacement.parametres) }
        : {}),
    })),
  });
}

// --- Déverrouillage ------------------------------------------------------------------------------

/**
 * OUVRE le volume par le moyen que l'utilisateur a présenté.
 *
 * L'ordre est celui de l'ADR 0020, sans raccourci : l'inventaire public est lu, l'emplacement du
 * type demandé est choisi, la KEK est dérivée sous l'identité de CET emplacement, l'enveloppe est
 * ouverte sous `versionMinimale`, et seulement alors l'ouvreur reçoit la clé de volume.
 *
 * @param {{ moyen?: unknown, phrase?: unknown, code?: unknown, kek?: unknown,
 *           parametresHex?: unknown, versionMinimale?: unknown }} message
 * @param {string | null} correlation
 */
async function deverrouiller(message, correlation) {
  const moyen = moyenParNom(message.moyen);
  if (moyen === null) {
    return repondreCode(CODES_REFUS_COQUILLE.typeInconnu, correlation);
  }
  if (!capaciteDOuverture()) {
    interne.etat = ETATS_DU_VOLUME.indisponible;
    return publierLEtat(correlation);
  }
  const versionMinimale = ancre(message.versionMinimale);
  const observe = await support().etat();

  const ouverte = observe.present
    ? await ouvrirLExistante(moyen, message, versionMinimale)
    : await creerLeCoffre(moyen, message);

  interne.backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: ouverte.dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
  // La DEK est EFFACÉE dès que l'ouvreur l'a importée : l'ouvreur en garde une `CryptoKey` non
  // extractible, jamais les octets. Ce n'est pas une garantie — le moteur a pu copier —, c'est une
  // fenêtre refermée, et elle est gratuite (`ouverture-par-enveloppe.mjs`, même geste).
  ouverte.dek.fill(0);
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

/** Ouvre une enveloppe EXISTANTE : inventaire, choix de l'emplacement, dérivation, ouverture. */
async function ouvrirLExistante(moyen, message, versionMinimale) {
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
  const identite = {
    identifiantVolume: IDENTIFIANT_VOLUME,
    identifiantEmplacement: emplacement.identifiantEmplacement,
  };
  const kek =
    moyen.derivePar === "page"
      ? exigerKekDeLaPage(message.kek)
      : await CATALOGUE.pour(moyen.typeKek).deriver({
          parametres: emplacement.parametres,
          identite,
          geste: gesteDuMoyen(moyen, message),
        });
  const ouverte = await ouvrirEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek,
    versionMinimale,
  });
  return { dek: ouverte.dek, kek, version: ouverte.version };
}

/**
 * CRÉE le coffre : une clé de volume tirée, une enveloppe posée sous le moyen présenté.
 *
 * `recuperation` est refusé ici, et le refus est de fond : un code de récupération secourt un
 * coffre existant ; en laisser créer un ferait naître un volume dont l'unique clé est un papier —
 * perdu ce papier, tout est perdu, et l'utilisateur n'aurait jamais choisi cela.
 */
async function creerLeCoffre(moyen, message) {
  if (moyen.typeKek === TYPES_KEK.recuperation) {
    const erreur = new Error(
      "Aucun coffre n'existe encore : un code de récupération secourt, il ne crée pas.",
    );
    erreur.code = CODES_REFUS_COQUILLE.recuperation;
    throw erreur;
  }
  const pose =
    moyen.derivePar === "page"
      ? {
          kek: exigerKekDeLaPage(message.kek),
          parametres: hexEnOctets(String(message.parametresHex ?? "")),
          identifiantEmplacement: String(message.identifiantEmplacement ?? ""),
        }
      : await preparerLaPhrase(message);
  const dek = tirerCleDeVolume();
  const creee = await creerEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek: pose.kek,
    typeKek: moyen.typeKek,
    parametres: pose.parametres,
    identifiantEmplacement: pose.identifiantEmplacement,
  });
  return { dek, kek: pose.kek, version: creee.version };
}

/** Le sel d'une phrase NEUVE est TIRÉ, et sa calibration est celle de l'ADR 0021. */
async function preparerLaPhrase(message) {
  const parametres = parametresDePhrase({ sel: tirerSelDePhrase(), ...CALIBRATION_PHRASE });
  const prepare = await preparerEmplacementDerive({
    identifiantVolume: IDENTIFIANT_VOLUME,
    derivateur: CATALOGUE.pour(TYPES_KEK.phrase),
    parametres,
    geste: { phrase: String(message.phrase ?? "") },
  });
  return { kek: prepare.kek, parametres, identifiantEmplacement: prepare.identifiantEmplacement };
}

/** Le GESTE que le dérivateur attend, choisi par le moyen. Aucun moyen n'en reçoit deux. */
function gesteDuMoyen(moyen, message) {
  if (moyen.typeKek === TYPES_KEK.phrase) return { phrase: String(message.phrase ?? "") };
  return { code: String(message.code ?? "") };
}

/**
 * EXIGE une KEK opaque venue de la page, et rien d'autre.
 *
 * La garde est ici comme elle est à l'enveloppe (`enveloppePrivilegiee`), et les deux ne font pas
 * double emploi : l'une décide ce qui a le droit de PARTIR, l'autre ce qui a le droit d'ARRIVER.
 * Une seule des deux laisserait le canal ouvert dans le sens qu'elle ne garde pas.
 */
function exigerKekDeLaPage(kek) {
  if (kek?.constructor?.name !== "CryptoKey" || kek.extractable !== false) {
    const erreur = new Error(
      "Une passkey présente une CryptoKey NON EXTRACTIBLE, jamais des octets de clé.",
    );
    erreur.code = CODES_REFUS_COQUILLE.capaciteDansUnMessage;
    throw erreur;
  }
  return kek;
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

/**
 * Le moteur fournit-il de quoi ouvrir un volume ?
 *
 * L'OPFS et son accès synchrone manquent à un moteur de la matrice #2 (WebKit) : l'absence est
 * rendue comme un ÉTAT — `indisponible` — et non comme un refus de déverrouillage, parce que ce
 * n'est pas le geste qui a échoué. Confondre les deux ferait redemander à l'utilisateur une phrase
 * qui n'ouvrirait rien.
 */
function capaciteDOuverture() {
  return (
    typeof navigator?.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function"
  );
}
