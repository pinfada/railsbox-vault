// Le DÉVERROUILLAGE du Worker de confiance : les clés, l'enveloppe, l'ouverture du volume (#191).
//
// Il est sorti de `runtime-worker.mjs` SANS changement de comportement, pour tenir le plafond de
// lignes (`tests/unit/taille-des-fichiers.test.mjs`). Le Worker garde le canal, le dispatch et l'ÉTAT
// partagé (`interne`) : ce module n'en crée aucun second, il reçoit le MÊME objet par
// `brancherLeDeverrouillage`, comme `portabilite-du-worker.mjs`. Il est importé par
// `runtime-worker.mjs` et ne s'exécute que dans lui ; la KEK et la clé de volume qu'il manipule ne
// franchissent aucun `postMessage`.

import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";
import {
  IDENTIFIANT_DU_COFFRE,
  IDENTIFIANT_DU_VOLUME_COQUILLE,
} from "/src/coquille/identites-du-coffre.mjs";
import { TYPES_PRIVILEGIES } from "/src/coquille/contrat-de-messages.mjs";
import { refusDOuverture } from "/src/coquille/portabilite-du-coffre.mjs";
import { ETATS_DU_VOLUME } from "/src/coquille/etat-de-la-coquille.mjs";
import {
  ancreDeVersion,
  exigerKekDeLaPage,
  moyenParNom,
} from "/src/coquille/moyens-de-deverrouillage.mjs";
import { ouvrirParLeCode } from "/src/coquille/ouverture-par-le-code.mjs";
import { constaterALOuverture, feuilleConstatee } from "/src/coquille/preuve-de-la-feuille.mjs";
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

/** L'identité que l'enveloppe authentifie, celle du COFFRE et du volume `application` (ADR 0039). */
const IDENTIFIANT_VOLUME = IDENTIFIANT_DU_COFFRE;

/** Trente-deux secteurs : de quoi écrire et relire, sans faire du démarrage une mesure de disque. */
const TAILLE = 32 * SECTOR_SIZE;

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

// Le contexte du Worker, posé UNE fois par `brancherLeDeverrouillage` : les MÊMES objets et les
// mêmes fonctions que ceux du Worker, aucun second état.
let interne;
let support;
let repondre;
let repondreCode;
let repondreRefus;
let constaterLaPortabilite;
let annoncerLaBarriere;
let exigerUnVolumeAtteignable;
let volume;

/**
 * @param {{ interne: object, support: Function, repondre: Function, repondreCode: Function,
 *           repondreRefus: Function, constater: Function, annoncerLaBarriere: Function,
 *           exigerUnVolumeAtteignable: Function, volume: string }} contexte
 */
export function brancherLeDeverrouillage(contexte) {
  ({
    interne,
    support,
    repondre,
    repondreCode,
    repondreRefus,
    constater: constaterLaPortabilite,
    annoncerLaBarriere,
    exigerUnVolumeAtteignable,
    volume,
  } = contexte);
}

