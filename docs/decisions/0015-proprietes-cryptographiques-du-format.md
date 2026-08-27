# ADR 0015 — Cinq menaces, cinq propriétés : le format de volume les tient par un chiffrement authentifié par secteur et une racine qui scelle sa génération

- Statut : accepté
- Date : 2026-08-27
- Issue : #17 · Invariants : `SEC-BLOCK-001`, `SEC-GEN-001` · Jalon 4

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
#18 et #19 devront reproduire octet pour octet.

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
forgerie qui en découle est calculable et vaut la peine d'être écrite plutôt que qualifiée : pour un
scellement de 512 octets (32 blocs de 128 bits) et des données associées de 122 octets (8 blocs), la
probabilité qu'une tentative de forgerie aboutisse est majorée par `(n + 1) / 2^128` avec `n = 40`,
soit **environ 2^-122,6**. Ce n'est pas « nulle », et le mot « jamais » n'apparaît donc nulle part
dans les propriétés ci-dessous.

**Alternatives écartées, et ce qu'elles auraient apporté.**

| Candidat                           | Ce qu'il apporte                                                 | Pourquoi il est écarté                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AES-GCM-SIV** (RFC 8452)         | résistance à la RÉUTILISATION de nonce                           | absent de WebCrypto. Il faudrait une implémentation JS ou WebAssembly tierce, donc une dépendance nouvelle et son audit. C'est le candidat le plus SÉRIEUX, et il devient la question n° 1 pour #20. |
| **ChaCha20-Poly1305** (RFC 8439)   | pas de dépendance au matériel AES, marge sur les canaux de temps | absent de WebCrypto. Même coût de dépendance, pour un gain moindre que celui de GCM-SIV sur notre modèle de panne.                                                                                   |
| **XChaCha20-Poly1305**             | nonce de 192 bits, tirable au hasard sans risque de collision    | absent de WebCrypto ET non normalisé par l'IETF. Deux raisons plutôt qu'une.                                                                                                                         |
| **HMAC-SHA-256 composé à la main** | disponible dans WebCrypto                                        | il faudrait décider l'ordre de composition, la séparation des clés et le format. Rien de tout cela n'est exigé par le résultat, et tout y est falsifiable en silence.                                |

La règle du dépôt sur les dépendances est celle du `CONTRIBUTING.md` : elle exige la même
justification écrite qu'une exclusion d'analyseur de secrets. Aucune des trois primitives absentes
de WebCrypto ne la franchit **aujourd'hui** ; la première pourrait la franchir demain, et la
question est posée à la revue externe plutôt que tranchée en silence.

### Le nonce : déterministe, dérivé, et sans l'adresse

**Décision.** Douze octets, gros-boutistes :

```text
  octet 0      domaine     0x01 bloc, 0x02 racine
  octets 1-6   génération  48 bits
  octets 7-11  rang        40 bits   (pour une racine : sa SÉQUENCE)
```

**Le choix qui compte est l'absence de l'adresse.** L'ADR 0014 admet qu'un même bloc soit réécrit
plusieurs fois DANS UNE MÊME GÉNÉRATION — c'est ce que l'index en mémoire du journal permet, et un
guest qui ne se relirait pas ne monterait aucun système de fichiers. Un nonce construit sur
(génération, adresse) se répéterait donc sur des clairs DIFFÉRENTS. Sous GCM, c'est la faute
catastrophique : la réutilisation d'un nonce livre le XOR des deux clairs **et** la clé
d'authentification `H`, donc la capacité de forger des étiquettes (SP 800-38D, annexe A ; attaque
dite « forbidden attack », Joux 2006). Le **rang de l'entrée dans le journal de sa génération**,
lui, est unique par construction. L'adresse reste dans les données associées, où l'unicité n'est pas
exigée.

