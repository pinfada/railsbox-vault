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

/** Le masquage est-il ÉTABLI ? Lu sur le DOM, jamais supposé. */
function masquageEtabli(conteneur) {
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

/** Une écriture qui peut échouer sans que le contrôle qui suit en soit affecté. */
function essayer(ecriture) {
  try {
    ecriture();
  } catch {
    // le contrôle de `masquageEtabli` le dit
  }
}

function masquerLeConteneur(conteneur) {
  if (conteneur === null || conteneur === undefined) return false;
  essayer(() => {
    conteneur.removeAttribute("data-vue");
    conteneur.removeAttribute("data-occurrence");
  });
  essayer(() => {
    conteneur.hidden = true;
  });
  if (masquageEtabli(conteneur)) return true;
  // Repli : une seconde écriture, indépendante de la première (l'attribut, pas la propriété).
  essayer(() => conteneur.setAttribute("hidden", ""));
  if (masquageEtabli(conteneur)) return true;
  // Dernier recours : le nœud est détaché, aucune affirmation n'est visible. Le masquage n'est PAS établi.
  essayer(() => conteneur.remove());
  return false;
}

/** R-9 : le focus rendu au même nœud (retrouvé par son identifiant), sinon au repère stable. */
function rendreLeFocus(ctx) {
  const { conteneur, repereDeFocus, focus } = ctx;
  if (focus.avant === null) return;
  const identifiant = focus.avant;
  focus.avant = null;
  const meme = identifiant === "" ? null : conteneur.querySelector(`#${identifiant}`);
  (meme ?? conteneur.querySelector("[data-focus-initial]") ?? repereDeFocus)?.focus();
}

function memoriserLeFocus(ctx) {
  const actif = ctx.doc.activeElement;
  ctx.focus.avant =
    actif !== null && actif !== undefined && ctx.conteneur.contains(actif) ? actif.id : null;
}

function lesEffets(ctx) {
  const { conteneur, regionDErreur } = ctx;
  return Object.freeze({
    remplacerLeContenu(fragment) {
      memoriserLeFocus(ctx);
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
      ctx.surPublication();
      rendreLeFocus(ctx);
    },
    masquer: () => void masquerLeConteneur(conteneur),
    montrerLaRegionDErreur(occurrence) {
      regionDErreur.setAttribute("data-erreur", String(occurrence));
      regionDErreur.hidden = false;
    },
  });
}

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
  const ctx = {
    doc,
    conteneur,
    regionDErreur,
    repereDeFocus,
    surPublication,
    focus: { avant: null },
  };
  return Object.freeze({
    nouveauFragment: () => doc.createDocumentFragment(),
    masquer: () => masquerLeConteneur(conteneur),
    effets: lesEffets(ctx),
  });
}
