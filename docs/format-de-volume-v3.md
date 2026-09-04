# Le format de volume v3 de RailsBox Vault — spécification pour la revue externe

- Version du document : 1 · 5 septembre 2026 · Issue
  [#20](https://github.com/pinfada/railsbox-vault/issues/20), moitié 1
- Format décrit : **volume v3**, journal de génération **format 3**, manifeste **format 3**
- Décisions dont il découle : [ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md)
  (propriétés), [ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md) (disposition),
  [ADR 0019](decisions/0019-fraicheur-du-volume.md) (fraîcheur)

## 1. Ce que ce document est, et ce qu'il n'est pas

**Il est autonome.** Un relecteur doit pouvoir le lire d'un bout à l'autre, reconstruire chaque
octet du disque et vérifier les vecteurs figés **sans ouvrir une ligne de code**. Là où un ADR
argumente une décision, ce document décrit un état de fait : les octets, leurs longueurs, leur
boutisme, les refus et ce qu'un exploitant doit en faire.

**Il ne remplace pas les ADR.** Les ADR portent le POURQUOI — les alternatives pesées, les
réfutations par exécution, les coûts mesurés. Ce document les cite plutôt que de les recopier ; là
où un choix a une raison, elle est nommée en une phrase et le renvoi est donné.

**Il n'établit aucune revue.** Le format de volume v3 de RailsBox Vault n'a été revu par aucun
tiers. Ce document existe pour rendre cette revue possible ; il ne dit ni « audité », ni « revu »,
ni « sûr ». Le dépôt est expérimental et ne doit contenir aucune donnée réelle : c'est le premier
gate de [`SECURITY.md`](../SECURITY.md), et il est fermé.

**Le CODE tranche.** Là où un ADR et le code divergent, ce document écrit ce que le code fait, dit
ce que l'ADR dit, et date l'écart. La § 12 les rassemble ; ils ne sont ni lissés ni corrigés en
silence.

## 2. Vérifier ce document en une commande

```sh
node tools/verifier-vecteurs.mjs
```

Node seul, aucune dépendance, aucun navigateur. Ce script **réimplémente** les encodages décrits ici
à partir de `node:crypto`, sans importer une ligne de `src/`, et les confronte aux octets figés de
`tests/vectors/format-chiffre-v1.json` (le modèle : blocs et racines en mémoire) et de
`tests/vectors/disposition-v3.json` (le disque : en-tête, enregistrement de journal, région
d'authentification, racine, témoin). Son indépendance est gardée par inspection de source :
`tests/unit/dossier-de-revue.test.mjs` › « le vérificateur de vecteurs n'importe RIEN de src/ : son
verdict est indépendant », et son verdict vert est exécuté par
`tests/unit/dossier-de-revue.test.mjs` › « le vérificateur de vecteurs tourne VERT en une commande,
sans le produit ».

Un vérificateur qui appellerait le modèle de référence emprunterait les encodages qu'il prétend
contrôler. Celui-ci mesure autre chose : que **la spécification écrite suffit** à reproduire les
octets.

Le reste du dossier s'exécute par `npm run test:unit` (les épreuves citées ci-dessous) et
`npm run check` (lint, format, épreuves, compatibilité, chaîne de publication).

## 3. Vue d'ensemble

Un volume est **un fichier** et **quatre voisins**, dans le système de fichiers privé de l'origine
(OPFS). Le partitionnement par origine du navigateur est la seule frontière extérieure du modèle
([ADR 0002](decisions/0002-topologie-origine-de-confiance.md)).

| Objet                 | Fichier                | Chiffré ? | Authentifié ?          | Dans le périmètre de cette revue   |
| --------------------- | ---------------------- | --------- | ---------------------- | ---------------------------------- |
| Volume                | `<volume>`             | oui       | oui, secteur à secteur | **oui**                            |
| Journal de génération | `<volume>.gen`         | oui       | oui, par racine        | **oui**                            |
| Témoin de séquence    | `<volume>.temoin`      | oui       | oui                    | **oui**                            |
| Manifeste             | `<volume>` voisin JSON | non       | **non**                | **oui** (ce qu'il déclare)         |
| Enveloppe de clé      | `<volume>.cles`        | oui       | oui                    | non — § 11                         |
| Instantané de reprise | `<volume>.instantane`  | oui       | oui                    | non — § 11                         |
| Journal de migration  | `<volume>.migration`   | non       | **non**                | non — § 11, mais sa limite est ici |

Le format sépare trois choses qu'il ne faut pas confondre :

- **la version du FORMAT DE VOLUME** — 3 — qui décide la disposition du fichier ;
- **la version du FORMAT DU JOURNAL** — 3 — qui décide la disposition d'une racine ;
- **la version de la SPÉCIFICATION cryptographique** — 1 — qui décide les données associées et n'a
  jamais bougé. Elle est l'étiquette de domaine `railsbox-vault/format-chiffre/v1/…`.

Les trois avancent indépendamment, et c'est délibéré : l'ADR 0019 a pu ajouter un champ à la racine
(journal 2 → 3) sans toucher un octet des données associées, donc sans invalider les vecteurs de
l'ADR 0015.

## 4. Les primitives

### 4.1 Chiffrement authentifié : AES-256-GCM

| Paramètre             | Valeur                                                         |
| --------------------- | -------------------------------------------------------------- |
| Algorithme            | `AES-GCM` de la recommandation W3C _Web Cryptography API_      |
| Nom épinglé du format | `aes-256-gcm` — le SEUL admis                                  |
| Clé                   | 256 bits (32 octets)                                           |
| Nonce                 | 96 bits (12 octets), **tiré au hasard**                        |
| Étiquette             | 128 bits (16 octets) — le maximum de NIST SP 800-38D § 5.2.1.2 |

**Pourquoi celui-là** : c'est le seul AEAD que WebCrypto rende disponible dans un Worker (ADR 0015,
§ « AEAD »). AES-GCM-SIV, ChaCha20-Poly1305 et XChaCha20-Poly1305 en sont absents ; les employer
demanderait une dépendance tierce et son audit. C'est la **question n° 1** de la § 13.

**Borne de forgerie, calculée et non qualifiée.** SP 800-38D § 5.2.1.2 et son annexe B majorent la
probabilité qu'une tentative de forgerie aboutisse par `(n + 1) / 2^t`, où `t` est la longueur
d'étiquette en bits et `n` le nombre de blocs de 128 bits de l'entrée. Pour un secteur de 512 octets
(32 blocs) et des données associées de 122 octets (8 blocs), `n = 40`, d'où **≈ 2^-122,6** par
tentative. Le mot « jamais » n'apparaît donc nulle part dans les propriétés de la § 8.

**Le nom de l'algorithme entre dans les données associées.** Sous une future version, un chiffré
produit par un algorithme ne pourra pas être réinterprété par un autre. Un nom autre que
`aes-256-gcm` est refusé par `VAULT_CRYPTO_ALGORITHME_INCONNU` ; l'agilité passe par une version de
format et un ADR, jamais par une négociation à l'exécution — qui serait un mécanisme de
rétrogradation dès qu'un adversaire peut écrire le champ qui la porte.

### 4.2 Le nonce : douze octets TIRÉS, conservés avec chaque objet scellé

Chaque scellement tire douze octets de `crypto.getRandomValues` (construction du § 8.2.2 de SP
800-38D) et les **stocke** à côté de l'objet scellé. Rien ne le dérive, et rien ne le reconstruit.

**Ce n'est pas un choix de confort, c'est une correction.** La première version de l'ADR 0015
dérivait le nonce de `(génération, rang)`. Une revue l'a **réfutée par exécution** : la génération
n'avance qu'à la validation, la récupération la remet à celle de la racine qui fait autorité, et le
vidage conserve la génération en incrémentant la séquence. Une génération déposée puis écartée
**rend son numéro** à la tentative suivante, si bien qu'une **fermeture propre** d'un onglet avec un
dépôt non validé suffisait à réémettre un nonce — sans qu'aucune panne soit nécessaire. Sous GCM,
deux chiffrés sous le même nonce livrent `C1 ⊕ C2 = P1 ⊕ P2` et la clé d'authentification `H`.
Épreuve : `tests/unit/vm-format-chiffre-reprise.test.mjs` › « FERMETURE PROPRE d'un dépôt non validé
: la reprise ne réémet aucun nonce ».

**La leçon est plus générale que le défaut** : dans un système conçu pour survivre aux coupures et
exposé au retour arrière du support, **tout nonce déterministe dérivé d'un état DURABLE** —
génération, séquence, époque, compteur — est réémis dès que cet état recule. L'aléa est la seule
construction dont l'unicité ne dépend d'aucun état.

**Conséquences à écrire.**

- Le nonce ne **décrit** plus rien. Un nonce altéré ne se distingue pas d'un chiffré altéré : les
  deux tombent dans le même refus. Épreuve : `tests/unit/vm-format-chiffre-identite.test.mjs` › « le
  nonce fait douze octets et ne dérive de RIEN ».
- Le format **ne sait pas détecter** une réutilisation de nonce. Il est sans état ; l'unicité vient
  du tirage, pas d'un contrôle. Le dire vaut mieux qu'un contrôle qui rassurerait sans rien
  vérifier.
- Le tirage coûte **douze octets stockés** par secteur et par enregistrement, et ≈ 4 µs par
  scellement (ADR 0015, § « Calcul, mesuré »).
- La source de nonces du produit **n'est remplaçable que sous jeton du harnais**, et aucun chemin de
  production n'en fournit : `tests/unit/harnais-portes.test.mjs` › « aucun module hors des épreuves
  ne remplace la source de nonces ». Ce que la garde protège est exécuté :
  `tests/unit/vm-source-de-nonce.test.mjs` › « ce que la garde protège : un nonce constant rend le
  clair récupérable ».

**Bornes de collision.** Sur 96 bits, `N` tirages entrent en collision avec une probabilité majorée
par `N² / 2^97` : **2^-35** au budget retenu de 2^31, 2^-33 au plafond NIST de 2^32. Vérifié sur un
espace représentatif par `tests/unit/vm-format-chiffre-identite.test.mjs` › « aucune collision de
nonce sur un espace représentatif de tirages ».

### 4.3 Empreintes : SHA-256

Deux emplois, tous deux SHA-256 sur 32 octets :

1. **l'empreinte de la suite ordonnée des entrées** d'une génération, qui est le CLAIR que la racine
   scelle (§ 5.3) ;
2. **l'empreinte de la région d'authentification** du volume, scellée dans la racine (§ 6.8).

La seconde est calculée **en flux**, par tranches de 1 Mio, si bien que la surmémoire vaut une
tranche et non la taille de la région (34 Mio pour un volume de 512 Mio). L'implémentation
incrémentale est calibrée contre `crypto.subtle.digest` par `tests/unit/vm-sha256-stream.test.mjs` ›
« concorde avec WebCrypto quel que soit le DÉCOUPAGE en morceaux » — un instrument non calibré
invaliderait ce qu'il mesure.

### 4.4 La clé de volume : reçue, jamais fabriquée par le produit

Trente-deux octets aléatoires, importés dans WebCrypto en clé **non extractible**. Le format ne la
dérive pas, ne l'écrit pas, ne l'efface pas et ne la renouvelle pas : c'est l'objet de
l'[ADR 0020](decisions/0020-enveloppe-de-cle.md) et de
l'[ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md), hors périmètre de cette revue
(§ 11).

Ce que le format SUPPOSE de cette clé, et qu'il ne vérifie pas :

1. qu'elle est **aléatoire et propre à CE volume**. Deux volumes qui partageraient une clé ne
   seraient séparés que par leur identifiant dans les données associées ;
2. qu'elle est remise au **Worker de confiance** de l'ADR 0002 et n'existe nulle part ailleurs ;
3. que sa **durée de vie** est celle de la session déverrouillée ;
4. qu'un **changement de clé** est possible — ce qui, en l'état, signifie rechiffrer le volume
   entier.

L'importation non extractible ne protège pas contre du code hostile déjà présent dans le Worker :
celui-ci s'en sert sans la lire. Elle réduit la surface d'exfiltration accidentelle, et elle est
gratuite.

**Un volume v3 présenté sans clé est REFUSÉ avant toute lecture**, par `VAULT_STORAGE_CLE_REQUISE` :
`tests/unit/vm-volume-chiffre.test.mjs` › « REFUS 7 — un volume v3 SANS CLÉ est refusé par un code
typé, jamais lu en clair ».

### 4.5 Le budget de clé, et la conduite au plafond

| Grandeur                                                |            Valeur |
| ------------------------------------------------------- | ----------------: |
| Plafond d'invocations par clé, NIST SP 800-38D § 8.3    |              2^32 |
| **Budget retenu par ce format**                         |          **2^31** |
| Probabilité de collision de nonce au budget retenu      | `N²/2^97` ≈ 2^-35 |
| Octets de charge correspondants (secteurs de 512 o)     |             1 Tio |
| Réécritures complètes d'un volume applicatif de 512 Mio |             2 048 |

**Ce que le compteur compte.** Le § 8.3 compte « all instances of the authenticated encryption
function ». Ici : chaque enregistrement déposé, chaque secteur rescellé au point de contrôle, chaque
racine écrite, chaque empreinte de région rescellée, chaque témoin écrit. Une barrière du guest qui
valide un enregistrement en consomme donc **quatre** (enregistrement, racine, empreinte de région,
témoin), et non deux : à 2^31, cela ramène le nombre de barrières admissibles sous une clé de ~1,07
milliard à **~537 millions**. Épreuve : `tests/unit/vm-generation-chiffre.test.mjs` › « le compteur
de scellements de la racine COMPTE les racines et les enregistrements ».

**Où il vit.** Dans l'en-tête AUTHENTIFIÉ de la racine (§ 6.7, offset 68). Il traverse donc les
sessions — et il **recule** avec un retour arrière du support. Le nombre réel d'invocations sous la
clé peut alors dépasser le nombre compté, d'un écart qu'aucune mesure ne borne aujourd'hui. La
moitié du plafond NIST est la marge choisie devant cet écart ; c'est la **question n° 4** de la
§ 13.

**Le compteur est sous-estimé hors transaction.** Un volume ouvert sans journal — versement d'une
image de référence, conversion de format — n'écrit aucune racine, donc ses scellements ne sont
comptés que le temps de la session. L'erreur va dans le sens qui laisse consommer plus que prévu, et
elle est écrite ici plutôt que découverte.

**Conduite au plafond.** À 2^31, tout scellement est refusé **avant de produire le moindre octet**,
par `VAULT_CRYPTO_BUDGET_DE_CLE`, traduit en `VAULT_STORAGE_BUDGET_DE_CLE`. Le refus n'est pas
franchissable : le remède est une **clé de volume neuve**, donc le rechiffrement du volume entier,
et ce geste n'existe pas encore dans le produit (§ 11). Épreuves :
`tests/unit/vm-volume-chiffre.test.mjs` › « le budget de clé refuse le scellement AVANT de produire
le moindre octet » et `tests/unit/vm-format-chiffre-identite.test.mjs` › « le budget de scellements
par clé est PLUS SERRÉ que le plafond de NIST, et dit pourquoi ».

## 5. L'identité logique et les données associées

Ce que GCM authentifie sans le chiffrer, ce sont les **données associées**. C'est là que vit
l'identité logique : le format y met tout ce qui pourrait servir à faire passer un objet authentique
pour un autre.

**Deux conventions de boutisme coexistent, et les confondre est l'erreur la plus facile de tout ce
document :**

- **les données associées sont GROS-BOUTISTES** (§ 5.1 à 5.3) ;
- **les en-têtes sur disque sont PETIT-BOUTISTES** (§ 6), par la convention de `DataView` qu'emploie
  le reste du dépôt.

### 5.1 Données associées d'un bloc

Un « bloc » est indifféremment un **secteur du volume**, un **enregistrement du journal**, une
**empreinte de région** ou un **témoin** : une seule forme de données associées les couvre tous, et
c'est ce qui permet une seule fonction d'encodage.

| Ordre | Champ                       | Longueur      | Encodage                                                                             |
| ----- | --------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| 1     | Étiquette de domaine        | 2 + 37 octets | longueur gros-boutiste sur 2 o, puis UTF-8 : `railsbox-vault/format-chiffre/v1/bloc` |
| 2     | Nom de l'algorithme         | 2 + 11 octets | idem : `aes-256-gcm`                                                                 |
| 3     | Version du format de volume | 4 octets      | entier gros-boutiste — **3**                                                         |
| 4     | Identifiant de volume       | 2 + 32 octets | idem : **32 caractères hexadécimaux minuscules**                                     |
| 5     | Génération                  | 8 octets      | entier gros-boutiste                                                                 |
| 6     | Rang de l'entrée            | 8 octets      | entier gros-boutiste                                                                 |
| 7     | Adresse logique             | 8 octets      | entier gros-boutiste                                                                 |
| 8     | Longueur du clair           | 4 octets      | entier gros-boutiste                                                                 |

Total pour un volume v3 : **122 octets**.

**Chaque champ est de largeur fixe ou préfixé de sa longueur, et ce n'est pas une élégance.** Une
concaténation non préfixée permettrait de déplacer un caractère d'un champ à l'autre sans changer
les octets — donc de déplacer un bloc sans que l'étiquette bronche. La propriété est éprouvée **par
mutation** plutôt qu'affirmée : `tests/unit/vm-format-chiffre-identite.test.mjs` › « le PRÉFIXE DE
LONGUEUR est ce qui rend l'encodage injectif : sans lui, deux identités collisionnent ».

**La conversion de l'identifiant de volume est FIXÉE.** Le disque porte **seize octets bruts**
(en-tête v3, racine) ; les données associées portent une **chaîne** de trente-deux caractères
hexadécimaux **minuscules**, sans séparateur. Deux conventions donneraient deux étiquettes
différentes pour le même volume. Épreuve : `tests/unit/vm-format-chiffre-identite.test.mjs` › « la
conversion de l'identifiant de volume est FIXÉE : seize octets vers trente-deux caractères ».

**Bornes des champs, refusées et non rebouclées :** génération ≤ 2^48 − 1 (la largeur du champ sur
le disque, § 6.4), rang ≤ 2^40 − 1, version de format ≤ 2^32 − 1, longueur ≤ 2^32 − 1, adresse ≤
2^53 − 1. Une valeur hors bornes est refusée par `VAULT_CRYPTO_MALFORME` :
`tests/unit/vm-format-chiffre-identite.test.mjs` › « les bornes des champs d'identité sont refusées
avant de reboucler en silence ».

### 5.2 Données associées d'une racine

| Ordre | Champ                       | Longueur      | Encodage                                      |
| ----- | --------------------------- | ------------- | --------------------------------------------- |
| 1     | Étiquette de domaine        | 2 + 39 octets | `railsbox-vault/format-chiffre/v1/racine`     |
| 2     | Nom de l'algorithme         | 2 + 11 octets | `aes-256-gcm`                                 |
| 3     | Version du format de volume | 4 octets      | gros-boutiste — **3**                         |
| 4     | Identifiant de volume       | 2 + 32 octets | 32 hexadécimaux minuscules                    |
| 5     | Séquence                    | 8 octets      | gros-boutiste                                 |
| 6     | Génération                  | 8 octets      | gros-boutiste                                 |
| 7     | Taille LOGIQUE du volume    | 8 octets      | gros-boutiste                                 |
| 8     | Nombre d'entrées            | 4 octets      | gros-boutiste — **dérivé**, jamais reçu       |
| 9     | Longueur de charge          | 8 octets      | gros-boutiste — somme des CLAIRS, **dérivée** |
| 10    | Scellements cumulés         | 8 octets      | gros-boutiste                                 |

Total : **126 octets**.

**Le CLAIR que la racine scelle est l'empreinte SHA-256 de la suite ordonnée de ses entrées** (§
5.3), 32 octets — et rien d'autre.

**L'ordre entre en-tête et clair décide de ce que le format a le droit d'AFFIRMER.** En vérifiant
d'abord l'étiquette sur l'en-tête, le lecteur obtient un en-tête **authentique** ; il peut alors
comparer ce qu'il a trouvé à ce que la racine déclare et nommer une **troncature établie**. Dans
l'autre sens, « troncature » serait un diagnostic posé sur un en-tête que rien ne garantit,
c'est-à-dire une devinette.

**Le compte et la longueur sont DÉRIVÉS des entrées au moment de sceller.** Une racine qui
annoncerait un compte différent de ce qu'elle scelle serait une troncature signée par son propre
producteur. C'est la même règle que celle qui interdit de stocker la longueur physique de la charge
(§ 6.7).

**L'en-tête de racine est en CLAIR sur le support, et il faut dire ce qu'il révèle** : le nombre
d'écritures d'une génération, la longueur de sa charge, le rang de la génération, la taille du
volume et le compteur cumulé de scellements. C'est un canal auxiliaire sur le **volume d'activité**.
Il est assumé, pas découvert : le chiffrer exigerait de choisir la racine qui fait autorité sans
lire son en-tête, ce que l'alternance de la § 6.6 rend impossible. C'est la **question n° 8** de la
§ 13.

### 5.3 Encodage canonique de la suite des entrées

```text
  2 + 40 octets   étiquette de domaine « railsbox-vault/format-chiffre/v1/entrees », préfixée
  4 octets        nombre d'entrées, gros-boutiste
  puis, POUR CHAQUE ENTRÉE, dans l'ordre de la suite :
      8 octets    adresse logique, gros-boutiste
      4 octets    longueur du clair, gros-boutiste
      8 octets    rang, gros-boutiste
     16 octets    ÉTIQUETTE du bloc scellé
```

Soit **36 octets par entrée**. L'empreinte SHA-256 de cette suite est le clair de la racine.

**Pourquoi l'étiquette du bloc et non son chiffré.** Sous une même clé, un même nonce et une même
identité, deux chiffrés distincts partageant une étiquette constitueraient une forgerie GCM, bornée
par 2^-122,6. La racine dit donc **quels** blocs composent la génération ; chaque bloc dit qu'il est
**intact**. Aucune des deux vérifications ne remplace l'autre, et un lecteur doit faire les deux.

**Pourquoi le nonce n'y figure pas.** Il est conservé avec l'enregistrement, et l'étiquette le
couvre déjà : une étiquette ne vérifie que sous le nonce qui l'a produite.

**L'ordre est significatif.** La racine scelle une **suite**, pas un sac : deux permutations des
mêmes entrées sont deux générations différentes. Les rangs doivent croître **strictement** —
`tests/unit/vm-format-chiffre-identite.test.mjs` › « les rangs d'une génération doivent croître
STRICTEMENT : l'ordre est une propriété » —, faute de quoi le scellement est refusé par
`VAULT_CRYPTO_ORDRE_INVALIDE` avant de produire un octet.

**Une borne mémoire, trouvée par exécution.** L'assemblage de cette suite doit se faire sans étaler
ses morceaux sur la pile d'appel : au plafond de charge du journal, le nombre de morceaux dépasse la
pile de tous les moteurs mesurés (« Maximum call stack size exceeded » au milieu d'une
récupération). La rupture tombait à **31 170 entrées**, soit 15,22 Mio — **sous** le plafond de 16
Mio, donc atteignable par une génération que le produit accepte. Les octets produits sont inchangés.
Épreuve : `tests/unit/vm-format-chiffre-identite.test.mjs` › « l'encodage des entrées tient une
génération AU PLAFOND, sans déborder la pile d'appel ».

### 5.4 Les rangs, et les trois rangs réservés

Le rang sépare des identités qui partageraient tout le reste. Trois valeurs sont **épinglées par le
format** :

| Rang       | Valeur              | Ce qu'il identifie                                          |
| ---------- | ------------------- | ----------------------------------------------------------- |
| 0          | `0`                 | un **secteur du volume** — une seule version par génération |
| `2^40 − 2` | `1 099 511 627 774` | le **témoin** de dernière séquence vue                      |
| `2^40 − 1` | `1 099 511 627 775` | l'**empreinte de la région** d'authentification             |

Les rangs qu'un volume emploie réellement partent de zéro et la charge est plafonnée à 16 Mio, soit
au plus quelques dizaines de milliers d'entrées : prendre les deux plus grands rangs représentables
met ces identités hors d'atteinte de toute collision **sans coûter un octet de format**.

Un enregistrement de journal, lui, porte sa **position dans la charge**, en base zéro.

## 6. La disposition sur disque

### 6.1 Le fichier de volume

```text
  offset 0                      en-tête v3                 1 secteur   (512 o)
  offset 512                    région d'authentification  R secteurs
  offset 512 + R × 512          charge chiffrée            N secteurs
```

avec `N = tailleLogique / 512` et `R × 512 = alignerHaut(N × 34, 512)`.

Un secteur logique d'adresse `a` vit à l'offset support `512 + R × 512 + a`, et son sceau à
`512 + (a / 512) × 34`.

**La taille LOGIQUE reste celle que l'émulateur voit.** Le mappage est confiné à une seule pièce, ce
qui permet à la géométrie de blocs, au contrat de tampon de v86 et à l'oracle de résilience de
n'avoir pas bougé.

Pour le volume applicatif de 512 Mio :

| Grandeur                |        Valeur |
| ----------------------- | ------------: |
| Taille logique          | 536 870 912 o |
| Secteurs logiques `N`   |     1 048 576 |
| Région `N × 34`         |  35 651 584 o |
| Région, en secteurs `R` |        69 632 |
| Taille du fichier       | 572 523 008 o |
| **Surcoût**             |  **+6,641 %** |

La région tombe juste à cette taille, sans rembourrage. Elle est alignée **vers le haut** dans le
cas général : la tronquer priverait les derniers secteurs de leur sceau, c'est-à-dire les rendrait
illisibles. Épreuves : `tests/unit/vm-volume-chiffre-format.test.mjs` › « la disposition d'un volume
de 512 Mio tombe juste sur 69 632 secteurs de région » et
`tests/unit/vm-volume-chiffre-format.test.mjs` › « une région qui ne tombe pas juste est alignée
VERS LE HAUT, jamais tronquée ».

**Pourquoi une région dédiée plutôt qu'un entrelacement.** Entrelacer (546 octets par secteur
logique) casserait l'alignement sur 512 et sur la page hôte de 4 096 octets, donc la géométrie que
le backend impose et que le point de contrôle exploite pour recopier des secteurs alignés.
**Pourquoi dans le fichier du volume et non dans un voisin** `<volume>.auth` : un voisin ajouterait
un problème d'atomicité entre deux fichiers là où il n'y en a pas — un handle, une barrière, un
fichier.

