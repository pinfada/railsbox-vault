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

Son interface de stockage expose au minimum :

- `read(offset, length)` avec lecture exacte ou erreur typée ;
- `write(offset, bytes)` avec détection des écritures partielles ;
- `flush()` dont l'acquittement signifie durabilité au niveau OPFS ;
- `size()` et géométrie immuable pendant une session ;
- fermeture exclusive et transfert explicite de propriété ;
- injection déterministe d'erreurs pour les tests de résilience.

Le spike #4 a confirmé ce contrat et l'a éprouvé contre un vrai guest Linux
([ADR 0003](decisions/0003-backend-de-blocs-v86.md)). Trois ajustements en découlent.

Le backend de production #6 (`src/vm/opfs-block-backend.mjs`) l'implémente au-dessus d'un
`FileSystemSyncAccessHandle`. Quatre précisions que seule une implémentation réelle pouvait apporter
:

- **le support est injecté.** Le backend reçoit un ouvreur de handle, pas OPFS. En production c'est
  `src/vm/opfs-sync-access.mjs` ; sous Node c'est `src/vm/sync-access-double.mjs`, un double
  calibré. Sans cette couture, quota, handle perdu et écriture partielle ne seraient jamais exercés
  — ou le seraient par un `throw` posé dans le code même que le test prétend vérifier ;
- **le handle exclusif ne quitte jamais le Worker dédié.** `openOpfsSyncAccess` refuse tout autre
  contexte avec `VAULT_STORAGE_UNSUPPORTED`, et le backend range le sien dans un champ privé de
  classe. Ni la coquille, ni l'adaptateur v86, ni donc la VM n'ont de chemin vers OPFS ;
- **la géométrie est celle de la session, pas celle du fichier.** Elle est fixée à l'ouverture —
  déclarée pour un volume neuf, RELUE du fichier à la réouverture — et revérifiée avant chaque E/S.
  Un fichier qui change de taille sous un volume ouvert est un `VAULT_STORAGE_GEOMETRY_MISMATCH`,
  jamais une nouvelle valeur de `size()` ;
- **l'alignement du contrat v86 est vérifié, pas supposé.** Les tampons asynchrones de v86 adressent
  par blocs de 256 octets ; la géométrie exigée est un multiple de 512, donc aussi de 256. Les accès
  eux-mêmes ne sont pas contraints : OPFS adresse à l'octet, et le backend relit exactement une
  écriture non alignée. Le spike #4 a mesuré que le guest n'en émet de toute façon jamais.

**Le contrat de Vault n'est pas celui de v86.** L'émulateur attend un tampon à callbacks —
`byteLength`, `load()`, `get(offset, length, fn, { signal })`, `set(offset, bytes, fn)` — accepté
tel quel dès qu'un objet porte `get`, `set` et `load`. Un adaptateur traduit ; le contrat ci-dessus
reste celui du runtime.

**`get` et `set` n'ont aucun canal d'erreur.** Le périphérique IDE émulé ne sait pas représenter un
échec de support : ses callbacks ne prennent qu'un succès. Un backend en panne a donc trois
conduites possibles, et deux sont interdites — rendre des zéros, ou acquitter quand même. La
troisième est retenue : **ne pas acquitter, remonter l'erreur typée au runtime, arrêter la VM**. Le
guest observe alors une erreur d'E/S après son délai de garde ATA ; l'exploitant, une erreur nommée.

**La barrière de durabilité n'existe pas en amont.** Elle est ajoutée par un pont qui traduit ATA
FLUSH CACHE en `flush()`. Sans lui, `SEC-DURABLE-001` est inatteignable, non par négligence du
backend mais parce que le guest n'émet jamais la barrière. Le détail est dans l'ADR 0003.

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
réinitialisation silencieuse. Les codes sont figés par le backend #6 dans
`src/vm/storage-errors.mjs` :