**Le second choix est la dérivation plutôt que le tirage ou le compteur.** Le § 8.2 de SP 800-38D
admet deux constructions : déterministe (champ fixe ‖ champ d'invocation) et tirée d'un générateur.
Un compteur global tiré d'un état durable serait la forme canonique du § 8.2.1 ; il exigerait que ce
compteur ne recule **jamais**, y compris après la coupure que tout l'ADR 0014 existe pour survivre.
Un compteur perdu ou rejoué, c'est un nonce réémis. La génération, elle, est monotone et durablement
scellée par la racine ; les rangs repartent de zéro dans la génération suivante. Une reprise après
coupure ouvre une génération NEUVE et ne peut donc pas réémettre un nonce déjà employé. C'est le
modèle de panne de ce dépôt qui décide ici, pas une préférence.

Le tirage aléatoire est écarté sans hésitation : sur 96 bits, la probabilité de collision atteint
2^-33 au bout de 2^32 tirages (paradoxe des anniversaires), ce qui est précisément la raison du
plafond du § 8.3. Un tirage aurait donc les inconvénients du plafond sans son bénéfice.

**Bornes, calculées.**

| Borne                                                   |                     Valeur | D'où elle vient                                             |
| ------------------------------------------------------- | -------------------------: | ----------------------------------------------------------- |
| Générations représentables                              | 2^48 = 281 474 976 710 656 | largeur du champ                                            |
| Entrées par génération                                  |   2^40 = 1 099 511 627 776 | largeur du champ                                            |
| Entrées par génération admises par l'ADR 0014           |                    131 072 | plafond de charge de 64 Mio ÷ 512 o                         |
| **Scellements par clé de volume**                       |   **2^32 = 4 294 967 296** | **SP 800-38D § 8.3** — la borne qui MORD                    |
| Octets scellés correspondants                           |                      2 Tio | 2^32 × 512 o                                                |
| Réécritures complètes du volume applicatif de 512 Mio   |                  **4 096** | 2^32 ÷ 2^20 secteurs                                        |
| Générations de la taille mesurée par #16 (177 secteurs) |             ~24,3 millions | 2^32 ÷ 177                                                  |
| Clair par invocation                                    |   2^39 − 256 bits ≈ 64 Gio | SP 800-38D § 5.2.1.1 — jamais atteignable avec des secteurs |

Les champs du nonce sont **plus larges que le budget**, et c'est délibéré : un champ étroit reboucle
en silence, ce qui est exactement la faute contre laquelle tout ce mécanisme existe. La borne qui
mord n'est pas structurelle, elle est **comptée** : la racine porte un compteur cumulé
`scellementsCumules`, authentifié, et le scellement est **refusé** par `VAULT_CRYPTO_BUDGET_DE_CLE`
avant de produire un nonce lorsque le budget est atteint. Le remède est une clé de volume neuve —
donc un travail de #21 —, pas une tolérance.

Ce que les 4 096 réécritures complètes veulent dire concrètement mérite d'être dit : la borne n'est
pas hors d'atteinte sur la vie d'un volume. À la cadence mesurée de bout en bout par #16 — 177
secteurs par génération —, elle est atteinte après ~24 millions de barrières. Ce n'est pas
atteignable par un test ; ce l'est par des années d'usage. Elle doit donc être **comptée par le
produit**, pas supposée lointaine.

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
`tests/unit/vm-format-chiffre-identite.test.mjs` éprouve ce cas précis (« ab » + « c » contre « a
» + « bc »).

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
majorée par ≈ 2^-122,6 par tentative. C'est une intégrité **authentifiée**, non un CRC : l'ADR 0014
disait déjà qu'un CRC-32 « ne prétend RIEN contre un altérateur volontaire, qui le recalculerait
sans difficulté ». Ici, le recalcul exige la clé.

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

| Forme                                                               | Détectée ? | Par quoi                                                                                   |
| ------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Rejeu d'une racine ou d'un bloc antérieur **au sein d'une session** | oui        | P3, avec le minimum de séquence tenu en mémoire                                            |
| Retour arrière d'un **secteur** du volume                           | **non**    | rien : le lecteur lit la génération du secteur dans le nonce, c'est-à-dire au même endroit |
| Retour arrière **complet** du support entre deux sessions           | **non**    | rien : l'état antérieur est cohérent et authentique                                        |

**Le retour arrière d'un secteur** mérite d'être expliqué, parce qu'il est contre-intuitif. Un
secteur relu du volume est ouvert sous une identité que le lecteur ne connaît pas d'avance : il lit
le nonce conservé à côté du secteur, en déduit la génération et le rang, reconstruit les données
associées et vérifie. Le sceau et l'identité viennent donc **du même endroit**. Un attaquant qui
remet en place le triplet complet d'une version antérieure du même secteur produit un ensemble
cohérent, et le lecteur l'accepte.

Le remède connu est une **structure authentifiée à l'échelle du volume** — typiquement un arbre de
Merkle sur les 2^20 secteurs du volume applicatif, dont la racine serait scellée à chaque point de
contrôle. Son coût est calculable : 20 hachages par écriture pour mettre à jour un chemin, et un
état de 2^21 − 1 nœuds de 32 octets, soit 64 Mio, à tenir ou à relire. Ce n'est pas exigé par le
résultat de #17 ni par celui de #19 tel que l'issue le formule (« la racine authentifie l'ensemble
exact des blocs de SA génération »). **Ce n'est donc pas fourni ici, et c'est la question n° 2 pour
#20.**

