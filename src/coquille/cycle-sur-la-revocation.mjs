// ÉCHAFAUDAGE du commit rouge (#265, revue de #321) : le contrat est posé, la liaison ne l'est pas encore.
import { brancherLesGestesDuCycle } from "./gestes-du-cycle.mjs";

export function brancherLeCycleSurLaRevocation(liaison) {
  return brancherLesGestesDuCycle(liaison);
}
