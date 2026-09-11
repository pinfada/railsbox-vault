// La LISTE D'ADMISSION du port restreint, et la liste de refus qui ne se négocie pas (#161, ADR 0028).
//
// L'ADR 0002 réserve cette liste à #24 et dit comment l'écrire : « dérivée des besoins réels de
// l'application, pas devinée ». Ce module porte donc la DÉRIVATION avec elle — chaque geste admis
// nomme le fichier et la ligne qui le demandent, et un geste sans usage n'entre pas. La liste de
// refus, elle, vient de l'issue #24 et n'est pas dérivable : elle est ce que la frontière existe
// pour interdire.
//
// ## Ce que le relevé a trouvé, geste par geste
//
// `apps/reference` est une application `ActionController::API` de deux routes JSON, sans session,
// sans cookie, sans gabarit et SANS UNE LIGNE DE JAVASCRIPT (`apps/reference/config/routes.rb`,
// `apps/reference/app/controllers/vault_controller.rb`). Elle ne demande donc rien à la coquille
// par elle-même : ce que le relevé mesure, ce sont les gestes dont les SCÉNARIOS ont besoin pour
// qu'un document encadré serve à quelque chose. Ils sont deux, et un troisième candidat a été
// examiné puis écarté.
//
// ## Une identité d'application n'existe pas ici
//
// L'ADR 0018 § 4 : « l'origine devient l'identité ». Aucun champ de ce contrat ne nomme une
// application, et `evaluerAnnonce` ne compare rien d'autre que l'origine, la fenêtre émettrice et
// le type. Inventer un identifiant reviendrait à créer un critère dont #46 a mesuré qu'il ne sépare
// rien tant que l'origine ne sépare pas — et qui serait redondant dès qu'elle sépare.

import {
  TYPES_APPLICATIFS,
  correlationAdmise,
  decoderMessage,
  estTypePrivilegie,
  typeRendu,
} from "./contrat-de-messages.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";

/**
 * Les gestes ADMIS sur le port restreint. `usage` cite le fichier et la ligne qui le DEMANDENT ;
 * une entrée sans usage réel n'a pas sa place ici, et `tests/unit/coquille-admission.test.mjs`
 * exige que chaque citation désigne un fichier qui existe.
 *
 * @type {readonly { type: string, geste: string, usage: readonly string[], motif: string }[]}
 */
export const GESTES_ADMIS = Object.freeze([
  Object.freeze({
    type: TYPES_APPLICATIFS.etat,
    geste: "demander l'état du volume et le rang de la dernière barrière acquittée",
    usage: Object.freeze([
      "public/vm/reference-worker-phases-volume.mjs:275 › « present: etat.present, » — la seule " +
        "observation qu'un scénario fait d'un volume avant de s'en servir ; tout le reste du " +
        "compte rendu concerne les VOISINS du volume, qui ne regardent pas l'application",
      'tests/e2e/instantane-reprise.spec.mjs:201 › « phase: "inspect-volume" » — un scénario ' +
        "interroge l'état entre deux gestes plutôt que de le supposer",
      "src/spike/origin-topology.mjs:118 › « export function isAllowedAppRequest » — la seule " +
        "requête que le spike admettait déjà, et la mesure de l'ADR 0002 n'en a jamais fait " +
        "apparaître d'autre",
    ]),
    motif:
      "un document applicatif ne peut rien rendre d'utile avant que le volume soit ouvert : sans " +
      "cette réponse, il ne lui reste qu'à essayer et à échouer devant l'utilisateur.",
  }),
  Object.freeze({
    type: TYPES_APPLICATIFS.barriere,
    geste: "recevoir l'annonce d'une barrière de durabilité acquittée",
    usage: Object.freeze([
      'public/vm/reference-banc.mjs:73 › « if (type === "mutation") » — l\'annonce existe déjà, ' +
        "et elle ne porte AUCUN identifiant de requête : c'est une poussée, pas une réponse",
      "tests/e2e/coupure-generation-boot-froid.spec.mjs:159 › « une barrière a été acquittée » — " +
        "un scénario ne juge « écrit » qu'après cela, jamais après l'écriture seule",
    ]),
    motif:
      "l'application est le seul endroit qui puisse dire « enregistré » à l'utilisateur, et le " +
      "seul qui ne sache pas quand ce sera vrai. La coquille le POUSSE : l'application n'a rien " +
      "à demander, donc rien à interroger en boucle.",
  }),
]);

