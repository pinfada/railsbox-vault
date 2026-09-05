# Architecture exploratoire

Cette architecture organise les questions à prouver ; elle ne fige pas encore une implémentation.

```text
Publication statique — DEUX origines (ADR 0002), UNE PAR APPLICATION au-delà de la première (ADR 0018)
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
- fermeture exclusive et transfert explicite de propriété. Elle ATTEND les E/S déjà acceptées :
  retirer le handle sous une écriture en vol la ferait échouer sur un handle « déjà fermé »,
  c'est-à-dire présenter au guest comme une panne du support une fermeture décidée par la session
  elle-même (#132) ;
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
cookies de session, IndexedDB, cache, Service Worker hors ligne — et de rien d'autre.

La conséquence que le spike #35 avait laissée ouverte est tranchée par
l'[ADR 0018](decisions/0018-isolation-entre-applications.md) : sur une origine applicative partagée,
deux applications se lisent **et s'effacent** mutuellement, et aucun partitionnement par chemin ne
l'empêche. **Le navigateur ne cloisonne que par origine.** La règle est donc **une origine par
application** — un sous-domaine du domaine propre exigé par l'ADR 0017, jamais un port, qui ne
cloisonne pas les cookies —, et elle s'applique **dès qu'il y a plus d'une application**. Le MVP
n'en publie qu'une : la limite y est acceptée explicitement, faute de seconde application à lire. La
seule borne réelle par chemin est la portée d'un Service Worker ; elle protège l'interception réseau
et aucun stockage.

### Services optionnels

Un hébergement statique distribue les artefacts. Un relais peut transporter des paquets chiffrés.
Aucun de ces services ne doit être requis pour ouvrir un volume déjà installé, ni disposer des clés
permettant de lire les données.

L'hébergement doit fournir **deux** origines. GitHub Pages n'en sert qu'une par compte, les sites de
projet en étant des chemins ; les options mesurées — domaine propre avec sous-domaine, second
compte, ou hébergeur distinct pour une origine — sont comparées dans l'ADR 0002 et le choix
appartient à la publication #45. Un changement d'origine rend l'OPFS de l'ancienne inatteignable :
il se traite comme une migration exigeant un export préalable, pas comme un détail de déploiement.

**Deux est un plancher, pas un plafond.**
L'[ADR 0018](decisions/0018-isolation-entre-applications.md) fait de l'isolation entre applications
une frontière d'origine : au-delà de la première application, chacune prend son sous-domaine, donc
son enregistrement DNS, son certificat et son arbre publié. Ce coût n'est pas seulement celui de
l'hébergeur : `shellContentSecurityPolicy()` rend `frame-src 'self' <origine applicative>`, mesuré
appliqué sur les trois moteurs, si bien qu'**ajouter une application oblige à republier la
coquille**. Un joker de sous-domaine dans `frame-src` est refusé par le même ADR. Le MVP ne publie
qu'une application et ne paie donc rien de tout cela.

L'hébergement n'a en revanche **aucun en-tête d'isolation à servir**.
L'[ADR 0010](decisions/0010-isolation-multi-origine.md) établit qu'aucun
`Cross-Origin-Embedder-Policy` n'est exigé : aucun module de production n'utilise
`SharedArrayBuffer` ou `Atomics`, et la mémoire WebAssembly de v86 épinglé n'est pas partagée. C'est
ce qui n'oblige pas l'hébergeur à servir COEP. En revanche
l'[ADR 0017](decisions/0017-chaine-de-publication.md) exige un hébergeur capable d'en-têtes
personnalisés des deux côtés (CSP, COOP, `frame-ancestors`) : GitHub Pages est écarté par mesure, il
ne sert aucun en-tête personnalisé. `Cross-Origin-Resource-Policy` reste servi, il ne dépend pas de
cette décision.

Le même ADR distingue **COOP de COEP**, et ne les rejette pas ensemble.
`Cross-Origin-Opener-Policy: same-origin` servi **seul** ne confère pas `crossOriginIsolated`, ne
s'applique qu'aux contextes de navigation de plus haut niveau — donc sans effet sur le cadre
applicatif ni sur la topologie ci-dessus — et n'exige rien de l'origine applicative. Il est
**recommandé** sur l'origine de confiance, comme **exigence différée** vers la publication #45 : il
ferme la relation d'ouverture inter-fenêtres (`window.opener`), que `frame-ancestors 'none'` ne
couvre pas, autour d'une coquille destinée à détenir les clés du volume (#24). GitHub Pages ne sait
pas le servir : c'est un critère de plus pour #45, pas un couperet.

## Cycle de vie de référence

1. La coquille vérifie identités et compatibilité avant de demander une clé.
2. Elle acquiert l'exclusivité du volume et un canal privé vers le Worker, **avant qu'aucun document
   applicatif n'existe** : un canal établi après coup serait à portée du code applicatif.
3. Le Worker ouvre le backend, puis seulement la VM.
4. La coquille encadre alors le document applicatif sur l'origine distincte et lui transfère un
   `MessagePort` restreint, après vérification du type, de l'origine et de la fenêtre émettrice de
   son annonce.
5. Le guest lit et écrit ; un flush traverse toutes les couches avant son acquittement.
6. Export et migration créent une génération cohérente distincte. Depuis #16, « cohérente » a un
   sens opposable : la récupération d'ouverture applique la dernière génération VALIDÉE avant que
   quiconque lise le volume, et l'export porte donc cet état-là. Ce que #16 ne fournit pas, c'est la
   migration sur une génération copy-on-write que `release-policy.md` demande : la migration mute
   toujours en place.
7. Verrouillage arrête les nouvelles E/S, termine proprement si possible, ferme le handle exclusif
   et relâche les clés au mieux de JavaScript.
8. La reprise part d'un boot à froid tant qu'un snapshot lié à une génération exacte n'est pas
   démontré.

## Erreurs contractuelles

Quota, handle perdu, authentification invalide, format incompatible, écriture partielle et échec de
flush sont des états distincts. Aucune couche ne les convertit en succès, en bloc zéro ou en
réinitialisation silencieuse. Les codes sont figés par le backend #6 dans
`src/vm/storage-errors.mjs` :

| Code                                 | État                                                           | Origine |
| ------------------------------------ | -------------------------------------------------------------- | ------- |
| `VAULT_STORAGE_OUT_OF_RANGE`         | accès hors de la géométrie déclarée                            | #4      |
| `VAULT_STORAGE_SHORT_READ`           | le support a rendu moins d'octets que demandé                  | #4      |
| `VAULT_STORAGE_PARTIAL_WRITE`        | le support a accepté moins d'octets que demandé                | #4      |
| `VAULT_STORAGE_FLUSH_FAILED`         | la barrière de durabilité n'a pas abouti                       | #4      |
| `VAULT_STORAGE_HANDLE_LOST`          | le handle exclusif a disparu sous le volume ouvert             | #4      |
| `VAULT_STORAGE_CLOSED`               | E/S demandée après fermeture du volume                         | #4      |
| `VAULT_STORAGE_BUSY`                 | un autre détenteur possède déjà l'exclusivité                  | #4      |
| `VAULT_STORAGE_UNSUPPORTED`          | capacité absente : jamais remplacée par un repli               | #4      |
| `VAULT_STORAGE_QUOTA_EXCEEDED`       | le quota de stockage de l'origine est épuisé                   | **#6**  |
| `VAULT_STORAGE_GEOMETRY_MISMATCH`    | la géométrie du support diffère de celle de la session         | **#6**  |
| `VAULT_STORAGE_SUPPORT_FAILURE`      | échec du support non classable : jamais deviné, toujours nommé | **#6**  |
| `VAULT_STORAGE_GENERATION_DISCARDED` | une génération non validée a été écartée à l'ouverture         | **#16** |
| `VAULT_STORAGE_GENERATION_CORRUPT`   | une génération validée dont la charge ne concorde plus         | **#16** |
| `VAULT_STORAGE_GENERATION_OVERFLOW`  | la génération en cours dépasse le plafond du journal           | **#16** |
| `VAULT_STORAGE_GENERATION_PENDING`   | point de contrôle demandé sur une génération non validée       | **#16** |

Les quatre derniers naissent de la génération transactionnelle (#16, ADR 0014). Le premier n'est
jamais **levé** : il est PUBLIÉ dans le compte rendu de récupération, parce qu'écarter une
génération non validée est le résultat NORMAL d'une coupure — mais qu'une mise au rebut silencieuse
serait un succès muet. Les trois derniers sont levés.

Les trois précédents naissent de l'implémentation OPFS. Le quota **n'est pas** une écriture
partielle — l'un se corrige en libérant de la place, l'autre décrit un état intermédiaire du volume.
La géométrie **n'est pas** un accès hors bornes — elle dit que le support a changé, pas que
l'appelant s'est trompé. Et un `DOMException` de nom inconnu **n'est pas** rangé dans l'état le plus
proche : `src/vm/opfs-error-mapping.mjs` traduit les noms qu'il connaît et nomme les autres
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
      → backend OPFS (opfs-block-backend) : journalise `flush`, VALIDE la génération
         en cours (generation-store) — barrière sur la charge, écriture de la racine,
         barrière sur la racine —, puis journalise `flush-ack`
      ← acquittement RÉEL du support (deux flush du journal voisin, #16)
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

Ce que #14 ne couvre pas : le regroupement ou l'optimisation des flush, le chiffrement, la reprise
Rails complète (#7) et l'accès concurrent (#8), traité plus bas. L'atomicité d'une génération et sa
récupération sont désormais couvertes par #16 — voir « La génération transactionnelle ».

## La génération transactionnelle (#16)

Une génération est l'ensemble des écritures comprises entre deux barrières ACQUITTÉES, et
l'acquittement est le point de validation. Le guest n'émet aucune transaction : la barrière est la
seule frontière observable, et c'est donc elle qui devient la frontière transactionnelle. La
décision et ses alternatives mesurées sont dans
[l'ADR 0014](decisions/0014-generation-transactionnelle.md).

Trois pièces, dans `src/vm/` :

- **`generation-format.mjs`** — le format du journal voisin `<volume>.gen` : deux racines qui
  ALTERNENT, chacune d'un seul secteur, portant un numéro de séquence monotone, le numéro de
  génération, la longueur de la charge et sa somme de contrôle. L'alternance est ce qui empêche une
  validation interrompue de détruire la racine qui fait autorité.
- **`generation-store.mjs`** — la machine d'état : DÉPOSER (les octets vont au journal, jamais au
  volume), VALIDER (barrière sur la charge, puis racine, puis barrière — c'est le point où le guest
  peut être acquitté sans mentir), POINT DE CONTRÔLE (la charge validée est recopiée dans le volume,
  après l'acquittement et jamais sur son chemin), RÉCUPÉRER.
- **`opfs-block-backend.mjs`** — le backend délègue : `write` dépose, `read` superpose la génération
  en cours au volume relu (l'écrivain se relit, un lecteur qui rouvre ne voit rien), `flush` valide,
  `close` range.

**Le volume ne change ni de format ni de disposition.** Il reste l'image que v86 lit, ce dont
dépendent l'export (#11), la restauration (#12) et la migration (#13). Aucun format v3 n'est
introduit, ni pour le volume, ni pour le manifeste : la génération validée est nommée par la racine
du journal, publiée par `describe().generation`, pas par le manifeste — qui décrit une IDENTITÉ, pas
une histoire (ADR 0011).

**La récupération vit dans `openOpfsVolume`**, non dans le seul `openVolumeForWrite`. La règle de
l'ADR 0009 n'est ni affaiblie ni élargie : elle est simplement insuffisante ici, puisque douze
chemins ouvrent encore le volume directement — dont l'export, qui aurait exporté un état antérieur à
la dernière barrière acquittée. Trois chemins ouvrent SANS génération et le disent
(`describe().transactionnel`) : la préparation depuis l'image de référence et la restauration
écrivent un volume entier et portent déjà leur atomicité (manifeste inscrit en dernier).

Mesure : le taux de coupures laissant « ancien ou nouveau » passe de 12,5 % à 100 % sur trois
graines, sur OPFS réel. Voir [`quality-attributes.md`](quality-attributes.md).

## Le format chiffré : la spécification, et ce qu'elle a coûté (#17)

**#17 n'exerçait rien dans le produit ; #18 l'exerce, et la section suivante dit comment.** #17
livre une SPÉCIFICATION EXÉCUTABLE — modèle de référence pur et vecteurs figés — que #18 (bloc
authentifié) et #19 (rejeu, troncature, mélange) devront tenir. Le rapport est celui de l'oracle de
#15 au magasin de #16 : le juge est écrit avant, et séparément. Décision :
[ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md).

Quatre gestes, sur des structures en mémoire, dans `src/vm/format-chiffre/` :

- **`scellerBloc` / `ouvrirBloc`** — AES-256-GCM par `crypto.subtle`, étiquette de 128 bits, données
  associées = l'**identité logique complète** (identifiant de volume, adresse logique, version de
  format, génération, rang, longueur, algorithme), encodée de façon injective. C'est
  `SEC-BLOCK-001`.
- **`scellerRacine` / `ouvrirRacine`** — l'en-tête de la racine est les données associées, et
  l'empreinte SHA-256 de la **suite ordonnée** des entrées est le clair. Cet ordre décide de ce que
  le modèle a le droit d'affirmer : l'étiquette vérifie d'abord, ce qui rend l'en-tête AUTHENTIQUE,
  et rejeu, troncature et mélange ne sont classés qu'ensuite. C'est `SEC-GEN-001` ;
- **`rescellerEnSecteurs`** — ce que le POINT DE CONTRÔLE de l'ADR 0014 exige. Le journal scelle des
  enregistrements de longueur quelconque, le volume est adressé au secteur : le rangement rescelle
  donc secteur par secteur, avec un nonce neuf. Un enregistrement non aligné est refusé plutôt que
  complété.

**Le nonce est TIRÉ AU HASARD**, douze octets de `crypto.getRandomValues`, et conservé avec chaque
objet scellé. Une première version le dérivait de (génération, rang) ; une revue l'a réfutée par
exécution contre `generation-store.mjs`, où une fermeture PROPRE avec un dépôt non validé suffisait
à réémettre un nonce. La leçon est écrite dans l'ADR : tout nonce dérivé d'un état DURABLE est
réémis dès que cet état recule, et un système conçu pour survivre aux coupures en fait reculer. Le
budget par clé est fixé à **2^31** — la moitié du plafond du § 8.3 de NIST SP 800-38D —, parce que
le compteur qui le suit vit dans la racine et recule lui aussi ; son dépassement est un refus typé.

**Ce que le format ne couvre pas est écrit plutôt que déduit** : le retour arrière d'un secteur, et
le retour arrière complet du support entre deux sessions. Voir `SECURITY.md` et l'ADR 0015.

## Le format de volume v3 : le chemin, désormais (#18)

#18 branche la spécification ci-dessus sur le produit. La disposition sur disque est décidée par
l'[ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md), qui ne prend AUCUNE décision
cryptographique : primitives, nonce, données associées, budget de clé et ordre des vérifications
restent ceux de l'ADR 0015, et le modèle de référence reste la spécification.

```text
[ en-tête v3, 1 secteur ][ région d'authentification, 34 o par secteur logique ][ charge chiffrée ]
```

**Deux tailles, et il ne faut jamais les confondre.** La taille LOGIQUE est celle que v86 voit et
que le manifeste déclare ; la taille SUPPORT est celle du fichier. `size()` du backend rend la
première, le contrôle de géométrie confronte la seconde, et le mappage entre elles est confiné à
`volume-chiffre-format.mjs`. C'est ce qui permet à `block-geometry.mjs`, au contrat de tampon de v86
et à l'oracle de #15 de n'avoir pas bougé. Pour un volume applicatif de 512 Mio, le fichier fait 572
523 008 octets — **+6,64 %**.

**Un SEUL sceau, de 34 octets, dans deux endroits** : la région d'authentification du volume et
l'enregistrement du journal portent la même forme — nonce 12, étiquette 16, génération 6. L'ADR 0015
n'en annonçait que 28 pour le journal, en supposant que la génération d'un enregistrement était
celle de sa racine ; l'ADR 0016 montre par exécution que c'est faux — le journal n'est vidé qu'au
point de contrôle, donc une charge cumule plusieurs générations — et corrige le chiffre.

**L'en-tête v3 et la copie de l'identifiant de volume dans la racine LOCALISENT ; ils n'autorisent
pas.** L'identité qui entre dans les données associées est celle que le MANIFESTE déclare ; ce que
le fichier en porte lui est CONFRONTÉ, et l'écart est refusé par `VAULT_STORAGE_IDENTITE_VOLUME`.
Une altération de ces champs produit donc un refus, jamais une lecture erronée.

**La clé de volume est reçue en mémoire, et le produit n'en fabrique aucune.** Un volume v3 présenté
sans clé est refusé par `VAULT_STORAGE_CLE_REQUISE` avant toute lecture ; les bancs reçoivent une
clé de TEST du harnais, sous jeton, comme l'injecteur d'arrêts de #15. Les clés de déverrouillage et
l'enveloppe sont #21.

**Les refus du format traversent la couche de stockage sans perdre leur cause** :
`VAULT_CRYPTO_SCEAU_REFUSE` devient `VAULT_STORAGE_SCEAU_REFUSE`, rejeu, troncature et mélange
retombent sur `VAULT_STORAGE_GENERATION_CORRUPT` — trois façons pour une génération validée de ne
plus concorder, un seul remède —, et la `CryptoError` d'origine reste dans le contexte.

**Ce que #18 ne fait pas** : la migration v2 → v3 est DÉCLARÉE dans la chaîne et refusée par
`VAULT_MIGRATION_STEP_UNAVAILABLE`, faute d'une cible capable d'agrandir un fichier et de le
rechiffrer ; les contrôles de séquence restent #19 ; l'archive porte le fichier v3 tel quel, donc
son empreinte porte sur du chiffré.

## L'instantané de reprise : une accélération vérifiée, jamais une source de vérité (#65)

L'[ADR 0005](decisions/0005-qualification-de-la-reprise.md) avait tranché la voie sans pouvoir dire
**à quoi** un instantané mémoire se lie. Les générations transactionnelles (#16), le format v3 (#18)
et la fraîcheur (#19) l'ont livré ; l'[ADR 0024](decisions/0024-instantane-de-reprise.md) pose le
format, la politique de capture et le cycle de vie.

**La phrase qui gouverne tout le reste : le volume est la seule source de vérité.** Un instantané
qui ne décrit pas exactement l'état présent est ÉCARTÉ — retiré du support — et le boot à froid
s'exécute. Aucun message ne laisse croire à une reprise, et aucune promesse de durabilité ne bouge :
`SEC-DURABLE-001` est tenu par le journal de génération, pas par l'instantané. **Un instantané perdu
ne perd aucune donnée : il coûte un boot.**

Un sixième voisin, `<volume>.instantane`, rejoint le manifeste (#10), le journal de migration (#13),
le journal de génération (#16), le témoin de séquence (#19) et l'enveloppe de clé (#21). C'est le
plus long suffixe réservé du dépôt : `MAX_VOLUME_NAME` passe de 54 à 53 caractères, et la
rétroactivité est écrite dans l'ADR plutôt que subie.

Cinq pièces, dans `src/vm/instantane/` et `src/vm/` :

- **`instantane/identite-instantane.mjs`** — la LIAISON : identifiant de volume, versions de format,
  séquence et génération de la racine validée, empreinte de la région d'authentification (ADR 0019),
  empreinte de l'image de référence (ADR 0007), longueur de l'état. Encodage canonique, champs
  préfixés ou de largeur fixe, pour la raison exacte de l'ADR 0015 ;
- **`instantane/modele-reference.mjs`** — la spécification exécutable : **UN seul scellement par
  capture**, AES-256-GCM sous la DEK, clair = l'état v86, **données associées = la liaison**. C'est
  ce que « en-tête scellé » veut dire ici : l'en-tête est en clair sur le disque — il faut pouvoir
  le lire avant de traverser 250 Mio — et il est AUTHENTIFIÉ, si bien qu'un champ modifié fait
  échouer l'étiquette ;
- **`instantane/fichier-instantane.mjs`** — la disposition : en-tête de 152 octets, corps chiffré,
  **marque de complétude posée à la FIN**, après le corps et après une barrière. Un fichier tronqué
  par une coupure n'a pas de marque ;
- **`instantane-de-reprise.mjs`** — la conduite : capturer, relire, ÉCARTER. L'ouverture rend un
  RAPPORT et ne lève pas, parce que tous les refus mènent au même geste et que l'appelant a besoin
  du MOTIF pour le publier ;
- **`v86-buffer-adapter.mjs`** — la QUIESCENCE, qui amende l'ADR 0003 sur deux gestes exactement.

**La quiescence est le filet de la capture, pas une preuve d'arrêt.** Elle refuse de s'établir tant
qu'une E/S est en vol ou qu'une faute est retenue ; pendant qu'elle dure, `get`, `set` et `flush`
sont refusés, le backend n'est pas touché et **le rappel d'acquittement de v86 n'est pas appelé** —
un acquittement pendant une capture serait exactement le mensonge que `SEC-DURABLE-001` interdit ;
`reprendre()` publie le nombre de violations, et une capture qui en a vu une échoue proprement, sans
produire de fichier. Ce qu'elle ne dit PAS : que le guest soit logiquement au repos. C'est l'arrêt
de l'émulateur qui fait le repos ; l'adaptateur ne voit que les E/S qui lui arrivent.

**`get_state` ne rend que la liaison, et rien du disque.** v86 appelle ce geste sur le tampon du
disque pendant `save_state` ; rendre les octets du volume en ferait une seconde copie, capable de le
contredire. `set_state` confronte la liaison reçue au volume réellement ouvert, avant que le guest
n'ait battu une seule fois. `get_buffer` reste refusé, pour la raison inchangée de l'ADR 0003.

**Ce que #65 ne fait pas** : il n'ouvre pas le gate « reprise p95 ≤ 60 s ». Le gate demande une
mesure ET une preuve d'équivalence byte-à-byte, publiées dans
[`quality-attributes.md`](quality-attributes.md).

## Résilience aux coupures : l'instrument, puis la garantie

L'issue #15 a livré l'**instrument** de mesure des arrêts brutaux ; #16 a livré la **garantie**
d'atomicité qu'il mesure. La distinction reste structurante : rien de ce qui suit ne PROMET
d'atomicité — l'instrument rend l'état laissé par une coupure **observable, reproductible et
classé**, et c'est le mécanisme décrit ci-dessus qui le rend atomique.

Quatre pièces, toutes dans `src/vm/` :

- **l'injecteur** (`crash-plan.mjs`) tire d'une graine entière une séquence déterministe de points
  de coupure — arrêt brutal, écriture déchirée, coupure entre écriture et barrière. Il n'invente
  aucune sorte de faute : il traduit chaque point dans le plan de `fault-plan.mjs`, si bien que la
  panne est exécutée par le code de backend de production et non par un `throw` posé pour
  l'occasion. Le générateur pseudo-aléatoire est écrit dans le module ; la graine est une donnée
  versionnable ;
- **l'arrêt** est une mort réelle de Worker. Sur le chemin navigateur, la page appelle
  `Worker.terminate()` pendant que le Worker runtime tient encore le handle exclusif du volume, sans
  fermeture — qui matérialiserait les écritures en attente — et sans barrière. Sous Node,
  `crash-machine.mjs` reproduit la même sémantique sur le double calibré : l'exclusivité est
  reprise, aucun `close()` n'est appelé. Ce n'est PAS une mort de processus : le navigateur survit,
  et aucun cache volatil n'est perdu au passage. Le genre de coupure nommé `arret-brutal` arrête le
  **chemin d'E/S** — le handle est déclaré perdu —, pas la machine. Couper plus bas reste un
  protocole à écrire : #16 ne l'a pas fourni, et le dit ;
- **l'oracle** (`crash-oracle.mjs`) classe, après réouverture, chaque bloc suivi en `ancien`,
  `nouveau`, `dechire` ou `corrompu`, et en tire un verdict de volume : `ancien`, `nouveau`,
  `melange` ou `corrompu`. Il lit les octets ET le **journal de blocs** : un bloc dont l'écriture a
  été acquittée puis franchie par une barrière, et qui rend pourtant l'ancien état, est une
  corruption — c'est `SEC-DURABLE-001` lu à l'envers. Un bloc qu'il ne sait pas rattacher est
  `corrompu` avec diagnostic, jamais ignoré : c'est la règle « aucun succès silencieux » de
  `quality-attributes.md` appliquée à l'instrument lui-même. **L'oracle est le juge de #16**, et il
  est écrit pour ne jamais se tromper du côté flatteur : la discernabilité octet par octet des deux
  états attendus est une précondition vérifiée, une barrière franchie ne se dé-franchit pas quand
  une écriture postérieure suit, et le journal est exigé plutôt que supposé vide — les détails et
  leurs contre-exemples sont dans `docs/testing.md` ;
- **le compte rendu** (`crash-report.mjs`) agrège la matrice d'une graine et publie le taux « ancien
  ou nouveau », point par point et globalement, AVEC le profil du scénario mesuré : un taux sans le
  nombre d'écritures, de barrières et de blocs suivis n'est comparable à rien.

L'injecteur ne s'arme jamais hors harnais (`crash-harness.mjs`), sur le modèle du drapeau
`--worker-src-blob` de `tools/serve.mjs` : variable d'environnement exigée sous Node, jeton exigé
dans un Worker de navigateur. Aucun chemin du produit ne FABRIQUE l'un ni l'autre — le Worker
runtime, lui, relaie le jeton que son appelant lui présente, et c'est la page de résilience du
harnais qui est la seule à le présenter. La portée exacte de cette garde, et ce qu'elle ne couvre
pas, sont dans `SECURITY.md`.

Ce que l'instrument ne couvre pas : la participation d'un guest v86 à la coupure — le scénario écrit
depuis le Worker runtime, la chaîne guest → pont ATA → backend restant prouvée par les suites de #6
et #14, et le scénario Bout en bout de #16 la couvrant avec un vrai Rails —, et la perte d'une
écriture non barriérée, qu'aucun des deux supports éprouvés ne produit aujourd'hui. Les deux mesures
du taux, avant et après #16, sont publiées dans `docs/quality-attributes.md`.

**Ce que #16 a changé dans la MESURE : l'oracle, pas la charge.** La cadence de #15 — vingt-quatre
blocs distincts, une barrière tous les huit — rendait 100 % inatteignable pour TOUT mécanisme : les
générations intermédiaires y sont validées mais ne couvrent qu'une fraction du volume, et un oracle
qui ne connaît que deux états de référence les classe `melange`. La borne est calculée : 50 % sur la
graine 2026, 37,5 % sur les deux autres.

#16 a d'abord essayé de changer la CHARGE mesurée — huit blocs réécrits trois fois — pour que toute
génération validée soit l'un des deux états que l'oracle savait juger. **C'était faux, et une
mutation l'a montré** : à contenu identique d'une passe à l'autre, un magasin qui acquitte les
générations 2 et 3 puis les perd laisse le même volume qu'un magasin correct, et la matrice restait
à 100 %. Un juge inchangé sur une charge appauvrie ne mesure pas moins qu'un juge élargi — il ne
mesure plus rien.

L'oracle reçoit donc la **suite des générations attendues** du scénario et n'accepte un état que
s'il en est exactement une, avec des verdicts nommés (`generation-1`, `generation-2`). Il refuse une
suite qui ne croît pas strictement : son appelant ne peut pas l'élargir. La charge, elle, revient à
celle de #15, et `tests/unit/vm-crash-mutation.test.mjs` conserve le contre-exemple.

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

| Situation                                           | Lecture | Écriture | Code de refus                       |
| --------------------------------------------------- | :-----: | :------: | ----------------------------------- |
| format plus récent que le format courant du runtime | refusée | refusée  | `VAULT_MANIFEST_FORMAT_TOO_NEW`     |
| format sous le plus ancien format lisible           | refusée | refusée  | `VAULT_MANIFEST_FORMAT_TOO_OLD`     |
| application (`app.id`) différente                   | refusée | refusée  | `VAULT_MANIFEST_IDENTITY_MISMATCH`  |
| format lisible mais antérieur au format courant     | tolérée | refusée  | `VAULT_MANIFEST_MIGRATION_REQUIRED` |
| runtime en cours antérieur à l'écrivain admis       | tolérée | refusée  | `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  |

Le **format futur** est refusé en lecture comme en écriture : sa disposition n'est pas interprétable
en confiance. Le **downgrade dangereux** est refusé en écriture seule ; la lecture reste tolérée
pour le diagnostic et l'export (#11). Seule `app.id` doit correspondre : la version de l'application
peut différer, ses migrations métier restant distinctes de celles du format Vault.

**Ce que « downgrade » veut dire dépend du format**, et chaque format est jugé par SA règle. À
partir de **v2** (#13), le volume **déclare** `runtime.minWriter` et le refus est une comparaison :
le runtime en cours est-il antérieur à l'écrivain le plus ancien que le volume admet ? Un manifeste
**v1** ne porte pas ce champ et conserve la règle v1 — « majeur du volume > majeur en cours » —, au
lieu de recevoir d'office une valeur que son auteur n'a jamais déclarée ; en pratique elle ne
s'applique qu'à un runtime dont le format courant est 1, sinon `MIGRATION_REQUIRED` refuse
l'écriture plus tôt. Le détail et la raison du changement figurent dans
l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) et au § « Migration de format et
reprise ».

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

Ce que le manifeste **ne** couvre pas, et qu'il ne faut pas en déduire : la **génération
copy-on-write** et l'atomicité transactionnelle (#16), et l'**authentification** ou le
**chiffrement** du manifeste lui-même (jalon 4). L'empreinte du contenu et l'export portable sont
venus avec #11 — `identity.digest` atteste la provenance, pas l'état courant (ADR 0009) —, la
restauration inter-origine avec #12, et le détail des migrations avec #13 (§ « Migration de format
et reprise »).

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

