# Attributs de qualité et budgets

Les budgets sont des seuils d'acceptation révisables par ADR, pas des promesses marketing. Toute
mesure publie machine, navigateur, volume, nombre d'essais et percentile ; une moyenne seule ne
suffit pas.

## Environnement de référence initial

- poste de bureau 4 cœurs physiques, 16 Gio de RAM ;
- profil navigateur neuf, alimentation secteur ;
- réseau limité à 100 Mbit/s pour le premier chargement ;
- application et jeu de données synthétiques de référence définis par #5, figés ci-dessous ;
- 10 essais après un échauffement, résultats p50 et p95.

Toute autre machine est publiée séparément et ne remplace pas cette référence.

## Fixture de référence figée

L'issue #5 a figé la fixture. Elle est décrite par deux fichiers commités, et par eux seuls :

| Fichier                                     | Ce qu'il fige                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/reference/vault-invariant.json`       | identité de l'application, UUID de l'invariant, empreinte et règle de dérivation de la pièce jointe |
| `tools/build-reference-image/manifest.json` | artefacts produits : nom, taille, empreinte SHA-256, licence, origine, versions de la chaîne        |

Caractéristiques exactes :

| Élément              | Valeur                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| Identifiant          | `railsbox-vault-reference`, version `1.0.0`                                  |
| Enregistrement       | un seul, UUID v4 figé `f2b2a4e0-6a5f-4a3c-9c1a-1d0a5b8e7c31`, clé primaire   |
| Champs déterministes | `label`, `payload`, `sequence`, `recorded_at` figé au `2026-01-01T00:00:00Z` |
| Pièce jointe         | ActiveStorage sur disque local, 4096 octets, SHA-256 publié                  |
| Base                 | SQLite, `journal_mode = delete`, `synchronous = full` (ADR 0004)             |
| Ruby / Rails         | 3.3.12 / 8.1.3.1, épinglés dans `Gemfile.lock`                               |
| Guest                | Debian bookworm i386, noyau `linux-image-686`, boot direct bzImage + initrd  |
| Mémoire VM           | 512 Mio                                                                      |

Le jeu de données est **synthétique et reproductible** : les 4096 octets de la pièce jointe sont la
concaténation de 128 blocs `SHA-256("railsbox-vault-reference/invariant/" + i)`, règle publiée dans
le contrat et réappliquée par la suite Minitest.

Ce que la fixture ne contient pas, délibérément : aucun secret, aucune donnée réelle, aucune
fonction applicative. Elle mesure la persistance et rien d'autre.

### Mesures initiales de la fixture

Relevé du 2026-08-23 sur la machine de développement — **ce n'est pas l'environnement de référence
ci-dessus**, et ces chiffres ne valent donc que comme ordre de grandeur et point de comparaison :

| Élément   | Valeur                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| Machine   | Windows 11, Node 24.14.0, Docker Desktop 29.4.3, 28 threads logiques, 32 Gio          |
| Émulateur | v86 0.5.432 sous Node, disque en mémoire, VM à 512 Mio                                |
| Protocole | `node tools/vm/mesurer-boot.mjs --essais=4`, chaque essai depuis un boot à froid neuf |
| Brut      | `reports/vm/mesures-boot.json`                                                        |

**Taille des artefacts**

| Artefact                     |  Sur disque | Compressé (gzip) |
| ---------------------------- | ----------: | ---------------: |
| `reference-rootfs.ext4`      |     367 Mio |          127 Mio |
| `reference-app.ext2`         |     512 Mio |           43 Mio |
| `reference-rootfs-initrd`    |    24,1 Mio |   déjà compressé |
| `reference-rootfs-vmlinuz`   |     5,4 Mio |       non mesuré |
| `seabios.bin`, `vgabios.bin` |    0,16 Mio |       non mesuré |
| **Total**                    | **927 Mio** |    **≈ 200 Mio** |

**Temps de boot à froid jusqu'à `GET /vault/health`** — 4 essais : 96 s, 119 s, 91 s, 90 s. **p50 =
91 s, p95 = 119 s**, pour un budget « premier boot de preuve p95 ≤ 15 min ». Le p95 est ici la
valeur maximale des quatre essais : avec si peu d'essais, la méthode du plus proche rang ne peut
rien affirmer de plus fin, et c'est le sens conservateur.

