// Une MODIFICATION D'ENVELOPPE dont l'appelant attend l'issue (#265, ADR 0049, C2-3).
//
// `modifier` du magasin lance le geste après le pré-vol et rend tout de suite `{ accepte, annonce }` :
// il ne rend pas l'issue, qu'il consomme lui-même pour relire l'inventaire. Les gestes qui montrent
// quelque chose de leur résultat — la feuille de récupération, la restauration — en ont besoin ; ce
// module la leur rend, sans jamais contourner `modifier` : le lanceur est TOUJOURS appelé par lui.

/**
 * @template T
 * @param {(lanceur: () => Promise<unknown>) => { accepte: boolean, annonce?: string | null }} modifier
 * @param {() => Promise<T>} faire le geste (un appel du canal privilégié)
 * @returns {{ accepte: boolean, annonce: string | null,
 *             issue: Promise<{ rendu: T | null, erreur: unknown }> | null }}
 */
export function modifierEtAttendre(modifier, faire) {
  let regler = () => {};
  const issue = new Promise((rendre) => {
    regler = rendre;
  });
  const resultat = modifier(async () => {
    let rendu = null;
    let erreur = null;
    try {
      rendu = await faire();
    } catch (echec) {
      erreur = echec;
    }
    regler({ rendu, erreur });
    // Un refus reste un refus pour le magasin : il relit l'inventaire quand même (e20).
    if (erreur !== null) throw erreur;
    return rendu;
  });
  return {
    accepte: resultat.accepte,
    annonce: resultat.annonce ?? null,
    issue: resultat.accepte ? issue : null,
  };
}
