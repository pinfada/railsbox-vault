// Le ROUTAGE du Service Worker de la coquille de cadre (#192, ADR 0038 ; correctif S1/S2 de la revue
// de sécurité de la PR #203).
//
// ## Le défaut qu'il corrige
//
// Le Service Worker est UNIQUE pour l'origine applicative ; les courtiers, non — un par coquille
// ouverte. Il relayait pourtant par « le premier courtier trouvé » : deux coffres ouverts, et la page
// du coffre B était servie par le port restreint, le Worker de confiance, le guest et le bocal à
// cookies du coffre A. Et un onglet ouvert à la main sur le chemin du courtier, qui ne détient aucun
// port, pouvait être « trouvé » le premier et rendre le relais muet pour tout le coffre.
//
// ## La propriété tenue
//
// **Aucune requête n'est servie par le courtier d'un autre coffre.** Elle s'obtient ainsi, et chaque
// règle a son motif :
//
//  1. **un courtier est un client qui DIT détenir un port restreint** — il le dit quand le Service
//     Worker le lui demande, jamais par sa seule présence sur un chemin. Un onglet ouvert à la main
//     répond « sans port », et il n'est pas un courtier (S2) ;
//  2. **une SOUS-RESSOURCE suit la LIAISON de son client** (`event.clientId`) : le courtier qui a
//     servi la navigation qui a créé ce client, et nul autre. Un client sans liaison reçoit un refus
//     typé — jamais le courtier d'un autre ;
//  3. **une NAVIGATION ne peut pas être liée** : un Service Worker ne connaît pas le parent d'un
//     client. Elle n'est donc servie que s'il existe EXACTEMENT UN courtier, et refusée sinon. C'est
//     le prix déclaré : UN seul coffre servi à la fois — cohérent avec l'exclusivité de volume que le
//     produit constate déjà ;
//  4. **une navigation de PREMIER RANG n'est jamais relayée** : un onglet ouvert sur l'origine
//     applicative n'est dans aucun coffre, et rien ne l'y fait entrer (reproduction A du constat 1) ;
//  5. **aucun courtier du tout : le réseau**, comme avant — c'est ce qui rend le Service Worker inerte
//     partout où la coquille n'est pas.
//
// Ce module est PUR : il décide, le Service Worker exécute. Il est éprouvé par
// `tests/unit/coquille-routage-du-cadre.test.mjs` et muté par `tools/muter-gardes-coquille.mjs`.

/** Les trois issues d'une requête interceptée. */
export const ISSUES_DU_ROUTAGE = Object.freeze({
  /** Le Service Worker s'efface : la requête part au réseau. */
  reseau: "reseau",
  /** La requête est relayée par LE courtier nommé. */
  relayer: "relayer",
  /** Un refus typé est rendu au document, qui le lit. */
  refus: "refus",
});

/** Les refus du routage. Ils ne sont pas des codes de la coquille : ils ne franchissent aucun port. */
export const CODES_DU_ROUTAGE = Object.freeze({
  /** Plusieurs coffres ouverts : une navigation ne peut pas savoir lequel la porte. */
  courtiersMultiples: "CADRE_COURTIERS_MULTIPLES",
  /** Une sous-ressource dont le client n'est lié à aucun courtier joignable. */
  clientSansCourtier: "CADRE_CLIENT_SANS_COURTIER",
  /** Un candidat n'a pas dit s'il détenait un port : on ne sert pas au hasard. */
  courtierIncertain: "CADRE_COURTIER_INCERTAIN",
  /**
   * L'application servie a demandé un chemin que la coquille de cadre occupe (`/index.html`,
   * `/cadre/…`) : elle reçoit ce refus, lisible, et jamais un document de la coquille (revue
   * d'intégration de la PR #203, constat 5).
   */
  cheminReserve: "CADRE_CHEMIN_RESERVE",
});

/**
 * Le routage a-t-il besoin de savoir qui détient un port ? La question coûte un aller-retour par
 * candidat : elle n'est posée que lorsque la réponse change l'issue.
 *
 * @param {{ mode: string, destination: string, reserve: boolean, cheminDuCourtier: boolean }} requete
 */
export function presencesNecessaires({ mode, destination, reserve, cheminDuCourtier }) {
  if (mode !== "navigate") return !reserve;
  if (destination !== "iframe") return false;
  return !cheminDuCourtier;
}