/**
 * Les candidats EXAMINÉS et écartés, avec le motif. Ils comptent autant que la liste d'admission :
 * une liste courte sans trace de ce qu'on a refusé d'y mettre se relit comme un oubli.
 *
 * @type {readonly { candidat: string, motif: string }[]}
 */
export const GESTES_ECARTES = Object.freeze([
  Object.freeze({
    candidat: "connaître la taille du volume ou l'espace restant",
    motif:
      "aucun usage ne le demande. Ni `apps/reference` ni un scénario de `tests/e2e/` ne consulte " +
      "l'espace ; la couche budget (#9) est un geste de la COQUILLE, mesuré page-side par " +
      "`tests/browser/storage-budget.spec.mjs`, et l'ADR 0006 fait de la conduite au refus une " +
      "affaire de la coquille. L'application apprend le manque par l'échec de sa propre écriture, " +
      "pas en interrogeant un chiffre — et un chiffre d'espace est un canal auxiliaire gratuit.",
  }),
  Object.freeze({
    candidat: "s'annoncer sous un identifiant d'application",
    motif:
      "l'ADR 0018 § 4 décide que l'origine EST l'identité, et interdit d'inventer ce champ. #46 a " +
      "mesuré que deux applications d'une même origine ne se distinguent par rien que le " +
      "navigateur fasse respecter.",
  }),
  Object.freeze({
    candidat: "demander la version d'enveloppe, ou la fournir",
    motif:
      "l'ADR 0027 décision 3 tranche que la version d'enveloppe est une SAISIE de l'utilisateur " +
      "dans la coquille, « jamais une valeur lue d'un stockage de l'appareil » ; une version " +
      "fournie par l'origine applicative rouvrirait le déni de service écarté par écrit.",
  }),
]);

/**
 * La LISTE DE REFUS de l'issue #24, décision 2 : dix gestes, chacun avec son code.
 *
 * Elle n'est pas dérivée et ne se négocie pas. Elle est nommée dans le CODE plutôt que laissée au
 * refus générique parce que l'épreuve de l'application malveillante doit pouvoir distinguer « la
 * coquille refuse ce geste-là » de « la coquille n'a pas compris le message » — sans quoi un relevé
 * tout vert s'obtiendrait par incompréhension.
 *
 * @type {readonly { type: string, geste: string, code: string }[]}
 */
export const GESTES_REFUSES = Object.freeze([
  Object.freeze({
    type: "vault.coquille.obtenir-kek",
    geste: "obtenir une clé de déverrouillage (KEK)",
    code: CODES_REFUS_COQUILLE.kek,
  }),
  Object.freeze({
    type: "vault.coquille.obtenir-dek",
    geste: "obtenir la clé de volume (DEK)",
    code: CODES_REFUS_COQUILLE.dek,
  }),
  Object.freeze({
    type: "vault.coquille.exporter",
    geste: "exporter le volume",
    code: CODES_REFUS_COQUILLE.exportation,
  }),
  Object.freeze({
    type: "vault.coquille.revoquer",
    geste:
      "révoquer un emplacement (`revoquerEmplacement`, `revoquerToutSauf`, `remplacerEmplacement`)",
    code: CODES_REFUS_COQUILLE.revocation,
  }),
  Object.freeze({
    type: "vault.coquille.ajouter-emplacement",
    geste: "ajouter un emplacement de déverrouillage",
    code: CODES_REFUS_COQUILLE.emplacement,
  }),
  Object.freeze({
    type: "vault.coquille.creer-recuperation",
    geste: "créer un moyen de récupération",
    code: CODES_REFUS_COQUILLE.recuperation,
  }),
  Object.freeze({
    type: "vault.coquille.changer-volume",
    geste: "changer d'emplacement de volume",
    code: CODES_REFUS_COQUILLE.volume,
  }),
  Object.freeze({
    type: "vault.coquille.lire-enveloppe",
    geste: "lire `<volume>.cles` ou son inventaire",
    code: CODES_REFUS_COQUILLE.enveloppe,
  }),
  Object.freeze({
    type: "vault.coquille.obtenir-port-privilegie",
    geste: "obtenir le port privilégié coquille ↔ Worker",
    code: CODES_REFUS_COQUILLE.portPrivilegie,
  }),
  Object.freeze({
    type: "vault.coquille.obtenir-handle",
    geste: "obtenir un handle de fichier",
    code: CODES_REFUS_COQUILLE.handle,
  }),
]);

