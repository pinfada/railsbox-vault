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

| Attribut               | Seuil de sortie du jalon concerné                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Installation           | `npm ci` + navigateurs reproductibles depuis un clone vierge                                                               |
| Premier boot de preuve | p95 ≤ 15 min, aucun timeout silencieux                                                                                     |
| Reprise locale au MVP  | cible p95 ≤ 60 s ; **gate fermé** (mesuré ~94 s), voie de qualification par ADR 0005                                       |
| Mémoire                | pic navigateur ≤ 1,5 Gio au prototype ; cible MVP ≤ 1,2 Gio                                                                |
| Artefacts              | ≤ 500 Mio transférés par application au premier usage, inventaire détaillé publié                                          |
| Écriture acquittée     | RPO 0 après la barrière durable du guest                                                                                   |
| Récupération           | dernière génération valide trouvée en ≤ 60 s hors temps de boot VM                                                         |
| Coupures injectées     | 100 % des points donnent ancien état, nouvel état ou erreur explicite — **mesuré à 100 %** (#16, trois graines, OPFS réel) |
| Export                 | archive ≤ 2× la taille logique utilisée ; surmémoire de streaming ≤ 64 Mio                                                 |
| Restauration           | empreinte vérifiée avant première mutation ; aucune écriture sur incompatibilité                                           |
| Multi-onglets          | jamais deux écrivains ; relais ou refus explicite en ≤ 5 s                                                                 |
| Accessibilité          | parcours coquille conformes WCAG 2.2 AA avant qualification produit                                                        |

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

Relevé du 2026-08-27, `npm run test:vm`, projet `chromium`, volume OPFS réel. **La matrice de
coupures est celle de #15, point pour point** : le profil remis au planificateur — vingt-quatre
écritures, trois barrières, blocs de 512 octets — est inchangé, et
`tests/unit/vm-crash-cadence.test.mjs` épingle la suite de points obtenue pour la graine 2026.

Ce qui a changé dans la mesure, et pourquoi il fallait le changer : le scénario suit désormais
**huit blocs réécrits trois fois** au lieu de vingt-quatre blocs distincts. Avec la cadence de #15,
un mécanisme PARFAITEMENT atomique plafonnait à 50 % sur la graine 2026 et à 37,5 % sur deux autres
— non par faiblesse du mécanisme, mais parce que `SEC-DURABLE-001` oblige à publier les générations
intermédiaires, que l'oracle ne sait nommer ni « ancien » ni « nouveau ». La borne est calculée, pas
affirmée, par `tests/unit/vm-crash-cadence.test.mjs`. **L'oracle n'a pas été modifié** : il reste le
juge de #15, avec les mêmes refus. Le détail de ce constat est dans
[l'ADR 0014](decisions/0014-generation-transactionnelle.md).

| Mesure                                       |                           #15 (2026-08-26) |                           #16 (2026-08-27) |
| -------------------------------------------- | -----------------------------------------: | -----------------------------------------: |
| Taux « ancien ou nouveau » (**cible 100 %**) |                                     12,5 % |                                  **100 %** |
| Verdicts de volume, graine 2026              | 0 ancien, 1 nouveau, 4 melange, 3 corrompu | 4 ancien, 4 nouveau, 0 melange, 0 corrompu |
| Blocs déchirés                               |                                          3 |                                      **0** |
| Blocs non rattachables                       |                                          0 |                                      **0** |

Deux autres graines, jamais employées pour mettre le mécanisme au point, sur le même support :

| Graine   |  Taux | Verdicts                                   |
| -------- | ----: | ------------------------------------------ |
| `7`      | **1** | 3 ancien, 5 nouveau, 0 melange, 0 corrompu |
| `424242` | **1** | 3 ancien, 5 nouveau, 0 melange, 0 corrompu |

Le **double calibré** de Node rend exactement la même répartition sur les trois graines
(`tests/unit/vm-crash-matrice.test.mjs`) : les deux supports ne divergent pas.

**Ce que le relevé établit.** Les huit points de chaque graine laissent le volume dans l'état
d'avant ou dans l'état d'après, et les DEUX issues sont exercées — une matrice qui ne rendrait que «
ancien » serait satisfaite par un backend qui n'écrirait rien du tout. Chaque coupure s'est traduite
par une erreur typée du stockage, et chaque réouverture a NOMMÉ ce que la récupération a fait :
génération écartée (`VAULT_STORAGE_GENERATION_DISCARDED`), rejouée, ou rien en attente. La règle
`SEC-DURABLE-001` de l'oracle n'est pas devenue inerte au passage : sur le point 2 de la graine
2026, huit blocs sont acquittés ET franchis par une barrière, et les huit sont sur le support ; le
témoin négatif qui la fait mordre est conservé.

**Ce qu'il n'établit pas.** La coupure reste un `Worker.terminate()` : ni le processus du navigateur
ni la machine ne meurent, aucun cache volatil n'est perdu. Ce que #16 change sur ce point est plus
étroit qu'il n'y paraît — une perte de cache volatil ne peut plus produire un MÉLANGE, puisque les
octets non validés sont dans le journal et qu'une charge incomplète est écartée ; mais qu'elle ne le
produise pas n'est pas MESURÉ ici. Le protocole qui coupe plus bas reste à écrire.

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
