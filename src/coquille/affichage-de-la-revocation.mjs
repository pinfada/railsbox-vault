// L'AFFICHAGE de la révocation (#265, ADR 0049 § C2) : les effets VISIBLES que le rendeur unique pose sur
// le conteneur, et le masquage VÉRIFIÉ que le magasin exige avant tout envoi.
//
// Trois règles, portées ici et nulle part ailleurs :
//  - R-1  le contenu du conteneur visible ne change que par UN `replaceChildren(fragment)` : jamais
//         d'écriture incrémentale (`append`, `textContent`, `innerHTML`) dans le nœud visible ;
//  - R-3  l'estampille `data-vue` est l'UNIQUE acte qui rend le contenu visible (règle CSS : « masqué sans
//         `data-vue` »), donc le DERNIER ; `data-occurrence` la précède ;
//  - R-8  `masquer()` ÉCRIT puis RELIT : il rend `true` si, et seulement si, le conteneur est attaché,
//         sans estampille et `hidden`. Un échec de l'écriture est suivi d'un repli indépendant, puis du
//         détachement du nœud : aucune affirmation ne reste visible (L11″ pour le reste).
//
// Le conteneur, l'espace réservé et la région d'erreur sont du HTML STATIQUE : le script ne fait que
// retirer ou poser `hidden`, `data-vue`, `data-occurrence` et `data-erreur`.

/**
 * @param {{ doc: Document, conteneur: Element | null, regionDErreur: Element | null,
 *           repereDeFocus?: Element | null, surPublication?: () => void }} appel
 */
export function creerLAffichage({
  doc,
  conteneur,
  regionDErreur,
  repereDeFocus = null,
  surPublication = () => {},
}) {
  /** Identifiant du nœud qui avait le focus DANS le conteneur, avant son remplacement. */
  let focusAvant = null;

  /** Le masquage est-il ÉTABLI ? Lu sur le DOM, jamais supposé. */
  function masquageEtabli() {
    try {
      return (
        conteneur.isConnected === true &&
        !conteneur.hasAttribute("data-vue") &&
        conteneur.hidden === true
      );
    } catch {
      return false;
    }
  }

  function masquer() {
    if (conteneur === null || conteneur === undefined) return false;
    try {
      conteneur.removeAttribute("data-vue");
      conteneur.removeAttribute("data-occurrence");
    } catch {
      // le retrait a échoué : le contrôle ci-dessous le dit
    }
    try {
      conteneur.hidden = true;
    } catch {
      // idem
    }
    if (masquageEtabli()) return true;
    // Repli : une seconde écriture, indépendante de la première (l'attribut, pas la propriété).
    try {
      conteneur.setAttribute("hidden", "");
    } catch {
      // idem
    }
    if (masquageEtabli()) return true;
    // Dernier recours : le nœud est détaché, aucune affirmation n'est visible. Le masquage n'est PAS établi.
    try {
      conteneur.remove();
    } catch {
      // un navigateur qui refuse jusqu'au détachement : L11″
    }
    return false;
  }

  function memoriserLeFocus() {
    focusAvant = null;
    const actif = doc.activeElement;
    if (actif !== null && actif !== undefined && conteneur.contains(actif)) focusAvant = actif.id;
  }

  /** R-9 : le focus rendu au même nœud (retrouvé par son identifiant), sinon au repère stable. */
  function rendreLeFocus() {
    if (focusAvant === null) return;
    const identifiant = focusAvant;
    focusAvant = null;
    const meme = identifiant === "" ? null : conteneur.querySelector(`#${identifiant}`);
    (meme ?? repereDeFocus)?.focus();
  }

  const effets = Object.freeze({
    remplacerLeContenu(fragment) {
      memoriserLeFocus();
      conteneur.replaceChildren(fragment);
    },
    retirerLaRegionDErreur() {
      regionDErreur.hidden = true;
      regionDErreur.removeAttribute("data-erreur");
    },
    demasquer() {
      conteneur.hidden = false;
    },
    estamper(occurrence, valeur) {
      conteneur.setAttribute("data-occurrence", String(occurrence));
      conteneur.setAttribute("data-vue", String(valeur.empreinte));
      surPublication();
      rendreLeFocus();
    },
    masquer: () => void masquer(),
    montrerLaRegionDErreur(occurrence) {
      regionDErreur.setAttribute("data-erreur", String(occurrence));
      regionDErreur.hidden = false;
    },
  });

  return Object.freeze({
    nouveauFragment: () => doc.createDocumentFragment(),
    masquer,
    effets,
  });
}