/**
 * Ce qu'un candidat a répondu à la question « détiens-tu un port restreint ? ».
 *
 * `true` : un courtier. `false` : un document sans port (un onglet ouvert à la main). `null` : il n'a
 * pas répondu à temps — un document qui se charge, ou un onglet gelé.
 *
 * @typedef {{ id: string, porte: boolean | null }} Presence
 */

/**
 * DÉCIDE du sort d'une requête interceptée.
 *
 * @param {object} requete
 * @param {string} requete.mode `event.request.mode`
 * @param {string} requete.destination `event.request.destination`
 * @param {string} requete.clientId `event.clientId` (vide pour une navigation)
 * @param {ReadonlyMap<string, string>} requete.liaisons client → courtier, apprises aux navigations
 * @param {readonly Presence[]} requete.presences les candidats joignables, et ce qu'ils ont répondu
 * @param {boolean} [requete.reserve] le chemin appartient-il à la coquille de cadre ?
 * @param {boolean} [requete.cheminDuCourtier] est-ce le document courtier lui-même ?
 * @returns {{ issue: "reseau" } | { issue: "relayer", courtier: string } | { issue: "refus", code: string }}
 */
export function routerLaRequete({
  mode,
  destination,
  clientId,
  liaisons,
  presences,
  reserve = false,
  cheminDuCourtier = false,
}) {
  const courtiers = presences.filter((presence) => presence.porte === true).map(({ id }) => id);
  const incertains = presences.filter((presence) => presence.porte === null).length;

  if (reserve)
    return routerUnCheminReserve({
      mode,
      destination,
      clientId,
      liaisons,
      cheminDuCourtier,
      candidats: courtiers.length + incertains,
    });

  if (mode !== "navigate") {
    const lie = clientId ? liaisons.get(clientId) : undefined;
    if (lie !== undefined && courtiers.includes(lie)) {
      return { issue: ISSUES_DU_ROUTAGE.relayer, courtier: lie };
    }
    if (lie === undefined && courtiers.length === 0 && incertains === 0) {
      return { issue: ISSUES_DU_ROUTAGE.reseau };
    }
    return { issue: ISSUES_DU_ROUTAGE.refus, code: CODES_DU_ROUTAGE.clientSansCourtier };
  }

  if (destination !== "iframe") return { issue: ISSUES_DU_ROUTAGE.reseau };
  if (courtiers.length + incertains === 0) return { issue: ISSUES_DU_ROUTAGE.reseau };
  if (courtiers.length + incertains > 1) {
    return {
      issue: ISSUES_DU_ROUTAGE.refus,
      code:
        courtiers.length > 1
          ? CODES_DU_ROUTAGE.courtiersMultiples
          : CODES_DU_ROUTAGE.courtierIncertain,
    };
  }
  if (courtiers.length === 0) {
    return { issue: ISSUES_DU_ROUTAGE.refus, code: CODES_DU_ROUTAGE.courtierIncertain };
  }
  return { issue: ISSUES_DU_ROUTAGE.relayer, courtier: courtiers[0] };
}

/**
 * Un chemin RÉSERVÉ : le réseau pour la coquille de cadre elle-même, le refus lisible pour
 * l'application servie.
 *
 *  - le document COURTIER, et toute navigation qui n'est pas celle d'un cadre, vont au réseau :
 *    c'est ainsi qu'une coquille encadre son courtier, et qu'un onglet ouvert à la main voit ce que
 *    l'hébergeur sert ;
 *  - une navigation de CADRE vers un autre chemin réservé, pendant qu'un coffre est ouvert, est
 *    celle de l'application servie : elle reçoit `CADRE_CHEMIN_RESERVE` ;
 *  - une sous-ressource d'un client LIÉ à un courtier — l'application servie — le reçoit aussi ;
 *    celle d'un client non lié — le courtier qui charge ses modules, un banc — va au réseau.
 */
function routerUnCheminReserve({
  mode,
  destination,
  clientId,
  liaisons,
  cheminDuCourtier,
  candidats,
}) {
  const refus = { issue: ISSUES_DU_ROUTAGE.refus, code: CODES_DU_ROUTAGE.cheminReserve };
  if (mode !== "navigate") {
    return clientId && liaisons.has(clientId) ? refus : { issue: ISSUES_DU_ROUTAGE.reseau };
  }
  if (destination !== "iframe" || cheminDuCourtier || candidats === 0) {
    return { issue: ISSUES_DU_ROUTAGE.reseau };
  }
  return refus;
}
