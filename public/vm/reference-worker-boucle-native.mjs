// Worker de MESURE de #74 : l'image de référence bootée avec la boucle d'ordonnancement DU MOTEUR,
// c'est-à-dire l'état d'avant cette tranche. Il n'existe que pour un usage — mesurer le coût de la
// boucle de Vault en la comparant à celle qu'elle remplace, sur le MÊME code et le MÊME volume.
//
// Il ne duplique rien : il importe le Worker runtime du produit, en entier, phases comprises. Le
// seul écart est trois lignes plus bas — la boucle posée à l'évaluation de `reference-worker-boot`
// est RETIRÉE avant que quoi que ce soit ne l'emprunte. L'ordre le permet et n'a rien de fortuit :
//
//   1. les imports statiques s'évaluent d'abord ; c'est là que la boucle est posée ;
//   2. les instructions de tête de CE module s'exécutent ensuite ; c'est là qu'elle est retirée ;
//   3. `libv86.mjs` n'est importé que plus tard, à la première phase demandée, et c'est SEULEMENT
//      à ce moment que v86 fige son chemin d'ordonnancement.
//
// Ce Worker n'est atteignable que par `reference.html?boucle=native`, que seul le harnais
// `npm run test:rythme` demande. Il ne peut pas se glisser dans une mesure du produit sans se
// dénoncer : son compte rendu porte `boucleOrdonnancement: null`, et
// `tests/e2e/reprise-mutation-boot-froid.spec.mjs` EXIGE une boucle de Vault sur ce chemin.

import { boucleOrdonnancement } from "./reference-worker-boot.mjs";
import "./reference-worker.mjs";

boucleOrdonnancement.retirer();
