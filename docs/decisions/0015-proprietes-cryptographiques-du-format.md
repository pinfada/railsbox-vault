# ADR 0015 — Cinq menaces, cinq propriétés : le format de volume les tient par un chiffrement authentifié par secteur et une racine qui scelle sa génération

- Statut : accepté
- Date : 2026-08-27
- Issue : #17 · Invariants : `SEC-BLOCK-001`, `SEC-GEN-001` · Jalon 4

> **Révisé le 2026-08-27, avant fusion.** Une revue de sécurité a réfuté PAR EXÉCUTION la
> justification centrale de la première version : le nonce y était dérivé de (génération, rang), et
> le chemin de reprise de `generation-store.mjs` le réémet — sans qu'aucune panne soit nécessaire.
> Le nonce est désormais TIRÉ AU HASARD. La section « Le nonce » porte la réfutation, sa
> reproduction et ce qu'elle change ; `tests/unit/vm-format-chiffre-reprise.test.mjs` la rejoue sur
> le magasin réel. Le défaut est conservé ici plutôt qu'effacé : il est la meilleure justification
> de la décision qui l'a remplacé.

## Contexte

Le jalon 4 s'ouvre sur un format qui existe déjà, entièrement EN CLAIR : un volume de blocs de 512
octets servi tel quel à v86, un manifeste voisin ([ADR 0007](0007-manifeste-de-volume.md), format
v2), une archive d'export ([ADR 0008](0008-format-d-archive-d-export.md)), et depuis #16 un journal
de génération validé par une racine d'un seul secteur
([ADR 0014](0014-generation-transactionnelle.md)).

`SECURITY.md` porte deux invariants qui n'ont, à ce jour, aucune définition opposable :
`SEC-BLOCK-001` — « un bloc est authentifié avec volume, adresse, format et génération » — et
`SEC-GEN-001` — « rejeu, troncature et mélange de générations sont refusés ». Le même document dit
déjà pourquoi ils ne se déduisent pas l'un de l'autre : « l'authentification indépendante de chaque
bloc ne protège pas à elle seule contre le rejeu d'un ancien bloc, le déplacement d'un bloc valide,
la troncature ou la restauration complète d'une ancienne génération ».