**Ce que la région coûte en lecture.** Lire un secteur exige ses 34 octets de métadonnées, donc une
lecture de plus. Une page hôte de 4 096 octets de région porte les métadonnées de **120 secteurs
consécutifs** (60 Kio de charge) : le surcoût est d'une lecture par ~120 secteurs en accès
séquentiel, et d'une lecture par secteur en accès aléatoire.

### 6.2 L'en-tête v3, champ par champ

Un secteur, **petit-boutiste**.

| Offset | Largeur | Champ                                                  |
| ------ | ------: | ------------------------------------------------------ |
| 0      |       8 | marqueur `VLTVOL03` (ASCII)                            |
| 8      |       4 | version du format de volume — **3**                    |
| 12     |       4 | taille de secteur — **512**                            |
| 16     |       8 | taille LOGIQUE du volume                               |
| 24     |       8 | offset de la région d'authentification — **512**       |
| 32     |       8 | longueur de la région d'authentification               |
| 40     |       8 | offset de la charge chiffrée                           |
| 48     |      16 | identifiant de volume, **seize octets bruts**          |
| 64     |       8 | **marque de scellement complet** — `VLTSEAL1` ou zéros |
| 72     |     440 | réserve, à zéro                                        |

Les 512 octets de cet en-tête sont figés dans `tests/vectors/disposition-v3.json`, champ
`enTete.hex`, et le vérificateur de la § 2 les reconstruit champ par champ.

