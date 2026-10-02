// L'APPARIEMENT des réponses du port restreint aux sondes qui les attendent (#179).
//
// La fixture servait la PREMIÈRE attente non servie, quelle que soit la réponse. Sous charge, une
// réponse arrivée après le délai d'une sonde était servie à la sonde SUIVANTE : `contrat-etranger`
// recevait l'`etat-reponse` de `hostile-7`, et la frontière paraissait franchie alors que la
// fixture mesurait sa propre file d'attente.
//
// Une réponse est donc servie à l'attente qui porte SA corrélation, et à aucune autre. Le contrat le
// permet : la coquille rend la corrélation admissible de la requête dans sa réponse comme dans son
// refus. Elle ne la rend pas quand le message ne se décode pas (contrat ou version étrangers, valeur
// qui n'est pas un objet) ni quand il transfère une capacité : ces refus-là sont appariés par ordre,
// mais SEULEMENT parmi les attentes qui n'espèrent aucune corrélation.
//
// Module SANS DOM ni import : `tests/unit/coquille-fixture-appariement.test.mjs` le charge sous Node.

/**
 * @typedef {{ correlation: string | null, rendre: (valeur: unknown) => void, servi: boolean }} Attente
 */

/**
 * @param {{ typeDeRefus: string }} options type du refus typé, seul message sans corrélation qui
 *   réponde à une sonde (les annonces de barrière, poussées par la coquille, n'en sont pas)
 */
export function appariementDuPort({ typeDeRefus }) {
  /** @type {Attente[]} */
  const attentes = [];

  function retirer(attente) {
    attente.servi = true;
    attentes.splice(attentes.indexOf(attente), 1);
  }

  return {
    /**
     * Inscrit une attente.
     *
     * @param {string | null} correlation celle que la réponse portera, `null` si elle n'en portera pas
     * @param {(valeur: unknown) => void} rendre
     * @returns {Attente}
     */
    attendre(correlation, rendre) {
      const attente = { correlation, rendre, servi: false };
      attentes.push(attente);
      return attente;
    },

    /**
     * Sert une réponse reçue à l'attente VIVANTE qui porte sa corrélation. Sans attente de cette
     * corrélation, elle est ignorée : jamais servie à une autre sonde.
     *
     * @param {unknown} reponse
     * @returns {boolean} la réponse a-t-elle été servie ?
     */
    servir(reponse) {
      const correlation = typeof reponse?.correlation === "string" ? reponse.correlation : null;
      if (correlation === null && reponse?.type !== typeDeRefus) return false;
      const attente = attentes.find((candidate) => candidate.correlation === correlation);
      if (!attente) return false;
      retirer(attente);
      attente.rendre(reponse);
      return true;
    },

    /**
     * Rend un constat à une attente restée sans réponse, si elle l'est encore.
     *
     * @param {Attente} attente
     * @param {unknown} constat
     * @returns {boolean} le constat a-t-il été rendu ?
     */
    expirer(attente, constat) {
      if (attente.servi) return false;
      retirer(attente);
      attente.rendre(constat);
      return true;
    },

    /** Nombre d'attentes vivantes. */
    get vivantes() {
      return attentes.length;
    },
  };
}
