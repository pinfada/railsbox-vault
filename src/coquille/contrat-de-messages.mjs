// Le CONTRAT DE MESSAGES de la coquille de produit (#161, ADR 0028).
//
// Il remplace `railsbox-vault-browser-harness`, dont l'identifiant disait ce qu'il était : le
// contrat d'un harnais, à trois lignes, sans port, sans cadre et sans clé. Ce qui suit est un
// contrat de PRODUIT, versionné, et son encodage est refusé STRICTEMENT : un message qui n'est pas
// un objet, qui ne porte pas l'identifiant du contrat, qui porte une autre version ou dont le type
// n'est pas une chaîne reçoit un refus TYPÉ. Jamais un silence, jamais un repli.
//
// ## Ce qui est repris du spike #35, et ce qui ne l'est pas
//
// Repris : la STRUCTURE — canal privilégié établi avant qu'aucun document applicatif n'existe, port
// restreint transféré une fois, vérification triple de l'annonce. Non repris : la forme des messages
// (`vault.app-hello`, `vault.channel-grant`, `vault.status`), que l'ADR 0002 réserve nommément à
// #24 sous « Interfaces à ne pas figer ». Cette liste-là est une liste d'écueils, pas une base de
// départ : recopier ses noms aurait figé par inadvertance ce que l'ADR avait mis de côté.
//
// ## Deux canaux, deux vocabulaires
//
// Le canal PRIVILÉGIÉ (coquille ↔ Worker de confiance) et le port RESTREINT (coquille ↔ document
// applicatif) ne parlent pas la même langue, et c'est une propriété, pas une commodité de nommage :
// un type du canal privilégié posé sur le port restreint n'y est pas admis, et réciproquement.
// `estTypePrivilegie` existe pour que la coquille puisse refuser NOMMÉMENT la tentative la plus
// évidente — réclamer le canal privilégié depuis le port de l'application.

import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";

/**
 * Identité et version du contrat. La version est un ENTIER et se compare exactement : un document
 * applicatif qui parlerait une autre version est refusé, jamais servi « au mieux ».
 */
export const CONTRAT_COQUILLE = Object.freeze({
  id: "railsbox-vault-coquille",
  version: 1,
});

/** Les types du canal PRIVILÉGIÉ, entre la coquille et le Worker de confiance. */
export const TYPES_PRIVILEGIES = Object.freeze({
  /** Établissement du canal : la coquille transfère un port au Worker, avant tout document. */
  canal: "vault.coquille.canal-privilegie",
  /** Geste de déverrouillage. La tranche 2 lui donnera une interface ; ici le harnais le fournit. */
  deverrouiller: "vault.coquille.deverrouiller",
  /** Demande d'état : même question que sur le port restreint, sur l'autre canal et sous un autre nom. */
  etat: "vault.coquille.etat-prive",
  etatReponse: "vault.coquille.etat-prive-reponse",
  /** Annonce du Worker : une barrière de durabilité vient d'être acquittée. */
  barriere: "vault.coquille.barriere-privee",
  refus: "vault.coquille.refus-prive",
});

/** Les types du port RESTREINT, entre la coquille et le document applicatif. */
export const TYPES_APPLICATIFS = Object.freeze({
  /** Annonce du document applicatif, reçue sur `window`. Seul message accepté là. */
  annonce: "vault.coquille.annonce",
  /** Réponse de la coquille sur `window`, porteuse du port restreint transféré. */
  octroi: "vault.coquille.octroi",
  /** Le seul geste ADMIS sur le port restreint (voir `admission-applicative.mjs`). */
  etat: "vault.coquille.etat",
  etatReponse: "vault.coquille.etat-reponse",
  /** Annonce poussée par la coquille : les écritures du guest sont durables. */
  barriere: "vault.coquille.barriere",
  refus: "vault.coquille.refus",
});

const TYPES_PRIVILEGIES_CONNUS = Object.freeze(new Set(Object.values(TYPES_PRIVILEGIES)));

