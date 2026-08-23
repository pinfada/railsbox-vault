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

| Attribut               | Seuil de sortie du jalon concerné                                                 |
| ---------------------- | --------------------------------------------------------------------------------- |
| Installation           | `npm ci` + navigateurs reproductibles depuis un clone vierge                      |
| Premier boot de preuve | p95 ≤ 15 min, aucun timeout silencieux                                            |
| Reprise locale au MVP  | cible p95 ≤ 60 s ; dépassement exige un ADR avant qualification produit           |
| Mémoire                | pic navigateur ≤ 1,5 Gio au prototype ; cible MVP ≤ 1,2 Gio                       |
| Artefacts              | ≤ 500 Mio transférés par application au premier usage, inventaire détaillé publié |
| Écriture acquittée     | RPO 0 après la barrière durable du guest                                          |
| Récupération           | dernière génération valide trouvée en ≤ 60 s hors temps de boot VM                |
| Coupures injectées     | 100 % des points donnent ancien état, nouvel état ou erreur explicite             |
| Export                 | archive ≤ 2× la taille logique utilisée ; surmémoire de streaming ≤ 64 Mio        |
| Restauration           | empreinte vérifiée avant première mutation ; aucune écriture sur incompatibilité  |
| Multi-onglets          | jamais deux écrivains ; relais ou refus explicite en ≤ 5 s                        |
| Accessibilité          | parcours coquille conformes WCAG 2.2 AA avant qualification produit               |

Le budget de premier boot accepte temporairement la réalité de l'émulation ; il ne vaut pas
validation produit. La cible à 60 secondes est un gate : snapshot cohérent, autre stratégie de
reprise ou changement de runtime devront être évalués plutôt que d'abaisser silencieusement
l'exigence.

Le premier boot mesuré sur la fixture de #5 tient largement sous ce budget, mais il le doit à une
image dépouillée — un seul service, aucune base serveur, aucun processus de fond — et à un disque
servi depuis la mémoire. Il ne préjuge donc pas du boot d'une application réelle sur le backend de
blocs de #4.

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
