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

| Attribut               | Seuil de sortie du jalon concerné                                                    |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Installation           | `npm ci` + navigateurs reproductibles depuis un clone vierge                         |
| Premier boot de preuve | p95 ≤ 15 min, aucun timeout silencieux                                               |
| Reprise locale au MVP  | cible p95 ≤ 60 s ; **gate fermé** (mesuré ~94 s), voie de qualification par ADR 0005 |
| Mémoire                | pic navigateur ≤ 1,5 Gio au prototype ; cible MVP ≤ 1,2 Gio                          |
| Artefacts              | ≤ 500 Mio transférés par application au premier usage, inventaire détaillé publié    |
| Écriture acquittée     | RPO 0 après la barrière durable du guest                                             |
| Récupération           | dernière génération valide trouvée en ≤ 60 s hors temps de boot VM                   |
| Coupures injectées     | 100 % des points donnent ancien état, nouvel état ou erreur explicite                |
| Export                 | archive ≤ 2× la taille logique utilisée ; surmémoire de streaming ≤ 64 Mio           |
| Restauration           | empreinte vérifiée avant première mutation ; aucune écriture sur incompatibilité     |
| Multi-onglets          | jamais deux écrivains ; relais ou refus explicite en ≤ 5 s                           |
| Accessibilité          | parcours coquille conformes WCAG 2.2 AA avant qualification produit                  |

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

| Mesure                                       |                                             Valeur |
| -------------------------------------------- | -------------------------------------------------: |
| Taux « ancien ou nouveau » (**cible 100 %**) |                                         **12,5 %** |
| Verdicts de volume                           |         0 ancien, 1 nouveau, 4 melange, 3 corrompu |
| Blocs classés                                | 114 ancien, 75 nouveau, 3 déchirés, 0 inclassables |

**Ce que le relevé établit.** Sept points sur huit laissent aujourd'hui un état **non atomique** :
un volume où d'anciens et de nouveaux blocs cohabitent, ou un bloc dont une partie seulement des
octets a atteint le support. Aucune coupure n'a produit de bloc inclassable, et aucune n'a produit
de succès silencieux : chacune s'est traduite par une erreur typée du stockage
(`VAULT_STORAGE_PARTIAL_WRITE` ou `VAULT_STORAGE_HANDLE_LOST`).

**Ce qu'il n'établit pas.** Le seul point classé `nouveau` est une coupure posée sur la **dernière**
barrière : les vingt-quatre écritures avaient eu lieu, aucune barrière ne les avait franchies, et
elles se sont pourtant retrouvées sur le support après la mort du Worker. Ce relevé n'a donc observé
**aucune perte d'écriture non barriérée** sur l'OPFS de Chromium — ce qui ne veut pas dire qu'il n'y
en a pas : huit points, une machine, un moteur, et une écriture qui atteint le fichier n'est pas une
écriture qui a atteint le disque. La question relève de #16 et d'un protocole qui coupe le processus
lui-même, pas seulement le Worker.

**Rejeu.** La graine et le point complet sont publiés pour chaque ligne du compte rendu ; la même
graine rejoue la même matrice, ce que la suite vérifie en l'exécutant deux fois sur le vrai support.
Le protocole est décrit dans [`testing.md`](testing.md), § « Résilience : arrêts, écritures
partielles et rejeu ».

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
