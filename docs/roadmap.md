# Feuille de route

La feuille de route détaillée vit dans les jalons et issues GitHub.
L'[issue d'index #31](https://github.com/pinfada/railsbox-vault/issues/31) rassemble toutes les
tranches et leur avancement. Ce document fixe l'ordre des preuves et les critères de sortie de
chaque étape.

## 0 — Fondation vérifiable

Le projet possède un harnais automatisé, une matrice de navigateurs explicite et des contrats de
composants suffisamment petits pour commencer les changements en TDD.

Ordre critique : #3 → (#2, #35) → #4 → #5. Le jalon se ferme avec les contrats opérationnels #34 et
les ADR produits par les spikes.

## 1 — Persistance locale

Une vraie application Rails modifie son disque applicatif dans le navigateur, le navigateur est
entièrement fermé, puis un boot à froid retrouve ces données. Aucun chiffrement ni snapshot mémoire
ne masque encore les problèmes de cohérence.

Dépendances : #4 et #5. Ordre : #6 → #14 → #7, tandis que #8 et #9 doivent être fermées avant de
qualifier la persistance.

## 2 — Portabilité

L'utilisateur exporte un volume complet, vérifiable et versionné, puis le restaure sur une autre
origine avec la bonne version de l'application et du runtime.

Ordre : #10 → #11 → #12 → #13. La restauration inter-origine réutilise la topologie décidée par #35.

## 3 — Résilience transactionnelle

Les barrières du système invité atteignent le stockage. Les écritures partielles, arrêts brutaux et
corruptions injectées produisent soit l'état validé précédent, soit le nouvel état validé, jamais un
succès silencieux incohérent.

Ordre : #14 → #15 → #16. Le jalon 4 ne fige aucun format chiffré avant #16.

## 4 — Volume chiffré

Le format assure confidentialité, authenticité des blocs et intégrité globale des générations. Il
détecte déplacement, rejeu, troncature et mélange de générations. Aucune promesse de production
n'est faite avant revue externe.

Ordre : #17 → #18 → #19 → #20. La revue externe publie constats, sévérité et disposition ; elle ne
simule pas une preuve TDD.

## 5 — Déverrouillage et origine de confiance

Une clé de volume aléatoire est enveloppée par une ou plusieurs clés de déverrouillage. Perte,
rotation, révocation et récupération sont testées. La coquille de confiance est isolée du code
applicatif.

La décision #35 précède les interfaces persistantes ; #24 en réalise la version complète avant toute
levée du gate « données sensibles ». Ordre des clés : #21 → #22 → #23, avec #25 avant qualification
produit.

## 6 — Échanges chiffrés optionnels

Deux utilisateurs peuvent échanger des paquets confidentiels, authentifiés et résistants au rejeu
sans confier leurs données au relais. RailsBox Vault fournit les primitives ; chaque application
conserve ses règles de fusion métier.

## Règle de passage

Un jalon n'est terminé que lorsque son scénario de sortie est automatisé au niveau approprié et que
ses limites restantes sont écrites. Une démonstration manuelle seule ne ferme pas un jalon.
