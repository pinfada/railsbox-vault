# Contribuer à RailsBox Vault

RailsBox Vault manipule à terme des données durables et sensibles. Chaque
évolution doit donc rester petite, explicable et vérifiable indépendamment.

## Une tranche = une issue = une pull request

Toute évolution fonctionnelle commence par une issue. L'issue décrit un résultat
observable par l'utilisateur ou par un composant appelant, ses critères
d'acceptation et ce qui reste hors périmètre.

La pull request :

- ferme une seule issue principale avec `Closes #…` ;
- livre la plus petite tranche verticale qui satisfait ses critères ;
- inclut les tests et la documentation nécessaires ;
- ne mélange pas une refonte sans rapport avec le résultat annoncé ;
- reste en brouillon tant que sa preuve n'est pas complète.

Une issue peut nécessiter plusieurs PR uniquement si chacune apporte une preuve
autonome et si la décomposition est inscrite dans l'issue avant le découpage.

### Definition of Ready

Une issue d'implémentation ne passe à l'état prête que si :

- le résultat utilisateur ou le contrat composant est explicite ;
- ses dépendances sont fermées ou fournissent déjà leur contrat stable ;
- au moins un scénario d'acceptation est automatisable ;
- le niveau de preuve et la commande cible sont connus ;
- aucune décision d'architecture implicite ne bloque encore la solution ;
- les risques de sécurité et de compatibilité persistante sont qualifiés ;
- le périmètre tient dans une PR révisable.

Une issue qui ne satisfait pas ces conditions reste un epic, une question ou un
spike. Elle ne doit pas être prise comme tâche d'implémentation.

## Boucle TDD

Une PR d'implémentation documente les trois temps :

1. **Rouge** — le test ajouté échoue pour la raison attendue sans le changement ;
2. **Vert** — le changement minimal fait réussir ce test et les régressions ;
3. **Refactorisation** — les améliorations internes éventuelles conservent la
   suite verte.

Le dépôt ne demande pas de pousser volontairement un commit rouge sur `main`.
La preuve peut être le résultat copié dans la description de PR, une exécution
CI sur le commit de test, ou un lien vers un commit rouge présent dans la
branche. Un simple « tests ajoutés » n'est pas une preuve TDD.

Cette boucle est requise pour une implémentation ou une correction. Une PR de
documentation prouve ses liens, sa cohérence et ses contrôles de forme ; un
audit produit des constats et leur disposition.

Les explorations appelées `spike` répondent à une question dont la solution
n'est pas encore connue. Elles ne sont pas artificiellement présentées comme du
TDD. Elles fournissent un protocole reproductible, des mesures, une conclusion,
les artefacts permettant de reproduire l'expérience et, si elles influencent
l'architecture, un ADR.

## Niveaux de preuve

Chaque issue choisit le niveau le plus bas capable de prouver son résultat :

- **unitaire** : format, codec, règle pure, machine d'état ;
- **intégration navigateur** : Worker, OPFS, WebCrypto, WebAuthn simulé ;
- **intégration VM** : lectures, écritures et barrières entre v86 et le stockage ;
- **bout en bout** : vraie application Rails, fermeture et reprise du navigateur ;
- **résilience** : arrêt brutal, écriture partielle, corruption, rejeu ;
- **sécurité** : franchissement d'origine, fuite de clé, altération authentifiée.

Les commandes exactes apparaissent dans la PR. Une commande récurrente doit être
stabilisée dans les scripts du dépôt plutôt que recopiée différemment entre PR.

## Definition of Done

Une tranche est terminée lorsque :

- tous ses critères sont démontrés par une preuve adaptée à son type ;
- les contrôles obligatoires de la branche sont verts ;
- erreurs, logs et comportements de repli utiles sont couverts ;
- documentation, ADR et modèle de menace sont cohérents avec le résultat ;
- aucun secret ni donnée personnelle réelle n'entre dans les tests ;
- risques résiduels et travail découvert sont inscrits dans des issues ;
- la PR est assez autonome pour être annulée sans retirer une autre capacité.

## Changements structurants

Une PR ajoute ou modifie un ADR lorsqu'elle change :

- une frontière de confiance ;
- le format persistant ou sa compatibilité ;
- la récupération ou le cycle de vie des clés ;
- la relation entre snapshot et volume ;
- une promesse de portabilité ou de durabilité.

Une modification du modèle de menace met à jour `SECURITY.md` dans la même PR.

## Suivi GitHub

- Les **jalons** portent les capacités successives du produit.
- Les **issues** sont les tranches acceptables et testables.
- Une issue « Feuille de route » rassemble les liens et montre l'avancement.
- Les **pull requests** contiennent la réalisation et ses preuves.
- La fermeture automatique des issues par les PR maintient la feuille de route
  sans double saisie.

Les tâches découvertes en cours de PR sont créées comme issues séparées. Elles
ne sont absorbées dans la PR que si elles sont indispensables à ses critères
d'acceptation.

Les rôles, délais de décision, limites de travail simultané et règles
d'escalade sont décrits dans [`docs/governance.md`](docs/governance.md).