| Code                              | État                                                           | Origine |
| --------------------------------- | -------------------------------------------------------------- | ------- |
| `VAULT_STORAGE_OUT_OF_RANGE`      | accès hors de la géométrie déclarée                            | #4      |
| `VAULT_STORAGE_SHORT_READ`        | le support a rendu moins d'octets que demandé                  | #4      |
| `VAULT_STORAGE_PARTIAL_WRITE`     | le support a accepté moins d'octets que demandé                | #4      |
| `VAULT_STORAGE_FLUSH_FAILED`      | la barrière de durabilité n'a pas abouti                       | #4      |
| `VAULT_STORAGE_HANDLE_LOST`       | le handle exclusif a disparu sous le volume ouvert             | #4      |
| `VAULT_STORAGE_CLOSED`            | E/S demandée après fermeture du volume                         | #4      |
| `VAULT_STORAGE_BUSY`              | un autre détenteur possède déjà l'exclusivité                  | #4      |
| `VAULT_STORAGE_UNSUPPORTED`       | capacité absente : jamais remplacée par un repli               | #4      |
| `VAULT_STORAGE_QUOTA_EXCEEDED`    | le quota de stockage de l'origine est épuisé                   | **#6**  |
| `VAULT_STORAGE_GEOMETRY_MISMATCH` | la géométrie du support diffère de celle de la session         | **#6**  |
| `VAULT_STORAGE_SUPPORT_FAILURE`   | échec du support non classable : jamais deviné, toujours nommé | **#6**  |

Les trois derniers naissent de l'implémentation OPFS. Le quota **n'est pas** une écriture partielle
— l'un se corrige en libérant de la place, l'autre décrit un état intermédiaire du volume. La
géométrie **n'est pas** un accès hors bornes — elle dit que le support a changé, pas que l'appelant
s'est trompé. Et un `DOMException` de nom inconnu **n'est pas** rangé dans l'état le plus proche :
`src/vm/opfs-error-mapping.mjs` traduit les noms qu'il connaît et nomme les autres
`VAULT_STORAGE_SUPPORT_FAILURE`, parce que deviner un diagnostic serait l'inventer.

Ce que le guest en perçoit est mesuré et n'est pas symétrique : une faute transitoire est absorbée
par les tentatives du noyau, une faute persistante devient une erreur d'E/S, une panne de support
bloque le périphérique. Le tableau figure dans
[`docs/spikes/0004-backend-de-blocs-v86.md`](spikes/0004-backend-de-blocs-v86.md).

## Budget de stockage : quota, persistance, espace insuffisant

L'issue #9 ajoute au-dessus des erreurs contractuelles une couche de **budget** qui ne touche ni
OPFS ni le handle exclusif (#8) : elle estime l'espace, demande la persistance quand elle existe, et
transforme quatre situations en **diagnostics stables**. Un diagnostic porte toujours un **code
stable**, l'**opération** concernée et une **action de récupération sûre**, sans jamais exposer le
contenu de l'utilisateur. Le code vit dans `src/vm/storage-budget.mjs` ; son rendu accessible (rôle
ARIA + texte) dans `src/vm/storage-budget-messages.mjs`.

Cette couche **détecte et diagnostique** ; elle ne tranche aucune politique produit. La conduite à
tenir sur un refus de persistance est décidée par #42 (voir « Conduite sur refus de persistance »
ci-dessous et l'[ADR 0006](decisions/0006-conduite-refus-persistance.md)), qui se pose au-dessus de
ce diagnostic sans le modifier.

| Code                                | Situation                                                             |
| ----------------------------------- | --------------------------------------------------------------------- |
| `VAULT_BUDGET_PERSIST_DENIED`       | `persist()` refusé : poursuite volatile ou arrêt, jamais durable      |
| `VAULT_BUDGET_PERSIST_UNSUPPORTED`  | `persist()`/`persisted()` absents : aucune durabilité inventée        |
| `VAULT_BUDGET_ESTIMATE_UNAVAILABLE` | `estimate()` indisponible : état `unknown`, jamais zéro capacité      |
| `VAULT_BUDGET_SPACE_LOW`            | espace estimé < besoin, mesuré **avant** toute mutation               |
| `VAULT_BUDGET_QUOTA_EXCEEDED`       | quota dépassé pendant write/flush : volume préservé, non réinitialisé |

Quatre invariants gouvernent ces états :

- **un refus de `navigator.storage.persist()` n'est ni une erreur ni une promesse de durabilité.**
  Comme #2 l'a mesuré, `persist()` est refusé sans geste utilisateur (verdict `denied`, pas
  `error`). Le diagnostic qualifie une poursuite explicitement volatile ou un arrêt ; il ne rend
  jamais `durable` vrai sur un refus ;