const ADMIS = Object.freeze(new Set(GESTES_ADMIS.map(({ type }) => type)));
const REFUSES = Object.freeze(new Map(GESTES_REFUSES.map(({ type, code }) => [type, code])));

/**
 * Types que la coquille ADMET en REQUÊTE sur le port restreint.
 *
 * L'annonce de barrière est un geste admis du contrat, mais dans l'autre sens : la coquille la
 * POUSSE. Une application qui la posterait vers la coquille demande quelque chose que personne ne
 * sert, et tombe donc sur le refus générique.
 */
const REQUETES_ADMISES = Object.freeze(new Set([TYPES_APPLICATIFS.etat]));

/** @param {string} type */
export function estGesteAdmis(type) {
  return ADMIS.has(type);
}

/**
 * Les SEULS champs qu'une requête admise a le droit de porter.
 *
 * Le décodage était strict sur l'enveloppe et muet sur le reste : la revue de #166 a fait servir
 * une réponse à un message portant un champ de deux cent mille caractères et un objet imbriqué.
 * Rien n'en était lu — mais rien n'en était refusé non plus, et un champ qu'on accepte sans le lire
 * est un champ que la version suivante lira par accident.
 */
const CHAMPS_DUNE_REQUETE = Object.freeze(["contrat", "version", "type", "correlation"]);

/**
 * Décide du sort d'un message reçu sur le port restreint. Trois issues, jamais un silence :
 *
 *  - le message ne se décode pas → le refus du décodeur (`MESSAGE_MALFORME`, `CONTRAT_REFUSE`) ;
 *  - le type est nommé par la liste de refus → SON code, calculé sans consulter le moindre état ;
 *  - le type est admis en requête → servi, si et seulement si sa forme est exacte ; tout le reste
 *    → `TYPE_INCONNU`.
 *
 * Un type du canal PRIVILÉGIÉ reçu ici est traité comme la tentative d'obtenir ce canal : c'est
 * exactement ce qu'il est, et le refus le dit.
 *
 * `recu` est TRONQUÉ : il ne sert qu'à revenir à celui qui l'a envoyé. Depuis la revue de #166, il
 * n'entre nulle part dans le relevé de la coquille, qui ne porte plus que des compteurs.
 *
 * @param {unknown} valeur message brut reçu sur le port
 * @returns {{ admise: true, type: string, correlation: string }
 *          | { admise: false, code: string, recu: string, correlation: string | null }}
 */
export function evaluerRequete(valeur) {
  const decode = decoderMessage(valeur);
  if (!decode.ok) {
    return { admise: false, code: decode.code, recu: nommer(valeur), correlation: null };
  }
  const { type, message } = decode;
  const correlation = correlationAdmise(message.correlation);
  if (REFUSES.has(type)) {
    return { admise: false, code: REFUSES.get(type), recu: typeRendu(type), correlation };
  }
  if (estTypePrivilegie(type)) {
    return {
      admise: false,
      code: CODES_REFUS_COQUILLE.portPrivilegie,
      recu: typeRendu(type),
      correlation,
    };
  }
  if (!REQUETES_ADMISES.has(type)) {
    return {
      admise: false,
      code: CODES_REFUS_COQUILLE.typeInconnu,
      recu: typeRendu(type),
      correlation,
    };
  }
  if (!formeExacte(message)) {
    return {
      admise: false,
      code: CODES_REFUS_COQUILLE.messageMalforme,
      recu: typeRendu(type),
      correlation,
    };
  }
  if (correlation === null) {
    return {
      admise: false,
      code: CODES_REFUS_COQUILLE.correlationAbsente,
      recu: typeRendu(type),
      correlation: null,
    };
  }
  return { admise: true, type, correlation };
}

