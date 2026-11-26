// La SÉQUENCE de publication que portent la page et le Worker de confiance (#299, ADR 0048 § 6).
//
// STUB du dépôt vivant : `null` veut dire « aucune réserve » — `tools/serve.mjs` et `public/` n'enregistrent
// aucun Service Worker, et aucune épreuve existante n'est exposée à un cache de code. La PUBLICATION
// (`tools/publier-reserve.mjs`) remplace ce fichier par `{ sequence: <n> }` dans l'arbre `coquille`.
export const RESERVE_PUBLIEE = null;
