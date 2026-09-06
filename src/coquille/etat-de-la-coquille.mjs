// L'ÉTAT que la coquille consent à publier, et sa forme exacte (#161, ADR 0028).
//
// C'est la charge utile du seul geste admis sur le port restreint. Elle est décrite ici plutôt que
// construite à la volée dans la page pour une raison de frontière : ce qui franchit le port est
// exactement ce que ce module rend, et une épreuve unitaire peut donc dire ce qui le franchit sans
// démarrer de navigateur.
//
// **Ce que la réponse ne porte pas**, et c'est la moitié qui compte : ni nom de volume, ni taille,
// ni espace restant, ni identifiant d'emplacement, ni version d'enveloppe, ni chemin, ni handle.
// La taille et l'espace ont été examinés et écartés (`admission-applicative.mjs`,
// `GESTES_ECARTES`) ; le reste n'a jamais été demandé par personne.

/**
 * Les quatre états, et rien entre eux. `indisponible` n'est pas `verrouille` : l'un dit « il faut
 * un geste », l'autre dit « ce moteur ne sait pas », et les confondre ferait promettre à
 * l'utilisateur un déverrouillage qui n'ouvrirait rien.
 */
export const ETATS_DU_VOLUME = Object.freeze({
  /** La coquille a démarré ; le Worker de confiance n'a pas encore répondu. */
  demarrage: "demarrage",
  /** Le Worker vit, aucun volume n'est ouvert : il manque le geste de déverrouillage. */
  verrouille: "verrouille",
  /** Un volume est ouvert dans le Worker de confiance. Sa clé n'en sort pas. */
  ouvert: "ouvert",
  /** Le moteur ne fournit pas ce qu'il faut pour ouvrir un volume (OPFS, accès synchrone). */
  indisponible: "indisponible",
});

const ETATS_CONNUS = Object.freeze(new Set(Object.values(ETATS_DU_VOLUME)));

/**
 * Construit la charge utile de la réponse d'état. Elle est GELÉE et ne porte que deux champs.
 *
 * `barrieres` est un COMPTE, pas un horodatage : c'est le nombre de barrières de durabilité
 * acquittées depuis le démarrage du Worker. Un compte est monotone, ne dépend d'aucune horloge, et
 * suffit à ce que l'application dise « enregistré » — elle compare celui qu'elle a vu au dernier
 * annoncé. Un horodatage aurait ajouté une horloge de l'origine de confiance à ce qui franchit la
 * frontière, pour rien.
 *
 * @param {{ etat: string, barrieres: number }} observation
 * @returns {{ etat: string, barrieres: number }}
 */
export function chargeUtileDEtat({ etat, barrieres }) {
  if (!ETATS_CONNUS.has(etat)) {
    throw new Error(
      `État de volume inconnu : ${etat}. La coquille ne publie que ses quatre états.`,
    );
  }
  if (!Number.isInteger(barrieres) || barrieres < 0) {
    throw new Error("Le compte de barrières est un entier positif ou nul.");
  }
  return Object.freeze({ etat, barrieres });
}