**Les trois offsets déclarés (24, 32, 40) sont REDONDANTS avec la taille logique**, et le décodeur
les traite comme tels : il recalcule la disposition depuis la taille logique et **refuse** l'en-tête
dont les offsets déclarés ne concordent pas. Un en-tête qui mentirait sur l'endroit où la charge
commence ferait lire des sceaux comme des données.

**Cet en-tête n'est PAS une autorité, et il ne prétend pas l'être.** Il n'est ni chiffré ni
authentifié : il **localise**. Ce qui le rend inoffensif est ailleurs — l'identifiant de volume et
la version de format entrent dans les données associées de **chaque** secteur, si bien qu'un en-tête
falsifié fait échouer la première lecture par un sceau refusé au lieu de rendre du clair. Le seul
dommage qu'une altération produise est donc un **refus**, jamais une lecture erronée. L'authentifier
exigerait de pouvoir le lire sans connaître l'identifiant qu'il porte, ce qui est circulaire.

**Ce que le décodeur refuse sans clé** : marqueur absent, version autre que 3, taille de secteur
autre que 512, taille logique inadmissible, et **disposition incohérente** — l'en-tête qui placerait
la région ou la charge ailleurs que là où la taille logique l'impose. Épreuves :
`tests/unit/vm-volume-chiffre-format.test.mjs` › « l'en-tête v3 fait un secteur, porte son marqueur
et rend ce qu'il a reçu » et `tests/unit/vm-volume-chiffre-format.test.mjs` › « un en-tête dont la
disposition ne se déduit pas de sa taille logique est refusé ».

**L'ouverture confronte l'identifiant de l'en-tête à celui que le MANIFESTE déclare** et refuse
l'écart par `VAULT_STORAGE_IDENTITE_VOLUME` avant toute lecture de charge : deux sources qui
divergent ne se départagent pas, elles se refusent.

### 6.3 La marque de scellement complet

Huit octets `VLTSEAL1` à l'offset 64 de l'en-tête. **Elle est le DERNIER geste d'une création ou
d'une conversion**, posé après le dernier secteur scellé, puis matérialisé par une barrière.

**Le problème qu'elle ferme.** L'en-tête est écrit et flushé AVANT que le volume ne soit scellé — il
faut connaître la disposition pour savoir où écrire les sceaux. Entre les deux s'ouvre une fenêtre
qui dure le temps de sceller tout le volume (**87,6 s mesurées pour 512 Mio**), et une coupure qui y
tombe laisse un fichier ayant l'exacte apparence d'un volume. Sans la marque, ce fichier se
présenterait comme ouvrable et rendrait un refus de sceau au premier secteur lu — envoyant
l'exploitant restaurer la sauvegarde d'un volume qui n'a jamais servi.

**Huit octets d'un motif, et non un bit.** Un bit, ou un octet non nul, serait posé par accident :
une page jamais écrite que le support rend en `0xff`, un octet retourné, un reliquat d'un autre
format suffiraient à faire passer un volume inachevé pour un volume complet — et c'est exactement
l'état qu'on veut interdire. Épreuve : `tests/unit/vm-volume-neuf-incomplet.test.mjs` › « la marque
est un MOTIF, pas un bit : des octets quelconques ne la fabriquent pas ».

**Elle n'est pas authentifiée**, comme le reste de l'en-tête. Ce qu'elle protège est une erreur
d'exploitation, pas un adversaire.

**Un volume v3 sans cette marque est refusé** par `VAULT_STORAGE_VOLUME_INCOMPLET`, dont le message
nomme le seul remède vrai : supprimer et recréer. Épreuves :
`tests/unit/vm-volume-neuf-incomplet.test.mjs` › « un volume dont le scellement initial n'a pas
abouti est REFUSÉ à la réouverture » et `tests/unit/vm-volume-neuf-incomplet.test.mjs` › « la marque
de scellement complet n'est posée qu'APRÈS le dernier secteur ».

**Pourquoi un tel volume n'est PAS rescellé automatiquement**, alors que ce serait sans perte : la
marque vit dans l'en-tête, qui n'est pas authentifié. Un rescellement automatique donnerait à
quiconque peut effacer huit octets le moyen de faire écraser tout le volume par des zéros scellés —
c'est-à-dire de le détruire par un geste que rien ne distingue d'une réparation. Le refus, lui, ne
laisse à cet adversaire qu'un déni de service qu'il avait déjà.

### 6.4 Le sceau de 34 octets

```text
  nonce 12 o  ‖  étiquette 16 o  ‖  génération 6 o, PETIT-BOUTISTE   =  34 octets
```

**Une seule forme pour deux endroits** : la région d'authentification du volume **et** le sceau d'un
enregistrement de journal. Une seule fonction d'encodage, une seule de décodage, un seul jeu
d'épreuves — deux encodages du même objet finissent toujours par diverger. Épreuve :
`tests/unit/vm-volume-chiffre-format.test.mjs` › « un sceau fait 34 octets : nonce 12, étiquette 16,
génération 6 ».

**Pourquoi la génération est stockée.** Un secteur du volume est lu **isolément** : le lecteur
connaît son adresse et rien d'autre. Comme les données associées portent la génération, il faut la
lui donner — six octets, la largeur du champ. Le **rang**, lui, est épinglé à zéro par le format :
un secteur ne porte qu'une version par génération, le rang n'y ajoute rien, et le fixer évite cinq
octets de plus.

**Un sceau entièrement à zéro se décode comme n'importe quel autre, et c'est délibéré.** Le
distinguer rendrait un secteur zéroté « vierge » plutôt que « refusé » — précisément l'attaque que
la § 6.5 ferme. C'est l'étiquette qui refuse, jamais le décodeur. Épreuve :
`tests/unit/vm-volume-chiffre-format.test.mjs` › « un sceau ENTIÈREMENT À ZÉRO se décode, et c'est
délibéré ».

**Un enregistrement de région peut CHEVAUCHER deux secteurs du support** : 34 ne divise pas 512. Une
déchirure sur la frontière abîme le sceau, et le secteur correspondant est **refusé** à la lecture
suivante. Ce n'est pas un affaiblissement : le secteur de charge et son sceau sont de toute façon
deux écritures distinctes qu'aucune atomicité ne lie. Ce que le format promet ici est un **refus**,
pas une lecture. Épreuve : `tests/unit/vm-volume-chiffre.test.mjs` › « un sceau À CHEVAL sur deux
secteurs du support, à moitié écrit, est refusé ».

### 6.5 La charge chiffrée, et l'absence de secteur vierge

La charge porte, pour chaque secteur logique, les 512 octets de son chiffré — sans étiquette, qui
vit dans la région. Le chiffré d'AES-GCM a exactement la longueur du clair.

**Un secteur « jamais écrit » ne peut pas exister en v3.** Si la région était à zéro pour un secteur
vierge, un adversaire n'aurait qu'à zéroter ces 34 octets pour faire lire un secteur comme blanc. La
**création** d'un volume et la **restauration** scellent donc TOUS les secteurs, y compris ceux qui
ne portent que des zéros. Épreuves : `tests/unit/vm-volume-chiffre.test.mjs` › « REFUS 5 — un
secteur EN CLAIR, jamais scellé, est refusé : pas de secteur vierge en v3 » et
`tests/unit/vm-volume-chiffre.test.mjs` › « sceller un volume ENTIER ne laisse aucun secteur sans
sceau ».

**L'ordre des deux écritures d'un secteur, et pourquoi il ne change rien.** Écrire un secteur, c'est
écrire deux choses : sa charge et son sceau. Aucune atomicité ne les lie, et le format n'en suppose
aucune. La charge est écrite en premier, si bien qu'une coupure entre les deux laisse « charge
neuve, sceau ancien » — refusé. L'ordre inverse laisserait « sceau neuf, charge ancienne » — refusé
aussi. La protection contre la **perte** est ailleurs : dans le journal (§ 6.6), dont le point de
contrôle est le seul geste qui écrive le volume et dont l'échec ne valide rien. Épreuve sur support
réel : `tests/vm/resilience-arrets.spec.mjs` › « sur OPFS réel, une écriture déchirée n'entame plus
le volume ».

**Une lecture ne rend jamais de zéros.** Un sceau qui ne vérifie pas est un refus typé, et le
secteur n'est pas rendu du tout — ni partiellement, ni complété. Le pilote du guest interpréterait
des octets manquants comme des données valides.

### 6.6 Le journal de génération `<volume>.gen`

Une **génération** est l'ensemble des écritures comprises entre deux barrières acquittées. Elle est
déposée dans ce voisin, puis **validée** par l'écriture d'une racine.

```text
  offset 0        racine 0        1 secteur, dans une page hôte de 4 096 o
  offset 4096     racine 1        1 secteur, dans la page hôte suivante
  offset 8192     charge : les enregistrements, à la suite
```

**Les racines ALTERNENT** : la racine de séquence `s` occupe l'emplacement `s mod 2`. Une validation
interrompue ne peut donc pas détruire la racine qui fait autorité — ce qui serait la perte d'une
écriture acquittée. « Ne peut pas », et non « ne peut jamais » : la propriété repose sur une
hypothèse écrite — **deux pages hôtes distinctes ne sont pas abîmées ensemble** —, et c'est pourquoi
les deux emplacements sont séparés par une page de 4 096 octets et non par un secteur. Épreuves :
`tests/unit/vm-generation-format.test.mjs` › « les deux racines alternent, et une validation
n'écrase jamais celle qui fait autorité » et `tests/unit/vm-generation-store.test.mjs` › « la racine
alterne : une validation déchirée ne détruit pas la génération qu'elle remplace ».

**La racine qui fait autorité est celle de séquence la plus haute** parmi celles qui sont lisibles.

#### La disposition d'un enregistrement

```text
  en-tête 16 o   ‖   sceau 34 o   ‖   chiffré L o
```

En-tête, **petit-boutiste** :

| Offset | Largeur | Champ                        |
| ------ | ------: | ---------------------------- |
| 0      |       8 | offset LOGIQUE de l'écriture |
| 8      |       4 | longueur `L` du clair        |
| 12     |       4 | réserve, à zéro              |

Le surcoût est donc **FIXE : 50 octets** par enregistrement (16 + 34), ce qui permet de dériver la
longueur physique d'une charge de ce que la racine authentifie (§ 6.7). Épreuve :
`tests/unit/vm-generation-format.test.mjs` › « le surcoût d'un enregistrement est FIXE, et la
longueur physique s'en déduit ».

L'en-tête n'est **pas authentifié** ; les mêmes champs le sont dans les données associées du sceau,
si bien qu'un en-tête falsifié conduit à un refus de sceau, jamais à un clair. Sa plausibilité
(`offset + longueur ≤ tailleVolume`) reste le premier filtre d'un parcours.

#### Un enregistrement porte SA génération, et c'est une correction

Une charge de journal **n'appartient pas à une seule génération** : la validation incrémente la
génération et scelle une racine **sans vider le journal**, qui n'est vidé qu'au point de contrôle.
Entre deux points de contrôle, plusieurs validations se succèdent donc sur la même charge cumulée,
et la racine la plus récente scelle des enregistrements déposés sous des générations **antérieures à
la sienne**. Un lecteur qui reconstruirait les données associées à partir de la génération de la
racine échouerait sur tous les enregistrements des générations précédentes — c'est-à-dire sur le
chemin de reprise le plus courant. Épreuve : `tests/unit/vm-generation-chiffre.test.mjs` › « DEUX
validations sans point de contrôle se rejouent : l'enregistrement porte SA génération ».

C'est ce constat qui porte le surcoût d'un enregistrement de 28 à **34 octets** (§ 12, écart 1 du
tableau des coûts).

#### Les plafonds du journal

| Grandeur                            | Valeur | Ce qu'elle décide                                 |
| ----------------------------------- | -----: | ------------------------------------------------- |
| Point de contrôle amorti au-delà de |  8 Mio | quand le journal est rangé dans le volume et vidé |
| Plafond de charge d'une génération  | 16 Mio | au-delà, l'écriture est REFUSÉE, jamais acquittée |

Un guest qui écrirait plus de 16 Mio sans franchir de barrière reçoit
`VAULT_STORAGE_GENERATION_OVERFLOW`, qui devient une erreur d'E/S ATA : un refus bruyant et typé,
jamais une promesse non tenue. Le plafond est calibré sur le budget de récupération de
`docs/quality-attributes.md` : `tests/vm/recuperation-generation.spec.mjs` › « une génération portée
au plafond est retrouvée dans le budget, sur OPFS réel ».

