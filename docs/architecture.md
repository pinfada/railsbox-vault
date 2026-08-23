# Architecture exploratoire

Cette architecture organise les questions à prouver ; elle ne fige pas encore
une implémentation.

```text
Publication statique
├── coquille de confiance
├── runtime RailsBox Vault versionné
└── application Rails versionnée
            │
            ▼
Navigateur / Worker dédié
├── VM Linux + Ruby + Rails
├── contrôleur de stockage
└── clé de volume en mémoire volatile
            │
            ▼
Stockage local
├── volume transactionnel
├── métadonnées authentifiées
└── points de récupération
            │
            ├── export portable
            └── relais E2EE optionnel
```

## Frontières

### Runtime générique

Le runtime prend en charge l'exécution, la persistance, le verrouillage,
l'export, la restauration et l'identité des artefacts. Il ne connaît pas les
concepts métier de l'application.

### Application Rails

L'application définit son schéma, ses migrations, ses identifiants et ses règles
de fusion. Une future bibliothèque Rails pourra proposer des primitives de
réplication, sans les rendre obligatoires.

### Services optionnels

Un hébergement statique distribue les artefacts. Un relais peut transporter des
paquets chiffrés. Aucun de ces services ne doit être requis pour ouvrir un
volume déjà installé, ni disposer des clés permettant de lire les données.

## Ordre des preuves

1. Persistance locale non chiffrée avec redémarrage complet de la VM.
2. Export et restauration depuis une autre origine.
3. Résistance aux arrêts brutaux et cohérence de la base.
4. Format de volume authentifié et transactionnel.
5. Déverrouillage, récupération et rotation des clés.
6. Séparation de l'origine de confiance et de l'application.
7. Échanges chiffrés optionnels entre utilisateurs.

La restauration d'un instantané mémoire pré-calculé sur un disque mutable est
écartée du premier prototype. Le boot à froid constitue la référence de
cohérence jusqu'à ce qu'un snapshot puisse être lié à une génération exacte et
proprement arrêtée du volume.