/** Oublie le porteur du code de la session : la fermeture et la restauration le font. */
export function oublierLeMoyenRetenu() {
  moyenRetenu = null;
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
export function preparerUnEmplacement(message, correlation) {
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
export async function deverrouiller(message, correlation) {
  const moyen = moyenParNom(message.moyen);
  if (moyen === null) {
    return repondreCode(CODES_REFUS_COQUILLE.typeInconnu, correlation);
  }
  exigerUnVolumeAtteignable();
  const refusDuCoffre = refusDOuverture(await constaterLaPortabilite());
  if (refusDuCoffre !== null)
    throw Object.assign(new Error(refusDuCoffre), { code: refusDuCoffre });
  const versionMinimale = ancreDeVersion(message.versionMinimale);
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
  // Après l'ouverture seulement ; la barrière qui suit rend l'inscription durable (#239).
  const constat = await constaterALOuverture(interne.backend, ouverte.identifiantEprouve);
  interne.eprouves = constat.identifiants;
  interne.kek = ouverte.kek;
  interne.version = ouverte.version;
  interne.etat = ETATS_DU_VOLUME.ouvert;
  await ecrireEtAcquitter();
  const feuille = await feuilleConstatee(interne.eprouves, () =>
    inventorierEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_VOLUME }),
  );
  // Une preuve illisible ne referme pas le coffre ; son refus est publié, jamais avalé.
  for (const erreur of [constat.erreur, feuille.erreur]) if (erreur) repondreRefus(erreur, null);
  return repondre(TYPES_PRIVILEGIES.deverrouillageReponse, correlation, {
    etat: interne.etat,
    barrieres: interne.barrieres,
    versionEnveloppe: interne.version,
    enveloppeMigree: ouverte.migree === true,
    feuilleEprouvee: feuille.eprouvee,
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
  interne.eprouves = [];
  if (precedent !== null) await precedent.close();
  interne.backend = await openOpfsVolume({
    name: volume,
    size: TAILLE,
    cle: dek,
    identifiantVolume: IDENTIFIANT_DU_VOLUME_COQUILLE,
    transactionnel: false,
  });
}

/**
 * Ouvre une enveloppe EXISTANTE, sous la KEK de la page ou sous un code de récupération.
 *
 * `enveloppeMigree` remonte jusqu'à l'utilisateur, et c'est son seul emploi : une migration de page
 * AVANCE la version d'un cran qu'il n'a pas décidé (revue de sécurité de la PR #187, constat 5), et
 * l'ancre notée AVANT ne détecte plus l'effacement de la page v2.
 */
async function ouvrirLExistante(moyen, message, versionMinimale) {
  const ouverte =
    moyen.derivePar === "page"
      ? await ouvrirSousLaPage(message, versionMinimale)
      : await ouvrirSousLeCode(moyen, message, versionMinimale);
  return {
    dek: ouverte.dek,
    kek: ouverte.kek,
    version: ouverte.version,
    migree: ouverte.migration?.faite === true,
    // Seul un CODE éprouve une feuille, jamais l'emplacement d'une phrase ou d'une passkey.
    identifiantEprouve: moyen.derivePar === "page" ? null : ouverte.identifiantEmplacement,
  };
}

/** La KEK est DÉJÀ LÀ : ce Worker ne relit RIEN des paramètres publics — l'enveloppe tranche seule. */
async function ouvrirSousLaPage(message, versionMinimale) {
  const kek = exigerKekDeLaPage(message.kek);
  const ouverte = await ouvrirEnveloppe({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek,
    versionMinimale,
  });
  return { ...ouverte, kek };
}

/**
 * OUVRE sous un code, en ESSAYANT chaque emplacement de récupération (#214).
 *
 * Ce Worker CHOISISSAIT le premier emplacement de type 4 et dérivait sous son sel : un coffre qui en
 * porte deux — ce qu'un rechargement rend ordinaire — refusait le code qu'il venait d'imprimer. La
 * boucle sans court-circuit vit dans `ouverture-par-le-code.mjs`, avec son motif, et le banc de
 * référence l'appelle aussi. Le refus d'un coffre SANS emplacement de récupération reste celui
 * d'ici : il nomme le moyen demandé.
 */
async function ouvrirSousLeCode(moyen, message, versionMinimale) {
  return ouvrirParLeCode({
    support: support(),
    identifiantVolume: IDENTIFIANT_VOLUME,
    code: String(message.code ?? ""),
    derivateur: CATALOGUE.pour(moyen.typeKek),
    versionMinimale,
    sansEmplacement: () =>
      Object.assign(new Error(`Aucun emplacement de type « ${moyen.nom} » dans cette enveloppe.`), {
        code: CODES_REFUS_COQUILLE.typeInconnu,
      }),
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
  return { dek, kek, version: creee.version, identifiantEprouve: null };
}

// --- Le moyen de récupération, et son code rendu UNE fois -----------------------------------------

/**
 * CRÉE un moyen de récupération et rend son code, une seule fois PAR CODE : `rendre()` relâche la
 * chaîne au premier appel et lève `VAULT_DERIVATION_CODE_DEJA_RENDU` ensuite (ADR 0025, décision 3).
 * La garde est structurelle et vaut PAR CODE ; `moyenRetenu` ne la double pas — voir sa déclaration.
 */
export async function rendreUnMoyenDeRecuperation(correlation) {
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

/**
 * Le porteur du code de LA SESSION : une commodité, jamais la garantie (#214 ; ADR 0029, limite 2).
 * C'est une variable de MODULE, que tout Worker neuf remet à `null` (rechargement, verrouillage de
 * #169) : le geste suivant AJOUTE un second code, que l'ouverture sait désormais essayer. Ce que le
 * porteur achète, et c'est tout : un double clic dans la MÊME page ne brûle pas une place sur huit.
 */
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
export async function cleDeVolume() {
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