La restauration exécute **sept gestes, dans cet ordre**, et l'ordre fait partie du contrat :

| #   | Geste           | Ce qu'il garantit                                                                           |
| --- | --------------- | ------------------------------------------------------------------------------------------- |
| 1   | **Vérifier**    | l'archive entière est validée (empreinte #11 + manifeste #10) **sans écrire un seul octet** |
| 2   | **Refuser**     | cible occupée, géométrie inconciliable, espace insuffisant (#9) — avant toute mutation      |
| 3   | **Ouvrir**      | le handle exclusif est pris ; une ouverture ratée ne doit rien avoir détruit                |
| 4   | **Révoquer**    | le manifeste de la cible est retiré : le volume cesse d'être présenté comme valide          |
| 5   | **Restaurer**   | le contenu est recopié octet pour octet, en flux (≤ 64 Mio), puis une barrière est franchie |
| 6   | **Re-vérifier** | le volume est **relu depuis le support** et son empreinte confrontée à celle de l'archive   |
| 7   | **Inscrire**    | le manifeste est écrit : seul ce dernier geste rend le volume présentable comme valide      |

Il n'existe donc **pas de restauration partielle silencieuse** : soit le volume est complet, relu et
identifié, soit l'échec est typé et le volume reste **non identifié**. L'ouverture précède la
révocation parce qu'elle peut échouer pour des raisons étrangères à la restauration — un autre
onglet détient l'exclusivité (#8), le support a perdu le handle, le quota refuse l'allocation — et
qu'un volume **intact** ne doit pas devenir inutilisable par la faute du produit. Après l'ouverture,
la révocation précède impérativement le premier octet écrit.

**Le manifeste est un fichier voisin, et il porte la validité.** Il est écrit sous
`<volume>.manifest` dans le même répertoire OPFS — jamais en tête du volume, dont les octets sont
servis tels quels à v86 et dont un en-tête décalerait le système de fichiers du guest. Le suffixe
est **réservé** par la frontière de nommage, et la longueur maximale d'un nom de volume réduite
d'autant : aucun volume ne peut porter le nom d'un manifeste, et un volume créable est toujours
restaurable.

**Le BOOT exige ce voisin** (`src/vm/opfs-volume-open.mjs`, `SEC-UPDATE-001`). La règle exacte,
telle que le code la tient :

- un volume **identifié** ne s'ouvre en écriture que par `openVolumeForWrite`, qui lit le manifeste
  voisin, le soumet à `assertVolumeWritable` (#10) et n'ouvre qu'ensuite. Le boot y passe : un
  volume sans manifeste y est refusé par `VAULT_MANIFEST_UNIDENTIFIED` **avant** la construction de
  v86 ;
- un volume **anonyme** n'est ouvrable que par le chemin qui va l'identifier — préparation depuis
  l'image, restauration — et reste refusé au boot tant que son manifeste n'est pas inscrit ;
- les bancs #4/#6/#14 et les phases de mesure (export, empreinte) n'ouvrent aucun volume applicatif.

C'est ce qui donne leur portée aux gestes 4 et 7 — une restauration interrompue laisse une cible
sans voisin, et le boot suivant la refuse avant que le guest ne monte un système de fichiers
tronqué. En corollaire, toute création de volume inscrit son manifeste en dernier geste, et il
n'existe **aucune période de transition** : un volume sans manifeste est refusé, jamais complété par
une identité devinée.

En revanche, `openOpfsVolume` **reste appelable directement** — treize sites le font encore,
énumérés et justifiés dans l'[ADR 0009](decisions/0009-restauration-inter-origine.md). Rien dans
l'outillage n'empêche un nouveau chemin d'en ajouter un : c'est une **discipline de revue, pas une
contrainte du code**.

**Écraser exige un consentement ; retailler est toujours refusé.** Une cible non vide est refusée
par défaut ; l'appelant peut consentir explicitement, et ce consentement est inscrit dans le compte
rendu. Un volume existant n'est en revanche jamais retaillé, consentement ou non — #6 tient la
géométrie pour immuable. La restauration ne supprime jamais de données de sa propre initiative : un
voisin présent mais non analysable comme manifeste fait **refuser** la restauration, il n'est pas
effacé.

Les refus forment une famille **distincte** du stockage (#6), du bail (#8), du manifeste (#10) et de
l'archive (#11), avec la même forme transportable, dans `src/vm/import-errors.mjs`. Les refus de #10
et #11 remontent, eux, **tels quels** :

| Code                               | État                                                                | Origine |
| ---------------------------------- | ------------------------------------------------------------------- | ------- |
| `VAULT_IMPORT_TARGET_NOT_EMPTY`    | la cible porte déjà un volume : consentement explicite exigé        | **#12** |
| `VAULT_IMPORT_SPACE_INSUFFICIENT`  | espace estimé inférieur au volume : refusé avant toute mutation     | **#12** |
| `VAULT_IMPORT_GEOMETRY_MISMATCH`   | la cible n'a pas la géométrie de l'archive : jamais retaillée       | **#12** |
| `VAULT_IMPORT_VERIFICATION_FAILED` | le volume relu ne rend pas l'empreinte de l'archive : non identifié | **#12** |

**Ce que le manifeste inscrit atteste.** `identity.digest` porte l'empreinte du contenu **tel qu'il
vient d'être restauré** : il atteste la provenance (« ce volume vient de cette archive-là »), pas
l'état courant. Dès la première écriture du guest il ne décrit plus le volume, et rien ne
l'invalide. `assertVolumeWritable` ne le compare à rien — il juge le format, le runtime et
l'identité de l'application, jamais le contenu. Toute évolution qui le comparerait serait un
changement de contrat, à décider par ADR (voir ADR 0009).

Ce que la restauration v1 **ne** couvre pas : la **migration** d'un format antérieur (#13 — un tel
manifeste est restaurable mais son écriture reste refusée par `VAULT_MANIFEST_MIGRATION_REQUIRED`),
le **déchiffrement** et l'**authentification** de l'archive (jalon 4 : l'intégrité est prouvée,
l'authenticité non), l'atomicité d'une génération (#16), le transport de l'archive entre origines —
qui reste un geste de l'utilisateur — et une interface produit de restauration.

## Migration de format et reprise

L'issue #13 (`VAULT-COMPAT-001`) donne enfin une **sortie** au refus posé par #10 : jusqu'ici un
volume d'un format antérieur était lisible mais définitivement non inscriptible. La décision
complète est l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md).

**Le format de volume passe à v2.** Il ajoute un champ obligatoire, `runtime.minWriter` : la version
de runtime la plus ancienne autorisée à écrire ce volume, **déclarée** par le runtime qui l'écrit.
v1 la devinait à partir du seul majeur SemVer — une heuristique que l'ADR 0007 signalait déjà comme
à revoir et qui, en série `0.x`, ne peut **rien** refuser, puisque `docs/release-policy.md` y
exprime une rupture d'API runtime par un incrément du **mineur** : les deux majeurs valent 0 et la
comparaison est toujours fausse. Chaque format est jugé par SA règle — un manifeste v1 ne reçoit pas
d'office une valeur qu'il n'a jamais portée — et `minReadable` reste 1 : un volume v1 demeure
lisible, donc exportable, restaurable et migrable ; seule son écriture reste refusée par
`VAULT_MANIFEST_MIGRATION_REQUIRED`.

**La migration** (`src/vm/volume-migration.mjs`, module pur ; cible OPFS
`src/vm/opfs-migration-target.mjs` ; format du journal de reprise `src/vm/migration-journal.mjs` ;
contrôle de la preuve de sauvegarde `src/vm/migration-backup-proof.mjs`) exécute dix gestes dont
l'ordre est le contrat : lire, planifier, exiger une preuve, ouvrir, vérifier la sauvegarde,
journaliser, révoquer, appliquer et flusher, inscrire puis relire, retirer le journal. La
restitution du handle n'en est pas un onzième : elle est tentée quoi qu'il arrive, et si elle rate
elle ne remplace pas l'erreur d'origine — celle-ci remonte, la fermeture jointe en `cause`. Quatre
propriétés en découlent :

- **la chaîne va d'un format au SUIVANT**, une étape enregistrée à la fois. Un saut
  (`VAULT_MIGRATION_NO_PATH`) et un retour en arrière (`VAULT_MIGRATION_DOWNGRADE_REFUSED`) sont des
  refus typés. Un contrôle au chargement du module refuse une étape non contiguë ;
- **« export de sauvegarde obligatoire avant migration irréversible » est un contrôle**, pas une
  phrase : l'archive fournie est relue par #11 et son empreinte confrontée à celle du volume relu
  depuis le support, dans son état courant. À défaut, un consentement **nommé**, inscrit au journal.
  Sans l'un ni l'autre, `VAULT_MIGRATION_BACKUP_REQUIRED` tombe et la cible n'est **même pas
  ouverte** ;
- **une migration interrompue laisse un volume NON IDENTIFIÉ** que `openVolumeForWrite` refuse
  (`VAULT_MANIFEST_UNIDENTIFIED`), et un journal voisin `<volume>.migration` qui porte le manifeste
  **source**, la chaîne visée et la preuve retenue. La reprise repart de là, **sans redemander
  l'archive** — l'exiger de nouveau ferait d'une interruption une impasse. Un journal illisible fait
  refuser, jamais deviner ni supprimer ; un journal resté derrière un manifeste déjà migré est
  simplement retiré, ce qui rend la migration idempotente ;
- **le manifeste n'est déclaré valide qu'après avoir été RELU** depuis le support ; une relecture
  divergente le retire (`VAULT_MIGRATION_VERIFICATION_FAILED`) ;
- **un journal ne fait pas AUTORITÉ sur le volume.** Un journal peut être le reliquat périmé d'un
  volume recréé depuis : s'il coexiste avec un manifeste, les deux doivent coïncider octet pour
  octet, et la géométrie déclarée doit décrire le support réel
  (`VAULT_MIGRATION_GEOMETRY_MISMATCH`), faute de quoi la migration est refusée **avant toute
  ouverture**. Les chemins qui recréent un volume — création et restauration — retirent le journal
  voisin, pour qu'un volume neuf ne reste pas non migrable à cause d'un indice qui ne décrit plus
  rien.

Le suffixe `.migration` rejoint `.manifest` parmi les voisins **réservés** par la frontière de
nommage : aucun volume ne peut le porter, et la longueur maximale d'un nom de volume se règle sur le
plus long des voisins — un volume créable reste un volume migrable.

Les erreurs de migration forment une famille distincte (`src/vm/migration-errors.mjs`), avec la même
forme transportable que les autres :

| Code                                  | État                                                                    | Origine |
| ------------------------------------- | ----------------------------------------------------------------------- | ------- |
| `VAULT_MIGRATION_NO_PATH`             | aucune étape enregistrée ne relie le format du volume au demandé        | **#13** |
| `VAULT_MIGRATION_DOWNGRADE_REFUSED`   | format demandé antérieur : une migration ne descend jamais              | **#13** |
| `VAULT_MIGRATION_BACKUP_REQUIRED`     | ni sauvegarde vérifiée, ni consentement nommé : rien n'est ouvert       | **#13** |
| `VAULT_MIGRATION_BACKUP_MISMATCH`     | l'archive ne décrit pas ce volume dans son état courant                 | **#13** |
| `VAULT_MIGRATION_JOURNAL_MALFORMED`   | journal illisible, contredisant le manifeste, ou visant un autre format | **#13** |
| `VAULT_MIGRATION_GEOMETRY_MISMATCH`   | le manifeste de départ ne décrit pas la géométrie du support            | **#13** |
| `VAULT_MIGRATION_VERIFICATION_FAILED` | manifeste relu divergent : le volume reste non identifié                | **#13** |

Ce que la migration v2 **ne** couvre pas : la **génération copy-on-write** et l'atomicité
transactionnelle (#16 — entre la révocation et l'inscription, l'état est sûr mais pas révocable en
un geste), le **chiffrement** et l'**authentification** du manifeste comme du journal (jalon 4), et
les **vecteurs de test par version publiée** qu'exige `docs/release-policy.md`, qui supposent qu'une
version le soit. Le témoin de refus par une « ancienne version » simule celle-ci par ses attentes
déclarées, non par un binaire antérieur : la limite est écrite dans l'ADR 0011 et dans
`docs/testing.md`.

## Publication : deux arborescences, un inventaire, les mêmes en-têtes (#45)

Le diagramme de contexte commence par « Éditeur ──publie──► Hébergement statique ». Depuis #45, ce
verbe a un outil et une forme, décidés par l'[ADR 0017](decisions/0017-chaine-de-publication.md).

**Ce qui est publié est double, parce que la frontière l'est.** `node tools/publier.mjs` construit
deux arborescences indépendantes, une par origine de l'ADR 0002, et jamais un artefact unique :

| Arbre           | Contenu                                                                                            | En-têtes servis                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **coquille**    | document de confiance, `main.mjs`, Worker runtime, `src/vm/`, artefacts v86 épinglés, licences     | CSP stricte de l'ADR 0013, `CORP: same-origin`, `nosniff`, **COOP `same-origin`**, `Referrer-Policy: no-referrer` et `Permissions-Policy` (ADR 0022) |
| **application** | aucun artefact du dépôt — le HTML vient du guest — plus une **place tenante** déclarée comme telle | `CORP: cross-origin`, `nosniff`, **`frame-ancestors <coquille>` SEUL**                                                                               |

Trois propriétés de cette construction touchent l'architecture, et pas seulement l'outillage.

**`tools/serve-headers.mjs` est la source de vérité des en-têtes.** La production ne recopie pas la
politique : elle appelle `securityHeaders()` et rend le fichier de configuration correspondant. La
raison est de cohérence des preuves — `tests/browser/csp-frontiere.spec.mjs` et les sondes du spike
#35 mesurent ce que ce module sert, et une politique recopiée ailleurs divergerait sans bruit, en
laissant deux vérités qui ont l'air vraies. La publication **ajoute exactement deux** en-têtes, un
par origine : `Cross-Origin-Opener-Policy: same-origin` sur la coquille — recommandation différée de
l'[ADR 0010](decisions/0010-isolation-multi-origine.md) —, et
`Content-Security-Policy: frame-ancestors <origine coquille>` sur l'application, sans quoi le
document qui porte les cookies de session est encadrable par n'importe quel site. Cette seconde
directive ne contraint rien de ce que le guest rend : elle ne gouverne pas ce que le document
charge, seulement qui peut l'encadrer, et l'ADR 0002 ne s'interdit que la première de ces deux
choses. Une épreuve unitaire échoue si un **troisième** en-tête apparaît. COEP reste absent.

L'[ADR 0022](decisions/0022-entetes-de-durcissement.md) a ajouté deux en-têtes de **durcissement
générique** sans toucher cette table de deux : ils sont posés dans la source de vérité, donc servis
en développement et mesurés là, puis dérivés par la publication. Ils s'arrêtent aux documents de la
coquille — pas le territoire applicatif, pas la sonde de capacités — et ne sont pas posés sur
l'origine applicative, parce que `Referrer-Policy` et `Permissions-Policy` gouvernent ce qu'un
document ÉMET et ce qu'il PEUT, c'est-à-dire le contenu que le guest rend.
`Strict-Transport-Security` est écarté et son absence gardée : il serait ignoré sur le `http:` de
tout ce que ce dépôt sait mesurer, et il engage un domaine plutôt qu'une arborescence.

**Les surfaces de mesure ne sont pas du produit, et c'est désormais mesuré.** `public/csp/`,
`public/spike/`, `public/vm/`, la sonde de capacités et leurs contrats sous `src/` sont retirés,
avec motif. `public/spike/origin/` mérite d'être nommé : il contient un document **hostile** et un
Service Worker qui **intercepte**, écrits pour prouver la frontière ; les servir depuis l'origine de
confiance publierait l'adversaire. Une épreuve unitaire exige que tout fichier de `public/` ou de
`src/` soit publié ou exclu — jamais ni l'un ni l'autre.

**L'inventaire porte l'identité des octets, là où le manifeste de volume porte celle des versions.**
Chaque arbre publié embarque l'empreinte SHA-256 de chacun de ses fichiers et une empreinte de
racine **accompagnée** du commit — adressée par contenu, elle ne nomme pas une version : deux
tranches dont aucun octet publié ne diffère la partagent. Les artefacts v86 y sont confrontés à
l'épinglage de l'ADR 0003. C'est ce qui donne prise à `SEC-UPDATE-001` sur ce qui est **servi**, et
non seulement sur ce qui est déclaré. La jonction entre les deux — inscrire l'empreinte de la
coquille dans le manifeste de volume — est une question de **format persistant** que l'ADR 0017 pose
et ne tranche pas.

**Changer l'origine de la coquille est une migration.** OPFS est cloisonné par origine : l'ancienne
devient inatteignable. L'export doit précéder la bascule, la restauration la suivre (ADR 0008, ADR
0009). L'origine figure dans l'inventaire de chaque arbre, si bien qu'une bascule ne peut pas passer
pour un redéploiement au vu des artefacts.

Ce que la chaîne ne fait pas : aucun déploiement réel, aucune signature, aucun SBOM.

**La politique de cache, elle, est décidée** depuis
l'[ADR 0023](decisions/0023-politique-de-cache-par-nature-d-artefact.md) (#103) — par NATURE
D'ARTEFACT, dans la source de vérité, et non plus héritée du serveur de test : `no-cache` pour la
coquille, ses modules, et le manifeste d'épinglage v86, qui changent à chaque version ;
`public, max-age=31536000, immutable` pour les artefacts v86 de l'ADR 0003, depuis que #123 fait
nommer à leur URL leur empreinte (`libv86-<empreinte>.mjs`) — un ré-épinglage les DÉPLACE, si bien
qu'un artefact périmé n'est plus jamais demandé ; `no-store` conservé sur le territoire applicatif,
parce que ce qu'il sert porte les cookies de session du guest. Le fichier `_headers` porte donc
plusieurs blocs, chacun complet, et `Cache-Control` est le seul en-tête dont la valeur dépend du
chemin — le cliquet de publication refuse qu'une seconde dimension se mette à varier. Le mode hors
ligne à deux Service Workers de l'ADR 0002 n'est pas construit pour autant : ce que cette politique
lui permet et lui interdit est écrit dans l'ADR 0023.

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
