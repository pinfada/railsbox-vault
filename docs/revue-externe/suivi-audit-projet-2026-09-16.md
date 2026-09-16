# Suivi des six remarques de l'audit du projet

Vérification du 16 septembre 2026 sur l'arbre local modifié. Ce document est un suivi de l'audit de
projet, distinct du registre de revue cryptographique. Les modifications locales ne sont pas encore
livrées sur GitHub. « Documenté » ne signifie pas « corrigé ».

| Remarque initiale                                 | État                                                       | Preuve et reste à faire                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Publication sans signature, SBOM et provenance | Partiellement traitée                                      | `tools/generer-sbom-npm.mjs` produit et confronte l'inventaire npm au verrou. Il ne couvre ni le système invité, ni Ruby, ni tous les artefacts vendus. `publication.yml` ne signe ni n'atteste les artefacts. Signature, provenance, inventaire complet et validation sur un hébergement réel restent ouverts.                                                                                                                                                                       |
| 2. Surveillance des dépendances                   | Implémentée localement, activation à vérifier              | Dependabot couvre npm, Bundler et Actions. `security.yml` définit deux audits indépendants, appelés par la CI et la publication, également exécutables sur calendrier. Le contrôle déjà requis `Qualité et tests` refuse désormais un échec des audits ou de la couverture. Il reste à livrer les workflows et constater le blocage sur GitHub.                                                                                                                                       |
| 3. Révocation et retour arrière                   | Limites documentées, non corrigées                         | `SECURITY.md`, section « Ce que le moyen de récupération couvre », décrit les anciennes copies et le retour arrière complet. Aucun chemin de rotation de la clé maîtresse ne les corrige. Une rotation protégerait les états futurs, jamais une copie historique déjà déchiffrable. Détecter un retour arrière intégral demande une référence de confiance hors du stockage rejoué. Ces changements nécessitent une décision d'architecture et des preuves de migration sous coupure. |
| 4. Instantané sensible / clé dédiée               | Recommandation de clé dédiée déjà satisfaite avant l'audit | `cleDInstantane` dans `src/vm/derivation/hierarchie-de-volume.mjs` dérive une clé par capture. La recommandation initiale était erronée ; la documentation a été rectifiée. La conservation de la RAM chiffrée au verrouillage demeure un choix explicite, pas une anomalie nouvellement corrigée.                                                                                                                                                                                    |
| 5. Absence de couverture                          | Mesure ajoutée, portée limitée                             | `test:coverage` impose des seuils sur les modules `src/` chargés par les tests Node ; `ci.yml` prévoit Node 22 et 24 et conserve les rapports. Modules jamais chargés, `public/`, Ruby, navigateur et couverture différentielle ne sont pas mesurés. La couverture globale n'est donc pas établie.                                                                                                                                                                                    |
| 6. Readiness périmée                              | Corrigée dans la documentation locale                      | `readiness-assessment.md` sépare maintenant la photographie historique et l'état observable actuel, avec les réserves explicites. Aucun nouveau score ne prétend qualifier la production.                                                                                                                                                                                                                                                                                             |

## Vérification de la protection de branche

Lecture de `repos/pinfada/railsbox-vault/branches/main/protection/required_status_checks` :
`strict: true`, contrôles requis `Qualité et tests` et `Campagnes de mutation`. Les nouveaux
contrôles `Audit npm et inventaire du verrou`, `Audit du verrou Ruby` et
`Couverture unitaire (Node 22)` / `Couverture unitaire (Node 24)` ne figurent pas dans cette liste.
Les règles GitHub n'ont pas été modifiées. La correction suivante raccorde ces résultats au contrôle
déjà requis : `Qualité et tests` devient un job final dépendant des tests du produit, des audits
réutilisables et de la matrice de couverture. Son `always()` empêche un échec amont de simplement
sauter le contrôle ; seul `success` est accepté pour chacun des trois résultats. Les tests lourds
restent parallèles. Ce mécanisme doit encore être constaté après livraison sur une PR réelle.

La publication appelle également les audits avec la révision demandée avant de construire. Cela
n'ajoute ni signature ni provenance et ne qualifie pas l'hébergement. Le workflow de sécurité garde
ses déclenchements hebdomadaire et manuel ; PR et push passent par la CI, sans deuxième exécution.
Les tests `workflows-controles-requis.test.mjs` vérifient le raccordement et exécutent le code réel
du contrôle avec succès, échec, annulation, saut et résultat manquant.

## Preuves disponibles et limites

- Après raccordement des contrôles requis : 1 905 tests réussis sous Node 22, aucun échec ni saut ;
  couverture de 94,01 % lignes, 89,54 % branches et 92,37 % fonctions. La suite avec couverture
  réussit également sous Node 24 avec les mêmes pourcentages. Les 19 nouveaux tests du raccordement
  couvrent notamment le refus des résultats annulés, sautés et manquants. Formatage global conforme.
  Les suites navigateur et la construction VM n'ont pas été rejouées lors de cette correction CI.
- Lors de l'autocritique : 1 884 tests réussis sous Node 22, couverture des modules chargés de 94,01
  % lignes, 89,54 % branches et 92,37 % fonctions. Ce relevé précède les deux nouveaux cas de refus
  de SBOM vide ou portant une version substituée ajoutés lors de ce suivi.
- La comparaison du SBOM réel au verrou a retrouvé les 79 composants, également sous
  `NODE_ENV=production` ; les audits npm et Bundler n'ont signalé aucun avis connu au relevé.
- Après renforcement du générateur : 25 tests ciblés réussis (SBOM, séparation des clés et modèle
  d'instantané), génération réelle du SBOM réussie, lint des modules modifiés et contrôle du diff
  conformes. L'exhaustivité des noms et versions du verrou est désormais contrôlée à chaque
  génération.
- Aucune exécution GitHub des nouveaux workflows, aucune signature de publication, aucune
  reconstruction complète de l'image ni qualification de déploiement n'est attestée par ce suivi.

Conclusion de suivi : les six remarques sont tracées ; elles ne sont pas toutes corrigées. Le gate
de production et celui des données sensibles restent inchangés.
