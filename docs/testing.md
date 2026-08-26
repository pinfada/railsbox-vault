# Stratégie de test

## Suites disponibles

| Commande                       | Portée                                                                                                      |                                 Coût attendu |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------: |
| `npm run test:unit`            | contrats, logique pure et configuration du lint sous Node                                                   |                                     secondes |
| `npm run test:browser`         | page, Worker dédié, backend OPFS réel et frontière d'origine sous Chromium                                  |                                environ 1 min |
| `npm run test:spike:origin`    | les deux suites de frontière d'origine seules                                                               |                                environ 1 min |
| `npm run test:browser:moteurs` | la suite navigateur sur plusieurs moteurs                                                                   |                                environ 2 min |
| `npm run test:compat`          | sonde de capacités sous Chromium, Firefox et WebKit                                                         |              environ 20 s après installation |
| `npm run test:vm`              | guest Linux réel sur les backends mémoire et OPFS (Chromium), et démarrage du runtime sur les trois moteurs |              environ 1,6 min, **périodique** |
| `npm run test:isolation`       | coût de l'isolation multi-origine sur le runtime v86, trois moteurs                                         |              environ 8 min, **à la demande** |
| `npm run test:csp`             | démarrage de v86 sous deux CSP, quatre configurations, trois moteurs                                        |             environ 25 min, **à la demande** |
| `npm run app:test`             | suite Minitest de l'application Rails de référence, en Docker                                               | environ 1 min après la première construction |
| `npm run test:vm:reference`    | boot à froid réel de l'image de référence sous v86                                                          |   plus de 10 min, Docker et artefacts requis |
| `npm run test:e2e`             | reprise, export vérifiable, restauration inter-origine et migration de format                               |   plus de 20 min, Docker et artefacts requis |
| `npm test`                     | suites unitaire et navigateur                                                                               |                                     secondes |
| `npm run check`                | lint, format et toutes les suites actuelles                                                                 |             moins de 2 min hors installation |

