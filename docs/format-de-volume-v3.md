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

| Objet                 | Fichier               | Chiffré ? | Authentifié ?          | Dans le périmètre de cette revue   |
| --------------------- | --------------------- | --------- | ---------------------- | ---------------------------------- |
| Volume                | `<volume>`            | oui       | oui, secteur à secteur | **oui**                            |
| Journal de génération | `<volume>.gen`        | oui       | oui, par racine        | **oui**                            |
| Témoin de séquence    | `<volume>.temoin`     | oui       | oui                    | **oui**                            |
| Manifeste             | `<volume>.manifest`   | non       | **non**                | **oui** (ce qu'il déclare)         |
| Enveloppe de clé      | `<volume>.cles`       | oui       | oui                    | non — § 11                         |
| Instantané de reprise | `<volume>.instantane` | oui       | oui                    | non — § 11                         |
| Journal de migration  | `<volume>.migration`  | non       | **non**                | non — § 11, mais sa limite est ici |

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
(32 blocs) et des données associées de 118 octets — soit 8 blocs, la fin étant complétée —,
`n = 40`, d'où **≈ 2^-122,6** par tentative — le PLUS PETIT objet du format. **Ce n'est pas la borne
la plus large que le format admette** : un enregistrement de journal porte le clair de l'écriture du
guest, jusqu'au plafond de charge de 16 Mio (§ 6.6), pas 512 octets ; à ce plafond, `n ≈ 2^20` et la
borne vaut **≈ 2^-107** — quinze bits de moins, sans conséquence pratique, mais c'est le pire cas
qui majore réellement une forgerie sur ce format, pas le meilleur. Le mot « jamais » n'apparaît donc
nulle part dans les propriétés de la § 8. _(L'ADR 0015 écrit « 122 octets » pour la même grandeur ;
le compte exact des champs de la § 5.1 en donne 118, et `n` ne change pas — 118 comme 122 tiennent
en huit blocs de 128 bits.)_

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
2. **l'empreinte de la région d'authentification** du volume, scellée dans la racine (§ 6.8) : les
   `R × 512` octets de la région TELLE QU'ALIGNÉE (§ 6.1), **rembourrage compris** — pas les seuls
   octets utiles (`N × 34`) qu'elle porte avant alignement.

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

> **CE PARAGRAPHE DÉCRIT UN BUDGET QUI N'EST PAS GLOBAL À LA CLÉ, et la revue externe du 10
> septembre 2026 l'a établi** ([#182](https://github.com/pinfada/railsbox-vault/issues/182), HIGH,
> ouvert — § 9.7). « Ce que le compteur compte », plus bas, décrit ce qu'UNE instance de scellement
> compte ; or les volumes de coquille et d'application partagent la même clé, chaque instance repart
> de zéro, les racines d'enveloppe et les exports scellent sous cette clé hors de tout compteur, et
> deux chemins de production s'ouvrent hors transaction. La probabilité de 2^-35 publiée ci-dessous
> **n'est donc pas bornée par le mécanisme implémenté**. La correction est décidée —
> [ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md), une clé dérivée par domaine
> et par volume — et **elle n'est pas livrée** : ce paragraphe reste vrai du format v3, c'est-à-dire
> du format que le produit écrit aujourd'hui. Il sera récrit par la version v4.

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

**Le compteur est REPRIS de la racine qui fait autorité, sans contrôle de croissance.** À
l'ouverture, la session reprend le compteur à `scellementsCumules + 1` de cette racine, sans le
comparer au témoin, à la racine voisine ni à quoi que ce soit d'autre : il ne peut que **suivre**
les reculs de cette racine, jamais les corriger. Ce n'est pas seulement la conséquence d'un retour
arrière du support (question n° 4) : il suffit qu'une racine plus ancienne fasse autorité pour une
autre raison — voir § 9.6, constat [#144](https://github.com/pinfada/railsbox-vault/issues/144) —
pour que le compteur recule avec elle, sans qu'aucun refus ne le signale.

**Le budget est celui de la racine qui fait AUTORITÉ, et un recul d'une génération le rend d'autant.
Ce n'est PAS une réutilisation de nonce.** Les nonces sont **tirés**, jamais dérivés d'un compteur
(§ 4.2) : reculer le compteur ne fait donc réémettre aucun nonce déjà employé, et la probabilité de
collision reste celle du § 4.2 pour le nombre **réel** d'invocations. Ce que le recul dégrade est la
**fidélité de la mesure** — le compteur sous-estime alors ce qui a été consommé sous la clé, et le
plafond de 2^31 est atteint plus tard qu'il ne devrait l'être. C'est un compteur de **conduite**,
pas un contrôle cryptographique, et c'est pour cet écart-là que la moitié du plafond NIST est prise
comme marge. Aucun contrôle n'est ajouté ici : le refus que #144 apporte porte sur la racine, pas
sur le compteur.

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

### 5.1 Données associées d'un bloc du volume

Un « bloc » est un objet du magasin **VOLUME** : un **secteur** de la charge, l'**empreinte de la
région** d'authentification, ou le **témoin** de séquence. Un **enregistrement du journal** n'en est
pas un — il a sa propre étiquette de domaine depuis le format de journal 4 (§ 5.1 bis), et le § 5.4
dit pourquoi le rang ne suffisait pas à les séparer.

| Ordre | Champ                       | Longueur      | Encodage                                                                               |
| ----- | --------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| 1     | Étiquette de domaine        | 2 + 37 octets | longueur gros-boutiste sur 2 o, puis UTF-8 : `railsbox-vault/format-chiffre/v1/bloc`   |
| 2     | Nom de l'algorithme         | 2 + 11 octets | idem : `aes-256-gcm`                                                                   |
| 3     | Version du format de volume | 4 octets      | entier gros-boutiste — **3**                                                           |
| 4     | Identifiant de volume       | 2 + n octets  | idem : chaîne quelconque ; **32 caractères hexadécimaux minuscules** pour un volume v3 |
| 5     | Génération                  | 8 octets      | entier gros-boutiste                                                                   |
| 6     | Rang de l'entrée            | 8 octets      | entier gros-boutiste                                                                   |
| 7     | Adresse logique             | 8 octets      | entier gros-boutiste                                                                   |
| 8     | Longueur du clair           | 4 octets      | entier gros-boutiste                                                                   |

Total pour un volume v3, dont l'identifiant fait trente-deux caractères : **118 octets** (39 + 13 +
4 + 34 + 8 + 8 + 8 + 4).

**Où la forme 32-hex est réellement imposée, et où elle ne l'est pas.** L'encodage lui-même
(`encoderIdentiteBloc`) accepte une chaîne de longueur QUELCONQUE pour le champ 4 — 118 octets n'est
donc le total que **pour un identifiant de trente-deux caractères**. La forme 32-hex minuscule est
imposée un étage plus haut : par `identifiantVolumeEnOctets` (§ 6.2, l'en-tête v3) et par le
manifeste (§ 6.10), pas par l'encodage d'identité. `tests/vectors/format-chiffre-v1.json` en tire
parti pour son propre confort de lecture : son identifiant de vecteur, `volume-de-vecteur` (dix-sept
caractères), donne des données associées de **103 octets** (39 + 13 + 4 + 19 + 8 + 8 + 8 + 4) et non
118 — un relecteur qui recalcule ce vecteur à la lettre de ce tableau échoue avant d'avoir rien
attaqué s'il suppose 118 octets partout.

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

### 5.1 bis Données associées d'un enregistrement du journal

**Même forme, autre étiquette de domaine.** Les huit champs, leurs largeurs, leur ordre et leurs
préfixes sont ceux du § 5.1 ; seul le champ 1 change :

| Ordre | Champ                | Longueur      | Encodage                                                                                       |
| ----- | -------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| 1     | Étiquette de domaine | 2 + 47 octets | longueur gros-boutiste sur 2 o, puis UTF-8 : `railsbox-vault/format-chiffre/v1/enregistrement` |

Total pour un volume v3, dont l'identifiant fait trente-deux caractères : **128 octets** (49 + 13 +
4 + 34 + 8 + 8 + 8 + 4), soit dix de plus que les 118 d'un bloc — la longueur de l'étiquette, et
rien d'autre. Les bornes des champs 3 à 8 sont celles du § 5.1, refusées de la même façon.

**Le rang y est la POSITION de l'enregistrement dans sa charge**, en base zéro. Il ordonne ; il ne
sépare plus rien (§ 5.4).

Cette étiquette est apparue avec le **format de journal 4** (§ 6.7). Un journal de format 2 ou 3
porte des enregistrements scellés sous l'étiquette d'un **bloc** : le § 6.6 dit ce que ce runtime en
fait. Épreuves : `tests/unit/vm-identite-magasin.test.mjs` › « les données associées d'un
enregistrement de journal ne sont JAMAIS celles du secteur homologue » et
`tests/unit/vm-identite-magasin.test.mjs` › « un ENREGISTREMENT de journal épissé dans la région et
la charge du volume est REFUSÉ ».

### 5.2 Données associées d'une racine

| Ordre | Champ                       | Longueur      | Encodage                                                         |
| ----- | --------------------------- | ------------- | ---------------------------------------------------------------- |
| 1     | Étiquette de domaine        | 2 + 39 octets | `railsbox-vault/format-chiffre/v1/racine`                        |
| 2     | Nom de l'algorithme         | 2 + 11 octets | `aes-256-gcm`                                                    |
| 3     | Version du format de volume | 4 octets      | gros-boutiste — **3**                                            |
| 4     | Identifiant de volume       | 2 + n octets  | chaîne quelconque ; 32 hexadécimaux minuscules pour un volume v3 |
| 5     | Séquence                    | 8 octets      | gros-boutiste                                                    |
| 6     | Génération                  | 8 octets      | gros-boutiste                                                    |
| 7     | Taille LOGIQUE du volume    | 8 octets      | gros-boutiste                                                    |
| 8     | Nombre d'entrées            | 4 octets      | gros-boutiste — **dérivé**, jamais reçu                          |
| 9     | Longueur de charge          | 8 octets      | gros-boutiste — somme des CLAIRS, **dérivée**                    |
| 10    | Scellements cumulés         | 8 octets      | gros-boutiste                                                    |

Total : **136 octets** (41 + 13 + 4 + 34 + 8 + 8 + 8 + 4 + 8 + 8) pour un identifiant de trente-deux
caractères — voir § 5.1 pour ce que devient ce total sous un identifiant d'une autre longueur, ce
que `encoderEnteteRacine` accepte tout autant. À ne pas confondre avec les 136 octets qu'une racine
de format 2 occupait dans son secteur (§ 6.7) : les deux nombres sont égaux par coïncidence et ne
mesurent pas la même chose.

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