L'ADR 0014 a laissé la place explicitement : « la somme de contrôle est un CRC-32 […] elle ne
prétend RIEN contre un altérateur volontaire […] l'authentification d'un bloc (`SEC-BLOCK-001`, #18)
et le refus de rejeu (`SEC-GEN-001`, #19) sont du jalon 4. Ce format leur laisse la place — un
enregistrement porte déjà son offset et sa longueur, et la racine porte déjà un numéro de génération
—, il ne la prend pas. »

Cet ADR prend cette place. Il ne chiffre rien dans le produit.

## Ce que cet ADR fait, et ce qu'il ne fait pas

**Il fait** : il décide les primitives et leurs paramètres, il définit les cinq propriétés et écrit
pour chacune ce qu'elle NE garantit PAS et sur quelle hypothèse elle repose, il chiffre le coût en
espace et le MESURE en calcul, et il livre une **spécification exécutable** — un modèle de référence
pur (`src/vm/format-chiffre/`) et des vecteurs figés (`tests/vectors/format-chiffre-v1.json`) que
#18 et #19 devront reproduire octet pour octet. Il spécifie aussi le **rescellement du point de
contrôle**, sans lequel le passage du journal au volume n'était pas décrit.

Le rapport de ce modèle aux implémentations à venir est celui de l'oracle de #15 au magasin de #16 :
le juge est écrit avant, et séparément. L'ADR 0014 a montré ce que vaut cette séparation — un juge
écrit après coup avait cessé de mesurer quoi que ce soit, et seule une mutation l'avait révélé.

**Il ne fait pas** : aucun octet du produit ne change. Le backend de blocs, `generation-store.mjs`,
le manifeste, l'archive et les Workers du produit ne sont pas touchés. Aucun test VM ni Bout en bout
n'est ajouté, et c'est délibéré : il n'y a rien de nouveau à observer dans le produit.

Sont **hors périmètre** et le restent : les clés de déverrouillage, l'enveloppe DEK/KEK et la
dérivation (#21, jalon 5) ; le chiffrement du manifeste et de l'archive (question ouverte n° 6
ci-dessous, pas une décision de cet ADR) ; la revue externe (#20).

## Les primitives, décidées

### AEAD : AES-256-GCM, étiquette de 128 bits

**Décision.** `AES-GCM`, clé de 256 bits, nonce de 96 bits, étiquette de 128 bits, par
`crypto.subtle` de l'API Web Cryptography du W3C.

**Pourquoi celui-là.** C'est le seul chiffrement authentifié que la recommandation W3C _Web
Cryptography API_ rende disponible, et il l'est dans un Worker dédié — le contexte où vit le runtime
depuis l'ADR 0002. Les autres algorithmes de la recommandation ne sont pas des AEAD : `AES-CTR` et
`AES-CBC` ne fournissent aucune authenticité, `AES-KW` est un enveloppement de clé, `HMAC` seul
imposerait de composer chiffrement et MAC à la main — un assemblage dont l'histoire de la
cryptographie appliquée montre qu'il se rate plus souvent qu'il ne réussit.

Le choix de 256 bits plutôt que 128 est une marge, pas une nécessité démontrée : la mesure
ci-dessous montre que le coût est dominé par l'appel et non par le nombre de tours d'AES, si bien
que la marge est presque gratuite.

L'étiquette de 128 bits est le **maximum** admis par le § 5.2.1.2 de NIST SP 800-38D. La borne de
forgerie qui en découle est calculable, et elle vaut la peine d'être écrite plutôt que qualifiée :
le § 5.2.1.2 et l'annexe B (« Authentication Assurance ») majorent la probabilité qu'une tentative
de forgerie aboutisse par `(n + 1) / 2^t`, où `t` est la longueur d'étiquette et `n` le nombre de
blocs de 128 bits de l'entrée. Pour un scellement de 512 octets (32 blocs) et des données associées
de 122 octets (8 blocs), `n = 40`, d'où **environ 2^-122,6**. Ce n'est pas « nulle », et le mot «
jamais » n'apparaît donc nulle part dans les propriétés ci-dessous.

**Alternatives écartées, et ce qu'elles auraient apporté.**

| Candidat                           | Ce qu'il apporte                                                 | Pourquoi il est écarté                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AES-GCM-SIV** (RFC 8452)         | résistance à la RÉUTILISATION de nonce                           | absent de WebCrypto. Il faudrait une implémentation JS ou WebAssembly tierce, donc une dépendance nouvelle et son audit. Depuis que le nonce est TIRÉ, il n'est plus la condition de correction ; il reste le candidat le plus sérieux en défense en profondeur, et la question n° 1 pour #20. |
| **ChaCha20-Poly1305** (RFC 8439)   | pas de dépendance au matériel AES, marge sur les canaux de temps | absent de WebCrypto. Même coût de dépendance, pour un gain moindre que celui de GCM-SIV sur notre modèle de panne.                                                                                                                                                                             |
| **XChaCha20-Poly1305**             | nonce de 192 bits, tirable au hasard sans risque de collision    | absent de WebCrypto ET non normalisé par l'IETF. Deux raisons plutôt qu'une.                                                                                                                                                                                                                   |
| **HMAC-SHA-256 composé à la main** | disponible dans WebCrypto                                        | il faudrait décider l'ordre de composition, la séparation des clés et le format. Rien de tout cela n'est exigé par le résultat, et tout y est falsifiable en silence.                                                                                                                          |

La règle du dépôt sur les dépendances est celle du `CONTRIBUTING.md` : elle exige la même
justification écrite qu'une exclusion d'analyseur de secrets. Aucune des trois primitives absentes
de WebCrypto ne la franchit **aujourd'hui** ; la première pourrait la franchir demain, et la
question est posée à la revue externe plutôt que tranchée en silence.

### Le nonce : TIRÉ AU HASARD, et cette décision est une correction

**Décision.** Douze octets tirés de `crypto.getRandomValues` à chaque scellement, et **conservés**
avec l'objet scellé. C'est la construction fondée sur un générateur approuvé du § 8.2.2 de NIST SP
800-38D.

#### La première version de cet ADR se trompait, et une revue l'a réfutée PAR EXÉCUTION

Elle dérivait le nonce de `(domaine, génération, rang)` et justifiait son unicité ainsi : « une
reprise ouvre une génération NEUVE, donc elle ne peut pas réémettre un nonce déjà employé ». Cette
phrase était fausse contre `src/vm/generation-store.mjs`, et le constat n'est pas une lecture
pessimiste — il a été exécuté :

- la génération n'avance que dans `valider()` ;
- `#recuperer()` la remet à celle de la racine qui fait autorité ;
- `#vider()` incrémente la **séquence** et **conserve** la génération ;
- la branche « racines vierges au-dessus d'une charge » remet génération **et** séquence à **zéro**.

Or les octets sont scellés au **dépôt**, sous la génération en vol. Une génération déposée puis
écartée **rend son numéro** à la tentative suivante, et les rangs repartent de zéro parce que le
journal a été vidé. `tests/unit/vm-format-chiffre-reprise.test.mjs` rejoue deux variantes sur le
magasin réel ; toutes deux étaient rouges avant cette correction :

| Variante                                                   | Nonce réémis               |
| ---------------------------------------------------------- | -------------------------- |
| **Fermeture PROPRE** d'un onglet avec un dépôt non validé  | `010000000000020000000000` |
| Racines vierges au-dessus d'une charge (génération à zéro) | `010000000000010000000000` |

**La première ne demande aucune panne.** Fermer l'onglet proprement suffit. L'épreuve mesure aussi
le dommage exact plutôt que de l'invoquer : `C1 ⊕ C2 == P1 ⊕ P2`, c'est-à-dire la confidentialité
des deux écritures perdue par la seule observation du support — et, avec la clé d'authentification
`H`, la capacité de forger (SP 800-38D § 8.1 ; « forbidden attack », Joux 2006). P1, P2, P4 et P5
tomberaient alors sur **tout le volume**.

« Le point de contrôle finit par effacer le journal » ne sauve rien : l'exigence d'unicité du § 8.2
est **inconditionnelle**, et un adversaire qui détient le support — ou un simple instantané de
sauvegarde — garde les deux chiffrés.

#### La leçon, plus générale que le défaut

**Dans un système conçu pour survivre aux coupures et exposé au retour arrière du support, tout
nonce déterministe dérivé d'un état DURABLE — génération, séquence, « époque », compteur — est
réémis dès que cet état recule.** L'aléa est la seule construction dont l'unicité ne dépend d'aucun
état. C'est pourquoi le tirage n'est pas ici un choix de confort mais la condition de correction.

#### Deux réparations déterministes, examinées et écartées

1. **Sceller à la VALIDATION plutôt qu'au dépôt.** La génération serait alors connue et définitive
   au moment du scellement. Écarté pour deux raisons : le journal resterait **en clair** entre le
   dépôt et la barrière — inacceptable pour un volume chiffré, puisque c'est précisément là que
   vivent les écritures les plus récentes du guest —, et cela casserait « déposer = une écriture,
   une seule » de l'ADR 0014, dont tout le protocole des quatre gestes dépend.
2. **Un champ « tentative » durable, incrémenté à chaque reprise.** Il déplace le défaut sans le
   corriger : ce champ est un état durable de plus, et un retour arrière du support le fait reculer
   comme le reste. On aurait remplacé une dépendance à la génération par une dépendance à un
   compteur, avec le même point de rupture.

**AES-GCM-SIV n'est plus la condition de correction** — le tirage l'est —, mais il reste la question
n° 1 pour #20, en **défense en profondeur** : il rendrait une collision improbable non
catastrophique, là où GCM la rend fatale.

#### Ce que le domaine devient

Il **reste dans les données associées** (`railsbox-vault/format-chiffre/v1/bloc`, `.../racine`,
`.../entrees`), où il sépare les espaces sans consommer de bits de nonce.

#### Bornes, calculées

| Borne                                                   |                     Valeur | D'où elle vient                                                    |
| ------------------------------------------------------- | -------------------------: | ------------------------------------------------------------------ |
| Espace des nonces                                       |                       2^96 | douze octets tirés                                                 |
| Plafond d'invocations par clé, **NIST**                 |       2^32 = 4 294 967 296 | SP 800-38D § 8.3                                                   |
| **Budget retenu par ce dépôt**                          |   **2^31 = 2 147 483 648** | la moitié — voir ci-dessous                                        |
| Probabilité de collision au budget retenu               |      `N²/2^97` ≈ **2^-35** | 2^-33 au plafond NIST                                              |
| Octets scellés correspondants                           |                      1 Tio | 2^31 × 512 o                                                       |
| Réécritures complètes du volume applicatif de 512 Mio   |                  **2 048** | 2^31 ÷ 2^20 secteurs                                               |
| Générations de la taille mesurée par #16 (177 secteurs) |             ~12,1 millions | 2^31 ÷ 177                                                         |
| Générations représentables (champ d'identité)           | 2^48 = 281 474 976 710 656 | largeur du champ dans les données associées                        |
| Entrées par génération (champ d'identité)               |   2^40 = 1 099 511 627 776 | largeur du champ ; l'ADR 0014 en admet 131 072 (plafond de 64 Mio) |
| Clair par invocation                                    |   2^39 − 256 bits ≈ 64 Gio | SP 800-38D § 5.2.1.1 — jamais atteignable avec des secteurs        |

**Pourquoi la moitié du plafond NIST.** Le compteur cumulé est authentifié **dans la racine**, donc
il **recule** avec un retour arrière du support : le nombre réel d'invocations sous la clé peut
alors dépasser le nombre compté, d'un écart qu'aucune mesure ne borne aujourd'hui. Un budget serré
garde un ordre de grandeur de marge devant cet écart. `LIMITE_NIST_INVOCATIONS` publie le plafond à
côté du budget, pour que l'écart se lise plutôt que se devine — et c'est la **question n° 4 pour
#20**.

**Le budget est vérifié AU SCELLEMENT**, du côté du bloc comme du côté de la racine, et
`scellementsCumules` y est **obligatoire** : une première version affirmait le vérifier « à
l'ouverture d'une génération » alors qu'`ouvrirRacine` ne le vérifiait nulle part — trois textes
disaient ce que le code ne faisait pas. Le compteur inclut les **racines** : le § 8.3 compte « all
instances of the authenticated encryption function », et une racine en est une.

#### Ce que le tirage coûte

Deux choses, toutes deux mesurées plus bas : **douze octets stockés** par enregistrement de journal
et par secteur du volume, puisque le nonce n'est plus dérivable de rien ; et **environ 4 µs par
scellement** sous Chromium, l'écart entre 13,73 µs (nonce dérivé, première mesure) et 17,87 µs
(nonce tiré).

#### Deux obligations restent à l'appelant, et elles ne portent plus sur le nonce

Le tirage les a vidées de leur enjeu cryptographique, mais elles restent des propriétés du FORMAT,
et le modèle continue de les refuser :

1. **les rangs d'une génération croissent strictement.** Une racine scelle une **suite** ordonnée ;
2. **la séquence d'une racine croît strictement**, reprise après échec comprise. Deux racines
   authentiques de même séquence rendraient l'autorité **ambiguë** pour `#racineFaisantAutorite`,
   qui départage par la séquence la plus haute.

Le code de refus a été renommé pour cette raison : `VAULT_CRYPTO_NONCE_REUTILISE` est devenu
`VAULT_CRYPTO_ORDRE_INVALIDE`. Garder l'ancien nom aurait fait affirmer au modèle une conséquence
qu'il ne produit plus. **Le modèle ne sait d'ailleurs plus détecter une réutilisation de nonce** :
il est sans état, et l'unicité vient du tirage, pas d'un contrôle. Le dire est plus utile qu'un
contrôle qui rassurerait sans rien vérifier.

### Les données associées : l'identité logique complète, encodée de façon injective

**Décision.** Les données associées d'un bloc portent, dans cet ordre :

```text
  étiquette de domaine « railsbox-vault/format-chiffre/v1/bloc »   (préfixée de sa longueur)
  nom de l'algorithme  « aes-256-gcm »                             (préfixé de sa longueur)
  version du FORMAT DE VOLUME                                      (4 octets)
  identifiant du volume                                            (préfixé de sa longueur)
  génération                                                       (8 octets)
  rang de l'entrée                                                 (8 octets)
  adresse logique                                                  (8 octets)
  longueur                                                         (4 octets)
```

Chaque champ est de **largeur fixe ou préfixé de sa longueur**. Ce n'est pas une élégance : une
concaténation non préfixée permettrait de déplacer un caractère d'un champ à l'autre sans changer
les octets — donc de déplacer un bloc sans que l'étiquette bronche.
`tests/unit/vm-format-chiffre-identite.test.mjs` l'éprouve par **mutation** plutôt que par
affirmation : le même encodage privé de ses préfixes confond « ab » + « c » et « a » + « bc », et
l'encodage réel les sépare.

**La conversion de l'identifiant de volume est FIXÉE ici**, faute de quoi #18 ne pourrait pas
reproduire les vecteurs : le disque porte **seize octets bruts** (en-tête de racine v3, manifeste
v3), les données associées portent une **chaîne**, et deux conventions donneraient deux étiquettes
différentes pour le même volume. La forme retenue est l'**hexadécimal minuscule sans séparateur,
trente-deux caractères** — `identifiantVolumeEnTexte`, éprouvée sur un vecteur explicite.

Le **nom de l'algorithme** y figure pour l'agilité : sous une future version, un chiffré produit par
un algorithme ne pourra pas être réinterprété par l'autre.

**L'identifiant de volume n'existe pas encore, et c'est un constat de cet ADR.** Le manifeste v2
(ADR 0007) porte `app.id` — l'identité de l'APPLICATION, partagée par tous ses volumes —,
`identity.digest` — l'empreinte de l'état RESTAURÉ, nullable, et qui « n'atteste pas l'état courant
» (ADR 0009) — et une géométrie. Aucun champ ne distingue deux volumes de la même application. Le
format v3 devra donc en ajouter un : un identifiant **opaque, aléatoire, immuable, inscrit à la
création du volume**. Tant qu'il n'existe pas, la propriété P2 ci-dessous ne refuse un déplacement
inter-volumes que si les deux volumes portent des identifiants distincts — c'est-à-dire pas encore.
C'est du travail de #18, nommé ici plutôt que découvert là-bas.

### La racine : une empreinte de la SUITE des entrées, pas un arbre

**Décision.** La racine d'une génération est scellée ainsi :

- **données associées** = son en-tête : domaine, algorithme, version de format, identifiant de
  volume, séquence, génération, taille du volume, nombre d'entrées, longueur de charge, compteur
  cumulé de scellements ;
- **clair** = l'empreinte SHA-256 (32 octets) de l'encodage canonique de la **suite ordonnée** de
  ses entrées, chacune portant `adresse ‖ longueur ‖ rang ‖ étiquette du bloc scellé`.

**Pourquoi une liste et pas un arbre.** Un arbre de Merkle permettrait de vérifier une entrée sans
lire les autres. Ce bénéfice n'a **aucun consommateur ici** : l'ADR 0014 relit la charge validée
d'un seul tenant (`#relireCharge`) et la rejoue entière. Un arbre coûterait autant de hachages que
la liste, plus la gestion des nœuds, pour une capacité que personne n'exerce. La liste tient de
surcroît dans le secteur déjà alloué : la racine ne scelle que l'empreinte, la liste vit dans le
journal, d'où elle est reconstructible.

**Pourquoi l'étiquette du bloc et non son chiffré.** L'empreinte couvre l'ÉTIQUETTE. Sous une même
clé, un même nonce et une même identité, deux chiffrés distincts partageant une étiquette
constitueraient une forgerie GCM, bornée par 2^-122,6. La racine dit donc **quels** blocs composent
la génération ; chaque bloc dit qu'il est **intact**. Aucune des deux vérifications ne remplace
l'autre, et l'implémentation doit faire les deux.

**Pourquoi l'en-tête est les données associées et l'empreinte le clair**, et non l'inverse. Cet
ordre décide de ce que le modèle a le droit d'AFFIRMER. En vérifiant d'abord l'étiquette sur
l'en-tête, le lecteur obtient un en-tête **authentique** ; il peut alors comparer le nombre
d'entrées trouvées à celui que la racine déclare, et nommer une **troncature établie**. Dans l'autre
sens, « troncature » serait un diagnostic posé sur un en-tête que rien ne garantit — c'est-à-dire
une devinette. Le dépôt refuse ce genre de phrase depuis l'ADR 0014 (« tout doute est un refus »).

L'en-tête de racine reste **en clair sur le support**, et il faut dire ce qu'il révèle : le nombre
d'entrées d'une génération, la longueur de sa charge, le rang de la génération, la taille du volume
et le compteur cumulé de scellements. C'est un canal auxiliaire sur le VOLUME d'écriture. Il est
assumé et nommé ici ; le chiffrer exigerait de pouvoir choisir la racine qui fait autorité sans lire
son en-tête, ce que l'alternance de l'ADR 0014 rend impossible.

### Agilité : un seul algorithme admis, nommé dans le manifeste

**Décision.** La règle est celle que l'ADR 0011 a déjà posée pour l'empreinte, et elle s'applique
mot pour mot : l'algorithme est **épinglé**, pas « une chaîne non vide ». Le manifeste v3 nommera
`aes-256-gcm` dans un champ dédié ; le modèle refuse tout autre nom par
`VAULT_CRYPTO_ALGORITHME_INCONNU`. Accepter une autre étiquette la rendrait persistante sans
qu'aucun code ne l'honore — un volume affirmerait « chacha20-poly1305 » pendant que la vérification
présenterait un AES-GCM.

**Un second algorithme exigera une version de format et un ADR.** C'est le prix de l'agilité, et il
est plus honnête que le contraire : une négociation d'algorithme à l'exécution est un mécanisme de
rétrogradation dès qu'un attaquant peut écrire le champ qui la porte.

### La clé de volume : reçue, jamais dérivée ici

Le modèle reçoit **32 octets aléatoires en mémoire** et les importe dans WebCrypto en clé **non
extractible**. Ce que cela suppose, et qui relève de #21 :

1. que la clé est **aléatoire** et propre à CE volume — sans quoi P2 perd son second pilier : deux
   volumes partageant une clé ne seraient séparés que par leur identifiant dans les données
   associées ;
2. qu'elle est **remise** au Worker de confiance de l'ADR 0002, et n'existe nulle part ailleurs ;
3. que sa **durée de vie** est celle de la session déverrouillée. Rien ici ne l'efface, ne la
   verrouille ni ne la renouvelle ;
4. qu'un **changement de clé** (budget atteint, révocation) est possible — ce qui, en l'état,
   signifie rechiffrer le volume entier. Le coût est mesuré plus bas.

L'importation non extractible ne protège pas contre du code hostile déjà présent dans le Worker :
celui-ci s'en sert sans la lire. Elle réduit la surface d'exfiltration accidentelle, et elle est
gratuite.

## Cinq menaces, cinq propriétés

Chaque propriété est doublée d'un **témoin positif** dans
`tests/unit/vm-format-chiffre-modele.test.mjs`. Sans lui, un modèle qui refuserait tout passerait
pour sûr.

### P1 — Modification

**Propriété.** Pour une clé `K`, un sceau `(nonce, chiffré, étiquette)` et une identité `I`,
`ouvrirBloc` ne rend un clair que si l'étiquette AES-256-GCM vérifie sur `(chiffré, AAD(I))` sous
`K` et `nonce`. Toute altération d'un bit du chiffré, de l'étiquette ou du nonce est refusée.

**Ce qu'elle garantit.** Qu'une altération non détectée exige une forgerie GCM, de probabilité
majorée par ≈ 2^-122,6 par tentative. Le nonce entre dans le calcul de l'étiquette : l'altérer est
donc refusé comme le reste — mais depuis qu'il est tiré, il ne DÉCRIT plus rien, et un nonce altéré
ne se distingue plus d'un chiffré altéré. C'est une intégrité **authentifiée**, non un CRC : l'ADR
0014 disait déjà qu'un CRC-32 « ne prétend RIEN contre un altérateur volontaire, qui le
recalculerait sans difficulté ». Ici, le recalcul exige la clé.

**Ce qu'elle NE garantit PAS.** Rien contre un attaquant qui **détient la clé** : il forge à
volonté. Rien sur la **disponibilité** : effacer le volume reste possible et n'est pas une
modification détectable, c'est une perte. Rien sur les **canaux auxiliaires** : la taille du volume,
le nombre de secteurs écrits et le motif d'accès restent observables d'un support hostile, et un
secteur écrit deux fois est visible comme tel. Rien sur la **correction de l'implémentation
WebCrypto** du moteur, que ce dépôt ne peut pas auditer.

**Hypothèse.** AES-256-GCM est un AEAD sûr pour l'étiquette choisie ; `K` est inconnue de
l'adversaire ; l'implémentation du moteur est conforme.

### P2 — Déplacement

**Propriété.** Les données associées portent l'identité logique **complète** : identifiant de
volume, adresse logique, version de format, génération, rang, longueur, algorithme. Un bloc valide
relu à une autre adresse, dans un autre volume, sous une autre version de format ou une autre
génération est refusé. C'est la définition opposable de `SEC-BLOCK-001`.

**Ce qu'elle garantit.** Que le déplacement exige la même forgerie que P1. L'encodage étant injectif
(champs de largeur fixe ou préfixés), deux identités distinctes ne peuvent pas produire les mêmes
données associées.

**Ce qu'elle NE garantit PAS.** Elle ne dit pas **de quoi** le refus vient : modification et
déplacement sont **cryptographiquement indiscernables**, et le modèle refuse sans prétendre les
distinguer (`VAULT_CRYPTO_SCEAU_REFUSE`, qui nomme les deux menaces). Elle ne garantit pas l'unicité
ni l'authenticité de l'identifiant de volume, qui **n'existe pas encore** dans le manifeste v2 :
tant que #18 ne l'a pas ajouté, deux volumes de la même application ne sont séparés que par leur
clé. Elle ne dit rien de la **fraîcheur** : un bloc à la bonne adresse mais d'une génération
antérieure relève de P3.

**Hypothèse.** L'identifiant de volume est unique et immuable ; les clés de deux volumes sont
distinctes (#21).

### P3 — Rejeu

**Propriété.** La séquence et la génération sont authentifiées dans l'en-tête de la racine.
`ouvrirRacine` refuse une racine dont la séquence est **inférieure** au minimum que l'appelant
présente ; `ouvrirBloc` refuse un bloc dont la génération est inférieure à `generationMinimale`. Les
deux refus sont posés **après** la vérification de l'étiquette, donc sur des valeurs authentiques.

**Ce qu'elle garantit.** Qu'une racine ou un bloc d'une génération antérieure, réintroduits intacts,
sont refusés **dès lors que le minimum présenté est juste**. En session, ce minimum est la dernière
séquence que le processus a lui-même validée : un support qui échangerait des fichiers sous une
session ouverte est donc refusé.

**Ce qu'elle NE garantit PAS — et c'est le résidu le plus important de cet ADR.** Voir « Le retour
arrière » ci-dessous. Entre deux sessions, le minimum ne peut venir que du support lui-même ; un
support qui restitue un état antérieur COMPLET et COHÉRENT — volume, journal, racine, manifeste —
n'est pas distinguable d'un support qui n'a jamais avancé.

**Hypothèse.** La source du minimum de séquence est au moins aussi fiable que ce qu'on lui demande
de protéger.

### P4 — Troncature

**Propriété.** L'en-tête authentifié de la racine porte le **nombre d'entrées** et la **longueur de
charge** de sa génération. Une génération à laquelle il manque des entrées — ou à laquelle il en a
été ajouté — est refusée par `VAULT_CRYPTO_TRONCATURE`, sur un en-tête authentique.

**Ce qu'elle garantit.** Qu'une génération incomplète n'est jamais prise pour une génération plus
courte. Le compte et la longueur sont dérivés des entrées au moment de sceller, jamais reçus de
l'appelant : une racine qui annoncerait un compte différent de ce qu'elle scelle serait une
troncature signée par son propre producteur.

**Ce qu'elle NE garantit PAS.** La **suppression de la génération entière** avec sa racine, qui est
un retour arrière (P3) et non une troncature. Ni la troncature du VOLUME lui-même, hors journal : la
racine ne dit rien des secteurs qu'elle ne touche pas.

**Hypothèse.** La liste des entrées présentée au lecteur est celle qu'il a réellement trouvée sur le
support, et non une liste reconstruite à partir de l'en-tête.

### P5 — Mélange

**Propriété.** L'empreinte SHA-256 de la **suite ordonnée** des entrées est le clair scellé par la
racine. Un assemblage de blocs individuellement valides mais issus de générations différentes est
refusé par `VAULT_CRYPTO_MELANGE` — de même qu'un simple réordonnancement, car la racine scelle une
suite, pas un sac.

**Ce qu'elle garantit.** Que la génération est un TOUT. Substituer une entrée authentique d'une
autre génération change l'étiquette du bloc (les données associées portent une autre génération),
donc l'empreinte, donc le verdict.

**Ce qu'elle NE garantit PAS.** Rien sur le **volume** au-delà du journal. Après le point de
contrôle de l'ADR 0014, le volume porte légitimement des secteurs de générations différentes : c'est
son état normal, pas un mélange. Un secteur du volume ramené à une version antérieure — authentique,
à la bonne adresse, dans le bon volume, mais d'une génération plus ancienne — **n'est pas détecté**
par ce format. Voir le retour arrière.

**Hypothèse.** SHA-256 résiste à la seconde préimage ; deux étiquettes GCM distinctes ne
collisionnent pas sous la borne écrite plus haut.

## Le retour arrière, nommé

Trois formes, et elles ne se traitent pas de la même façon.

| Forme                                                               | Détectée ? | Par quoi                                                                                                               |
| ------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rejeu d'une racine ou d'un bloc antérieur **au sein d'une session** | oui        | P3, avec le minimum de séquence tenu en mémoire                                                                        |
| Retour arrière d'un **secteur** du volume                           | **non**    | rien : le lecteur lit la génération du secteur dans la région d'authentification voisine, au même endroit que le sceau |
| Retour arrière **complet** du support entre deux sessions           | **non**    | rien : l'état antérieur est cohérent et authentique                                                                    |

**Le retour arrière d'un secteur** mérite d'être expliqué, parce qu'il est contre-intuitif. Un
secteur relu du volume est ouvert sous une identité que le lecteur ne connaît pas d'avance : il lit
la **génération** dans la région d'authentification, juste à côté du nonce et de l'étiquette du même
secteur, reconstruit les données associées et vérifie. Le sceau et l'identité viennent donc **du
même endroit**. Un attaquant qui remet en place le quadruplet complet d'une version antérieure du
même secteur — chiffré, nonce, étiquette, génération — produit un ensemble cohérent, et le lecteur
l'accepte.

Le tirage du nonce n'y change rien, et il faut le dire : il garantit l'unicité, pas la fraîcheur. Un
sceau authentique d'hier reste authentique aujourd'hui.

Le remède connu est une **structure authentifiée à l'échelle du volume** — typiquement un arbre de
Merkle sur les 2^20 secteurs du volume applicatif, dont la racine serait scellée à chaque point de
contrôle. Son coût est calculable : 20 hachages par écriture pour mettre à jour un chemin, et un
état de 2^21 − 1 nœuds de 32 octets, soit 64 Mio, à tenir ou à relire. Ce n'est pas exigé par le
résultat de #17 ni par celui de #19 tel que l'issue le formule (« la racine authentifie l'ensemble
exact des blocs de SA génération »). **Ce n'est donc pas fourni ici, et c'est la question n° 2 pour
#20.**

**Le retour arrière complet** ne se traite pas par un format. Il exige un **point d'ancrage monotone
hors de portée de l'attaquant** : un compteur matériel, un témoin distant, ou un service tiers de
fraîcheur. Ni OPFS, ni IndexedDB, ni le stockage clé-valeur ne promettent la monotonie face à un
adversaire qui contrôle le profil.

**Un candidat existe et mérite d'être nommé plutôt que passé sous silence** :
`authenticatorData.signCount` de WebAuthn est un compteur monotone tenu par l'authentificateur. Il
ne suffit pas, et pour trois raisons cumulées : CTAP2 le rend **facultatif**, la plupart des
authentificateurs de plateforme (Touch ID, Windows Hello) rendent **zéro**, et l'employer
supposerait une décision de #21 sur le déverrouillage, qui n'est pas prise. Une piste
**best-effort** existe par ailleurs contre le retour arrière PARTIEL — conserver la dernière
séquence connue dans IndexedDB, hors du fichier de volume, pour qu'un support qui recule SEUL soit
détecté. Elle ne résiste pas à un adversaire qui recule les deux, et cet ADR ne l'exige pas.

Le retour arrière complet est donc **assumé**, et sa seule barrière est celle qui l'était déjà : le
partitionnement OPFS par origine de l'ADR 0002. Le dire est le minimum ; c'est la question n° 3 pour
#20.

## Coût

### Espace

| Objet                            |                                        Surcoût | Détail                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secteur du **volume**            |                    **34 o pour 512 → 6,641 %** | nonce 12 o + étiquette 16 o + **génération 6 o**. Le nonce est tiré donc stocké ; la génération l'est aussi, car le lecteur d'un secteur ne la connaît pas d'avance et les données associées l'exigent. |
| Enregistrement du **journal**    | ~~28 o pour 512 → 5,469 %~~ **34 o → 6,641 %** | nonce 12 o + étiquette 16 o + **génération 6 o**. Le chiffre de 28 supposait que la génération d'un enregistrement était celle de sa racine ; c'est faux, et l'amendement du 2026-08-28 dit pourquoi.   |
| **Racine** de génération         |                            **0 octet de plus** | l'en-tête passe de 60 à 136 octets dans le secteur DÉJÀ alloué par l'ADR 0014. Le CRC-32 disparaît, remplacé par l'étiquette.                                                                           |
| Volume applicatif de **512 Mio** |                                  **34,00 Mio** | 1 048 576 secteurs × 34 o = 35 651 584 o, soit exactement 69 632 secteurs                                                                                                                               |

L'en-tête de racine v3, détaillé, pour montrer qu'il tient : marqueur 8 + format du journal 4 +
taille de secteur 4 + séquence 8 + génération 8 + taille du volume 8 + nombre d'entrées 4 + longueur
de charge 8 + identifiant de volume 16 + scellements cumulés 8 + nonce 12 + chiffré (l'empreinte des
entrées) 32 + étiquette 16 = **136 octets** sur les 512 du secteur. La réserve de zéros que l'ADR
0014 décrit reste large.

**Pourquoi le volume stocke la génération et pas le journal.** Un enregistrement du journal est lu
dans le contexte de sa racine, qui nomme la génération, et sa position dans le journal donne son
rang. Un secteur du volume, lui, est lu **isolément** : le lecteur connaît son adresse et rien
d'autre. Comme les données associées portent la génération — c'est `SEC-BLOCK-001` —, il faut la lui
donner. Six octets, la largeur du champ. Le rang, lui, est **épinglé à zéro** par le format pour un
secteur du volume (`RANG_SECTEUR_DE_VOLUME`) : un secteur ne porte qu'une version par génération, le
rang n'y ajoute rien, et le fixer évite cinq octets de plus.

### Où ces octets vivront : un format de volume v3

**Décision de disposition** : une **région d'authentification dédiée**, en tête du fichier de
volume, alignée sur le secteur, portant **34 octets** par secteur logique — nonce 12, étiquette 16,
génération 6. Le fichier devient :

```text
[ en-tête v3, 1 secteur ][ région d'authentification, 69 632 secteurs ][ charge chiffrée, 1 048 576 secteurs ]
```

**Pourquoi cette disposition plutôt que l'entrelacement.** Entrelacer (chaque secteur logique
occupant 540 octets sur le support) casserait l'alignement sur 512 et sur la page hôte de 4 096
octets, donc la géométrie que `block-geometry.mjs` impose et que le point de contrôle de l'ADR 0014
exploite pour recopier des secteurs alignés. La région dédiée confine le changement à un préambule.

**Pourquoi dans le FICHIER du volume et non dans un quatrième voisin.** Un voisin `<volume>.auth`
ajouterait un problème d'atomicité entre deux fichiers là où il n'y en a pas : un handle, une
barrière, un fichier.

**Ce que ça coûte en lecture.** Lire un secteur exige ses 34 octets de métadonnées, donc une lecture
de plus. Une page hôte de 4 096 octets de la région porte les métadonnées de 120 secteurs
consécutifs (60 Kio de charge) : le surcoût est d'une lecture par ~120 secteurs en accès séquentiel,
et d'une lecture par secteur en accès aléatoire.

**Un secteur « jamais écrit » ne peut pas exister en v3.** Si la région d'authentification était à
zéro pour un secteur vierge, un attaquant n'aurait qu'à zéroter ces 28 octets pour faire lire un
secteur comme blanc. La préparation d'un volume et la restauration (les chemins
`transactionnel: false` de l'ADR 0014) devront donc **sceller tous les secteurs**, y compris ceux
qui ne portent que des zéros. Le coût est mesuré ci-dessous.

### Le point de contrôle RESCELLE, secteur par secteur

Ce geste manquait à la première version de cet ADR, et une revue l'a relevé : le coût était chiffré
par enregistrement et par secteur sans que rien ne dise ce que le point de contrôle fait des
enregistrements **multi-secteurs**.

Le journal scelle des **enregistrements**, dont la longueur est celle de l'écriture du guest et peut
couvrir plusieurs secteurs (`generation-store.mjs`, `deposer`). Le volume, lui, est adressé **au
secteur** et doit pouvoir être relu secteur par secteur. Une étiquette par enregistrement
obligerait, pour vérifier un seul secteur du volume, à relire tout l'enregistrement dont il vient —
et d'abord à le RETROUVER, ce que le volume ne sait pas faire : après le rangement, un secteur ne
porte plus trace de l'enregistrement qui l'a produit.

**Décision : le point de contrôle rescelle, un secteur à la fois, avec un nonce NEUF par secteur**
(`rescellerEnSecteurs`). Trois conséquences, toutes assumées :

1. **le clair transite en mémoire** entre l'ouverture de l'enregistrement et le scellement des
   secteurs. C'est déjà le cas de la recopie de l'ADR 0014, qui relit la charge et l'écrit dans le
   volume ; le chiffrement n'ajoute pas d'exposition nouvelle, il ajoute du calcul ;
2. **les octets rangés sont scellés deux fois** — une fois au dépôt, au format du journal, une fois
   au rangement, au format du volume. Le coût est celui d'un scellement de plus par secteur rangé,
   soit 17,87 µs mesurés, et il tombe sur le geste amorti de l'ADR 0014, pas sur la barrière ;
3. **un enregistrement non aligné sur un secteur est REFUSÉ** par le modèle plutôt que complété. Le
   compléter exigerait de LIRE le volume — donc d'ouvrir les secteurs voisins —, ce qui n'est pas le
   travail d'un module pur. L'appelant (#18) fait cette lecture-modification-réécriture avant
   d'appeler, comme `deposer` le fait déjà côté journal pour la même raison.

Le rang d'un secteur du volume est **épinglé à zéro** par le format (`RANG_SECTEUR_DE_VOLUME`) : un
secteur ne porte qu'une version par génération, le rang n'y ajoute rien, et le fixer évite de le
stocker.

**Impacts listés, aucun ADR modifié :**

| ADR                  | Ce que v3 lui impose                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0007** (manifeste) | un **identifiant de volume** obligatoire, opaque et immuable, qui n'existe pas en v2 ; un champ nommant l'algorithme ; `MANIFEST_FORMAT_VERSION` à 3 et `MIN_WRITER_FORMAT_VERSION` déplacé — un runtime v2 ne peut pas écrire un v3.                                                                                                                                                                  |
| **0008** (archive)   | `content.length` et `identity.digest` portent aujourd'hui sur un fichier qui EST l'image du disque. En v3 il ne l'est plus. Reste à trancher : l'archive porte-t-elle le fichier v3 tel quel (chiffré, donc non restaurable sans la clé) ou une image déchiffrée ? **Question n° 6.**                                                                                                                  |
| **0011** (migration) | une étape v2 → v3 qui **rechiffre le volume entier**, sous l'atomicité de l'ADR 0011 (manifeste révoqué, puis réinscrit après relecture). Coût mesuré ci-dessous.                                                                                                                                                                                                                                      |
| **0014** (journal)   | le CRC-32 de la racine remplacé par l'étiquette ; l'enregistrement grossit de **28 octets** (nonce 12 + étiquette 16) ; l'en-tête de racine passe de 60 à 136 octets dans le même secteur ; le point de contrôle **rescelle** (voir ci-dessus) ; les quatre issues de la récupération sont inchangées, leurs raisons `VAULT_CRYPTO_*` se mappant sur les codes `VAULT_STORAGE_GENERATION_*` existants. |

### Calcul, mesuré

`node tools/mesurer-scellement.mjs --navigateur --essais=5`, relevé du **2026-08-27** sur la machine
de développement (Windows 11, Intel i7-14700HX, 28 cœurs logiques, Node 24.14.0, Chromium 151 par
Playwright). **Ce n'est pas l'environnement de référence** de `docs/quality-attributes.md` (4 cœurs,
16 Gio, dix essais) : ces chiffres valent comme ordre de grandeur mesuré, pas comme relevé de
référence. Lot de 4 Mio, 8 192 blocs de 512 octets, cinq essais, **nonce tiré**.

| Moteur                   | Sceller un bloc | Ouvrir un bloc | Débit par blocs |    4 Mio en UN appel |
| ------------------------ | --------------: | -------------: | --------------: | -------------------: |
| **Chromium 151, Worker** |    **17,87 µs** |   **13,50 µs** |      27,3 Mio/s |   4,5 ms → 889 Mio/s |
| Node 24.14               |        50,45 µs |       48,19 µs |       8,1 Mio/s | 3,2 ms → 1 268 Mio/s |

**Le résultat qui décide n'est pas le débit d'AES, c'est le coût par APPEL.** Les mêmes 4 Mio
coûtent 146,4 ms en 8 192 appels contre 4,5 ms en un seul, soit un facteur **32,5** qui n'est pas
imputable au chiffrement : le coût fixe d'un appel à `crypto.subtle` vaut ≈ 17,3 µs, contre ≈ 0,5 µs
de calcul pour 512 octets. Et Node est **2,8 fois plus lent par appel** que Chromium : sa mesure ne
peut pas se substituer à celle du navigateur, ce qui justifie d'avoir monté le banc dans un vrai
Worker.

Le tirage du nonce coûte **≈ 4 µs par scellement** : c'est l'écart entre les 13,73 µs de la première
mesure (nonce dérivé) et les 17,87 µs d'aujourd'hui. L'ouverture, elle, ne tire rien et reste à
13,50 µs.

**Rapporté aux budgets de `docs/quality-attributes.md`** — toujours avec les chiffres de Chromium :

| Geste                                                                   | Coût de scellement |                                                                                               Rapporté à |
| ----------------------------------------------------------------------- | -----------------: | -------------------------------------------------------------------------------------------------------: |
| Boot Rails mesuré par #16 (285 lectures + 13 écritures)                 |         **4,1 ms** |                                                                  ~92 s de boot → **0,004 %**. Invisible. |
| Une génération de la taille mesurée par #16 (90 304 o, 177 secteurs)    |         **3,2 ms** |                                                                         s'ajoute à une barrière du guest |
| Récupération d'une génération au plafond de 64 Mio                      |          **1,8 s** | budget « dernière génération valide trouvée en ≤ 60 s » — tenu avec plus d'un ordre de grandeur de marge |
| Création ou restauration d'un volume de 512 Mio (tous secteurs scellés) |         **18,7 s** |                                             s'ajoute à la préparation d'image et à la restauration (#12) |
| Migration v2 → v3 d'un volume de 512 Mio                                |         **18,7 s** |                                                 à comparer au boot après migration mesuré à ~105 s (#74) |
| Lecture du volume entier (export #11, si l'archive est en clair)        |         **14,2 s** |                                                l'export n'a pas de budget de temps ; il en aurait besoin |

**Aucune ligne n'est ajoutée au tableau des budgets.** L'ADR 0014 a posé la règle et elle vaut ici :
« un seuil posé sans mesure opposable serait une promesse, pas un budget ». Ces chiffres sont des
mesures, pas des seuils, et ils sont pris sur une machine qui n'est pas l'environnement de
référence.

**Ce que la mesure n'établit pas.** Elle porte sur un seul moteur et une seule machine ; Firefox et
WebKit ne sont pas mesurés. Elle mesure le CPU du scellement, pas l'effet sur le rythme de
l'émulateur ni sur les E/S — `test:rythme` ne saurait pas plus conclure ici qu'il ne le savait pour
#16, et cette tranche ne le fait donc pas mentir en l'invoquant. Et elle ne dit rien de la
consommation mémoire du scellement en volume.

## La spécification exécutable

| Fichier                                         | Ce qu'il porte                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/vm/format-chiffre/identite-logique.mjs`    | nonce, données associées, encodage canonique des entrées, bornes, budget de clé     |
| `src/vm/format-chiffre/modele-reference.mjs`    | `scellerBloc`, `ouvrirBloc`, `scellerRacine`, `ouvrirRacine`, `rescellerEnSecteurs` |
| `src/vm/format-chiffre/crypto-errors.mjs`       | famille `VAULT_CRYPTO_*`, chacune nommant les menaces qu'elle couvre                |
| `src/vm/format-chiffre/octets.mjs`              | hexadécimal, concaténation, comparaison à temps constant, entiers gros-boutistes    |
| `tests/vectors/format-chiffre-v1.json`          | **cinq blocs et deux racines figés**, avec clé de TEST publique et sans entropie    |
| `tools/figer-vecteurs-scellement.mjs`           | produit les vecteurs depuis le modèle                                               |
| `tools/mesurer-scellement.mjs`                  | le banc de mesure, sous Node et dans un Worker de Chromium                          |
| `tests/unit/vm-format-chiffre-reprise.test.mjs` | la réfutation du nonce dérivé, rejouée sur le magasin RÉEL de l'ADR 0014            |

**Les vecteurs sont un contrat, pas une commodité.** Les régénérer après avoir modifié le modèle ne
corrige rien : c'est un changement de format persistant, qui exige une version et un ADR. Que
l'épreuve sache rougir a été vérifié par **mutation** plutôt que supposé : deux mutations du modèle
— l'étiquette de domaine du bloc, puis celle de la liste d'entrées — font tomber 2 épreuves sur 7 du
fichier de vecteurs, chacune sur une moitié différente.

Les cinq blocs figés couvrent les axes de l'identité plutôt que de faire nombre : un secteur
ordinaire, **la même adresse réécrite dans la même génération** (le cas que le nonce doit traiter),
une adresse voisine, une génération suivante à une adresse déjà écrite, et une écriture courte non
alignée sur un secteur.

## Questions ouvertes pour la revue externe (#20)

1. **AES-GCM-SIV vaut-il sa dépendance, en défense en profondeur ?** Le tirage du nonce est
   désormais la condition de correction, et GCM-SIV n'en est plus une. Il rendrait cependant une
   collision improbable **non catastrophique**, là où GCM la rend fatale. Le coût est une
   implémentation JS ou WebAssembly tierce et son audit. Est-ce le bon échange pour un format de
   stockage local ?
2. **Faut-il un arbre de Merkle sur le volume ?** Le retour arrière d'un SECTEUR n'est pas détecté.
   Le remède coûte 20 hachages par écriture et 64 Mio d'état pour un volume de 512 Mio. Est-ce
   proportionné à un modèle de menace où l'adversaire écrit dans l'OPFS de l'origine de confiance —
   c'est-à-dire où il a déjà franchi la frontière de l'ADR 0002 ?
3. **Existe-t-il un ancrage monotone acceptable dans un navigateur ?** Le retour arrière complet du
   support est assumé. Le seul compteur monotone qu'une API de navigateur expose est
   `authenticatorData.signCount` de WebAuthn — et il ne suffit pas : CTAP2 le rend **facultatif**,
   la plupart des authentificateurs de plateforme (Touch ID, Windows Hello) rendent **zéro**, et son
   emploi supposerait une décision de #21 sur le déverrouillage. Une piste **best-effort** existe
   contre le retour arrière PARTIEL : conserver la dernière séquence connue dans IndexedDB, hors du
   fichier de volume, pour qu'un support qui recule seul soit détecté. Elle ne résiste pas à un
   adversaire qui recule les deux, et cet ADR ne l'exige pas. Un témoin distant optionnel
   changerait-il utilement le modèle, ou déplacerait-il seulement la confiance ?
4. **Le budget de scellements est-il au bon endroit, et 2^31 est-il la bonne valeur ?** Le compteur
   est authentifié dans la racine, donc protégé contre la falsification mais soumis au retour
   arrière : un support qui recule fait re-parcourir des scellements déjà comptés, et le nombre réel
   d'invocations sous la clé dépasse alors le nombre compté d'un écart qu'aucune mesure ne borne. La
   moitié du plafond NIST est une marge choisie, pas calculée. La même question vaut pour la stricte
   croissance de la SÉQUENCE d'une racine, que le modèle ne peut vérifier que si l'appelant lui
   présente la valeur précédente.
5. **Le lot par appel est-il le bon découpage ?** Sceller 512 octets à la fois coûte 32,5 fois plus
   cher que sceller 4 Mio d'un coup. Pour le JOURNAL — rejoué d'un seul tenant — un scellement par
   génération serait défendable ; pour le VOLUME, il détruirait l'accès aléatoire et ferait perdre
   toute une génération sur une erreur d'un bit. Y a-t-il un découpage intermédiaire raisonnable
   (page hôte de 4 Kio, groupe de 8 secteurs) et que coûte-t-il en granularité de refus ?
6. **Le manifeste et l'archive doivent-ils être chiffrés ?** Cet ADR ne le décide pas. Le manifeste
   porte une identité, pas des données ; l'archive porte le volume entier. Une archive chiffrée
   n'est restaurable qu'avec la clé — ce qui change la nature de la sauvegarde (#12) et de la
   récupération (#23). Une archive en clair annule le chiffrement au repos dès qu'elle quitte
   l'appareil.
7. **Un lecteur peut-il distinguer un secteur jamais écrit d'un secteur effacé ?** La réponse
   retenue est « il n'y a pas de secteur jamais écrit en v3 », au prix de 18,7 s de scellement à la
   création. Est-ce le bon compromis, ou faut-il un marquage authentifié des plages non initialisées
   ?
8. **L'en-tête de racine en clair est-il acceptable ?** Il publie le nombre d'écritures d'une
   génération, la longueur de sa charge et le compteur cumulé de scellements. Sur un volume de base
   de données, cela dit quelque chose du rythme d'activité. Faut-il l'atténuer (rembourrage,
   granularité) ou l'assumer ?
9. **Le rescellement du point de contrôle est-il au bon endroit ?** Passer du journal au volume
   exige de rescéller chaque secteur sous un nonce neuf, donc de DÉCHIFFRER puis RECHIFFRER la
   charge validée — le clair transite en mémoire, et le coût double pour les octets rangés.
   L'alternative serait de sceller au format du volume dès le dépôt, ce qui obligerait le journal à
   n'accepter que des écritures alignées. Laquelle est la moins mauvaise ?

## Limites

1. **Rien de tout ceci n'est exercé par le produit.** `SEC-BLOCK-001` et `SEC-GEN-001` reçoivent ici
   leur définition et leurs vecteurs ; aucun chemin d'écriture ni de lecture du produit ne les
   appelle. Ils le seront par #18 et #19, et `SECURITY.md` le dit désormais explicitement.
2. **Le retour arrière d'un secteur et le retour arrière complet ne sont pas détectés.** Voir la
   section qui leur est consacrée. Ce ne sont pas des trous découverts après coup : ce sont les
   limites du périmètre, écrites.
3. **L'identifiant de volume n'existe pas encore.** P2 est donc incomplète tant que #18 n'a pas
   ajouté le champ au manifeste v3.
4. **La mesure porte sur un moteur et une machine.** Chromium 151 sur une machine de développement à
   28 cœurs. Firefox et WebKit ne sont pas mesurés ; l'environnement de référence non plus.
5. **Aucun audit de l'implémentation WebCrypto.** Le dépôt ne peut pas auditer BoringSSL ni NSS.
   `SECURITY.md` exige déjà un « audit externe du format cryptographique avant toute promesse de
   production » — c'est #20, et cet ADR lui fournit sa liste de questions.
6. **Le modèle n'a aucune borne mémoire.** Il travaille sur des structures en mémoire, sans
   streaming. Une implémentation qui rejouerait une génération de 64 Mio devra régler ce point
   elle-même, comme l'issue **#91** le demande déjà pour la récupération.
7. **Le modèle ne peut pas détecter une réutilisation de nonce.** Il est sans état : l'unicité vient
   du tirage, pas d'un contrôle. C'est un changement de nature par rapport à la première version,
   qui prétendait la vérifier — et se trompait.
8. **La stricte croissance de la séquence n'est vérifiable que si l'appelant présente la valeur
   précédente.** Faiblesse nommée, pas garantie. Et `generation-store.mjs` porte un cas voisin :
   `#racineFaisantAutorite` IGNORE la séquence d'une racine abîmée, si bien que deux reprises
   successives peuvent réécrire une racine sous la même (génération, séquence). Sans effet sur la
   confidentialité depuis que le nonce est tiré — il fallait le dire quand même, parce que
   l'autorité à la reprise en dépend, et parce que ce cas aurait été FATAL sous la version
   précédente.

## Ce qui est explicitement réservé

- **L'implémentation dans le backend de blocs** : #18 (bloc authentifié) et #19 (rejeu, troncature,
  mélange). Les vecteurs de cette tranche sont leur critère.
- **Les clés de déverrouillage, l'enveloppe DEK/KEK et la dérivation** : #21, jalon 5. Cet ADR
  suppose une clé de volume aléatoire remise en mémoire, et écrit les quatre choses que cela
  suppose.
- **La récupération et la révocation** : #22, #23.
- **Le chiffrement du manifeste et de l'archive** : question ouverte n° 6, pas une décision.
- **La rotation de clé** au-delà du constat qu'elle exige de rechiffrer le volume, et de sa mesure.

## Alternatives rejetées

- **Un nonce DÉTERMINISTE dérivé de (génération, rang).** C'est ce que cet ADR décidait d'abord, et
  c'est **réfuté par exécution** : voir la section du nonce. Le défaut n'est pas propre à ce choix
  de champs — il vaut pour tout état durable, puisque tout état durable recule.
- **Un nonce construit sur (génération, adresse).** Écarté pour une raison de plus, antérieure :
  l'ADR 0014 autorise la réécriture d'un même bloc dans une même génération, et un tel nonce s'y
  répéterait immédiatement.
- **Un compteur global de nonces tiré d'un état durable.** Forme canonique du § 8.2.1 de SP 800-38D,
  écartée pour la même raison que les deux précédentes : un compteur qui recule est un nonce réémis,
  et l'ADR 0014 existe précisément pour survivre à des coupures qui font reculer des états.
- **Sceller à la VALIDATION plutôt qu'au dépôt.** Le journal resterait en clair jusqu'à la barrière,
  ce qui est inacceptable pour un volume chiffré, et cela casserait « déposer = une écriture, une
  seule » de l'ADR 0014.
- **Un champ « tentative » durable.** Déplace le défaut au lieu de le corriger : c'est un état
  durable de plus, qui recule comme les autres.
- **Un arbre de Merkle pour la racine d'une génération.** Rejeté ici : son seul bénéfice, la
  vérification partielle, n'a aucun consommateur, puisque la charge validée est relue et rejouée
  d'un seul tenant (ADR 0014). Il reste le candidat pour le VOLUME, où le problème est différent
  (question n° 2).
- **Sceller une génération entière en un seul appel.** 32,5 fois moins cher, et c'est réel. Rejeté
  pour le VOLUME : il n'y aurait plus d'accès aléatoire, et une erreur d'un bit ferait perdre toute
  la génération au lieu d'un secteur. Reste ouvert pour le JOURNAL (question n° 5).
- **Une étiquette par ENREGISTREMENT dans le volume.** Rejeté : un enregistrement du journal a la
  longueur de l'écriture du guest et peut couvrir plusieurs secteurs, alors que le volume est
  adressé au secteur. Vérifier un secteur obligerait à relire tout l'enregistrement — et à le
  retrouver, ce que le volume ne sait pas faire. D'où `rescellerEnSecteurs`.
- **Entrelacer étiquette et nonce avec chaque secteur (546 octets par secteur).** Rejeté : casse
  l'alignement sur 512 et sur la page hôte, donc la géométrie de `block-geometry.mjs` et la recopie
  alignée du point de contrôle.
- **Un quatrième fichier voisin `<volume>.auth`.** Rejeté : introduit un problème d'atomicité entre
  deux fichiers là où un seul handle et une seule barrière suffisent.
- **Négocier l'algorithme à l'exécution.** Rejeté : c'est un mécanisme de rétrogradation dès qu'un
  attaquant peut écrire le champ qui le porte. L'agilité passe par une version de format et un ADR,
  comme l'ADR 0011 l'a décidé pour l'empreinte.
- **Prétendre distinguer modification et déplacement.** Rejeté : ils sont indiscernables sous GCM.
  Le modèle refuse et le dit ; un diagnostic inventé serait pire qu'un refus honnête.
- **Garder le code `VAULT_CRYPTO_NONCE_REUTILISE`.** Rejeté : depuis le tirage, un rang répété ne
  réémet plus de nonce. Le nom aurait fait affirmer au modèle une conséquence qu'il ne produit plus.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

1. la revue externe (#20) conclut que le nonce déterministe est trop fragile face au modèle de panne
   de l'ADR 0014, auquel cas AES-GCM-SIV redevient le candidat, avec sa dépendance et son audit
   assumés ;
2. le retour arrière d'un secteur est jugé dans le périmètre, auquel cas un arbre de Merkle sur le
   volume devient nécessaire, avec son coût de 64 Mio d'état et 20 hachages par écriture ;
3. une mesure sur l'environnement de référence montre que les 14,4 s de scellement d'une création de
   volume, ou les 2,4 ms par barrière, dégradent un budget publié au-delà du bruit ;
4. un second algorithme devient nécessaire (dépréciation d'AES-GCM, exigence réglementaire), auquel
   cas la règle d'agilité s'applique : version de format, ADR, et vecteurs pour les deux ;
5. WebCrypto acquiert un AEAD résistant à la réutilisation de nonce, ce qui retirerait à la question
   n° 1 son coût de dépendance ;
6. une mesure établit l'écart entre le compteur de scellements et le nombre réel d'invocations sous
   une clé, ce qui permettrait de fixer le budget par le calcul plutôt que par une marge choisie ;
7. `crypto.getRandomValues` se révèle indisponible ou dégradé dans un contexte visé — auquel cas ce
   n'est pas le format qu'il faut réviser, c'est le contexte qu'il faut refuser, comme
   `VAULT_RUNTIME_*` refuse déjà un moteur incapable d'exécuter le runtime.

## Amendement du 2026-08-28 — le sceau d'un enregistrement fait 34 octets, pas 28 (#18)

Cet amendement ne révise aucune décision de cet ADR. Les primitives, les données associées et les
cinq propriétés sont inchangées, et les vecteurs figés le restent à l'octet. Il corrige **un
chiffre** du tableau des coûts, et la supposition qui l'avait produit.

Le tableau annonçait **28 octets** de surcoût par enregistrement du journal — nonce 12 + étiquette
16 —, au motif que « la génération y est celle de la racine […] ni l'une ni l'autre n'est stockée ».
La mise en œuvre de #18 a montré que c'est faux : **le journal n'est vidé qu'au point de contrôle**,
si bien qu'une charge validée porte des enregistrements de PLUSIEURS générations. La génération d'un
enregistrement n'est donc pas déductible de la racine qui le valide ; il faut la lire pour composer
les données associées, donc la stocker.

Le sceau d'un enregistrement a par conséquent **la même forme que celui d'un secteur du volume** —
nonce 12 + étiquette 16 + génération 6 = **34 octets**, soit **6,641 %** pour 512 octets et non
5,469 %. `SCEAU_OCTETS` est unique pour les deux, ce qui vaut mieux que deux formes à un champ près.

**Ce que l'écart coûte réellement.** Il porte sur le JOURNAL, dont la charge est plafonnée à 16 Mio
depuis #91, et non sur le volume : au plafond, six octets de plus par enregistrement de 512 octets
font 192 Kio, sur un fichier voisin qui est vidé à chaque point de contrôle. Le surcoût du VOLUME —
34,00 Mio pour 512 Mio, soit 6,641 % — était juste et ne bouge pas.

**Pourquoi cette correction arrive par un amendement et non par une réécriture.** Le chiffre de 28
n'était pas une faute de calcul : c'était une conclusion tirée d'une hypothèse sur le cycle de vie
du journal qui n'avait pas été confrontée à l'ADR 0014. La conserver, barrée, dit à un lecteur futur
où la spécification et la mise en œuvre ont divergé, et pourquoi — ce qu'un chiffre corrigé en
silence n'aurait pas dit.

La décision correspondante est celle de l'[ADR 0016](0016-format-de-volume-v3-dispositions.md), et
`docs/quality-attributes.md` porte le chiffre corrigé.