### 6.7 La racine v3, champ par champ

Un secteur, **petit-boutiste**. **202 octets** utilisés sur 512 ; le reste est à zéro.

| Offset | Largeur | Champ                                     | Dans les données associées ?     |
| ------ | ------: | ----------------------------------------- | -------------------------------- |
| 0      |       8 | marqueur `VLTGEN01` (ASCII)               | non — il localise                |
| 8      |       4 | format du journal — **3**                 | non — il localise                |
| 12     |       4 | taille de secteur — **512**               | non — il localise                |
| 16     |       8 | séquence                                  | **oui**                          |
| 24     |       8 | génération                                | **oui**                          |
| 32     |       8 | taille LOGIQUE du volume                  | **oui**                          |
| 40     |       4 | nombre d'entrées                          | **oui**                          |
| 44     |       8 | longueur de charge (somme des CLAIRS)     | **oui**                          |
| 52     |      16 | identifiant de volume, seize octets bruts | voir ci-dessous                  |
| 68     |       8 | scellements cumulés                       | **oui**                          |
| 76     |      12 | nonce                                     | —                                |
| 88     |      32 | chiffré : l'empreinte scellée des entrées | —                                |
| 120    |      16 | étiquette                                 | —                                |
| 136    |      66 | **fraîcheur de région** (§ 6.8)           | — (non authentifiée en PRÉSENCE) |
| 202    |     310 | réserve, à zéro                           | —                                |

**Le CRC-32 de l'ancien format a disparu**, remplacé par l'étiquette : elle refuse ce qu'un CRC
détectait (déchirure, octet retourné) **plus** ce contre quoi il ne prétendait rien — un altérateur
volontaire, qui recalculait un CRC sans difficulté. Épreuves :
`tests/unit/vm-generation-chiffre.test.mjs` › « le format du journal passe à 3, et sa racine occupe
202 octets » et `tests/unit/vm-generation-chiffre.test.mjs` › « la racine v3 ne porte plus de CRC-32
: l'étiquette a pris sa place ».

**L'identifiant de volume de la racine est le seul champ dont la colonne se lit de travers.**
L'identité qui entre RÉELLEMENT dans les données associées est celle que le **manifeste** déclare et
que l'ouvreur porte, pas celle qu'on lit sur le disque : retourner la copie sur disque ne change
donc pas l'étiquette. Elle n'est pas crue pour autant — elle est **confrontée** à l'identité de
l'ouvreur, et l'écart est refusé par `VAULT_STORAGE_IDENTITE_VOLUME` avant tout parcours. Cela
distingue « ce journal appartient à un autre volume » de « ce journal est abîmé », deux états dont
les remèdes n'ont rien de commun. La copie sur disque est un **localisateur, pas une autorité**.
Épreuves : `tests/unit/vm-generation-format.test.mjs` › « un octet retourné dans un champ de
LOCALISATION est refusé SANS clé » et `tests/unit/vm-generation-format.test.mjs` › « un octet
retourné dans un champ AUTHENTIFIÉ se décode encore, et c'est l'étiquette qui refuse ».

**La longueur PHYSIQUE de la charge n'est pas stockée**, elle se déduit :

```text
  longueurPhysique = longueurCharge + nombreEntrees × 50
```

Deux grandeurs stockées peuvent diverger ; une grandeur dérivée ne le peut pas.

**Le format du journal fait barrière de version.** Ce runtime **lit** les formats 2 et 3 et
**n'écrit jamais** un format 2. Un runtime plus ancien refuse une racine de format 3 par « Format de
journal de génération inconnu : 3 », ce qui est exactement le comportement voulu : il ne
confronterait pas la région et croirait fraîche une version d'hier.

**Une racine VIDE est authentifiée comme les autres, et c'est ce qui la rend sûre.** Elle n'a aucune
charge à confronter, et **elle fixe à elle seule la génération et la séquence** de la session à
venir — c'est l'état que laisse tout point de contrôle, donc l'état le plus fréquent d'un journal au
repos. Un journal dont la racine vide serait forgée avec une séquence plus haute ferait autorité, et
la génération réellement validée serait écartée comme « dépassée » : une écriture acquittée perdue
sans qu'aucun code ne mente. Le parcours est donc exécuté même pour une charge de zéro entrée.
Épreuve : `tests/unit/vm-generation-chiffre.test.mjs` › « une racine VIDE est authentifiée elle
aussi : c'est elle qui fixe la génération ».

### 6.8 La fraîcheur : la racine date la région d'authentification

**Le défaut que cela ferme.** Un secteur du volume est ouvert sous une identité que le lecteur ne
connaît pas d'avance : il lit sa **génération** dans la région, juste à côté du nonce et de
l'étiquette du même secteur. Le sceau et l'identité viennent donc **du même endroit**. Un adversaire
qui remet en place le **quadruplet complet** d'une version antérieure du même secteur — chiffré,
nonce, étiquette, génération — produit un ensemble cohérent, et un lecteur qui ne regarderait que ce
secteur l'accepterait. Le tirage du nonce n'y change rien : il garantit l'unicité, pas la fraîcheur
; un sceau authentique d'hier reste authentique aujourd'hui.

**La parade : sceller AILLEURS une empreinte de la région entière.** « Ailleurs » veut dire : dans
la racine de génération, dont l'autorité vient du journal et pas du volume.

Les 66 octets à l'offset 136 de la racine :

```text
  sceau 34 o  (nonce 12 ‖ étiquette 16 ‖ génération 6, petit-boutiste)
  chiffré 32 o  — l'empreinte SHA-256 de la région, scellée
```

L'identité logique de cet objet est le **rang réservé `2^40 − 1`**, adresse 0, longueur 32, sous
l'identifiant de volume et la version de format de la session.

**Elle est RESCELLÉE à chaque écriture de racine, sous la génération de CETTE racine.** Sans cela,
une empreinte authentique mais scellée sous une génération antérieure pourrait être épissée dans une
racine récente, et la région d'hier passerait pour celle d'aujourd'hui. La confrontation présente
donc `generationMinimale = generation de la racine porteuse`, et le refus est un rejeu **établi**.

**Elle n'est REHACHÉE que si le volume a été écrit** depuis la dernière : le seul geste qui écrive
le volume est le point de contrôle. Les racines intermédiaires rescellent l'empreinte tenue en cache
— un chiffrement de 32 octets, pas un hachage de 34 Mio. La marque « région salie » est levée
**avant** l'attente du hachage et jamais après : un point de contrôle peut écrire pendant le
hachage, et lever la marque après aurait scellé l'état d'avant. Épreuve :
`tests/unit/vm-generation-fraicheur.test.mjs` › « une région salie PENDANT le hachage n'est pas
oubliée ».

**À l'ouverture, la région relue est confrontée à cette empreinte AVANT toute lecture de secteur.**
Un volume dont la région ne concorde plus ne rend aucun clair, fût-il authentique. Épreuve :
`tests/unit/vm-generation-fraicheur.test.mjs` › « un SECTEUR ramené en arrière hors journal est
refusé, alors que ce secteur reste authentique » — l'épreuve démontre les **deux moitiés** du fait :
le secteur remis en place reste authentique, et l'ouverture transactionnelle le refuse tout de même.
Voir aussi `tests/unit/vm-generation-fraicheur.test.mjs` › « une RÉGION qui change sous une racine
inchangée est refusée, empreinte à l'appui ».

**Ce que la présence de l'empreinte n'établit pas, et qui est le prix payé.** L'empreinte n'est pas
dans les DONNÉES ASSOCIÉES de la racine : y ajouter un champ aurait imposé une version de
spécification cryptographique et invalidé les vecteurs figés de l'ADR 0015. Seule sa **valeur** est
authentique ; sa **présence** ne l'est pas. Ce qui ferme ce reste est le témoin (§ 6.9) et une garde
de cohérence : une racine qui se déclare de format 2 au-dessus d'octets de fraîcheur non nuls est
refusée — un des deux ment. C'est une garde, pas une authentification, et la nuance est écrite
plutôt que gommée.

**Coût mesuré.** Empreinte d'une région de 34 Mio sur OPFS réel : p50 de **345 à 354 ms**, p95 de
350 à 383 ms sur deux exécutions, soit **0,58 % et 0,64 %** du budget de reprise de 60 s. Le seuil
épinglé par l'épreuve est **un pour cent** de ce budget, et c'est un **engagement**, pas une
observation : `tests/vm/fraicheur-region-cout.spec.mjs` › « l'empreinte de région d'un volume de 512
Mio reste sous le pour-cent du budget de reprise ». Ce que la mesure ne borne pas : la
**fréquence**. Une session paie une empreinte à l'ouverture et une par point de contrôle ; rien
n'interdit qu'une application en paie beaucoup, et personne ne l'a mesuré.

**Compatibilité : lire deux formats, n'écrire que le plus récent.** Un volume scellé avant l'ADR
0019 porte une racine de format 2, sans empreinte. Ce runtime la décode, la rend explicitement comme
« aucune empreinte scellée » — jamais comme une empreinte de zéros, qui serait une empreinte comme
une autre — et ne prétend **aucune** fraîcheur pour cette ouverture-là ; le rapport d'ouverture
publie l'état `migree`. La fenêtre dure **exactement une ouverture** : toute récupération se termine
par un vidage, qui écrit une racine neuve, donc de format 3. Épreuve :
`tests/unit/vm-generation-fraicheur.test.mjs` › « un volume scellé par #18 reste OUVRABLE, et migre
à la première racine écrite ». Pendant cette unique ouverture, un secteur ramené en arrière n'est
pas détecté ; l'état est celui d'avant l'ADR 0019, ni meilleur ni pire, et il ne se reproduit pas.

Les quatre états que le rapport d'ouverture publie — un contrôle qu'on ne publie pas finit par être
supposé actif :

| État          | Ce qu'il dit                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `non-fournie` | le magasin n'a reçu aucune source de région : aucune fraîcheur n'est prétendue  |
| `sans-racine` | aucune racine ne faisait autorité : il n'y avait rien à confronter              |
| `migree`      | la racine trouvée est d'avant l'ADR 0019 ; la prochaine portera l'empreinte     |
| `verifiee`    | la région relue concorde avec l'empreinte que la dernière racine validée scelle |

### 6.9 Le témoin `<volume>.temoin`

Soixante octets, **petit-boutiste**.

| Offset | Largeur | Champ                               |
| ------ | ------: | ----------------------------------- |
| 0      |       8 | marqueur `VLTTEM01` (ASCII)         |
| 8      |       4 | version du format de témoin — **1** |
| 12     |       4 | réserve, à zéro                     |
| 16     |      12 | nonce                               |
| 28     |      16 | étiquette                           |
| 44     |      16 | chiffré                             |

Le **clair** de seize octets, scellé sous le rang réservé `2^40 − 2`, génération 0, adresse 0 :

| Offset | Largeur | Champ                                                 |
| ------ | ------: | ----------------------------------------------------- |
| 0      |       8 | dernière séquence vue                                 |
| 8      |       6 | génération de cette séquence                          |
| 14     |       1 | la racine correspondante portait-elle une empreinte ? |
| 15     |       1 | réserve, à zéro                                       |

**Il est écrit APRÈS la racine et sa barrière, jamais avant. L'ordre est le contrat.** Une coupure
entre les deux laisse un témoin **en retard** : un plancher en retard sous-détecte, il ne refuse
jamais à tort. L'ordre inverse laisserait un témoin **en avance**, c'est-à-dire un volume intact
refusé. Épreuve sur support réel, coupant dans cette fenêtre exacte :
`tests/vm/resilience-fraicheur.spec.mjs` › « une coupure ENTRE la racine et le témoin laisse un
témoin en retard, jamais un refus ».

**Il est retiré avec le volume**, et aussi par tout geste qui RÉÉCRIT le volume entier : la
restauration et la migration. Un témoin survivant attesterait, pour un volume homonyme créé ensuite
ou pour un volume réécrit depuis une archive, une séquence que celui-ci n'a jamais atteinte : la
prochaine ouverture refuserait un volume sain, et le message désignerait un retour arrière qui n'a
pas eu lieu. La règle est donc écrite plutôt que laissée à la vigilance — **un témoin ne date que le
volume qu'il accompagne**.

**Absent = première ouverture, jamais une preuve.** C'est le point où la nuance se perd le plus
facilement.

**Ce que le scellement du témoin achète, exactement** : un témoin **forgé** — une séquence inventée
par qui n'a pas la clé — est refusé au lieu d'être cru. Cela ne rend pas le témoin monotone ; cela
évite seulement qu'un tiers sans clé fabrique un refus permanent en y inscrivant une séquence
démesurée.

**Deux refus que le témoin ajoute, et qui n'existaient pas :**

- un journal **sans aucune racine** sous un témoin présent. Le témoin ne s'écrit qu'après une racine
  et sa barrière : son existence prouve qu'une racine a été durable, et son absence du journal est
  un recul, pas un volume neuf. Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « un
  journal SANS racine sous un témoin présent est refusé : c'est un recul, pas un volume neuf » ;
- une racine **sans empreinte** sous un témoin qui en atteste une. Une propriété acquise ne se
  reperd pas ; cet état décrit un retour à une racine d'avant la fraîcheur. Épreuve :
  `tests/unit/vm-generation-fraicheur.test.mjs` › « une fois la fraîcheur acquise, un retour à une
  racine SANS empreinte est refusé ».

