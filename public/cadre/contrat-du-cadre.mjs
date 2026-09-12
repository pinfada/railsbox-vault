// Le petit contrat INTERNE de la coquille de cadre (#192, ADR 0038).
//
// Il relie deux pièces qui vivent toutes les deux sur l'ORIGINE APPLICATIVE : le Service Worker qui
// intercepte ce que le document servi demande, et le COURTIER — le module du document encadré, qui
// détient le port restreint octroyé par la coquille.
//
// **Ce n'est PAS une frontière**, et il faut l'écrire pour que personne ne le prenne pour telle. Les
// deux extrémités sont dans le même territoire, celui du guest (ADR 0018 § 4 : l'origine est
// l'identité) ; elles peuvent se lire l'une l'autre par mille voies, et rien ici ne les en empêche.
// La frontière est ailleurs — c'est le port restreint, et son contrat est
// `src/coquille/contrat-de-messages.mjs`. Ce fichier-ci n'est qu'un vocabulaire commun, choisi pour
// que les deux moitiés d'un même mécanisme ne se parlent pas par accident avec les mots d'un autre.
//
// Un message de ce contrat ne franchit donc AUCUNE frontière, et ne porte jamais rien de sensible :
// une méthode, un chemin, trois en-têtes, un corps en base64. Exactement ce que le port restreint
// accepte, ni plus ni moins — la coquille ne lui ferait pas crédit d'un champ de plus.

/** Identifiant du contrat interne. Distinct de celui de la coquille, et il doit le rester. */
export const CONTRAT_DU_CADRE = Object.freeze({
  id: "railsbox-vault-cadre",
  version: 1,
});

export const TYPES_DU_CADRE = Object.freeze({
  /** Le Service Worker demande au courtier de relayer une requête. */
  demande: "cadre.relayer",
  /** Le courtier rend ce que la coquille lui a rendu. */
  reponse: "cadre.reponse",
  /** Le courtier n'a rien à rendre, et dit pourquoi. Jamais un silence. */
  refus: "cadre.refus",
  /**
   * L'application n'est pas encore démarrée : le courtier ne relaie RIEN et le dit, avec depuis
   * combien de temps il attend. Le Service Worker en fait une page d'attente honnête (#203, I1).
   */
  attente: "cadre.attente",
  /** Le Service Worker demande à un candidat s'il détient un port restreint. */
  presence: "cadre.presence",
  /** La réponse : `porte` vaut `true` pour un courtier, `false` pour tout autre document. */
  presenceReponse: "cadre.presence-reponse",
  /**
   * Le courtier demande au Service Worker DÉJÀ actif de le prendre sous contrôle. Sans elle, un
   * second courtier chargé après l'activation reste non contrôlé sous Firefox, et son cadre ne
   * s'ouvre jamais (mesuré le 13 septembre 2026, `tests/browser/coquille-deux-coffres.spec.mjs`).
   */
  reclamer: "cadre.reclamer",
});

/**
 * Borne d'attente du Service Worker sur une réponse du courtier, en millisecondes.
 *
 * C'est la borne la plus EXTÉRIEURE des trois qui gouvernent une requête relayée, et elle est donc
 * la plus LONGUE : 180 s, contre 150 s pour la coquille (`DELAI_RELAIS_COQUILLE_MS`) et 120 s pour
 * le pont série. Elle valait 75 s, c'est-à-dire qu'elle gagnait sur les deux autres et rendait
 * « courtier muet » pour une lenteur du guest (revue d'intégration de la PR #203, constat 6). Ce
 * qu'elle borne désormais est le seul silence qui lui appartient : un courtier détruit au milieu
 * d'un aller-retour, un onglet gelé.
 */
export const DELAI_DU_COURTIER_MS = 180_000;

/**
 * Borne de la question de PRÉSENCE — « détiens-tu un port restreint ? » —, en millisecondes.
 *
 * Un courtier y répond sans rien demander à personne : c'est une lecture d'une variable. Trois
 * secondes couvrent un document qui se charge sur une machine chargée ; au-delà, le candidat est
 * INCERTAIN, et le routage refuse plutôt que de servir au hasard.
 */
export const DELAI_DE_PRESENCE_MS = 3_000;

/**
 * Les en-têtes que le Service Worker relève de la requête interceptée.
 *
 * La même liste que `ENTETES_DE_REQUETE_RELAYEES` de `src/coquille/relais-http.mjs`, et ce n'est pas
 * une recopie qui pourrait diverger : `tests/unit/coquille-relais-http.test.mjs` exige qu'elles
 * soient identiques. Elle est écrite ici parce que le Service Worker ne doit rien importer de la
 * coquille pour fonctionner — il s'exécute sur l'autre origine, sous l'autre budget de chargement.
 */
export const ENTETES_RELEVEES = Object.freeze(["accept", "accept-language", "content-type"]);

/**
 * Le document encadré est-il sur une origine DISTINCTE de celle qui l'encadre ?
 *
 * C'est la garde qui empêche la coquille de cadre — donc son Service Worker — de s'installer sur
 * l'origine de CONFIANCE. L'ADR 0030 décision 4 refuse un Service Worker dans la frontière, et ce
 * refus doit tenir même quand une épreuve encadre le document applicatif EN MÊME ORIGINE : c'est le
 * témoin positif de `tests/browser/coquille-frontiere.spec.mjs`, et rien ne doit s'y installer.
 *
 * La mesure est la SEULE dont dispose un document qui ne connaît pas l'origine de sa coquille
 * (ADR 0028) : lire `location.origin` du parent. Une lecture qui ABOUTIT dit « même origine » ; une
 * lecture qui JETTE dit « origines distinctes », et c'est le navigateur qui le dit, pas nous.
 *
 * Un document de PREMIER RANG — ouvert à la main, pas encadré — rend `false` : il n'y a pas de
 * frontière, donc rien à servir à travers elle.
 *
 * @param {Window} fenetre
 * @returns {boolean}
 */
export function origineDistincteDuParent(fenetre) {
  const parent = fenetre?.parent;
  if (!parent || parent === fenetre) return false;
  try {
    return parent.location.origin !== fenetre.location.origin;
  } catch {
    return true;
  }
}