**Mémoire** — pic de RSS du processus hôte Node : 940 Mio au premier essai, depuis une base de 56
Mio. Le budget prototype (≤ 1,5 Gio) est tenu, mais deux réserves valent d'être dites : la mesure
porte sur **Node**, pas sur un navigateur, et les essais suivants du même processus héritent de la
mémoire non encore rendue par le ramasse-miettes — leurs pics (jusqu'à 1227 Mio) ne sont donc pas
des mesures indépendantes. Seul le premier essai est propre.

Ces chiffres ne remplacent pas l'environnement de référence : la machine a 28 threads logiques et 32
Gio, non 4 cœurs et 16 Gio, et le protocole demande 10 essais après échauffement. Ils sont publiés
comme point de départ mesuré, pas comme relevé de référence.

Trois réserves, à ne pas perdre de vue quand ces chiffres seront comparés à d'autres :

- le boot mesuré utilise le **disque en mémoire** de v86, pas le backend de blocs OPFS (#4, #6). Le
  temps de boot d'une image servie depuis OPFS sera différent, probablement plus long ;
- le budget « ≤ 500 Mio transférés par application au premier usage » est tenu **après compression**
  (≈ 200 Mio), pas sur disque (927 Mio). Le budget porte sur les octets transférés ; encore faut-il
  que la publication (#45) et le backend de blocs (#6) servent effectivement des artefacts
  compressés. Tant qu'ils ne l'ont pas décidé, l'écart brut reste un risque, pas un acquis ;
- le disque applicatif est dimensionné à 512 Mio pour laisser de la place aux écritures du guest,
  alors que son contenu en occupe bien moins. Les 469 Mio libres sont des zéros, d'où le rapport de
  compression de 12 pour 1 ; c'est un gaspillage sur disque et presque rien sur le fil.

## Budgets prototype

| Attribut                   | Seuil de sortie du jalon concerné                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Installation               | `npm ci` + navigateurs reproductibles depuis un clone vierge                                                               |
| Premier boot de preuve     | p95 ≤ 15 min, aucun timeout silencieux                                                                                     |
| Reprise locale au MVP      | cible p95 ≤ 60 s ; **gate fermé** (mesuré ~94 s), voie de qualification par ADR 0005                                       |
| Mémoire                    | pic navigateur ≤ 1,5 Gio au prototype ; cible MVP ≤ 1,2 Gio                                                                |
| Artefacts                  | ≤ 500 Mio transférés par application au premier usage, inventaire détaillé publié                                          |
| Écriture acquittée         | RPO 0 après la barrière durable du guest                                                                                   |
| Récupération               | dernière génération valide trouvée en ≤ 60 s hors temps de boot VM — **mesurée** (#91, OPFS réel)                          |
| Surmémoire de récupération | ≤ 64 Mio, comme l'export — **mesurée à 1 Mio**, indépendante de la taille de la charge (#91)                               |
| Coupures injectées         | 100 % des points donnent ancien état, nouvel état ou erreur explicite — **mesuré à 100 %** (#16, trois graines, OPFS réel) |
| Export                     | archive ≤ 2× la taille logique utilisée ; surmémoire de streaming ≤ 64 Mio                                                 |
| Restauration               | empreinte vérifiée avant première mutation ; aucune écriture sur incompatibilité                                           |
| Multi-onglets              | jamais deux écrivains ; relais ou refus explicite en ≤ 5 s                                                                 |
| Accessibilité              | parcours coquille conformes WCAG 2.2 AA avant qualification produit                                                        |

Le budget de premier boot accepte temporairement la réalité de l'émulation ; il ne vaut pas
validation produit. La cible à 60 secondes est un gate : snapshot cohérent, autre stratégie de
reprise ou changement de runtime devront être évalués plutôt que d'abaisser silencieusement
l'exigence. Cette évaluation est faite dans
[ADR 0005](decisions/0005-qualification-de-la-reprise.md) : la voie retenue est l'instantané lié à
une génération arrêtée, la cible reste 60 s, et le gate **reste fermé** jusqu'à sa mesure sur
l'environnement de référence.

Le premier boot mesuré sur la fixture de #5 tient largement sous ce budget, mais il le doit à une
image dépouillée — un seul service, aucune base serveur, aucun processus de fond — et à un disque
servi depuis la mémoire. Il ne préjuge donc pas du boot d'une application réelle sur le backend de
blocs de #4.

### Première mesure de reprise sur le backend OPFS (#7)

Relevé du 2026-08-24 par `npm run test:e2e`, sur le disque applicatif **adossé à OPFS** — donc, pour
la première fois, dans les conditions réelles du produit et non sur un disque en mémoire. **Ce n'est
pas l'environnement de référence** (28 threads, 32 Gio au lieu de 4 cœurs, 16 Gio ; trois essais au
lieu de dix) : ces chiffres valent comme premier ordre de grandeur, pas comme relevé de référence.

| Élément                    | Valeur                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| Machine                    | Windows 11, Node 24.14.0, Chromium (Playwright), VM à 512 Mio     |
| Disque applicatif          | 512 Mio dans OPFS ; runtime (rootfs, noyau, initrd, BIOS) 437 Mio |
| Boot à chaud (santé Rails) | 94 s ; 40 écritures et 1 barrière durable acquittée vers OPFS     |
| Reprise à froid, 3 essais  | 94,5 s, 92,2 s, 162,1 s → **p50 = 94,5 s, p95 = 162,1 s**         |

**Le p95 de reprise dépasse la cible de 60 s.** Conformément au budget ci-dessus, un dépassement
n'abaisse pas l'exigence en silence : il **exige un ADR** de qualification produit. Cet ADR est
désormais rendu — [ADR 0005](decisions/0005-qualification-de-la-reprise.md), accepté : la voie de
qualification retenue est un **instantané mémoire lié à une génération proprement arrêtée**, et **le
gate reste fermé** tant qu'il n'est pas construit puis mesuré sur l'environnement de référence. La
tranche #7 prouve que la reprise **fonctionne** hors ligne à froid, pas qu'elle tient le budget.

### Décomposition mesurée de la reprise (#60)

Relevé du 2026-08-24, `npm run test:e2e`, **même machine de développement** que #7 (donc pas
l'environnement de référence), trois reprises. Le troisième essai aberrant de #7 (162 s) **ne s'est
pas reproduit** : p50 92,4 s, p95 94,1 s — ce qui conforte l'hypothèse d'un point isolé (contention
ou ramasse-miettes) que le protocole à dix essais de l'environnement de référence départagera. Même
sans cette aberration, le p95 dépasse la cible de ~57 %.

La décomposition est **outillée** (jalons `performance.now()` et repères du flux série brut du
guest, publiés dans `reports/e2e/reprise-boot-froid.json`, champ `repriseTimeline`) et non
modélisée. Un jalon jamais atteint reste `null`. Valeurs représentatives des trois essais, de
`emulator.run()` à la première réponse `/vault/health` :

| Étape                                            |     Durée |      Part |
| ------------------------------------------------ | --------: | --------: |
| Instanciation v86 + WebAssembly + contrôleur IDE |   ~130 ms |      ~0 % |
| BIOS → premier octet série                       |    ~3,4 s |      ~4 % |
| Boot noyau → init (montage `/app`)               |   ~15,5 s |     ~17 % |
| Montage du disque applicatif OPFS (`/dev/sdb`)   |    ~65 ms |      ~0 % |
| **Boot Puma/Rails → première `/vault/health`**   | **~73 s** | **~79 %** |
| **Total (`healthMilliseconds`)**                 | **~92 s** |     100 % |

Deux enseignements portent l'ADR 0005 : le **boot de Puma/Rails sur l'i386 émulé domine** (~79 %),
et le **backend OPFS n'est pas le goulot** (montage ~65 ms). L'hypothèse de #7 — le surcoût
viendrait de ce que le disque est servi depuis OPFS — est donc infirmée pour la part dominante : le
coût est du CPU émulé, non de la latence OPFS. Aucune optimisation de boot à froid ne peut à elle
seule tenir 60 s, puisque le seul boot Rails (~73 s) dépasse déjà la cible.

### Reprise avec la boucle d'ordonnancement de Vault (#74)

Relevé du 2026-08-26, `npm run test:e2e`, **même machine de développement** que #7 et #60. Depuis
#74, la boucle d'ordonnancement de v86 est fournie par Vault et non plus par le moteur
([ADR 0013](decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md), § « Mise en œuvre par #74 »).
C'est un changement du **rythme de tout l'émulateur** : il devait être mesuré ici, pas supposé.

| Mesure                                   | Boucle native | Boucle de Vault |   Écart |
| ---------------------------------------- | ------------: | --------------: | ------: |
| Boot à chaud jusqu'à `/vault/health` (1) |     99 475 ms |      110 465 ms | +11,0 % |
| Reprise à froid, p50 (3 essais)          |     94 870 ms |       97 568 ms |  +2,8 % |
| Reprise à froid, p95 (3 essais)          |    109 412 ms |      110 140 ms |  +0,7 % |
| Boot après migration de format (1)       |     97 173 ms |      105 293 ms |  +8,4 % |

**Ces écarts ne sont pas distinguables du bruit de cette machine, et cela ne veut pas dire qu'ils
sont nuls.** L'étendue à l'intérieur d'une même série de trois reprises atteint 17,4 % avant et 15,8
% après ; les deux lignes marquées « (1) » sont des points uniques, et le boot à chaud « après » a
en outre produit **60 écritures OPFS contre 40** — deux boots qui n'ont pas fait le même travail.
Une conclusion de non-régression exigerait le protocole de l'environnement de référence : dix essais
après échauffement, sur 4 cœurs et 16 Gio.

Ce que le relevé établit sans ambiguïté : **aucun budget de cette page n'est franchi**, la barrière
durable reste émise et acquittée, et **le gate de reprise reste fermé** pour la même raison qu'avant
— la cible est p95 ≤ 60 s, le mesuré reste autour de 100 s, et la voie de qualification retenue par
l'ADR 0005 est l'instantané de #65. Cette tranche ne l'a ni rapproché ni éloigné.

La mémoire publiée par le relevé (`memoireTasJs`) est le **tas JS de la page**, pas l'empreinte de
la VM : v86 et ses 512 Mio de RAM invitée vivent dans le Worker, que `performance.memory` de la page
ne mesure pas. Une mesure de l'empreinte réelle du processus navigateur reste à outiller (issue de
suivi).

## Première mesure du taux de coupures atomiques (#15)

Le budget « Coupures injectées » du tableau ci-dessus — _100 % des points donnent ancien état,
nouvel état ou erreur explicite_ — n'avait jusqu'ici aucun instrument. #15 en fournit un et publie
sa **première mesure**. Il ne rapproche pas le budget de sa cible : il rend enfin visible l'écart
qui l'en sépare. La garantie est l'objet de #16.

Relevé du 2026-08-26, `npm run test:vm`, projet `chromium`, volume OPFS réel. Graine `2026`, huit
points de coupure, vingt-quatre blocs de 512 octets suivis par point. Le Worker runtime écrit une
suite de blocs connus ; la page l'arrête par `Worker.terminate()`, handle exclusif ouvert, sans
fermeture et sans barrière ; le volume est rouvert et classé.

| Genre de coupure         | Points | Verdicts obtenus                               |
| ------------------------ | -----: | ---------------------------------------------- |
| `ecriture-dechiree`      |      3 | 3 × `corrompu` (un bloc déchiré à chaque fois) |
| `arret-brutal`           |      3 | 3 × `melange`                                  |
| `coupure-avant-barriere` |      2 | 1 × `melange`, 1 × `nouveau`                   |

| Mesure                                       |                                                Valeur |
| -------------------------------------------- | ----------------------------------------------------: |
| Taux « ancien ou nouveau » (**cible 100 %**) |                                            **12,5 %** |
| Verdicts de volume                           |            0 ancien, 1 nouveau, 4 melange, 3 corrompu |
| Blocs classés                                | 114 ancien, 75 nouveau, 3 déchirés, 0 non rattachable |
| Blocs durables au moment de la coupure       |    40 sur 192, à partir de 93 entrées de journal lues |

Le même relevé sur le **double calibré** de Node — mêmes huit points, même graine — donne la même
répartition et le même taux (`tests/unit/vm-crash-matrice.test.mjs` le fige). Les deux supports ne
divergent donc pas, ce qui est la condition pour que le chiffre publié dise quelque chose du SUPPORT
et non de l'instrument.

**Ce que le relevé établit.** Sept points sur huit laissent aujourd'hui un état **non atomique** :
un volume où d'anciens et de nouveaux blocs cohabitent, ou un bloc dont une partie seulement des
octets a atteint le support. Aucune coupure n'a produit de bloc non rattachable, et aucune n'a
produit de succès silencieux : chacune s'est traduite par une erreur typée du stockage
(`VAULT_STORAGE_PARTIAL_WRITE` ou `VAULT_STORAGE_HANDLE_LOST`). Aucune non plus n'a violé
`SEC-DURABLE-001` : quarante blocs étaient acquittés ET franchis par une barrière au moment de la
coupure, et les quarante étaient sur le support. Que cette règle sache mordre est vérifié par un
témoin négatif — un rapport réel rejugé avec un journal trafiqué — et non déduit de son silence.

**Ce qu'il n'établit pas.** Le seul point classé `nouveau` est une coupure posée sur la **dernière**
barrière : les vingt-quatre écritures avaient eu lieu, les deux premières barrières avaient été
acquittées, et les huit dernières écritures — qu'aucune barrière n'avait franchies — se sont elles
aussi retrouvées sur le support après la mort du Worker. Ce relevé n'a donc observé **aucune perte
d'écriture non barriérée** sur l'OPFS de Chromium — ce qui ne veut pas dire qu'il n'y en a pas :
huit points, une machine, un moteur, et une écriture qui atteint le fichier n'est pas une écriture
qui a atteint le disque. Un `Worker.terminate()` ne tue d'ailleurs ni le processus du navigateur ni
la machine : aucun cache volatil n'est perdu au passage. La question relève de #16 et d'un protocole
qui coupe plus bas.

**Rejeu.** La graine et le point complet sont publiés pour chaque ligne du compte rendu ; la même
graine rejoue la même matrice, ce que la suite vérifie en l'exécutant deux fois sur le vrai support.
Le protocole est décrit dans [`testing.md`](testing.md), § « Résilience : arrêts, écritures
partielles et rejeu ».

## Le taux de coupures atomiques atteint sa cible (#16)

Relevé du 2026-08-27, `npm run test:vm`, projet `chromium`, volume OPFS réel. **La cadence et la
matrice sont celles de #15** : vingt-quatre blocs distincts, une barrière tous les huit, et une
suite de points identique point pour point, ce que `tests/unit/vm-crash-cadence.test.mjs` épingle.

Ce qui a changé pour que la comparaison ait un sens, c'est l'**oracle**. Celui de #15 ne connaissait
que deux états de référence — « tout l'ancien », « tout le nouveau » — et rangeait donc toute
génération intermédiaire VALIDÉE dans `melange` : le 100 % demandé était hors d'atteinte de tout
mécanisme, la borne valant 50 % sur la graine 2026 et 37,5 % sur les deux autres. Il reçoit
désormais la **suite des générations attendues du scénario** — `[∅, {0..7}, {0..15}, {0..23}]` — et
n'accepte un volume que si les blocs publiés en forment EXACTEMENT une. Les verdicts intermédiaires
sont nommés (`generation-1`, `generation-2`).

C'est un juge **strictement plus discriminant**, pas plus indulgent : la suite est dérivée du
scénario et non du mécanisme, l'oracle refuse une suite qui ne croît pas strictement — un appelant
ne peut donc pas y glisser l'état que son mécanisme produit —, et tout ce que #15 refusait est
encore refusé.

| Mesure                                                             |                                    #15 |                                                #16 |
| ------------------------------------------------------------------ | -------------------------------------: | -------------------------------------------------: |
| Taux de coupures laissant une génération validée (**cible 100 %**) |                                 12,5 % |                                          **100 %** |
| Verdicts, graine 2026                                              | 0 anc., 1 nouv., 4 mélange, 3 corrompu | **4 `ancien`, 3 `generation-1`, 1 `generation-2`** |
| Blocs déchirés                                                     |                                      3 |                                              **0** |
| Blocs non rattachables                                             |                                      0 |                                              **0** |

Deux autres graines, jamais employées pour mettre le mécanisme au point, sur le même support :

| Graine   |  Taux | Verdicts                                                              |
| -------- | ----: | --------------------------------------------------------------------- |
| `7`      | **1** | 3 `ancien`, 3 `generation-1`, 2 `generation-2`, 0 mélange, 0 corrompu |
| `424242` | **1** | 3 `ancien`, 3 `generation-1`, 2 `generation-2`, 0 mélange, 0 corrompu |

Le **double calibré** de Node rend exactement la même répartition sur les trois graines
(`tests/unit/vm-crash-matrice.test.mjs`) : les deux supports ne divergent pas.

**Ce que le relevé établit.** Les huit points de chaque graine laissent le volume dans un état qui
est exactement l'une des générations attendues, et trois des quatre états possibles sont exercés :
l'extrême bas et les deux générations intermédiaires. Chaque coupure s'est traduite par une erreur
typée du stockage, et chaque réouverture a NOMMÉ ce que la récupération a fait — génération écartée,
rejouée, ou rien en attente —, l'état attendu étant DÉDUIT du point plutôt qu'accepté au hasard.

**Ce que la mesure vaut, établi par mutation.** Un taux de 100 % ne prouve rien tant qu'on n'a pas
montré qu'il sait descendre. Deux magasins mutés acquittent au guest puis ne scellent rien :

| Magasin                                |  2026 |     7 | 424242 |
| -------------------------------------- | ----: | ----: | -----: |
| Sain                                   | **1** | **1** |  **1** |
| Perd les générations après la première | 0,875 |  0,75 |   0,75 |
| Les perd toutes                        |   0,5 | 0,375 |  0,375 |

Les points trahis tombent en `corrompu` par la règle `SEC-DURABLE-001`. Ceux qui ne le sont pas —
coupés avant la barrière que le mutant honore encore — rendent le même verdict qu'un magasin sain :
il n'y a rien à trahir quand rien n'a été promis, et c'est pourquoi le taux ne tombe pas à zéro.

**Ce qu'il n'établit pas.** Le verdict `nouveau` — les vingt-quatre blocs publiés — est
**inatteignable par la matrice** : la troisième barrière suit la vingt-quatrième écriture, et les
trois genres de coupure tombent tous avant son acquittement. L'extrême haut est donc exercé par un
témoin positif au niveau unitaire — le scénario sans faute doit rendre `nouveau` — et le zéro de
cette colonne est publié plutôt que masqué.

Et la coupure reste un `Worker.terminate()` : ni le processus du navigateur ni la machine ne
meurent, aucun cache volatil n'est perdu. Ce que #16 change sur ce point est plus étroit qu'il n'y
paraît — une perte de cache volatil ne peut plus produire un MÉLANGE, puisque les octets non validés
sont dans le journal et qu'une charge incomplète est écartée ; mais qu'elle ne le produise pas n'est
pas MESURÉ ici.

**Le surcoût d'écriture n'a pas de budget opposable, et ce relevé n'en fabrique pas.** L'ADR 0014
mesure ×2,06 sur son banc — chaque octet écrit par le guest entre deux barrières est écrit une fois
dans le journal, une fois dans le volume — et deux barrières du support par barrière du guest au
lieu d'une. Le tableau des budgets ne reçoit **aucune** ligne « surcoût d'écriture » : un seuil posé
sans mesure opposable serait une promesse, pas un budget.

### Ce que `test:rythme` dit, et surtout ce qu'il ne dit pas (#16)

Relevé du 2026-08-26, `npm run test:rythme`, cinq essais par bras entrelacés, machine de
développement. **Vert**, verdict publié « dans le bruit de cette machine ».

| Bras            |   p50 (ms) | p95 (ms) | Étendue intra-série | Écritures OPFS par boot |
| --------------- | ---------: | -------: | ------------------: | ----------------------: |
| Boucle native   |    114 362 |  117 616 |               5,4 % |                 63 à 73 |
| Boucle de Vault |    115 468 |  118 875 |               7,6 % |                 63 à 72 |
| **Écart p50**   | **+1,0 %** |        — |         bruit 7,6 % |                       — |

**Ce banc ne mesure PAS le surcoût de #16.** Il compare deux boucles d'ordonnancement, et **les deux
bras portent la génération transactionnelle** : le surcoût d'écriture est présent des deux côtés et
s'annule dans l'écart. Ce qu'il établit est plus modeste, et c'est la non-régression demandée : avec
#16, la reprise reste conforme, l'invariant Rails aussi, et la boucle de Vault ne dérive pas.

Comparé au relevé #74 sur la même machine (boucle de Vault, boot à chaud, point unique : 110 465
ms), le p50 de cinq essais passe à **115 468 ms**, soit **+4,5 %** — sous l'étendue intra-série de
15,8 % que ce relevé-là publiait. Et le bras NATIF a bougé davantage encore, de 99 475 à 114 362 ms
(+15 %), alors qu'il porte exactement le même stockage. **L'écart entre les deux relevés est donc
dominé par l'état de la machine, pas par #16**, et personne ne peut conclure autrement à partir de
ces chiffres. Le nombre d'écritures OPFS par boot, lui, est inchangé : le journal ne multiplie pas
les écritures LOGIQUES, il double les octets écrits sur le support.

Conclure « pas de régression du surcoût d'écriture » exigerait un protocole que cette tranche n'a
pas exécuté : dix essais après échauffement sur l'environnement de référence, avec un bras SANS
génération transactionnelle. C'est du travail découvert. Le gate de reprise reste fermé pour les
raisons de l'ADR 0005, qui n'ont pas changé.

## Ce que coûtera le scellement d'un secteur (#17)

L'[ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md) décide d'ajouter un
chiffrement authentifié à chaque secteur. **Rien n'est encore chiffré dans le produit** : ce relevé
mesure le modèle de référence, pour que la décision soit prise sur un chiffre plutôt que sur une
intuition. La règle de l'ADR 0014 s'applique — « un coût que personne ne mesure finit par être
supposé nul ».

Relevé du **2026-08-27**, `node tools/mesurer-scellement.mjs --navigateur --essais=5`. **Ce n'est
pas l'environnement de référence** (Windows 11, Intel i7-14700HX, 28 cœurs logiques, Node 24.14.0,
Chromium 151 par Playwright ; cinq essais au lieu de dix, une machine au lieu de quatre cœurs) : ces
chiffres valent comme ordre de grandeur mesuré. Lot de 4 Mio, 8 192 blocs de 512 octets,
AES-256-GCM.

| Moteur                   | Sceller un bloc | Ouvrir un bloc | Débit par blocs |    4 Mio en UN appel |
| ------------------------ | --------------: | -------------: | --------------: | -------------------: |
| **Chromium 151, Worker** |    **17,87 µs** |   **13,50 µs** |      27,3 Mio/s |   4,5 ms → 889 Mio/s |
| Node 24.14               |        50,45 µs |       48,19 µs |       8,1 Mio/s | 3,2 ms → 1 268 Mio/s |

**Le chiffre qui décide n'est pas le débit d'AES, c'est le coût par APPEL.** Les mêmes 4 Mio coûtent
146,4 ms en 8 192 appels contre 4,5 ms en un seul : un facteur **32,5** qui n'est pas imputable au
chiffrement, mais au coût fixe d'un appel à `crypto.subtle` (≈ 17,3 µs, contre ≈ 0,5 µs de calcul
pour 512 octets). Et **Node est 2,8 fois plus lent par appel que Chromium** : sa mesure ne peut pas
se substituer à celle du navigateur, ce qui justifie d'avoir monté le banc dans un Worker de module
réel plutôt que sous Node seul.

Le **tirage du nonce** coûte ≈ 4 µs par scellement : c'est l'écart entre les 13,73 µs d'un premier
relevé, où le nonce était dérivé de la génération et du rang, et les 17,87 µs d'aujourd'hui, où il
est tiré de `crypto.getRandomValues`. Ce surcoût est le prix d'une **correction**, pas d'un confort
: l'[ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md) dit quelle réfutation l'a
imposé. L'ouverture, elle, ne tire rien et reste à 13,50 µs.

Rapporté aux budgets ci-dessus, avec les chiffres de Chromium :

| Geste                                                            | Scellement |                                                                                               Rapporté à |
| ---------------------------------------------------------------- | ---------: | -------------------------------------------------------------------------------------------------------: |
| Boot Rails mesuré par #16 (285 lectures, 13 écritures)           | **4,1 ms** |                                                                   ~92 s de boot → **0,004 %**, invisible |
| Une génération de la taille mesurée par #16 (90 304 o)           | **3,2 ms** |                                                                         s'ajoute à une barrière du guest |
| Récupération d'une génération au plafond de 64 Mio               |  **1,8 s** | budget « dernière génération valide trouvée en ≤ 60 s » — tenu avec plus d'un ordre de grandeur de marge |
| Création ou restauration d'un volume de 512 Mio                  | **18,7 s** |                                              tous les secteurs devront être scellés, y compris les zéros |
| Migration de format v2 → v3 d'un volume de 512 Mio               | **18,7 s** |                                                               boot après migration mesuré à ~105 s (#74) |
| Lecture du volume entier (export #11, si l'archive est en clair) | **14,2 s** |                                                l'export n'a pas de budget de temps ; il en aurait besoin |

**En espace** : 34 octets par secteur du volume (nonce 12 + étiquette 16 + génération 6), soit
**6,641 %** et 34,00 Mio sur le volume applicatif de 512 Mio ; 28 octets par enregistrement du
journal (**5,469 %** — la génération y est celle de la racine, le rang est la position de
l'enregistrement) ; et **zéro octet de plus** pour la racine, dont l'en-tête passe de 60 à 136
octets dans le secteur déjà alloué par l'ADR 0014.

**Aucune ligne n'est ajoutée au tableau des budgets**, et c'est délibéré. La règle posée par #16
vaut ici : « un seuil posé sans mesure opposable serait une promesse, pas un budget ». Ces valeurs
sont des mesures prises sur une machine qui n'est pas l'environnement de référence, sur un seul
moteur. Firefox et WebKit ne sont pas mesurés, et l'effet du scellement sur le rythme de l'émulateur
ne l'est pas non plus — `test:rythme` ne saurait pas plus conclure ici qu'il ne le savait pour #16.

## Le budget de récupération est mesuré, et le plafond de charge en découle (#91)

Le budget « dernière génération valide trouvée en ≤ 60 s hors temps de boot VM » existait depuis le
premier jalon et **n'était mesuré nulle part** : aucune épreuve ne chronométrait une récupération,
et aucune ne la faisait porter sur une charge réaliste. La surmémoire de la récupération, elle,
n'était pas bornée du tout — la charge validée était lue d'un seul tenant, soit jusqu'à ~128 Mio à
l'ancien plafond, alors que ce document borne la surmémoire de streaming à 64 Mio et l'exige
explicitement de l'export et de la restauration.

Relevé du **2026-08-27**, `npm run test:vm` (`tests/vm/recuperation-generation.spec.mjs`), OPFS réel
sous Chromium, machine de développement — **pas l'environnement de référence**. Série complète dans
`reports/vm/recuperation-generation.json`.

| Charge rejouée              | Granularité          | Enregistrements |       p50 |           p95 | Échantillons | Étendue relative | Surmémoire de pointe |
| --------------------------- | -------------------- | --------------: | --------: | ------------: | -----------: | ---------------: | -------------------: |
| 16 Mio (plafond)            | 64 Kio               |             255 |    269 ms |        459 ms |            7 |             77 % |                1 Mio |
| 16 Mio (plafond)            | 4 Kio                |           4 080 |  1 978 ms |      2 398 ms |            7 |             39 % |                1 Mio |
| 16 Mio (plafond)            | **512 o** (pire cas) |          31 775 | 11 598 ms | **12 390 ms** |            5 |             20 % |                1 Mio |
| **64 Mio** (ancien plafond) | **512 o**            |         127 100 | 40 342 ms |     41 285 ms |            3 |              5 % |                1 Mio |

**La granularité décide, pas les octets.** Un rejeu écrit au moins une fois dans le volume par
enregistrement, et un appel OPFS synchrone se paie en centaines de microsecondes : à charge égale,
la même charge coûte **quarante-trois fois** plus cher en enregistrements de 512 octets qu'en
enregistrements de 64 Kio. Publier un seul profil laisserait croire que la durée suit les octets.
Elle suit le nombre d'écritures que le guest a émises entre deux barrières.

**L'étendue intra-série est publiée parce qu'elle est grande.** 77 % sur le profil le plus court : à
270 ms de médiane, quelques dizaines de millisecondes d'ordonnancement pèsent lourd en relatif. Elle
tombe à 20 % sur le profil qui décide — celui de 512 octets —, où la durée est dominée par le
travail et non par le bruit. Un p95 sans son étendue laisserait croire à une précision que sept
répétitions sur une machine de développement n'ont pas.

**Le témoin ne dépasse pas franchement le budget : il l'ENCADRE, et c'est pire.** La série à 64 Mio
a été mesurée trois fois sur cette machine, à des états de charge différents : **71,1 s**, **53,2
s**, puis **40,3 s** de médiane machine au repos. Un budget que la mesure franchit dans un sens ou
dans l'autre selon ce que la machine faisait par ailleurs n'est pas un budget tenu — sa marge est
nulle, et l'environnement de référence n'est pas cette machine-ci. À 16 Mio, la pire valeur
individuelle jamais relevée au pire cas vaut 14,9 s : la conclusion ne dépend plus de l'état de la
machine.

**Le budget n'a pas bougé d'une seconde ; le plafond de charge, si** — de 64 Mio à 16 Mio
(`PLAFOND_CHARGE_OCTETS`). C'est la règle que #91 s'était donnée : si la mesure ne tient pas, c'est
le plafond qu'on révise, pas le budget. Le nouveau chiffre est deux fois le seuil de point de
contrôle — un guest qui émet des barrières n'est jamais refusé — et près de deux cents fois la seule
génération jamais observée de l'image de référence. Voir l'amendement du 2026-08-27 de
[ADR 0014](decisions/0014-generation-transactionnelle.md).

**La surmémoire de récupération vaut 1 Mio, et ne suit pas la charge.** C'est la taille de la
fenêtre glissante avec laquelle le journal est relu ; elle est une constante du magasin. Relever le
plafond ne la relèverait pas. Elle est **mesurée du côté du support** — la plus grande lecture qu'il
reçoit — et non déclarée par le code qu'elle contrôle.

### La plus grande génération que l'image de référence produit

Le plafond ne vaut que confronté à ce qu'un guest demande RÉELLEMENT entre deux barrières. Jusqu'à
#91 le seul relevé était celui du scénario Bout en bout de #16 — 90 304 octets déposés entre la
première barrière acquittée de Rails et la coupure —, et ce n'était pas un maximum : le point de
contrôle remet la charge validée à zéro à chaque rangement, si bien que seule la DERNIÈRE génération
d'un boot restait lisible.

Le magasin retient désormais **deux hautes eaux**, que chaque boot publie, et il a fallu les
distinguer : `PLAFOND_CHARGE_OCTETS` borne la charge **DÉPOSÉE** depuis le dernier point de contrôle
— barrière ou pas —, et non la génération validée. Relevé du 2026-08-27, `npm run test:e2e`, vrai
Rails sur volume OPFS de 512 Mio :

| Scénario                     | Charge DÉPOSÉE max | Plus grande génération scellée |
| ---------------------------- | -----------------: | -----------------------------: |
| Boot à chaud, mutation Rails |          992 208 o |                        4 112 o |
| Reprise à froid, essai 1     |          979 904 o |                        4 112 o |
| Reprise à froid, essai 2     |        1 008 640 o |                        4 112 o |
| Reprise à froid, essai 3     |        1 004 512 o |                        4 112 o |
| Boot après migration         |    **1 012 688 o** |                        4 112 o |
| **Plafond**                  |   **16 777 216 o** |                              — |

**L'écart entre les deux colonnes est le fait le plus instructif du relevé.** La plus grande
génération SCELLÉE vaut 4 112 octets partout — un bloc de 4 Kio et son en-tête, ce que SQLite écrit
puis fait suivre d'un `fsync`. La charge DÉPOSÉE, elle, atteint près d'un Mio : un boot de l'image
de référence produit **soixante et une écritures OPFS pour UNE seule barrière acquittée**. Rails
écrit beaucoup et barrière peu, si bien que c'est la charge non validée qui approche le plafond.

**Le plafond laisse 16,6× au-dessus de la pire charge observée.** C'est confortable, et ce n'est pas
immense : une application qui écrirait seize fois plus que l'image de référence entre deux barrières
serait refusée. Le facteur valait 66 avec l'ancien plafond de 64 Mio — l'abaissement le réduit sans
l'annuler, et c'est le prix assumé d'un budget de récupération tenu plutôt que supposé.

**Ce qu'un refus coûte au guest**, puisque le plafond refuse au lieu de dégrader : un guest qui
dépasserait reçoit `VAULT_STORAGE_GENERATION_OVERFLOW`, traduit en erreur d'E/S ATA — pour Linux, un
disque qui refuse d'écrire, donc système de fichiers en lecture seule et transaction SQLite échouée.
Bruyant, typé, sans perte silencieuse, mais bloquant. `SEC-DURABLE-001` n'en est pas affaibli : une
écriture refusée n'est annoncée durable à personne.

**Ce que ce relevé ne couvre pas.** `rails db:seed` et les migrations de schéma ne tournent pas au
boot : l'image de référence les exécute à la CONSTRUCTION, dans Docker, hors du backend de blocs.
Une application qui sèmerait ou migrerait au démarrage écrirait davantage d'un coup, et personne ne
l'a mesurée. Le plafond reste donc un garde-fou **révisable**, et le signal qui déclenche sa
révision est nommé : un seul `VAULT_STORAGE_GENERATION_OVERFLOW` observé en E2E. Les trois scénarios
de bout en bout l'assertent à chaque exécution — leur rouge précède l'incident d'un utilisateur.

## Compatibilité

La cible produit est les deux dernières versions stables de Chromium, Firefox et Safari sur
ordinateur. Depuis les mesures de #2, Chromium et Firefox sont **mesurés** et Safari reste
**candidat** : le moteur WebKit de Playwright ne le qualifie pas. Un moteur n'est annoncé supporté
que si toute capacité obligatoire et le scénario E2E du jalon passent dans sa CI ou sa recette
publiée. Les verdicts par capacité sont dans [`compatibility.md`](compatibility.md).

Le mobile est exploratoire tant que mémoire, stockage, fermeture des Workers et WebAuthn PRF ne
satisfont pas les mêmes preuves.

## Durabilité et sécurité

- aucun succès silencieux après corruption ou espace insuffisant ;
- aucune donnée réelle avant fermeture des gates sécurité de `SECURITY.md` ;
- aucun changement de format sans vecteur de compatibilité et sauvegarde ;
- aucune mesure de performance ne désactive `flush`, authentification ou séparation d'origine.
