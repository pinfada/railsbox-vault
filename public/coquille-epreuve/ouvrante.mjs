// Le geste qui OUVRE une seconde fenêtre, pour mesurer ce que COOP fait de la relation d'ouverture
// (#163, ADR 0030, décision 4).
//
// `window.open` déclenché par un CLIC, et non un `<a target="_blank">` : les moteurs posent
// `noopener` IMPLICITEMENT sur une ancre à cible nommée, si bien que l'épreuve mesurerait cette
// convention-là au lieu de l'en-tête. Le clic fournit le geste d'utilisateur qu'un bloqueur de
// fenêtres exigerait.
//
// DEUX cibles, et l'écart entre elles est ce qui isole COOP :
//
//  - la MÊME origine — `Cross-Origin-Opener-Policy: same-origin` compare deux documents avant de
//    couper, et deux documents de la même origine portant la même politique restent liés. Ce n'est
//    pas un défaut : c'est ce que la directive dit. Ce relevé sert de témoin POSITIF à la sonde —
//    sans lui, « opener nul » pourrait n'être qu'une lecture qui échoue ;
//  - une AUTRE origine — celle de l'ADR 0002, dont #24 suppose le code hostile. C'est là que la
//    coupure compte, et c'est là qu'elle est attestée.

import { origineApplicativeDe } from "/src/coquille/origines-de-la-coquille.mjs";
import { ORIGINE_APPLICATIVE_B } from "/spike/origin/apps-topologie.mjs";

/** Le chemin de la fenêtre ouverte, servi à l'identique par toutes les origines du harnais. */
const CHEMIN = "/coquille-epreuve/fenetre-ouverte.html";

/**
 * L'AUTRE origine, dérivée comme la coquille dérive la sienne.
 *
 * Depuis l'origine de confiance, c'est l'origine applicative de l'ADR 0002. Depuis l'origine
 * applicative elle-même, la règle ne conclut pas — `localhost` n'a pas de sous-domaine —, et le
 * repli est la seconde origine applicative du harnais (#46) : ce dont le témoin négatif a besoin
 * est une fenêtre INTER-ORIGINE, pas une origine particulière.
 */
const AILLEURS = origineApplicativeDe(location.origin) ?? ORIGINE_APPLICATIVE_B;

document.querySelector("#ouvrir-ici").addEventListener("click", () => {
  window.open(CHEMIN);
});

document.querySelector("#ouvrir-ailleurs").addEventListener("click", () => {
  window.open(`${AILLEURS}${CHEMIN}`);
});