/** @param {unknown} type */
export function estTypePrivilegie(type) {
  return typeof type === "string" && TYPES_PRIVILEGIES_CONNUS.has(type);
}

/**
 * Enveloppe un message du contrat. Le corps est recopié TEL QUEL après contrôle : c'est
 * `sansCapacite` qui décide de ce qui a le droit d'y figurer, et il refuse plutôt que de filtrer.
 *
 * @param {string} type
 * @param {Record<string, unknown>} [corps]
 */
export function enveloppeDeMessage(type, corps = {}) {
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("Un message du contrat de coquille doit porter un type non vide.");
  }
  sansCapacite(corps);
  return Object.freeze({
    contrat: CONTRAT_COQUILLE.id,
    version: CONTRAT_COQUILLE.version,
    type,
    ...corps,
  });
}

/**
 * Longueur maximale d'un TYPE, en caractères. Cent vingt-huit, soit près de six fois le plus long
 * type du contrat (`vault.coquille.etat-prive-reponse`, vingt-neuf caractères).
 *
 * Elle existe parce que le contrat ne bornait que la PROFONDEUR d'un corps, jamais sa taille : la
 * revue de #166 a posté quarante messages dont le seul champ `type` faisait deux cent mille
 * caractères. Un type n'est pas une charge utile ; au-delà de cette borne, ce n'en est pas un.
 */
export const TAILLE_MAXIMALE_DU_TYPE = 128;

/**
 * Longueur maximale d'un identifiant de CORRÉLATION, et son alphabet.
 *
 * Il est rendu TEL QUEL à l'appelant : c'est donc une valeur du guest qui revient au guest, et elle
 * doit être bornée et close pour que ce retour ne soit jamais un canal. Soixante-quatre caractères
 * suffisent à un UUID comme à un compteur ; l'alphabet exclut tout ce qui ne serait pas un
 * identifiant.
 */
export const TAILLE_MAXIMALE_DE_CORRELATION = 64;
const CORRELATION_ADMISE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Un identifiant de corrélation admissible, ou `null`.
 *
 * @param {unknown} valeur
 * @returns {string | null}
 */
export function correlationAdmise(valeur) {
  if (typeof valeur !== "string") return null;
  if (valeur.length > TAILLE_MAXIMALE_DE_CORRELATION) return null;
  return CORRELATION_ADMISE.test(valeur) ? valeur : null;
}

/**
 * Longueur à laquelle un type REFUSÉ est tronqué avant d'être rendu à son émetteur.
 *
 * Il ne va nulle part ailleurs : depuis la revue de #166, le relevé de la coquille ne porte plus que
 * des COMPTEURS, et aucune chaîne du guest n'y entre. Ce qui revient au guest est ce que le guest a
 * envoyé, borné — assez pour qu'un développeur reconnaisse son message, trop peu pour être un canal.
 */
export const TAILLE_MAXIMALE_DU_TYPE_RENDU = 64;

/** @param {string} type */
export function typeRendu(type) {
  return type.length <= TAILLE_MAXIMALE_DU_TYPE_RENDU
    ? type
    : `${type.slice(0, TAILLE_MAXIMALE_DU_TYPE_RENDU)}…`;
}

/**
 * Décode STRICTEMENT un message reçu. Cinq refus, dans cet ordre, et chacun a sa raison :
 *
 *  1. ce n'est pas un objet — un nombre, une chaîne, `null`, un tableau : rien à décoder ;
 *  2. l'identifiant du contrat n'est pas le nôtre — un autre logiciel parle sur le même canal ;
 *  3. la version diffère — servir « au mieux » une version inconnue est la façon la plus banale
 *     d'accepter un message qu'on n'a pas compris ;
 *  4. le type n'est pas une chaîne — tout le traitement suivant en dépend.
 *
 * L'ordre compte : un objet venu d'un autre logiciel ne doit pas recevoir un diagnostic de version,
 * qui lui apprendrait quelque chose de nous sans rien nous apprendre de lui.
 *
 * @param {unknown} valeur
 * @returns {{ ok: true, type: string, message: Record<string, unknown> }
 *          | { ok: false, code: string }}
 */
