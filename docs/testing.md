# Stratégie de test

## Suites disponibles

| Commande               | Portée                                      |                     Coût attendu |
| ---------------------- | ------------------------------------------- | -------------------------------: |
| `npm run test:unit`    | contrats et logique pure sous Node          |                         secondes |
| `npm run test:browser` | vraie page et Worker dédié sous Chromium    |                         secondes |
| `npm test`             | suites unitaire et navigateur               |                         secondes |
| `npm run check`        | lint, format et toutes les suites actuelles | moins de 2 min hors installation |

Les suites `test:vm`, `test:e2e`, `test:resilience` et `test:security` seront ajoutées lorsqu'elles
posséderont un premier scénario réel. Un script vide qui réussit ne constitue pas une preuve.

## Preuve rouge

Pour une implémentation TDD, la PR indique :

- le commit contenant le test avant l'implémentation ;
- la commande exécutée ;
- l'échec attendu et sa cause ;
- le commit qui rend la même commande verte.

Il n'est pas demandé de pousser un état rouge sur `main`. Les PR de documentation, spikes et audits
utilisent leurs preuves propres.

## Données de test

Les tests emploient uniquement des données synthétiques, déterministes et versionnées. Les scénarios
de corruption conservent une graine de reproduction.

## Navigateurs

Chromium est le premier moteur du harnais, pas encore la matrice de support du produit. L'issue #2
décidera des moteurs et versions cibles à partir de tests de capacités, puis étendra la CI en
conséquence.
