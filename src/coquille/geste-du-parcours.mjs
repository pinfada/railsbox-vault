// Brancher un geste PROPRE au parcours (« Terminer sans révoquer », « Revenir à mon application »,
// « Continuer », …) : aucun ne parle au Worker (#193, ADR 0040).

/**
 * @param {{ noeud: (id: string) => any, id: string, faire: () => void, rendre: () => void,
 *           revocation: { sortieFermee: (id: string) => boolean } }} liaison
 */
export function brancherUnGesteDuParcours({ noeud, id, faire, rendre, revocation }) {
  void revocation;
  noeud(id)?.addEventListener("click", () => {
    faire();
    rendre();
  });
}
