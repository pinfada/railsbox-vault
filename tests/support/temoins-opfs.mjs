// La COMPARAISON des témoins OPFS de la frontière d'origine, et la FOUILLE de l'OPFS (#46, #231,
// revues de la PR #305).
//
// Un `UnknownError` de `getDirectory()` ne PROUVE pas que l'OPFS est absente : le moteur le dit
// « transitoire ». Il ne retire donc JAMAIS un témoin de la comparaison et ne rend jamais une fouille
// vide. Il donne `indetermine` — et l'épreuve ÉCHOUE —, sauf dans UN seul contexte : le contexte
// éphémère WebKit, que l'ÉPREUVE connaît par SA PROPRE fixture (`contexteEphemereMesure`), jamais par le
// nom de l'erreur observée. Et même là, deux conditions tiennent la tolérance : A n'a rien pu déposer
// non plus (`depots.opfs` est `indetermine`), et le détail est exactement celui qui a été mesuré. Un
// témoin DÉJÀ DÉPOSÉ qui disparaît reste rouge.

const INDISPONIBILITE_ETABLIE = /(^| )absent$/;
const DETAIL_MESURE = "navigator.storage.getDirectory rejeté (UnknownError)";

/** L'indisponibilité ÉTABLIE : une API absente, et rien d'autre. */
function estIndisponibleEtablie(sonde) {
  return sonde.resultat === "indisponible" && INDISPONIBILITE_ETABLIE.test(sonde.detail ?? "");
}

/** Le trou de mesure toléré : un témoin OPFS `indetermine`, dans le seul contexte éphémère mesuré. */
function estToleree(sonde, { contexteEphemereMesure = false, depots = null } = {}) {
  return (
    contexteEphemereMesure === true &&
    typeof depots?.opfs === "string" &&
    depots.opfs.startsWith("indetermine: ") &&
    sonde.mecanisme === "OPFS" &&
    sonde.resultat === "indetermine" &&
    sonde.detail === DETAIL_MESURE
  );
}

/** Les témoins OPFS dont la mesure manque, mais que le contexte mesuré autorise à ne pas mesurer. */
export function temoinsOpfsToleres(sondes, options) {
  return sondes.filter((sonde) => estToleree(sonde, options));
}

/**
 * Compare un relevé à une table d'attentes. Seules l'API absente et la tolérance ci-dessus sortent de
 * la comparaison : tout le reste — `indetermine` ailleurs, `panne`, `indisponible` sans API absente —
 * est un écart. Les écarts sont rendus, jamais avalés.
 */
export function ecarts(sondes, attendu, options = {}) {
  return sondes
    .filter((sonde) => !estIndisponibleEtablie(sonde) && !estToleree(sonde, options))
    .filter((sonde) => sonde.resultat !== attendu[sonde.nom])
    .map(
      (sonde) =>
        `${sonde.nom} : ${sonde.resultat} au lieu de ${attendu[sonde.nom]} — ${sonde.detail}`,
    );
}

/**
 * Les témoins OPFS d'une topologie ISOLÉE qui n'ont pas été MESURÉS. « Rien n'aboutit » ne vaut preuve
 * d'isolation que si chaque témoin a rendu `lu` ou `invisible` : un `indetermine` ou une `panne` n'est
 * pas un refus. Seule la tolérance du contexte éphémère mesuré en est exemptée.
 */
export function opfsNonMesures(sondes, options = {}) {
  return sondes.filter(
    (sonde) =>
      sonde.mecanisme === "OPFS" &&
      !["lu", "invisible"].includes(sonde.resultat) &&
      !estToleree(sonde, options),
  );
}

/**
 * Ce qu'une fouille de l'OPFS impossible vaut. Une fouille qui ne regarde rien n'est PAS une fouille
 * vide : c'est une PANNE, sauf dans le seul contexte éphémère mesuré (`contexteEphemereMesure`, posé par la
 * FIXTURE de l'épreuve, jamais par ce que la page affiche) où, de surcroît, le moteur n'ouvre aucun volume
 * (`porte` faux, constaté par une ouverture réelle) : la limite est alors ÉCRITE et la fouille reste « non
 * réalisée ».
 *
 * @param {{ porte: boolean, contexteEphemereMesure?: boolean, morceaux: { ou: string, texte: string, impossible?: string }[] }} fouille
 * @returns {{ problemes: string[], limites: string[] }}
 */
export function fouilleOpfsAdmise({ porte, morceaux, contexteEphemereMesure = false }) {
  const problemes = [];
  const limites = [];
  for (const morceau of morceaux) {
    if (morceau.impossible === undefined) continue;
    if (porte || contexteEphemereMesure !== true) {
      problemes.push(
        `fouille OPFS impossible (${morceau.impossible}) alors que le moteur ouvre un volume : ` +
          "une panne, pas une fouille vide",
      );
    } else {
      limites.push(
        `OPFS non réalisée (${morceau.impossible}) : le moteur n'ouvre aucun volume dans ce contexte, ` +
          "le témoin OPFS n'est pas exigé — et la fouille n'est pas déclarée vide",
      );
    }
  }
  return { problemes, limites };
}
