# Évaluation de readiness

Date de référence : 23 août 2026. L'évaluation porte sur l'état observable de `main` et de GitHub
après les PR #32, #33 et #36. Une note mesure une capacité démontrée, pas l'intention du projet.

## Méthode

Chaque critère est noté de 0 à 10 selon quatre dimensions de poids égal : contrat explicite, preuve
exécutable ou vérifiable, traitement des échecs, et capacité de reproduction par une autre personne.
`9,5` signifie que le travail ordinaire peut être réalisé sans décision implicite majeure et que les
exceptions résiduelles sont rares, bornées et testées.

La moyenne simple sert d'indicateur, sans compenser une faiblesse de sécurité par une bonne
documentation. Les gates de `SECURITY.md` restent absolus.

## Résultats

| Critère                          | Note | Preuves factuelles                                                                                       |
| -------------------------------- | ---: | -------------------------------------------------------------------------------------------------------- |
| Définition produit               |  9,3 | parcours MVP, personas, exigences `VAULT-*`, non-objectifs et pivots dans `product-requirements.md`      |
| Séparation RailsBox Live / Vault |  9,7 | dépôts, vision, roadmap et gouvernance indépendants ; partage futur contractuel                          |
| Architecture et contrats         |  8,8 | frontières, cycle de vie, stockage et erreurs documentés ; décisions #35 et #4 encore ouvertes           |
| Roadmap et dépendances           |  9,2 | jalons à critères de sortie, ordre critique et index #31 ; aucune vélocité réelle disponible             |
| Qualité du backlog               |  9,1 | file prête #2/#35 et chemin critique détaillé ; epics futurs volontairement non raffinés                 |
| TDD et intégration continue      |  8,4 | preuve rouge/verte #33, CI obligatoire et tests Node/Chromium ; aucun test VM ou résilience              |
| Reproductibilité                 |  8,2 | Node et dépendances verrouillés, commandes documentées ; images VM et build propre non prouvés           |
| Gouvernance des PR               |  9,3 | protection de `main`, contrôle strict, modèles, CODEOWNERS et auto-fusion ; revue encore mono-mainteneur |
| Sécurité démontrée               |  7,2 | modèle de menace, invariants et gates publiés ; séparation, chiffrement et audit non implémentés         |
| Qualité et performance mesurées  |  8,5 | budgets et protocole publiés ; presque aucune mesure runtime réelle                                      |
| Autonomie d'équipe               |  8,6 | guide, DoR/DoD, responsabilités, escalade et deux tâches prêtes ; bus factor actuel de un                |
| Versions et publications         |  8,0 | politiques runtime/app/volume et rollback définies ; aucune chaîne de release, SBOM ou signature         |

Moyenne informative : **8,7/10**. La fondation est exploitable pour commencer les deux prochains
travaux, mais RailsBox Vault n'est ni un runtime persistant démontré ni un produit apte aux données
réelles.

## Améliorations requises sous 9,5

### Définition produit — cible 9,5

Valider le parcours avec au moins cinq utilisateurs correspondant aux personas, publier les tâches,
taux de réussite et incompréhensions, puis ajuster les exigences uniquement par PR. La réussite est
atteinte quand deux sessions indépendantes accomplissent installation, reprise et restauration sans
aide orale dès que ces capacités existent.

### Architecture et contrats — cible 9,5

Fermer #35 et #4 avec ADR, prototypes reproductibles et tests de franchissement de frontière. Puis
figer les ports du Worker, la machine d'état du volume et les erreurs publiques dans des tests de
contrat consommés par le backend et le harnais.

### Roadmap et dépendances — cible 9,5

Après cinq PR représentatives, publier temps de cycle et capacité observés plutôt qu'une date
inventée. À chaque fermeture, vérifier automatiquement ou au triage que le successeur n'est promu
que si ses dépendances et sa Definition of Ready sont satisfaites.

### Qualité du backlog — cible 9,5

Raffiner seulement le prochain jalon, à raison d'au moins deux issues prêtes par flux actif. Pour
chaque issue promue, faire relire exigence, scénario négatif, commande de preuve, dépendances et
rollback par une personne qui ne l'a pas rédigée. Conserver les jalons lointains comme epics évite
une fausse précision qui déséquilibrerait le produit.

### TDD et intégration continue — cible 9,5

Livrer #2 puis ajouter les niveaux `test:vm`, `test:e2e`, `test:resilience` et `test:security`
seulement avec leur premier scénario réel. Rendre obligatoire le niveau correspondant au risque,
archiver les rapports de faute et ajouter tests de propriétés aux formats persistants.

### Reproductibilité — cible 9,5

Construire l'image Rails de #5 dans un environnement propre, épingler chaque source et publier
empreinte, licence et script. Une CI depuis clone vierge doit reconstruire ou vérifier les
artefacts, puis reproduire le scénario sur une seconde machine documentée.

### Gouvernance des PR — cible 9,5

Quand un second mainteneur existe, nommer titulaires et suppléants, étendre `CODEOWNERS` et exiger
une approbation non auteur ; deux regards sont requis pour sécurité et format persistant. Tester une
fois le processus d'exception et de rollback au lieu de le laisser purement déclaratif.

### Sécurité démontrée — cible 9,5

Implémenter chaque invariant `SEC-*` avec test offensif, fermer #16 à #25, épingler et attester la
chaîne d'approvisionnement, puis obtenir la revue externe #20. Les constats critiques ou élevés
doivent être corrigés ou explicitement bloquer la qualification ; aucun score documentaire ne lève
les gates de données sensibles.

### Qualité et performance mesurées — cible 9,5

Avec #4 à #7, publier p50/p95, pic mémoire, taille transférée et temps de récupération sur
l'environnement de référence. Conserver les historiques en artefacts CI et faire échouer une
qualification lorsqu'un budget est dépassé sans ADR accepté.

### Autonomie d'équipe — cible 9,5

Faire exécuter `team-start.md` par deux contributeurs n'ayant pas préparé le dépôt. Mesurer temps du
clone à la PR, questions bloquantes et erreurs de procédure ; corriger les documents et automatiser
les étapes répétées. La cible exige au moins deux propriétaires capables par domaine critique et un
transfert complet sans conversation privée indispensable.

### Versions et publications — cible 9,5

Automatiser une préversion avec changelog, artefacts déterministes, empreintes, SBOM et provenance,
puis vérifier signature, installation, export, restauration et rollback depuis la version
précédente. Le format de volume conserve ses vecteurs indépendamment de la version npm.

## Critère déjà au-dessus de 9,5

La séparation RailsBox Live / RailsBox Vault atteint 9,7. Aucune recommandation corrective n'est
ajoutée à ce critère ; toute mutualisation future devra préserver cette frontière par une interface
versionnée et une décision explicite.