**Le rang ne sépare PAS les deux magasins, et c'est une correction.** Ce document a affirmé le
contraire — « le rang sépare des identités qui partageraient tout le reste » — au-dessus d'une table
qui épingle le rang 0 pour un secteur du volume. La pré-revue adverse de #20 l'a réfutée sur les
vecteurs livrés ([#143](https://github.com/pinfada/railsbox-vault/issues/143)) : le rang d'un
enregistrement est sa **position dans la charge**, donc le premier enregistrement de chaque charge
porte lui aussi le rang 0, et une écriture du guest alignée sur un secteur — le cas nominal du § 7.2
— donnait deux objets de magasins différents sous des données associées identiques octet pour octet.

**Ce qui sépare les magasins est l'ÉTIQUETTE DE DOMAINE** (§ 5.1 et § 5.1 bis), et elle les sépare à
**tout rang**. Le rang, lui, sépare des identités **à l'intérieur d'un magasin** : trois valeurs
sont **épinglées par le format** pour le magasin du volume, et le rang d'un enregistrement ordonne
la charge du journal.

| Rang       | Valeur              | Ce qu'il identifie                                          |
| ---------- | ------------------- | ----------------------------------------------------------- |
| 0          | `0`                 | un **secteur du volume** — une seule version par génération |
| `2^40 − 2` | `1 099 511 627 774` | le **témoin** de dernière séquence vue                      |
| `2^40 − 1` | `1 099 511 627 775` | l'**empreinte de la région** d'authentification             |

Les rangs qu'un volume emploie réellement partent de zéro et la charge est plafonnée à 16 Mio, soit
au plus quelques dizaines de milliers d'entrées : prendre les deux plus grands rangs représentables
met ces identités hors d'atteinte de toute collision **sans coûter un octet de format**.

Un enregistrement de journal, lui, porte sa **position dans la charge**, en base zéro — et il vit
dans l'autre espace d'identités, celui du § 5.1 bis. Un rang décalé aurait fermé le cas observé sans
fermer la classe : deux magasins seraient restés dans le même espace, séparés par une convention que
rien n'aurait relue.

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

**« Supprimer et recréer », outillé.** `removeOpfsVolume(name)` (`src/vm/opfs-sync-access.mjs`)
retire le volume ET ses voisins — journal de génération (`.gen`), témoin de séquence (`.temoin`),
enveloppe de clé (`.cles`), instantané de reprise (`.instantane`) — pour que le nom redevienne
disponible sans rien laisser derrière lui. La NAISSANCE d'un volume du même nom retire elle-même ces
orphelins, à l'exception de l'enveloppe de clé (§ 6.9), pour l'exploitant qui a retiré le seul
fichier de volume à la main : voir § 6.9 et § 9.6, constat
[#145](https://github.com/pinfada/railsbox-vault/issues/145).

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
**création** d'un volume et la **migration** scellent donc TOUS les secteurs, y compris ceux qui ne
portent que des zéros. Épreuves : `tests/unit/vm-volume-chiffre.test.mjs` › « REFUS 5 — un secteur
EN CLAIR, jamais scellé, est refusé : pas de secteur vierge en v3 » et
`tests/unit/vm-volume-chiffre.test.mjs` › « sceller un volume ENTIER ne laisse aucun secteur sans
sceau ».

**L'ordre des deux écritures d'un secteur, et pourquoi il ne change rien.** Écrire un secteur, c'est
écrire deux choses : sa charge et son sceau. Aucune atomicité ne les lie, et le format n'en suppose
aucune. La charge est écrite en premier, si bien qu'une coupure entre les deux laisse « charge
neuve, sceau ancien » — refusé. L'ordre inverse laisserait « sceau neuf, charge ancienne » — refusé
aussi. La protection contre la **perte** est ailleurs : dans le journal (§ 6.6), dont le point de
contrôle — et le rejeu de reprise (§ 6.8, § 7.3) — sont les deux gestes qui écrivent le volume, et
dont l'échec ne valide rien. Épreuve sur support réel : `tests/vm/resilience-arrets.spec.mjs` › «
sur OPFS réel, une écriture déchirée n'entame plus le volume ».

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

**L'alternance fait DEUX choses, et la seconde a longtemps été tue.** Elle protège une validation
déchirée — c'est ce qui précède — **et** elle conserve, sur le support, un **point de recul d'une
génération** : l'emplacement `(s − 1) mod 2` porte encore la racine `s − 1`, authentique et lisible.
Ce point de recul est donc à portée d'un adversaire qui n'a **rien archivé** : abîmer les 512 octets
de l'emplacement `s mod 2` suffit à faire de `s − 1` l'autorité, et les écritures acquittées de la
génération `s` disparaissent ([#144](https://github.com/pinfada/railsbox-vault/issues/144)). Les
deux faces sont vraies ensemble, et la seconde est ce qui rend le témoin décisif : c'est lui, et lui
seul, qui distingue une racine `s` déchirée par une coupure d'une racine `s` détruite pour reculer.
La règle est écrite au § 6.9, avec ses trois cas et le refus qu'elle ajoute.

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

**L'identité logique d'un enregistrement est celle du § 5.1 bis**, sous l'étiquette de domaine du
JOURNAL : depuis le format 4, un enregistrement et le secteur du volume qui porte la même adresse
sous la même génération ne vivent plus dans le même espace d'identités. Le § 5.4 dit pourquoi le
rang n'y suffisait pas.

**Un journal de format 2 ou 3 est REJOUÉ une fois, sous l'ancienne étiquette.** Une charge validée
vit dans le journal jusqu'à ce qu'une ouverture la reporte dans le volume : la refuser perdrait une
écriture **acquittée**, et la lire sous la nouvelle étiquette la refuserait par « sceau refusé »,
donc par `VAULT_STORAGE_GENERATION_CORRUPT` — « restaurer une sauvegarde » — pour un volume intact.
C'est le défaut que la revue de #110 avait relevé sur le format 1
(`src/vm/generation-v1-rejeu.mjs`). Le vidage qui termine **toute** récupération écrit ensuite une
racine de format 4 : la fenêtre dure exactement une ouverture, et le rapport d'ouverture la publie
sous `journalFormatAnnonce`. Épreuves : `tests/unit/vm-journal-format-4.test.mjs` › « un journal de
format 3 portant une génération VALIDÉE est rejoué sans perte » et
`tests/unit/vm-journal-format-4.test.mjs` › « après le rejeu, l'ouverture suivante trouve un journal
de format 4 et ne rejoue rien ».

Le chemin de compatibilité n'est pas une porte : un enregistrement de format 3 dont le chiffré a
changé d'un octet reste refusé, sous le même code qu'un journal de format courant —
`tests/unit/vm-journal-format-4.test.mjs` › « un journal de format 3 ABÎMÉ rend le même refus
qu'avant, jamais un clair ».

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

| Grandeur                                                         | Valeur | Ce qu'elle décide                                 |
| ---------------------------------------------------------------- | -----: | ------------------------------------------------- |
| Point de contrôle amorti au-delà de                              |  8 Mio | quand le journal est rangé dans le volume et vidé |
| Plafond de la charge déposée depuis le dernier point de contrôle | 16 Mio | au-delà, l'écriture est REFUSÉE, jamais acquittée |

**Ce que ce plafond borne, précisément.** `deposer` refuse quand la charge **déposée depuis le
dernier point de contrôle** dépasse ce plafond — et non la charge d'« une génération » : entre deux
points de contrôle, plusieurs validations (donc plusieurs générations) se succèdent sur la même
charge cumulée (voir plus bas), si bien que la grandeur bornée est plus grande que ce qu'une seule
génération a pu déposer. Un boot mesuré le 2026-08-27 a compté 68 écritures OPFS pour une seule
barrière. Le § 5.3 nomme correctement cette grandeur (« plafond de charge du **journal** ») ; c'est
la seule des trois occurrences du chiffre à le faire.

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
| 8      |       4 | format du journal — **4**                 | non — il localise                |
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
`tests/unit/vm-generation-chiffre.test.mjs` › « le format du journal passe à 4, et sa racine occupe
toujours 202 octets » et `tests/unit/vm-generation-chiffre.test.mjs` › « la racine v3 ne porte plus
de CRC-32 : l'étiquette a pris sa place ».

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

**Le format du journal fait barrière de version.** Ce runtime **lit** les formats 2, 3 et 4.

**Ce qu'il ÉCRIT dépend d'une condition, et la condition doit être dite** : une session qui tient
une source de fraîcheur — la région d'authentification et le témoin (§ 6.8) — écrit le format **4**
; une session ouverte **sans** source écrit le format **2**, c'est-à-dire le journal de #18, et
scelle donc ses enregistrements sous l'étiquette de domaine d'un **bloc du volume**. Une phrase
antérieure de ce document disait « n'écrit que le 4 » sans réserve ; une revue l'a réfutée en une
commande, et la borne réelle n'est pas temporelle mais **conditionnelle**.

**Aucun chemin du produit n'ouvre sans source.** `openOpfsVolume` en fournit toujours une ; les
seuls appelants qui déclarent l'absence sont deux **bancs de mesure**, qui chronomètrent une
récupération et ne rouvrent jamais ce qu'ils écrivent. Cela ne se lit pas, cela se mesure :
`tests/unit/harnais-portes.test.mjs` › « aucun OUVREUR SANS FRAÎCHEUR n'est un module de src/ »
tient la liste des franchissements et refuse tout module du chemin de production, et
`tests/unit/vm-journal-format-4.test.mjs` › « l'OUVREUR DU PRODUIT écrit un journal de format 4, et
ses enregistrements ne sont pas des blocs » épingle le résultat par le chemin d'ouverture réel.

Un runtime plus ancien refuse une racine de format 4 : il ouvrirait les enregistrements sous
l'étiquette de domaine du VOLUME (§ 5.4), et un runtime d'avant le format 3 ne confronterait pas non
plus la région. **Ce qu'il refuse EXACTEMENT n'est pas ce que ce document a longtemps annoncé**, et
il vaut mieux décrire ce qu'un exploitant lit que ce qu'un module lève : le refus « Format de
journal de génération inconnu : 4 » est produit par le décodeur, mais il est **agrégé** avant
d'atteindre la surface — la racine illisible est comptée parmi les racines abîmées, et l'exploitant
reçoit `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` (« ce qui a été validé est INCONNU… restaurer une
sauvegarde »), ou `VAULT_STORAGE_GENERATION_CORRUPT` par le témoin lorsqu'il y en a un. **Le refus
est typé, il précède toute écriture, et aucune génération validée n'est écartée en silence** — c'est
la propriété qui compte, et elle tient. Mais le diagnostic est faux dans ce cas précis : le volume
est intact, et le remède exact — mettre à jour le runtime — n'est nommé nulle part. C'est écrit ici
plutôt que corrigé dans le code : distinguer « racine illisible » de « racine d'un format plus
récent » touche `remedeSansRacine`, donc la conduite d'une récupération, et cela ne se décide pas
dans une correction d'identité logique. Épreuve : `tests/unit/vm-generation-format.test.mjs` › « le
format du journal vaut 4 : un runtime antérieur refuse cette racine sans la comprendre ».

**Un numéro de format dit DEUX choses ensemble** : ce que porte la racine, et sous quelle étiquette
de domaine les enregistrements de sa charge sont scellés. **2** = pas d'empreinte de région,
enregistrements sous l'identité d'un bloc (ce qu'écrivait #18, et ce qu'écrit une session sans
source) ; **3** = empreinte de région, enregistrements sous l'identité d'un bloc (#19) ; **4** =
empreinte de région, enregistrements sous leur propre identité (#143). Les découpler aurait demandé
un champ de plus dans la racine pour un état qu'aucun volume de production n'atteint.

**Les formats 3 et 4 ont EXACTEMENT la même disposition**, et il faut dire ce que cela laisse : le
champ de format n'est pas authentifié, et aucune garde de cohérence ne peut les distinguer comme
celle qui distingue 2 de 3 (§ 6.8). Le retourner fait ouvrir les enregistrements sous l'autre
étiquette, qui ne vérifie pas : le résultat est un **refus**, jamais un clair, et sur une racine
VIDE — l'état d'un journal au repos — il ne change rien, puisque aucun enregistrement n'est ouvert.
Ce qui interdit de rejouer un vrai journal de format 3 à côté d'un volume plus récent reste ce qui
l'interdisait déjà : le plancher de séquence du témoin (§ 6.9) et l'empreinte de région que sa
racine scelle (§ 6.8). Épreuve : `tests/unit/vm-journal-format-4.test.mjs` › « un journal de format
3 dont le NUMÉRO est retourné en 4 est refusé, jamais ouvert de travers ».

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
la racine de génération, dont l'autorité vient du journal et pas du volume. **Entière** veut dire :
l'empreinte SHA-256 des `R × 512` octets de la région alignée (§ 6.1), **rembourrage compris** — le
rembourrage entre bien dans l'empreinte, ce que la seule lecture du § 4.3 et du présent paragraphe
ne tranchait pas.

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

**Elle n'est REHACHÉE que si le volume a été écrit** depuis la dernière. **Deux gestes écrivent le
volume : le rejeu de reprise et le point de contrôle** ; les deux marquent la région salie
(`marquerRegionSale`). Les racines intermédiaires — celles où aucun des deux gestes n'a eu lieu
depuis la dernière — rescellent l'empreinte tenue en cache — un chiffrement de 32 octets, pas un
hachage de 34 Mio. La marque « région salie » est levée **avant** l'attente du hachage et jamais
après : un point de contrôle peut écrire pendant le hachage, et lever la marque après aurait scellé
l'état d'avant. Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « une région salie PENDANT
le hachage n'est pas oubliée ».

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
authentique ; sa **présence** ne l'est pas. Ce qui RÉDUIT ce reste — il n'est pas fermé, seulement
réduit — est le témoin (§ 6.9) et une garde de cohérence : une racine qui se déclare de format 2
au-dessus d'octets de fraîcheur non nuls est refusée — un des deux ment. **Le cas symétrique est
couvert aussi, et sans ambiguïté** : une racine de format 3 porte TOUJOURS une fraîcheur ; le
décodeur ne rend `fraicheur = null` que pour un format 2, jamais pour un format 3, si bien que des
octets de fraîcheur nuls sous un format 3 ne se lisent jamais comme une absence — ce sont un sceau
qui ne vérifie pas, donc un refus à la confrontation (`ouvrirBloc` refuse un sceau de zéros), jamais
un repli sur « aucune empreinte scellée ». C'est une garde, pas une authentification, et la nuance
est écrite plutôt que gommée.

**Coût mesuré.** Empreinte d'une région de 34 Mio sur OPFS réel : p50 de **344,8 et 354,1 ms**, p95
de 350,2 et 383,3 ms sur deux exécutions de trois relevés, soit **0,58 % et 0,64 %** du budget de
reprise de 60 s. Le seuil épinglé par l'épreuve est **un pour cent** de ce budget, et c'est un
**engagement**, pas une observation : `tests/vm/fraicheur-region-cout.spec.mjs` › « l'empreinte de
région d'un volume de 512 Mio reste sous le pour-cent du budget de reprise ». Ce que la mesure ne
borne pas : la **fréquence**. Une session paie une empreinte à l'ouverture et une par point de
contrôle ; rien n'interdit qu'une application en paie beaucoup, et personne ne l'a mesuré.

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

Le rapport publie aussi `journalFormatAnnonce` : le format que la racine trouvée **déclare** à
l'ouverture, avant que le vidage n'écrive une racine neuve, ou `null` si aucune racine ne faisait
autorité.

**Son nom porte sa réserve, et c'est une correction.** Ce champ s'appelait `journalFormat` et ce
document lui donnait un sens d'exploitation — « il dit d'un volume s'il a franchi le format 4 ». Il
est lu à l'offset 8 de la racine, qui **n'est pas authentifié** (§ 6.7) : un adversaire le choisit,
dans les deux sens. Une revue l'a montré sur un journal AU REPOS, entièrement migré, dont le champ
retourné 4 → 3 fait publier « format 3 » à une ouverture dont la fraîcheur est par ailleurs
`verifiee`. La doctrine de ce dépôt étant qu'« un contrôle qu'on ne publie pas finit par être
supposé actif », un contrôle publié dont la valeur est choisie par l'adversaire mérite la même
franchise : le champ vaut comme état de migration **sur un journal que rien n'a touché**, et pas
au-delà.

Ce qui est ÉTABLI, en revanche, est ce que la récupération a fait : une charge non vide rejouée sous
l'ancienne étiquette de domaine ne s'ouvre que si ses enregistrements y étaient réellement scellés
(§ 6.6). Le retournement du champ sur une charge non vide est donc un **refus**, jamais un clair —
dans les deux sens, et les deux sont éprouvés : `tests/unit/vm-journal-format-4.test.mjs` › « un
journal de format 3 dont le NUMÉRO est retourné en 4 est refusé, jamais ouvert de travers » et
`tests/unit/vm-journal-format-4.test.mjs` › « un journal de format 4 dont le NUMÉRO est retourné en
3 est refusé : c'est le sens qu'un volume de production rencontre ». Sur une racine VIDE, aucun
enregistrement n'est ouvert et le retournement ne change que ce que le rapport annonce :
`tests/unit/vm-journal-format-4.test.mjs` › « sur une racine VIDE, le format retourné ne change que
ce qui est ANNONCÉ ».

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

**Le champ « génération » n'oppose aucun plancher : il est écrit pour le DIAGNOSTIC, pas comme
contrôle.** Contrairement à la séquence, dont l'ouvreur retient la valeur pour la présenter comme
plancher à chaque vérification de racine (§ 7.3), aucun chemin de production ne relit ce champ. Un
relecteur qui le suppose symétrique de la séquence — un plancher de génération — bâtirait sur une
propriété que le format n'offre pas ; le champ existe déjà, et lui faire opposer un plancher serait
un durcissement réel, pas un ajout de format.

**Il est écrit APRÈS la racine et sa barrière, jamais avant. L'ordre est le contrat.** Une coupure
entre les deux laisse un témoin **en retard** : un plancher en retard sous-détecte, il ne refuse
jamais à tort. L'ordre inverse laisserait un témoin **en avance**, c'est-à-dire un volume intact
refusé. Épreuve sur support réel, coupant dans cette fenêtre exacte :
`tests/vm/resilience-fraicheur.spec.mjs` › « une coupure ENTRE la racine et le témoin laisse un
témoin en retard, jamais un refus ».

**Il est retiré avec le volume**, et aussi par tout geste qui RÉÉCRIT le volume entier : la
restauration et la migration. Un témoin survivant attesterait, pour un volume réécrit depuis une
archive, une séquence que celui-ci n'a jamais atteinte : la prochaine ouverture refuserait un volume
sain, et le message désignerait un retour arrière qui n'a pas eu lieu. La règle est donc écrite
plutôt que laissée à la vigilance — **un témoin ne date que le volume qu'il accompagne**.

**Deux cas distincts, et un seul de retrait outillé côté naissance (#145).** Un témoin survivant à
côté d'un fichier de volume ABSENT n'est pas un cas de recul : **un témoin sans volume ne date
rien**, puisque le volume qu'il décrivait n'existe plus. C'est le cas de l'exploitant qui a supprimé
le seul fichier de volume, à la main, sans passer par `removeOpfsVolume` (§ 6.3, § 10.2) : la
NAISSANCE du volume homonyme qui suit retire elle-même ce témoin orphelin, avant même que la
récupération de sa génération ne le lise, et ce retrait ne désarme rien — la détection du recul
porte sur un volume PRÉSENT, pas sur un volume qui vient de naître. Un témoin survivant à côté d'un
fichier de volume PRÉSENT, en revanche, reste un écart de séquence réel : c'est ce volume-là qui a
reculé, et retirer le témoin effacerait la seule trace qui en reste — voir « le geste qui en sort »
plus bas.

**Absent = première ouverture, jamais une preuve.** C'est le point où la nuance se perd le plus
facilement.

**Ce que le scellement du témoin achète, exactement — et ce qu'il n'achète pas.** Le sceau refuse un
témoin dont la séquence n'a **jamais été atteinte par ce volume sous cette clé** : c'est la
**forgerie**, et elle est fermée. Il ne rend pas le témoin **monotone**, et il ne le rend pas non
plus **unique** : la séquence vit dans le clair et les données associées sont **constantes pour un
volume donné** (rang `2^40 − 2`, génération 0, adresse 0, longueur 16), si bien que deux témoins
successifs du même volume sont **aussi authentiques l'un que l'autre**. Un témoin qui a été
légitimement écrit peut donc être **REJOUÉ**, et il fabrique alors un **refus permanent d'un volume
sain**. La formulation antérieure — « cela évite seulement qu'un tiers sans clé fabrique un refus
permanent » — confondait forgerie et rejeu ;
[#142](https://github.com/pinfada/railsbox-vault/issues/142) l'a relevé, et la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153) la corrige ici.

Le chemin est celui qu'une **restauration d'archive** ouvre : `discardGeneration` retire le journal
**et** le témoin, et l'archive porte le fichier v3 tel quel — donc le même identifiant de volume et
la même clé (§ 7.5). Qui peut écrire dans l'OPFS de l'origine n'a qu'à conserver une copie du témoin
et la **remettre** après la restauration : l'ouverture suivante ne trouve aucune racine sous un
témoin présent, et refuse (`VAULT_STORAGE_GENERATION_CORRUPT`, cause `VAULT_TEMOIN_SEQUENCE`).

**Le geste qui en sort, et sa CONDITION — les deux, jamais l'un sans l'autre.** Après une
restauration d'archive **délibérée**, un témoin présent ne peut être qu'une copie réinstallée : le
**retirer** rouvre le volume en première ouverture, sans perdre un octet. **Sans restauration, ne
pas le retirer** : c'est le volume qui a reculé, et retirer le témoin effacerait la seule trace qui
en reste. Un message qui enseignerait « retirer le témoin » sans sa condition désarmerait la
détection du recul réel ; celui de ce refus porte les deux lectures et la condition. Épreuve :
`tests/unit/vm-recul-generation.test.mjs` › « un témoin REJOUÉ après une restauration nomme les DEUX
lectures et le geste CONDITIONNEL ».

Ce que le rejeu **n'obtient pas** reste vrai : aucun clair, aucune forgerie, aucun octet perdu sur
le volume. Et la capacité qu'il exige — écrire dans l'OPFS de l'origine — permet déjà de détruire le
volume lui-même : le témoin n'a jamais défendu contre cet adversaire, et ce même paragraphe dit plus
bas que le neutraliser est gratuit. Ce qui **fermerait** le rejeu est une **ancre monotone hors du
support** (§ 9.1, § 13 question n° 3) ; elle n'existe pas, et rien ici ne la remplace.

**Deux refus que le témoin ajoute, et qui n'existaient pas :**

- un journal **sans aucune racine** sous un témoin présent. Le témoin ne s'écrit qu'après une racine
  et sa barrière : son existence prouve qu'une racine a été durable, et son absence du journal est
  un recul, pas un volume neuf. Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « un
  journal SANS racine sous un témoin présent est refusé : c'est un recul, pas un volume neuf » ;
- une racine **sans empreinte** sous un témoin qui en atteste une. Une propriété acquise ne se
  reperd pas ; cet état décrit un retour à une racine d'avant la fraîcheur. Épreuve :
  `tests/unit/vm-generation-fraicheur.test.mjs` › « une fois la fraîcheur acquise, un retour à une
  racine SANS empreinte est refusé ».

**Sa limite, sans détour, et l'effort n'est PAS symétrique.** Reculer le volume d'**une** génération
ne suppose **aucune copie antérieure** : l'alternance des racines (§ 6.6) garde `s − 1` lisible sur
le support, et le point de recul est donc dans le fichier par construction. Abîmer les 512 octets de
l'emplacement `s mod 2` suffit à le ramener là. Reculer **au-delà d'une génération** suppose, lui,
une copie antérieure de volume et de journal, cohérente : la racine `s − 2` a été écrasée par `s`.
La formulation antérieure — « reculer le volume suppose d'en détenir une copie antérieure » —
promettait donc à l'adversaire un coût qu'il n'a pas à payer ;
[#144](https://github.com/pinfada/railsbox-vault/issues/144) l'a relevé, et la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153) la corrige ici comme au § 9.1.

**Ce qui décide devant un recul d'une génération est le TÉMOIN**, et l'ordre d'écriture ci-dessus
est ce qui le permet — le témoin vient **après** la racine et sa barrière :

- **témoin concordant** avec la racine retenue (à sa séquence, ou en retard sur elle) : c'est une
  coupure pendant l'écriture de `s`, le cas normal que l'alternance existe pour absorber. Le volume
  **ouvre**, et les octets déposés au-delà de ce que la racine retenue authentifie sont écartés sous
  `VAULT_STORAGE_GENERATION_DISCARDED` (§ 10.2). Refuser ici enverrait « restaurer une sauvegarde »
  à chaque coupure au mauvais instant ;
- **témoin en avance** sur la racine retenue : c'est le recul que ce témoin ferme déjà, et le
  plancher de séquence refuse sans qu'aucune règle nouvelle soit nécessaire ;
- **témoin absent** : pour que `s − 1` soit acceptée sous un témoin à `s`, l'adversaire doit d'abord
  neutraliser le témoin — ce qui, comme dit plus bas, ne lui coûte rien. Une coupure a pu l'emporter
  aussi. **Rien ne distingue les deux**, et l'état est **REFUSÉ** :
  `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`, dont le message porte les deux lectures.

**Neutraliser le témoin ne suppose rien : le supprimer, ou simplement le tronquer, suffit — et sans
la clé.** Un fichier absent, vide ou trop court n'est pas un témoin ; l'ouverture repart sur «
première ouverture », donc sans plancher, et la fenêtre du retour arrière complet est **réarmée**
pour qui détient déjà une copie antérieure de volume + journal. Ce comportement est délibéré et ne
doit pas changer : refuser tout volume sans témoin rendrait irouvrable un volume neuf, un volume
restauré depuis une archive, ou un volume dont le témoin a été perdu par un incident de support — on
échangerait une détection qu'on n'a pas contre une perte de données qu'on aurait.

**Le refus que #144 ajoute ne contredit pas la phrase précédente, et il faut dire exactement
pourquoi.** Il ne porte que sur la **conjonction** « aucun témoin **ET** une racine abîmée **ET**
une racine retenue **portant une empreinte de région** ». **Quatre** états ne la produisent pas :

- un volume **neuf** n'a aucune racine abîmée ;
- un volume **restauré** n'a pas de `.gen` du tout, `discardGeneration` le retirant avec le témoin ;
- un **premier point de contrôle** écrit une racine et laisse l'autre emplacement vierge — et un
  secteur vierge n'est pas une racine abîmée (§ 6.6) ;
- un volume scellé **avant #19**, dont la racine ne porte aucune empreinte de région (§ 6.8). Un
  magasin d'alors n'écrivait aucun témoin : son absence ne prétend rien, elle n'a **jamais pu** être
  autrement. Exiger un témoin ici rendrait irouvrable **pour toujours** un volume que la migration
  devait ouvrir — le refus tombant avant toute écriture, le vidage ne réparerait jamais
  l'emplacement déchiré. La fenêtre dure **exactement une ouverture**, et la porte qu'elle pourrait
  laisser reste gardée par un contrôle qui ne bouge pas : une racine sans empreinte **sous un témoin
  qui en atteste une** est refusée. Ce quatrième état a été relevé en revue. Épreuve :
  `tests/unit/vm-recul-generation.test.mjs` › « un volume scellé par #18, dont une racine est
  déchirée, reste OUVRABLE : il n'a jamais pu avoir de témoin ».

Un volume dont le témoin a été perdu par un incident de support rouvre donc comme avant, **sauf** si
une racine est abîmée en même temps — et dans ce cas précis, ce qui a été validé est réellement
inconnu.

**Ce que ce refus SUR-DÉTECTE, et pourquoi rien ne le corrige.** Le compte des racines abîmées
**compte**, il ne **situe** pas : une racine illisible n'a plus de séquence lisible, et prétendre la
situer reviendrait à croire un en-tête que rien n'authentifie. Abîmer la racine la plus **ancienne**
— celle qui ne fait pas autorité, dont la perte ne coûte rien — produit donc le même refus, alors
que rien n'a reculé. Le message nomme les **deux** lectures que cela laisse — la racine abîmée
portait la séquence d'avant celle retenue (une avarie sans conséquence, typiquement une coupure
pendant sa propre écriture), ou celle d'après (et le volume a reculé) — plutôt que d'en inventer une
troisième. C'est le prix de la règle, relevé en revue, et il est éprouvé :
`tests/unit/vm-recul-generation.test.mjs` › « la racine ABÎMÉE n'est pas située : abîmer l'ancienne
refuse comme abîmer la récente, et c'est le prix ».

**Ce que ce refus NE ferme PAS, et c'est la limite de la règle.** Il tient contre l'adversaire qui
**neutralise** le témoin — celui-là obtient un refus, pas un recul. Il ne tient **pas** contre celui
qui le **rejoue**, c'est-à-dire l'adversaire de #142, accepté dans la même correction : archiver le
témoin à `s − 1` (62 octets), abîmer la racine `s`, puis **remettre** la copie fait concorder le
témoin avec la racine retenue. L'ouverture conclut « coupure », le volume ouvre sur `s − 1`, et une
génération **acquittée** disparaît sous un rapport qui déclare la fraîcheur `verifiee` — le seul
signal étant `VAULT_STORAGE_GENERATION_DISCARDED`, qui dit « coupure normale ». Ce n'est **pas** une
course : le témoin n'est pas perdu au bon instant, il est archivé à l'avance. Épreuve :
`tests/unit/vm-recul-generation.test.mjs` › « #142 COMPOSÉ à #144 : un témoin ARCHIVÉ puis rejoué
fait perdre une génération acquittée sous « verifiee » ». Épreuves du refus lui-même :
`tests/unit/vm-recul-generation.test.mjs` › « une racine abîmée à côté d'une racine lisible, SANS
témoin, est REFUSÉE : rien ne la distingue d'un recul », « une coupure qui déchire la racine `s`
laisse le témoin à `s − 1` : le volume ROUVRE, et la mise au rebut est PUBLIÉE » et « une racine
abîmée sous un témoin EN AVANCE reste un recul : le plancher de séquence refuse ».

Ce qui manque n'est pas une garde de plus : c'est une **ancre monotone hors du support** (§ 9, § 13
question n° 3).

En revanche, un fichier qui **ressemble** à un témoin mais dont le sceau ne vérifie pas est REFUSÉ,
jamais ignoré : l'ignorer offrirait à quiconque peut écrire dans l'origine le moyen de désarmer le
contrôle en abîmant huit octets.

### 6.9 bis Le voisin `<volume>.engagement`

Ajouté le 10 septembre 2026 (#181,
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)). **Cent quatre-vingts octets,
GROS-boutistes**, et un fichier qui n'existe qu'entre une restauration et l'ouverture qui la valide
: il est CONSOMMÉ à cette ouverture, jamais relu ensuite.

| Offset | Largeur | Champ                                                      |
| ------ | ------: | ---------------------------------------------------------- |
| 0      |       8 | marqueur `VLTENG01` (ASCII)                                |
| 8      |       4 | version du fichier d'engagement — **1**                    |
| 12     |       4 | version d'ARCHIVE — **3**                                  |
| 16     |      32 | identifiant de volume, 32 hexadécimaux minuscules (ASCII)  |
| 48     |       8 | taille support                                             |
| 56     |       8 | taille logique                                             |
| 64     |       4 | taille de secteur — **512**                                |
| 68     |       4 | version de l'enveloppe embarquée — **0** s'il n'y en a pas |
| 72     |       8 | longueur du contenu                                        |
| 80     |       8 | longueur de la section de récupération                     |
| 88     |      32 | sel du domaine `archive`, TIRÉ, en clair                   |
| 120    |      12 | nonce                                                      |
| 132    |      32 | chiffré — l'empreinte du fichier, scellée                  |
| 164    |      16 | étiquette                                                  |

**Tout ce qui précède le sel est exactement ce que les données associées encodent** (§ 7.5) : le
fichier est SELF-DESCRIPTIF, et l'ouverture y reconstruit les données associées sans rien supposer.
Ses déclarations sont authentifiées par l'étiquette GCM — les modifier fait échouer l'ouverture,
jamais dériver le verdict. Le SEL, lui, n'est pas authentifié et n'a pas à l'être : un adversaire
qui le change obtient une clé différente, donc un refus.

**Il fait exactement onze caractères de suffixe, comme `.instantane`** : il ne rétrécit donc aucun
nom de volume déjà admissible. Il figure dans la liste de `removeOpfsVolume` **et** dans le balayage
d'orphelins d'une naissance, par acquit, même s'il est consommé à la première ouverture — c'est le
défaut de #145, et on ne le rouvre pas.

Vecteur figé : `tests/vectors/archive-v3.json` › `engagement.voisin`.

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
4. **écrire la RACINE INITIALE** — séquence 0, génération 0, compteur = les scellements que la
   création vient de consommer, la racine comprise —, barrière, puis le témoin ;
5. poser la marque `VLTSEAL1`, barrière. **C'est le dernier geste.**

Une coupure avant l'étape 5 laisse un volume refusé par `VAULT_STORAGE_VOLUME_INCOMPLET` (§ 6.3).

> **L'étape 4 est ajoutée le 10 septembre 2026** (#181,
> [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)). Elle est ce qui rend vraie
> la règle « **aucun volume légitime n'est sans racine** », et donc ce qui rend REFUSABLE un volume
> restauré dont on a retiré l'engagement (§ 7.3, § 7.5). Bénéfice second : elle publie les 2^20
> scellements qu'une création de 512 Mio ne publiait nulle part (§ 4.5).
>
> **Un volume v3 créé AVANT cette date n'a pas de racine initiale : il est refusé** par
> `VAULT_STORAGE_VOLUME_SANS_RACINE`. Rien n'est publié et le gate « données sensibles » est fermé ;
> les volumes pré-fabriqués des bancs et des scénarios ont été régénérés.
>
> **Le versement d'un disque applicatif hors transaction DATE sa création.** La coquille de produit
> (ADR 0030) et le banc de référence écrivent le fichier entier sans passer par le journal, ce qui
> change la région d'authentification et périme donc la racine de l'étape 4. Ils appellent
> `daterLaCreation` une fois le fichier final, avant d'inscrire le manifeste. Sans cet appel, le
> volume est refusé au premier boot par la garde de fraîcheur (§ 6.8) : un oubli coûte un refus,
> jamais un silence. Épreuve : `tests/unit/coquille-application.test.mjs`, sur l'ordre des gestes de
> l'installation.

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
   la plus haute séquence lisible fait autorité. **Si AUCUNE ne fait autorité, voir le pas 4 bis :
   l'ouverture ne continue pas sans une autorisation.** 4 bis. **AUCUNE racine ne fait autorité —
   les trois cas, et il n'y en a pas de quatrième** (#181,
   [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)) :

   | À l'ouverture                     | Conduite                                                                                                                                                                                                          |
   | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | une racine fait autorité          | chemin normal — les pas 5 à 9 ci-dessous ; l'engagement n'est pas consulté                                                                                                                                        |
   | pas de racine, engagement présent | vérifier l'engagement **avant tout clair** ; s'il ouvre : écarter la charge trouvée s'il y en a une, écrire aussitôt la **racine initiale**, puis RETIRER le voisin ; sinon : `VAULT_STORAGE_ENGAGEMENT_INVALIDE` |
   | pas de racine, engagement absent  | `VAULT_STORAGE_VOLUME_SANS_RACINE`, **avant tout clair**                                                                                                                                                          |

   Le cas « au moins une racine ABÎMÉE » reste ce qu'il est :
   `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`, inchangé, et il tombe **avant** toute autorisation —
   vérifier un engagement coûte l'empreinte de tout le fichier, et un journal dont on ne sait plus
   ce qu'il a validé est refusé de toute façon.

   **L'engagement est CONSOMMÉ une fois**, jamais vérifié à chaque ouverture : une fois la racine
   initiale écrite, c'est la fraîcheur du § 6.8 qui prend le relais. Le voisin est retiré **après**
   que la racine soit durable — l'ordre inverse laisserait, sur une coupure, un volume sans racine
   et sans engagement, c'est-à-dire irrécupérable.

   **Une ouverture qui ÉCRIT est un geste nouveau sur ce chemin, et il est PUBLIÉ** : le rapport
   d'ouverture porte `racineInitiale: true` et le motif — `creation`, `migration` ou `engagement`.
   Jamais en silence.

5. **Parcours de la charge**, enregistrement par enregistrement, en **fenêtre glissante** : lire
   l'en-tête, lire le sceau, sauter le chiffré, collecter l'entrée
   `(adresse, longueur, rang, étiquette)`. Aucun déchiffrement, aucune allocation qui suive la
   taille de la charge.
6. **Ouvrir la racine** : l'étiquette de l'en-tête est vérifiée, **puis** le rejeu, la troncature et
   le mélange sont **établis** sur un en-tête authentique.
7. **Confronter la région** à l'empreinte que la racine scelle — **avant toute lecture de secteur**.
8. **Rejouer** : seconde passe, chaque enregistrement ouvert sous l'identité reconstruite (volume,
   format 3, génération **du sceau**, rang, adresse, longueur), puis rescellé vers le volume.
   **Cette étape écrit le volume et salit donc la région d'authentification (§ 6.8), au même titre
   que le point de contrôle** — c'est ce qui empêche l'étape 9 de sceller l'empreinte d'avant le
   rejeu.
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

> **L'ARCHIVE EST AUTHENTIFIÉE depuis le 10 septembre 2026**
> ([#181](https://github.com/pinfada/railsbox-vault/issues/181), CRITICAL corrigé — § 9.7,
> [PR #184](https://github.com/pinfada/railsbox-vault/pull/184),
> [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)).
>
> **Ce que la revue avait montré, et qui n'est plus vrai.** Le SHA-256 décrit plus bas est
> **recalculable** par quiconque tient le fichier : il atteste contre l'accident, pas contre un
> adversaire. Comme la restauration retire journal et témoin et que l'ouverture suivante acceptait
> l'absence de racine, un mélange de secteurs authentiques venus de deux états du même volume se
> restaurait, s'ouvrait et se lisait en clair, sans refus.
>
> **Ce qui le referme, en trois traits.** Une archive v3 porte un ENGAGEMENT — le SHA-256 du fichier
> chiffré ENTIER, scellé sous une clé du domaine `archive` dérivée de la DEK ; la restauration le
> dépose à côté du volume ; la première ouverture le vérifie AVANT tout clair, écrit la racine
> initiale, puis retire le voisin. Et, pour que ce refus soit atteignable, **aucun volume légitime
> n'est sans racine** (§ 7.1). Les archives v1 et v2 sont REFUSÉES : elles ne portent aucun
> engagement, et c'est exactement le défaut.

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
   dépôt n'en gérait qu'une (§ 11). Perdre la clé, c'était perdre l'archive.

> **AMENDÉ le 6 septembre 2026 (#149, [ADR 0027](decisions/0027-archive-et-ancre-de-version.md)) :
> le format d'archive passe à la VERSION 2, et la seconde chose peut voyager.**
>
> ```text
> [ RBVAULT1 8 o ][ longueur d'en-tête 4 o ][ en-tête JSON H o ][ contenu N o ][ récupération R o ]
> ```
>
> L'en-tête déclare `recovery: { length, digest, envelopeVersion, slots } | null` ;
> `offset du contenu = 12 + H` (INCHANGÉ) ; `taille de l'archive = 12 + H + N + R`. La section,
> quand elle existe, est **une page d'enveloppe de 8 192 octets ne portant que des emplacements de
> type 4** — un moyen de récupération, jamais une phrase ni une passkey, et **jamais le code**, qui
> reste sur une feuille chez l'utilisateur. À la restauration, `<volume>.cles` est écrit à partir de
> cette page (page 0 = la page embarquée, page 1 à zéro), **après** le contenu relu et **avant** le
> manifeste.
>
> Une archive v2 dont `recovery` vaut `null` décrit un volume sans moyen de récupération, et le
> compte rendu de l'export le DIT : elle ne s'ouvrira nulle part ailleurs.

> **AMENDÉ le 10 septembre 2026 (#181,
> [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)) : le format d'archive passe
> à la VERSION 3, et l'en-tête gagne un champ.**
>
> ```text
> [ RBVAULT1 8 o ][ longueur d'en-tête 4 o ][ en-tête JSON H o ][ contenu N o ][ récupération R o ]
> ```
>
> La DISPOSITION ne bouge pas : `offset du contenu = 12 + H`, `taille = 12 + H + N + R`, et le
> marqueur `RBVAULT1` est inchangé — le changer ferait dire à un runtime ancien « ce n'est pas une
> archive » au lieu de « cette archive est trop récente », et l'ADR 0011 veut un refus explicite
> d'un format futur. L'en-tête déclare, entre `recovery` et `manifest` :
>
> ```json
> "engagement": { "algorithm": "aes-256-gcm", "salt": "<64 hex>", "nonce": "<24 hex>",
>                 "ciphertext": "<64 hex>", "tag": "<32 hex>" }
> ```
>
> **Ce que l'engagement scelle.** Clair = `SHA-256(fichier chiffré ENTIER)`, 32 octets. Données
> associées, champs de largeur fixe ou préfixés de leur longueur, comme au § 5.1 :
>
> ```text
> donnéesAssociées = LP("railsbox-vault/archive/engagement/v1") ‖ LP("aes-256-gcm")
>                  ‖ U32BE(versionDArchive) ‖ LP(identifiantVolume)
>                  ‖ U64BE(tailleSupport) ‖ U64BE(tailleLogique) ‖ U32BE(tailleDeSecteur)
>                  ‖ U32BE(versionDeRecuperation)
>                  ‖ U64BE(longueurDuContenu) ‖ U64BE(longueurDeLaRecuperation)
> ```
>
> **La longueur de l'EN-TÊTE n'y est PAS, et c'est une nécessité d'encodage, pas un oubli** :
> l'engagement vit dans cet en-tête, et y sceller sa longueur la rendrait fonction d'elle-même. Ce
> que l'en-tête déclare d'AUTRE — la garantie de cohérence, le nom de l'application — n'est donc pas
> authentifié, et cette phrase est là pour ne pas le laisser croire.
>
> **La clé.**
> `HKDF-SHA-256(IKM = DEK, sel = 32 octets TIRÉS et écrits en clair dans l'archive, info)`, info de
> l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) décision 3 avec
> `domaine = "archive"` et `versionDeFormatDuDomaine = 3`. **Une archive, une clé, un scellement,
> aucun compteur** : le domaine `archive` est à usage unique, et le budget du § 4.5 n'a rien à y
> compter. La clé du VOLUME, elle, reste la DEK jusqu'à #182 — entorse assumée, écrite dans
> l'ADR 0033.
>
> **Qui vérifie, et quand.** La restauration **n'a pas la clé**, et c'est une propriété qu'on garde
> : elle vérifie ce qu'elle peut sans clé — présence, longueur, cohérence de l'en-tête, version lue
> —, refuse une archive de version non lue, et DÉPOSE l'engagement dans le voisin
> `<volume>.engagement` (§ 6.9 bis), entre l'enveloppe de récupération et le manifeste. C'est
> l'OUVERTURE qui le confronte, selon les trois cas du § 7.3.
>
> **Ce que ce refus prouve, et ce qu'il ne prouve pas.** Il est tenu contre le mélange et contre le
> retrait du voisin. Il ne couvre PAS le rejeu d'une archive **entière et cohérente** : c'est le
> retour arrière complet du § 9.1, inchangé. Un volume v3 créé avant cette date est refusé, comme
> les archives v1 et v2.
>
> Vecteurs figés : `tests/vectors/archive-v3.json`, vérifiés par `node tools/verifier-vecteurs.mjs`
> depuis le seul texte des ADR — l'info HKDF octet par octet, les données associées, le scellement
> qui S'OUVRE, et les 180 octets du voisin.

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

- **Garantit** qu'une altération non détectée exige une forgerie GCM, majorée par ≈ 2^-122,6 pour un
  secteur de 512 octets et par ≈ 2^-107 pour le plus grand enregistrement de journal que le plafond
  de charge admette (16 Mio, § 4.1) — le pire cas, pas le meilleur. C'est une intégrité
  **authentifiée**, non une somme de contrôle : le recalcul exige la clé.
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

Les données associées portent l'identité logique **complète**, **magasin compris** : un bloc valide
relu à une autre adresse, dans un autre volume, sous une autre version de format, une autre
génération — ou **dans l'autre magasin** — est refusé.

Le « magasin compris » est une correction, pas une reformulation. Jusqu'au format de journal 4, un
enregistrement du journal et un secteur du volume partageaient leur étiquette de domaine, et cette
propriété était **fausse** dans le cas nominal du § 5.4 : les deux se déplaçaient l'un vers l'autre
sans qu'aucune étiquette bronche. Le constat est
[#143](https://github.com/pinfada/railsbox-vault/issues/143) ; la § 9.6 dit ce qui reste ouvert pour
les volumes déjà écrits.

- **Garantit** que le déplacement exige la même forgerie que P1, l'encodage étant injectif.
- **Ne garantit pas** de dire **de quoi** le refus vient : modification et déplacement sont
  **cryptographiquement indiscernables**, et un seul code les couvre. Ne garantit pas non plus
  l'unicité de l'identifiant de volume, qui est tiré localement et que rien n'authentifie contre un
  registre.
- **Hypothèses** : l'identifiant de volume est unique et immuable ; les clés de deux volumes sont
  distinctes.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « P2 positif — le même chiffré s'ouvre
  sous SON identité logique, et sous elle seule », `tests/unit/vm-volume-chiffre.test.mjs` › « REFUS
  2 — un secteur valide DÉPLACÉ à une autre adresse est refusé » et, pour la séparation des
  magasins, `tests/unit/vm-identite-magasin.test.mjs` › « un ENREGISTREMENT de journal épissé dans
  la région et la charge du volume est REFUSÉ ».

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

**Ce paragraphe ne décrit QUE le retour arrière complet, et un recul d'UNE génération n'en est pas
un.** Il ne demande ni copie antérieure ni journal : l'alternance des racines (§ 6.6) garde `s − 1`
lisible sur le support, et abîmer les 512 octets de `s` suffit. **Le témoin tranche ce recul-là,
SAUF contre un adversaire qui en détient une copie antérieure** — celui de
[#142](https://github.com/pinfada/railsbox-vault/issues/142) :

- contre qui **neutralise** le témoin, le recul est refusé (§ 6.9,
  `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`) ;
- contre qui le **rejoue** — un témoin de `s − 1` archivé, la racine `s` abîmée, la copie remise —,
  il ne l'est pas : le témoin **concorde** avec la racine retenue, l'ouverture conclut « coupure »,
  et une génération **acquittée** disparaît sous un rapport qui déclare la fraîcheur `verifiee`.
  C'est le retour arrière décrit ci-dessus, **obtenu à moindre coût** — 62 octets archivés à
  l'avance au lieu d'une copie cohérente du volume et du journal. Il reste **indétectable**, et
  cette phrase le dit plutôt que de laisser croire que le témoin ferme ce recul en toutes
  circonstances. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « #142 COMPOSÉ à #144 ».

[#144](https://github.com/pinfada/railsbox-vault/issues/144) avait relevé que ce paragraphe et le §
6.9 promettaient tous deux « une copie antérieure » pour un recul d'une génération ; la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153) corrige les deux, et une revue de
cette PR a corrigé la correction — la première rédaction affirmait que « le témoin le tranche »,
sans sa réserve.

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
transaction : le point de contrôle et le rejeu de reprise sont les deux gestes qui écrivent le
volume (§ 6.8), leur échec ne valide rien, et la génération reste dans le journal pour être rejouée.
Épreuves : `tests/unit/vm-generation-format.test.mjs` › « une racine dont l'en-tête est tronqué par
une déchirure n'est jamais une racine » et `tests/unit/vm-generation-store.test.mjs` › « une
génération validée est REJOUÉE à la réouverture même si le point de contrôle a manqué ».

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

### 9.6 Constats de la pré-revue interne, 5 septembre 2026

Quatre constats de la pré-revue adverse interne (#20, moitié 1, point 5) décrivent un défaut RÉEL du
format ou de sa mise en œuvre — pas un défaut de ce document. Chacun contredit une phrase que ce
document écrivait ailleurs. **Trois sont corrigés** (#143, #144, #145) : leurs phrases d'origine ont
été récrites là où elles vivaient. **Un est accepté** (#142) : sa limite est écrite, l'ADR 0019 est
amendé, et sa sévérité est révisée. Les dispositions sont inscrites au registre de la revue externe.

**[#142](https://github.com/pinfada/railsbox-vault/issues/142) — Un témoin authentique rejoué rend
un volume sain définitivement irouvrable. ACCEPTÉ, sévérité révisée HIGH → MEDIUM, ADR 0019 amendé
le 5 septembre 2026 ; documenté et le message corrigé par la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153).** Le § 6.9 affirmait, à tort, que le
scellement du témoin « évite seulement qu'un tiers sans clé fabrique un refus permanent en y
inscrivant une séquence démesurée » — cette phrase confondait forgerie et rejeu. État réel : le
scellement empêche la **forgerie** d'une séquence inventée ; il n'empêche PAS le **rejeu** d'une
copie antérieure et authentique du témoin, qui est **fongible** pour un volume donné. Une
restauration d'archive retire le témoin et le journal sans en reposer tant qu'aucun point de
contrôle n'a eu lieu ; réinstaller ensuite la copie d'un témoin antérieur fait échouer la
confrontation de fraîcheur (`journalSousLeTemoin`) et rend un volume par ailleurs sain irouvrable.

**Pourquoi ACCEPTÉ, et non corrigé.** Rendre le rejeu détectable demanderait une **ancre monotone
hors du support** (§ 13, question n° 3), et elle n'existe pas. Faire entrer la séquence dans les
données associées du témoin — la seconde proposition de l'issue — ne la fabriquerait pas : un témoin
rejoué resterait **authentique** sous cette identité aussi, et le coût serait une version du format
de témoin et l'invalidation d'un vecteur figé, pour une propriété qui ne serait pas acquise.

**Pourquoi la sévérité est révisée en MEDIUM — et ce que ce motif ne dit PAS.** L'adversaire requis
écrit dans l'OPFS de l'origine de confiance, ce contre quoi le témoin n'a **jamais** défendu : le §
6.9 écrit depuis #19 que le neutraliser est gratuit sous cette même capacité. Ce que le rejeu
obtient **seul** est un refus permanent d'un volume sain — un déni de service, sans perte d'octet ni
clair. Ce qu'il obtient **en composition avec #144** est davantage, et il faut l'écrire plutôt que
de l'omettre : un retour arrière d'**une génération** sous un rapport `verifiee`, c'est-à-dire le
retour arrière complet du § 9.1, **déjà accepté comme indétectable**, obtenu à moindre coût — 62
octets archivés au lieu d'une copie cohérente du volume et du journal. La sévérité reste révisée
parce que ni la capacité ni la propriété perdue ne sont neuves ; ce qui l'est, ce sont deux défauts
de **conduite** — une phrase fausse, et un message qui envoyait l'exploitant dans une boucle sans
issue nommée (« restaurer une sauvegarde », geste qui retire le témoin que l'adversaire n'a qu'à
remettre). Une revue de la PR a fait retirer de ce motif l'argument « aucune perte d'octets », qui
était faux en composition. Les deux sévérités figurent au registre, et le motif est dans l'issue.

**Ce que la disposition change.** Le § 6.9 dit désormais ce que le sceau achète (la non-forgerie) et
ce qu'il n'achète pas (la non-fongibilité, donc pas la résistance au rejeu), et il nomme le **geste
de sortie avec sa CONDITION** : après une restauration d'archive **délibérée**, retirer le témoin ;
sans restauration, ne pas le retirer, car il est alors la seule trace du recul. Le message du refus
porte les deux lectures et la même condition — l'enseigner sans elle désarmerait la détection du
recul réel. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « un témoin REJOUÉ après une
restauration nomme les DEUX lectures et le geste CONDITIONNEL ».

**Ce que la disposition NE change pas, et c'est le résidu.** Le rejeu reste **possible** : un
adversaire qui peut écrire dans l'OPFS peut toujours refabriquer ce refus après chaque restauration.
Aucun octet de format ne bouge, aucun vecteur ne change, et l'ancre monotone n'est pas décidée
(#23).

**[#143](https://github.com/pinfada/railsbox-vault/issues/143) — L'identité logique ne sépare pas un
enregistrement de journal d'un secteur de volume. CORRIGÉ par la
[PR #146](https://github.com/pinfada/railsbox-vault/pull/146).** Le § 5.4 affirmait, à tort, que «
le rang sépare des identités qui partageraient tout le reste » et présentait le rang 0 comme
identifiant sans ambiguïté « un secteur du volume » : le premier enregistrement déposé dans une
charge de journal porte lui aussi le rang 0, sous une identité par ailleurs identique dans le cas
nominal d'une écriture alignée sur 512 octets. Ce n'était donc pas le rang qui séparait les deux
magasins, mais l'empreinte de région (§ 6.8) — absente des trois états `non-fournie`, `sans-racine`
et `migree`, qui restaient exposés à la substitution du contenu d'un secteur par celui, différent,
que le journal détient pour la même adresse et la même génération.

**Ce que la correction ferme** : les enregistrements du journal portent désormais leur propre
étiquette de domaine (§ 5.1 bis), et le format du journal passe de 3 à 4 (§ 6.7). Aucun octet du
volume ne change ; `tests/vectors/format-chiffre-v1.json` reste valide. Les trois états exposés
refusent maintenant un enregistrement épissé — `tests/unit/vm-identite-magasin.test.mjs` › « un
ENREGISTREMENT de journal épissé dans la région et la charge du volume est REFUSÉ ».

**Ce que la correction NE ferme pas, et ce résidu est nommé plutôt que tu.** Des octets
d'enregistrement scellés sous l'étiquette d'un **bloc** restent épissables dans la région et la
charge du volume correspondant, dans les trois mêmes états. Aucune clé ne permet de les resceller,
et fermer ce reste aurait exigé de changer aussi l'étiquette des SECTEURS — c'est-à-dire d'invalider
les vecteurs de l'ADR 0015 et d'imposer un rescellement complet de chaque volume existant.

**Deux façons d'obtenir de tels octets, et la seconde n'est pas temporelle** — une revue a corrigé
ce document sur ce point :

- un journal écrit **avant** le format 4. La migration a lieu à la première réouverture, et le
  vidage qui la termine tronque la charge : après elle, l'OPFS n'en porte plus. Il faut donc en
  détenir une copie prise avant ;
- un journal écrit **aujourd'hui par une session sans source de fraîcheur** (§ 6.7), qui écrit le
  format 2. La borne est donc **conditionnelle**, pas seulement temporelle. Aucun chemin du produit
  n'ouvre ainsi — seuls deux bancs de mesure le font, et `tests/unit/harnais-portes.test.mjs` › «
  aucun OUVREUR SANS FRAÎCHEUR n'est un module de src/ » le tient par inspection de source plutôt
  que par cette phrase.

Ce qui est fermé, et c'est l'essentiel du modèle de menace, est l'attaque **continue** sur un volume
du produit : un adversaire qui lit l'OPFS n'y trouve plus d'enregistrement épissable.

**[#144](https://github.com/pinfada/railsbox-vault/issues/144) — Le retour arrière d'une génération
ne demande aucune copie antérieure, et une racine abîmée à côté d'une racine lisible est ignorée.
CORRIGÉ par la [PR #153](https://github.com/pinfada/railsbox-vault/pull/153).** Le § 6.9 et le § 9.1
affirmaient, à tort, que « reculer le volume suppose d'en détenir une copie antérieure, cohérente
avec son journal ». État réel : l'alternance des racines (§ 6.6) conserve sur le support la racine
`s − 1`, authentique et lisible, à l'emplacement `(s − 1) mod 2` — il n'y a donc rien à détenir pour
revenir d'une génération. Écrire des octets quelconques sur l'emplacement de la racine `s`, tant
qu'aucun point de contrôle n'a eu lieu depuis `s − 1`, suffit à rendre `s − 1` de nouveau autorité ;
aucun refus n'était posé pour la racine `s` abîmée à côté d'elle, et les enregistrements de la
génération `s` déjà écrits dans le journal étaient écartés en silence, sous un rapport d'ouverture
qui déclare la fraîcheur `verifiee`.

**Ce que la correction ferme.** Le **témoin décide**, et l'ordre d'écriture du § 6.9 le permet — il
vient après la racine et sa barrière. Un témoin **concordant** avec la racine retenue est une
coupure, et le volume ouvre. Un témoin **absent** devant une racine abîmée à côté d'une racine
retenue est un état **ambigu que rien ne distingue d'un recul**, et il est désormais **REFUSÉ** sous
`VAULT_STORAGE_GENERATION_ROOT_CORRUPT` (§ 10.2), avec un message qui porte les deux lectures. Le
refus ne porte que sur cette **conjonction** : ni un volume neuf, ni un volume restauré, ni un
premier point de contrôle ne la produisent, si bien que le « refuser tout volume sans témoin ne doit
pas changer » du § 6.9 reste vrai. Et la mise au rebut des octets de la génération `s` porte
maintenant son code — `VAULT_STORAGE_GENERATION_DISCARDED` est publié **dès qu'un octet est
écarté**, y compris dans le chemin `rejouee` où il ne l'était pas, ce qui rend vraie la promesse du
§ 10.2. Épreuves : `tests/unit/vm-recul-generation.test.mjs`.

**La proposition n° 1 de l'issue est REFUSÉE, et il faut dire pourquoi.** Refuser dès qu'une racine
abîmée côtoie une racine lisible, sans regarder le témoin, refuserait le cas **normal** que
l'alternance existe pour absorber : une racine déchirée par une coupure pendant sa propre écriture.
Le coût serait « restaurer une sauvegarde » à chaque coupure au mauvais instant — c'est-à-dire une
perte de données réelle échangée contre une détection que le témoin donne déjà.

**Ce que la correction NE ferme pas, et une revue de la PR l'a établi par reproduction.** La règle
fait décider le témoin : elle tient contre l'adversaire qui le **neutralise**, et **pas** contre
celui qui le **rejoue** — c'est-à-dire contre #142, accepté dans la même correction. La composition
des deux constats se reproduit ainsi, sans la clé :

1. archiver `<volume>.temoin` à la séquence `s − 1` : **62 octets**, pris longtemps à l'avance ;
2. laisser la génération `s` être validée et **acquittée** au guest ;
3. écrire 512 octets quelconques sur l'emplacement `s mod 2`, puis **remettre** l'archive.

Le témoin **concorde** alors avec la racine retenue, l'ouverture conclut « coupure », le rapport
publie `etat: rejouee`, `fraicheurRegion: verifiee`, `code: VAULT_STORAGE_GENERATION_DISCARDED`, et
les écritures acquittées de la génération `s` **ont disparu du volume** après le rangement — sans
qu'aucun refus ne soit levé. **Ce n'est pas une course** : le témoin n'est pas perdu au bon instant,
il est archivé à l'avance. C'est le **retour arrière complet du § 9.1**, déjà accepté comme
indétectable, obtenu à moindre coût — 62 octets au lieu d'une copie cohérente du volume et du
journal. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « #142 COMPOSÉ à #144 : un témoin
ARCHIVÉ puis rejoué fait perdre une génération acquittée sous « verifiee » ».

Le refus **sur-détecte** par ailleurs : abîmer la racine la plus ancienne, celle qui ne fait pas
autorité, produit le même refus, parce qu'une racine illisible n'a plus de séquence lisible (§ 6.9).

Le compteur de scellements cumulés (§ 4.5) recule toujours avec la racine retenue ; ce n'est pas une
réutilisation de nonce — les nonces sont tirés (§ 4.2) —, et le § 4.5 le dit désormais plutôt que de
le laisser deviner.

Enfin, la phrase de l'issue « l'état publié est `verifiee` » est **exacte**, et la première
rédaction de cette correction la restreignait à tort au chemin « sans témoin » : `verifiee` est
publié aussi **avec** un témoin à `s − 1`, dans la reproduction ci-dessus. Ce qui est vrai est plus
étroit — avec un témoin resté à `s`, le plancher de séquence refuse et rien n'est publié. La
correction est portée dans l'issue.

**[#145](https://github.com/pinfada/railsbox-vault/issues/145) — « Supprimer et recréer » ne retire
aucun voisin, et le volume recréé est refusé. CORRIGÉ par la
[PR #157](https://github.com/pinfada/railsbox-vault/pull/157).** Le § 6.3 et le § 10.2 affirmaient,
à tort, que le message de `VAULT_STORAGE_VOLUME_INCOMPLET` nomme « le seul remède vrai : supprimer
et recréer » sans que ce geste existe dans `src/` ni que ce document dise ce qu'il faut supprimer.
Le point 1 du constat était PÉRIMÉ : `removeOpfsVolume(name)` (`src/vm/opfs-sync-access.mjs`) existe
en production et retire déjà les voisins d'un volume explicitement supprimé — `.gen`, `.temoin`,
`.cles`, `.instantane`. Ce qui restait vrai, et qui est corrigé ici : un exploitant qui supprime
seulement le fichier `<volume>` à la main, sans passer par `removeOpfsVolume`, puis en recrée un du
même nom, laissait `<volume>.temoin` en place ; le volume neuf était scellé sous un identifiant
neuf, et sa première ouverture échouait sur le sceau du témoin, qui porte l'ancien identifiant
(`VAULT_STORAGE_SCEAU_REFUSE`).

**Ce que la correction ferme.** La NAISSANCE d'un volume (`naissance === true`,
`src/vm/opfs-volume-ouverture.mjs`) retire elle-même ses voisins orphelins — `.gen`, `.temoin`,
`.instantane`, `.migration` — AVANT que la récupération de sa génération ne les lise, en EXCLUANT
l'enveloppe de clé `.cles` (§ 6.9, § 11, ADR 0020 : une naissance qui la retirerait détruirait
l'enveloppe qu'un chemin de création chiffrée vient de poser pour ce même volume). Le retrait est
publié dans `describe().voisinsRetires`, jamais en silence. Épreuves :
`tests/unit/vm-naissance-voisins-orphelins.test.mjs` › « la naissance retire les voisins orphelins
.gen, .temoin et .instantane, et rouvre sans refus » et « la naissance NE retire PAS l'enveloppe de
clé, écrite avant elle (ADR 0020) ». Le cas « volume neuf homonyme » du constat disparaît (§ 6.9) ;
le § 11 ne compte plus « supprimer et recréer » parmi les remèdes non outillés.

`docs/revue-externe/registre.md` porte ces **quatre lignes** : #143, #144 et #145 disposés « corrigé
», #142 disposé « accepté » avec sa sévérité révisée. Ces quatre constats viennent d'une pré-revue
INTERNE traitée comme externe ; la moitié 2 de #20 a eu lieu depuis, et ses deux constats sont au §
9.7.

### 9.7 Constats de la revue externe, 10 septembre 2026

La moitié 2 de [#20](https://github.com/pinfada/railsbox-vault/issues/20) a eu lieu le 10 septembre
2026, sur `main` à l'empreinte `aa6be826ad0e14162a9e06e5`. Son texte intégral est versé au dépôt en
[`docs/revue-externe/revue-2026-09-10.md`](revue-externe/revue-2026-09-10.md), et sa nature est
écrite au registre sans formule d'audit : **une revue adverse assistée par un agent d'IA distinct
des agents du dépôt, ni tiers humain ni cabinet indépendant.** Que cela satisfasse la condition «
tiers » des gates de [`SECURITY.md`](../SECURITY.md) est une décision du mainteneur, **et elle n'est
pas prise**.

**Verdict du relecteur : le gate « données sensibles » ne doit pas être ouvert.** Deux constats. Le
CRITICAL est **CORRIGÉ** depuis le 10 septembre 2026
([PR #184](https://github.com/pinfada/railsbox-vault/pull/184),
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)) ; le HIGH reste **OUVERT** au
registre — reçu, reproduit, non corrigé, et dû avant la fermeture de #20.

**[#181](https://github.com/pinfada/railsbox-vault/issues/181) — Une archive accepte un mélange de
secteurs provenant de plusieurs états, et la première ouverture restaurée le rend en clair.
CRITICAL, CORRIGÉ.** La restauration retire le journal et le témoin avant de recopier le volume (§
7.5) ; l'ouverture suivante traite l'absence de racine comme une première ouverture ; et l'archive
n'est authentifiée par rien d'autre qu'un SHA-256 **recalculable** (§ 7.5, § 13 question n° 6). Le
relecteur a exécuté le mélange : trois états A, B, C du même volume, puis le secteur 0 de A remis
dans le fichier de C, puis une archive reconstruite avec le format public. Le résultat est
`{ "archiveVerifiee": true, "fraicheur": "sans-racine", "etatJamaisProduit": true }` : chaque
secteur reste authentique isolément, leur combinaison ne correspond à **aucun état validé**, aucun
refus n'est produit, et le clair est rendu.

**Ce que ce constat contredit dans ce document.** Le § 8, propriété P5, écrit que le format refuse «
jamais un mélange » ; la § 9.1 assume le retour arrière COMPLET du support, pas un état **jamais
produit**. Un adversaire qui détient deux archives ou deux captures chiffrées du même volume revient
sélectivement sur des pages de base de données **sans connaître la clé**. La § 7.5 dit que
l'empreinte « atteste qu'une archive n'a pas été abîmée » : c'est vrai, et c'est précisément
insuffisant.

**Ce que le dépôt a FAIT, et où c'est écrit.** L'archive passe en **version 3** et porte un
**engagement authentifié** sur le fichier chiffré entier, son identité, sa géométrie et sa version
de récupération, scellé sous une clé du domaine `archive` dérivée de la DEK ; la restauration le
dépose à côté du volume, la première ouverture le **vérifie avant tout clair**, écrit la racine
initiale et retire le voisin. Les archives v1 et v2 sont **refusées** : rien n'est publié, il n'y a
aucune compatibilité à préserver. Et, pour que le refus d'un engagement ABSENT soit atteignable,
**aucun volume légitime n'est sans racine** — la création en écrit une avant `VLTSEAL1` (§ 7.1), la
migration v2 → v3 aussi. Le détail est au § 7.5 et à
l'[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md) ; la hiérarchie de clés qui
lui donne son domaine est l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md).

**Ce qu'elle NE corrige pas, et qui reste écrit ici.** Le rejeu d'une archive **entière et
cohérente** reste indétectable : c'est le retour arrière complet du § 9.1, inchangé, et l'ancrage
monotone reste renvoyé à [#23](https://github.com/pinfada/railsbox-vault/issues/23). Les épreuves
sont dans `tests/unit/vm-archive-melange-etats.test.mjs` — le mélange A/C du relecteur, six étapes,
et son revers « restauration puis voisin retiré ».

**[#182](https://github.com/pinfada/railsbox-vault/issues/182) — Le budget AES-GCM n'est pas global
à la clé. HIGH, OUVERT.** Le § 4.5 affirme compter « toutes les invocations sous une clé », et c'est
l'exigence du § 8.3 de NIST SP 800-38D. Le produit compte par **instance de scellement** : les
volumes de coquille et d'application emploient la même DEK, chaque instance repart de zéro, la
coquille et l'installation initiale s'ouvrent hors transaction, et les deux rescellements de racine
d'enveloppe — mutation de `<volume>.cles`, export avec récupération — se font directement sous la
DEK, hors compteur. Le test minimal du relecteur rend
`{ "memeCle": true, "compteurVolumeA": 1, "compteurVolumeB": 1, "sommeReelle": 2 }`.

**Ce que ce constat contredit dans ce document.** La phrase « ce que le compteur compte » du § 4.5,
et la probabilité de collision de 2^-35 qu'il publie : elle est calculée pour 2^31 invocations sous
UNE clé, et rien dans le mécanisme implémenté ne borne le nombre réel d'invocations sous la DEK.
**Ce n'est pas une réutilisation de nonce observée** — les nonces sont tirés (§ 4.2) —, c'est une
borne annoncée que le mécanisme ne tient pas. La sous-estimation hors transaction que le § 4.5 avoue
déjà en est un cas particulier, pas l'ensemble du défaut.

**Ce que le dépôt fera, et où c'est écrit.**
L'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) fait de la DEK une clé
**maîtresse** qui ne chiffre plus rien : chaque domaine — `volume`, `journal`, `instantane`,
`enveloppe`, `archive`, `recuperation` — scelle sous une clé AEAD dérivée par HKDF-SHA-256, liée au
domaine, au volume et à la version de format. Deux domaines gardent un compteur, désormais exhaustif
parce qu'une clé n'a plus qu'un consommateur ; les quatre autres prennent une clé à **usage unique**
avec un sel tiré, et n'ont plus besoin de compter. C'est une **version de format v4** avec migration
reprenable, sur le modèle de la v2 → v3 (§ 7.4).

**Ce que ces deux constats font au reste du dossier.** La question n° 1 (AES-GCM-SIV) est
**rouverte** par le relecteur ; la question n° 4 (le budget) reçoit une réponse en deux moitiés — la
PORTÉE est tranchée par l'ADR 0033, l'EMPLACEMENT reste ouvert ; la question n° 6 est tranchée
contre la position du dépôt. Les neuf réponses sont reprises une par une au § 13, et la § 14 porte
les deux constats parmi ce que ce dossier ne prouve pas.

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
code — **ce ne sont PAS des codes**, malgré la forme : ce sont les valeurs des constantes
`CAUSE_FRAICHEUR_REGION` et `CAUSE_TEMOIN` — : `VAULT_FRAICHEUR_REGION` (région relue ≠ empreinte
scellée ; racine sans empreinte sous un témoin actif) et `VAULT_TEMOIN_SEQUENCE` (journal sans
racine sous un témoin ; témoin de format inconnu).

Le reste de la famille, avec sa conduite :

| Code                                    | Ce qu'il constate                                                                                                                                                  | Conduite                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `VAULT_STORAGE_SCEAU_REFUSE`            | un sceau de secteur, d'enregistrement ou de racine ne vérifie pas                                                                                                  | restaurer une sauvegarde                         |
| `VAULT_STORAGE_IDENTITE_VOLUME`         | l'identité présentée ne correspond pas à celle qui est authentifiée                                                                                                | ouvrir le bon volume, ou la bonne clé            |
| `VAULT_STORAGE_BUDGET_DE_CLE`           | budget de scellements de la clé atteint                                                                                                                            | changer de clé de volume                         |
| `VAULT_STORAGE_CLE_REQUISE`             | volume v3 présenté SANS clé, ou clé de longueur inadmissible                                                                                                       | fournir la clé — le produit n'en fabrique aucune |
| `VAULT_STORAGE_VOLUME_INCOMPLET`        | création ou conversion interrompue : la marque de scellement manque                                                                                                | **supprimer et recréer**, pas restaurer          |
| `VAULT_STORAGE_VOLUME_SANS_RACINE`      | aucune racine ne fait autorité, et rien n'autorise à en écrire une (#181)                                                                                          | restaurer depuis l'archive                       |
| `VAULT_STORAGE_ENGAGEMENT_INVALIDE`     | un engagement d'archive est présent et n'autorise pas cette ouverture (#181)                                                                                       | restaurer de nouveau depuis l'archive            |
| `VAULT_STORAGE_GENERATION_CORRUPT`      | une génération VALIDÉE ne concorde plus (rejeu, troncature, mélange, fraîcheur)                                                                                    | restaurer une sauvegarde                         |
| `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` | une racine abîmée dont rien ne dit ce qu'elle validait : soit aucune n'est lisible, soit une racine est retenue mais AUCUN témoin ne dit laquelle faisait autorité | restaurer une sauvegarde                         |
| `VAULT_STORAGE_GENERATION_DISCARDED`    | des octets déposés au-delà de ce que la racine retenue authentifie ont été écartés. **Ce n'est pas une panne** : c'est le résultat normal d'une coupure            | rien — publié, jamais tu                         |
| `VAULT_STORAGE_GENERATION_OVERFLOW`     | la charge déposée depuis le dernier point de contrôle dépasse le plafond de 16 Mio                                                                                 | le guest doit franchir une barrière              |
| `VAULT_STORAGE_GENERATION_PENDING`      | un geste exigeant une génération validée a été demandé sur une génération en cours                                                                                 | franchir la barrière d'abord                     |
| `VAULT_STORAGE_GEOMETRY_MISMATCH`       | la géométrie du support diffère de celle de la session                                                                                                             | exporter puis migrer — jamais retailler          |
| `VAULT_STORAGE_QUOTA_EXCEEDED`          | le quota de stockage de l'origine est épuisé                                                                                                                       | libérer de la place, puis réessayer              |
| `VAULT_STORAGE_QUIESCE`                 | l'adaptateur est quiescé : une capture d'instantané est en cours                                                                                                   | réessayer après la capture                       |
| `VAULT_STORAGE_OUT_OF_RANGE`            | lecture ou écriture hors de la géométrie déclarée                                                                                                                  | corriger l'appelant                              |
| `VAULT_STORAGE_SHORT_READ`              | le support a rendu moins d'octets que demandé                                                                                                                      | réessayer, puis diagnostiquer le support         |
| `VAULT_STORAGE_PARTIAL_WRITE`           | le support a accepté moins d'octets que demandé                                                                                                                    | réessayer, puis diagnostiquer le support         |
| `VAULT_STORAGE_FLUSH_FAILED`            | la barrière de durabilité n'a pas abouti — **rien n'est acquitté**                                                                                                 | réessayer ; ne rien annoncer durable             |
| `VAULT_STORAGE_HANDLE_LOST`             | le handle exclusif a disparu sous le volume ouvert                                                                                                                 | rouvrir le volume                                |
| `VAULT_STORAGE_CLOSED`                  | opération demandée après fermeture du volume                                                                                                                       | corriger l'appelant                              |
| `VAULT_STORAGE_BUSY`                    | un autre détenteur possède déjà l'exclusivité                                                                                                                      | fermer l'autre onglet ou attendre                |
| `VAULT_STORAGE_UNSUPPORTED`             | capacité absente du moteur — **jamais remplacée par un repli silencieux**                                                                                          | changer de moteur                                |
| `VAULT_STORAGE_SUPPORT_FAILURE`         | échec du support non classable ci-dessus — nommé, jamais deviné                                                                                                    | diagnostiquer le support                         |

**Deux codes que #144 a précisés, et ce qui a changé.** `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`
couvrait le seul état « aucune racine lisible ». Il en couvre un second, de même nature — une racine
abîmée dont on ne sait pas ce qu'elle validait —, et c'est le refus que le § 6.9 décrit : sans
témoin, une racine abîmée à côté d'une racine retenue ne se distingue pas d'un recul d'une
génération. Le code n'est pas dédoublé parce que la conduite est la même, et le § 10.2 le dit ici
plutôt que de le laisser deviner. `VAULT_STORAGE_GENERATION_DISCARDED` était promis « publié, jamais
tu » et ne l'était que dans l'état `ecartee` : l'état `rejouee` écarte aussi les octets déposés
au-delà de ce que la racine retenue authentifie, et il les écartait **sans un mot**. Le rapport
d'ouverture porte désormais ce code **dès qu'un octet est écarté**, quel que soit l'état. Aucun code
n'est retiré, et aucun n'est ajouté. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « une
coupure qui déchire la racine `s` laisse le témoin à `s − 1` : le volume ROUVRE, et la mise au rebut
est PUBLIÉE ».

**« Supprimer et recréer », le remède de `VAULT_STORAGE_VOLUME_INCOMPLET`, est OUTILLÉ (#145) : voir
§ 6.3.** `removeOpfsVolume(name)` retire le volume et ses voisins ; une naissance sur un nom dont
seul le fichier de volume a été supprimé à la main retire elle-même ces mêmes orphelins, hors
enveloppe de clé — § 6.9 en donne la distinction avec un écart de séquence réel.

**Deux refus retirés le 6 septembre 2026 (#139)** : `VAULT_ARCHIVE_VOLUME_CHIFFRE` et
`VAULT_IMPORT_VOLUME_CHIFFRE` n'existent plus. Voir § 12, écart 2.

**Deux codes AJOUTÉS le 10 septembre 2026 (#181,
[PR #184](https://github.com/pinfada/railsbox-vault/pull/184),
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)), et ce qui les sépare.**
`VAULT_STORAGE_VOLUME_SANS_RACINE` dit qu'il n'y avait RIEN à présenter : ni racine, ni engagement.
`VAULT_STORAGE_ENGAGEMENT_INVALIDE` dit que ce qui a été présenté ne tient pas. Les remèdes ne sont
pas les mêmes — dans le premier cas le volume est antérieur à la règle, ou son voisin a disparu ;
dans le second, l'archive ou le volume restauré a été altéré. Le second ne rend **qu'une seule
cause**, et c'est délibéré : étiquette forgée, sel modifié, descripteur contredit, empreinte qui ne
concorde pas — les distinguer donnerait à un adversaire un oracle sur ce qu'il a manqué. Le CONTEXTE
porte le détail pour l'exploitant ; le CODE est le même.

### 10.3 Les refus des voisins hors périmètre

Ces deux familles ne relèvent pas de cette revue (§ 11). Elles sont listées **exhaustivement** pour
qu'un relecteur qui les rencontre sache qu'elles existent et qu'elles ne sont pas de son ressort.

**Enveloppe de clé** — `<volume>.cles` : `VAULT_ENVELOPPE_ABSENTE` (aucune enveloppe, ce qui n'est
pas « clé invalide »), `VAULT_ENVELOPPE_CLE_REFUSEE` (clé de déverrouillage inconnue ou révoquée —
le même refus pour les deux, indiscernable, et **le même nombre d'appels AEAD** :
`tests/unit/vm-enveloppe-operations.test.mjs` › « clé RÉVOQUÉE et clé INCONNUE rendent le même
refus, indiscernable »), `VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` (révoquer le dernier emplacement est
refusé — un volume sans issue n'est pas un état acceptable ; il ne s'applique PAS à la révocation
d'urgence de l'[ADR 0026](decisions/0026-revocation-d-urgence-et-page-libre.md), qui laisse toujours
exactement un emplacement et n'a donc aucun refus propre), `VAULT_ENVELOPPE_EMPLACEMENT_INCONNU`,
`VAULT_ENVELOPPE_IDENTITE`, `VAULT_ENVELOPPE_ILLISIBLE`, `VAULT_ENVELOPPE_MALFORME`,
`VAULT_ENVELOPPE_MELANGE`, `VAULT_ENVELOPPE_PLEINE`, `VAULT_ENVELOPPE_RACINE_REFUSEE`,
`VAULT_ENVELOPPE_REJEU`, `VAULT_ENVELOPPE_TRONCATURE`.

**Dérivation des clés de déverrouillage** : `VAULT_DERIVATION_ANNULEE`,
`VAULT_DERIVATION_ARGON2_INDISPONIBLE`, `VAULT_DERIVATION_CODE_DEJA_RENDU` (un code de récupération
n'est rendu qu'une fois, et le produit ne le conserve nulle part — ADR 0025),
`VAULT_DERIVATION_CODE_MAL_RECOPIE` (la saisie n'est pas un code de ce produit : longueur, symbole
étranger, somme de contrôle, bourrage — un refus qui ne dépend QUE de la saisie, jamais du volume ni
de l'enveloppe, et qui n'est donc pas un oracle), `VAULT_DERIVATION_PARAMETRES_REFUSES` (plancher de
coût Argon2id vérifié à l'écriture ET à la lecture), `VAULT_DERIVATION_PHRASE_REFUSEE`,
`VAULT_DERIVATION_PRF_IGNOREE`, `VAULT_DERIVATION_PRF_INDISPONIBLE`,
`VAULT_DERIVATION_TYPE_INCONNU`.

Un code de récupération ÉTRANGER — bien formé, somme de contrôle juste — ne relève d'aucun de ces
refus : il dérive une autre clé, et c'est `VAULT_ENVELOPPE_CLE_REFUSEE` qui tombe, indiscernable
d'une clé révoquée.

Aucun repli automatique entre ces refus, et aucun compteur d'échec persisté.

### 10.4 Les refus de la migration, de l'export/restauration et du manifeste

Ces trois gestes sont, contrairement aux deux familles du § 10.3, **dans le périmètre** de cette
revue (§ 3, § 6.10, § 7.4, § 7.5) : ils n'ont pas leur place au § 10.3, et le § 10 ne peut pas les
laisser sans code sans se contredire lui-même.

**La migration (§ 7.4).** Famille `VAULT_MIGRATION_*`, distincte du stockage : le remède dépend de
ce qui a échoué, pas d'un état générique du support.

| Code                                     | Ce qu'il constate                                                                                                                                   | Conduite                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `VAULT_MIGRATION_NO_PATH`                | aucune étape enregistrée ne relie le format du volume au format demandé                                                                             | migrer vers un format intermédiaire connu      |
| `VAULT_MIGRATION_DOWNGRADE_REFUSED`      | le format demandé est ANTÉRIEUR à celui du volume                                                                                                   | une migration ne descend jamais                |
| `VAULT_MIGRATION_BACKUP_REQUIRED`        | ni sauvegarde vérifiée, ni consentement nommé                                                                                                       | fournir une sauvegarde vérifiée                |
| `VAULT_MIGRATION_BACKUP_MISMATCH`        | l'archive présentée comme sauvegarde ne décrit pas ce volume dans son état courant                                                                  | fournir la bonne sauvegarde                    |
| `VAULT_MIGRATION_JOURNAL_MALFORMED`      | le journal de reprise existe mais ne fait pas autorité (illisible, ou incohérent avec le manifeste, ou visant un format que le volume ne porte pas) | ne pas deviner : restaurer une sauvegarde      |
| `VAULT_MIGRATION_GEOMETRY_MISMATCH`      | le manifeste dont part la migration ne décrit pas la géométrie réelle du support                                                                    | corriger la cible ou repartir d'une sauvegarde |
| `VAULT_MIGRATION_VERIFICATION_FAILED`    | le manifeste relu depuis le support ne rend pas les octets inscrits                                                                                 | restaurer une sauvegarde                       |
| `VAULT_MIGRATION_STEP_UNAVAILABLE`       | l'étape existe dans la chaîne, mais son exécution n'est pas fournie par cette version du runtime                                                    | mettre à jour le runtime                       |
| `VAULT_MIGRATION_CONVERSION_INCOHERENTE` | le support contredit ce que le journal de reprise déclare                                                                                           | ne pas deviner : restaurer une sauvegarde      |

Les refus de compatibilité du manifeste (`VAULT_MANIFEST_FORMAT_TOO_NEW`, `_IDENTITY_MISMATCH`,
`_UNIDENTIFIED`) ne sont **pas** reconditionnés dans cette famille : ils remontent tels quels.

**L'export et la restauration (§ 7.5).** Deux familles distinctes, l'une pour l'INTÉGRITÉ d'une
archive, l'autre pour l'écriture de sa cible.

| Code                                 | Ce qu'il constate                                                                                                                                                                                            | Conduite                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `VAULT_ARCHIVE_MALFORMED`            | l'entrée n'est pas structurellement une archive : marqueur absent, en-tête illisible, version non prise en charge, champ `recovery` absent d'une v2 ou déclaré par une v1, octets au-delà de la fin déclarée | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_TRUNCATED`            | l'archive est plus courte que ce que son en-tête déclare                                                                                                                                                     | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_DIGEST_MISMATCH`      | l'empreinte recalculée du CONTENU diffère de celle inscrite                                                                                                                                                  | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_GEOMETRY_MISMATCH`    | la longueur du contenu contredit la géométrie du manifeste ou de l'en-tête                                                                                                                                   | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_RECUPERATION_ALTEREE` | l'empreinte recalculée de la SECTION DE RÉCUPÉRATION diffère de celle inscrite (#149)                                                                                                                        | réexporter : les données, elles, sont peut-être intactes   |
| `VAULT_ARCHIVE_RECUPERATION_REFUSEE` | la section n'est pas une enveloppe de récupération SEULE — illisible, mauvaise taille, emplacement d'un autre type que 4, descripteur ou identité de volume qui ne s'accordent pas avec la page (#149)       | ne pas restaurer : la provenance de l'archive est en cause |
| `VAULT_ARCHIVE_VERSION_NON_LUE`      | l'archive porte une version que ce runtime ne lit pas — v1, v2, ou une version future (#181). Distinct de `MALFORMED` : le conteneur est reconnu, et c'est sa VERSION qui est refusée                        | réexporter depuis le volume                                |
| `VAULT_ARCHIVE_ENGAGEMENT_ABSENT`    | une archive v3 ne déclare aucun engagement, en déclare un illisible, ou décrit un volume sans identifiant (#181)                                                                                             | ne pas restaurer : l'archive n'atteste rien                |
| `VAULT_IMPORT_TARGET_NOT_EMPTY`      | la cible porte déjà un volume, jamais écrasée sans consentement explicite                                                                                                                                    | choisir une autre cible ou consentir                       |
| `VAULT_IMPORT_SPACE_INSUFFICIENT`    | l'espace estimé est inférieur au volume à restaurer, refusé AVANT toute mutation                                                                                                                             | libérer de la place                                        |
| `VAULT_IMPORT_GEOMETRY_MISMATCH`     | la cible ouverte n'a pas la taille du volume de l'archive                                                                                                                                                    | choisir une cible de la bonne taille                       |
| `VAULT_IMPORT_VERIFICATION_FAILED`   | la relecture du volume restauré ne rend pas l'empreinte de l'archive                                                                                                                                         | réexporter la source                                       |
| `VAULT_IMPORT_CONSENTEMENT_REQUIS`   | l'archive est ANTÉRIEURE à la version d'enveloppe notée sur la feuille de récupération (#149)                                                                                                                | relire la feuille ; à défaut, consentir NOMMÉMENT          |

`VAULT_ARCHIVE_VOLUME_CHIFFRE` et `VAULT_IMPORT_VOLUME_CHIFFRE` ont existé et sont **retirés depuis
le 6 septembre 2026** (#139) — voir § 10.2 et § 12, écart 2 — et n'apparaissent donc pas dans ces
deux tables.

**Une PRÉCÉDENCE, et elle se lit dans la table.** Sur une archive v2 dont la section de récupération
est abîmée, `VAULT_ARCHIVE_DIGEST_MISMATCH` tombe AVANT `VAULT_ARCHIVE_RECUPERATION_ALTEREE` quand
le contenu est abîmé lui aussi : la vérification empreinte le contenu d'abord. C'est voulu — le
contenu est ce que l'archive existe pour porter, et une archive dont le contenu est perdu n'a pas de
récupération à discuter. Et sur la section seule, `ALTEREE` précède `REFUSEE` : une section abîmée
en transport et une section FORGÉE n'appellent pas le même remède — réexporter dans un cas, se
méfier de la provenance dans l'autre.

**Le manifeste (§ 6.10).** Famille `VAULT_MANIFEST_*`, une propriété de compatibilité de format,
distincte du stockage.

| Code                                | Ce qu'il constate                                                                    | Conduite                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `VAULT_MANIFEST_MALFORMED`          | le manifeste lu n'est pas structurellement un manifeste v1                           | corriger ou recréer le manifeste            |
| `VAULT_MANIFEST_FORMAT_TOO_NEW`     | version de format supérieure à ce que ce runtime connaît                             | mettre à jour le runtime                    |
| `VAULT_MANIFEST_FORMAT_TOO_OLD`     | version de format sous le plancher lisible de ce runtime                             | migrer le volume, ou un runtime plus ancien |
| `VAULT_MANIFEST_MIGRATION_REQUIRED` | format lisible mais antérieur au format courant : écriture refusée jusqu'à migration | migrer le volume (§ 7.4)                    |
| `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  | volume écrit par un runtime majeur plus récent : écriture refusée                    | mettre à jour le runtime                    |
| `VAULT_MANIFEST_IDENTITY_MISMATCH`  | l'application en cours ne correspond pas à celle qui possède le volume               | ouvrir depuis la bonne application          |
| `VAULT_MANIFEST_UNIDENTIFIED`       | ouverture en écriture d'un volume sans manifeste connu                               | jamais autorisée (`SEC-UPDATE-001`)         |

### 10.5 La famille de la COQUILLE, et ce qu'elle refuse au document applicatif

Elle décrit une propriété de **frontière**, et non de support : ces refus ne parlent ni d'octets, ni
de volume, ni de clé. Ils disent ce que la coquille de produit refuse au document applicatif servi
par l'origine applicative (#161, [ADR 0028](decisions/0028-coquille-de-produit-et-frontiere.md),
`SEC-ORIGIN-001`). Un relecteur externe les rencontrera dès qu'il ouvrira la coquille : ils sont
donc listés **exhaustivement**, et `tests/unit/dossier-de-revue.test.mjs` échoue sur un code que le
produit rendrait sans que cette table le nomme.

Deux traits gouvernent toute la famille :

- **un refus est TYPÉ, jamais un silence.** C'est l'exigence de l'issue #24, et c'est ce qui permet
  à l'épreuve de l'application malveillante de distinguer « la coquille refuse ce geste-là » de « la
  coquille n'a pas compris le message ». Un relevé tout vert obtenu par incompréhension ne
  prouverait rien ;
- **le code ne dépend QUE du type reçu.** Il est calculé avant que la coquille ait consulté un état
  — volume, enveloppe, présence d'une clé —, et deux appareils dans des états différents rendent le
  même code pour le même type. Ce n'est donc pas un oracle : un adversaire qui lit
  `VAULT_COQUILLE_KEK_REFUSEE` apprend qu'il a demandé une KEK, ce qu'il savait en l'écrivant.

**L'encodage du contrat** (`src/coquille/contrat-de-messages.mjs`) :

| Code                              | Ce qu'il constate                                                       | Conduite                                  |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `VAULT_COQUILLE_MESSAGE_MALFORME` | le message n'est pas un objet, ou ne porte pas de type : rien à décoder | corriger l'appel                          |
| `VAULT_COQUILLE_CONTRAT_REFUSE`   | identifiant ou version du contrat étrangers à cette coquille            | parler la version publiée par la coquille |
| `VAULT_COQUILLE_TYPE_INCONNU`     | type bien formé, ni admis ni nommé par la liste de refus                | s'en tenir à la liste d'admission         |

**Les dix gestes de la liste de refus** (issue #24, décision 2 ;
`src/coquille/admission-applicative.mjs`). La liste n'est pas dérivée et ne se négocie pas : chacun
de ces gestes appartient à l'utilisateur, jamais à l'application.

| Code                                    | Geste tenté                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `VAULT_COQUILLE_KEK_REFUSEE`            | obtenir une clé de déverrouillage (KEK)                                              |
| `VAULT_COQUILLE_DEK_REFUSEE`            | obtenir la clé de volume (DEK)                                                       |
| `VAULT_COQUILLE_EXPORT_REFUSE`          | exporter le volume                                                                   |
| `VAULT_COQUILLE_REVOCATION_REFUSEE`     | `revoquerEmplacement`, `revoquerToutSauf`, `remplacerEmplacement`                    |
| `VAULT_COQUILLE_EMPLACEMENT_REFUSE`     | ajouter un emplacement de déverrouillage                                             |
| `VAULT_COQUILLE_RECUPERATION_REFUSEE`   | créer un moyen de récupération                                                       |
| `VAULT_COQUILLE_VOLUME_REFUSE`          | changer d'emplacement de volume                                                      |
| `VAULT_COQUILLE_ENVELOPPE_REFUSEE`      | lire `<volume>.cles` ou son inventaire                                               |
| `VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE` | obtenir le port privilégié coquille ↔ Worker, ou y poster un type qui lui appartient |
| `VAULT_COQUILLE_HANDLE_REFUSE`          | obtenir un handle de fichier                                                         |

**L'annonce reçue sur `window`, et l'ordre du cycle de vie.** Cinq conditions, contrôlées dans cet
ordre, chacune nécessaire :

| Code                             | Ce qu'il constate                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_CANAL_ABSENT`    | le canal privilégié n'est pas établi : aucun port n'est octroyé avant lui              |
| `VAULT_COQUILLE_ANNONCE_TYPE`    | type inattendu — il ne prouve rien seul, tout document le connaît                      |
| `VAULT_COQUILLE_ANNONCE_ORIGINE` | origine inattendue                                                                     |
| `VAULT_COQUILLE_ANNONCE_FENETRE` | fenêtre émettrice inattendue : une iframe imbriquée porte la MÊME origine que le cadre |
| `VAULT_COQUILLE_ANNONCE_UNIQUE`  | le port restreint a déjà été transféré ; il ne l'est qu'une fois                       |

**La CORRÉLATION, et ce qu'elle ferme.** Une requête admise porte un identifiant qui lui revient tel
quel : c'est lui qui apparie N réponses à N requêtes. Sans lui, deux requêtes en vol se disputaient
une seule réponse et l'une des deux restait **muette** — sur le seul geste que la coquille admette,
et alors que « jamais un silence » est écrit quatre fois dans ce dossier. C'est le constat 2 de la
revue de sécurité de la [PR #166](https://github.com/pinfada/railsbox-vault/pull/166).

| Code                                   | Ce qu'il constate                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_CORRELATION_ABSENTE`   | pas d'identifiant admissible : une chaîne de 1 à 64 caractères `[A-Za-z0-9_-]`               |
| `VAULT_COQUILLE_CORRELATION_DUPLIQUEE` | cet identifiant est déjà en vol ; le réemployer rendrait la réponse ambiguë                  |
| `VAULT_COQUILLE_TROP_DE_REQUETES`      | plus de requêtes en vol que la borne nommée. La coquille refuse ; elle ne met pas en réserve |

**Le canal PRIVILÉGIÉ, et l'ordre des gestes qu'il porte** (#162,
[ADR 0029](decisions/0029-deverrouillage-dans-la-coquille.md)). Un seul code, et il ne parvient
jamais au document applicatif — qui reçoit `VAULT_COQUILLE_RECUPERATION_REFUSEE` bien avant, sur le
type du message et sans qu'aucun état ne soit consulté.

| Code                               | Ce qu'il constate                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_VOLUME_VERROUILLE` | un geste qui exige un volume OUVERT a été demandé sur un volume qui ne l'est pas — créer un moyen de récupération exige de détenir déjà une clé qui ouvre |

Le dire par un code plutôt que par un bouton grisé a une raison : un bouton grisé n'apprend rien à
qui l'atteint autrement, et l'épreuve n'a rien à mesurer.

**Le CYCLE DE VIE assemblé, et ce qu'il refuse** (#163,
[ADR 0030](decisions/0030-cycle-de-vie-assemble-dans-la-coquille.md) ; #169,
[ADR 0031](decisions/0031-verrouiller-le-worker-meurt-l-instantane-survit.md)). Aucun ne parvient au
document applicatif : ils vivent entre la coquille, son Worker de confiance et son propre document.

| Code                                              | Ce qu'il constate                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_WORKER_MORT`                      | le Worker de confiance ne répond plus : il a jeté, il a été terminé, ou il s'est tu au-delà de `DELAI_WORKER_MORT_MS`. La coquille refuse alors **tout service jusqu'à un geste explicite**                                                                                                                |
| `VAULT_COQUILLE_ETAPE_HORS_ORDRE`                 | une étape du cycle de vie a été demandée avant celle dont elle dépend — un boot avant l'ouverture du backend, un cadre avant que l'étape 3 ait conclu, **un verrouillage pendant qu'un démarrage est en vol** (#169)                                                                                       |
| `VAULT_COQUILLE_GESTE_ROMPU`                      | le Worker de confiance a **jeté en servant une requête ADMISE**, sans code de refus à donner. Le geste était admis, il n'a pas abouti, et ce qui a jeté ne se dit pas — une exception peut nommer un chemin de fichier, un refus rendu n'a rien à en dire                                                  |
| `VAULT_COQUILLE_APPLICATION_ABSENTE`              | aucune application n'est servie par cette origine : il n'y a rien à démarrer. Ce n'est pas un échec du geste, c'est l'absence de son objet — comme `indisponible` est l'absence d'un moteur capable                                                                                                        |
| `VAULT_COQUILLE_CAPACITE_MANQUANTE`               | une capacité EXIGÉE manque au moteur, mesurée dans le document de la coquille et **sous la CSP servie** — sans l'exemption dont jouit la sonde `public/compat.html` (#2), qui mesurerait notre politique                                                                                                   |
| `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE` | un fichier de volume applicatif existe, mais aucun manifeste ne l'identifie. La coquille **refuse**, et ne réinstalle pas : un volume anonyme est soit une installation interrompue, soit autre chose, et verser le disque par-dessus écraserait sans un geste et sans un mot ce que le guest y aurait mis |
| `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE` | un fichier de volume applicatif existe, mais aucun manifeste ne l'identifie. La coquille **refuse**, et ne réinstalle pas : un volume anonyme est soit une installation interrompue, soit autre chose, et verser le disque par-dessus écraserait sans un geste et sans un mot ce que le guest y aurait mis |

`VAULT_COQUILLE_GESTE_ROMPU` est neuf (#169) et ferme un défaut de la même famille que celui qui a
fait naître `VAULT_COQUILLE_WORKER_MORT` : le repli du Worker de confiance renvoyait
`VAULT_COQUILLE_TYPE_INCONNU` pour un geste qui était, lui, parfaitement admis — et il le renvoyait
**là où le message compte le plus**, sur l'inattendu, c'est-à-dire ce dont personne n'a écrit le
refus. Il ne remplace aucun code TYPÉ : une `VAULT_STORAGE_*` garde le sien, une `VAULT_ENVELOPPE_*`
le sien ; le repli ne mord que sur ce qui n'en a pas.

`VAULT_COQUILLE_WORKER_MORT` est neuf, et son absence était un défaut : la borne de mort rejetait
sous `VAULT_COQUILLE_TYPE_INCONNU`, dont le message dit « Requête hors de la liste d'admission de la
coquille » — c'est-à-dire tout autre chose que ce qui s'était produit. Ce que ce code **ne dit pas**
est aussi important : ni ce que « verrouillé » veut dire, ni sous quel délai, ni sur quel
déclencheur. L'état et la règle appartiennent à #25 ; la coquille les cite (ADR 0030, décision 3).

**Ce que « jusqu'à un geste explicite » désigne, nommément** : le bouton « Rouvrir le coffre », que
la mort révèle dans l'interface remontée et qui **recharge** la coquille. Il ne ressuscite rien — un
Worker recréé en place hériterait d'un cadre applicatif dont le port est mort — et il n'est jamais
automatique. La borne qui mène à ce refus mesure l'absence de **signe de vie** et non l'absence de
réponse : le Worker de confiance émet un **battement** (`vault.coquille.battement-prive`) pendant
tout geste long, et un boot de deux minutes ne déclare donc plus mort un Worker vivant.

**Ce que « jusqu'à un geste explicite » désigne, nommément** : le bouton « Rouvrir le coffre », que
la mort révèle dans l'interface remontée et qui **recharge** la coquille. Il ne ressuscite rien — un
Worker recréé en place hériterait d'un cadre applicatif dont le port est mort — et il n'est jamais
automatique. La borne qui mène à ce refus mesure l'absence de **signe de vie** et non l'absence de
réponse : le Worker de confiance émet un **battement** (`vault.coquille.battement-prive`) pendant
tout geste long, et un boot de deux minutes ne déclare donc plus mort un Worker vivant.

**Ce qui ne franchit le port dans aucun sens** : `VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE` sert des
deux côtés. Vers l'application, il est levé par la coquille **contre elle-même** — une réponse
allait transporter autre chose que des données (un port, un tampon, une `CryptoKey`, un handle, une
fonction) —, et ne parvient donc jamais au document applicatif. Vers la coquille, il refuse un
message du document applicatif qui **transfère** un port ou un tampon : rien n'en était retenu, mais
rien n'était refusé non plus, et un canal qu'on n'a pas décidé d'ouvrir doit être fermé nommément
(constat 7 de la même revue).

`tests/unit/coquille-contrat.test.mjs` › « `sansCapacite` laisse passer des données et REFUSE tout
ce qui est une capacité » mesure la première moitié, `tests/browser/coquille-frontiere.spec.mjs` la
seconde, et `tools/muter-gardes-coquille.mjs` montre que les gardes savent rougir.

**Deux bornes nommées, et pourquoi elles sont dans le décodeur.** Un `type` au-delà de 128
caractères n'est pas un type : c'est une charge utile déguisée, et le refuser au décodage est ce qui
l'empêche d'être recopiée plus loin. Un type refusé revient à son émetteur **tronqué** à 64
caractères. Le motif est le constat 3 de la revue : quarante messages dont le seul champ `type`
faisait 200 000 caractères faisaient passer le relevé de la coquille de 606 à 8 003 678 caractères.
Le relevé ne recopie plus rien du guest — il COMPTE, par code, et l'ensemble des codes est clos.

Épreuves : `tests/unit/coquille-admission.test.mjs`, `tests/unit/coquille-contrat.test.mjs` et
`tests/browser/coquille-frontiere.spec.mjs` (trois moteurs, application malveillante, témoin positif
en même origine).

## 11. Les voisins hors périmètre de la revue

Un relecteur en voit la **place**, pas l'implémentation. Ils sont nommés ici avec leur statut pour
qu'aucune absence ne se lise comme un oubli.

| Voisin                | Décision                                                                                                         | Statut au 6 septembre 2026                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<volume>.cles`       | [ADR 0020](decisions/0020-enveloppe-de-cle.md), [ADR 0026](decisions/0026-revocation-d-urgence-et-page-libre.md) | **livré.** Chiffré et authentifié. Il est le seul chemin vers le volume : sa perte vaut la perte des données. **L'archive ne l'emporte pas.** **SIX** opérations depuis le 6 septembre 2026 : la révocation d'urgence retire tous les emplacements sauf celui que la clé présentée OUVRE, en une version et une barrière, et toute mutation qui RETIRE une clé efface ensuite la page libérée (8192 zéros, seconde barrière). |
| Dérivation            | [ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md)                                              | **livré.** Argon2id (RFC 9106) au plancher de la RFC, ou WebAuthn PRF. Le compteur `signCount` **n'est pas lu**.                                                                                                                                                                                                                                                                                                              |
| `<volume>.instantane` | [ADR 0024](decisions/0024-instantane-de-reprise.md)                                                              | **livré.** Il part avec le témoin et le journal à tout geste qui réécrit le volume, pour la raison de la § 6.9. L'empreinte de région de la § 6.8 lui sert de **liaison** : elle rend un instantané périmé détectable dès qu'un secteur a été rescellé (`VAULT_INSTANTANE_ECART_REGION`).                                                                                                                                     |
| `<volume>.migration`  | [ADR 0011](decisions/0011-migration-de-format-et-reprise.md)                                                     | **livré, ni chiffré ni authentifié.** Sa limite est dans le périmètre : § 9.2.                                                                                                                                                                                                                                                                                                                                                |

**Et une chose qui n'existe pas.** Le **changement de clé de volume** : le refus au budget (§ 4.5)
et la révocation d'un emplacement d'enveloppe nomment tous deux ce remède ; aucun chemin du produit
ne rechiffre un volume sous une clé neuve. C'est la limite que l'ADR 0026 écrit sans l'arrondir :
**révoquer ne rechiffre pas.** Qui détient `<volume>` et une page ANTÉRIEURE de `<volume>.cles`
développe toujours la même clé de volume ; une révocation protège le fichier À VENIR, jamais la
copie déjà prise, et l'effacement de la page libre ne change rien à cela — il ferme la fenêtre du
fichier, pas celle du support. **« Supprimer et recréer »** (§ 6.3, § 10.2), la conduite nommée par
`VAULT_STORAGE_VOLUME_INCOMPLET`, N'EN FAIT PLUS PARTIE depuis le 6 septembre 2026 :
`removeOpfsVolume` l'outille, et la naissance retire elle-même les orphelins d'un volume supprimé à
la main — voir § 9.6, constat [#145](https://github.com/pinfada/railsbox-vault/issues/145).

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
spécifier. **Statut au 6 septembre 2026 : corrigé, PR #157** — décision 10 de l'amendement du même
jour à l'[ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md).

**Écart 2 — deux refus déclarés « retirés » existent encore.** L'ADR 0016 (décision 9) écrit que
`VAULT_ARCHIVE_VOLUME_CHIFFRE` et `VAULT_IMPORT_VOLUME_CHIFFRE` « n'existent plus » : « un refus qui
survit à sa cause devient un piège pour l'exploitant ». Ils sont toujours **déclarés** dans le code
et ne sont **plus levés nulle part**. C'est du code mort et non un piège actif — aucun exploitant ne
les rencontre —, mais l'ADR affirme une suppression qui n'a pas eu lieu. **Statut au 6 septembre
2026 : corrigé, PR #157** — les deux entrées sont retirées de `src/vm/archive-errors.mjs` et
`src/vm/import-errors.mjs`.

**Écart 3 — la version du journal annoncée par l'ADR 0016 est périmée.** Sa décision 3 donne «
format du journal (**2** en v3) ». Le code écrit **4** depuis le constat #143 — 3 depuis l'ADR 0019,
qui le disait explicitement. La table de l'ADR 0016 n'a pas reçu d'amendement sur ce champ ; ses
amendements datés et celui de l'ADR 0019 donnent la version courante, la table seule ne la donne
pas. **Statut au 6 septembre 2026 : corrigé, PR #157** — la chaîne 2 → 3 → 4 est écrite dans
l'amendement du même jour à l'ADR 0016, avec ses deux renvois.

**Écart 4 — le coût du scellement initial : 18,7 s annoncés, 87,6 s mesurés.** L'ADR 0015 chiffre la
création d'un volume de 512 Mio à **18,7 s** par extrapolation, et sa section « Risques » cite «
14,4 s » pour le même geste — deux chiffres pour une même grandeur à l'intérieur d'un même document.
La mesure réelle sur OPFS, publiée dans `docs/quality-attributes.md`, donne **87,6 s** (83,5 µs par
secteur), soit un facteur 4,7 sur l'extrapolation. Le chiffre de ce document est le chiffre
**mesuré**. La fenêtre que la marque de scellement complet ferme (§ 6.3) est donc quatre fois plus
longue que l'ADR ne le laissait croire. **Statut au 6 septembre 2026 : corrigé, PR #157** — l'ADR
0015 est amendé le même jour : la mesure fait foi, et les trois chiffres restent lisibles avec leur
statut.

**Écart 5 — un commentaire du code décrit un mécanisme qui n'existe plus.** La déclaration de
`VAULT_CRYPTO_IDENTITE_INCOHERENTE` porte encore, dans son commentaire, la description de l'époque
du nonce dérivé : « le nonce conservé avec le sceau n'encode pas la génération et le rang de
l'identité présentée. Établi AVANT tout calcul cryptographique : le nonce se décrit lui-même. » Le
constructeur situé quinze lignes plus bas dit exactement le contraire, et il est juste : le nonce ne
décrit plus rien, et ce refus ne sert plus qu'à la racine, après vérification de l'étiquette. C'est
un défaut de documentation dans le code, sans effet sur les octets. **Statut au 6 septembre 2026 :
corrigé, PR #157** — le commentaire dit désormais ce que le constructeur fait.

Aucun de ces cinq écarts ne change un octet du format. Les quatre premiers sont des documents en
retard sur le code ; le cinquième est un commentaire en retard sur son propre fichier.

## 13. Questions au relecteur

> **RÉPONDUES le 10 septembre 2026.** La revue externe de la moitié 2 de #20 (§ 9.7,
> [texte intégral](revue-externe/revue-2026-09-10.md)) a répondu aux neuf. Chaque question porte
> désormais trois choses : la position d'origine du dépôt, **la réponse du relecteur citée**, et la
> **position révisée**. Aucune position d'origine n'est effacée : ce qui a changé doit se lire.
>
> Le compte, pour qui ne lit que celui-là : **une rouverte** (n° 1), **une réfutée** (n° 4, sur sa
> portée), **une tranchée contre le dépôt** (n° 6), **six confirmées ou nuancées** (n° 2, 3, 5, 7,
> 8, 9).

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

**Réponse du relecteur, 10 septembre 2026 : ROUVERTE.** « AES-GCM-SIV : position à rouvrir, compte
tenu du budget non global. Une dépendance auditée peut être justifiée. » Et, dans le corps du
constat #182 : « Le RFC le recommande précisément lorsque plusieurs chiffreurs partagent une clé ou
que l'état garantissant l'unicité ne peut être assuré (RFC 8452). Cela ne dispense toutefois pas de
séparer les clés par domaine. »

**Position RÉVISÉE du dépôt : rouverte, et exactement par ce qui la ferait changer.** Le levier
écrit ci-dessus s'est réalisé — le constat #182 est précisément que le budget réel n'est pas borné —
et la position « non, pas aujourd'hui » ne tient plus. Elle n'est pas retournée pour autant : le
relecteur écrit lui-même que SIV ne dispense pas de séparer les clés, et la séparation vient
d'abord. La question devient un **spike**, T3, dont
l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) fixe le périmètre :
disponibilité par moteur, coût par secteur devant les ≈ 17,3 µs mesurés, et ce que SIV apporte **une
fois les clés séparées** — c'est-à-dire quand une collision ne coûte plus que la confidentialité de
deux clairs d'un domaine d'un volume. Aucun code, aucune version de format : une mesure et un
verdict.

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

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE pour le volume, NUANCÉE pour l'archive.** «
Arbre de Merkle : pas nécessaire pour le volume courant. L'archive a besoin d'un engagement
authentifié global, qui peut rester plat. »

**Position RÉVISÉE du dépôt : confirmée, et la nuance devient #181.** L'empreinte plate reste le bon
outil pour le volume. Ce que la réponse ajoute est que l'archive, elle, n'a **aucun** engagement
global — et c'est le constat CRITICAL. « Qui peut rester plat » est repris tel quel par la
Definition of Ready de #181 : l'engagement est une empreinte du fichier chiffré entier, scellée, pas
un arbre.

### Question n° 3 — Existe-t-il un ancrage monotone acceptable dans un navigateur ?

**Position du dépôt.** Non. Le retour arrière **complet** est assumé (§ 9.1). Le témoin de la § 6.9
ferme le retour arrière **partiel** — le volume recule, son voisin non — et rien de plus ; il vit
dans la même origine que le volume, et le neutraliser ne coûte rien. `authenticatorData.signCount`
est instruit et écarté pour trois raisons cumulées, et le déverrouillage livré **ne le lit pas**.

**Ce qui la ferait changer.** Une ancre monotone hors du support qui ne déplacerait pas simplement
la confiance : un compteur matériel accessible depuis un navigateur, ou un témoin distant dont le
compromis serait strictement moins grave que celui de l'origine. La question est renvoyée nommément
à la récupération.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE.** « Ancrage monotone navigateur : aucun
ancrage purement local ne résiste au recul complet du profil. Il faut un témoin externe ou accepter
explicitement cette limite. »

**Position RÉVISÉE du dépôt : inchangée, et l'alternative est nommée.** La limite est acceptée
explicitement (§ 9.1), et elle l'était déjà. Ce que la réponse ajoute est que la seule autre voie
est un **témoin externe** — hors appareil, donc hors du modèle « tout tient dans le navigateur ». Ce
choix appartient à [#23](https://github.com/pinfada/railsbox-vault/issues/23) et n'est pas fait ici.
L'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) ne change rien à ce point :
la séparation des clés ne fabrique aucune ancre.

### Question n° 4 — Le budget de scellements est-il au bon endroit, et 2^31 est-il la bonne valeur ?

**Position du dépôt.** Le compteur est authentifié **dans la racine**, donc protégé contre la
falsification mais soumis au retour arrière : un support qui recule fait re-parcourir des
scellements déjà comptés, et le nombre réel d'invocations sous la clé dépasse alors le nombre compté
d'un écart qu'aucune mesure ne borne. La moitié du plafond NIST est une marge **choisie**, pas
calculée. Le témoin borne désormais ce recul pour tout ce qui n'est pas un retour arrière complet —
l'écart est réduit, pas annulé. S'y ajoute la sous-estimation hors transaction de la § 4.5, et le
fait que le compteur est **repris tel quel** de la racine qui fait autorité, sans aucun contrôle de
croissance (§ 4.5) : il suit passivement les reculs de cette racine, y compris ceux du constat
[#144](https://github.com/pinfada/railsbox-vault/issues/144), qui ne demandent pas un retour arrière
du SUPPORT. La même question vaut pour la stricte croissance de la **séquence**, que le format ne
peut vérifier que si l'appelant lui présente la valeur précédente.

**Ce qui la ferait changer.** Une mesure ou un argument bornant l'écart entre le compteur et le
nombre réel d'invocations, ce qui permettrait de fixer le budget **par le calcul** plutôt que par
une marge. Ou la démonstration que 2^31 est déjà trop haut sous le modèle de recul.

**Réponse du relecteur, 10 septembre 2026 : RÉFUTÉE, sur les deux moitiés.** « Budget : ni son
emplacement ni sa portée actuelle ne conviennent. » C'est le constat HIGH #182, et il ne porte pas
sur le recul : il porte sur le fait que le compteur ne compte **pas ce qu'il dit compter**.

**Position RÉVISÉE du dépôt : la PORTÉE est corrigée, l'EMPLACEMENT reste la question.** La position
d'origine ne parlait que du recul, et elle passait à côté : la moitié du plafond NIST était une
marge devant un écart de mesure, alors que le vrai problème était qu'il n'y avait pas **une** mesure
mais une collection de mesures locales, dont certaines n'existaient pas. La correction est
l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) : la DEK cesse de chiffrer,
chaque domaine de chaque volume a sa clé, **deux** domaines gardent un compteur — le volume et le
journal, tous deux dans l'en-tête authentifié de la racine v4 — et les quatre autres prennent une
clé à usage unique, dont le budget est 1 et qu'aucune mesure ne peut rendre faux. Les ouvertures
hors transaction, que le § 4.5 avoue aujourd'hui sous-estimer, doivent alors **clore par une
racine** ; une session qui ne peut pas en écrire n'a plus le droit de sceller.

**Ce qui reste ouvert après cette correction, et il faut le dire :** l'emplacement. Les deux
compteurs vivent toujours dans la racine, donc reculent toujours avec elle (§ 9.1,
[#144](https://github.com/pinfada/railsbox-vault/issues/144)), et 2^31 reste une marge **choisie**
devant un écart non borné. Le navigateur n'offre pas de meilleur endroit : c'est la question n° 3,
et elle est ouverte elle aussi.

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

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE, et priorisée.** « Lot par appel : 512 octets
reste défendable pour l'accès aléatoire. Une mesure comparative à 4 Kio est pertinente, mais
secondaire par rapport à la séparation des clés. »

**Position RÉVISÉE du dépôt : inchangée, et la mesure reste non faite.** Le découpage candidat de 4
096 octets est nommé d'avance, il n'est activé par aucun chemin, et il le reste. « Secondaire » est
repris tel quel : la mesure ne passe ni avant #181 ni avant #182, et elle n'a pas de tranche.

### Question n° 6 — Le manifeste et l'archive doivent-ils être chiffrés ?

**Position du dépôt, tranchée pour l'archive seulement.** L'archive porte le fichier v3 **tel
quel**, chiffré, et son manifeste (§ 7.5) ; elle n'est ni chiffrée davantage ni signée. Le
**manifeste reste en clair** et n'est pas authentifié : il porte une identité, pas des données. Deux
conséquences déjà écrites : l'empreinte porte sur le chiffré, et une archive restaurée sans sa clé
est inerte.

**Ce qui la ferait changer.** Une attaque sur le manifeste en clair qui ne se réduise pas à un refus
— aujourd'hui, un manifeste falsifié produit un écart d'identité refusé avant toute lecture. Ou une
exigence de sauvegarde qui rendrait inacceptable qu'une archive et sa clé voyagent séparément.

**Réponse du relecteur, 10 septembre 2026 : TRANCHÉE CONTRE la position du dépôt.** « Manifeste et
archive : ils n'ont pas nécessairement besoin d'être secrets, mais l'archive doit être authentifiée
cryptographiquement. Le SHA-256 auto-déclaré est insuffisant. »

**Position RÉVISÉE du dépôt : l'archive doit être authentifiée, et elle l'EST depuis le 10
septembre 2026.** La question posait « faut-il les CHIFFRER ? » et la réponse dit que ce n'était pas
la bonne question : le secret n'est pas en cause, **l'authentification** l'est. Le SHA-256
recalculable atteste contre l'accident, jamais contre un adversaire. Une archive v3 porte donc un
**engagement** scellé sous une clé du domaine `archive`, vérifié avant tout clair, et une archive
sans engagement est **refusée** (§ 7.5,
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md),
[PR #184](https://github.com/pinfada/railsbox-vault/pull/184)). **Le manifeste, lui, reste en clair
et non authentifié** : sur ce point la position d'origine tient, et le relecteur ne la conteste pas.

**Et ce que l'engagement ne couvre pas, dit ici plutôt qu'au détour d'un module.** Il scelle
l'empreinte du fichier, l'identité et la géométrie du volume, la version de récupération et les
longueurs des sections. Il ne scelle **pas** le reste de l'en-tête JSON — la garantie de cohérence
déclarée par l'export, le nom de l'application du manifeste — ni la longueur de l'en-tête lui-même,
qui serait fonction d'elle-même puisque l'engagement y vit. Ces champs restent ce que le manifeste
est : une déclaration, pas une preuve.

### Question n° 7 — Un lecteur peut-il distinguer un secteur jamais écrit d'un secteur effacé ?

**Position du dépôt.** Il n'y a **pas** de secteur jamais écrit en v3 : la création et la migration
scellent tous les secteurs, zéros compris (§ 6.5). Le prix est de **87,6 s** de scellement à la
création d'un volume de 512 Mio (§ 12, écart 4), et la fenêtre que cela ouvre est refermée par la
marque de scellement complet.

**Ce qui la ferait changer.** Un marquage **authentifié** des plages non initialisées qui coûterait
moins que le scellement complet sans rouvrir la porte du secteur zéroté lu comme blanc.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE.** « Jamais écrit / effacé : la réponse
actuelle est cohérente puisque tous les secteurs sont initialement scellés. »

**Position RÉVISÉE du dépôt : inchangée.** Elle le reste en v4 : la création scelle tous les
secteurs, et la migration v3 → v4 les rescelle tous. Ce qui change en v4 est qu'une création doit
désormais clore par une racine qui publie ce qu'elle a consommé (question n° 4) — le scellement
complet cesse d'être invisible au budget.

### Question n° 8 — L'en-tête de racine en clair est-il acceptable ?

**Position du dépôt.** Il est assumé et nommé (§ 5.2, § 9.4). Il publie le nombre d'écritures d'une
génération, la longueur de sa charge et le compteur cumulé de scellements ; sur un volume de base de
données, cela dit quelque chose du rythme d'activité. Le chiffrer exigerait de choisir la racine qui
fait autorité **sans lire son en-tête**, ce que l'alternance rend impossible.

**Ce qui la ferait changer.** Une construction qui permettrait de départager deux racines sans lire
leurs en-têtes en clair, ou une mesure montrant que ce canal apprend, sur un usage réel, davantage
que « le volume a été écrit ».

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE sous condition.** « En-tête de racine en clair
: acceptable si la fuite du rythme d'activité est assumée. »

**Position RÉVISÉE du dépôt : inchangée, et la condition est tenue** — le § 5.2 et le § 9.4 écrivent
la fuite, ils ne la découvrent pas. **La v4 l'élargit d'un champ**, et il faut le dire : le second
compteur, `scellementsCumulesJournal`, publie en clair ce que le journal a consommé, séparément du
volume. Un observateur du support apprend donc désormais la part des dépôts dans l'activité, et non
plus seulement son total. C'est un élargissement assumé, écrit avec la décision qui l'apporte.

### Question n° 9 — Le rescellement du point de contrôle est-il au bon endroit ?

**Position du dépôt.** Oui, faute de mieux (§ 7.2). Passer du journal au volume exige de rescéller
chaque secteur sous un nonce neuf, donc de **déchiffrer puis rechiffrer** la charge validée : le
clair transite en mémoire, et le coût double pour les octets rangés. L'alternative — sceller au
format du volume dès le dépôt — obligerait le journal à n'accepter que des écritures alignées et
casserait « déposer = une écriture, une seule ».

**Ce qui la ferait changer.** Une construction qui éviterait le double scellement sans imposer
l'alignement au dépôt, ou une démonstration que le clair en mémoire pendant le rangement est une
exposition qualitativement pire que celle de la recopie qui existait déjà.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE, avec une exigence en plus.** « Rescellement
au point de contrôle : position raisonnable. L'état authentifié résultant doit cependant survivre à
l'export. »

**Position RÉVISÉE du dépôt : confirmée, et la phrase en plus est le CRITICAL.** « L'état
authentifié résultant doit survivre à l'export » est exactement ce que #181 montre qu'il ne fait pas
: la restauration retire journal et témoin, et l'ouverture suivante accepte l'absence de racine. Le
rescellement est au bon endroit ; ce qu'il produit ne traverse pas l'archive. C'est l'engagement de
#181 qui le fera traverser.

## 14. Ce que ce dossier ne prouve pas

- **UN CONSTAT DE LA REVUE EXTERNE RESTE OUVERT, et ce document décrit donc un format dont une
  propriété ne tient pas** (§ 9.7). [#182](https://github.com/pinfada/railsbox-vault/issues/182),
  HIGH : le budget de clé du § 4.5 n'est pas global à la clé, et la probabilité de collision de
  2^-35 qu'il publie n'est pas bornée par le mécanisme implémenté. Il est **reçu, reproduit et non
  corrigé** au 10 septembre 2026 ; sa correction est décidée par
  l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) et due avant la fermeture
  de #20.
- **Le CRITICAL est corrigé, et ce qu'il corrige a une borne.**
  [#181](https://github.com/pinfada/railsbox-vault/issues/181) est fermé par la
  [PR #184](https://github.com/pinfada/railsbox-vault/pull/184) : une archive porte un engagement
  scellé, et aucun volume légitime n'est sans racine. **Ce n'est pas la fermeture du § 9.1** : le
  rejeu d'une archive ENTIÈRE et cohérente reste indétectable, et l'ancrage monotone reste renvoyé à
  [#23](https://github.com/pinfada/railsbox-vault/issues/23). La propriété P5 du § 8 tient de
  nouveau pour un volume restauré ; elle ne tient toujours pas contre un support ramené en arrière
  tout entier.
- **Il ne prouve pas que le format est sûr.** Il décrit ce qu'il fait, ce qu'il ne fait pas, et sous
  quelles hypothèses. **Un relecteur l'a revu le 10 septembre 2026, et ce n'est pas un tiers au sens
  des gates** : une revue adverse assistée par un agent d'IA distinct des agents du dépôt, ni tiers
  humain ni cabinet indépendant. Que cela satisfasse la condition « tiers » est une décision du
  mainteneur, et elle n'est pas prise.
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
- **Le registre de la revue externe porte SIX lignes, dont UNE OUVERTE.** Quatre viennent d'une
  pré-revue interne traitée comme externe ; deux viennent de la revue du 10 septembre 2026, dont
  l'une est corrigée le jour même et l'autre est due. Voir
  [`docs/revue-externe/registre.md`](revue-externe/registre.md), le texte de la revue
  [`revue-2026-09-10.md`](revue-externe/revue-2026-09-10.md) et le
  [gabarit de constat](revue-externe/gabarit-de-constat.md).
- **Le gate « données sensibles » reste FERMÉ.** RailsBox Vault est expérimental et ne doit contenir
  aucune donnée réelle.
