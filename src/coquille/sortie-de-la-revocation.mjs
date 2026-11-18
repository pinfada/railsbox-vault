// La SORTIE de l'étape 9 pendant et après une révocation (#265, relecture de #308).
//
// Pendant qu'une révocation est EN VOL, ni « Terminer sans révoquer » ni « Revenir à mon application »
// ne doivent pouvoir quitter l'étape : le premier ferait dire « rien n'a été révoqué » d'une demande
// qui peut aboutir ensuite. Après une issue INCERTAINE, « Terminer sans révoquer » reste fermé : il
// dirait « rien n'a été révoqué » sans que la page le sache.

/**
 * @param {{ ligneDePortabilite?: string | null, revocationIncertaine?: boolean }} etat
 * @returns {{ sansRevoquerFerme: boolean, retourFerme: boolean }}
 */
export function sortieDeLEtape9(etat) {
  void etat;
  return { sansRevoquerFerme: false, retourFerme: false };
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