**Le retour arrière complet** ne se traite pas par un format. Il exige un **point d'ancrage monotone
hors de portée de l'attaquant** : un compteur matériel, un témoin distant, ou un service tiers de
fraîcheur. Le navigateur n'en offre aucun — ni OPFS, ni IndexedDB, ni le stockage clé-valeur ne
promettent la monotonie face à un adversaire qui contrôle le profil. Il est donc **assumé**, et sa
seule barrière est celle qui l'était déjà : le partitionnement OPFS par origine de l'ADR 0002. Le
dire est le minimum ; c'est la question n° 3 pour #20.

## Coût

### Espace

| Objet                            |                     Surcoût | Détail                                                                                                                        |
| -------------------------------- | --------------------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| Secteur du **volume**            | **28 o pour 512 → 5,469 %** | nonce 12 o + étiquette 16 o. Le nonce est STOCKÉ : le lecteur ne connaît pas d'avance la génération d'un secteur.             |
| Enregistrement du **journal**    | **16 o pour 512 → 3,125 %** | étiquette seule. Le nonce y est DÉRIVABLE : la génération est dans la racine, le rang est la position de l'enregistrement.    |
| **Racine** de génération         |         **0 octet de plus** | l'en-tête passe de 60 à 136 octets dans le secteur DÉJÀ alloué par l'ADR 0014. Le CRC-32 disparaît, remplacé par l'étiquette. |
| Volume applicatif de **512 Mio** |               **28,00 Mio** | 1 048 576 secteurs × 28 o = 29 360 128 o, soit exactement 57 344 secteurs                                                     |

L'en-tête de racine v3, détaillé, pour montrer qu'il tient : marqueur 8 + format du journal 4 +
taille de secteur 4 + séquence 8 + génération 8 + taille du volume 8 + nombre d'entrées 4 + longueur
de charge 8 + identifiant de volume 16 + scellements cumulés 8 + nonce 12 + chiffré (l'empreinte des
entrées) 32 + étiquette 16 = **136 octets** sur les 512 du secteur. La réserve de zéros que l'ADR
0014 décrit reste large.

### Où ces octets vivront : un format de volume v3

**Décision de disposition** : une **région d'authentification dédiée**, en tête du fichier de
volume, alignée sur le secteur, portant 28 octets par secteur logique. Le fichier devient :

```text
[ en-tête v3, 1 secteur ][ région d'authentification, 57 344 secteurs ][ charge chiffrée, 1 048 576 secteurs ]
```

