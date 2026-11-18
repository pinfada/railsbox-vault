// L'AFFICHAGE de la révocation (#265, ADR 0049 § C2) : les effets VISIBLES que le rendeur unique pose sur
// le conteneur. ÉCHAFAUDAGE du commit rouge : le contrat est posé, le comportement ne l'est pas encore.

export function creerLAffichage() {
  return Object.freeze({
    nouveauFragment: () => null,
    masquer: () => false,
    effets: Object.freeze({}),
  });
}
