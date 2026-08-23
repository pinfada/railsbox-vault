# Vision

## La proposition

Le web distribue remarquablement bien les logiciels, mais le modèle SaaS place
habituellement l'exécution et les données sous l'autorité de l'éditeur. Le
logiciel de bureau donne davantage de contrôle à l'utilisateur, au prix d'une
installation, de mises à jour et d'une distribution plus difficiles.

RailsBox Vault cherche à réunir ces deux propriétés :

> la simplicité de distribution du web et la souveraineté d'un logiciel
> personnel local.

Une application est publiée sous forme d'artefacts statiques. À l'ouverture, le
navigateur exécute localement Linux, Ruby, Rails, la base de données et les gems
nécessaires. Le serveur de publication distribue le logiciel ; il n'héberge pas
le volume personnel de l'utilisateur.

## Ce que signifie « souveraineté »

La souveraineté ne se limite pas à stocker un fichier dans OPFS. L'utilisateur
doit pouvoir :

1. travailler sans connexion après installation ;
2. savoir quelle version du logiciel ouvre son volume ;
3. exporter une sauvegarde complète dans un format documenté ;
4. restaurer cette sauvegarde sur un autre appareil ou une autre origine ;
5. conserver une version fonctionnelle si l'éditeur disparaît ;
6. choisir ou refuser tout service de synchronisation ;
7. récupérer l'accès après la perte raisonnablement prévisible d'un moyen de
   déverrouillage.

## Ce que RailsBox Vault n'est pas

- un hébergement SaaS sans facture ;
- une promesse de collaboration temps réel universelle ;
- une protection contre une application malveillante pendant le déverrouillage ;
- une raison d'enfermer les données dans une origine navigateur ;
- une couche métier imposant UUID, CRDT ou règles de fusion à toutes les
  applications Rails.

## Applications visées

Le projet vise d'abord les logiciels personnels ou familiaux durables : archives,
généalogie, collections, journaux, inventaires et outils fonctionnant hors
ligne. Une application de généalogie pourra servir de démonstrateur, sans que
son modèle métier devienne celui du runtime.