**Pourquoi cette disposition plutôt que l'entrelacement.** Entrelacer (chaque secteur logique
occupant 540 octets sur le support) casserait l'alignement sur 512 et sur la page hôte de 4 096
octets, donc la géométrie que `block-geometry.mjs` impose et que le point de contrôle de l'ADR 0014
exploite pour recopier des secteurs alignés. La région dédiée confine le changement à un préambule.

**Pourquoi dans le FICHIER du volume et non dans un quatrième voisin.** Un voisin `<volume>.auth`
ajouterait un problème d'atomicité entre deux fichiers là où il n'y en a pas : un handle, une
barrière, un fichier.

**Ce que ça coûte en lecture.** Lire un secteur exige ses 28 octets de métadonnées, donc une lecture
de plus. Une page hôte de 4 096 octets de la région porte les métadonnées de 146 secteurs
consécutifs (74,8 Kio de charge) : le surcoût est d'une lecture par ~146 secteurs en accès
séquentiel, et d'une lecture par secteur en accès aléatoire.

**Un secteur « jamais écrit » ne peut pas exister en v3.** Si la région d'authentification était à
zéro pour un secteur vierge, un attaquant n'aurait qu'à zéroter ces 28 octets pour faire lire un
secteur comme blanc. La préparation d'un volume et la restauration (les chemins
`transactionnel: false` de l'ADR 0014) devront donc **sceller tous les secteurs**, y compris ceux
qui ne portent que des zéros. Le coût est mesuré ci-dessous.

**Impacts listés, aucun ADR modifié :**

| ADR                  | Ce que v3 lui impose                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0007** (manifeste) | un **identifiant de volume** obligatoire, opaque et immuable, qui n'existe pas en v2 ; un champ nommant l'algorithme ; `MANIFEST_FORMAT_VERSION` à 3 et `MIN_WRITER_FORMAT_VERSION` déplacé — un runtime v2 ne peut pas écrire un v3.                                                                               |
| **0008** (archive)   | `content.length` et `identity.digest` portent aujourd'hui sur un fichier qui EST l'image du disque. En v3 il ne l'est plus. Reste à trancher : l'archive porte-t-elle le fichier v3 tel quel (chiffré, donc non restaurable sans la clé) ou une image déchiffrée ? **Question n° 6.**                               |
| **0011** (migration) | une étape v2 → v3 qui **rechiffre le volume entier**, sous l'atomicité de l'ADR 0011 (manifeste révoqué, puis réinscrit après relecture). Coût mesuré ci-dessous.                                                                                                                                                   |
| **0014** (journal)   | le CRC-32 de la racine remplacé par l'étiquette ; l'enregistrement grossit de 16 octets ; l'en-tête de racine passe de 60 à 136 octets dans le même secteur ; les quatre issues de la récupération sont inchangées, leurs raisons `VAULT_CRYPTO_*` se mappant sur les codes `VAULT_STORAGE_GENERATION_*` existants. |

### Calcul, mesuré

`node tools/mesurer-scellement.mjs --navigateur --essais=5`, relevé du **2026-08-27** sur la machine
de développement (Windows 11, Intel i7-14700HX, 28 cœurs logiques, Node 24.14.0, Chromium 151 par
Playwright). **Ce n'est pas l'environnement de référence** de ce document (4 cœurs, 16 Gio, dix
essais) : ces chiffres valent comme ordre de grandeur mesuré, pas comme relevé de référence. Lot de
4 Mio, 8 192 blocs de 512 octets, cinq essais.

| Moteur                   | Sceller un bloc | Ouvrir un bloc | Débit par blocs |    4 Mio en UN appel |
| ------------------------ | --------------: | -------------: | --------------: | -------------------: |
| **Chromium 151, Worker** |    **13,73 µs** |   **14,51 µs** |      35,6 Mio/s |   4,1 ms → 976 Mio/s |
| Node 24.14               |        58,92 µs |       56,46 µs |       8,3 Mio/s | 3,4 ms → 1 177 Mio/s |