**Sa limite, sans détour, et l'effort n'est PAS symétrique.** Reculer le volume suppose d'en détenir
une copie antérieure, cohérente avec son journal. **Neutraliser le témoin ne suppose rien : le
supprimer, ou simplement le tronquer, suffit — et sans la clé.** Un fichier absent, vide ou trop
court n'est pas un témoin ; l'ouverture repart sur « première ouverture », donc sans plancher, et la
fenêtre du retour arrière complet est **réarmée** pour qui détient déjà une copie antérieure de
volume + journal. Ce comportement est délibéré et ne doit pas changer : refuser tout volume sans
témoin rendrait irouvrable un volume neuf, un volume restauré depuis une archive, ou un volume dont
le témoin a été perdu par un incident de support — on échangerait une détection qu'on n'a pas contre
une perte de données qu'on aurait. Ce qui manque n'est pas une garde de plus : c'est une **ancre
monotone hors du support** (§ 9, § 13 question n° 3).

En revanche, un fichier qui **ressemble** à un témoin mais dont le sceau ne vérifie pas est REFUSÉ,
jamais ignoré : l'ignorer offrirait à quiconque peut écrire dans l'origine le moyen de désarmer le
contrôle en abîmant huit octets.

### 6.10 Le manifeste v3

Le manifeste est un voisin **JSON, ni chiffré ni authentifié**. Ce que la v3 y ajoute et rend
obligatoire :

| Champ              | Valeur                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `formatVersion`    | **3**                                                                                                            |
| `volume.id`        | l'identifiant **opaque, aléatoire, immuable**, inscrit à la création — **exactement 32 hexadécimaux minuscules** |
| `volume.algorithm` | `aes-256-gcm`, **seul admis**                                                                                    |

Une forme approchante de `volume.id` donnerait une autre chaîne dans les données associées, donc un
autre volume : elle est refusée, jamais normalisée. Un `volume.algorithm` autre est refusé par
`VAULT_MANIFEST_MALFORMED`.

**Les bornes de version, et ce qu'elles couvrent EXACTEMENT** : `MIN_READABLE_FORMAT_VERSION` vaut 1
et porte sur le **manifeste**, c'est tout ce qu'il a jamais porté. **Le manifeste d'un v1 ou d'un v2
se lit ; leur FICHIER ne s'ouvre pas** — il n'a ni région d'authentification ni nonce, si bien qu'un
runtime v3 n'a nulle part où écrire le sceau d'un secteur. Ce n'est pas un refus de politesse, c'est
une absence de place. Un runtime plus ancien qui rencontre `formatVersion: 3` le refuse par
`VAULT_MANIFEST_FORMAT_TOO_NEW`, ce qui empêche un runtime v2 d'écrire en clair dans un volume
chiffré. Épreuve : `tests/unit/vm-volume-manifest.test.mjs` › « un format FUTUR inconnu est refusé
en lecture comme en écriture ».

**Le manifeste est ce qui rend l'identité OPPOSABLE.** L'ouvreur le lit, confronte son `volume.id` à
celui de l'en-tête du fichier, et refuse l'écart avant toute lecture. Un volume sans manifeste
identifiable n'est jamais ouvert en écriture : `tests/unit/vm-opfs-volume-open.test.mjs` › « un
volume sans manifeste voisin n'est JAMAIS ouvert en écriture ».

**Portée exacte du contrôle, et ce qui n'est pas garanti par le code.** L'ouvreur unique est une
**discipline de revue**, pas une contrainte de l'outillage : l'ouverture de bas niveau reste
appelable directement, et plusieurs sites de production le font. Rien n'empêche un nouveau chemin
d'en ajouter un sans passer par l'ouvreur. C'est écrit ici parce qu'un relecteur le découvrirait
sinon en lisant le code.

## 7. Les gestes, dans l'ordre

### 7.1 Créer un volume

1. saisir le handle exclusif ; **exiger la clé** — sans elle, rien n'est alloué ;
2. allouer le fichier à sa taille support, écrire l'en-tête v3 **sans** la marque de scellement
   complet, barrière ;
3. sceller **tous** les secteurs, par tours bornés en mémoire, en écrivant charge puis sceau ;
4. poser la marque `VLTSEAL1`, barrière. **C'est le dernier geste.**

Une coupure avant l'étape 4 laisse un volume refusé par `VAULT_STORAGE_VOLUME_INCOMPLET` (§ 6.3).

### 7.2 Écrire, valider, ranger

1. **Déposer** — l'écriture du guest est alignée sur des secteurs entiers par relecture au besoin,
   scellée sous « génération validée + 1 », et ajoutée à la charge du journal. Une écriture, une
   seule. Épreuve : `tests/unit/vm-generation-store.test.mjs` › « une écriture non alignée sur le
   secteur est complétée par relecture, pas refusée en silence ».
2. **Valider** — à la barrière du guest : la génération est incrémentée, une racine est scellée sur
   la suite ordonnée des entrées, l'empreinte de région y est rescellée, la racine est écrite à
   l'emplacement `séquence mod 2`, barrière ; **puis** le témoin est écrit. L'acquittement au guest
   suit un flush réel du support : `tests/unit/vm-durability-barrier.test.mjs` › « aucune barrière
   n'est acquittée au guest avant que le flush OPFS ait rendu la main ».
3. **Ranger** (point de contrôle, amorti au-delà de 8 Mio de charge validée) — la charge validée est
   relue, chaque enregistrement ouvert, **rescellé secteur par secteur sous un nonce NEUF**, écrit
   dans le volume ; puis le journal est vidé par une racine vide.

**Le rescellement, et ses trois conséquences assumées.** Le journal scelle des **enregistrements**,
dont la longueur est celle de l'écriture du guest et peut couvrir plusieurs secteurs ; le volume est
adressé **au secteur** et doit pouvoir être relu secteur par secteur. Une étiquette par
enregistrement obligerait, pour vérifier un seul secteur, à relire tout l'enregistrement dont il
vient — et d'abord à le RETROUVER, ce que le volume ne sait pas faire. D'où :

1. **le clair transite en mémoire** entre l'ouverture de l'enregistrement et le scellement des
   secteurs ;
2. **les octets rangés sont scellés deux fois** — une fois au dépôt, une fois au rangement ;
3. **un enregistrement non aligné est REFUSÉ**, jamais complété : le compléter exigerait de LIRE le
   volume, ce qui n'est pas le travail de la couche qui rescelle. Épreuves :
   `tests/unit/vm-format-chiffre-modele.test.mjs` › « POINT DE CONTRÔLE — un enregistrement non
   aligné est REFUSÉ, jamais complété en silence » et `tests/unit/vm-volume-chiffre.test.mjs` › « le
   RESCELLEMENT du point de contrôle reproduit le vecteur d'un secteur de volume ».

C'est la **question n° 9** de la § 13.

### 7.3 Rouvrir : l'ordre des vérifications

L'ordre suivant n'est pas une commodité ; changer un seul de ses pas rendrait un verdict deviné.

1. **En-tête v3** relu et décodé. Marque de scellement complet exigée.
2. **Identifiant** de l'en-tête confronté à celui du manifeste.
3. **Témoin** lu et ouvert. Il fixe le **plancher de séquence** de la session. Absent = première
   ouverture.
4. **Racines** relues, décodées sans clé (marqueur, format, taille de secteur, taille de volume) ;
   la plus haute séquence lisible fait autorité.
5. **Parcours de la charge**, enregistrement par enregistrement, en **fenêtre glissante** : lire
   l'en-tête, lire le sceau, sauter le chiffré, collecter l'entrée
   `(adresse, longueur, rang, étiquette)`. Aucun déchiffrement, aucune allocation qui suive la
   taille de la charge.
6. **Ouvrir la racine** : l'étiquette de l'en-tête est vérifiée, **puis** le rejeu, la troncature et
   le mélange sont **établis** sur un en-tête authentique.
7. **Confronter la région** à l'empreinte que la racine scelle — **avant toute lecture de secteur**.
8. **Rejouer** : seconde passe, chaque enregistrement ouvert sous l'identité reconstruite (volume,
   format 3, génération **du sceau**, rang, adresse, longueur), puis rescellé vers le volume.
9. **Vider** le journal par une racine neuve, et écrire le témoin.

**Chaque enregistrement est ouvert à CHAQUE passe, y compris celle qui n'émet rien.** N'ouvrir qu'à
l'émission laisserait les premiers enregistrements dans le volume au moment où le dernier serait
refusé — le rejeu à moitié que la transaction interdit. Le prix est un déchiffrement de plus par
enregistrement, et il tombe sur le geste amorti.

**Les planchers sont PRÉSENTÉS, et un plancher oublié est refusé.** La valeur `null` reste admise
mais doit **s'écrire** : c'est un `null` par défaut, et non un `null` décidé, qui avait laissé les
refus de rejeu inertes — du code mort qu'aucune épreuve ne signalait. Le plancher de génération d'un
enregistrement est la plus grande génération vue avant lui dans la charge ; en session, il vaut «
génération de reprise + 1 ». Épreuves : `tests/unit/vm-generation-sequence.test.mjs` › « une racine
AUTHENTIQUE mais antérieure au plancher de séquence est refusée en session » et
`tests/unit/vm-generation-sequence.test.mjs` › « un ENREGISTREMENT authentique d'une génération
antérieure est refusé dans une charge plus récente ».

Le **seul `null` qui subsiste** sur un chemin de production est l'ouverture du témoin lui-même : à
ce moment rien n'est encore connu qui puisse minorer sa génération, et un plancher de zéro ne
refuserait aucun témoin authentique. Un contrôle décoratif se lit comme une garantie ; le `null`
assumé, non.

### 7.4 Migrer un volume antérieur vers v3

En place, sous la chaîne de l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) —
sauvegarde vérifiée exigée, manifeste révoqué avant la première mutation, journal de reprise inscrit
avant la révocation, manifeste v3 inscrit **en dernier** et relu depuis le support. Une migration
interrompue laisse un volume **non identifié**, que le boot refuse. Épreuve :
`tests/unit/vm-volume-migration.test.mjs` › « la migration inscrit le manifeste cible EN DERNIER,
après le journal et la révocation ».

**En place et non par un fichier voisin** : un voisin exigerait le **double du quota** au moment
précis où l'on migre un volume de 512 Mio, c'est-à-dire là où la place manque le plus souvent. Le
surcoût de la conversion en place est celui du format : 6,64 %.

**Deux gestes, et leur ordre est indispensable.**

1. **DÉPLACER** la charge de `a` vers `chargeOffset + a`, **du dernier secteur au premier**.
2. **SCELLER** chaque secteur à sa nouvelle place.

L'ordre n'est pas seulement souhaitable : la région vit dans `[512, chargeOffset)`, c'est-à-dire
**dans la zone d'où le déplacement lit**. Sceller avant d'avoir fini de déplacer détruirait la
source du déplacement.

**Le déplacement n'est PAS rejouable depuis le début**, et une première conception le croyait : la
zone d'arrivée `[chargeOffset, chargeOffset + L)` **recouvre** la zone de départ `[0, L)` dès que
`chargeOffset < L`, donc pour tout volume plus grand que sa propre région. La **position atteinte**
est donc journalisée après chaque tour ; elle n'a pas besoin d'être exacte, seulement conservatrice.
Le contre-exemple est **conservé comme épreuve** : `tests/unit/vm-migration-v3.test.mjs` › «
REPRENDRE le déplacement depuis le DÉBUT corrompt le volume — le contre-exemple est gardé ».

**Le scellement, lui, est reprenable sans compteur** : un secteur déjà converti s'ouvre, un secteur
encore en clair ne s'ouvre pas, et la région est à zéro avant conversion. La probabilité qu'un
secteur en clair passe pour scellé est celle d'une forgerie GCM. Une reprise applique un
**fail-closed** : sous la position journalisée, tout secteur DOIT s'ouvrir ; qu'il ne s'ouvre pas
admet deux lectures que rien ne distingue — « il reste du clair », et le rescéller est juste ; « il
porte du chiffré qu'on ne sait plus ouvrir », et le rescéller le détruit. On refuse. Épreuves :
`tests/unit/vm-migration-v3.test.mjs` › « un secteur SOUS la position déjà scellée qui ne s'ouvre
pas fait REFUSER la reprise » et `tests/unit/vm-migration-v3.test.mjs` › « un volume v2 converti en
v3 rend EXACTEMENT le même clair, par le chemin de production ».

**L'identifiant est TIRÉ à la migration**, puisqu'un volume antérieur n'en a pas, et il est immuable
ensuite. Trois gardes ferment le chemin par lequel une reprise sous un mauvais identifiant
détruirait le clair en silence : l'empreinte du journal de migration, l'en-tête v3 posé dès la fin
du déplacement, et le fail-closed ci-dessus. **La limite résiduelle est nommée** : un support
capable d'écrire de façon COHÉRENTE le journal ET l'en-tête ferait reprendre la conversion sous une
identité de son choix, et les trois gardes passeraient. Ni le journal ni l'en-tête ne sont
authentifiés — seuls les secteurs le sont —, et les authentifier suppose une clé disponible avant
d'ouvrir le volume. Ce qu'un tel support obtient reste une **destruction, jamais une lecture**.

### 7.5 Exporter et restaurer

**L'archive porte le fichier v3 TEL QUEL — chiffré — et son manifeste v3.** L'intégrité est prouvée
par l'empreinte SHA-256 du fichier ; la restauration recopie les octets **sans clé** ; la clé n'est
nécessaire qu'à l'**ouverture** du volume restauré. Épreuves :
`tests/unit/vm-archive-volume-chiffre.test.mjs` › « une archive de volume v3 se restaure SANS CLÉ,
octet pour octet » et `tests/unit/vm-opfs-volume-brut.test.mjs` › « il rend les octets CHIFFRÉS d'un
volume v3, et n'en ouvre aucun secteur ».

