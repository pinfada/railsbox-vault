// Brancher un geste PROPRE au parcours (« Terminer sans révoquer », « Revenir à mon application »,
// « Continuer », …) : aucun ne parle au Worker (#193, ADR 0040).

/**
 * @param {{ noeud: (id: string) => any, id: string, faire: () => void, rendre: () => void,
 *           revocation: { sortieFermee: (id: string) => boolean } }} liaison
 */
export function brancherUnGesteDuParcours({ noeud, id, faire, rendre, revocation }) {
  noeud(id)?.addEventListener("click", () => {
    // La garde est ICI, synchrone, au début du gestionnaire : `disabled` ne la remplace pas (un
    // `dispatchEvent()` synthétique, ou un `click` retenu par un rendu différé, atteint le gestionnaire).
    if (revocation.sortieFermee(id)) return;
    faire();
    rendre();
  });
}
