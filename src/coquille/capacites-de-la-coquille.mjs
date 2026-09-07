// L'ÉTAPE 1 du cycle de vie : identités et compatibilité, mesurées DANS la coquille (#163, ADR 0030).
//
// La sonde `public/compat.html` (#2) mesure ce qu'un moteur sait faire, et elle est EXEMPTÉE de la
// CSP de la coquille — délibérément : « une CSP qui refuserait WebAssembly ferait rendre « capacité
// absente » à un navigateur qui la possède », dit `tools/serve-headers.mjs`. Cette exemption est
// juste pour une sonde, et fausse pour un produit : ce que la coquille doit savoir, c'est ce qu'elle
// peut faire ELLE, dans son propre document, sous la politique qu'on lui sert réellement.
//
// D'où ce module. Il ne remplace pas la sonde — celle-ci publie une matrice, celui-ci décide d'un
// démarrage — et il ne mesure que ce dont un geste du produit dépend, capacité par capacité, avec
// le geste nommé à côté. Une capacité mesurée dont rien ne dépend serait du décor.
//
// ## Exigée ou facultative, et pourquoi la distinction n'est pas une commodité
//
// Une capacité EXIGÉE absente rend la coquille inutilisable : il n'y a pas de chemin dégradé, et
// prétendre le contraire mènerait l'utilisateur jusqu'à un refus tardif, après une phrase saisie.
// Une capacité FACULTATIVE absente retire un MOYEN et en laisse d'autres : sans
// `navigator.credentials`, la passkey disparaît, la phrase et le code de récupération restent.
// C'est exactement la règle que l'ADR 0021 pose déjà — « le repli vers `phrase` n'est jamais
// automatique » —, appliquée au démarrage plutôt qu'au geste.
//
// ## Ce que ce module ne mesure PAS
//
// L'accès SYNCHRONE à l'OPFS — `createSyncAccessHandle` — n'existe que dans un Worker dédié : il est
// constaté par `public/runtime-worker.mjs` (`PEUT_OUVRIR`) et rendu comme l'ÉTAT `indisponible`,
// jamais comme un refus de geste. Le mesurer ici, depuis un document, rendrait « absent » sur les
// trois moteurs. Ce que ce module relève d'OPFS est la seule chose qu'un document puisse en voir —
// `navigator.storage.getDirectory` —, et il la relève comme FACULTATIVE pour la même raison.

/**
 * Les capacités dont la coquille dépend, chacune avec le geste qui la réclame.
 *
 * `presente` reçoit la PORTÉE — `globalThis` en production, un objet dans les épreuves — et ne doit
 * jamais lever : une portée amputée est ce qu'on mesure, pas une erreur de programmation.
 */
export const CAPACITES_DE_LA_COQUILLE = Object.freeze([
  Object.freeze({
    nom: "webcrypto",
    exigee: true,
    pourquoi:
      "dériver une KEK, ouvrir l'enveloppe et sceller chaque secteur : sans WebCrypto, aucun coffre ne s'ouvre",
    presente: (portee) =>
      typeof portee?.crypto?.subtle === "object" &&
      portee.crypto.subtle !== null &&
      typeof portee.crypto.getRandomValues === "function",
  }),
  Object.freeze({
    nom: "webassembly",
    exigee: true,
    pourquoi:
      "Argon2id et le runtime v86 sont des modules WebAssembly ; la CSP de la coquille ne les autorise que par « 'wasm-unsafe-eval' » (ADR 0013)",
    presente: (portee) =>
      typeof portee?.WebAssembly?.instantiate === "function" &&
      typeof portee.WebAssembly.Module === "function",
  }),
  Object.freeze({
    nom: "worker-module",
    exigee: true,
    pourquoi:
      "le Worker de confiance détient le handle exclusif et la clé de volume (ADR 0002) ; sans lui, rien ne peut vivre hors de la page",
    presente: (portee) => typeof portee?.Worker === "function",
  }),
  Object.freeze({
    nom: "canal-de-messages",
    exigee: true,
    pourquoi:
      "le canal privilégié et le port restreint sont deux `MessageChannel` : c'est la frontière elle-même",
    presente: (portee) => typeof portee?.MessageChannel === "function",
  }),
  Object.freeze({
    nom: "clone-structure",
    exigee: true,
    pourquoi:
      "tout ce qui franchit un port est cloné par l'algorithme structuré ; son absence rendrait chaque message silencieux",
    presente: (portee) => typeof portee?.structuredClone === "function",
  }),
  Object.freeze({
    nom: "opfs",
    // FACULTATIVE, et c'est une décision plutôt qu'une indulgence : l'absence d'OPFS est déjà rendue
    // comme un ÉTAT — `indisponible` — par le Worker de confiance (`PEUT_OUVRIR`), et l'ADR 0029 dit
    // pourquoi : « ce n'est pas le geste qui a échoué ». L'exiger ici ferait refuser le DÉMARRAGE de
    // la coquille sur un moteur qui la porte par ailleurs — mesuré sur WebKit, où `getDirectory`
    // manque au document —, et ferait disparaître avec elle la frontière d'origine, les dix refus et
    // l'interface que #161 et #162 y mesurent. Deux décisions pour une même absence, dont l'une
    // annulerait ce que l'autre publie.
    exigee: false,
    pourquoi:
      "le volume, son enveloppe et ses voisins vivent dans le système de fichiers d'origine privée ; son absence est l'état « indisponible », jamais un refus de démarrage",
    presente: (portee) => typeof portee?.navigator?.storage?.getDirectory === "function",
  }),
  Object.freeze({
    nom: "webauthn",
    exigee: false,
    pourquoi:
      "la passkey se dérive dans le document par `navigator.credentials` (ADR 0021, décision 5) ; son absence retire ce moyen et laisse les deux autres",
    presente: (portee) =>
      typeof portee?.navigator?.credentials === "object" && portee.navigator.credentials !== null,
  }),
]);

/**
 * MESURE la portée et rend ce qui manque. Ne lève jamais : une capacité dont la sonde échoue est
 * une capacité ABSENTE, pas une exception à remonter — c'est la même règle que « aucune capacité
 * manquante n'est remplacée par un repli », vue de l'autre côté.
 *
 * @param {object} portee `globalThis` en production
 * @returns {{ manquantes: string[], presentes: string[], suffisante: boolean }}
 */
export function mesurerLesCapacites(portee) {
  const manquantes = [];
  const presentes = [];
  for (const capacite of CAPACITES_DE_LA_COQUILLE) {
    let vue;
    try {
      vue = capacite.presente(portee) === true;
    } catch {
      vue = false;
    }
    (vue ? presentes : manquantes).push(capacite.nom);
  }
  const exigees = new Set(
    CAPACITES_DE_LA_COQUILLE.filter((capacite) => capacite.exigee).map(({ nom }) => nom),
  );
  return {
    manquantes,
    presentes,
    suffisante: manquantes.every((nom) => !exigees.has(nom)),
  };
}
