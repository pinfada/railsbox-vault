// SOLDE du journal de génération AVANT une capture d'instantané (#65, ADR 0024, décision 6).
//
// Ce module ne tient qu'un geste, et il vit à part pour une raison précise : c'est LUI qui décide
// si un instantané est capturable, et il est resté trop longtemps dans le Worker de référence —
// c'est-à-dire hors de portée de toute épreuve sous Node, alors que sa règle est celle que la revue
// de cette tranche a le plus discutée. `tests/unit/vm-instantane-solde.test.mjs` l'exerce désormais
// geste par geste.

/**
 * SOLDE le journal d'un guest ARRÊTÉ : valider ce qu'il a déposé, ranger, puis VÉRIFIER.
 *
 * Rend `null` quand le journal ne porte plus rien — la seule situation où une capture a un sens — ou
 * le détail de ce qui reste.
 *
 * **Valider les dépôts d'un guest ARRÊTÉ n'est pas une licence : c'est la condition de la
 * correction.** Les octets déposés ont atteint le périphérique. La mémoire qu'on s'apprête à
 * capturer les tient donc pour écrits — propres dans son cache de pages — et ne les relira jamais
 * depuis le disque. Les laisser non validés les ferait ÉCARTER à la prochaine ouverture, et le guest
 * restauré lirait alors, à la première éviction de cache, un secteur d'avant : une divergence
 * SILENCIEUSE entre la mémoire et le disque, exactement ce que l'ADR 0024 refuse.
 *
 * **Ce geste ne contredit pas la règle de `close()`** — « une génération non validée n'est PAS
 * rangée : personne ne l'a acquittée ». Cette règle protège la sémantique d'une COUPURE, où
 * ressusciter des écritures non acquittées serait inventer un état. Ici il n'y a pas de coupure : le
 * guest est arrêté proprement, et l'on rend le volume ÉGAL à la mémoire qu'on capture plutôt que
 * d'en capturer une qui le dépasse.
 *
 * **`SEC-DURABLE-001` est intact** : rien n'est annoncé durable à personne — le guest est arrêté et
 * ne recevra aucun acquittement —, et la barrière du support est franchie avant la racine, comme
 * partout ailleurs.
 *
 * La VÉRIFICATION finale n'est pas une politesse : ce qui resterait dans le journal serait rejoué
 * dans le volume à la prochaine ouverture. La région d'authentification changerait, la génération
 * non, et l'instantané serait écarté au motif `ECART_REGION` sur un volume que personne d'autre
 * n'aurait touché. Le scénario de bout en bout de cette tranche l'a mesuré avant que ce solde
 * n'existe.
 */
export async function solderLeJournal(generation) {
  if (generation.enAttente) await generation.valider();
  if (generation.rangeable) await generation.pointDeControle();
  if (!generation.enAttente) return null;
  return { octetsDeCharge: generation.octetsDeCharge };
}
