// Script de l'application de référence.
//
// Il ne fait qu'une chose, et c'est délibéré : marquer le document quand il
// s'est réellement EXÉCUTÉ. Un relais qui servirait le script sous un type de
// contenu que le navigateur refuse d'exécuter rendrait une page qui a l'air
// juste ; cette marque est ce qui distingue « servi » d'« exécuté ».
document.documentElement.dataset.scriptApplicatif = "execute";
