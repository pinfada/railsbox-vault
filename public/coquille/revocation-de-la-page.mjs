// Le BRANCHEMENT de la révocation d'urgence dans la page (#265, ADR 0049 § C2).
//
// Ce module ne décide rien : il prête au câblage de `src/coquille/cablage-de-la-revocation.mjs` les nœuds
// du document et les quelques fonctions des AUTRES modules de branchement, par le pont (lecture
// PARESSEUSE : aucun de ces modules n'existe encore quand celui-ci est assemblé). Le magasin, le rendeur,
// l'affichage et les gestionnaires sont dans `src/coquille/`, où la campagne de mutation les rejoue.

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
    surRevocationAcquittee: (rendu) => {
      rapport.portabilite ??= { sauvegarde: null, restauration: null, revocation: null };
      rapport.portabilite.revocation = {
        versionEnveloppe: rendu.versionEnveloppe,
        restants: rendu.restants,
        retires: rendu.retires,
        nombreRetires: rendu.nombreRetires,
        nombreRestants: rendu.nombreRestants,
        copieDeSauvegardeRetiree: rendu.copieDeSauvegardeRetiree,
      };
      // L'archive que CETTE page tient encore porte l'ancienne page de récupération : le lien qui la
      // remet au navigateur est fermé (revue de la PR #208, constat 4).
      pont.portabilite?.retirerLeLien();
      publier();
      noeud("portabilite-etat").textContent =
        `portabilite:revoque:${rendu.nombreRetires}-retires:${rendu.nombreRestants}-restant`;
    },
    surTerminer: () => pont.parcours.terminerSansRevoquer(),
    surRevenir: () => pont.parcours.revenirALApplication(),
    apresPublication: () => pont.parcours?.appliquerLesBlocs(),
  });
}