/**
 * Une requête admise ne porte AUCUN champ hors du contrat.
 *
 * L'absence d'un champ attendu n'est pas jugée ici : la corrélation manquante a son propre refus,
 * qui dit à l'appelant ce qu'il doit ajouter. Confondre les deux lui rendrait « message illisible »
 * pour un message parfaitement lisible auquel il manque une chose nommée.
 */
function formeExacte(message) {
  return Object.keys(message).every((champ) => CHAMPS_DUNE_REQUETE.includes(champ));
}

/**
 * La VÉRIFICATION TRIPLE de l'annonce reçue sur `window`, reprise du spike #35 et éprouvée par
 * mutation — précédée de l'ORDRE, et suivie de l'unicité. Cinq conditions, chacune nécessaire :
 *
 *  - l'ORDRE : le canal privilégié coquille ↔ Worker existe. Il vient EN PREMIER parce qu'il ne
 *    dépend pas du candidat : une coquille qui octroierait un port avant d'avoir son canal
 *    promettrait un service qu'elle ne peut pas rendre, et l'issue #24 pose cet ordre comme non
 *    négociable (« le canal privilégié est établi avant qu'aucun document applicatif n'existe ») ;
 *  - le TYPE, qui ne prouve rien seul puisque n'importe quel document le connaît ;
 *  - l'ORIGINE, qui sépare la topologie retenue de la topologie en même origine ;
 *  - la FENÊTRE ÉMETTRICE, seule à distinguer le cadre applicatif d'une iframe imbriquée que ce
 *    cadre aurait créée — laquelle porte exactement la même origine ;
 *  - l'UNICITÉ, qui ferme la porte d'un second port réclamé après coup.
 *
 * L'ordre des trois du milieu est indifférent à la sécurité et fixé pour la lisibilité du relevé.
 * L'unicité vient EN DERNIER : un second appel bien formé doit être refusé pour ce motif-là, et
 * l'ordre inverse ferait rendre « origine inattendue » à un second cadre légitime.
 *
 * @param {{ canalPrivilegiePret: boolean, type: unknown, origine: string,
 *           fenetreEstLeCadre: boolean, origineAttendue: string, dejaOctroye: boolean }} candidat
 * @returns {{ accepte: boolean, code: string | null }}
 */
export function evaluerAnnonce(candidat) {
  const { canalPrivilegiePret, type, origine, fenetreEstLeCadre, origineAttendue, dejaOctroye } =
    candidat;
  if (!canalPrivilegiePret) {
    return { accepte: false, code: CODES_REFUS_COQUILLE.canalAbsent };
  }
  if (type !== TYPES_APPLICATIFS.annonce) {
    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceType };
  }
  if (origine !== origineAttendue) {
    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceOrigine };
  }
  if (!fenetreEstLeCadre) {
    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceFenetre };
  }
  if (dejaOctroye) {
    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceUnique };
  }
  return { accepte: true, code: null };
}

/** Nomme ce qu'on a reçu quand ce n'était pas décodable, sans le recopier dans le refus. */
function nommer(valeur) {
  if (valeur === null) return "null";
  if (Array.isArray(valeur)) return "Array";
  const nature = typeof valeur;
  if (nature !== "object") return nature;
  const type = /** @type {Record<string, unknown>} */ (valeur).type;
  return typeof type === "string" ? typeRendu(type) : "objet";
}
