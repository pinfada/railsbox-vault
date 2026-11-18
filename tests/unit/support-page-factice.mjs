// Une PAGE FACTICE pour les épreuves de la confirmation de la révocation (#265) : pas de document, des
// nœuds qui retiennent leurs écouteurs, leur `hidden`, leurs attributs, leur texte et le focus.

/** Une page factice : des nœuds qui retiennent leurs écouteurs, leur `hidden` et le focus. */
export function pageFactice() {
  const noeuds = new Map();
  // Le bloc qui porte la confirmation : le parcours le cache quand l'étape change.
  const page = { actif: null, bloc: { hidden: false } };
  const nouveau = (id) => {
    const ecouteurs = new Map();
    const attributs = new Map();
    const noeud = {
      id,
      hidden: id === "revocation-confirmation",
      disabled: false,
      textContent: "",
      addEventListener: (type, fn) => ecouteurs.set(type, [...(ecouteurs.get(type) ?? []), fn]),
      setAttribute: (nom, valeur) => attributs.set(nom, String(valeur)),
      getAttribute: (nom) => attributs.get(nom) ?? null,
      removeAttribute: (nom) => attributs.delete(nom),
      closest: () => (id === "revocation-confirmation" ? page.bloc : null),
      focus: () => {
        page.actif = id;
      },
      emettre: (type, evenement = {}) => {
        for (const fn of ecouteurs.get(type) ?? []) fn({ preventDefault() {}, ...evenement });
      },
      click: () => {
        if (!noeud.disabled && !noeud.hidden) noeud.emettre("click");
      },
    };
    return noeud;
  };
  page.racine = {
    querySelector(selecteur) {
      const id = selecteur.slice(1);
      if (id === "sauvegarde-lien") return null;
      if (!noeuds.has(id)) noeuds.set(id, nouveau(id));
      return noeuds.get(id);
    },
  };
  page.noeud = (id) => page.racine.querySelector(`#${id}`);
  return page;
}
