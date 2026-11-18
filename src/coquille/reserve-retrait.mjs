// Le GESTE « Retirer la copie hors connexion » (#299, ADR 0048 § 11) : `unregister()` ET suppression des
// caches (`unregister()` seul laisse le cache, et la page courante reste contrôlée jusqu'à sa navigation).
//
// Il est BORNÉ À LA COQUILLE, et c'est une exigence du second contre-examen :
//  - l'INSCRIPTION de la coquille : celle dont la portée est la racine de l'origine ET dont le `scriptURL` d'un
//    des Workers (actif, en attente, installant) est le script de la coquille, retrouvée par
//    `getRegistration("/")` puis VÉRIFIÉE sur son `scriptURL` avant `unregister()`. JAMAIS `getRegistrations()`
//    suivi d'une désinscription de toutes : une inscription distincte survit ;
//  - les caches dont le nom commence par `reserve-` (et les anciens préfixes NOMMÉS) : un cache d'un autre
//    nom de la même origine survit.
//
// L'ordre est celui du script de retrait : les caches d'abord, la désinscription ensuite. Le geste est
// IDEMPOTENT : rejouable après une interruption.

import { PREFIXES_ANCIENS, PREFIXE_DE_CACHE, URL_DU_SW } from "./reserve-identite.mjs";

function estLInscriptionDeLaCoquille(inscription) {
  try {
    if (new URL(inscription.scope).pathname !== "/") return false;
    return [inscription.active, inscription.waiting, inscription.installing].some(
      (worker) => worker && new URL(worker.scriptURL).pathname === URL_DU_SW,
    );
  } catch {
    return false;
  }
}

/**
 * @param {{ conteneur: any, caches: { keys(): Promise<string[]>, delete(nom: string): Promise<boolean> },
 *           prefixesAnciens?: readonly string[] }} o
 * @returns {Promise<{ desinscrite: boolean, caches: string[] }>}
 */
export async function retirerLaCopie({ conteneur, caches, prefixesAnciens = PREFIXES_ANCIENS }) {
  const inscription = await conteneur.getRegistration("/").catch(() => undefined);
  const supprimes = [];
  for (const nom of await caches.keys()) {
    if ([PREFIXE_DE_CACHE, ...prefixesAnciens].some((prefixe) => nom.startsWith(prefixe))) {
      await caches.delete(nom);
      supprimes.push(nom);
    }
  }
  const desinscrite =
    inscription !== undefined && estLInscriptionDeLaCoquille(inscription)
      ? (await inscription.unregister()) === true
      : false;
  return { desinscrite, caches: supprimes };
}
