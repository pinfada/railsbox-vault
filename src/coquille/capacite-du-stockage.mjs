// ROUGE : un stub sans transitions — la sémantique fautive (un booléen qui retombe à faux sur toute
// panne) que les épreuves du lot rejettent. Le code vert remplace ce fichier.

export const ETATS_DE_CAPACITE = Object.freeze({
  inconnu: "inconnu",
  disponible: "disponible",
  indetermine: "indetermine",
  absent: "absent",
  panne: "panne",
});

export function capaciteInitiale({ apiPresente }) {
  return { etat: apiPresente ? "inconnu" : "absent" };
}

export function apresLaSonde(capacite, { verdict, code = null }) {
  if (verdict === "atteignable") return { etat: "disponible" };
  if (verdict === "absente") return { etat: "absent" };
  if (verdict === "indetermine") return { etat: "indetermine" };
  return { etat: "indetermine", code };
}

export const peutOuvrir = (capacite) => capacite.etat === "disponible";
export const reessayable = (capacite) => capacite.etat === "indetermine";
export const etatPublie = () => "verrouille";
export const refusDeCapacite = () => null;
