# Architecture exploratoire

Cette architecture organise les questions à prouver ; elle ne fige pas encore une implémentation.

```text
Publication statique — DEUX origines (ADR 0002)
├── origine de confiance : coquille + runtime RailsBox Vault versionné
└── origine applicative  : documents et assets de l'application Rails versionnée
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
                              │ MessagePort restreint            ├── VM Rails
                              │ (aucun secret applicatif)        └── volume OPFS
                              ▼
              ORIGINE APPLICATIVE distincte : document Rails, son stockage,
              son Service Worker — aucun canal implicite vers la coquille
                              │
                              ▼
                       export utilisateur ──► autre origine/appareil
```

Le JavaScript rendu par l'application Rails est une entrée hostile potentielle. Il ne partage pas
l'autorité de la coquille, et depuis l'[ADR 0002](decisions/0002-topologie-origine-de-confiance.md)
il ne partage pas non plus son **origine** : le document applicatif vit sur une origine distincte,
encadré par `sandbox="allow-scripts allow-same-origin"`. La partition d'origine sépare OPFS,
IndexedDB, Web Locks, `BroadcastChannel`, stockage clé-valeur, cookies et portée des Service
Workers. La coquille n'accorde qu'un `MessagePort` transféré, restreint à une liste d'admission.

Les formes exactes de ces ports restent ouvertes : l'ADR 0002 énumère les interfaces à ne pas figer
avant l'implémentation complète #24.

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

Son document vit sur l'origine applicative. Elle y dispose pleinement de son propre stockage —
cookies de session, IndexedDB, cache, Service Worker hors ligne — et de rien d'autre. Une
conséquence reste à trancher : sur une origine applicative partagée, deux applications se lisent
mutuellement. Origine par application ou partitionnement explicite est un travail découvert du spike
#35.

### Services optionnels

Un hébergement statique distribue les artefacts. Un relais peut transporter des paquets chiffrés.
Aucun de ces services ne doit être requis pour ouvrir un volume déjà installé, ni disposer des clés
permettant de lire les données.

L'hébergement doit fournir **deux** origines. GitHub Pages n'en sert qu'une par compte, les sites de
projet en étant des chemins ; les options mesurées — domaine propre avec sous-domaine, second
compte, ou hébergeur distinct pour une origine — sont comparées dans l'ADR 0002 et le choix
appartient à la publication #45. Un changement d'origine rend l'OPFS de l'ancienne inatteignable :
il se traite comme une migration exigeant un export préalable, pas comme un détail de déploiement.

## Cycle de vie de référence

1. La coquille vérifie identités et compatibilité avant de demander une clé.
2. Elle acquiert l'exclusivité du volume et un canal privé vers le Worker, **avant qu'aucun document
   applicatif n'existe** : un canal établi après coup serait à portée du code applicatif.
3. Le Worker ouvre le backend, puis seulement la VM.
4. La coquille encadre alors le document applicatif sur l'origine distincte et lui transfère un
   `MessagePort` restreint, après vérification du type, de l'origine et de la fenêtre émettrice de
   son annonce.
5. Le guest lit et écrit ; un flush traverse toutes les couches avant son acquittement.
6. Export et migration créent une génération cohérente distincte.
7. Verrouillage arrête les nouvelles E/S, termine proprement si possible, ferme le handle exclusif
   et relâche les clés au mieux de JavaScript.
8. La reprise part d'un boot à froid tant qu'un snapshot lié à une génération exacte n'est pas
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
6. Implémentation complète (#24) de la séparation d'origine décidée par l'ADR 0002 ; sa preuve de
   frontière existe déjà (`tests/browser/origin-topology.spec.mjs`) et devra être rejouée sur les
   ports réels.
7. Échanges chiffrés optionnels entre utilisateurs.

La restauration d'un instantané mémoire pré-calculé sur un disque mutable est écartée du premier
prototype. Le boot à froid constitue la référence de cohérence jusqu'à ce qu'un snapshot puisse être
lié à une génération exacte et proprement arrêtée du volume.

## Provenance et partage avec RailsBox Live

Tout code importé conserve sa licence et référence le commit source. Les correctifs communs sont
reportés explicitement tant qu'aucune interface stable n'a justifié une bibliothèque partagée. Une
copie silencieuse de `libv86.js` ou d'un artefact Live n'est pas une dépendance reproductible.

### Ce qui vient de Live, et à quel titre

| Élément de Vault                                         | Rapport à Live                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/build-reference-image/guest/serial-bridge.py`     | **inspiré, réimplémenté.** Le principe de trame, le découpage base64 acquitté et le verrou d'écriture unique viennent de `tools/build-v86-image/base/rib/serial-bridge.py` (MIT, commit `a36baf0bcbdec65ca3749ba1fb6d7b94e4abd594`). Ni horloge, ni environnement, ni redémarrage à chaud : le préfixe de trame est `@VLT1` et non `@RIB1`, pour que les deux protocoles ne puissent pas être confondus. |
| `SHELL ["linux32", …]` dans `guest.Dockerfile`           | **constat repris**, même commit : sans `personality(PER_LINUX32)`, Ruby se compile sous un triplet `x86_64-linux-x32` qui n'existe pas.                                                                                                                                                                                                                                                                  |
| `NOKOGIRI_USE_SYSTEM_LIBRARIES=true`                     | **constat repris**, même commit : la compilation du libxml2 embarqué échoue sous i386.                                                                                                                                                                                                                                                                                                                   |
| Boot direct bzImage + initrd, disque applicatif en `hdb` | **même mode de démarrage**, redécidé pour Vault et documenté dans `sources.json` (`guest.cmdline`).                                                                                                                                                                                                                                                                                                      |
| `seabios.bin`, `vgabios.bin`                             | **téléchargés**, jamais copiés depuis Live : URL, commit et empreinte SHA-256 dans `tools/build-reference-image/sources.json`, licences dans le manifeste.                                                                                                                                                                                                                                               |
| `libv86`                                                 | **dépendance npm** `v86`, verrouillée dans `package-lock.json`. Aucun fichier n'est recopié dans le dépôt.                                                                                                                                                                                                                                                                                               |

Aucun octet de rootfs, d'instantané ou d'artefact publié par Live n'entre dans Vault.