**Le résultat qui décide n'est pas le débit d'AES, c'est le coût par APPEL.** Les mêmes 4 Mio
coûtent 112,5 ms en 8 192 appels contre 4,1 ms en un seul, soit un facteur **27** qui n'est pas
imputable au chiffrement : le coût fixe d'un appel à `crypto.subtle` vaut ≈ 13,2 µs, contre ≈ 0,5 µs
de calcul pour 512 octets. Et Node est **4,3 fois plus lent par appel** que Chromium : sa mesure ne
peut pas se substituer à celle du navigateur, ce qui justifie d'avoir monté le banc dans un vrai
Worker.

**Rapporté aux budgets de `docs/quality-attributes.md`** — toujours avec les chiffres de Chromium :

| Geste                                                                   | Coût de scellement |                                                                                           Rapporté à |
| ----------------------------------------------------------------------- | -----------------: | ---------------------------------------------------------------------------------------------------: |
| Boot Rails mesuré par #16 (285 lectures + 13 écritures)                 |         **4,3 ms** |                                                              ~92 s de boot → **0,005 %**. Invisible. |
| Une génération de la taille mesurée par #16 (90 304 o, 177 secteurs)    |         **2,4 ms** |                                                                     s'ajoute à une barrière du guest |
| Récupération d'une génération au plafond de 64 Mio                      |          **1,9 s** | budget « dernière génération valide trouvée en ≤ 60 s » — tenu avec deux ordres de grandeur de marge |
| Création ou restauration d'un volume de 512 Mio (tous secteurs scellés) |         **14,4 s** |                                         s'ajoute à la préparation d'image et à la restauration (#12) |
| Migration v2 → v3 d'un volume de 512 Mio                                |         **14,4 s** |                                             à comparer au boot après migration mesuré à ~105 s (#74) |
| Lecture du volume entier (export #11, si l'archive est en clair)        |         **15,2 s** |                                            l'export n'a pas de budget de temps ; il en aurait besoin |

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

| Fichier                                      | Ce qu'il porte                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/vm/format-chiffre/identite-logique.mjs` | nonce, données associées, encodage canonique des entrées, bornes, budget de clé  |
| `src/vm/format-chiffre/modele-reference.mjs` | `scellerBloc`, `ouvrirBloc`, `scellerRacine`, `ouvrirRacine`                     |
| `src/vm/format-chiffre/crypto-errors.mjs`    | famille `VAULT_CRYPTO_*`, chacune nommant les menaces qu'elle couvre             |
| `src/vm/format-chiffre/octets.mjs`           | hexadécimal, concaténation, comparaison à temps constant, entiers gros-boutistes |
| `tests/vectors/format-chiffre-v1.json`       | **cinq blocs et deux racines figés**, avec clé de TEST publique et sans entropie |
| `tools/figer-vecteurs-scellement.mjs`        | produit les vecteurs depuis le modèle                                            |
| `tools/mesurer-scellement.mjs`               | le banc de mesure, sous Node et dans un Worker de Chromium                       |

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

1. **AES-GCM-SIV vaut-il sa dépendance ?** Notre nonce est déterministe et dérivé d'un état
   (génération, rang) reconstruit après coupure. Si ce raisonnement était faux quelque part, GCM
   perdrait tout ; GCM-SIV ne perdrait que l'indistinguabilité des messages répétés. Le coût est une
   implémentation JS ou WebAssembly tierce et son audit. Est-ce le bon échange pour un format de
   stockage local exposé à des coupures ?
2. **Faut-il un arbre de Merkle sur le volume ?** Le retour arrière d'un SECTEUR n'est pas détecté.
   Le remède coûte 20 hachages par écriture et 64 Mio d'état pour un volume de 512 Mio. Est-ce
   proportionné à un modèle de menace où l'adversaire écrit dans l'OPFS de l'origine de confiance —
   c'est-à-dire où il a déjà franchi la frontière de l'ADR 0002 ?
3. **Existe-t-il un ancrage monotone acceptable dans un navigateur ?** Le retour arrière complet du
   support est assumé. Aucune API du navigateur ne promet la monotonie face à un adversaire qui
   contrôle le profil. Un témoin distant optionnel changerait-il utilement le modèle, ou
   déplacerait-il seulement la confiance ?
4. **Le compteur de scellements est-il au bon endroit ?** Il est authentifié dans la racine, donc
   protégé contre la falsification mais soumis au retour arrière : un support qui recule ferait
   re-parcourir des rangs déjà employés dans des générations déjà employées. La monotonie de la
   génération est-elle une protection suffisante, ou le budget doit-il vivre ailleurs ?
5. **Le lot par appel est-il le bon découpage ?** Sceller 512 octets à la fois coûte 27 fois plus
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
   retenue est « il n'y a pas de secteur jamais écrit en v3 », au prix de 14,4 s de scellement à la
   création. Est-ce le bon compromis, ou faut-il un marquage authentifié des plages non initialisées
   ?
8. **L'en-tête de racine en clair est-il acceptable ?** Il publie le nombre d'écritures d'une
   génération et la longueur de sa charge. Sur un volume de base de données, cela dit quelque chose
   du rythme d'activité. Faut-il l'atténuer (rembourrage, granularité) ou l'assumer ?

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

- **Un nonce construit sur (génération, adresse).** C'est la construction la plus naturelle, et elle
  est **fausse ici** : l'ADR 0014 autorise la réécriture d'un même bloc dans une même génération. Le
  rejet de cette alternative est la raison d'être du champ « rang ».
- **Un compteur global de nonces tiré d'un état durable.** Forme canonique du § 8.2.1 de SP 800-38D,
  écartée parce qu'elle exige un compteur qui ne recule jamais — dans un dépôt dont tout l'ADR 0014
  existe pour survivre à des coupures qui font justement reculer les états.
- **Un nonce tiré au hasard.** Sur 96 bits, la collision devient probable à l'échelle même du budget
  de 2^32 : les inconvénients du plafond sans son bénéfice.
- **Un arbre de Merkle pour la racine d'une génération.** Rejeté ici : son seul bénéfice, la
  vérification partielle, n'a aucun consommateur, puisque la charge validée est relue et rejouée
  d'un seul tenant (ADR 0014). Il reste le candidat pour le VOLUME, où le problème est différent
  (question n° 2).
- **Sceller une génération entière en un seul appel.** 27 fois moins cher, et c'est réel. Rejeté
  pour le VOLUME : il n'y aurait plus d'accès aléatoire, et une erreur d'un bit ferait perdre toute
  la génération au lieu d'un secteur. Reste ouvert pour le JOURNAL (question n° 5).
- **Entrelacer étiquette et nonce avec chaque secteur (540 octets par secteur).** Rejeté : casse
  l'alignement sur 512 et sur la page hôte, donc la géométrie de `block-geometry.mjs` et la recopie
  alignée du point de contrôle.
- **Un quatrième fichier voisin `<volume>.auth`.** Rejeté : introduit un problème d'atomicité entre
  deux fichiers là où un seul handle et une seule barrière suffisent.
- **Négocier l'algorithme à l'exécution.** Rejeté : c'est un mécanisme de rétrogradation dès qu'un
  attaquant peut écrire le champ qui le porte. L'agilité passe par une version de format et un ADR,
  comme l'ADR 0011 l'a décidé pour l'empreinte.
- **Prétendre distinguer modification et déplacement.** Rejeté : ils sont indiscernables sous GCM.
  Le modèle refuse et le dit ; un diagnostic inventé serait pire qu'un refus honnête.

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
   n° 1 son coût de dépendance.
