// Le RAPPORT de refus de la source, écrit pour une personne qui n'est pas développeuse (#342).
//
// Chaque anomalie porte trois phrases : ce qui bloque, pourquoi, et quoi changer. Le code entre
// crochets suit le style des anomalies du contrat (`[code] message`, `contrat-du-paquet.mjs`) :
// il sert à qui cherche, la phrase sert à qui corrige. Toutes les anomalies sont rapportées d'un
// coup : corriger un point pour découvrir le suivant au tour d'après décourage.

/**
 * @typedef {{ code: string, fichier: string, quoi: string, pourquoi: string, changer: string }}
 *   AnomalieDeLaSource
 */

/**
 * Le texte du rapport.
 * @param {string} source chemin de la source examinée
 * @param {readonly AnomalieDeLaSource[]} anomalies
 */
export function rapportDeRefus(source, anomalies) {
  const nombre = anomalies.length === 1 ? "un point bloque" : `${anomalies.length} points bloquent`;
  const points = anomalies.map(
    (anomalie, rang) =>
      `  ${rang + 1}. [${anomalie.code}] ${anomalie.fichier}\n` +
      `     Ce qui bloque : ${anomalie.quoi}\n` +
      `     Pourquoi : ${anomalie.pourquoi}\n` +
      `     Quoi changer : ${anomalie.changer}`,
  );
  return (
    `Source refusée : ${source}\n` +
    `${nombre} la fabrication du paquet. Rien n'a été construit.\n\n` +
    `${points.join("\n\n")}\n`
  );
}

/**
 * L'erreur qui porte le rapport ET ses anomalies : le message pour la personne, la liste pour les
 * épreuves et pour qui voudrait les relire autrement.
 * @param {string} source
 * @param {readonly AnomalieDeLaSource[]} anomalies
 */
export function erreurDeRefus(source, anomalies) {
  const erreur = new Error(rapportDeRefus(source, anomalies));
  erreur.anomalies = Object.freeze([...anomalies]);
  return erreur;
}
