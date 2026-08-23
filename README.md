# RailsBox Vault

**RailsBox Vault explore une nouvelle forme de logiciel personnel : une
application Rails distribuée comme un site web, mais exécutée et possédée
localement comme un logiciel de bureau.**

Le navigateur exécute l'application, sa base de données et ses dépendances. Les
données de l'utilisateur restent locales, doivent pouvoir être chiffrées,
sauvegardées et déplacées sans dépendre d'un serveur applicatif permanent.

## Statut

RailsBox Vault est un projet expérimental. Il ne protège encore aucune donnée
réelle et ne doit pas être utilisé en production.

Le premier objectif est volontairement plus modeste que la vision complète :

> Modifier une base Rails, fermer entièrement le navigateur, retrouver les
> données hors ligne, exporter le volume, puis le restaurer depuis une autre
> origine.

Le chiffrement, la récupération de clés et la collaboration ne seront construits
qu'après avoir démontré cette propriété de persistance et de portabilité.

## Principes

- **Local par défaut** : l'application et ses données fonctionnent sans serveur
  applicatif.
- **Données possédées par l'utilisateur** : le stockage primaire est local et
  aucun relais ne doit pouvoir lire son contenu.
- **Sortie toujours possible** : un export documenté et restaurable est une
  fonction fondamentale, pas une option de secours.
- **Logiciel reproductible** : un volume identifie la version du runtime et de
  l'application nécessaires pour le rouvrir.
- **Aucun compte central obligatoire** : un service distant peut simplifier la
  distribution ou l'échange, jamais devenir l'autorité sur les données.
- **Rails réel autant que possible** : RailsBox Vault cherche à exécuter
  l'application Rails et ses dépendances, pas à en produire une approximation.

## Relation avec RailsBox Live

[RailsBox Live](https://github.com/pinfada/railsbox) transforme une application
Rails en démonstration publique, isolée et jetable. RailsBox Vault est un projet
séparé parce qu'un logiciel durable contenant des données privées exige un autre
contrat produit, un autre modèle de menace et un autre cycle de publication.

Les deux projets pourront partager ultérieurement des composants dont la
frontière aura été éprouvée. Aucun paquet commun n'est extrait prématurément.

## Documentation

- [Vision](docs/vision.md)
- [Architecture exploratoire](docs/architecture.md)
- [Modèle de menace](SECURITY.md)
- [ADR 0001 — un produit et un dépôt séparés](docs/decisions/0001-produit-et-depot-separes.md)

## Licence

RailsBox Vault est distribué sous licence MIT. Voir [LICENSE](LICENSE).
