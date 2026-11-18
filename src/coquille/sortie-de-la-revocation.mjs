// La SORTIE de l'étape 9 pendant et après une révocation (#265, relecture de #308).
//
// Pendant qu'une révocation est EN VOL, ni « Terminer sans révoquer » ni « Revenir à mon application »
// ne doivent pouvoir quitter l'étape : le premier ferait dire « rien n'a été révoqué » d'une demande
// qui peut aboutir ensuite. Après une issue INCERTAINE, « Terminer sans révoquer » reste fermé : il
// dirait « rien n'a été révoqué » sans que la page le sache.

import { lireLigneDEtat } from "./parcours.mjs";

/**
 * @param {{ ligneDePortabilite?: string | null, revocationIncertaine?: boolean }} etat
 * @returns {{ sansRevoquerFerme: boolean, retourFerme: boolean }}
 */
export function sortieDeLEtape9({ ligneDePortabilite = null, revocationIncertaine = false }) {
  // « En vol » se lit sur la ligne que le geste publie, la seule chose que la page observe d'un geste.
  const enVol = lireLigneDEtat(ligneDePortabilite)?.evenement === "revocation-en-cours";
  return { sansRevoquerFerme: enVol || revocationIncertaine === true, retourFerme: enVol };
}

/**
 * Pose l'état fermé ou ouvert des deux gestes de sortie.
 *
 * @param {{ noeud: (id: string) => any, ligneDePortabilite?: string | null,
 *           revocationIncertaine?: boolean }} page
 */
export function poserLaSortie({ noeud, ...etat }) {
  const { sansRevoquerFerme, retourFerme } = sortieDeLEtape9(etat);
  const sans = noeud("parcours-sans-revoquer");
  const retour = noeud("parcours-retour-application");
  if (sans !== null && sans !== undefined) sans.disabled = sansRevoquerFerme;
  if (retour !== null && retour !== undefined) retour.disabled = retourFerme;
}
