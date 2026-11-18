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
/** Les champs que `aria-invalid` peut marquer : ceux qu'un refus juge, et le numéro de feuille (B2-7). */
const CHAMPS_MARQUES = Object.freeze([...CHAMPS_JUGES, "ancre-version"]);
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
    for (const champ of CHAMPS_MARQUES) {
      const cible = noeud(champ);
      if (cible === null) continue;
      const refuse = juge && CHAMP_DU_GESTE[gesteCourant()] === champ;
      if (refuse) emplacement = noeud(`refus-${champ}`);
      // La saisie fausse EN DIRECT (code mal recopié, B2-2 ; numéro qui n'en est pas un, B2-7) marque
      // le champ sans refus.
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

/**
 * Un numéro de feuille qui n'en est pas un se dit au champ, avant tout clic (#266 B2-7) : la recette a
 * vu la PHRASE tapée dans ce champ, et le refus qui s'ensuivait s'écrivait dans le relevé technique,
 * que personne n'ouvre. Un champ vide n'est pas une erreur : c'est un choix.
 *
 * @param {{ noeud: (id: string) => HTMLElement | null, dire: (id: string, texte: string) => void,
 *           lire: (texte: string) => { valide: boolean, aveu: string }, relier: () => void }} page
 */
export function relierLAncre({ noeud, dire, lire, relier }) {
  noeud("ancre-version")?.addEventListener("input", () => {
    const lue = lire(noeud("ancre-version").value);
    dire("parcours-ancre-lue", lue.valide ? "" : lue.aveu);
    noeud("ancre-version").dataset.saisieFausse = String(!lue.valide);
    relier();
  });
}

/** Les trois branchements des champs : le refus qui les juge, le code lu en direct, le numéro lu. */
export function relierLesChamps({ lireLeCode, annoncerLeCode, lireLAncre, ...page }) {
  const refusDuChamp = relierLeRefusAuChamp(page);
  const { noeud, dire } = page;
  const { relier } = refusDuChamp;
  relierLaSaisieDuCode({ noeud, dire, lire: lireLeCode, annoncer: annoncerLeCode, relier });
  relierLAncre({ noeud, dire, lire: lireLAncre, relier });
  return refusDuChamp;
}
