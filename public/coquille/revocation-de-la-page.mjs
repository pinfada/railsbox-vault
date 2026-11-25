// Le BRANCHEMENT de la révocation d'urgence dans la page (#265, ADR 0049 § C2).
//
// Ce module ne décide rien : il prête au câblage de `src/coquille/cablage-de-la-revocation.mjs` les nœuds
// du document et les quelques fonctions des AUTRES modules de branchement, par le pont (lecture
// PARESSEUSE : aucun de ces modules n'existe encore quand celui-ci est assemblé). Le magasin, le rendeur,
// l'affichage et les gestionnaires sont dans `src/coquille/`, où la campagne de mutation les rejoue.

import { creerLAcquit } from "/src/coquille/acquit-de-la-revocation.mjs";
import { creerLeCablage } from "/src/coquille/cablage-de-la-revocation.mjs";

/**
 * @param {{ rapport: object, publier: () => void,
 *           pont: { canal: object, parcours?: object, interface?: object, portabilite?: object } }} liaison
 */
export function creerLaRevocationDeLaPage({ rapport, publier, pont }) {
  const noeud = (id) => document.getElementById(id);
  return creerLeCablage({
    doc: document,
    conteneur: noeud("affichage"),
    regionDErreur: noeud("affichage-erreur"),
    annonce: noeud("affichage-annonce"),
    repereDeFocus: noeud("parcours-titre"),
    demander: (type, corps) => pont.canal.demanderAuWorker(type, corps),
    rapport,
    publierLeRapport: publier,
    indice: false,
    noterLIndice: () => pont.parcours.noterLaRevocation(),
    refleter: (donnees, identifiantVolume) => pont.interface?.refleter(donnees, identifiantVolume),
    // Le relevé, le lien d'archive fermé, la ligne d'état : `src/coquille/acquit-de-la-revocation.mjs`.
    surRevocationAcquittee: creerLAcquit({
      rapport,
      publier,
      // Aucune archive n'est offerte avant que les gestes de portabilité soient branchés : sans eux, il n'y a
      // pas de lien à fermer. Le test de l'acquit exige la fonction ; seule cette garde est ici.
      retirerLeLien: () => pont.portabilite?.retirerLeLien(),
      noeudDeLigne: noeud("portabilite-etat"),
    }),
    surTerminer: () => pont.parcours.terminerSansRevoquer(),
    surRevenir: () => pont.parcours.revenirALApplication(),
    apresPublication: () => pont.parcours?.appliquerLesBlocs(),
  });
}
