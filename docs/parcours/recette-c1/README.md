# Recette QA ciblée du lot C, tranche 1 (#265) — 18/11/2026

Chromium (Playwright), coquille réelle **sans machine virtuelle** (le Worker de confiance est le
vrai), coffre d'essai créé pour la recette (phrase publique, aucune donnée personnelle). **Avant** :
`main` `40ef7d4`. **Après** : la branche du lot. Largeurs 360 et 1280 px, clair et sombre. Les
mesures brutes sont dans `avant/` et `apres/` (`mesures-<largeur>-<thème>.json`) ; les captures
nomment l'écran, la largeur et le thème.

Rejouer (depuis la racine du dépôt) : servir la coquille et l'origine applicative
(`node tools/serve.mjs --role shell --host 127.0.0.1 --port 4105 --app-origin http://localhost:4106`
et `node tools/serve.mjs --role app --host localhost --port 4106`), puis
`node docs/parcours/recette-c1/scripts/recette.mjs http://127.0.0.1:4105 <dossier> avant|apres`.

## Ce que la recette montre

| Constat (#265)                               | Avant (`main`)                                                                                                                                  | Après                                                                                                                                   | Captures                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Un clic révoque                              | un clic sur « Révoquer… » envoie `revoquer-en-urgence` (l'épreuve rouge le montre : compteur à 1, aucune confirmation)                          | un clic n'envoie rien : la confirmation s'ouvre ; « Annuler » a le focus ; « Oui, révoquer les autres moyens » envoie un message        | `etape-9-confirmation-*`, `accueil-confirmation-*` |
| Ordre de tabulation ≠ ordre visuel (étape 9) | tabulation : « Révoquer… » puis « Terminer sans révoquer » ; écran : l'inverse, par `order: 1` (`mesures-*`, `ordreDeTabulation`/`ordreVisuel`) | tabulation = écran = « Terminer sans révoquer » puis « Révoquer… » ; aucun `order` calculé dans la section                              | `etape-9-*`                                        |
| Danger en contour, principal « Terminer »    | déjà fait (ADR 0043 § 4) : « Terminer » principal, « Révoquer… » contour rouge                                                                  | inchangé                                                                                                                                | `etape-9-*`                                        |
| Annulation                                   | —                                                                                                                                               | referme, rend le focus à « Révoquer… », dit « Rien n'a été révoqué » ; `revocationsEnvoyees` reste à 0 (`mesures-*`, `etape-9-annulee`) | —                                                  |

## Limites de la recette

- Sans machine virtuelle : le parcours clavier sur Rails réel est l'E2E `parcours-clavier.spec.mjs`
  (CI).
- Un seul moteur (Chromium). Aucun lecteur d'écran n'a été utilisé : l'annonce est éprouvée par le
  nom et la description accessibles, pas par la voix.
- Le sous-repli « Sécurité » à l'accueil (DoR de #265, « à confirmer par capture ») : le bloc de
  révocation reste dans le panneau « Coffre » et la section de l'accueil ; aucun repli
  supplémentaire n'est ajouté (voir `accueil-*`). Décision laissée au propriétaire si la hiérarchie
  de l'accueil doit encore baisser le geste.
