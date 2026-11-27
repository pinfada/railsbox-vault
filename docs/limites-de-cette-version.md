# Les limites de cette version, avec leurs chiffres et leurs sources

Cette page détaille les sept limites que l'écran d'entrée de RailsBox Vault dit à la personne (« Ce
que cette version ne promet pas », `src/coquille/limites-de-cette-version.mjs`). Elle **déclare** :
elle ne corrige rien, et ne redéfinit aucun palier. Le palier « usage sur données non sensibles »
est celui de [`docs/vision.md`](vision.md) et de [`SECURITY.md`](../SECURITY.md) (§ « Gates
d'utilisation »), qui font foi.

Un chiffre dit à l'écran doit se retrouver ici : une épreuve
(`tests/unit/coquille-limites-de-l-entree.test.mjs`) le vérifie. L'écran écrit « Mo » et « Go » pour
la personne ; les mesures sont en mébioctets (Mio) et gibioctets (Gio), et l'écart (environ 5 %)
n'ôte rien à l'ordre de grandeur.

## 1. Chrome ou Edge seulement

- **Ce qui est dit** : Chrome ou Edge récents, sur ordinateur ; Firefox, l'application ne démarre
  pas ; Safari non pris en charge.
- **Fondement** : sous Firefox, la machine virtuelle tourne environ six fois plus lentement que sous
  Chromium et Rails n'y a jamais répondu (ADR 0038 ; `docs/quality-attributes.md`, § « L'ÉCART : la
  mesure Firefox n'existe pas »). WebKit est refusé : `getDirectory()` y est rejeté ou absent
  (`docs/compatibility.md`). Safari n'a jamais été éprouvé en vrai : le statut est « candidat ».
- **Non prouvé** : les navigateurs mobiles sont « expérimentaux » (`docs/compatibility.md`) ; aucun
  téléphone n'a été mesuré.

## 2. Un premier démarrage long

- **Ce qui est dit** : environ deux minutes ; de 82 à 126 secondes mesurées, sur des machines de
  test.
- **Mesures** (`docs/quality-attributes.md`) :

  | Mesure                                         | Valeur                   | Environnement                                                                                                                 | Date       |
  | ---------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
  | Premier démarrage dans Chromium, installation  | 116,6 s et 82,0 s        | banc de bout en bout `parcours-page-rails.spec.mjs`, Chromium                                                                 | 13/09/2026 |
  | Boot à froid jusqu'à `/vault/health`, 4 essais | 90 à 119 s (p50 91 s)    | Windows 11, 28 threads logiques, 32 Gio, Node, disque en mémoire                                                              | 23/08/2026 |
  | Boot à froid, environnement de référence       | p50 124,1 s, p95 125,9 s | exécutant GitHub `ubuntu-latest`, 4 vCPU, 16 Gio, Node 22.23.2, harnais Node, dix essais après échauffement (run 33894145816) | 04/09/2026 |

- **Non prouvé** : un portable modeste, un appareil occupé ou un téléphone. Le boot mesuré sous Node
  utilise un disque en mémoire, pas OPFS : le temps réel dans le navigateur est « probablement plus
  long » (`docs/quality-attributes.md`, § « Mesures initiales de la fixture »).
- **Ce qui change après** : la réouverture après un verrouillage prend environ 1 s (instantané), pas
  deux minutes.

## 3. Un gros téléchargement

- **Ce qui est dit** : environ 200 Mo au premier démarrage.
- **Mesure** : **206,9 Mio** transférés au premier démarrage (rootfs, paquet, noyau, initrd et BIOS,
  en gzip), recette QA du 19/09/2026, Chrome installé, octets de chaque artefact relevés au réseau
  (`docs/quality-attributes.md`, § « Ce que les morceaux GZIP et la mise à jour coûtent »).
- **Non prouvé** : ce que les démarrages suivants transfèrent depuis le magasin d'artefacts (#247)
  et la réserve hors connexion n'est pas mesuré (« non mesuré », `docs/quality-attributes.md`, § «
  Mesures de sortie du lot D1 »). Le parcours annonce lui-même « environ 200 Mo » pour une mise à
  jour.

## 4. Beaucoup de mémoire

- **Ce qui est dit** : l'application réserve 512 Mo ; le navigateur a dépassé 1,5 Go au plus fort du
  démarrage, au-delà de la cible de 1,2 Go.
- **Mesures** (`docs/quality-attributes.md`) :
  - la machine virtuelle de la fixture a **512 Mio** de mémoire invitée ;
  - pic de mémoire du processus hôte Node : **940 Mio** (premier essai), jusqu'à 1 227 Mio aux
    essais suivants — sur Node, pas sur un navigateur (23/08/2026) ;
  - pic **Chromium**, `node tools/mesurer-memoire.mjs --essais=1`, 18/09/2026 : **1 550 Mio** au
    boot à chaud, **1 596 Mio** à la reprise ; privé jusqu'à 1 925 Mio. La cible de **1,2 Gio**
    (#67) est dépassée : l'issue **#238** est ouverte (« Lecture à la demande du paquet applicatif
    »).
- **Non prouvé** : le comportement sur un appareil à peu de mémoire. Ce que fait le navigateur quand
  il manque de mémoire n'a pas été mesuré.

## 5. Données non sensibles seulement

- **Ce qui est dit** : aucune donnée réelle ni sensible ; cette version sert à essayer.
- **Fondement** : `SECURITY.md`, § « Gates d'utilisation » : le gate « données sensibles » est
  **fermé**, et « une démonstration réussie ne lève jamais seule un gate ». Le parcours le dit aussi
  à l'écran de création : « utilisez uniquement des données d'essai ».

## 6. Une application non signée

- **Ce qui est dit** : l'application n'est pas signée ; la signature est prévue plus tard (jalon 6).
- **Fondement** : « Le paquet n'est pas signé par son auteur » (`SECURITY.md`, « Ce qui n'est PAS
  garanti », paquet applicatif) ; jusqu'au jalon 6 (#26 à #28), la seule garantie est l'empreinte
  servie par l'origine de la coquille, que l'on croit sur parole. L'inventaire publié n'est pas une
  signature (`docs/release-policy.md`).

## 7. Hors connexion, après un premier démarrage

- **Ce qui est dit** : le premier démarrage a besoin d'Internet ; ensuite l'application redémarre
  sans connexion, mais elle ne peut pas savoir si une nouvelle version existe.
- **Fondement** : ADR 0046 et ADR 0048 ; scénario `tests/e2e/hors-ligne.spec.mjs` joué en CI sur
  l'arbre publié (#323). Hors connexion, un retrait de version est **invisible** (ADR 0048), et il
  n'y a aucune durée maximale avant le jalon 6.
- **Non prouvé** : le coût en octets et la taille du magasin hors connexion ne sont pas mesurés
  (`docs/quality-attributes.md`, § « Mesures de sortie du lot D1 »).
