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
// est celui du DOM (l'attribut `hidden` du panneau). L'état « en vol » n'est PAS tenu ici : l'appelant
// le donne (`enCours`), parce qu'il doit être posé par le geste lui-même, AVANT l'envoi, et lu par
// d'autres que ce composant (`etat-de-la-revocation.mjs`). Une fois « Oui » cliqué, la demande est
// partie et ne s'annule plus : la confirmation ne se rouvre pas, « Annuler » n'existe plus, aucun
// second message ne part ; le geste se dit `aria-disabled` le temps de la demande.
//
// Le module ne porte aucun texte : la page écrit ce que la confirmation dit (`textes-du-parcours.mjs`).
// #218 (retirer un code que l'on n'a plus) réutilise ce composant avec ses propres identifiants.

/**
 * `enCours` : une demande attend sa réponse — la confirmation ne se rouvre qu'une fois la réponse
 * connue. `interdite` : aucune demande ne s'offre (une révocation précédente d'issue incertaine) ; il
 * n'y a PAS de confirmation à ouvrir, donc rien à annuler, et `refusee` dit pourquoi. `refermer` rend le
 * focus au geste qui a demandé ; `accomplir` laisse le geste `aria-disabled` jusqu'à la réponse.
 *
 * @param {{ noeud: (id: string) => any,
 *           declencheur: string, panneau: string, annuler: string, confirmer: string,
 *           confirmee: () => void | Promise<unknown>, enCours?: () => boolean,
 *           interdite?: () => boolean, refusee?: () => void,
 *           demandee?: () => void, annulee?: () => void }} liaison
 * @returns {{ demander: () => void, annuler: () => void, confirmer: () => Promise<void> }}
 */
export function brancherUneConfirmation({
  noeud,
  declencheur,
  panneau,
  annuler,
  confirmer,
  confirmee,
  enCours = () => false,
  interdite = () => false,
  refusee = () => {},
  demandee = () => {},
  annulee = () => {},
}) {
  const ouverte = () => noeud(panneau)?.hidden === false;
  const marquer = (ferme) => marquerLeGeste(noeud(declencheur), ferme);
  const dire = (ouvert) => noeud(declencheur)?.setAttribute("aria-expanded", String(ouvert));

  function demander() {
    if (ouverte() || enCours()) return;
    if (interdite()) return refusee();
    noeud(panneau).hidden = false;
    dire(true);
    noeud(annuler)?.focus();
    demandee();
  }
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
  async function accomplir() {
    if (!ouverte()) return;
    refermer();
    const attente = confirmee(); // pose l'état « en vol », de façon synchrone, AVANT l'envoi
    marquer(true);
    try {
      await attente;
    } finally {
      marquer(interdite()); // fermé si l'issue le rend interdit
    }
  }

  relier({ noeud, declencheur, panneau, annuler, confirmer }, { demander, renoncer, accomplir });
  return Object.freeze({ demander, annuler: renoncer, confirmer: accomplir });
}

/** Le geste se dit fermé (`aria-disabled`) sans perdre le focus. */
function marquerLeGeste(bouton, ferme) {
  if (ferme) bouton?.setAttribute("aria-disabled", "true");
  else bouton?.removeAttribute("aria-disabled");
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
