// Le WORKER DE CONFIANCE de la coquille de produit (#161, ADR 0028).
//
// Jusqu'à cette tranche, ce fichier faisait TROIS lignes : il postait un message et mourait. Les
// deux seuls fichiers du dépôt qui portaient les mots « Worker de confiance » étaient des Workers de
// BANCS — `public/vm/deverrouillage-worker.mjs` et `public/vm/enveloppe-worker.mjs`. Ce qui suit
// reprend leur capacité — ouvrir un volume par une clé de déverrouillage, sans jamais rendre de clé
// — et la met sur le chemin du produit.
//
// ## Ce qu'il détient, et ce qui n'en sort pas
//
// Il détient le port privilégié, la clé de volume développée et le handle du volume. Rien de cela
// ne franchit un `postMessage` : ce qu'il rend est un ÉTAT — quatre valeurs et un compte de
// barrières —, construit par `src/coquille/etat-de-la-coquille.mjs` et contrôlé par `sansCapacite`
// avant d'être posté. Le port restreint de l'application, lui, ne le joint pas du tout : il s'arrête
// à la coquille, qui ne relaie que la question d'état.
//
// ## Le geste de déverrouillage vient du HARNAIS, et c'est la réserve écrite de cette tranche
//
// La coquille n'a pas encore d'interface de saisie : c'est la tranche 2 (#162) qui l'ajoute, avec
// la phrase, la passkey et le code de récupération. Ici, le geste est fourni par le harnais, sous le
// JETON exact de `src/vm/cle-de-volume.mjs` — la porte que `tests/unit/harnais-portes.test.mjs`
// surveille déjà, et la même que celle de la réserve de `SEC-BLOCK-001` dans `SECURITY.md`. Sans le
// jeton, `deverrouiller` refuse bruyamment et l'état reste `verrouille` : aucun chemin de production
// ne transmet ce jeton, et aucun fichier publié ne contient sa valeur.
//
// Ce que cela ne change PAS : la frontière que cette tranche prouve ne dépend pas du déverrouillage.
// Les refus opposés au document applicatif sont calculés avant que le moindre état soit consulté.

import {
  TYPES_PRIVILEGIES,
  decoderMessage,
  enveloppeDeMessage,
  sansCapacite,
} from "/src/coquille/contrat-de-messages.mjs";
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";
import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { cleDeVolumeDuHarnais, clesDeDeverrouillageDuHarnais } from "/src/vm/cle-de-volume.mjs";
import { creerEnveloppe, ouvrirEnveloppe } from "/src/vm/enveloppe-de-cle.mjs";
import { octetsEnHex } from "/src/vm/format-chiffre/octets.mjs";
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

/** Ce que le Worker sait de lui-même. Rien de tout cela ne franchit un `postMessage`. */
const interne = {
  etat: ETATS_DU_VOLUME.verrouille,
  barrieres: 0,
  /** Backend du volume ouvert. Il tient le handle exclusif ; il n'est jamais posté. */
  backend: null,
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
    chaine = chaine
      .then(() => surMessagePrivilegie(message))
      .catch((erreur) => repondreRefus(erreur));
  });
  port.start();
});

/** File d'exécution du canal privilégié : un message à la fois, dans l'ordre d'arrivée. */
let chaine = Promise.resolve();

/** @param {string} code */
function refuserSurLeGlobal(code) {
  self.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.refus, { code, message: messageDeRefus(code) }),
  );
}

/** @param {MessageEvent} event */
async function surMessagePrivilegie(event) {
  const decode = decoderMessage(event.data);
  if (!decode.ok) return repondreCode(decode.code);
  if (decode.type === TYPES_PRIVILEGIES.etat) return publierLEtat();
  // Le déverrouillage ne publie PAS l'état : la coquille le redemande, et la file ci-dessus garantit
  // que la réponse suit le geste. Publier ici rendrait deux `etatReponse` pour une question.
  if (decode.type === TYPES_PRIVILEGIES.deverrouiller) {
    return deverrouiller(decode.message.jeton);
  }
  return repondreCode(CODES_REFUS_COQUILLE.typeInconnu);
}

/** Poste l'état sur le canal privilégié. Le contrôle de capacité a lieu à l'enveloppe. */
function publierLEtat() {
  const charge = chargeUtileDEtat({ etat: interne.etat, barrieres: interne.barrieres });
  portPrivilegie.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.etatReponse, sansCapacite({ ...charge })),
  );
}

/** @param {string} code */
function repondreCode(code) {
  portPrivilegie.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.refus, { code, message: messageDeRefus(code) }),
  );
}

/**
 * Rend un refus à partir d'une exception. Le CODE de l'erreur est repris tel quel quand il y en a
 * un — c'est ainsi que `VAULT_ENVELOPPE_CLE_REFUSEE` remonte jusqu'à la coquille sans être traduit
 * en un refus générique —, et le message est celui de la famille, jamais celui de l'exception : une
 * exception peut nommer un chemin de fichier, un refus rendu n'a rien à en dire.
 *
 * @param {unknown} erreur
 */
function repondreRefus(erreur) {
  const code = typeof erreur?.code === "string" ? erreur.code : CODES_REFUS_COQUILLE.typeInconnu;
  portPrivilegie.postMessage(
    enveloppeDeMessage(TYPES_PRIVILEGIES.refus, {
      code,
      message: `Le Worker de confiance a refusé le geste (${code}).`,
    }),
  );
}

// --- Déverrouillage ------------------------------------------------------------------------------

/**
 * Ouvre le volume par une clé de déverrouillage. Le jeton est celui du HARNAIS : sans lui,
 * `clesDeDeverrouillageDuHarnais` lève, et l'état reste `verrouille`.
 *
 * @param {unknown} jeton
 */
async function deverrouiller(jeton) {
  const kek = clesDeDeverrouillageDuHarnais({ jeton: String(jeton ?? "") }).initiale;
  if (!capaciteDOuverture()) {
    interne.etat = ETATS_DU_VOLUME.indisponible;
    return;
  }
  const support = supportEnveloppeOpfs(VOLUME);
  const observe = await support.etat();
  if (!observe.present) await poserLEnveloppe(support, kek, jeton);
  const ouverte = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek,
  });
  interne.backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: ouverte.dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
  await ecrireEtAcquitter();
  interne.etat = ETATS_DU_VOLUME.ouvert;
}

/**
 * Crée l'enveloppe du volume. La DEK vient du harnais, comme la KEK : le produit n'en fabrique
 * aucune (ADR 0016 décision 6), et la tranche 2 remplacera les deux par un geste de l'utilisateur.
 */
async function poserLEnveloppe(support, kek, jeton) {
  const dek = cleDeVolumeDuHarnais({ jeton: String(jeton ?? "") });
  await creerEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, dek, kek });
}

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
