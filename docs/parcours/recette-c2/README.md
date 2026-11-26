# Recette QA ciblée — lot C, tranche C2 (#265)

Chromium, coquille réelle, sans machine virtuelle ; 360 et 1280 px, thèmes clair et sombre. Le
script `scripts/recette.mjs` joue les neuf étapes d'un coffre d'essai, puis relève chaque écran :
captures, ordre du DOM (= ordre de tabulation), ordre visuel (positions mesurées), bouton principal,
focus, nombre de messages `revoquer-en-urgence` posés sur le canal.

```sh
node docs/parcours/recette-c2/scripts/recette.mjs <origine> <dossier> avant|apres
```

- `avant/` : `main` à `505e794` (C1 fusionné, sans interface). Étape 9 et accueil.
- `apres/` : la branche de la PR. Étape 9 et accueil, puis la **confirmation** ouverte
  (`*-confirmation-*`).

## Ce que les mesures disent

| Écran (360 px, clair)        | Ordre de tabulation                                                          | Ordre visuel                                    | Focus                                        | Messages de révocation   |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- | ------------------------ |
| avant — étape 9              | `revoquer-en-urgence`, `parcours-sans-revoquer` (**désaccord avec l'écran**) | `parcours-sans-revoquer`, `revoquer-en-urgence` | —                                            | —                        |
| après — étape 9              | `parcours-sans-revoquer`, `revoquer-en-urgence`                              | identique                                       | titre                                        | 0                        |
| après — confirmation ouverte | `…`, `revocation-annuler`, `revocation-oui`                                  | identique                                       | **`revocation-annuler`**                     | **0** (rien n'est parti) |
| après — « Annuler »          | `parcours-sans-revoquer`, `revoquer-en-urgence`                              | identique                                       | **`revoquer-en-urgence`** (le geste ouvrant) | 0                        |

Avant, l'ordre du DOM contredisait l'écran (un `order: 1` CSS retournait la révocation) ; après, il
n'y a plus d'`order` : l'ordre visuel **est** l'ordre du DOM. « Terminer sans révoquer » est le
bouton principal, « Révoquer… » est en contour (danger) et n'est jamais principal.

## Ce que la recette ne prouve pas

L'annonce par un lecteur d'écran réel (seuls le nom accessible, le rôle `group` et l'ordre de
tabulation sont mesurés) ; Firefox et WebKit (les épreuves d'apparence et du navigateur les
couvrent, pas cette recette).