- **l'espace insuffisant est avertí AVANT la mutation.** `reserve(besoin)` compare le besoin à
  l'espace estimé disponible et rend un avertissement `VAULT_BUDGET_SPACE_LOW` avant qu'aucune
  écriture ne soit tentée ;
- **le quota dépassé pendant l'écriture préserve le volume.** #6 le remonte déjà comme
  `StorageError` typée sans réinitialiser le volume ; `classifyWriteFailure` le requalifie en
  diagnostic de budget en préservant l'état — `volumeReset: false`, `priorDataReadable: true` — et
  ne réétiquette jamais les autres états typés de #6, qui ne lui appartiennent pas ;
- **une estimation indisponible est l'état `unknown`, pas une capacité nulle.** Traiter l'inconnu
  comme zéro bloquerait à tort une coquille saine ; `reserve` rend alors un verdict indéterminé
  (`sufficient: null`), jamais insuffisant.

**Aucune récupération ne supprime de données.** Les actions publiées (`RECOVERY_ACTIONS`) informent,
proposent un export ou invitent l'utilisateur à libérer de l'espace lui-même, puis laissent la
couche supérieure décider. Un test de contrat exige qu'aucun texte d'action ne propose d'effacer, de
purger ou de réinitialiser. Le nettoyage automatique et l'achat de stockage sont hors périmètre.

## Conduite sur refus de persistance

L'issue #42 se pose **au-dessus** du diagnostic de #9 : #9 qualifie un verdict de `persist()` ; #42
décide de la **conduite produit**. Le code vit dans `src/vm/persistence-conduct.mjs` ; son rendu
accessible dans `src/vm/persistence-conduct-messages.mjs`. Il **réutilise** la couche de budget de
#9 (import, pas copie) et ne la modifie pas. La décision complète est
l'[ADR 0006](decisions/0006-conduite-refus-persistance.md).

À partir d'un verdict de persistance et du contexte (geste utilisateur, choix), la conduite produit
un **état de coquille** explicite et une **promesse de durabilité à trois valeurs** — jamais un
booléen, jamais une promesse fausse :

| Verdict de persistance                 | État de coquille               | Promesse de durabilité |
| -------------------------------------- | ------------------------------ | ---------------------- |
| aucune demande, aucun geste            | `CONSENTEMENT_REQUIS`          | `INCONNUE`             |
| `granted` / `already`                  | `DURABLE_GARANTI`              | `GARANTIE`             |
| `pending` (Firefox, invite en attente) | `ATTENTE_RESOLUTION`           | `INCONNUE`             |
| `denied` / `unsupported` + poursuite   | `POURSUITE_VOLATILE_QUALIFIEE` | `NON_GARANTIE`         |
| `denied` / `unsupported` + arrêt       | `ARRET`                        | `NON_GARANTIE`         |

Trois règles la gouvernent :

- **la persistance n'est demandée que derrière un geste utilisateur explicite**, jamais au
  chargement — #2 a mesuré qu'une demande sans geste est refusée d'office, et l'ADR 0002 confie le
  consentement à la coquille. `shouldRequestPersistence` l'énonce : au chargement, on lit
  `persisted()` sans geste, et l'on attend un geste avant d'appeler `persist()` ;
- **une durabilité `GARANTIE` n'existe que derrière une persistance réellement accordée**
  (`granted`/`already`). C'est la traduction produit de `SEC-DURABLE-001`, éprouvée sur toutes les
  combinaisons de verdict × geste × choix ;
- **une attente pendante est traitée comme non accordée**, donc jamais durable. Elle halte la
  décision (`ATTENTE_RESOLUTION`) au lieu de trancher à la place du navigateur, puis la conduite est
  réévaluée avec le verdict résolu.

## Contrat de barrière de durabilité

L'issue #14 ferme la barrière de bout en bout que #6 avait laissée ouverte : #6 avait prouvé que la
barrière ATTEINT le support ; #14 prouve qu'**aucune écriture n'est annoncée durable au guest avant
que le flush OPFS ait réellement rendu la main**. C'est l'invariant `SEC-DURABLE-001`.

La barrière traverse une chaîne fixe, sans court-circuit :