Deux conséquences à écrire :

1. **l'empreinte porte sur le chiffré.** Deux exports d'un même contenu logique ne sont plus
   comparables par empreinte — les nonces diffèrent, donc les octets. C'est voulu : l'empreinte
   atteste qu'une archive n'a pas été abîmée, pas que deux volumes portent le même état ;
2. **une archive restaurée sans sa clé est INERTE.** Elle se vérifie, se recopie, s'identifie ; elle
   ne s'ouvre pas. La sauvegarde d'un volume chiffré est la sauvegarde de **deux** choses, dont ce
   dépôt n'en gère qu'une (§ 11). Perdre la clé, c'est perdre l'archive.

**L'export passe par un accès BRUT au fichier**, sans clé et sans géométrie logique : par la voie
autorisée, qui déchiffre, il aurait produit une archive **en clair** d'un volume chiffré — le
chiffrement au repos annulé dès que le fichier quitte l'appareil, par omission et sans message. Une
épreuve le montre au lieu de l'affirmer : `tests/unit/vm-archive-volume-chiffre.test.mjs` › « le
CLAIR d'un secteur connu n'apparaît nulle part dans l'archive exportée ».

**Et pourtant l'export DEMANDE la clé.** Le fichier ne porte pas tout l'état du volume : une
génération **validée** vit dans le journal jusqu'à ce qu'une ouverture transactionnelle la rejoue.
Copier le fichier tel quel dans cet intervalle produirait une archive à laquelle il manque une
écriture acquittée, dont l'empreinte vérifie, dont la restauration réussit, et dont personne
n'apprendrait jamais qu'elle est incomplète. L'export **ouvre donc transactionnellement pour
récupérer, referme, puis ouvre en brut pour copier** — et si la récupération REFUSE, le fichier
n'est pas même ouvert.

**Le bail exclusif est rompu entre les deux ouvertures**, et le dire vaut mieux que le taire : il
n'existe pas de passation d'un handle exclusif. Ce qui est fait à la place est de **re-constater**,
après la reprise du bail, que le fichier est bien celui qu'on vient de récupérer — sa taille et
l'identifiant de son en-tête — et de refuser sinon. Ce contrôle n'est pas une preuve d'exclusivité :
il attrape le remplacement et le retaillage, pas une écriture au milieu du fichier.

## 8. Ce que le format protège

Chaque propriété est doublée d'un **témoin positif** : sans lui, un format qui refuserait tout
passerait pour sûr.

### P1 — Modification

Un sceau ne rend un clair que si l'étiquette AES-256-GCM vérifie sur `(chiffré, données associées)`
sous la clé et le nonce. Toute altération d'un bit du chiffré, de l'étiquette ou du nonce est
refusée.

- **Garantit** qu'une altération non détectée exige une forgerie GCM, majorée par ≈ 2^-122,6 par
  tentative. C'est une intégrité **authentifiée**, non une somme de contrôle : le recalcul exige la
  clé.
- **Ne garantit pas** : rien contre un détenteur de la clé ; rien sur la **disponibilité** — effacer
  reste possible et n'est pas une modification détectable, c'est une perte ; rien sur les **canaux
  auxiliaires** ; rien sur la correction de l'implémentation WebCrypto du moteur, que ce dépôt ne
  peut pas auditer.
- **Hypothèses** : AES-256-GCM est un AEAD sûr pour l'étiquette choisie ; la clé est inconnue de
  l'adversaire ; l'implémentation du moteur est conforme.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « P1 positif — un bloc scellé puis
  ouvert rend EXACTEMENT le clair d'origine » et `tests/unit/vm-format-chiffre-modele.test.mjs` › «
  MODIFICATION — un seul octet retourné, où qu'il soit, refuse le sceau ».

### P2 — Déplacement

Les données associées portent l'identité logique **complète**. Un bloc valide relu à une autre
adresse, dans un autre volume, sous une autre version de format ou une autre génération est refusé.

- **Garantit** que le déplacement exige la même forgerie que P1, l'encodage étant injectif.
- **Ne garantit pas** de dire **de quoi** le refus vient : modification et déplacement sont
  **cryptographiquement indiscernables**, et un seul code les couvre. Ne garantit pas non plus
  l'unicité de l'identifiant de volume, qui est tiré localement et que rien n'authentifie contre un
  registre.
- **Hypothèses** : l'identifiant de volume est unique et immuable ; les clés de deux volumes sont
  distinctes.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « P2 positif — le même chiffré s'ouvre
  sous SON identité logique, et sous elle seule » et `tests/unit/vm-volume-chiffre.test.mjs` › «
  REFUS 2 — un secteur valide DÉPLACÉ à une autre adresse est refusé ».

### P3 — Rejeu

La séquence et la génération sont authentifiées dans l'en-tête de la racine. Une racine dont la
séquence est inférieure au plancher présenté est refusée ; un bloc dont la génération est inférieure
au plancher présenté aussi. Les deux refus sont posés **après** la vérification de l'étiquette.

- **Garantit** qu'une racine ou un bloc d'une génération antérieure, réintroduits intacts, sont
  refusés **dès lors que le plancher présenté est juste**. En session, ce plancher est la dernière
  séquence validée ; à l'ouverture, il vient du témoin.
- **Ne garantit pas** le retour arrière **complet** du support entre deux sessions (§ 9).
- **Hypothèse** : la source du plancher est au moins aussi fiable que ce qu'on lui demande de
  protéger.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « REJEU — une racine et un bloc d'une
  génération antérieure, intacts, sont refusés » et `tests/unit/vm-generation-sequence.test.mjs` › «
  une racine AUTHENTIQUE mais antérieure au plancher de séquence est refusée en session ».

### P4 — Troncature

L'en-tête authentifié porte le nombre d'entrées et la longueur de charge. Une génération à laquelle
il manque des entrées — ou à laquelle il en a été ajouté — est refusée, sur un en-tête authentique.

- **Garantit** qu'une génération incomplète n'est jamais prise pour une génération plus courte.
- **Ne garantit pas** la suppression de la génération ENTIÈRE avec sa racine, qui est un retour
  arrière et non une troncature ; ni la troncature du VOLUME hors journal.
- **Hypothèse** : la liste des entrées présentée est celle qui a réellement été trouvée sur le
  support, non une liste reconstruite depuis l'en-tête.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « TRONCATURE — une génération à
  laquelle il manque une entrée est refusée » et `tests/unit/vm-generation-sequence.test.mjs` › «
  une génération AUGMENTÉE d'une entrée est refusée, et le refus traverse en VAULT_STORAGE_* ».

### P5 — Mélange

L'empreinte SHA-256 de la **suite ordonnée** des entrées est le clair scellé par la racine. Un
assemblage de blocs individuellement valides mais issus de générations différentes est refusé — de
même qu'un simple réordonnancement.

- **Garantit** que la génération est un TOUT.
- **Ne garantit rien sur le VOLUME au-delà du journal** : après un point de contrôle, le volume
  porte légitimement des secteurs de générations différentes ; c'est son état normal, pas un
  mélange.
- **Hypothèses** : SHA-256 résiste à la seconde préimage ; deux étiquettes GCM distinctes ne
  collisionnent pas sous la borne écrite en § 4.1.
- Épreuve : `tests/unit/vm-format-chiffre-modele.test.mjs` › « MÉLANGE — des blocs individuellement
  valides mais d'une autre génération sont refusés ».

### P6 — Fraîcheur de la région (au-delà des cinq propriétés d'origine)

La racine scelle l'empreinte de la région d'authentification, rescellée sous sa propre génération,
et l'ouverture la confronte avant toute lecture de secteur (§ 6.8).

- **Garantit** le refus d'un **secteur du volume ramené en arrière** hors journal — quadruplet
  complet remis en place, à la bonne adresse, dans le bon volume.
- **Ne garantit pas** : le contenu du volume **entre deux points de contrôle** (la région ne bouge
  pas tant que rien n'est rangé) ; le retour arrière qui emporte AUSSI le journal et le témoin ; la
  **présence** de l'empreinte, dont seule la valeur est authentifiée.
- Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « un SECTEUR ramené en arrière hors
  journal est refusé, alors que ce secteur reste authentique ».

### Le contrat de vecteurs

Les octets sont un **contrat**, pas une commodité. Les régénérer après avoir modifié le format ne
corrige rien : c'est un changement de format persistant, qui exige une version et un ADR. Épreuves :
`tests/unit/vm-format-chiffre-vecteurs.test.mjs` › « le modèle reproduit OCTET POUR OCTET les blocs
scellés figés », `tests/unit/vm-volume-chiffre.test.mjs` › « le scellement du produit reproduit
OCTET POUR OCTET les cinq blocs figés », `tests/unit/vm-format-chiffre-vecteurs.test.mjs` › « aucun
nonce n'apparaît DEUX FOIS dans les vecteurs » et `tests/unit/vm-format-chiffre-vecteurs.test.mjs` ›
« les compteurs de scellements des vecteurs croissent et COMPTENT les racines ».

## 9. Ce que le format NE protège PAS

Cette section est du **même rang** que la précédente. Rien de ce qui suit n'est un trou découvert
après coup : ce sont les limites du périmètre, écrites.

### 9.1 Le retour arrière COMPLET du support

Volume, journal, racine, témoin et manifeste ramenés ensemble à un état antérieur cohérent **ne sont
pas détectables**. L'état antérieur est cohérent et authentique ; rien ne le distingue d'un support
qui n'a jamais avancé.

Le remède exige une **ancre monotone hors de portée de l'adversaire** : un compteur matériel, un
témoin distant, un service tiers de fraîcheur. Ni OPFS, ni IndexedDB, ni le stockage clé-valeur ne
promettent la monotonie face à un adversaire qui contrôle le profil. Le seul compteur monotone
qu'une API de navigateur expose est `authenticatorData.signCount` de WebAuthn, et il ne suffit pas
pour trois raisons cumulées : CTAP2 le rend **facultatif**, la plupart des authentificateurs de
plateforme rendent **zéro**, et son emploi supposerait une décision sur le déverrouillage. Le
déverrouillage livré **ne le lit pas**.

D'ici là, la seule barrière est le **partitionnement OPFS par origine**. Et la limite n'est pas
seulement écrite, elle est **exécutée** : `tests/unit/vm-generation-fraicheur.test.mjs` › « un
volume ramené SOUS le témoin est refusé ; ramené AVEC lui, il ne l'est pas » — le volume rouvre, et
la seconde écriture a disparu sans que personne puisse le voir. Une limite qu'aucune épreuve ne
montre finit par être oubliée.

**L'effort n'est pas symétrique** (§ 6.9) : neutraliser le témoin coûte huit octets effacés, sans la
clé.

### 9.2 Le journal de migration n'est ni chiffré ni authentifié

`<volume>.migration` porte le manifeste source, la preuve de sauvegarde retenue, l'étape franchie et
la position atteinte. Il porte une **empreinte SHA-256 de son corps**, vérifiée avant l'analyse de
ses champs — elle détecte l'**altération**, pas la **forgerie** : elle n'est ni signée ni chiffrée,
et un journal réécrit d'un bloc serait cohérent avec lui-même.

Un support hostile pourrait donc faire reprendre une migration depuis une identité forgée. La
confiance repose ici encore sur le partitionnement d'origine. Ce qu'un tel support obtient est une
**destruction**, jamais une lecture (§ 7.4).

### 9.3 L'écriture déchirée intra-secteur

Le format ne suppose **aucune atomicité** : ni sectorielle, ni entre la charge et son sceau, ni
entre les 34 octets d'un enregistrement de région à cheval sur deux secteurs du support. Ce qu'il
promet partout est un **refus**, pas une lecture. Ce qui protège contre la **perte** est la
transaction : le point de contrôle est le seul geste qui écrive le volume, son échec ne valide rien,
et la génération reste dans le journal pour être rejouée. Épreuves :
`tests/unit/vm-generation-format.test.mjs` › « une racine dont l'en-tête est tronqué par une
déchirure n'est jamais une racine » et `tests/unit/vm-generation-store.test.mjs` › « une génération
validée est REJOUÉE à la réouverture même si le point de contrôle a manqué ».

Reste hors de tout ce document la perte d'un cache d'écriture **volatil** — mort du processus du
navigateur, coupure de courant : aucun des supports éprouvés ne la produit, et rien ici ne la
mesure.

### 9.4 Les canaux auxiliaires

Sont **observables** d'un support hostile, sans la clé :

- la **taille** du volume et celle de la région ;
- le **nombre de secteurs écrits** et leurs **adresses** — un secteur écrit deux fois est visible
  comme tel ;
- le **motif d'accès** ;
- tout ce que l'en-tête de racine publie en clair : nombre d'entrées d'une génération, longueur de
  sa charge, rang de la génération, taille du volume, **compteur cumulé de scellements**. Sur un
  volume de base de données, cela dit quelque chose du **rythme d'activité** (§ 13, question n° 8) ;
- l'existence et la taille de chaque voisin.

Rien n'est fait contre eux, et rien ne prétend le contraire. Le **temps** n'est pas modélisé non
plus : le format n'emploie une comparaison à temps constant que pour les empreintes qu'il compare
lui-même, et laisse au moteur la responsabilité de sa propre vérification d'étiquette.

### 9.5 Ce qui est hors du format par construction

- **Un adversaire qui détient la clé** forge à volonté.
- **Du code hostile déjà présent dans le Worker de confiance** : la clé non extractible ne l'empêche
  pas de s'en servir.
- **La disponibilité** : effacer un fichier reste possible et n'est pas une modification détectable.
- **L'implémentation WebCrypto du moteur** n'est pas auditée par ce dépôt.
- **La confidentialité en exploitation** : la clé de volume n'est distribuée que par le harnais (§
  11), et le format prouve donc le FORMAT, sous une clé de test publique.
