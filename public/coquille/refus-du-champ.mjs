// Le refus JUGE le champ du geste qui l'a provoqué (#266 M2) : le champ le cite par
// `aria-describedby`, se marque `aria-invalid`, et la correction l'efface dès la première frappe.

const CHAMP_DU_GESTE = Object.freeze({
  "ouvrir-par-phrase": "saisie-phrase",
  "ouvrir-par-code": "saisie-code",
});
const CHAMPS_JUGES = Object.freeze([...new Set(Object.values(CHAMP_DU_GESTE))]);

/**
 * @param {{ doc: Document, noeud: (id: string) => HTMLElement | null,
 *           gesteCourant: () => string | null, dire: (id: string, texte: string) => void }} page
 */
export function relierLeRefusAuChamp({ doc, noeud, gesteCourant, dire }) {
  function relier() {
    const refuse = (noeud("parcours-refus")?.textContent ?? "") !== "";
    for (const champ of CHAMPS_JUGES) {
      const cible = noeud(champ);
      if (cible === null) continue;
      const juge = refuse && CHAMP_DU_GESTE[gesteCourant()] === champ;
      const cites = (cible.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter((id) => id !== "" && id !== "parcours-refus");
      if (juge) cible.setAttribute("aria-invalid", "true");
      else cible.removeAttribute("aria-invalid");
      const describedby = juge ? [...cites, "parcours-refus"] : cites;
      if (describedby.length === 0) cible.removeAttribute("aria-describedby");
      else cible.setAttribute("aria-describedby", describedby.join(" "));
    }
  }
  const Observateur = doc.defaultView?.MutationObserver;
  if (typeof Observateur === "function" && noeud("parcours-refus") !== null) {
    new Observateur(relier).observe(noeud("parcours-refus"), {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  for (const champ of CHAMPS_JUGES) {
    noeud(champ)?.addEventListener("input", () => {
      if (noeud(champ).getAttribute("aria-invalid") === "true") dire("parcours-refus", "");
    });
  }
}
