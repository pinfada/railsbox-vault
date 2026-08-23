# Attributs de qualité et budgets

Les budgets sont des seuils d'acceptation révisables par ADR, pas des promesses marketing. Toute
mesure publie machine, navigateur, volume, nombre d'essais et percentile ; une moyenne seule ne
suffit pas.

## Environnement de référence initial

- poste de bureau 4 cœurs physiques, 16 Gio de RAM ;
- profil navigateur neuf, alimentation secteur ;
- réseau limité à 100 Mbit/s pour le premier chargement ;
- application et jeu de données synthétiques de référence définis par #5 ;
- 10 essais après un échauffement, résultats p50 et p95.

L'issue #5 figera les caractéristiques exactes de la fixture. Toute autre machine est publiée
séparément et ne remplace pas cette référence.

## Budgets prototype

| Attribut               | Seuil de sortie du jalon concerné                                                 |
| ---------------------- | --------------------------------------------------------------------------------- |
| Installation           | `npm ci` + navigateurs reproductibles depuis un clone vierge                      |
| Premier boot de preuve | p95 ≤ 15 min, aucun timeout silencieux                                            |
| Reprise locale au MVP  | cible p95 ≤ 60 s ; dépassement exige un ADR avant qualification produit           |
| Mémoire                | pic navigateur ≤ 1,5 Gio au prototype ; cible MVP ≤ 1,2 Gio                       |
| Artefacts              | ≤ 500 Mio transférés par application au premier usage, inventaire détaillé publié |
| Écriture acquittée     | RPO 0 après la barrière durable du guest                                          |
| Récupération           | dernière génération valide trouvée en ≤ 60 s hors temps de boot VM                |
| Coupures injectées     | 100 % des points donnent ancien état, nouvel état ou erreur explicite             |
| Export                 | archive ≤ 2× la taille logique utilisée ; surmémoire de streaming ≤ 64 Mio        |
| Restauration           | empreinte vérifiée avant première mutation ; aucune écriture sur incompatibilité  |
| Multi-onglets          | jamais deux écrivains ; relais ou refus explicite en ≤ 5 s                        |
| Accessibilité          | parcours coquille conformes WCAG 2.2 AA avant qualification produit               |

Le budget de premier boot accepte temporairement la réalité de l'émulation ; il ne vaut pas
validation produit. La cible à 60 secondes est un gate : snapshot cohérent, autre stratégie de
reprise ou changement de runtime devront être évalués plutôt que d'abaisser silencieusement
l'exigence.

## Compatibilité

La cible produit est les deux dernières versions stables de Chromium, Firefox et Safari sur
ordinateur. Elle reste **candidate** jusqu'aux mesures de #2. Un moteur n'est annoncé supporté que
si toute capacité obligatoire et le scénario E2E du jalon passent dans sa CI ou sa recette publiée.

Le mobile est exploratoire tant que mémoire, stockage, fermeture des Workers et WebAuthn PRF ne
satisfont pas les mêmes preuves.

## Durabilité et sécurité

- aucun succès silencieux après corruption ou espace insuffisant ;
- aucune donnée réelle avant fermeture des gates sécurité de `SECURITY.md` ;
- aucun changement de format sans vecteur de compatibilité et sauvegarde ;
- aucune mesure de performance ne désactive `flush`, authentification ou séparation d'origine.