- **Le manifeste**, ni chiffré ni authentifié.

## 10. Les codes de refus, et la conduite

Un refus porte un **code stable**, un message en français, un **contexte** sérialisable, et il
survit au passage d'un `postMessage`.

### 10.1 La famille du format chiffré

Elle décrit une propriété de **sécurité**.

| Code                                | Ce qu'il constate                                                                               | Conduite                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `VAULT_CRYPTO_SCEAU_REFUSE`         | l'étiquette ne vérifie pas. **Modification et déplacement, indiscernables.** Aucun clair rendu. | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_IDENTITE_INCOHERENTE` | l'en-tête AUTHENTIQUE d'une racine décrit un autre volume, format ou taille                     | ouvrir le bon volume, ou la bonne clé        |
| `VAULT_CRYPTO_REJEU`                | séquence ou génération authentifiée, mais ANTÉRIEURE au plancher exigé                          | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_TRONCATURE`           | le compte ou la longueur trouvés diffèrent de ce que la racine authentifie                      | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_MELANGE`              | le compte est juste, l'empreinte ne l'est pas : une entrée vient d'ailleurs                     | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_ORDRE_INVALIDE`       | rangs non strictement croissants, ou séquence de racine qui ne dépasse pas la précédente        | corriger l'appelant — aucun octet produit    |
| `VAULT_CRYPTO_BUDGET_DE_CLE`        | le budget de 2^31 scellements de cette clé est atteint                                          | **changer de clé de volume** (§ 11)          |
| `VAULT_CRYPTO_MALFORME`             | entrée structurellement inadmissible : largeur, type, longueur, attente oubliée                 | corriger l'appelant — faute de programmation |
| `VAULT_CRYPTO_ALGORITHME_INCONNU`   | un nom d'algorithme autre que `aes-256-gcm`                                                     | le manifeste ment sur son algorithme         |

**Les trois derniers ne nomment aucune menace, et c'est délibéré** : ils répondent d'une violation
de contrat par l'appelant, en amont de toute menace. Confondre les deux ferait croire qu'un
adversaire est à l'œuvre là où c'est une faute de programmation, et l'inverse.

**Un code RETIRÉ, nommé ici pour qu'un relecteur ne le cherche pas :**
`VAULT_CRYPTO_NONCE_REUTILISE` **n'existe plus**. Il a été renommé `VAULT_CRYPTO_ORDRE_INVALIDE` le
jour où le nonce a cessé d'être dérivé : un rang répété ne réémet plus de nonce, et garder l'ancien
nom aurait fait affirmer au format une conséquence qu'il ne produit plus. Le seul endroit du dépôt
où la chaîne subsiste est le commentaire qui documente ce renommage.

### 10.2 La famille du stockage

Elle décrit un état du **support**. Les refus du format y sont traduits, et la cause d'origine est
**conservée dans le contexte** : un refus de sécurité qui perdrait sa cause en changeant de couche
ne serait plus qu'une panne.

| Code du format                      | Code de stockage                   |
| ----------------------------------- | ---------------------------------- |
| `VAULT_CRYPTO_SCEAU_REFUSE`         | `VAULT_STORAGE_SCEAU_REFUSE`       |
| `VAULT_CRYPTO_IDENTITE_INCOHERENTE` | `VAULT_STORAGE_IDENTITE_VOLUME`    |
| `VAULT_CRYPTO_REJEU`                | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_TRONCATURE`           | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_MELANGE`              | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_ORDRE_INVALIDE`       | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_BUDGET_DE_CLE`        | `VAULT_STORAGE_BUDGET_DE_CLE`      |

`VAULT_CRYPTO_MALFORME` et `VAULT_CRYPTO_ALGORITHME_INCONNU` ne sont **pas** traduits : les habiller
en erreur de stockage ferait croire à un support abîmé là où c'est un bogue.

**Quatre causes tombent sur un seul code, et c'est une décision** : la conduite dépend du
**remède**, pas du diagnostic, et six causes qui appellent toutes « restaurer une sauvegarde » ne
justifient pas six conduites. Deux causes supplémentaires, portées dans le contexte et non par un
code : `VAULT_FRAICHEUR_REGION` (région relue ≠ empreinte scellée ; racine sans empreinte sous un
témoin actif) et `VAULT_TEMOIN_SEQUENCE` (journal sans racine sous un témoin ; témoin de format
inconnu).

Le reste de la famille, avec sa conduite :

| Code                                    | Ce qu'il constate                                                                                                         | Conduite                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `VAULT_STORAGE_SCEAU_REFUSE`            | un sceau de secteur, d'enregistrement ou de racine ne vérifie pas                                                         | restaurer une sauvegarde                         |
| `VAULT_STORAGE_IDENTITE_VOLUME`         | l'identité présentée ne correspond pas à celle qui est authentifiée                                                       | ouvrir le bon volume, ou la bonne clé            |
| `VAULT_STORAGE_BUDGET_DE_CLE`           | budget de scellements de la clé atteint                                                                                   | changer de clé de volume                         |
| `VAULT_STORAGE_CLE_REQUISE`             | volume v3 présenté SANS clé, ou clé de longueur inadmissible                                                              | fournir la clé — le produit n'en fabrique aucune |
| `VAULT_STORAGE_VOLUME_INCOMPLET`        | création ou conversion interrompue : la marque de scellement manque                                                       | **supprimer et recréer**, pas restaurer          |
| `VAULT_STORAGE_GENERATION_CORRUPT`      | une génération VALIDÉE ne concorde plus (rejeu, troncature, mélange, fraîcheur)                                           | restaurer une sauvegarde                         |
| `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` | aucune racine lisible alors qu'au moins une est abîmée : ce qui a été validé est INCONNU                                  | restaurer une sauvegarde                         |
| `VAULT_STORAGE_GENERATION_DISCARDED`    | une génération déposée sans validation a été écartée. **Ce n'est pas une panne** : c'est le résultat normal d'une coupure | rien — publié, jamais tu                         |
| `VAULT_STORAGE_GENERATION_OVERFLOW`     | la génération en cours dépasse le plafond de 16 Mio                                                                       | le guest doit franchir une barrière              |
| `VAULT_STORAGE_GENERATION_PENDING`      | un geste exigeant une génération validée a été demandé sur une génération en cours                                        | franchir la barrière d'abord                     |
| `VAULT_STORAGE_GEOMETRY_MISMATCH`       | la géométrie du support diffère de celle de la session                                                                    | exporter puis migrer — jamais retailler          |
| `VAULT_STORAGE_QUOTA_EXCEEDED`          | le quota de stockage de l'origine est épuisé                                                                              | libérer de la place, puis réessayer              |
| `VAULT_STORAGE_QUIESCE`                 | l'adaptateur est quiescé : une capture d'instantané est en cours                                                          | réessayer après la capture                       |
| `VAULT_STORAGE_OUT_OF_RANGE`            | lecture ou écriture hors de la géométrie déclarée                                                                         | corriger l'appelant                              |
| `VAULT_STORAGE_SHORT_READ`              | le support a rendu moins d'octets que demandé                                                                             | réessayer, puis diagnostiquer le support         |
| `VAULT_STORAGE_PARTIAL_WRITE`           | le support a accepté moins d'octets que demandé                                                                           | réessayer, puis diagnostiquer le support         |
| `VAULT_STORAGE_FLUSH_FAILED`            | la barrière de durabilité n'a pas abouti — **rien n'est acquitté**                                                        | réessayer ; ne rien annoncer durable             |
| `VAULT_STORAGE_HANDLE_LOST`             | le handle exclusif a disparu sous le volume ouvert                                                                        | rouvrir le volume                                |
| `VAULT_STORAGE_CLOSED`                  | opération demandée après fermeture du volume                                                                              | corriger l'appelant                              |
| `VAULT_STORAGE_BUSY`                    | un autre détenteur possède déjà l'exclusivité                                                                             | fermer l'autre onglet ou attendre                |
| `VAULT_STORAGE_UNSUPPORTED`             | capacité absente du moteur — **jamais remplacée par un repli silencieux**                                                 | changer de moteur                                |
| `VAULT_STORAGE_SUPPORT_FAILURE`         | échec du support non classable ci-dessus — nommé, jamais deviné                                                           | diagnostiquer le support                         |

**Deux refus provisoires survivent à leur cause** : `VAULT_ARCHIVE_VOLUME_CHIFFRE` et
`VAULT_IMPORT_VOLUME_CHIFFRE` sont encore **déclarés** dans le code et ne sont plus levés nulle
part. Voir § 12, écart 2.

### 10.3 Les refus des voisins hors périmètre

Ces deux familles ne relèvent pas de cette revue (§ 11). Elles sont listées **exhaustivement** pour
qu'un relecteur qui les rencontre sache qu'elles existent et qu'elles ne sont pas de son ressort.