export function decoderMessage(valeur) {
  if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) {
    return { ok: false, code: CODES_REFUS_COQUILLE.messageMalforme };
  }
  const message = /** @type {Record<string, unknown>} */ (valeur);
  if (message.contrat !== CONTRAT_COQUILLE.id) {
    return { ok: false, code: CODES_REFUS_COQUILLE.contratRefuse };
  }
  if (message.version !== CONTRAT_COQUILLE.version) {
    return { ok: false, code: CODES_REFUS_COQUILLE.contratRefuse };
  }
  if (typeof message.type !== "string" || message.type.length === 0) {
    return { ok: false, code: CODES_REFUS_COQUILLE.messageMalforme };
  }
  // Un type au-delà de la borne n'est pas un type : c'est une charge utile déguisée en type, et la
  // refuser ICI est ce qui empêche qu'elle soit recopiée plus loin (revue de #166, constat 3).
  if (message.type.length > TAILLE_MAXIMALE_DU_TYPE) {
    return { ok: false, code: CODES_REFUS_COQUILLE.messageMalforme };
  }
  return { ok: true, type: message.type, message };
}

/**
 * Constructeurs de valeurs que le port restreint ne doit JAMAIS transporter (ADR 0002, tableau des
 * capacités : « ne peut transporter une clé, un handle, un descripteur de fichier ou une capacité
 * transférable »).
 *
 * La liste est nommée plutôt que devinée, et elle est cherchée par le NOM du constructeur : ces
 * types n'existent pas tous dans tous les contextes — un Worker n'a pas `OffscreenCanvas` partout,
 * une page n'a pas `FileSystemSyncAccessHandle` —, et un `instanceof` sur un global absent lèverait
 * une exception au lieu de rendre un refus.
 */
const CONSTRUCTEURS_INTERDITS = Object.freeze([
  "MessagePort",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "CryptoKey",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "ImageBitmap",
  "OffscreenCanvas",
  "RTCDataChannel",
  "FileSystemHandle",
  "FileSystemFileHandle",
  "FileSystemDirectoryHandle",
  "FileSystemSyncAccessHandle",
  "Blob",
  "File",
  "Function",
]);

const INTERDITS = new Set(CONSTRUCTEURS_INTERDITS);

/** Profondeur au-delà de laquelle un corps de message est refusé plutôt que parcouru. */
const PROFONDEUR_MAXIMALE = 8;

/**
 * Refuse une valeur qui transporterait autre chose que des données. Le contrôle est RÉCURSIF et
 * s'arrête au premier interdit rencontré.
 *
 * Le geste admis rend un objet de nombres, de chaînes et de booléens ; tout le reste serait un
 * défaut de programmation de la coquille et non une entrée hostile — d'où l'exception plutôt qu'un
 * refus poli. Elle porte le code `VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE`, et l'épreuve la cherche.
 *
 * @param {unknown} valeur
 * @param {number} [profondeur]
 */
export function sansCapacite(valeur, profondeur = 0) {
  if (profondeur > PROFONDEUR_MAXIMALE) throw refusDeCapacite("profondeur");
  if (valeur === null || valeur === undefined) return valeur;
  const nature = typeof valeur;
  if (nature === "string" || nature === "number" || nature === "boolean") return valeur;
  if (nature !== "object") throw refusDeCapacite(nature);
  const nom = valeur.constructor?.name;
  if (nom && INTERDITS.has(nom)) throw refusDeCapacite(nom);
  if (ArrayBuffer.isView(valeur)) throw refusDeCapacite("vue sur un tampon");
  for (const entree of Array.isArray(valeur) ? valeur : Object.values(valeur)) {
    sansCapacite(entree, profondeur + 1);
  }
  return valeur;
}

/** @param {string} quoi */
function refusDeCapacite(quoi) {
  const erreur = new Error(
    `Un message de la coquille transportait « ${quoi} » : seules des données franchissent le port.`,
  );
  erreur.code = CODES_REFUS_COQUILLE.capaciteDansUnMessage;
  return erreur;
}