```text
guest FLUSH CACHE (0xE7/0xEA)
  → pont v86 (v86-flush-bridge) : pose BSY, appelle adapter.flush(ack, échec)
    → adaptateur (v86-buffer-adapter) : appelle backend.flush()
      → backend OPFS (opfs-block-backend) : journalise `flush`, ATTEND
         FileSystemSyncAccessHandle.flush(), puis journalise `flush-ack`
      ← acquittement RÉEL du support
    ← ack() → le pont lève BSY (DRDY|DSC) et pousse l'IRQ
  ← le guest reprend
```

Les propriétés garanties, chacune reliée à un test :

- **Ordre causal strict.** Dans le journal, toute écriture précède la barrière, et l'acquittement
  suit la barrière : `write* → flush → flush-ack`. Le backend **attend** le flush du support avant
  d'enregistrer `flush-ack` ; l'acquittement du guest ne peut donc pas devancer la durabilité. La
  trace corrèle commande guest (`ata`), appel backend (`flush`) et résultat (`flush-ack`) **sans
  aucune donnée utilisateur** — le journal ne porte que des offsets, des longueurs et des numéros de
  barrière.
- **Flush retardé, aucun succès anticipé.** Tant que `flush()` n'a pas rendu la main, le guest reste
  occupé (BSY). C'est la conséquence directe de l'attente ci-dessus, éprouvée par un double de
  stockage dont on **contrôle la latence** de la barrière.
- **Échec ou fermeture pendant le flush.** La commande ATA est **abandonnée** (`ABRT`, `DRDY|ERR`) :
  le guest reçoit une erreur d'E/S plutôt qu'un délai de garde muet, la coquille reçoit une erreur
  typée, et **aucun état durable n'est inventé** — ni `flush-ack`, ni bloc de zéros, ni succès
  silencieux. Le code remonté distingue les états : `VAULT_STORAGE_QUOTA_EXCEEDED` et
  `VAULT_STORAGE_HANDLE_LOST` sont **préservés** tels quels, tout autre échec du support devient
  `VAULT_STORAGE_FLUSH_FAILED`. Les fondre en un seul code effacerait des remèdes distincts —
  libérer de la place, rouvrir le volume, réessayer.
- **Deux barrières consécutives sans écriture** sont sûres et mesurables : chacune franchit le
  support et s'acquitte, sans erreur.

Ces propriétés sont prouvées à deux niveaux. Le niveau unitaire
(`tests/unit/vm-durability-barrier.test.mjs`) assemble la chaîne complète moins l'émulateur — pont,
adaptateur, backend OPFS, double déterministe — et contrôle ordre, latence et fautes ; son témoin de
barrière retardée échoue si le backend acquitte avant la résolution du flush. Le niveau intégration
VM (`tests/vm/opfs-barrier.spec.mjs`) rejoue le tout avec un vrai guest Linux et le vrai OPFS. La
persistance RPO 0 après une barrière acquittée — relecture des octets après réouverture du handle —
reste prouvée par `tests/vm/opfs-persistence.spec.mjs`.

