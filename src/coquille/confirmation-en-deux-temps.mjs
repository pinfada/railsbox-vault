// La CONFIRMATION EN DEUX TEMPS d'un geste irréversible, côté PAGE de confiance (#265).
//
// Un clic sur le geste ne l'accomplit pas : il OUVRE une confirmation, qui dit ce qui sera perdu et ce
// qui reste, et dont le focus est sur « Annuler ». Seul le second geste, nommé, accomplit. Annuler (le
// bouton, ou Échap) referme et rend le focus au geste qui avait demandé ; rien n'a été appelé.
//
// CE QUE CE MODULE EST, ET N'EST PAS. C'est une AIDE à la personne, pas une garde de sécurité : un
// script de même origine envoie le message au Worker sans passer par la page (le message n'a pas de
// paramètre, ADR 0039, § 5). La garde reste dans le Worker, inchangée. Ce que le module garantit est
// plus modeste et vérifiable : `confirmee` n'est appelée que depuis « le panneau est ouvert », une
// fois par ouverture, et JAMAIS tant qu'une demande précédente attend sa réponse. L'état « ouverte »
// est celui du DOM (l'attribut `hidden` du panneau) ; l'état « en vol » est tenu ici, et dit sur le
// geste (`aria-disabled`) : une fois « Oui » cliqué, la demande est partie et ne s'annule plus, donc
// la confirmation ne se rouvre pas, « Annuler » n'existe plus, et aucun second message ne part.
//
// Le module ne porte aucun texte : la page écrit ce que la confirmation dit (`textes-du-parcours.mjs`).
// #218 (retirer un code que l'on n'a plus) réutilise ce composant avec ses propres identifiants.

/**
 * @param {{ noeud: (id: string) => any,
 *           declencheur: string, panneau: string, annuler: string, confirmer: string,
 *           confirmee: () => void | Promise<unknown>, demandee?: () => void, annulee?: () => void }} liaison
 * @returns {{ demander: () => void, annuler: () => void, confirmer: () => Promise<void> }}
 */
export function brancherUneConfirmation({
  noeud,
  declencheur,
  panneau,
  annuler,
  confirmer,
  confirmee,
  demandee = () => {},
  annulee = () => {},
}) {
  let enVol = false;
  const ouverte = () => noeud(panneau)?.hidden === false;
  const dire = (ouvert) => noeud(declencheur)?.setAttribute("aria-expanded", String(ouvert));

  function demander() {
    // La SEULE garde « une demande en vol » : la confirmation ne se rouvre qu'une fois la réponse connue.
    if (ouverte() || enVol) return;
    noeud(panneau).hidden = false;
    dire(true);
    noeud(annuler)?.focus();
    demandee();
  }
  /** Referme et rend le focus au geste qui a demandé : le focus ne tombe jamais au document. */
  function refermer() {
    noeud(panneau).hidden = true;
    dire(false);
    noeud(declencheur)?.focus();
  }
  function renoncer() {
    if (!ouverte()) return;
    refermer();
    annulee();
  }
  /** `confirmee` peut rendre une promesse : tant qu'elle n'est pas réglée, la demande est EN VOL. */
  async function accomplir() {
    if (!ouverte()) return;
    refermer();
    enVol = true;
    noeud(declencheur)?.setAttribute("aria-disabled", "true");
    try {
      await confirmee();
    } finally {
      enVol = false;
      noeud(declencheur)?.removeAttribute("aria-disabled");
    }
  }

  relier({ noeud, declencheur, panneau, annuler, confirmer }, { demander, renoncer, accomplir });
  return Object.freeze({ demander, annuler: renoncer, confirmer: accomplir });
}

/** Les quatre écouteurs : le geste demande, « Annuler » et Échap renoncent, « Oui » accomplit. */
function relier(
  { noeud, declencheur, panneau, annuler, confirmer },
  { demander, renoncer, accomplir },
) {
  noeud(declencheur)?.addEventListener("click", demander);
  noeud(annuler)?.addEventListener("click", renoncer);
  noeud(confirmer)?.addEventListener("click", () => void accomplir());
  noeud(panneau)?.addEventListener("keydown", (evenement) => {
    if (evenement.key !== "Escape") return;
    evenement.preventDefault?.();
    renoncer();
  });
}

/**
 * Referme la confirmation SANS rendre le focus ni dire « annulé » : la page la ferme quand le geste
 * disparaît de l'écran (un changement d'étape), pour qu'une demande périmée ne survive jamais.
 *
 * @param {{ noeud: (id: string) => any, declencheur: string, panneau: string }} liaison
 */
export function oublierLaConfirmation({ noeud, declencheur, panneau }) {
  const cible = noeud(panneau);
  if (cible === null || cible === undefined || cible.hidden) return;
  cible.hidden = true;
  noeud(declencheur)?.setAttribute("aria-expanded", "false");
}
