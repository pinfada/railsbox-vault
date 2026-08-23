# Politique de compatibilité

## Statuts

- **candidat** — prévu, non encore démontré ;
- **mesuré** — capacités unitaires vérifiées ;
- **supporté** — scénario E2E publié et maintenu en CI ou recette périodique ;
- **refusé** — détection préalable et diagnostic stable ;
- **expérimental** — fonctionne sans engagement de migration ni de support.

## Matrice initiale

| Cible                 | Statut                                          | Condition de promotion                                    |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Chromium ordinateur   | mesuré pour page + Worker ; candidat pour Vault | #2 puis jalon 1                                           |
| Firefox ordinateur    | candidat                                        | #2, OPFS et scénario du jalon 1                           |
| Safari ordinateur     | candidat                                        | #2, limites OPFS et scénario du jalon 1                   |
| Navigateurs mobiles   | expérimental                                    | budgets mémoire, cycle Worker et récupération             |
| Node 22               | supporté pour développement et CI               | contrôle obligatoire `Qualité et tests`                   |
| PostgreSQL dans la VM | candidat                                        | fixture #5 et persistance #7                              |
| SQLite dans la VM     | candidat                                        | fixture dédiée après preuve PostgreSQL ou ADR de priorité |

La détection porte sur les capacités effectives, pas seulement sur un numéro de navigateur. Une
extension optionnelle comme WebAuthn PRF doit confirmer son résultat à l'enregistrement et au
déverrouillage.

## Applications Rails

Vault ne promet pas encore la compatibilité universelle de RailsBox Live. Une application devient
supportée lorsqu'elle fournit :

- un build reproductible et sans secret ;
- un identifiant et une version immuables ;
- une politique de migration de son volume ;
- une recette E2E de création, fermeture, reprise, export et restauration ;
- un diagnostic des dépendances réseau ou système incompatibles.
