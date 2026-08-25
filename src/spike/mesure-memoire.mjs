// Mesure fine de la mémoire d'un contexte, partagée par la page du banc #41 et par son Worker
// runtime : les deux doivent être relevés séparément, `performance` n'exposant pas nécessairement
// les mêmes méthodes dans un document et dans un Worker dédié.
//
// `performance.measureUserAgentSpecificMemory` est réputée réservée au contexte isolé
// multi-origine, et c'est le seul instrument que le dépôt gagnerait à poser COOP/COEP — le spike #4
// avait échoué à mesurer la mémoire faute d'elle. Le spike #41 la RELÈVE dans les deux conditions
// plutôt que de supposer ce qu'elle donne : une capacité n'est acquise que si on l'a vue.

/**
 * @returns {Promise<{ disponible: boolean, octets?: number, nombreBreakdown?: number,
 *                     raison?: string }>}
 */
export async function mesurerMemoireDetaillee() {
  const mesure = performance.measureUserAgentSpecificMemory;
  if (typeof mesure !== "function") {
    return { disponible: false, raison: "measureUserAgentSpecificMemory absente de ce contexte" };
  }
  try {
    const resultat = await mesure.call(performance);
    return {
      disponible: true,
      octets: resultat.bytes,
      nombreBreakdown: resultat.breakdown.length,
    };
  } catch (erreur) {
    return { disponible: false, raison: `${erreur.name} : ${erreur.message}` };
  }
}
