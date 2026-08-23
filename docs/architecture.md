# Architecture exploratoire

Cette architecture organise les questions à prouver ; elle ne fige pas encore une implémentation.

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

### Contexte

```text
Éditeur ──publie──► Hébergement statique non fiable pour les données
                         │ artefacts versionnés et vérifiables
                         ▼
Utilisateur ──geste──► Coquille de confiance ──capacité minimale──► Runtime Worker
                              │                                  │
                              │ aucun secret applicatif          ├── VM Rails
                              │                                  └── volume OPFS
                              ▼
                       export utilisateur ──► autre origine/appareil
```

Le JavaScript rendu par l'application Rails est une entrée hostile potentielle. Il ne partage pas
automatiquement l'autorité de la coquille. La topologie exacte est le résultat attendu du spike #35
; aucune interface durable de ports ne sera figée avant cette décision.

### Runtime générique

Le runtime prend en charge l'exécution, la persistance, le verrouillage, l'export, la restauration
et l'identité des artefacts. Il ne connaît pas les concepts métier de l'application.

Son interface de stockage devra exposer au minimum :

- `read(offset, length)` avec lecture exacte ou erreur typée ;
- `write(offset, bytes)` avec détection des écritures partielles ;
- `flush()` dont l'acquittement signifie durabilité au niveau OPFS ;
- `size()` et géométrie immuable pendant une session ;
- fermeture exclusive et transfert explicite de propriété ;
- injection déterministe d'erreurs pour les tests de résilience.

Les callbacks précis dépendront du spike v86 #4. Le contrat ci-dessus est le comportement exigé, pas
une supposition sur l'API actuelle de v86.

### Application Rails

L'application définit son schéma, ses migrations, ses identifiants et ses règles de fusion. Une
future bibliothèque Rails pourra proposer des primitives de réplication, sans les rendre
obligatoires.

L'application ne reçoit ni clé brute ni accès OPFS. Elle observe un disque IDE ordinaire et les
erreurs que le guest sait représenter. Ses migrations métier restent distinctes des migrations du
format Vault.

### Services optionnels

Un hébergement statique distribue les artefacts. Un relais peut transporter des paquets chiffrés.
Aucun de ces services ne doit être requis pour ouvrir un volume déjà installé, ni disposer des clés
permettant de lire les données.

## Cycle de vie de référence

1. La coquille vérifie identités et compatibilité avant de demander une clé.
2. Elle acquiert l'exclusivité du volume et un canal privé vers le Worker.
3. Le Worker ouvre le backend, puis seulement la VM.
4. Le guest lit et écrit ; un flush traverse toutes les couches avant son acquittement.
5. Export et migration créent une génération cohérente distincte.
6. Verrouillage arrête les nouvelles E/S, termine proprement si possible, ferme le handle exclusif
   et relâche les clés au mieux de JavaScript.
7. La reprise part d'un boot à froid tant qu'un snapshot lié à une génération exacte n'est pas
   démontré.

## Erreurs contractuelles

Quota, handle perdu, authentification invalide, format incompatible, écriture partielle et échec de
flush sont des états distincts. Aucune couche ne les convertit en succès, en bloc zéro ou en
réinitialisation silencieuse. Les codes stables seront définis avec le premier backend #6.

## Ordre des preuves

1. Persistance locale non chiffrée avec redémarrage complet de la VM.
2. Export et restauration depuis une autre origine.
3. Résistance aux arrêts brutaux et cohérence de la base.
4. Format de volume authentifié et transactionnel.
5. Déverrouillage, récupération et rotation des clés.
6. Implémentation complète de la séparation d'origine décidée dès la fondation.
7. Échanges chiffrés optionnels entre utilisateurs.

La restauration d'un instantané mémoire pré-calculé sur un disque mutable est écartée du premier
prototype. Le boot à froid constitue la référence de cohérence jusqu'à ce qu'un snapshot puisse être
lié à une génération exacte et proprement arrêtée du volume.

## Provenance et partage avec RailsBox Live

Tout code importé conserve sa licence et référence le commit source. Les correctifs communs sont
reportés explicitement tant qu'aucune interface stable n'a justifié une bibliothèque partagée. Une
copie silencieuse de `libv86.js` ou d'un artefact Live n'est pas une dépendance reproductible.