**Enveloppe de clé** — `<volume>.cles` : `VAULT_ENVELOPPE_ABSENTE` (aucune enveloppe, ce qui n'est
pas « clé invalide »), `VAULT_ENVELOPPE_CLE_REFUSEE` (clé de déverrouillage inconnue ou révoquée —
le même refus pour les deux, indiscernable, et **le même nombre d'appels AEAD** :
`tests/unit/vm-enveloppe-operations.test.mjs` › « clé RÉVOQUÉE et clé INCONNUE rendent le même
refus, indiscernable »), `VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` (révoquer le dernier emplacement est
refusé — un volume sans issue n'est pas un état acceptable), `VAULT_ENVELOPPE_EMPLACEMENT_INCONNU`,
`VAULT_ENVELOPPE_IDENTITE`, `VAULT_ENVELOPPE_ILLISIBLE`, `VAULT_ENVELOPPE_MALFORME`,
`VAULT_ENVELOPPE_MELANGE`, `VAULT_ENVELOPPE_PLEINE`, `VAULT_ENVELOPPE_RACINE_REFUSEE`,
`VAULT_ENVELOPPE_REJEU`, `VAULT_ENVELOPPE_TRONCATURE`.

**Dérivation des clés de déverrouillage** : `VAULT_DERIVATION_ANNULEE`,
`VAULT_DERIVATION_ARGON2_INDISPONIBLE`, `VAULT_DERIVATION_PARAMETRES_REFUSES` (plancher de coût
Argon2id vérifié à l'écriture ET à la lecture), `VAULT_DERIVATION_PHRASE_REFUSEE`,
`VAULT_DERIVATION_PRF_IGNOREE`, `VAULT_DERIVATION_PRF_INDISPONIBLE`,
`VAULT_DERIVATION_TYPE_INCONNU`.

Aucun repli automatique entre ces refus, et aucun compteur d'échec persisté.

## 11. Les voisins hors périmètre de la revue

Un relecteur en voit la **place**, pas l'implémentation. Ils sont nommés ici avec leur statut pour
qu'aucune absence ne se lise comme un oubli.

| Voisin                | Décision                                                            | Statut au 5 septembre 2026                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<volume>.cles`       | [ADR 0020](decisions/0020-enveloppe-de-cle.md)                      | **livré.** Chiffré et authentifié. Il est le seul chemin vers le volume : sa perte vaut la perte des données. **L'archive ne l'emporte pas.**                                                                                                                                             |
| Dérivation            | [ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md) | **livré.** Argon2id (RFC 9106) au plancher de la RFC, ou WebAuthn PRF. Le compteur `signCount` **n'est pas lu**.                                                                                                                                                                          |
| `<volume>.instantane` | [ADR 0024](decisions/0024-instantane-de-reprise.md)                 | **livré.** Il part avec le témoin et le journal à tout geste qui réécrit le volume, pour la raison de la § 6.9. L'empreinte de région de la § 6.8 lui sert de **liaison** : elle rend un instantané périmé détectable dès qu'un secteur a été rescellé (`VAULT_INSTANTANE_ECART_REGION`). |
| `<volume>.migration`  | [ADR 0011](decisions/0011-migration-de-format-et-reprise.md)        | **livré, ni chiffré ni authentifié.** Sa limite est dans le périmètre : § 9.2.                                                                                                                                                                                                            |

**Et une chose qui n'existe pas** : le **changement de clé de volume**. Le refus au budget (§ 4.5)
et la révocation d'un emplacement d'enveloppe nomment tous deux ce remède ; aucun chemin du produit
ne rechiffre un volume sous une clé neuve. C'est écrit ici pour qu'un relecteur ne suppose pas qu'un
remède nommé est un remède disponible.

**La clé de volume, en exploitation.** Le produit ne fabrique ni ne persiste aucune clé de volume
par lui-même en dehors de l'enveloppe ; les bancs et les épreuves reçoivent une **clé de TEST
publique** (les octets `0x00` à `0x1f`), sous jeton du harnais, et cette clé est publiée dans les
vecteurs. Le format est donc prouvé de bout en bout **sous une clé publique**, ce qui prouve le
format et non la confidentialité en exploitation.

## 12. Écarts entre les ADR et le code, au 5 septembre 2026

Relevés en écrivant ce document. **Le code tranche** ; l'écart est écrit, jamais corrigé en silence.

**Écart 1 — la marque de scellement complet n'est décidée par aucun ADR.** L'ADR 0016 (décision 1,
28 août 2026) donne l'en-tête v3 avec « offset 64, largeur 448, réserve, à zéro ». Le code y écrit
huit octets `VLTSEAL1` (§ 6.3), et la réserve réelle commence à 72 pour 440 octets. L'ADR 0016 y
renvoie une fois, en parlant d'un « fichier v3 sans cette marque refusé par l'ouvreur
(`VAULT_STORAGE_VOLUME_INCOMPLET`, décision 2) » — or sa décision 2 traite de la génération d'un
enregistrement de journal et ne mentionne ni la marque ni ce code. **La marque existe dans le code
et dans les épreuves, sans décision numérotée nulle part.** Ce document est le premier à la
spécifier.

**Écart 2 — deux refus déclarés « retirés » existent encore.** L'ADR 0016 (décision 9) écrit que
`VAULT_ARCHIVE_VOLUME_CHIFFRE` et `VAULT_IMPORT_VOLUME_CHIFFRE` « n'existent plus » : « un refus qui
survit à sa cause devient un piège pour l'exploitant ». Ils sont toujours **déclarés** dans le code
et ne sont **plus levés nulle part**. C'est du code mort et non un piège actif — aucun exploitant ne
les rencontre —, mais l'ADR affirme une suppression qui n'a pas eu lieu.

**Écart 3 — la version du journal annoncée par l'ADR 0016 est périmée.** Sa décision 3 donne «
format du journal (**2** en v3) ». Le code écrit **3** depuis l'ADR 0019, qui le dit explicitement.
La table de l'ADR 0016 n'a pas reçu d'amendement ; les deux ADR lus ensemble sont cohérents, la
table seule ne l'est pas.

**Écart 4 — le coût du scellement initial : 18,7 s annoncés, 87,6 s mesurés.** L'ADR 0015 chiffre la
création d'un volume de 512 Mio à **18,7 s** par extrapolation, et sa section « Risques » cite «
14,4 s » pour le même geste — deux chiffres pour une même grandeur à l'intérieur d'un même document.
La mesure réelle sur OPFS, publiée dans `docs/quality-attributes.md`, donne **87,6 s** (83,5 µs par
secteur), soit un facteur 4,7 sur l'extrapolation. Le chiffre de ce document est le chiffre
**mesuré**. La fenêtre que la marque de scellement complet ferme (§ 6.3) est donc quatre fois plus
longue que l'ADR ne le laissait croire.

**Écart 5 — un commentaire du code décrit un mécanisme qui n'existe plus.** La déclaration de
`VAULT_CRYPTO_IDENTITE_INCOHERENTE` porte encore, dans son commentaire, la description de l'époque
du nonce dérivé : « le nonce conservé avec le sceau n'encode pas la génération et le rang de
l'identité présentée. Établi AVANT tout calcul cryptographique : le nonce se décrit lui-même. » Le
constructeur situé quinze lignes plus bas dit exactement le contraire, et il est juste : le nonce ne
décrit plus rien, et ce refus ne sert plus qu'à la racine, après vérification de l'étiquette. C'est
un défaut de documentation dans le code, sans effet sur les octets.

Aucun de ces cinq écarts ne change un octet du format. Les quatre premiers sont des documents en
retard sur le code ; le cinquième est un commentaire en retard sur son propre fichier.

## 13. Questions au relecteur

Neuf questions de l'[ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md), reprises
ici avec ce que les [ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md) et
[ADR 0019](decisions/0019-fraicheur-du-volume.md) y ont ajouté ou en ont refermé. **Aucune question
n'est inventée ici**, et deux ont reçu depuis une réponse partielle qui est écrite avec elles. Les
questions qui touchent au déverrouillage renvoient aux
[ADR 0020](decisions/0020-enveloppe-de-cle.md) et
[ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md), livrés depuis, mais hors
périmètre (§ 11).

### Question n° 1 — AES-GCM-SIV vaut-il sa dépendance, en défense en profondeur ?

**Position du dépôt.** Non, pas aujourd'hui. Le tirage du nonce est la condition de correction, et
GCM-SIV n'en est plus une. Il rendrait cependant une collision improbable **non catastrophique**, là
où GCM la rend fatale. Le coût est une implémentation JS ou WebAssembly tierce et son audit, ce que
la règle de dépendances du dépôt n'accorde pas sans justification écrite.

**Ce qui la ferait changer.** Un argument montrant que la probabilité de collision de 2^-35 au
budget retenu est mal bornée — par exemple parce que le compteur de scellements recule (question
n° 4) et que le budget réel dépasse 2^31 d'un facteur inconnu. Ou l'arrivée d'un AEAD résistant à la
réutilisation de nonce **dans WebCrypto**, qui retirerait à la question son coût de dépendance.

### Question n° 2 — Faut-il un arbre de Merkle sur le volume ?

**Position du dépôt, et elle a changé depuis l'ADR 0015.** L'ADR 0019 a fermé le cas concret que
cette question visait — le retour arrière d'un **secteur** — par une **empreinte plate** de la
région entière, scellée dans la racine (§ 6.8), pour un hachage par rangement au lieu de 20 hachages
par écriture et 64 Mio d'état. Ce que l'empreinte plate ne donne pas est **quel** secteur a reculé —
et le remède ne change pas avec la réponse.

**Ce qui la ferait changer.** Une mesure montrant que l'empreinte de région dépasse le pour-cent du
budget de reprise à une taille de volume réaliste (aujourd'hui : 0,58 % à 0,64 %), ou un usage qui
exigerait de vérifier un secteur **sans** relire la région. L'ADR 0019 écrit d'avance les deux
leviers d'amortissement, dans l'ordre : empreinte à un seul coup d'abord — elle ne change aucun
octet de format —, empreintes par suites de secteurs ensuite, qui exigeraient une version de format.

### Question n° 3 — Existe-t-il un ancrage monotone acceptable dans un navigateur ?

**Position du dépôt.** Non. Le retour arrière **complet** est assumé (§ 9.1). Le témoin de la § 6.9
ferme le retour arrière **partiel** — le volume recule, son voisin non — et rien de plus ; il vit
dans la même origine que le volume, et le neutraliser ne coûte rien. `authenticatorData.signCount`
est instruit et écarté pour trois raisons cumulées, et le déverrouillage livré **ne le lit pas**.

**Ce qui la ferait changer.** Une ancre monotone hors du support qui ne déplacerait pas simplement
la confiance : un compteur matériel accessible depuis un navigateur, ou un témoin distant dont le
compromis serait strictement moins grave que celui de l'origine. La question est renvoyée nommément
à la récupération.

### Question n° 4 — Le budget de scellements est-il au bon endroit, et 2^31 est-il la bonne valeur ?

**Position du dépôt.** Le compteur est authentifié **dans la racine**, donc protégé contre la
falsification mais soumis au retour arrière : un support qui recule fait re-parcourir des
scellements déjà comptés, et le nombre réel d'invocations sous la clé dépasse alors le nombre compté
d'un écart qu'aucune mesure ne borne. La moitié du plafond NIST est une marge **choisie**, pas
calculée. Le témoin borne désormais ce recul pour tout ce qui n'est pas un retour arrière complet —
l'écart est réduit, pas annulé. S'y ajoute la sous-estimation hors transaction de la § 4.5. La même
question vaut pour la stricte croissance de la **séquence**, que le format ne peut vérifier que si
l'appelant lui présente la valeur précédente.

**Ce qui la ferait changer.** Une mesure ou un argument bornant l'écart entre le compteur et le
nombre réel d'invocations, ce qui permettrait de fixer le budget **par le calcul** plutôt que par
une marge. Ou la démonstration que 2^31 est déjà trop haut sous le modèle de recul.

### Question n° 5 — Le lot par appel est-il le bon découpage ?

**Position du dépôt : instruite, laissée fermée.** Sceller 512 octets à la fois coûte **32,5 fois**
plus cher que sceller 4 Mio d'un coup — le coût est celui de l'APPEL, pas d'AES : ≈ 17,3 µs par
appel contre ≈ 0,5 µs de calcul pour 512 octets. Pour le VOLUME, un lot détruirait l'accès aléatoire
et ferait perdre tout un groupe sur une erreur d'un bit. Le découpage candidat est **nommé
d'avance** — la page hôte de 4 096 octets, soit 8 secteurs, qui divise le volume applicatif sans
reste — avec son coût écrit : granularité de refus de 512 à 4 096 octets, et huit fois trop lu et
déchiffré pour un secteur isolé. Il **n'est activé par aucun chemin**, il n'est pas derrière un
drapeau, et il n'existe pas dans le code : une option non mesurée qui traîne finit par être allumée
sans décision. Pour le JOURNAL — rejoué d'un seul tenant — un scellement par génération resterait
défendable.

**Ce qui la ferait changer.** Une mesure montrant que la reprise se dégrade au-delà du bruit face au
budget de reprise, avec la granularité de refus qu'on accepte en échange.

### Question n° 6 — Le manifeste et l'archive doivent-ils être chiffrés ?

**Position du dépôt, tranchée pour l'archive seulement.** L'archive porte le fichier v3 **tel
quel**, chiffré, et son manifeste (§ 7.5) ; elle n'est ni chiffrée davantage ni signée. Le
**manifeste reste en clair** et n'est pas authentifié : il porte une identité, pas des données. Deux
conséquences déjà écrites : l'empreinte porte sur le chiffré, et une archive restaurée sans sa clé
est inerte.

**Ce qui la ferait changer.** Une attaque sur le manifeste en clair qui ne se réduise pas à un refus
— aujourd'hui, un manifeste falsifié produit un écart d'identité refusé avant toute lecture. Ou une
exigence de sauvegarde qui rendrait inacceptable qu'une archive et sa clé voyagent séparément.

### Question n° 7 — Un lecteur peut-il distinguer un secteur jamais écrit d'un secteur effacé ?

**Position du dépôt.** Il n'y a **pas** de secteur jamais écrit en v3 : la création et la
restauration scellent tous les secteurs, zéros compris (§ 6.5). Le prix est de **87,6 s** de
scellement à la création d'un volume de 512 Mio (§ 12, écart 4), et la fenêtre que cela ouvre est
refermée par la marque de scellement complet.

**Ce qui la ferait changer.** Un marquage **authentifié** des plages non initialisées qui coûterait
moins que le scellement complet sans rouvrir la porte du secteur zéroté lu comme blanc.

### Question n° 8 — L'en-tête de racine en clair est-il acceptable ?

**Position du dépôt.** Il est assumé et nommé (§ 5.2, § 9.4). Il publie le nombre d'écritures d'une
génération, la longueur de sa charge et le compteur cumulé de scellements ; sur un volume de base de
données, cela dit quelque chose du rythme d'activité. Le chiffrer exigerait de choisir la racine qui
fait autorité **sans lire son en-tête**, ce que l'alternance rend impossible.

**Ce qui la ferait changer.** Une construction qui permettrait de départager deux racines sans lire
leurs en-têtes en clair, ou une mesure montrant que ce canal apprend, sur un usage réel, davantage
que « le volume a été écrit ».

### Question n° 9 — Le rescellement du point de contrôle est-il au bon endroit ?

**Position du dépôt.** Oui, faute de mieux (§ 7.2). Passer du journal au volume exige de rescéller
chaque secteur sous un nonce neuf, donc de **déchiffrer puis rechiffrer** la charge validée : le
clair transite en mémoire, et le coût double pour les octets rangés. L'alternative — sceller au
format du volume dès le dépôt — obligerait le journal à n'accepter que des écritures alignées et
casserait « déposer = une écriture, une seule ».

**Ce qui la ferait changer.** Une construction qui éviterait le double scellement sans imposer
l'alignement au dépôt, ou une démonstration que le clair en mémoire pendant le rangement est une
exposition qualitativement pire que celle de la recopie qui existait déjà.

## 14. Ce que ce dossier ne prouve pas

- **Il ne prouve pas que le format est sûr.** Il décrit ce qu'il fait, ce qu'il ne fait pas, et sous
  quelles hypothèses. Aucun tiers ne l'a revu.
- **Il ne prouve pas la confidentialité en exploitation.** Le format est éprouvé de bout en bout
  sous une **clé de test publique** (§ 11).
- **Il ne prouve rien sur l'implémentation WebCrypto** des moteurs, que ce dépôt ne peut pas
  auditer, ni sur l'émulateur, ni sur l'application invitée.
- **Il ne prouve rien sur les moteurs non mesurés.** Les coûts publiés ici sont relevés sur
  Chromium, sur une machine de développement qui n'est pas l'environnement de référence. Firefox et
  WebKit exécutent les épreuves fonctionnelles, pas les bancs de coût.
- **Il ne prouve pas que l'ouvreur unique est incontournable.** C'est une discipline de revue, pas
  une contrainte de l'outillage (§ 6.10).
- **Le vérificateur de vecteurs n'établit qu'un fait étroit** : les octets figés sont ceux que ce
  document décrit. Il ne cherche aucune faiblesse.
- **Le registre de la revue externe est VIDE**, et cela veut dire que la moitié 2 n'a pas eu lieu :
  aucun tiers n'a été sollicité, aucun constat n'a été reçu. Voir
  [`docs/revue-externe/registre.md`](revue-externe/registre.md) et le
  [gabarit de constat](revue-externe/gabarit-de-constat.md).
- **Le gate « données sensibles » reste FERMÉ.** RailsBox Vault est expérimental et ne doit contenir
  aucune donnée réelle.
