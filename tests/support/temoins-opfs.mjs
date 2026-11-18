// ROUGE : la sémantique actuelle — l'indisponibilité mesurée, `UnknownError` compris, sort de la
// comparaison — que les épreuves du lot rejettent. Le code vert remplace ce fichier.

const INDISPONIBILITE_MESUREE =
  /(^| )absent$|^navigator\.storage\.getDirectory rejeté \(UnknownError\)$/;

export function ecarts(sondes, attendu) {
  return sondes
    .filter(
      (sonde) =>
        !(sonde.resultat === "indisponible" && INDISPONIBILITE_MESUREE.test(sonde.detail ?? "")),
    )
    .filter((sonde) => sonde.resultat !== attendu[sonde.nom])
    .map(
      (sonde) =>
        `${sonde.nom} : ${sonde.resultat} au lieu de ${attendu[sonde.nom]} — ${sonde.detail}`,
    );
}

export function fouilleOpfsAdmise() {
  return { problemes: [], limites: [] };
}

export function opfsNonMesures() {
  return [];
}

export function temoinsOpfsToleres() {
  return [];
}
