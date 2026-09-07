// L'ÉTAPE 2 du cycle de vie, moitié EXCLUSIVITÉ (#163, ADR 0030).
//
// L'architecture demande que la coquille « acquière l'exclusivité du volume et un canal privé vers
// le Worker, avant qu'aucun document applicatif n'existe ». Le canal était produit depuis #161 ;
// l'exclusivité, elle, restait le banc du bail (#8) — et l'ADR 0028 l'écrivait sans détour : « le
// verrou nommé et la diffusion inter-onglets n'existent pas encore dans le produit ».
//
// Ce module ne fabrique pas ce verrou. Il fabrique le CONSTAT qui manquait, et il faut dire
// exactement ce qu'il vaut :
//
//  - ce qu'il APPORTE — un second détenteur du volume est nommé AVANT qu'un document applicatif
//    existe, sous `VAULT_STORAGE_BUSY`, plutôt que découvert au milieu d'un déverrouillage, après
//    qu'une phrase a été saisie et qu'Argon2id a tourné deux secondes ;
//  - ce qu'il NE VAUT PAS — entre le constat et l'ouverture réelle, un autre onglet peut prendre le
//    handle. L'exclusivité CONTINUE est le bail d'écriture (#79), hors de cette tranche. La vraie
//    exclusivité commence à `openOpfsVolume` et dure jusqu'à `close()`.
//
// Le geste est un aller-retour : le handle exclusif est pris, puis relâché aussitôt. Une réservation
// tenue jusqu'au déverrouillage ferait rendre `VAULT_STORAGE_BUSY` à l'ouverture qui la suit — la
// coquille se refuserait le volume à elle-même.

import { openOpfsSyncAccess, statOpfsVolume } from "../vm/opfs-sync-access.mjs";

/**
 * Les verdicts, clos et finis. `sans-volume` n'est pas `disponible` : un coffre neuf n'a pas encore
 * de fichier, et prétendre que l'exclusivité y est acquise décrirait un fichier qui n'existe pas.
 */
export const VERDICTS_DEXCLUSIVITE = Object.freeze({
  /** Le handle exclusif a été obtenu, puis relâché : personne d'autre ne le tenait. */
  disponible: "disponible",
  /** Un autre détenteur le tient — un second onglet de la même origine, le plus souvent. */
  refusee: "refusee",
  /** Le volume n'existe pas encore. Il n'y a rien à prendre, et rien n'est créé pour le savoir. */
  sansVolume: "sans-volume",
  /** Ce moteur n'offre pas l'accès synchrone à l'OPFS dans un Worker : la question est sans objet. */
  indisponible: "indisponible",
  /** Le support a refusé de répondre. Ce n'est ni un oui ni un non, et le dire vaut mieux. */
  inconnue: "inconnue",
});

/**
 * CONSTATE l'exclusivité du volume nommé.
 *
 * Un volume ABSENT n'est pas un refus, et l'ouvrir pour poser la question le CRÉERAIT —
 * `openOpfsSyncAccess` crée le fichier — c'est-à-dire muterait le support pour l'interroger, ce que
 * `statOpfsVolume` existe précisément pour éviter.
 *
 * Ne lève jamais : un constat qui remonterait une exception ferait échouer le démarrage de la
 * coquille sur une question à laquelle elle n'a besoin que d'une réponse.
 *
 * @param {{ volume: string, peutOuvrir: boolean }} options
 * @returns {Promise<{ verdict: string, volume: string, code: string | null }>}
 */
export async function constaterLExclusivite({ volume, peutOuvrir }) {
  const constat = (verdict, code = null) => ({ verdict, volume, code });
  if (!peutOuvrir) return constat(VERDICTS_DEXCLUSIVITE.indisponible);
  let observe;
  try {
    observe = await statOpfsVolume(volume);
  } catch (erreur) {
    return constat(VERDICTS_DEXCLUSIVITE.inconnue, erreur?.code ?? null);
  }
  if (!observe.present) return constat(VERDICTS_DEXCLUSIVITE.sansVolume);
  let handle;
  try {
    handle = await openOpfsSyncAccess(volume);
  } catch (erreur) {
    return constat(VERDICTS_DEXCLUSIVITE.refusee, erreur?.code ?? null);
  }
  try {
    handle.close();
  } catch {
    // Un handle qui refuse de se fermer ne change pas le constat : il a été OBTENU, et c'est la
    // question posée. En faire un refus dirait qu'un autre détenteur a été rencontré — ce qui est
    // faux, et ce qui enverrait l'utilisateur fermer un onglet qui n'existe pas.
  }
  return constat(VERDICTS_DEXCLUSIVITE.disponible);
}
