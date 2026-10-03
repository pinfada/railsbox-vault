// La promesse de l'entrée (ADR 0043), écrite une fois depuis les textes du parcours — scindée de
// `parcours-de-la-page.mjs` pour le garder sous le seuil d'alerte de taille (#266).

import { PROMESSE } from "/src/coquille/textes-du-parcours.mjs";

/** @param {{ doc: Document, noeud: (id: string) => HTMLElement | null }} page */
export function ecrireLaPromesse({ doc, noeud }) {
  noeud("promesse-phrase").textContent = PROMESSE.phrase;
  const liste = noeud("promesse-garanties");
  liste.replaceChildren(
    ...PROMESSE.garanties.map(({ titre, preuve }) => {
      const item = doc.createElement("li");
      const fort = doc.createElement("strong");
      fort.textContent = titre;
      const texte = doc.createElement("span");
      texte.textContent = preuve;
      item.append(fort, texte);
      return item;
    }),
  );
}
