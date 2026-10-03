// Le refus JUGE le champ du geste qui l'a provoqué (#266 M2) : le champ le cite par
// `aria-describedby`, se marque `aria-invalid`, et la correction l'efface dès la première frappe.
//
// Seul un refus qui juge la VALEUR saisie accuse le champ (#266 B2-3) : un refus d'état — coffre déjà
// ouvert dans un autre onglet, installation inachevée — s'affiche sans le marquer. Le refus qui juge
// est PLACÉ sous le champ et son bouton (B2-1), dans l'emplacement que la page lui réserve : rien ne
// bouge quand il apparaît (B2-4), et le bouton n'est pas repoussé sous la ligne de flottaison (#251).

const CHAMP_DU_GESTE = Object.freeze({
  "ouvrir-par-phrase": "saisie-phrase",
  "ouvrir-par-code": "saisie-code",
});
const CHAMPS_JUGES = Object.freeze([...new Set(Object.values(CHAMP_DU_GESTE))]);
const REFUS = "parcours-refus";

/**
 * @param {{ doc: Document, noeud: (id: string) => HTMLElement | null,
 *           gesteCourant: () => string | null, dire: (id: string, texte: string) => void,
 *           jugeLaValeur: (texte: string) => boolean }} page
 */
export function relierLeRefusAuChamp({ doc, noeud, gesteCourant, dire, jugeLaValeur }) {
  const refus = noeud(REFUS);
  // La place d'origine du refus, pour l'y rendre quand il ne juge plus aucun champ.
  const maison = refus === null ? null : { parent: refus.parentNode, suivant: refus.nextSibling };

  function placerLe(emplacement) {
    if (refus === null || maison === null) return;
    if (emplacement === null) {
      if (refus.parentNode !== maison.parent) maison.parent.insertBefore(refus, maison.suivant);
    } else if (refus.parentNode !== emplacement) {
      emplacement.append(refus);
    }
  }

  function relier() {
    const texte = refus?.textContent ?? "";
    const juge = texte !== "" && jugeLaValeur(texte);
    let emplacement = null;
    for (const champ of CHAMPS_JUGES) {
      const cible = noeud(champ);
      if (cible === null) continue;
      const refuse = juge && CHAMP_DU_GESTE[gesteCourant()] === champ;
      if (refuse) emplacement = noeud(`refus-${champ}`);
      // La saisie fausse EN DIRECT (code mal recopié, B2-2) marque le champ sans refus.
      const invalide = refuse || cible.dataset?.saisieFausse === "true";
      const cites = (cible.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter((id) => id !== "" && id !== REFUS);
      if (invalide) cible.setAttribute("aria-invalid", "true");
      else cible.removeAttribute("aria-invalid");
      const describedby = refuse ? [...cites, REFUS] : cites;
      if (describedby.length === 0) cible.removeAttribute("aria-describedby");
      else cible.setAttribute("aria-describedby", describedby.join(" "));
    }
    placerLe(emplacement);
  }
  const Observateur = doc.defaultView?.MutationObserver;
  if (typeof Observateur === "function" && refus !== null) {
    new Observateur(relier).observe(refus, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  for (const champ of CHAMPS_JUGES) {
    noeud(champ)?.addEventListener("input", () => {
      if ((refus?.textContent ?? "") !== "" && jugeLaValeur(refus.textContent)) dire(REFUS, "");
    });
  }
  return Object.freeze({ relier });
}

/**
 * Un code mal recopié se dit comme une erreur de champ (#266 B2-2) : le champ est marqué tant que le
 * code est faux, et cite son message.
 *
 * @param {{ noeud: (id: string) => HTMLElement | null, dire: (id: string, texte: string) => void,
 *           lire: (texte: string) => { code: string | null }, annoncer: (etat: object) => string,
 *           relier: () => void }} page
 */
export function relierLaSaisieDuCode({ noeud, dire, lire, annoncer, relier }) {
  noeud("saisie-code")?.addEventListener("input", () => {
    const lue = lire(noeud("saisie-code").value);
    const fausse = lue.code !== null;
    dire("parcours-code-lu", annoncer(lue));
    if (fausse) noeud("parcours-code-lu").dataset.faute = "";
    else delete noeud("parcours-code-lu").dataset.faute;
    noeud("saisie-code").dataset.saisieFausse = String(fausse);
    relier();
  });
}