La suite `test:e2e` porte depuis #7 le scénario de sortie du MVP (voir plus bas), auquel se sont
ajoutés l'export vérifiable (#11), la restauration inter-origine (#12) et la migration de format
avec sa reprise après interruption (#13). Depuis #12, sa configuration démarre **deux** serveurs sur
deux origines distinctes : un import ne prouve rien tant qu'il peut relire le stockage qu'il vient
d'écrire. La suite `test:resilience` sera ajoutée lorsqu'elle possédera un premier scénario réel :
un script vide qui réussit ne constitue pas une preuve.

### Backend de blocs OPFS

Le backend de production de `VAULT-PERSIST-001` est prouvé sur **trois** niveaux, et chacun affirme
ce que les autres ne peuvent pas.

| Niveau         | Fichier                                     | Support                     | Rattachement      |
| -------------- | ------------------------------------------- | --------------------------- | ----------------- |
| unitaire       | `tests/unit/vm-opfs-backend.test.mjs`       | double déterministe         | `npm run check`   |
| unitaire       | `tests/unit/vm-sync-access-double.test.mjs` | le double lui-même          | `npm run check`   |
| unitaire       | `tests/unit/vm-opfs-scenarios.test.mjs`     | double déterministe         | `npm run check`   |
| unitaire       | `tests/unit/vm-block-fixture.test.mjs`      | aucun (règle de la fixture) | `npm run check`   |
| unitaire       | `tests/unit/vm-durability-barrier.test.mjs` | chaîne complète + double    | `npm run check`   |
| navigateur     | `tests/browser/opfs-block-backend.spec.mjs` | **vrai OPFS**, Worker dédié | `npm run check`   |
| intégration VM | `tests/vm/opfs-persistence.spec.mjs`        | vrai OPFS + guest Linux     | `npm run test:vm` |
| intégration VM | `tests/vm/opfs-barrier.spec.mjs`            | vrai OPFS + guest Linux     | `npm run test:vm` |
| intégration VM | `tests/vm/boot-trois-moteurs.spec.mjs`      | guest Linux, trois moteurs  | `npm run test:vm` |

**Le niveau unitaire mesure ce que le vrai support refuse de produire.** Aucun navigateur ne rend un
quota, un handle perdu ou une écriture partielle sur demande. Le double
`src/vm/sync-access-double.mjs` le fait, de façon déterministe. Il est lui-même testé, parce qu'un
instrument non calibré invaliderait tout ce qu'il mesure.

**Le niveau navigateur mesure le vrai OPFS.** Il exécute la MÊME sonde de persistance que le niveau
unitaire — `src/vm/opfs-scenarios.mjs` — dans un Worker Chromium : écrire quatre régions dont une
non alignée sur le secteur et une jusqu'au dernier octet du volume, franchir la barrière, **fermer
le handle**, rouvrir sans redéclarer de géométrie, tout relire. Les deux niveaux doivent produire la
même empreinte SHA-256 de volume, `PROBE_VOLUME_DIGEST`. Un écart entre eux serait un résultat.

Cette empreinte n'est pas un binaire versionné : l'image attendue est **reconstruite depuis sa
règle** par `buildProbeImage()`, et `tests/unit/vm-opfs-scenarios.test.mjs` vérifie que la constante
publiée en est bien l'empreinte. La fixture principale suit la convention de la pièce jointe
d'invariant d'`apps/reference/` : bloc `i` de 32 octets valant `SHA-256(label + i)`.

La suite navigateur est rattachée à `npm run check` : **3,4 s mesurées** sous Chromium, aucun
artefact tiers, aucun réseau. Une régression du backend de persistance doit bloquer une PR.

Elle n'accorde aucune indulgence à un moteur sans OPFS synchrone, et elle ne l'ignore pas non plus.
Chaque épreuve commence par mesurer la capacité du Worker — en **ouvrant réellement** un handle, car
une API présente peut refuser à l'exécution — puis :

- **sous Chromium**, la capacité est EXIGÉE. C'est le moteur du contrôle obligatoire : l'y voir
  disparaître doit bloquer une PR, pas faire basculer la suite en mesure négative ;
- **sur un moteur qui la porte**, toutes les assertions s'appliquent. Mesuré le 2026-08-23 :
  Chromium 151 et Firefox 153 exécutent la sonde complète et rendent la même empreinte de volume ;
- **sur un moteur qui ne la porte pas**, la suite exige un refus **typé**
  `VAULT_STORAGE_UNSUPPORTED`. Un plantage non typé, ou pire un succès, la fait échouer. Mesuré :
  WebKit 26.5 de Playwright n'expose `navigator.storage` ni en page ni en Worker, ce que
  [`docs/compatibility.md`](compatibility.md) classe déjà « refusé (OPFS absent) ».

```sh
npm run test:browser:moteurs -- chromium,firefox,webkit   # 15 épreuves, les trois moteurs verts
```

### Budget de stockage : quota, persistance, espace insuffisant

La couche budget de `VAULT-PERSIST-001` (#9) — `src/vm/storage-budget.mjs` et son rendu accessible
`src/vm/storage-budget-messages.mjs` — est prouvée sur **deux** niveaux. Elle ne touche ni OPFS ni
le handle exclusif : elle estime, demande la persistance quand elle existe, et transforme refus,
espace faible, quota dépassé et estimation indisponible en **diagnostics stables**.

| Niveau     | Fichier                                 | Support                            | Rattachement    |
| ---------- | --------------------------------------- | ---------------------------------- | --------------- |
| unitaire   | `tests/unit/vm-storage-budget.test.mjs` | doubles déterministes              | `npm run check` |
| navigateur | `tests/browser/storage-budget.spec.mjs` | **vrai** `navigator.storage`, page | `npm run check` |

**Le niveau unitaire couvre tous les scénarios d'acceptation** avec des doubles déterministes
d'`estimate`/`persist`/`persisted` et des `StorageError` typées de #6 : estimation connue et
inconnue (état `unknown`, jamais zéro capacité), refus de persistance (jamais durable),
avertissement d'espace faible **avant** mutation, quota dépassé pendant write/flush (volume
préservé, ancienne donnée lisible) et absence de fuite de contenu dans le message. Un test de
contrat exige qu'aucune action de récupération publiée ne propose d'effacer, de purger ou de
réinitialiser des données.

**Le niveau navigateur mesure les branches réellement atteignables** sur le vrai
`navigator.storage`, dans la page : estimation réelle, demande de persistance réelle (l'invariant «
un refus n'est jamais durable » tient quel que soit le verdict du moteur sans geste utilisateur),
réservation réelle, et le rendu d'un diagnostic dans un vrai DOM — une erreur en `role="alert"`, un
avertissement en `role="status"`. Les branches d'absence d'API et la vraie saturation du disque
restent prouvées par les doubles : les provoquer réellement dégraderait le moteur ou remplirait le
disque sans rien prouver de plus. Mesuré le 2026-08-24 : **4 épreuves vertes en 3,2 s** sous
Chromium, sans réseau ni artefact.

Cette conduite suit celle des épreuves COOP/COEP de la frontière d'origine : mesurer partout,
asserter là où la capacité existe, et ne jamais rendre vert un relevé qui n'a rien mesuré.

**Le niveau intégration VM mesure ce que le guest en obtient.** `tests/vm/opfs-persistence.spec.mjs`
démarre un vrai guest Linux i386 sur un disque IDE adossé au backend OPFS et vérifie les **deux**
directions du support :

- l'hôte dépose une marque dans le fichier OPFS **avant** le boot, et le guest la relit sur
  `/dev/sda` par un `dd bs=1` — donc à l'octet, sur un offset non aligné du point de vue du guest ;
- le guest écrit sa propre marque avec `conv=fsync`, l'hôte ferme le handle exclusif, rouvre le
  volume et la retrouve.

Une seule direction ne prouverait qu'une moitié : qu'un guest voie le support n'implique pas que ses
écritures y atterrissent. La barrière est comptée **sur l'étape du guest** et non sur le total du
journal, qui inclurait le flush émis par l'hôte avant le boot.

Ce que la barrière du guest garantisse la durabilité **avant** son acquittement — qu'aucune écriture
ne soit annoncée durable avant que le flush OPFS ait rendu la main — est prouvé par #14 :
`tests/unit/vm-durability-barrier.test.mjs` (chaîne complète moins l'émulateur, ordre/latence/fautes
déterministes) et `tests/vm/opfs-barrier.spec.mjs` (guest réel, vrai OPFS). Ce que ces niveaux
n'affirment pas : la reprise d'une application Rails après fermeture complète (#7) ni la politique
de quota côté produit (#9). L'accès concurrent multi-onglets (#8) est désormais couvert (voir « Bail
d'écriture » ci-dessous). Le quota n'est ici qu'un état détecté et nommé.

### Conduite sur refus de persistance

La couche de conduite de `VAULT-PERSIST-001` (#42) — `src/vm/persistence-conduct.mjs` et son rendu
accessible `src/vm/persistence-conduct-messages.mjs` — se pose au-dessus du diagnostic de budget de
#9 (qu'elle importe sans le modifier) et décide de la conduite produit : quand demander la
persistance, ce que la coquille affiche, et quelle promesse de durabilité elle fait. Elle est
prouvée sur **deux** niveaux.

| Niveau     | Fichier                                      | Support                            | Rattachement    |
| ---------- | -------------------------------------------- | ---------------------------------- | --------------- |
| unitaire   | `tests/unit/vm-persistence-conduct.test.mjs` | logique pure                       | `npm run check` |
| navigateur | `tests/browser/persistence-conduct.spec.mjs` | **vrai** DOM + `navigator.storage` | `npm run check` |

**Le niveau unitaire couvre chaque conduite** avec des verdicts déterministes et des verdicts réels
produits par les doubles de #9 : la règle « demander derrière un geste, jamais au chargement », les
cinq états de coquille (consentement requis, durable garanti, attente pendante, poursuite volatile
qualifiée, arrêt), la promesse de durabilité à trois valeurs, la réutilisation réelle du diagnostic
de refus de #9, le refus typé d'un verdict inconnu et l'absence de toute action de suppression.
L'**invariant central** — une durabilité `GARANTIE` n'existe que derrière une persistance réellement
accordée — est éprouvé sur **toutes** les combinaisons de verdict × geste × choix, l'attente
pendante comprise (traitée comme non accordée, donc jamais durable).

**Le niveau navigateur mesure le rendu réel** : l'état de coquille, la promesse de durabilité et le
message accessible (rôle ARIA `status`) sont posés dans un vrai DOM et relus, et l'invariant est
vérifié sur le verdict **réel** rendu par le vrai `navigator.storage` sans geste. Les branches de
logique restent prouvées par le niveau unitaire ; les rejouer dans le navigateur n'apprendrait rien
de plus que le rendu déjà vérifié. La décision complète est
l'[ADR 0006](decisions/0006-conduite-refus-persistance.md).

### Bail d'écriture (multi-onglets)

Le bail d'écriture de `VAULT-PERSIST-002` (#8) est prouvé sur **deux** niveaux : la machine à états
pure sous Node, et le transport réel sur Web Locks et OPFS dans le navigateur.

| Niveau     | Fichier                              | Support                        | Rattachement    |
| ---------- | ------------------------------------ | ------------------------------ | --------------- |
| unitaire   | `tests/unit/vm-write-lease.test.mjs` | horloge et événements injectés | `npm run check` |
| navigateur | `tests/browser/write-lease.spec.mjs` | **vrai Web Locks + vrai OPFS** | `npm run check` |

**Le niveau unitaire mesure la logique.** Il éprouve la machine à états (`src/vm/write-lease.mjs`)
et son arbitre modèle (`src/vm/write-lease-arbiter.mjs`) sur une horloge injectée : transitions
autorisées et interdites, invariant « au plus un écrivain », délai de relais mesuré au tic près,
récupération après crash sans événement de fermeture, refus à l'échéance, absence de contention
entre volumes. Le vrai Web Locks ne laisse contrôler ni le temps ni l'instant d'une mort de contexte
: l'arbitre modèle le fait, déterministiquement.

**Le niveau navigateur mesure le transport réel.** Plusieurs pages du même contexte — donc de la
même origine et de la même partition — se disputent le bail par le vrai Web Locks et le vrai handle
OPFS exclusif, chacune dans son Worker dédié. Aucune VM n'est bootée : la preuve n'exerce que le
bail. Les neuf épreuves couvrent chaque scénario d'acceptation :

- deux onglets simultanés : un seul atteint `detenu`, l'autre reste `attente` ;
- fermeture propre : le second n'atteint `detenu` qu'après avoir **ouvert** le handle exclusif, ce
  qui n'est possible qu'après la fermeture effective du premier ;
- **terminaison brutale** du Worker détenteur (`worker.terminate()`, ni release ni fermeture propre)
  : le waiter récupère le bail ;
- onglet suspendu (détenteur qui ne relâche pas) : le waiter reste `attente`, jamais un second
  écrivain, jusqu'au réveil et à la fermeture propre ;
- volume différent : les deux détiennent en même temps, sans attente ;
- l'UI affiche un état explicite — `attente`, `ecriture`, `lecture-seule`, `conflit`, `erreur` — lu
  dans le DOM, jamais un booléen.

Le délai de relais-ou-refus est **mesuré** par l'horloge monotone du Worker demandeur (injectée dans
le transport via `now`) et joint au rapport Playwright (`bail-relais-delai`, `bail-crash-delai`,
`bail-refus-delai`). Relevé du 2026-08-24 sous Chromium : relais après fermeture propre **15 ms**,
récupération après crash **9 ms**, refus à l'échéance **801 ms** (budget de 800 ms) — tous très en
deçà des 5 s. La suite est rattachée à `npm run check` : **7,1 s mesurées** sous Chromium, aucun
artefact, aucun réseau. Comme la suite OPFS, elle exige la capacité sous Chromium et, sur un moteur
sans OPFS synchrone dans le Worker, se contente d'un refus typé sans asserter le reste.

### Manifeste de volume

Le manifeste versionné de `VAULT-PORT-001`/`VAULT-COMPAT-001` (#10) — `src/vm/volume-manifest.mjs`
et sa famille d'erreurs typées `src/vm/manifest-errors.mjs` — est un **contrat de format** pur. Il
est donc prouvé à un **seul** niveau, unitaire sous Node : ni OPFS, ni navigateur, ni VM ne sont
requis pour éprouver une structure, une sérialisation et une règle de compatibilité.

| Niveau   | Fichier                                  | Support | Rattachement    |
| -------- | ---------------------------------------- | ------- | --------------- |
| unitaire | `tests/unit/vm-volume-manifest.test.mjs` | aucun   | `npm run check` |

Les vingt épreuves couvrent chaque critère d'acceptation : création et gel d'un manifeste v1, refus
des entrées invalides à la création, **sérialisation déterministe** (aller-retour stable octet à
octet et indépendance à l'ordre d'insertion des clés), **parse strict** d'entrées malformées vers
une erreur typée (jamais un objet à moitié valide), tolérance des champs futurs, compatibilité
acceptée, puis les **refus** exigés : format futur (lecture et écriture), format trop ancien,
écriture d'un format antérieur (dont #13 donne désormais la sortie), **downgrade** de runtime,
application étrangère, et **écriture refusée sans identité connue** (`assertVolumeWritable`,
`SEC-UPDATE-001`). La décision complète est l'[ADR 0007](decisions/0007-manifeste-de-volume.md), que
l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) complète pour le format **v2** et sa
règle de downgrade déclarée (§ « Migration de format et reprise »).

Ce niveau suffit parce que le module ne dépend d'aucune capacité que seul un vrai support pourrait
produire : contrairement au backend OPFS (#6), il n'a ni quota, ni handle, ni horloge à éprouver. Le
calcul de l'empreinte du **contenu** du volume, qui exige de lire un vrai volume, arrive avec
l'export (#11), décrit ci-dessous.

### Export vérifiable

L'export portable de `VAULT-PORT-001` (#11) — `src/vm/volume-export.mjs`, son hachage incrémental
`src/vm/sha256-stream.mjs` et sa famille d'erreurs `src/vm/archive-errors.mjs` — est prouvé sur
**deux** niveaux. La décision complète est
l'[ADR 0008](decisions/0008-format-d-archive-d-export.md).

| Niveau       | Fichier                                       | Support                       | Rattachement      |
| ------------ | --------------------------------------------- | ----------------------------- | ----------------- |
| unitaire     | `tests/unit/vm-sha256-stream.test.mjs`        | `crypto.subtle` (calibration) | `npm run check`   |
| unitaire     | `tests/unit/vm-volume-export.test.mjs`        | doubles déterministes         | `npm run check`   |
| Bout en bout | `tests/e2e/export-volume-verifiable.spec.mjs` | **vrai OPFS** + image #5      | job `Reprise MVP` |

**Le niveau unitaire calibre l'instrument puis éprouve le codec.** `sha256-stream` existe parce que
WebCrypto n'offre aucun hachage incrémental et que `node:crypto` est absent du Worker (ADR 0002) :
empreinter un volume à surmémoire bornée exige un hachage incrémental portable. Un instrument se
calibre — la suite le confronte à `crypto.subtle.digest` sur toutes les tailles frontières du
padding et tous les découpages en morceaux, jusqu'à une entrée multi-mégaoctets découpée
irrégulièrement ; un écart, à n'importe quelle frontière de bloc, échouerait. La suite du codec
éprouve l'aller-retour vérifiable, l'empreinte inscrite dans le manifeste (#10), l'archive ≤ 2× la
taille logique, le **streaming borné** (aucune lecture ne dépasse le bloc), la garantie de cohérence
exigée, et les **refus typés** : contenu altéré (`VAULT_ARCHIVE_DIGEST_MISMATCH`), troncature
(`VAULT_ARCHIVE_TRUNCATED`), marqueur/en-tête méconnaissable (`VAULT_ARCHIVE_MALFORMED`), et
incompatibilité de manifeste (`ManifestError` de #10 propagée, jamais reconditionnée).

**Le niveau Bout en bout mesure le vrai support.** `tests/e2e/export-volume-verifiable.spec.mjs`
écrit le disque applicatif de l'image #5 (qui porte l'invariant durable créé par
`bin/vault-fixture`) dans un volume OPFS, l'**exporte en flux** vers une archive OPFS distincte — le
volume est lu via le handle exclusif de #6, point cohérent déclaré —, puis la **vérifie** :
l'empreinte recalculée depuis l'archive égale celle calculée à l'export et celle du manifeste, ce
qui prouve que la copie est byte-exacte et que l'invariant écrit par Rails est capturé fidèlement.
Elle éprouve enfin les refus typés sur une archive **altérée** puis **tronquée**. La plus grande
lecture émise est mesurée et publiée (`reports/e2e/export-verifiable.json`) : elle ne dépasse jamais
le bloc de streaming (4 Mio), preuve déterministe que l'export ne demande jamais tout le volume d'un
coup.

Elle **n'est pas rattachée à `npm run check`** : comme la reprise (#7), elle exige les artefacts de
l'image #5 (`npm run image:build`, Docker). Elle tourne dans le job CI **non bloquant**
`Reprise MVP` (`.github/workflows/reprise.yml`), qui couvre déjà `tests/e2e/**`. Elle n'exige
toutefois **pas** les artefacts v86 ni de boot de guest : l'export s'exerce sur le disque OPFS sans
démarrer la VM.

### Restauration inter-origine

La restauration de `VAULT-PORT-001` (#12) — `src/vm/volume-import.mjs`, sa cible OPFS
`src/vm/opfs-import-target.mjs`, l'ouvreur en écriture `src/vm/opfs-volume-open.mjs` et sa famille
d'erreurs `src/vm/import-errors.mjs` — est prouvée sur **deux** niveaux. La décision complète est
l'[ADR 0009](decisions/0009-restauration-inter-origine.md).

| Niveau       | Fichier                                         | Support                             | Rattachement      |
| ------------ | ----------------------------------------------- | ----------------------------------- | ----------------- |
| unitaire     | `tests/unit/vm-volume-import.test.mjs`          | doubles déterministes               | `npm run check`   |
| unitaire     | `tests/unit/vm-opfs-volume-open.test.mjs`       | doubles déterministes               | `npm run check`   |
| Bout en bout | `tests/e2e/restauration-inter-origine.spec.mjs` | **deux origines** + OPFS + image #5 | job `Reprise MVP` |

**Le niveau unitaire éprouve l'ORDRE des gestes, qui est le contrat.** Une cible en mémoire compte
chaque geste de l'orchestration — ouvertures, fermetures, révocations, inscriptions —, ce qui permet
d'affirmer non pas « la restauration a échoué » mais « la cible n'a même pas été ouverte ». Les
épreuves couvrent : la restauration octet pour octet suivie de l'inscription du manifeste ;
l'absence **totale** de mutation sur archive altérée puis tronquée (les refus de #11 remontent tels
quels) ; le refus d'une cible non vide sans consentement, qui laisse le volume occupant **et son
manifeste** intacts ; l'écrasement consenti ; la relecture divergente qui laisse le volume **non
identifié** (manifeste jamais inscrit) ; le streaming borné en lecture, en écriture et en relecture
; l'espace insuffisant refusé avant toute mutation, avec le `BudgetDiagnostic` de #9 ; la
réservation **nette** sur un écrasement de même géométrie, qui ne doit rien réclamer ; l'estimation
indisponible qui ne bloque pas (l'inconnu n'est pas zéro) ; la géométrie de cible refusée ; la
compatibilité de manifeste contrôlée **par défaut**, sans attente à fournir ; le suffixe `.manifest`
réservé et la longueur de nom bornée, pour qu'un volume créable soit toujours restaurable ; un
voisin illisible **refusé sans être supprimé** ; la `ManifestError` d'identité de #10 propagée sans
reétiquetage ; et l'idempotence de deux restaurations successives.

**Et surtout la DÉFAILLANCE EN COURS de restauration**, qui est le cœur du contrat : une panne est
injectée à chacun des quatre points de rupture — ouverture de la cible, écriture du troisième bloc
(par le `FaultPlan` du dépôt, le même instrument déterministe que le backend de blocs), barrière de
durabilité, inscription du manifeste. À chaque fois la suite exige que le handle exclusif ait été
rendu, que le manifeste reste **absent** et qu'aucun commit n'ait eu lieu. Un cas est traité à part
: une panne à l'**ouverture** doit laisser le manifeste existant intact, puisque aucun octet n'a pu
être écrit — révoquer là rendrait inutilisable un volume parfaitement sain. La reprise d'une
restauration interrompue suit : refusée sans consentement (le refus porte `identified: false`),
reprise avec.

`tests/unit/vm-opfs-volume-open.test.mjs` éprouve l'autre moitié de `SEC-UPDATE-001` : un volume
sans manifeste voisin, appartenant à une autre application, ou dont le voisin est illisible ou
démesuré, n'est **jamais** ouvert en écriture. Le double compte les ouvertures réellement tentées,
ce qui distingue « refusé » de « refusé après coup ».

**Le niveau Bout en bout mesure le changement d'origine RÉEL.** `playwright.e2e.config.mjs` sert
deux origines distinctes au sens du navigateur — `http://127.0.0.1:4177` (A, export) et
`http://localhost:4178` (B, restauration) —, le même procédé que le spike d'origine de l'ADR 0002,
sans DNS ni certificat. Le scénario enchaîne :

- **mutation Rails sur A** — le disque applicatif de l'image #5 est écrit dans un volume OPFS de A,
  Rails y boote, écrit, et ses barrières `fsync` sont acquittées jusqu'à OPFS (#14) ;
- **export** — l'archive vérifiable de #11 est écrite dans l'OPFS de A, et son empreinte est
  confrontée à une empreinte indépendante du volume relu depuis le support ;
- **transfert** — l'archive est **téléchargée** vers le système de fichiers de l'hôte, puis remise à
  B par un `<input type="file">`. C'est le test — et, en production, l'utilisateur — qui la
  transporte : aucun canal inter-origines n'est ouvert, aucune directive de CSP n'est assouplie ;
- **preuve d'isolation, avant l'import** — l'OPFS de B ne connaît ni le volume de A, ni son archive.
  Sans cette vérification préalable, un « import » réussi ne prouverait rien : il pourrait relire un
  stockage déjà présent ;
- **import sur B** — vérification complète avant mutation, restauration en flux, relecture du
  volume, puis inscription du manifeste. La plus grande lecture d'archive et la plus grande écriture
  de volume sont mesurées : elles ne dépassent jamais le bloc de streaming ;
- **boot à froid hors ligne sur B** — le runtime est acquis en ligne, `context.setOffline(true)`
  coupe le réseau (une requête de contrôle échoue alors), puis Rails boote **à froid** sur le volume
  restauré, sans instantané mémoire ; le disque applicatif n'est jamais retéléchargé et toute
  requête de la page reste sur l'origine B ;
- **vérification Rails** — `/vault/invariant` est conforme, et l'identifiant d'enregistrement comme
  l'empreinte SHA-256 de la pièce jointe ActiveStorage sont ceux du contrat
  `apps/reference/vault-invariant.json`. La donnée écrite par Rails sur A est retrouvée, à l'octet
  près, sur une origine qui ne l'avait jamais vue ;
- **quatre témoins négatifs** — une archive dont **un bit** de contenu a été retourné pendant le
  transfert est refusée par `VAULT_ARCHIVE_DIGEST_MISMATCH` et **rien n'est écrit** (la cible
  n'existe toujours pas après le refus) ; une seconde restauration dans le volume déjà restauré est
  refusée par `VAULT_IMPORT_TARGET_NOT_EMPTY`, et le volume valide garde son manifeste et son
  empreinte ; le **manifeste voisin du volume restauré est retiré** — l'état exact que laisserait
  une restauration interrompue — et le boot suivant est alors refusé par
  `VAULT_MANIFEST_UNIDENTIFIED`, avant même que v86 ne démarre ; enfin, demander à la coquille le
  **fichier d'un volume** au lieu d'une archive est refusé par `VAULT_ARCHIVE_MALFORMED`, le Worker
  exigeant le marqueur `RBVAULT1` dans les huit premiers octets (`SEC-ORIGIN-001`).

Les deux derniers témoins comptent autant que le scénario nominal : sans eux, « un volume partiel ne
peut pas passer pour valide » et « l'archive, jamais le volume » ne seraient que des phrases.

Les mesures — origines, empreintes, tailles de bloc, budget, durées — sont écrites dans
`reports/e2e/restauration-inter-origine.json` et jointes au rapport Playwright.

Ce que la suite **n'affirme pas**, délibérément : la portabilité entre deux **appareils** ou deux
systèmes d'exploitation (deux origines servies par le harnais prouvent le cloisonnement OPFS, qui
est la propriété en jeu, pas un transport réseau) ; la **migration** d'un format antérieur, qui a
désormais sa propre suite (#13, § « Migration de format et reprise ») ; l'**authenticité** de
l'archive (jalon 4 : l'intégrité est prouvée, la signature non) ; et l'atomicité d'une génération
sous écriture concurrente (#16).

Elle **n'est pas rattachée à `npm run check`** : elle exige les artefacts de l'image #5
(`npm run image:build`, Docker) **et** ceux de v86 (`npm run vm:fetch`), puisqu'elle boote un guest.
Elle tourne dans le job CI **non bloquant** `Reprise MVP` (`.github/workflows/reprise.yml`), qui
couvre déjà `tests/e2e/**`.

### Migration de format et reprise

La migration de `VAULT-COMPAT-001` (#13) — `src/vm/volume-migration.mjs`, sa cible OPFS
`src/vm/opfs-migration-target.mjs` et sa famille d'erreurs `src/vm/migration-errors.mjs` — est
prouvée sur **deux** niveaux. La décision complète est
l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md).

| Niveau       | Fichier                                         | Support                   | Rattachement      |
| ------------ | ----------------------------------------------- | ------------------------- | ----------------- |
| unitaire     | `tests/unit/vm-volume-migration.test.mjs`       | doubles déterministes     | `npm run check`   |
| unitaire     | `tests/unit/vm-volume-manifest.test.mjs`        | aucun                     | `npm run check`   |
| Bout en bout | `tests/e2e/migration-volume-versionne.spec.mjs` | **OPFS** + image #5 + v86 | job `Reprise MVP` |

**Le niveau unitaire éprouve l'ORDRE des gestes, qui est le contrat.** Une cible en mémoire compte
chaque geste — inspections, ouvertures, fermetures, inscriptions de journal, révocations, commits —,
ce qui permet d'affirmer non pas « la migration a échoué » mais « la cible n'a même pas été ouverte
». Les épreuves couvrent : la chaîne d'un format au **suivant** et le refus d'un saut
(`VAULT_MIGRATION_NO_PATH`) comme d'une descente (`VAULT_MIGRATION_DOWNGRADE_REFUSED`) ; le refus
sans preuve **avant toute ouverture** (`VAULT_MIGRATION_BACKUP_REQUIRED`) ; la sauvegarde
**vérifiée** et non annoncée — archive relue par #11, empreinte confrontée à celle du volume relu
depuis le support, application et taille comparées — avec son refus
(`VAULT_MIGRATION_BACKUP_MISMATCH`) ; une **lecture courte** pendant cette vérification qui ne rend
jamais un verdict conforme ; le journal qui porte son marqueur, sa chaîne et la preuve retenue ; le
journal **illisible refusé sans être supprimé** ; la reprise qui repart du manifeste **source** du
journal **sans redemander la sauvegarde** ; le journal resté derrière un manifeste déjà migré,
simplement retiré (idempotence) — mais **seulement s'il vise bien ce format** ; le manifeste
**relu** divergent qui laisse le volume non identifié ; et les refus de #10 propagés **tels quels**
(volume sans manifeste, application étrangère, format futur).

**Et le fait qu'un journal ne fasse PAS AUTORITÉ**, qui est la seconde moitié du contrat de reprise.
Un journal peut être le reliquat périmé d'un volume détruit puis recréé sous le même nom. Trois
épreuves l'imposent, toutes **avant la moindre ouverture** : un journal qui **contredit le manifeste
présent** est refusé — sans ce contrôle, un journal forgé supplanterait un manifeste sain **et**
tiendrait lieu de preuve de sauvegarde, faisant inscrire une géométrie et une identité inventées ;
un manifeste de départ dont la **géométrie ne décrit pas le support** est refusé
(`VAULT_MIGRATION_GEOMETRY_MISMATCH`) ; un journal **visant un autre format** que celui porté n'est
pas retiré en silence. Chaque fois, la suite exige que la cible n'ait **pas été ouverte**, que le
manifeste reste intact et que le journal ne soit **pas** supprimé. Deux épreuves complémentaires
couvrent l'hygiène : la **création** d'un volume (`vm-opfs-volume-open.test.mjs`) et la
**restauration** depuis une archive (`vm-opfs-import-target.test.mjs`) retirent le journal voisin
périmé, sans quoi un volume neuf resterait non migrable à cause d'un indice qui ne décrit plus rien.

**Et surtout la DÉFAILLANCE EN COURS de migration**, qui est le cœur du contrat : une panne est
injectée à chacun des **cinq** points de rupture — ouverture de la cible, inscription du journal de
reprise, révocation du manifeste, barrière de durabilité, inscription du manifeste cible. À chaque
fois la suite exige que le volume ne soit **jamais présenté comme valide à moitié** et que le handle
exclusif ait été rendu.

Ces cinq pannes coupent **avant** l'effet du geste : rien n'a été modifié sur le support. Un onglet
fermé laisse l'état inverse — le geste a porté, puis la migration s'arrête —, et c'est ce que le
niveau Bout en bout injecte avec `interrompreApres`. Le double unitaire porte donc le **même mode**,
et **trois ruptures supplémentaires** couvrent les états que le premier n'atteint jamais : journal
inscrit alors que le manifeste source est intact ; manifeste cible inscrit mais **jamais relu**, la
reprise devant le constater et aboutir sans redemander de preuve ; et fermeture ratée — seule, ou
par-dessus une erreur antérieure, auquel cas c'est **l'erreur d'origine** qui remonte, la fermeture
lui étant jointe en `cause`. Soit **huit ruptures** couvertes en unitaire.

Côté format, `tests/unit/vm-volume-manifest.test.mjs` éprouve **v2** : `runtime.minWriter` exigé à
partir du format 2, refusé avant, refusé s'il dépasse la version qui écrit (un volume ne s'interdit
pas à son propre auteur), le downgrade jugé par comparaison au `minWriter` **déclaré**, et la règle
v1 conservée pour un manifeste v1 — jamais complétée par une valeur inventée.

**Le niveau Bout en bout enchaîne le résultat entier**, sur un vrai volume OPFS et une vraie
application Rails :

- **volume au format antérieur** — le disque applicatif de l'image #5 est écrit dans un volume OPFS
  portant un manifeste **v1**, et le boot est refusé par `VAULT_MANIFEST_MIGRATION_REQUIRED` :
  lisible, mais pas inscriptible ;
- **migration sans preuve refusée** — `VAULT_MIGRATION_BACKUP_REQUIRED` ; le manifeste v1 est intact
  et **aucun journal n'a été inscrit**, ce qui prouve que la cible n'a pas été ouverte ;
- **sauvegarde** — l'archive vérifiable de #11 est exportée, et son empreinte confrontée à une
  empreinte indépendante du volume relu depuis le support ;
- **migration INTERROMPUE** juste après la révocation du manifeste — l'état exact que laisse un
  onglet fermé. Le volume n'est plus identifié, le journal de reprise subsiste, et le boot suivant
  est refusé par `VAULT_MANIFEST_UNIDENTIFIED` **avant même que v86 ne démarre** ;
- **reprise** — sans fournir de nouveau l'archive : le journal porte la preuve retenue. Le rapport
  affirme `resumed: true`, `fromVersion: 1`, `toVersion: 2`, preuve `sauvegarde-verifiee` ; le
  manifeste est réinscrit et le **journal retiré en dernier geste** ;
- **aucun octet du volume touché** — l'empreinte après migration est identique à celle mesurée
  avant. C'est ce qui distingue « la migration a réussi » de « la migration n'a rien cassé » ;
- **boot à froid hors ligne** sur le volume migré — `context.setOffline(true)` coupe le réseau (une
  requête de contrôle échoue alors), Rails boote sans instantané mémoire, le disque applicatif n'est
  jamais retéléchargé, et `/vault/invariant` retrouve l'identifiant d'enregistrement et l'empreinte
  SHA-256 de la pièce jointe ActiveStorage du contrat `apps/reference/vault-invariant.json` ;
- **refus par une « ancienne version »** — un runtime qui ne connaît que le format 1 refuse le
  volume migré par `VAULT_MANIFEST_FORMAT_TOO_NEW`. Ce témoin n'exerce que l'ouverture **en
  écriture** (`openVolumeForWrite`) : le refus en lecture, qui existe aussi, est prouvé en unitaire
  seulement.

Les mesures — formats avant/après, empreintes, taille et empreinte de la sauvegarde, preuve retenue,
durées, et les quatre refus avec leur code — sont écrites dans
`reports/e2e/migration-volume-versionne.json` et jointes au rapport Playwright.

Ce que la suite **n'affirme pas**, délibérément :

- **le comportement d'une version publiée antérieurement.** Le runtime « ancien » du dernier témoin
  n'est pas un binaire installé : c'est le runtime courant à qui l'on **déclare** une plage de
  formats plus étroite (`supportedFormat: { current: 1, minReadable: 1 }`). Le test prouve que la
  **règle de compatibilité refuse** ; il ne prouve pas ce que ferait une release antérieure,
  qu'aucune publication n'a encore produite. Les **vecteurs de test conservés par version publiée**
  exigés par `docs/release-policy.md` restent à faire ;
- **une migration qui écrirait dans le volume.** L'étape 1 → 2 ne touche que le manifeste. L'ordre
  des gestes est conçu pour qu'une étape future qui écrirait n'ait pas à réinventer sa sûreté, mais
  cette sûreté-là n'est pas encore exercée par une étape réelle ;
- **une chaîne de plus d'un pas.** `planMigration` compose des chaînes plus longues et ses refus
  sont couverts en unitaire, mais aucune migration 1 → 3 n'a tourné sur un vrai volume : le deuxième
  pas n'existe pas ;
- **l'atomicité d'une génération** (#16) : entre la révocation et l'inscription, l'état est **sûr**
  — non identifié, donc non inscriptible — mais pas révocable en un geste ;
- **l'authenticité** du manifeste et du journal (jalon 4) : ni l'un ni l'autre n'est signé ou
  chiffré.

Elle **n'est pas rattachée à `npm run check`** : elle exige les artefacts de l'image #5
(`npm run image:build`, Docker) **et** ceux de v86 (`npm run vm:fetch`), puisqu'elle boote un guest.
Elle tourne dans le job CI **non bloquant** `Reprise MVP` (`.github/workflows/reprise.yml`), qui
couvre déjà `tests/e2e/**`.

### Coût de l'isolation multi-origine

`tests/isolation/cout-isolation.spec.mjs` est le harnais de mesure du spike #41
([ADR 0010](decisions/0010-isolation-multi-origine.md)). Il n'est ni une preuve de comportement ni
une garde de régression de performance : il **mesure**, et n'affirme que ce qui rendrait la mesure
fausse.

Il démarre **deux serveurs simultanés** servant le même contenu — l'un nu, l'autre avec
`--cross-origin-isolated` — puis exécute la même campagne sur les deux, essais **entrelacés** et
ordre inversé un tour sur deux. La raison de l'entrelacement est documentée dans le spike : la
première version mesurait en blocs successifs et rendait un écart qui n'a pas survécu au changement
de protocole.

Ce que la suite affirme :

- le **témoin d'isolation** — la condition nue n'est pas isolée, l'isolée l'est, en page comme dans
  le Worker. Sans lui, deux colonnes identiques ne prouveraient rien ;
- l'**égalité du travail** — écritures et barrières identiques entre les deux conditions, lectures à
  10 % près (la lecture anticipée du noyau invité varie, le spike #4 l'a mesuré) ;
- le fait central de l'ADR 0010 : le runtime v86 épinglé **boote, écrit et franchit sa barrière sans
  isolation**. Si cela cesse d'être vrai, la suite rougit et l'ADR doit être rouvert.

Ce que la suite n'affirme **pas** : un seuil de performance. Un écart mesuré est publié dans
`reports/isolation/cout-isolation-<moteur>.json`, jamais jugé par le harnais.

Un moteur qui ne peut pas porter le runtime rend une **raison typée** plutôt qu'un silence — c'est
ainsi que Firefox et WebKit sont consignés. Le Worker émet un pouls toutes les 250 ms pendant la
mesure, ce qui distingue « le guest ne démarre pas » de « le thread du Worker ne rend plus la main
».

Le protocole fautif que le spike documente est conservé et rejouable — un témoin négatif qu'on ne
peut plus reproduire n'est qu'une anecdote :

```sh
VAULT_MOTEURS=chromium VAULT_ISOLATION_ENTRELACEMENT=non npm run test:isolation
```

Il écrit `reports/isolation/cout-isolation-blocs-<moteur>.json`, distinct du rapport retenu, et le
champ `protocole` nomme le mode employé dans les deux.

Elle est **hors de `npm run check`**, pour les mêmes raisons que `test:vm` : artefacts tiers
téléchargés et vrais guests Linux. `npm run isolation:inventaire` l'accompagne et n'a besoin d'aucun
navigateur : il recense les dépendances à l'isolation dans le code et **dans les artefacts v86
épinglés**, section `memory` du binaire WebAssembly comprise.

### Intégration VM

`tests/vm/durability-barrier.spec.mjs` est la preuve de niveau **intégration VM** du spike #4 : un
guest Linux i386 réel démarre dans un Worker dédié, écrit sur un disque IDE dont le tampon est le
backend de blocs de Vault, puis franchit une barrière de durabilité. La suite affirme deux choses
complémentaires :

- **témoin négatif** — sans le pont de durabilité, le guest classe le disque en `write through` et
  n'émet aucune barrière ; le backend n'en voit aucune ;
- **résultat** — avec le pont, l'ordre écriture → `flush` → acquittement est vérifiable dans le
  journal du backend, barrière par barrière.

Sans le témoin négatif, un test qui ne mesurerait que le cas corrigé ne prouverait pas que la
correction sert à quelque chose.

#### Le démarrage du runtime, sur les trois moteurs

Depuis #74, `tests/vm/boot-trois-moteurs.spec.mjs` exécute le **Worker runtime du produit** —
contrôle préalable et boucle d'ordonnancement compris — sur **Chromium, Firefox et WebKit**, sous la
CSP servie. Il exige quatre faits sur chaque moteur : la boucle en place est celle de Vault, v86 l'a
réellement empruntée (le nombre de tâches reçues est positif), le compteur de tours a dépassé le
tour unique d'un émulateur abandonné, et le guest a écrit puis franchi sa barrière.

`playwright.vm.config.mjs` donne Firefox et WebKit à ce seul fichier. Ce n'est pas de la frilosité :
les autres épreuves de `test:vm` ouvrent un volume OPFS, que WebKit Playwright n'expose pas — elles
y échoueraient pour une raison déjà mesurée et étrangère à l'ordonnancement. Le scénario du témoin,
lui, tient sur un volume en mémoire.

Coût de l'extension : **+35 s environ** (1,6 min contre 1,1 min sur Chromium seul), essentiellement
les 22 s que Firefox met à atteindre l'invite du guest. Le job CI `Intégration VM` installe donc les
trois moteurs.

Un moteur qui ne démarrerait plus fait désormais **rougir la suite**. C'est le changement de nature
apporté par #74 : jusque-là, un moteur qui ne faisait pas battre le runtime était un fait consigné
dans un ADR ; c'est maintenant une épreuve.

Elle **n'est pas rattachée à `npm run check`**, et la raison n'est pas sa durée : les trois épreuves
de barrière tiennent en une vingtaine de secondes, la mesure de premier boot en ajoute une trentaine
et le témoin des trois moteurs une trentaine de plus. La raison est sa dépendance.

`test:vm` exige 9,9 Mio d'artefacts tiers — émulateur, BIOS, image de guest — que `npm run vm:fetch`
télécharge depuis `registry.npmjs.org`, `raw.githubusercontent.com` et `i.copy.sh`. Rattacher la
suite au contrôle obligatoire rendrait toute PR dépendante de la disponibilité de trois hôtes
extérieurs, dont un qui ne publie pas d'empreinte de son côté. Un contrôle bloquant qui rougit parce
qu'un CDN tiers est indisponible n'apprend rien sur la PR.

Elle tourne donc dans un job CI dédié et **non bloquant** (`.github/workflows/vm.yml`), déclenché
manuellement et chaque nuit.

Depuis #6 elle porte aussi `tests/vm/opfs-persistence.spec.mjs`, donc une preuve de persistance
réelle du produit. Depuis #14 elle porte enfin `tests/vm/opfs-barrier.spec.mjs`, qui démontre sur le
vrai OPFS l'ordre causal write → flush(OPFS réel) → acquittement, le cas du flush retardé (le guest
reste occupé jusqu'à la résolution) et le cas du flush en échec (la commande est abandonnée, rien
n'est acquitté). La condition restante pour rendre `test:vm` bloquante n'est pas la nature de ces
preuves mais leur dépendance : tant que les artefacts viennent de trois hôtes tiers, un contrôle
obligatoire rougirait pour des raisons étrangères à la PR. Le cœur de la barrière durable est donc
aussi prouvé **sans artefact** par `tests/unit/vm-durability-barrier.test.mjs`, rattaché à
`npm run check` : une régression de l'ordre ou de la latence de barrière bloque une PR. La preuve de
niveau navigateur du backend OPFS, elle, **est** également bloquante — elle n'a besoin d'aucun
artefact.

```sh
npm run vm:fetch     # récupère et vérifie les artefacts v86 (empreintes SHA-256)
npm run test:vm
npm run vm:protocol  # protocole de mesure complet sous Node, écrit reports/vm/protocole.json
```

`npm run vm:check` vérifie les empreintes sans réseau et échoue si un artefact manque ou diffère. Il
porte en outre la garde de l'ADR 0010 : un `v86.wasm` déclarant ou important une mémoire WebAssembly
partagée le fait échouer avec le code 2 — voir
[`docs/development.md`](development.md#monter-v86-de-version). Les mesures de référence du spike
sont figées dans [`docs/spikes/0004-backend-de-blocs-v86.md`](spikes/0004-backend-de-blocs-v86.md).

### Application Rails de référence

`npm run app:test` exécute la suite Minitest d'`apps/reference/` dans une image Docker épinglée par
digest (`ruby:3.3.12-slim-bookworm`). Elle couvre le contrat d'invariant, le modèle porteur de
l'UUID, la commande `bin/vault-fixture` — exécutée comme un **processus**, avec ses vrais codes de
sortie —, les deux routes JSON, l'absence de secret et les pragmas de durabilité SQLite.

Deux précautions la rendent opposable :

- **les pragmas sont interrogés sur la connexion réelle**, pas relus dans `database.yml`. Une ligne
  de configuration non appliquée est indiscernable d'une ligne absente ;
- **la commande de fixture est lancée sans `bundle exec`** et sans hériter du `RUBYOPT` du processus
  de test, parce que c'est ainsi que la construction du disque l'appelle. La première construction a
  précisément échoué sur cette différence.

Ce que la suite **n'affirme pas** : le comportement sous i386. Son image est amd64, choisie pour que
la boucle de développement reste en minutes. La preuve i386 est le rôle de `test:vm:reference`, et
d'elle seule.

Elle n'est pas rattachée à `npm run check` : elle exige Docker, que `docs/development.md` ne pose
pas en prérequis du contrôle obligatoire. Elle est exécutée à chaque exécution du contrôle
`Image de référence`, déclenché par toute modification d'`apps/**` ou de la chaîne de construction.

### Boot réel de la VM : `test:vm:reference`

`npm run test:vm:reference` boote **réellement** l'image de référence sous v86, dans Node, sans
instantané, et interroge Rails par le port série. Elle vérifie que la route de santé annonce les
versions du manifeste et que `/vault/invariant` rend le verdict `conforming` avec le digest de pièce
jointe attendu.

Trois règles la gouvernent :

- **elle ne réussit jamais sans avoir booté.** Si le manifeste ou les artefacts sont absents, elle
  se déclare `skipped` avec la raison exacte et la commande à lancer ; elle ne rend jamais un succès
  qui n'a rien mesuré ;
- **un artefact présent mais différent du manifeste est un échec**, pas une indisponibilité : le
  manifeste est la référence versionnée, et booter autre chose que ce qu'il décrit ne prouverait
  rien ;
- **la mesure est publiée**, dans `reports/vm/reference-boot.json` (dossier ignoré par git, archivé
  en artefact de CI).

Elle **n'est pas** rattachée à `npm run check`, et ce n'est pas un compromis de confort : un boot à
froid dépasse les dix minutes, la suite exige Docker et environ un gigaoctet d'artefacts construits,
et `docs/quality-attributes.md` lui accorde explicitement un budget de 15 minutes au p95. La
rattacher ferait passer `npm run check` de deux minutes à plus d'un quart d'heure sur chaque PR, y
compris celles qui ne touchent ni l'application ni l'image.

Sa périodicité est donc la suivante : elle s'exécute à chaque modification de `apps/`, de
`tools/build-reference-image/`, de `tools/vm/` ou de `tests/vm/`, par le contrôle GitHub
`Image de référence`, qui construit l'image puis la boote. Ce contrôle n'est pas obligatoire pour la
protection de branche — sa durée le rendrait bloquant pour des PR qui ne le concernent pas — mais un
échec y est traité comme un échec de `npm run check`.

### Reprise d'une mutation Rails : `test:e2e`

`npm run test:e2e` est le test du **niveau le plus élevé** du dépôt et le scénario de **sortie du
MVP** (#7, `VAULT-PERSIST-001`). Une vraie application Rails boote dans Chromium sur un disque
adossé à OPFS, on ferme la page, son Worker et ses handles, **on coupe le réseau**, et un **boot à
froid** depuis le même volume OPFS la retrouve. Il assemble les acquis sans les réinventer : image
de référence #5, backend OPFS #6, barrière durable #14, console série #54.

Le point technique dur de #7 est d'adosser le disque applicatif de v86 à OPFS **en écriture**. Il
est traité côté données : la phase `prepare` écrit le disque `reference-app.ext2` de l'image #5 dans
un volume OPFS neuf, en flux, sans jamais tenir 512 Mio en mémoire. Ce volume est ensuite servi à
v86 comme `hdb` (`/dev/sdb`) par l'adaptateur de tampon (#4). Le rootfs, lui, reste un tampon en
lecture servi comme `hda`. Les écritures de Rails — SQLite en `synchronous = full`, ActiveStorage —
atteignent donc réellement OPFS, et leurs barrières `fsync` sont propagées jusqu'au flush OPFS par
le pont de durabilité (#14). Le guest n'a pas de réseau émulé : la vérification passe par le pont
série `@VLT1`.

Le scénario, tel que `tests/e2e/reprise-mutation-boot-froid.spec.mjs` l'affirme :

- **boot à chaud** — Rails répond à `/vault/health`, `/vault/invariant` est conforme, et le journal
  du backend montre des écritures **et** au moins une barrière `flush` acquittée : des octets de
  Rails ont bien atteint OPFS avec une barrière durable, pas seulement un tampon ;
- **fermeture complète** — chaque phase s'exécute dans une **page neuve** ; la fermer ferme son
  Worker et rend le handle OPFS exclusif ;
- **boot à froid hors ligne** — le runtime (wasm, noyau, initrd, rootfs) est acquis pendant que la
  page est en ligne, puis `context.setOffline(true)` **coupe le réseau** — une requête sortante de
  contrôle échoue alors —, et le boot à froid + la vérification s'exécutent **réseau coupé**, depuis
  le runtime en mémoire et le disque applicatif dans OPFS. Le disque applicatif n'est **jamais**
  retéléchargé et toute requête de la page reste sur la coquille locale : la donnée retrouvée ne
  traverse pas le réseau ;
- **aucun instantané mémoire** — il n'existe aucun chemin de snapshot dans le Worker (`get_state` /
  `set_state` de l'adaptateur sont refusés, #4), et chaque reprise est un boot complet mesuré en
  dizaines de secondes, non une restauration instantanée ;
- **persistance byte-exacte** — la pièce jointe ActiveStorage de l'invariant (4096 octets, digest
  SHA-256 connu) est rendue durable et retrouvée à l'identique après chaque boot à froid. La preuve
  porte sur l'état **rendu durable** : la barrière de #14 ne garantit que ce qui a franchi un flush,
  et l'invariant est flushé dès la phase `prepare`. Les écritures de boot non flushées de Rails ne
  sont, elles, pas garanties de survivre — c'est exactement la distinction de `SEC-DURABLE-001` ;
- **≥ 3 reprises**, et un **témoin négatif** : un volume OPFS vide ne rend jamais l'invariant, ce
  qui prouve que la reprise dépend du contenu d'OPFS et non du réseau ou de l'artefact resservi.

Les mesures — temps de reprise p50/p95, mémoire du tas JS, tailles transférées et du volume — sont
écrites dans `reports/e2e/reprise-boot-froid.json` (dossier ignoré par git, archivé en artefact de
CI) et jointes au rapport Playwright. Depuis #60, le rapport porte aussi une **décomposition** du
temps de reprise (`repriseTimeline`, un objet par reprise) : jalons `performance.now()` côté hôte et
repères lus dans le flux série brut du guest (montage de `/dev/sdb`, lancement de Puma, pont série
actif). Chaque durée horodate un événement réellement observé ; un jalon jamais atteint reste
`null`, jamais estimé. Elle sert l'[ADR 0005](decisions/0005-qualification-de-la-reprise.md), qui
montre que le boot de Puma/Rails domine (~79 %) et que le montage OPFS est négligeable (~65 ms). La
cible de `docs/quality-attributes.md` est une reprise p95 ≤ 60 s ; un dépassement n'échoue pas la
suite (il a exigé l'ADR 0005), mais l'absence totale de mesure, elle, serait un échec.

Ce que la suite **n'affirme pas**, délibérément : une mutation **initiée par l'utilisateur au cours
de la session** via HTTP. L'application #5 n'expose que deux routes en lecture (`/vault/health`,
`/vault/invariant`) et aucune route d'écriture ; la « mutation » prouvée est donc l'état persistant
**écrit par Rails** (l'invariant, produit par `bin/vault-fixture create` à la construction, plus les
écritures de boot de Puma, SQLite et ActiveStorage) retrouvé après fermeture complète et boot à
froid. Prouver une écriture utilisateur intra-session — une route de mutation, ou une commande
passée au guest par le pont série — est le sujet d'une issue de suivi.

Elle **n'est pas rattachée à `npm run check`**, pour les mêmes raisons que `test:vm:reference` : un
boot à froid dépasse les dix minutes, la suite exige Docker et environ un gigaoctet d'artefacts
construits (`npm run image:build`) plus les artefacts v86 (`npm run vm:fetch`). Elle tourne dans un
job CI dédié et **non bloquant** (`.github/workflows/reprise.yml`), déclenché manuellement, chaque
nuit, et sur toute PR touchant `src/vm/`, `public/vm/`, `tests/e2e/`, `playwright.e2e.config.mjs` ou
`tools/serve.mjs`. Un échec y est traité comme un échec de `npm run check`.

```sh
npm run image:build   # image de référence (#5), Docker requis
npm run vm:fetch       # artefacts v86 vérifiés par empreinte
npm run test:e2e       # scénario complet sous Chromium
```

#### Le support des scénarios : un profil de navigateur PERSISTANT

Les quatre scénarios de `tests/e2e/` tirent leur contexte de
[`tests/e2e/contexte-persistant.mjs`](../tests/e2e/contexte-persistant.mjs) et non de la fixture
`context` par défaut de Playwright. La raison n'est pas cosmétique.

`browser.newContext()` crée un profil **hors enregistrement** — un profil « navigation privée » —,
et Chromium n'adosse alors **pas OPFS à un disque**. Mesuré sur ce dépôt le 26/08/2026, sonde
d'échantillonnage pendant le scénario d'export :

| Contexte                                     | Écrit dans OPFS | Variation du disque pendant le scénario |
| -------------------------------------------- | --------------- | --------------------------------------- |
| `browser.newContext()` (hors enregistrement) | > 1 Gio         | **< 1 Mio**                             |
| `chromium.launchPersistentContext()`         | > 1 Gio         | **≈ 1,0 Gio**, rendue à la fin          |

Deux conséquences, toutes deux corrigées par le passage au profil persistant.

D'abord, **la preuve portait sur un support qui n'est pas celui du produit**. `VAULT-PERSIST-001`
promet une reprise depuis un volume OPFS, et un utilisateur exécute Vault dans un profil ORDINAIRE,
dont l'OPFS est sur disque. Ce que les scénarios établissaient reste vrai — la donnée survit à la
fermeture de la page, du Worker et des handles — mais elle le faisait contre un support qui n'écrit
rien sur disque, ce qui est une promesse plus étroite que celle affichée.

Ensuite, **le support qui refusait n'était pas celui que l'on mesurait**, et c'est la cause de
l'issue #73 : `FILE_ERROR_NO_SPACE` était rendu pendant que `navigator.storage.estimate()` —
calculé, lui, sur le disque — annonçait **exactement 3 Gio** disponibles, trois refus de suite et
quel que soit l'usage courant. La valeur publiée par `estimate()` est arrondie (une valeur exacte
renseignerait une empreinte de machine) : elle ne décrit pas le support, et ne peut servir de seuil.
Que la ressource épuisée soit la mémoire est l'inférence qui reste — déduite du support et du code
d'erreur, non mesurée directement ; l'ADR 0012 le dit sous « Limites ».

Le même contraste se relit **sur l'exécutant CI**, où l'échantillonnage continu mesure le disque du
runner pendant le job complet : le run `32903478142` (profil hors enregistrement) déplace **0,03
Gio** pendant les scénarios, le run `32907545747` (profil persistant) en déplace **3,03 Gio**. Les
scénarios écrivent enfin ce qu'ils prétendent écrire, là où ils prétendent l'écrire.

Le profil vit dans le répertoire de sortie du test, donc **un par test** : l'isolation entre
scénarios est celle d'avant, et le cloisonnement d'OPFS par origine (ADR 0002) reste celui du
navigateur. Aucune assertion n'a été modifiée pour ce changement.

La décision complète, ses mesures et ses limites — notamment ce qui n'est **pas** affirmé de
Chromium — sont dans l'[ADR 0012](decisions/0012-support-des-scenarios-de-bout-en-bout.md).

#### Empreinte de stockage et diagnostic publié

La suite est de loin la plus gourmande du dépôt, et l'espace qu'elle consomme n'est pas celui du
dépôt : c'est celui du **profil de navigateur**. Chaque scénario écrit dans OPFS un volume
applicatif de 512 Mio ; l'export lui adjoint une archive de la même taille, la migration une
sauvegarde, et la restauration écrit autant sur une **seconde origine**. Il faut compter environ **1
Gio par scénario** en pic, auquel s'ajoutent, sur le disque de l'exécutant, les 927 Mio d'artefacts
de l'image de référence et les couches Docker de sa construction (≈ 2,9 Go mesurés en CI).

Trois mesures partent avec les artefacts du job, et servent à trancher plutôt qu'à supposer :

| Fichier                                | Contenu                                                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports/e2e/espace-disque.jsonl`      | une ligne par étape nommée de la recette : espace de chaque point de montage, mémoire de l'hôte, taille des répertoires d'artefacts, occupation de Docker |
| `reports/e2e/espace-pendant-e2e.jsonl` | le même relevé **toutes les cinq secondes pendant** les scénarios — une mesure avant et une après ne disent rien d'une ressource qui s'épuise au milieu   |
| `reports/e2e/export-verifiable.json`   | champ `stockage` : `navigator.storage.estimate()` avant et après l'écriture de l'archive                                                                  |

À quoi s'ajoute le contexte d'un refus : celui d'une `StorageError` — demandé, rendu, errno, offset,
quota, usage — traverse `postMessage` puis `page.evaluate` jusqu'au journal de CI.

Aucune de ces mesures ne conditionne un verdict : elles ne décident rien et ne font jamais échouer
la recette. Elles existent pour qu'un échec de support arrive **nommé et daté**, au lieu d'arriver
sous la forme d'une phrase à interpréter.

### Configuration du lint

`tests/unit/eslint-config.test.mjs` traite `eslint.config.mjs` comme un contrat testable. Il charge
la configuration réelle du dépôt via l'API `ESLint` et lint des sources témoins présentées sous des
chemins **virtuels** — aucun fichier n'est déposé dans l'arborescence — pour vérifier qu'un global
Node est refusé sous `public/` et `src/`, qu'un global DOM est refusé sous `tools/`, `tests/unit/`
et dans un module Worker, et que chaque contexte conserve les siens. La répartition attendue est
décrite dans [`docs/development.md`](development.md).

Cette suite est rattachée à `npm run test:unit`, donc à `npm run check` : son coût est de quelques
centaines de millisecondes et une régression de configuration doit bloquer une PR. `npm run lint`
seul ne le ferait pas, puisqu'un jeu de globals trop large ne produit aucun avertissement.

### Frontière d'origine

`tests/browser/origin-topology.spec.mjs` et `tests/browser/origin-isolation.spec.mjs` sont la preuve
de sécurité de `SEC-ORIGIN-001` (ADR 0002). Elles sont rattachées à `npm run check` plutôt que
périodiques : elles durent moins d'une minute, ne demandent aucune image VM, et une régression de
frontière doit bloquer une PR, pas être découverte à la recette suivante.

Elles exigent **deux serveurs**, donc deux origines réelles ; `playwright.config.mjs` les démarre
tous les deux. Trois précautions les rendent opposables :

- un **témoin positif** en même origine, qui exige que les mêmes tentatives aboutissent ;
- l'**arbitrage depuis la coquille** pour tout ce qui concerne la persistance et l'interception, car
  une sonde applicative ne sait pas dans quelle partition elle a écrit ;
- un troisième résultat `indisponible`, distinct de `bloque`, pour une capacité absente du moteur.

Leurs mesures sont **jointes** au rapport Playwright (`releve-…`, `navigation-…`, `isolation-…`,
`coep-…`), jamais imprimées sur la sortie standard : un relevé brut recopié à chaque `npm run check`
polluerait le journal de toutes les PR. Pour les consulter :

```sh
npx playwright test tests/browser/origin-topology.spec.mjs --reporter=html
npx playwright show-report
```

La CI n'archive le rapport qu'en cas d'échec, ce qui suffit à diagnostiquer une régression : les
mesures de référence du spike sont figées dans `docs/spikes/0035-topologie-origine-de-confiance.md`.

### Plusieurs moteurs

```sh
npx playwright install firefox webkit
npm run test:browser:moteurs -- chromium,firefox,webkit
```

Le script pose `VAULT_MOTEURS` sans dépendre de la syntaxe du shell. Les épreuves COOP/COEP mesurent
sur tout moteur mais n'assertent que sous Chromium : les écarts constatés sont consignés dans
`docs/spikes/0035-topologie-origine-de-confiance.md`, et la matrice de support reste l'objet de
l'issue #2. La commande reste manuelle : `npm run check` exécute la frontière d'ORIGINE sous
Chromium seulement. La couverture multi-moteurs de la CI passe par `test:compat` et, depuis #52, par
les projets `frontiere-csp-<moteur>` décrits ci-dessous, qui exécutent la frontière de CSP et le
diagnostic du runtime sur les trois moteurs à chaque `npm run check`.

### Frontière de CSP et diagnostic du runtime

`tests/browser/csp-frontiere.spec.mjs` et `tests/browser/runtime-diagnostic.spec.mjs` sont la preuve
de la CSP de la coquille (ADR 0013, #52). Elles sont rattachées à `npm run check` — environ 19 s
mesurées pour les vingt et une épreuves — et exécutées sur **chromium, firefox et webkit** par des
projets dédiés de `playwright.config.mjs`, indépendamment de `VAULT_MOTEURS` : une politique de
sécurité ne s'applique pas de la même façon d'un moteur à l'autre, et l'asserter sur un seul
publierait une garantie que les deux autres ne tiennent peut-être pas.

Elles n'ont besoin d'aucun artefact v86 : le contrôle préalable du Worker runtime précède le
chargement des artefacts, et les sondes de CSP n'instancient qu'un module WebAssembly vide.

Ce qu'elles établissent, dans les deux sens :

- **admis** — `WebAssembly.instantiate` réussit sous la politique servie, et un Worker de l'origine
  vit. Ce sont les témoins positifs : sans eux, un relevé « tout refusé » ne prouverait qu'un banc
  cassé ;
- **refusé** — un Worker `blob:`, un script `blob:`, un script `data:` et un script inline ne
  s'exécutent pas ; et sur une page portant en plus
  `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`, l'instanciation
  WebAssembly est refusée, ce qui rend `'wasm-unsafe-eval'` falsifiable sans toucher au serveur ;
- **diagnostiqué** — un Worker runtime chargé sans `?use-scheduling-api` rend un
  `VAULT_RUNTIME_WORKER_REFUSED` en quelques secondes, avec la raison exacte du repli, au lieu du
  silence que #52 décrivait.

Un point de méthode qui a coûté une mesure fausse : sous `worker-src 'self'`, Chromium ne lève
**aucune** exception à la construction d'un Worker `blob:` refusé — il rend un objet inerte. Les
sondes mesurent donc le SIGNE DE VIE (un message reçu dans un délai borné) et le journal des
événements `securitypolicyviolation`, jamais l'absence d'erreur.

### Démarrage de v86 sous deux CSP : `test:csp`

`tests/csp/ordonnancement-v86.spec.mjs` est le harnais de MESURE qui a tranché l'ADR 0013. Il lève
deux serveurs servant le même contenu, dont la CSP ne diffère que par `worker-src`, et croise les
deux politiques avec quatre configurations du contexte du Worker. Le Worker de mesure
(`public/csp/ordonnancement-worker.mjs`) ne vérifie **aucun** prérequis, délibérément : il démarre
v86 quoi qu'il arrive, pour observer la panne au lieu de la postuler.

Depuis #74, ce Worker n'écrit plus sa propre cale d'ordonnancement : il appelle
`src/vm/scheduling-loop.mjs`, le module livré dans les Workers runtime. Le harnais mesure donc le
code du produit et non une réplique — sans quoi ses relevés pourraient rester verts pendant que la
boucle livrée diverge. Ses deux modes (poser la boucle toujours, ou seulement si le moteur n'expose
pas l'API) restent ce qui distingue les deux dernières lignes de son tableau.

Le fait publié est le compteur de tours de v86 (`session.ticks()`). Figé, la boucle n'a jamais battu
; positif, elle bat et un non-démarrage a une autre cause. Rien d'autre ne sépare ces deux
diagnostics.

Le harnais **n'est pas rattaché à `npm run check`** : il exige les artefacts de `npm run vm:fetch`
et démarre de vrais guests Linux, dont plusieurs atteignent volontairement leur délai de garde.
Compter environ 25 minutes pour les trois moteurs. Il écrit `reports/csp/<moteur>.json`, et il
n'asserte que deux choses — que chaque relevé existe, et qu'au moins le moteur de référence fasse
battre l'émulateur dans la configuration retenue. Un moteur qui ne démarre pas est un fait de
compatibilité, consigné dans l'ADR, pas une régression du dépôt.

## Suite de compatibilité

`npm run test:compat` exécute la sonde `src/compat/` dans une page servie par `tools/serve.mjs` puis
dans un Worker dédié de type module, sur les trois moteurs Playwright. Elle utilise une
configuration distincte, `playwright.compat.config.mjs`, pour trois raisons :

- elle vise trois moteurs alors que `test:browser` reste volontairement sur Chromium ;
- elle a besoin d'un serveur servi avec `--cross-origin-isolated`, condition nécessaire pour mesurer
  `SharedArrayBuffer` et `Atomics.wait` ; le harnais de base ne doit pas changer de conditions ;
- elle écrit ses artefacts ailleurs (`test-results/compat`) pour ne pas écraser ceux du harnais.

Son serveur écoute sur le port 4180 et n'est **jamais** réutilisé : un rapport de compatibilité doit
provenir de la page du dépôt, servie avec les en-têtes d'isolation attendus. Si le port est déjà
occupé, la suite échoue immédiatement au lieu de mesurer un serveur étranger.

Ce que la suite affirme :

- le rapport respecte le schéma de `src/compat/capability-contract.mjs`, validé par une fonction
  pure elle-même couverte par `tests/unit/compat-contract.test.mjs` ;
- chaque capacité déclarée reçoit un verdict et un détail non vide ;
- le verdict Vault du rapport est cohérent avec les verdicts de capacités.

Ce que la suite n'affirme pas : **la présence d'une capacité**. Une capacité absente, refusée ou en
erreur ne fait jamais échouer la suite ; elle est enregistrée telle quelle. Seuls un rapport
malformé, une sonde qui plante ou une erreur de page non capturée provoquent un échec.

Chaque exécution écrit `reports/compat/<moteur>.json` (dossier ignoré par git) et attache le même
contenu au rapport Playwright. La CI archive `reports/compat/` en artefact à chaque exécution.

La suite est rattachée à `npm run check` : son coût mesuré est d'environ 20 s. Depuis l'ajout de la
frontière d'origine, l'ensemble de `npm run check` tient en un peu plus d'une minute en local, sous
la limite de 2 min (86 s mesurées en CI le 2026-08-23). Elle exige que les trois moteurs soient
installés (voir `docs/development.md`).

## Preuve rouge

Pour une implémentation TDD, la PR indique :

- le commit contenant le test avant l'implémentation ;
- la commande exécutée ;
- l'échec attendu et sa cause ;
- le commit qui rend la même commande verte.

Il n'est pas demandé de pousser un état rouge sur `main`. Les PR de documentation, spikes et audits
utilisent leurs preuves propres.

## Données de test

Les tests emploient uniquement des données synthétiques, déterministes et versionnées. Les scénarios
de corruption conservent une graine de reproduction.

La pièce jointe de l'invariant, `apps/reference/invariant/invariant.bin`, est le seul binaire
versionné du dépôt. Elle n'est pas arbitraire : ses 4096 octets sont la concaténation de 128 blocs
de 32 octets, le bloc `i` valant `SHA-256("railsbox-vault-reference/invariant/" + i)`. La règle est
publiée dans `apps/reference/vault-invariant.json` et **réappliquée** par
`apps/reference/test/lib/contract_test.rb`, qui compare le résultat au fichier commité : un octet
modifié dans le dépôt fait échouer la suite, sans qu'il faille faire confiance à une empreinte
recopiée à la main.

## Navigateurs

Chromium reste le moteur du harnais `test:browser`. La matrice de support du produit est établie par
`test:compat` sur Chromium, Firefox et WebKit, et publiée dans
[`docs/compatibility.md`](compatibility.md) avec sa date, son système et ses versions. Le projet
`webkit` de Playwright ne constitue pas à lui seul une qualification Safari : cette limite est
expliquée dans la même page.