Ce que #14 ne couvre pas : l'atomicité d'une génération complète et la récupération (#16), le
regroupement ou l'optimisation des flush, le chiffrement, la reprise Rails complète (#7) et l'accès
concurrent (#8), désormais traité ci-dessous.

## Concurrence et bail d'écriture

L'issue #8 (`VAULT-PERSIST-002`) tient le budget multi-onglets de `docs/quality-attributes.md` :
**un volume possède au plus un écrivain**, et un second contexte obtient en 5 s au plus soit un
relais sûr après fermeture effective, soit un refus explicite — jamais un accès concurrent
implicite.

Le handle OPFS de #6 est déjà exclusif par moteur, mais s'appuyer sur cette seule coïncidence serait
fragile — le même raisonnement que l'ADR 0002 tient pour l'ouverture du handle. #8 construit donc un
**bail explicite** : une machine à états pure (`src/vm/write-lease.mjs`) porte l'invariant, et un
transport mince (`src/vm/write-lease-transport.mjs`) l'alimente depuis Web Locks et le handle OPFS
de l'origine coquille — les deux canaux de coordination autorisés par l'ADR 0002.

### Machine à états du bail

Six états, du point de vue d'un contexte (un onglet, un Worker) :

| État      | Signification                                                        | Statut d'UI     |
| --------- | -------------------------------------------------------------------- | --------------- |
| `libre`   | ni détenu ni demandé : le contexte n'écrit pas                       | `lecture-seule` |
| `attente` | bail demandé ; un autre le détient, on patiente dans la file         | `attente`       |
| `detenu`  | ce contexte détient le bail ET le handle exclusif : c'est l'écrivain | `ecriture`      |
| `relais`  | le détenteur rend la main ; le handle se ferme avant tout octroi     | `lecture-seule` |
| `refus`   | demande refusée (délai dépassé ou refus explicite)                   | `conflit`       |
| `perdu`   | bail détenu puis perdu sans fermeture propre (mort du support)       | `erreur`        |

Le statut d'UI est un **état explicite**, jamais un booléen « peut écrire » : un onglet en attente,
en conflit ou en erreur ne se distinguerait pas d'un onglet en lecture seule sous un simple drapeau,
et l'utilisateur ne saurait pas s'il doit patienter, réessayer ou s'inquiéter.

Les transitions autorisées forment le contrat — toute paire absente lève `VAULT_LEASE_TRANSITION`,
jamais un glissement silencieux :

```text
libre    ──request──► attente
attente  ──grant────► detenu     (verrou obtenu ET handle ouvert)
attente  ──deny─────► refus      (refus explicite d'un autre détenteur)
attente  ──expire───► refus      (échéance de relais-ou-refus atteinte)
attente  ──abandon──► libre      (renoncement du contexte)
detenu   ──release──► relais     (début de fermeture du handle)
relais   ──settle───► libre      (handle effectivement fermé, verrou rendu)
detenu   ──lose─────► perdu      (support ou contexte disparu)
refus|perdu ──reset──► libre  ·  refus|perdu ──retry──► attente
```

La machine est **pure et immuable** : chaque transition rend une nouvelle instance, l'horloge est
injectée (échéances contrôlables au test, réelles en production), et l'invariant « au plus un
écrivain » est vérifiable par `assertAtMostOneWriter`. Elle ne connaît ni Web Locks, ni OPFS, ni
`BroadcastChannel`.

### Transport et règles de relais

Le transport tient le verrou Web Locks pendant qu'il détient le handle OPFS, et **ferme le handle
AVANT de rendre le verrou**. Web Locks n'exécute la requête suivante qu'après la résolution de la
requête courante : le second contexte n'ouvre donc son handle qu'après la fermeture effective du
premier. Le relais est sûr par construction, et non parce qu'un événement l'a annoncé.

La récupération après **crash** ne suppose aucun événement de fermeture fiable. Elle repose sur deux
faits mesurés :

- Web Locks relâche un verrou à la **mort du contexte** (onglet fermé, Worker terminé) ;
- un handle OPFS survivant à un contexte mort peut mettre un instant à être réclamé : l'ouverture
  est donc **réessayée** sur `VAULT_STORAGE_BUSY` tant que le budget de 5 s dure — un bail à
  expiration vérifiée par tentative de réacquisition du handle, plutôt qu'une confiance aveugle en
  un signal.

Un **onglet suspendu** n'est pas un onglet mort : son verrou n'est pas relâché, le waiter reste en
`attente` et ne devient jamais un second écrivain. Un **volume différent** est un verrou différent
et un fichier différent : aucune contention artificielle. Une **origine différente** est
partitionnée par le navigateur (ADR 0002, `SEC-ORIGIN-001`) : ses verrous et son OPFS sont
invisibles à la coquille, donc sans contention non plus.

### Erreur de transition

Le bail ajoute une erreur typée, distincte des états de stockage de #6 :

| Code                     | État                                                  | Origine |
| ------------------------ | ----------------------------------------------------- | ------- |
| `VAULT_LEASE_TRANSITION` | transition de bail interdite ou expiration prématurée | **#8**  |

Elle porte l'état source et l'événement refusé. Un refus de délai côté transport reste, lui, un état
de bail (`refus`), pas une exception : le contexte l'affiche en `conflit` et peut réessayer.

## Manifeste de volume et compatibilité

L'issue #10 (`VAULT-PORT-001`, `VAULT-COMPAT-001`) donne une représentation aux trois identités
indépendantes de `docs/release-policy.md`. Le **manifeste versionné** (`src/vm/volume-manifest.mjs`)
est le document qui lie, pour un volume donné, la version entière du **format**, la version SemVer
du **runtime**, l'identité immuable et la version de l'**application**, et la **géométrie** immuable
de #6. C'est le socle de l'export (#11) et de la restauration inter-origine (#12). C'est un contrat
de format persistant, figé par l'[ADR 0007](decisions/0007-manifeste-de-volume.md).

Le module est **pur et déterministe** : il ne lit ni OPFS, ni le temps, ni le réseau. Sa
sérialisation est canonique — clés triées récursivement — pour qu'un même manifeste rende toujours
les mêmes octets, condition d'une empreinte reproductible. `parseManifest` valide le cœur v1 ou lève
`VAULT_MANIFEST_MALFORMED` : jamais un objet à moitié valide. Il tolère les champs futurs
surnuméraires (compatibilité ascendante) mais exige le préambule figé `magic` + `formatVersion`.

La règle de compatibilité distingue **lecture seule tolérée** et **écriture refusée**, sur deux axes
indépendants :

| Situation                                               | Lecture | Écriture | Code de refus                       |
| ------------------------------------------------------- | :-----: | :------: | ----------------------------------- |
| format plus récent que le format courant du runtime     | refusée | refusée  | `VAULT_MANIFEST_FORMAT_TOO_NEW`     |
| format sous le plus ancien format lisible               | refusée | refusée  | `VAULT_MANIFEST_FORMAT_TOO_OLD`     |
| application (`app.id`) différente                       | refusée | refusée  | `VAULT_MANIFEST_IDENTITY_MISMATCH`  |
| format lisible mais antérieur au format courant         | tolérée | refusée  | `VAULT_MANIFEST_MIGRATION_REQUIRED` |
| runtime majeur du volume > runtime en cours (downgrade) | tolérée | refusée  | `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  |

Le **format futur** est refusé en lecture comme en écriture : sa disposition n'est pas interprétable
en confiance. Le **downgrade dangereux** — un volume écrit par un runtime de version majeure
supérieure — est refusé en écriture seule ; la lecture reste tolérée pour le diagnostic et l'export
(#11). Seule `app.id` doit correspondre : la version de l'application peut différer, ses migrations
métier restant distinctes de celles du format Vault.

**Vérification avant écriture (`SEC-UPDATE-001`).**
`assertVolumeWritable({ manifestBytes, expectations })` est le chemin d'ouverture en écriture : un
volume sans manifeste identifiable est refusé par `VAULT_MANIFEST_UNIDENTIFIED` — jamais d'écriture
sur un support non identifié — et un manifeste incompatible propage son refus typé. Identité et
version sont donc exigées et vérifiées **avant** que l'écriture soit autorisée, conformément au
cycle de vie de référence (« la coquille vérifie identités et compatibilité avant de demander une
clé »).

Les erreurs du manifeste forment une famille **distincte** des états de stockage de #6 et du bail de
#8, avec la même forme transportable (`code`, message français, contexte, `toJSON`) :

| Code                                | État                                                           | Origine |
| ----------------------------------- | -------------------------------------------------------------- | ------- |
| `VAULT_MANIFEST_MALFORMED`          | l'entrée n'est pas structurellement un manifeste v1            | **#10** |
| `VAULT_MANIFEST_FORMAT_TOO_NEW`     | format plus récent que ce runtime : refusé en lecture/écriture | **#10** |
| `VAULT_MANIFEST_FORMAT_TOO_OLD`     | format sous le plancher lisible de ce runtime                  | **#10** |
| `VAULT_MANIFEST_MIGRATION_REQUIRED` | format antérieur : écriture refusée jusqu'à migration (#13)    | **#10** |
| `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  | volume écrit par un runtime majeur plus récent : downgrade     | **#10** |
| `VAULT_MANIFEST_IDENTITY_MISMATCH`  | l'application en cours ne possède pas ce volume                | **#10** |
| `VAULT_MANIFEST_UNIDENTIFIED`       | ouverture en écriture d'un volume sans manifeste connu         | **#10** |

Ce que le manifeste v1 **ne** couvre pas, et qu'il ne faut pas en déduire : l'empreinte du
**contenu** du volume et l'export portable (#11) — `identity.digest` existe et est validé
structurellement mais n'est ni calculé ni confronté au contenu —, la restauration inter-origine
(#12), le détail des migrations et le copy-on-write (#13), et l'authentification ou le chiffrement
du manifeste lui-même.

## Export portable et vérifiable

L'issue #11 (`VAULT-PORT-001`) transforme le manifeste de #10, jusqu'ici sans empreinte de contenu,
en un **export portable, complet et vérifiable** d'un point cohérent du volume. Le code vit dans
`src/vm/volume-export.mjs` ; le format est figé par
l'[ADR 0008](decisions/0008-format-d-archive-d-export.md).

Une **archive** lie, en un conteneur binaire, le manifeste v1 de #10 — avec son `identity.digest`
désormais **renseigné** — au contenu intégral du volume et à son empreinte SHA-256. Sa disposition,
append-only donc streamable :

```text
[ marqueur 8 o ][ longueur d'en-tête uint32 BE 4 o ][ en-tête JSON H o ][ contenu N o ]
```

Le marqueur `RBVAULT1` reconnaît une archive avant toute interprétation ; l'en-tête JSON porte le
manifeste (digest renseigné) et un descripteur de contenu (`algorithm`, `digest`, `length`,
`consistency`) ; le contenu est le volume octet pour octet. Le surcoût se limite au préambule et à
l'en-tête (quelques centaines d'octets) : l'archive tient donc **très en deçà de 2× la taille
logique** (`docs/quality-attributes.md`).

Trois propriétés la gouvernent :

- **Streaming à surmémoire bornée.** L'export lit et empreinte le volume PAR BLOCS ; il ne le tient
  jamais entier en mémoire (budget ≤ 64 Mio). WebCrypto n'offrant aucun hachage incrémental et
  `node:crypto` étant absent du Worker (ADR 0002), l'empreinte est calculée par un **hachage SHA-256
  incrémental portable** (`src/vm/sha256-stream.mjs`), calibré contre `crypto.subtle.digest`.
  `writeArchive` fait deux passes sur la source relisible : empreinter, puis recopier.
- **Point cohérent exigé, non pris.** L'export ne prend pas le bail lui-même : il **exige** que
  l'appelant déclare la garantie sous laquelle le point est tenu — `handle-exclusif` (#6),
  `bail-ecrivain-unique` (#8) ou `barriere-acquittee` (#14) — et l'inscrit dans l'archive. Un export
  sans garantie est refusé. L'atomicité complète d'une génération sous écriture concurrente reste
  réservée à **#16**.
- **Vérifiabilité.** `verifyArchive(bytes)` recalcule l'empreinte du contenu et valide le manifeste
  par #10. Les échecs sont typés, jamais silencieux : `VAULT_ARCHIVE_MALFORMED`,
  `VAULT_ARCHIVE_TRUNCATED`, `VAULT_ARCHIVE_DIGEST_MISMATCH`, `VAULT_ARCHIVE_GEOMETRY_MISMATCH`. Un
  manifeste incompatible remonte comme `ManifestError` de #10, propagée telle quelle.

Ces erreurs forment une famille **distincte** des états de stockage (#6), du bail (#8) et du
manifeste (#10), avec la même forme transportable (`code`, message français, contexte, `toJSON`),
dans `src/vm/archive-errors.mjs` :

| Code                              | État                                                           | Origine |
| --------------------------------- | -------------------------------------------------------------- | ------- |
| `VAULT_ARCHIVE_MALFORMED`         | marqueur/en-tête méconnaissable, digests internes divergents   | **#11** |
| `VAULT_ARCHIVE_TRUNCATED`         | archive plus courte que ce que l'en-tête déclare               | **#11** |
| `VAULT_ARCHIVE_DIGEST_MISMATCH`   | empreinte recalculée ≠ empreinte inscrite : contenu altéré     | **#11** |
| `VAULT_ARCHIVE_GEOMETRY_MISMATCH` | longueur de contenu incohérente avec la géométrie du manifeste | **#11** |

Ce que l'export v1 **ne** couvre pas : le chiffrement et la **signature** de l'archive (jalon 4 —
l'archive v1 prouve l'INTÉGRITÉ, pas l'AUTHENTICITÉ : un support hostile peut la forger),
l'atomicité d'une génération sous écriture concurrente (#16), et la compression. La restauration
inter-origine, elle, est traitée ci-dessous.

## Restauration inter-origine

L'issue #12 (`VAULT-PORT-001`) referme la chaîne de portabilité : d'une archive v1 vers un **volume
complet**, sur une origine qui n'a jamais vu la source. Le code vit dans `src/vm/volume-import.mjs`
(orchestration pure) et `src/vm/opfs-import-target.mjs` (cible OPFS) ; la décision est
l'[ADR 0009](decisions/0009-restauration-inter-origine.md).

Le changement d'origine n'est pas un décor. OPFS est cloisonné **par origine** (ADR 0002) :
l'origine de restauration ne peut rien lire du stockage de l'origine d'export. **Rien ne traverse,
sinon l'archive** — et rien dans le produit ne la fait traverser : la CSP de la coquille
(`default-src 'none'`, `connect-src 'self'`) n'ouvre aucun canal inter-origines. L'archive sort par
un **téléchargement** vers le système de fichiers de l'utilisateur et entre par un **champ de
fichier** ; le `File` rendu par OPFS est adossé au support, donc lu par tranches, jamais tenu en
mémoire.

La restauration exécute **six gestes, dans cet ordre**, et l'ordre fait partie du contrat :

| #   | Geste           | Ce qu'il garantit                                                                           |
| --- | --------------- | ------------------------------------------------------------------------------------------- |
| 1   | **Vérifier**    | l'archive entière est validée (empreinte #11 + manifeste #10) **sans écrire un seul octet** |
| 2   | **Refuser**     | cible occupée, géométrie inconciliable, espace insuffisant (#9) — avant toute mutation      |
| 3   | **Révoquer**    | le manifeste de la cible est retiré : le volume cesse d'être présenté comme valide          |
| 4   | **Restaurer**   | le contenu est recopié octet pour octet, en flux (≤ 64 Mio), puis une barrière est franchie |
| 5   | **Re-vérifier** | le volume est **relu depuis le support** et son empreinte confrontée à celle de l'archive   |
| 6   | **Inscrire**    | le manifeste est écrit : seul ce dernier geste rend le volume présentable comme valide      |

Il n'existe donc **pas de restauration partielle silencieuse** : soit le volume est complet, relu et
identifié, soit l'échec est typé et le volume reste **non identifié**.

**Le manifeste est un fichier voisin, et il porte la validité.** Il est écrit sous
`<volume>.manifest` dans le même répertoire OPFS — jamais en tête du volume, dont les octets sont
servis tels quels à v86 et dont un en-tête décalerait le système de fichiers du guest. C'est ce
voisin qui donne leur sens aux gestes 3 et 6 : un volume sans lui est un volume non identifié, que
`assertVolumeWritable` (#10) refuse déjà par `VAULT_MANIFEST_UNIDENTIFIED`. Une restauration
interrompue ne peut pas se faire passer pour un volume valide, sans qu'aucun mécanisme de détection
nouveau ait été inventé.

**Écraser exige un consentement ; retailler est toujours refusé.** Une cible non vide est refusée
par défaut ; l'appelant peut consentir explicitement, et ce consentement est inscrit dans le compte
rendu. Un volume existant n'est en revanche jamais retaillé, consentement ou non — #6 tient la
géométrie pour immuable. La restauration ne supprime jamais de données de sa propre initiative.

Les refus forment une famille **distincte** du stockage (#6), du bail (#8), du manifeste (#10) et de
l'archive (#11), avec la même forme transportable, dans `src/vm/import-errors.mjs`. Les refus de #10
et #11 remontent, eux, **tels quels** :

| Code                               | État                                                                | Origine |
| ---------------------------------- | ------------------------------------------------------------------- | ------- |
| `VAULT_IMPORT_TARGET_NOT_EMPTY`    | la cible porte déjà un volume : consentement explicite exigé        | **#12** |
| `VAULT_IMPORT_SPACE_INSUFFICIENT`  | espace estimé inférieur au volume : refusé avant toute mutation     | **#12** |
| `VAULT_IMPORT_GEOMETRY_MISMATCH`   | la cible n'a pas la géométrie de l'archive : jamais retaillée       | **#12** |
| `VAULT_IMPORT_VERIFICATION_FAILED` | le volume relu ne rend pas l'empreinte de l'archive : non identifié | **#12** |

Ce que la restauration v1 **ne** couvre pas : la **migration** d'un format antérieur (#13 — un tel
manifeste est restaurable mais son écriture reste refusée par `VAULT_MANIFEST_MIGRATION_REQUIRED`),
le **déchiffrement** et l'**authentification** de l'archive (jalon 4 : l'intégrité est prouvée,
l'authenticité non), l'atomicité d'une génération (#16), le transport de l'archive entre origines —
qui reste un geste de l'utilisateur — et une interface produit de restauration.

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
