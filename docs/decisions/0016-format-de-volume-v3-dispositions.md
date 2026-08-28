# ADR 0016 — Le format de volume v3 range le sceau hors de la charge : un en-tête, une région d'authentification, et un sceau de 34 octets partout

- Statut : accepté
- Date : 2026-08-28
- Issue : #18 · Invariants : `SEC-BLOCK-001`, `SEC-DURABLE-001` · Jalon 4

## Contexte

L'[ADR 0015](0015-proprietes-cryptographiques-du-format.md) a décidé les primitives, écrit les cinq
propriétés, livré un modèle de référence (`src/vm/format-chiffre/`) et figé des vecteurs
(`tests/vectors/format-chiffre-v1.json`). Il l'a fait sans toucher un octet du produit, et il le
disait : « `SEC-BLOCK-001` et `SEC-GEN-001` reçoivent ici leur définition et leurs vecteurs ; aucun
chemin d'écriture ni de lecture du produit ne les appelle. »

#18 les appelle. Cet ADR ne prend **aucune décision cryptographique** — primitives, nonce, données
associées, budget de clé, ordre des vérifications restent ceux de l'ADR 0015, et le modèle de
référence reste la spécification. Il décide **où les octets vivent sur le disque**, ce que le
manifeste déclare, comment la clé arrive, et ce qu'une migration et une archive deviennent.

Il porte aussi une **correction de l'ADR 0015**, découverte par l'implémentation et démontrée par
une épreuve : la section « Le journal porte sa génération » ci-dessous.

## Décision 1 — La disposition du fichier de volume

Un volume v3 est **un seul fichier**, comme en v2. Sa disposition :

```text
  offset 0                              en-tête v3           1 secteur (512 o)
  offset 512                            région d'authentification   R secteurs
  offset 512 + R × 512                  charge chiffrée      N secteurs
```

avec `N = tailleLogique / 512` et `R = alignerHaut(N × 34) / 512`.

Pour le volume applicatif de 512 Mio : `N = 1 048 576`, `N × 34 = 35 651 584` octets, soit
**exactement 69 632 secteurs** — la région tombe juste, sans rembourrage. Le fichier fait alors
`512 + 35 651 584 + 536 870 912 = 572 523 008` octets pour 512 Mio logiques, soit **+6,64 %**.

**La taille LOGIQUE reste celle que v86 voit.** `describe().size` et `size()` du backend rendent la
taille logique ; le mappage vers le support est confiné à `volume-chiffre-format.mjs`. C'est ce qui
permet à `block-geometry.mjs`, au contrat de tampon de v86 et à l'oracle de #15 de rester inchangés
: un secteur logique `a` vit à l'offset support `512 + R × 512 + a`, et son sceau à
`512 + a / 512 × 34`.

**Pourquoi cette disposition plutôt que l'entrelacement**, et pourquoi dans le fichier du volume et
non dans un voisin `<volume>.auth` : les deux raisons sont écrites dans l'ADR 0015 (§ « Où ces
octets vivront ») et ne sont pas rejugées ici — alignement de `block-geometry.mjs` d'un côté,
atomicité à un seul handle de l'autre.

### L'en-tête v3, et ce qu'il n'est pas

Un secteur, gros-boutiste pour les champs nouveaux, petit-boutiste pour ceux qui reprennent la
convention de `generation-format.mjs` — la convention retenue est celle de `DataView` en
petit-boutiste, comme le reste des en-têtes sur disque du dépôt :

| offset | largeur | champ                                    |
| ------ | ------: | ---------------------------------------- |
| 0      |       8 | marqueur `VLTVOL03`                      |
| 8      |       4 | version du format de volume (3)          |
| 12     |       4 | taille de secteur (512)                  |
| 16     |       8 | taille LOGIQUE du volume                 |
| 24     |       8 | offset de la région d'authentification   |
| 32     |       8 | longueur de la région d'authentification |
| 40     |       8 | offset de la charge chiffrée             |
| 48     |      16 | identifiant de volume (16 octets bruts)  |
| 64     |     448 | réserve, à zéro                          |

**Cet en-tête n'est PAS une autorité, et il ne prétend pas l'être.** Il n'est ni chiffré ni
authentifié : il LOCALISE. Ce qui le rend inoffensif est ailleurs — l'identifiant de volume et la
version de format entrent dans les données associées de **chaque** secteur, si bien qu'un en-tête
falsifié fait échouer la première lecture par `VAULT_CRYPTO_SCEAU_REFUSE` au lieu de rendre du
clair. Le seul dommage qu'une altération produise est donc un **refus**, jamais une lecture erronée.
Le dire est le minimum ; l'authentifier exigerait de pouvoir le lire sans connaître l'identifiant
qu'il porte, ce qui est circulaire.

L'ouverture confronte les seize octets de l'en-tête à l'identifiant que le **manifeste** déclare, et
refuse l'écart par `VAULT_STORAGE_IDENTITE_VOLUME` avant toute lecture de charge : deux sources qui
divergent ne se départagent pas, elles se refusent.

### Le sceau de 34 octets, une seule forme pour deux endroits

```text
  nonce 12 o  ‖  étiquette 16 o  ‖  génération 6 o  =  34 octets
```

C'est la forme de la région d'authentification, **et** celle du sceau d'un enregistrement de
journal. Une seule fonction d'encodage, une seule de décodage, un seul jeu d'épreuves. L'ADR 0015
chiffrait 34 octets pour le volume et 28 pour le journal ; la section suivante dit pourquoi les deux
valent 34.

L'enregistrement de la région à l'index `a / 512` porte le nonce, l'étiquette et la **génération**
du secteur logique `a`. Le rang est épinglé à `RANG_SECTEUR_DE_VOLUME = 0` par le modèle et n'est
donc pas stocké.

**Un enregistrement de région peut chevaucher deux secteurs du support** : 34 ne divise pas 512. La
conséquence est écrite plutôt que masquée — une déchirure sur la frontière abîme le sceau, et le
secteur correspondant est **refusé** à la lecture suivante. Ce n'est pas un affaiblissement : le
secteur de charge et son sceau sont de toute façon deux écritures distinctes, qu'aucune atomicité ne
lie. Ce que le format promet ici est un refus, pas une lecture. La protection contre la perte reste
celle de l'ADR 0014 : le point de contrôle est le seul geste qui écrit le volume, son échec ne
valide rien, et la génération reste dans le journal pour être rejouée.

### Aucun secteur « jamais écrit »

L'ADR 0015 l'a tranché : « si la région d'authentification était à zéro pour un secteur vierge, un
attaquant n'aurait qu'à zéroter ces octets pour faire lire un secteur comme blanc ». La création
d'un volume v3 et la restauration **scellent donc tous les secteurs**, y compris ceux qui ne portent
que des zéros. Un sceau tout à zéro n'est pas un sceau valide : il est refusé comme n'importe quelle
altération, et le refus nomme les deux menaces indiscernables (modification, déplacement).

## Décision 2 — Le journal porte sa génération, et c'est une CORRECTION de l'ADR 0015

L'ADR 0015 chiffre le surcoût d'un enregistrement de journal à **28 octets** (nonce 12 +
étiquette 16) et justifie l'absence de la génération ainsi : « La génération y est celle de la
racine, le rang est la position de l'enregistrement : ni l'une ni l'autre n'est stockée. »

**Cette phrase est fausse contre `src/vm/generation-store.mjs`, et le constat est exécuté, pas
supposé.** Une charge de journal n'appartient PAS à une seule génération :

- `valider()` incrémente la génération et scelle une racine, **sans vider le journal** ;
- le journal n'est vidé qu'au **point de contrôle**, amorti au-delà de `POINT_DE_CONTROLE_OCTETS` ;
- entre deux points de contrôle, plusieurs validations se succèdent donc sur la **même** charge
  cumulée, et la racine la plus récente scelle des enregistrements déposés sous des générations
  **antérieures à la sienne**.

Un lecteur qui reconstruirait les données associées d'un enregistrement à partir de la génération de
la racine échouerait alors sur tous les enregistrements des générations précédentes — c'est-à-dire
sur le chemin de reprise le plus courant, celui qu'un boot exerce à chaque ouverture.
`tests/unit/vm-generation-chiffre.test.mjs` le rejoue sur le magasin réel : deux validations
successives sans point de contrôle, puis une réouverture.

**Décision : un enregistrement de journal porte le même sceau de 34 octets que la région du
volume**, génération comprise. Le surcoût annoncé par l'ADR 0015 passe de 28 à **34 octets** par
enregistrement, soit 6,641 % pour un enregistrement de 512 octets au lieu de 5,469 %.

Deux réparations ont été examinées et écartées :

1. **Vider le journal à chaque validation** (une génération = une charge). Elle rendrait la phrase
   de l'ADR 0015 vraie, au prix de la suppression du point de contrôle amorti de l'ADR 0014 —
   c'est-à-dire d'une recopie du volume à **chaque barrière du guest**. Le relevé de #16 mesure 13
   écritures pour une barrière au boot : le coût serait payé des centaines de fois par démarrage.
2. **Sceller à la validation plutôt qu'au dépôt.** Déjà écartée par l'ADR 0015, pour deux raisons
   qui n'ont pas bougé : le journal resterait en clair jusqu'à la barrière, et « déposer = une
   écriture, une seule » tomberait.

Le **rang** d'un enregistrement reste sa position dans la charge, en base zéro : il croît
strictement, ce que `verifierRangsCroissants` exige d'une suite d'entrées.

### La disposition d'un enregistrement v3

```text
  en-tête 16 o (offset logique 8, longueur 4, réserve 4)  ‖  sceau 34 o  ‖  chiffré L o
```

L'en-tête de l'ADR 0014 est **inchangé**, et c'est délibéré : il est déjà relu par
`decoderEnteteEnregistrement`, et son plausibilité (`offset + longueur ≤ tailleVolume`) reste le
premier filtre d'un parcours. Il n'est pas authentifié — les mêmes champs le sont dans les données
associées du sceau, si bien qu'un en-tête falsifié conduit à un refus de sceau, jamais à un clair.

## Décision 3 — La racine v3, 136 octets, sans CRC-32

L'ADR 0015 a chiffré l'en-tête de racine v3 à 136 octets « dans le secteur DÉJÀ alloué par l'ADR
0014 ». Voici sa disposition exacte, petit-boutiste :

| offset | largeur | champ                                     | dans les données associées ? |
| ------ | ------: | ----------------------------------------- | ---------------------------- |
| 0      |       8 | marqueur `VLTGEN01`                       | non                          |
| 8      |       4 | format du journal (**2** en v3)           | non                          |
| 12     |       4 | taille de secteur (512)                   | non                          |
| 16     |       8 | séquence                                  | oui                          |
| 24     |       8 | génération                                | oui                          |
| 32     |       8 | taille du volume (LOGIQUE)                | oui                          |
| 40     |       4 | nombre d'entrées                          | oui                          |
| 44     |       8 | longueur de charge                        | oui                          |
| 52     |      16 | identifiant de volume                     | voir ci-dessous              |
| 68     |       8 | scellements cumulés                       | oui                          |
| 76     |      12 | nonce                                     | —                            |
| 88     |      32 | chiffré : l'empreinte scellée des entrées | —                            |
| 120    |      16 | étiquette                                 | —                            |

Total : **136 octets** sur les 512 du secteur. Le CRC-32 de l'en-tête disparaît : l'étiquette le
remplace, et elle refuse ce qu'il détectait (déchirure, octet retourné) **plus** ce qu'il ne
prétendait rien contre (un altérateur volontaire, qui recalculait un CRC sans difficulté).

**L'identifiant de volume de la racine mérite une phrase à part, parce qu'il est le seul champ dont
la colonne « données associées » se lit de travers.** L'identité qui entre RÉELLEMENT dans les
données associées est celle que le **manifeste** déclare et que l'ouvreur porte, pas celle qu'on lit
sur le disque. Retourner la copie sur disque ne change donc pas l'étiquette. Elle n'est pas crue
pour autant : `generation-store.mjs` la CONFRONTE à l'identité de l'ouvreur et refuse l'écart par
`VAULT_STORAGE_IDENTITE_VOLUME` avant tout parcours — ce qui distingue « ce journal appartient à un
autre volume » de « ce journal est abîmé », deux états dont les remèdes n'ont rien de commun. La
copie sur disque est donc un **localisateur, pas une autorité**, exactement comme l'en-tête v3, et
`tests/unit/vm-generation-format.test.mjs` l'éprouve en montrant que l'octet 52 ne fait PAS échouer
l'étiquette.

Le **format du journal passe de 1 à 2**. C'est la barrière de version côté journal : un runtime v2
qui relit une racine v3 la refuse par « Format de journal de génération inconnu : 2 », comme
`decoderRacine` le fait déjà. Le marqueur, le format et la taille de secteur restent hors des
données associées : ils localisent, ils n'autorisent pas, et toute altération y produit un refus de
décodage.

**La longueur de charge stockée est celle des données associées** — la somme des longueurs de CLAIR
des entrées, telle que `enteteDeRacine` la dérive. La longueur PHYSIQUE de la charge sur le disque
s'en déduit sans être stockée :

```text
  longueurPhysique = longueurCharge + nombreEntrees × (16 + 34)
```

Les deux grandeurs sont ainsi authentifiées par une seule, et aucune divergence entre elles n'est
représentable. C'est la même règle que l'ADR 0015 applique au nombre d'entrées : « dérivé des
entrées au moment de sceller, jamais reçu de l'appelant ».

### La vérification à la reprise, dans l'ordre

1. **Parcourir** la charge, enregistrement par enregistrement, avec la fenêtre glissante de #91 :
   lire l'en-tête, lire le sceau, sauter le chiffré, collecter l'entrée
   `(adresse, longueur, rang, étiquette)`. Aucun déchiffrement, aucune allocation qui suive la
   taille de la charge.
2. **Ouvrir la racine** (`ouvrirRacine`) avec la suite d'entrées collectée. C'est là que l'étiquette
   de l'en-tête est vérifiée, puis que la troncature et le mélange sont **établis** sur un en-tête
   authentique.
3. **Rejouer** : seconde passe, `ouvrirBloc` par enregistrement sous l'identité reconstruite
   (volume, format 3, génération DU SCEAU, rang, adresse, longueur), puis `rescellerEnSecteurs` vers
   le volume.

L'ordre est celui de l'ADR 0015 — vérifier d'abord, classer ensuite — et il conserve les deux passes
de l'ADR 0014 : la première ne touche pas le volume, si bien qu'une charge refusée n'y laisse rien.

**Chaque enregistrement est ouvert à CHAQUE passe, y compris celle qui n'émet rien.** N'ouvrir qu'à
l'émission laisserait les premiers enregistrements dans le volume au moment où le dernier serait
refusé — exactement le rejeu à moitié que l'ADR 0014 interdit. Le prix est un déchiffrement de plus
par enregistrement, et il tombe sur le geste amorti.

### La racine VIDE est authentifiée comme les autres

Une racine vide n'a aucune charge à confronter, et c'est précisément ce qui la rend dangereuse :
**elle fixe à elle seule la génération et la séquence** de la session à venir. C'est l'état que
laisse tout point de contrôle, donc l'état le plus fréquent d'un journal au repos.

En v2, `decoderRacine` la validait par un CRC-32 — c'est-à-dire par rien : l'ADR 0014 écrivait déjà
que sa somme « ne prétend RIEN contre un altérateur volontaire, qui la recalculerait sans difficulté
». En v3, la décoder ne prouve plus quoi que ce soit non plus, puisque seule l'étiquette le fait. Un
journal dont la racine vide serait FORGÉE avec une séquence plus haute ferait donc autorité, et la
génération réellement validée serait écartée comme « dépassée » — une écriture acquittée perdue,
sans qu'aucun code ne mente.

**Décision : le parcours est exécuté même pour une charge de zéro entrée.** Il ne lit aucun
enregistrement et n'ouvre que la racine : le geste voulu, au prix d'un déchiffrement par ouverture.
`tests/unit/vm-generation-chiffre.test.mjs` forge une racine vide de séquence plus haute et la voit
refusée ; l'épreuve a été vérifiée ROUGE sans ce parcours, en le retirant.

## Décision 4 — Le point de contrôle rescelle, et compte

`rescellerEnSecteurs` du modèle est le geste, et il est appelé tel quel : le clair d'un
enregistrement est découpé en secteurs, chacun scellé sous un **nonce neuf** et sous la génération
de la racine qui range. Trois conséquences, toutes déjà écrites dans l'ADR 0015 et toutes assumées
ici : le clair transite en mémoire, les octets rangés sont scellés deux fois, un enregistrement non
aligné est refusé.

Le troisième point ne coûte rien en pratique : `deposer` aligne déjà toute écriture sur des secteurs
entiers, en relisant au besoin. C'est la lecture-modification-réécriture que l'ADR 0015 réclame de
l'appelant, et elle existait avant lui.

### Un manque du modèle de référence, signalé et comblé sans changer un octet

L'ADR 0015 a livré `scellerBlocSousNonce` et `scellerRacineSousNonce` avec une raison écrite : «
permettre à une implémentation (#18) de REPRODUIRE ces vecteurs ». **Le troisième geste,
`rescellerEnSecteurs`, n'avait pas son équivalent** — il tirait ses nonces lui-même, sans porte
d'injection. La conséquence n'est pas cosmétique : le chemin du point de contrôle est celui qui
écrit réellement dans le volume, et il échappait au contrat des vecteurs. Aucune épreuve n'aurait vu
une implémentation qui, par exemple, aurait épinglé un autre rang ou une autre longueur.

Le manque est comblé par un paramètre `nonces` **optionnel**, dont le défaut est le tirage — donc
sans qu'un seul octet produit change. `tests/unit/vm-volume-chiffre.test.mjs` s'en sert pour
confronter le rescellement au premier vecteur figé, qui est précisément un secteur de volume (rang
0, adresse 0, 512 octets). C'est un défaut de la spécification, corrigé dans la spécification ; ce
n'est pas un ajustement du modèle pour faire passer du code.

### Un second défaut du modèle, tombé sur le banc de récupération

`encoderEntrees` assemblait ses morceaux par `concatener(...morceaux)`, et le nombre de morceaux
suit le **nombre d'entrées** d'une génération. Au plafond de charge de l'ADR 0014 — 64 Mio, soit
jusqu'à 131 072 enregistrements de 512 octets —, l'étalement fait plus d'un demi-million d'arguments
et le moteur rend **« Maximum call stack size exceeded »**, au milieu d'une récupération que rien
n'annonçait comme démesurée. Le défaut est tombé sur `tests/vm/recuperation-generation.spec.mjs`, à
la première exécution du banc sur le format v3 — pas à la lecture.

L'ADR 0015 le nommait sans le chiffrer : « le modèle n'a aucune borne mémoire […] une implémentation
qui rejouerait une génération de 64 Mio devra régler ce point elle-même ». Le régler « elle-même »
n'était pas possible : le débordement est DANS le modèle, pas dans son appelant. L'assemblage passe
donc par `concatenerListe`, qui n'étale rien ; les octets produits sont identiques, ce que les
vecteurs figés vérifient, et `tests/unit/vm-format-chiffre-identite.test.mjs` borne désormais la
propriété par une épreuve au plafond plutôt que par une phrase.

**Le rescellement compte dans le budget de clé.** `scellementsCumules` est incrémenté par secteur
rescellé comme par enregistrement déposé et par racine écrite, et `verifierBudgetDeCle` refuse à
2^31. Le compteur est **authentifié dans la racine** : il traverse donc les sessions, et son recul
par retour arrière du support est la question n° 4 de l'ADR 0015, nommée là-bas et pas résolue ici.

## Décision 5 — Le manifeste v3

`MANIFEST_FORMAT_VERSION` passe à **3**. Trois changements, tous obligatoires à partir de v3 :

1. **`volume.id`** — l'identifiant **opaque, aléatoire, immuable, inscrit à la création**,
   représenté par **32 caractères hexadécimaux minuscules** (les seize octets de l'en-tête v3 et de
   la racine, convertis par `identifiantVolumeEnTexte`, comme l'ADR 0015 le fixe). C'est le champ
   dont l'ADR 0015 constatait l'absence : « tant que #18 ne l'a pas ajouté, deux volumes de la même
   application ne sont séparés que par leur clé ». Il est refusé s'il n'est pas exactement 32 hex
   minuscules — une forme approchante donnerait une autre chaîne dans les données associées, donc un
   autre volume ;
2. **`volume.algorithm`** — `aes-256-gcm`, **seul admis**, épinglé par `verifierAlgorithme`. La
   règle est celle que l'ADR 0011 a posée pour l'empreinte et que l'ADR 0015 reprend mot pour mot :
   un second algorithme exigera une version de format et un ADR, jamais une négociation à
   l'exécution ;
3. **`runtime.minWriter` relevé.** `MIN_WRITER_FORMAT_VERSION` reste 2 — le champ existe depuis v2
   —, mais un volume v3 déclare le runtime qui l'écrit. Un runtime v2 qui rencontre
   `formatVersion: 3` le refuse par `VAULT_MANIFEST_FORMAT_TOO_NEW` : c'est le mécanisme de l'ADR
   0007, inchangé, et c'est ce qui empêche un runtime plus ancien d'écrire en clair dans un volume
   chiffré.

`MIN_READABLE_FORMAT_VERSION` reste **1** : un volume v1 ou v2 se lit, s'exporte et se migre. Il ne
s'ÉCRIT pas — `VAULT_MANIFEST_MIGRATION_REQUIRED` le refuse déjà, et la raison est désormais plus
qu'une version : **un volume v2 n'a ni région d'authentification ni nonce**, si bien qu'un runtime
v3 n'a nulle part où écrire le sceau d'un secteur. Ce n'est pas un refus de politesse, c'est une
absence de place.

## Décision 6 — L'approvisionnement de la clé, et le refus sans clé

L'ADR 0015 réserve à #21 les clés de déverrouillage, l'enveloppe DEK/KEK et la dérivation. #18 ne
les anticipe pas. La règle est donc :

- **la clé est reçue en mémoire** par l'ouvreur unique (`openVolumeForWrite`, et les lecteurs de
  l'ADR 0009/0014), importée non extractible par `importerCleDeVolume`. Elle ne quitte pas le Worker
  de confiance de l'ADR 0002, et rien ici ne l'écrit sur un support ;
- **dans les bancs et les épreuves**, elle est fournie par le **harnais sous jeton**, exactement
  comme l'injecteur d'arrêts de #15 : sous Node, la variable d'environnement du processus ; dans un
  Worker de navigateur, le jeton exact que seule la page du banc transmet.
  `src/vm/cle-de-volume.mjs` porte la garde, et la clé qu'elle rend est une **clé de TEST
  publique**, nommée comme telle, sans entropie et sans valeur ;
- **dans le produit, aucun chemin ne fabrique ni ne persiste une clé de volume.** Un volume v3
  ouvert sans clé est refusé par `VAULT_STORAGE_CLE_REQUISE`, **avant** toute lecture. Rien n'est
  rendu en clair, aucun repli n'est tenté, et le message nomme #21 comme le remède plutôt que de
  laisser l'exploitant deviner.

C'est une limite ASSUMÉE et datée : jusqu'à #21, le produit sait lire et écrire un volume v3 **sous
harnais**, et refuse de le faire autrement. Le dire ainsi vaut mieux que d'inventer une clé de
convenance, qui serait un chiffrement sans secret — c'est-à-dire une promesse fausse.

## Décision 7 — L'archive porte le fichier v3 tel quel

Cette décision tranche la **question n° 6 de l'ADR 0015 pour cette tranche**, et pour elle seule.

**L'archive d'export porte le fichier de volume v3 TEL QUEL — chiffré — et son manifeste v3.**
`verifyArchive` continue de prouver l'intégrité par l'empreinte SHA-256 du fichier ; la restauration
inter-origine recopie les octets sans clé ; la clé n'est nécessaire qu'à l'**ouverture** du volume
restauré. L'archive n'est ni chiffrée davantage ni signée : c'est le jalon 6.

Deux conséquences, à écrire plutôt qu'à découvrir :

1. **L'empreinte porte sur le chiffré.** Deux exports d'un même contenu logique ne sont plus
   comparables par empreinte : les nonces diffèrent, donc les octets diffèrent. C'est voulu, et cela
   retire à l'empreinte un usage qu'elle n'a jamais promis — elle atteste qu'une archive n'a pas été
   abîmée, pas que deux volumes portent le même état ;
2. **une archive restaurée sans sa clé est inerte.** Elle se vérifie, elle se recopie, elle
   s'identifie ; elle ne s'ouvre pas. La sauvegarde d'un volume chiffré est donc une sauvegarde de
   **deux** choses, dont ce dépôt n'en gère qu'une aujourd'hui. C'est la conséquence directe du fait
   que #21 n'est pas fait, et elle sera reprise là-bas.

L'alternative — déchiffrer à l'export — a été écartée : elle annulerait le chiffrement au repos dès
que l'archive quitte l'appareil, ce que l'ADR 0015 nomme déjà comme le mauvais côté de l'échange.

### Cette décision n'est PAS mise en œuvre par cette tranche, et l'export est donc REFUSÉ

Le constat est venu du bout en bout, pas de la lecture. Le chemin d'export lit le volume par la
lecture AUTORISÉE — celle qui déchiffre —, et le chemin de restauration écrit par la voie autorisée
— celle qui rechiffre. Livrés tels quels sur un volume v3, ils auraient produit **une archive en
clair d'un volume chiffré** : le chiffrement au repos annulé dès que le fichier quitte l'appareil,
sans qu'aucun message ne le dise. C'est exactement l'échange que le paragraphe ci-dessus refuse, et
il se serait produit par omission.

**Décision : l'export et la restauration d'un volume v3 sont REFUSÉS**, par
`VAULT_ARCHIVE_VOLUME_CHIFFRE` et `VAULT_IMPORT_VOLUME_CHIFFRE`, jusqu'à ce que la recopie brute
existe. Les deux refus tombent avant le premier octet lu et avant le premier geste mutant, et ils
sont **distincts de `VAULT_STORAGE_CLE_REQUISE`** — qui tombait jusqu'ici sur la restauration et
accusait la clé d'un manque qui est celui du CHEMIN. Une clé n'y changerait rien : c'est la lecture
et l'écriture BRUTES qui manquent, et elles sont l'objet de la tranche (b), #101.

Ce qu'il faudra pour lever le refus, écrit d'avance : une source d'export qui lise le FICHIER (donc
`tailleSupport`, pas `tailleLogique`), une cible de restauration qui le RECOPIE sans passer par la
couche chiffrée, et le réglage de ce que `content.length` et `geometry.volumeSize` désignent alors —
l'ADR 0008 pose déjà la question, et c'est là qu'elle se referme.

## Décision 8 — La migration v2 → v3

Par la chaîne de l'[ADR 0011](0011-migration-de-format-et-reprise.md), sans exception à ses règles :

- **sauvegarde exigée avant** (`migration-backup-proof.mjs`) : la migration réécrit le volume
  entier, et elle est irréversible ;
- **manifeste révoqué** avant la première écriture, réinscrit après relecture. Une migration
  interrompue laisse un volume **non identifié**, donc refusé au boot par
  `VAULT_MANIFEST_UNIDENTIFIED` ;
- **reprise depuis le journal de migration** `<volume>.migration`, comme les étapes précédentes ;
- l'étape v2 → v3 **rechiffre le volume entier** : une lecture en clair, un scellement, une écriture
  de charge et une écriture de sceau par secteur, plus l'agrandissement du fichier de
  `512 + R × 512` octets. Le temps est mesuré et publié dans `docs/quality-attributes.md`, jamais
  estimé.

**Un volume v2 n'est pas inscriptible par un runtime v3 sans migration, et la raison n'est pas
administrative** : il n'a ni région d'authentification ni nonce. Le sceau d'un secteur n'aurait
nulle part où aller. Le refus est donc `VAULT_MANIFEST_MIGRATION_REQUIRED`, et son message le dit.

## Décision 9 — Les refus, et leur traduction

Le modèle lève des `CryptoError` (`VAULT_CRYPTO_*`). Le backend les propage en `StorageError`
cohérentes, parce qu'un appelant du stockage n'a pas à connaître deux familles :

| refus du modèle                     | code de stockage                   | ce que l'exploitant doit faire        |
| ----------------------------------- | ---------------------------------- | ------------------------------------- |
| `VAULT_CRYPTO_SCEAU_REFUSE`         | `VAULT_STORAGE_SCEAU_REFUSE`       | restaurer une sauvegarde              |
| `VAULT_CRYPTO_IDENTITE_INCOHERENTE` | `VAULT_STORAGE_IDENTITE_VOLUME`    | ouvrir le bon volume, ou la bonne clé |
| `VAULT_CRYPTO_REJEU`                | `VAULT_STORAGE_GENERATION_CORRUPT` | restaurer une sauvegarde              |
| `VAULT_CRYPTO_TRONCATURE`           | `VAULT_STORAGE_GENERATION_CORRUPT` | restaurer une sauvegarde              |
| `VAULT_CRYPTO_MELANGE`              | `VAULT_STORAGE_GENERATION_CORRUPT` | restaurer une sauvegarde              |
| `VAULT_CRYPTO_BUDGET_DE_CLE`        | `VAULT_STORAGE_BUDGET_DE_CLE`      | changer de clé de volume (#21)        |
| `VAULT_CRYPTO_ALGORITHME_INCONNU`   | `VAULT_MANIFEST_MALFORMED`         | le manifeste ment sur son algorithme  |

La `CryptoError` d'origine est conservée dans le contexte (`cause`), jamais effacée : un refus de
sécurité qui perdrait sa cause au passage d'une couche ne serait plus qu'une panne.

**Trois règles de conduite** que le backend tient et que les épreuves négatives vérifient :

1. une étiquette qui ne vérifie pas rend **une erreur**, jamais des zéros, jamais un clair partiel ;
2. un secteur d'une autre adresse, d'un autre volume, d'un autre format ou d'une autre génération
   est refusé par le **même** code — l'ADR 0015 dit pourquoi ils sont indiscernables ;
3. une racine refusée refuse la **génération**, et l'ADR 0014 conserve ses états : une génération
   non validée reste `ecartee`, une génération validée mais refusée reste un refus ferme.

**L'oracle de #15 n'est pas modifié.** Il compare l'ancien et le nouveau contenu d'un secteur sur le
**clair** obtenu par le chemin autorisé — c'est-à-dire par la lecture du backend, qui déchiffre —,
jamais sur les octets du support. Un oracle qui comparerait du chiffré classerait « autre » chaque
réécriture d'un même contenu, puisque le nonce change : il mesurerait le nonce, pas la reprise.

## Ce que cette tranche ne fait pas

- **Les contrôles de séquence à l'échelle de la résilience** — rejeu, troncature et mélange
  **observés sur le support** — sont #19. Ce que #18 livre, ce sont les refus du format ; ce que #19
  ajoutera, c'est la conduite du produit face à un support qui recule.
- **Les clés de déverrouillage, l'enveloppe, la récupération** : #21 à #23. Sans elles, la clé de
  volume n'existe que sous harnais.
- **Le chiffrement ou la signature de l'archive et du manifeste** : jalon 6. La décision 7 tranche
  seulement ce que l'archive PORTE, pas ce qu'elle protège.
- **La revue externe** : #20. Les neuf questions de l'ADR 0015 restent ouvertes ; cette tranche en
  documente une (n° 6, pour cette tranche) et en instruit une autre (n° 5, ci-dessous).

## Le lot par appel : proposé, non activé

La question n° 5 de l'ADR 0015 demande si sceller 512 octets à la fois est le bon découpage, puisque
le même volume coûte 32,5 fois moins en un seul appel. Elle est **instruite ici et laissée fermée**,
et l'ordre des deux gestes est le point :

- **le lot n'est activé par aucun chemin de cette tranche.** Le format v3 scelle un secteur à la
  fois, et c'est ce que les vecteurs figent ;
- **il ne s'activera que sur une mesure**, pas sur une intuition. La mesure opposable est
  `npm run test:rythme` contre le budget de reprise de
  l'[ADR 0005](0005-qualification-de-la-reprise.md) : tant que la reprise ne se dégrade pas au-delà
  du bruit, un découpage plus grossier n'achèterait rien et coûterait de la granularité de refus —
  une erreur d'un bit ferait perdre un groupe entier au lieu d'un secteur ;
- **le découpage candidat est nommé d'avance**, pour qu'il ne soit pas improvisé le jour où il
  faudra : la **page hôte de 4 096 octets**, soit 8 secteurs. Elle est déjà l'unité de
  `PAGE_HOTE_OCTETS` dans `generation-format.mjs`, et elle divise le volume applicatif sans reste.
  Son coût est écrit : la granularité de refus passe de 512 à 4 096 octets, et l'accès aléatoire
  d'un secteur isolé lit et déchiffre huit fois trop.

Activer le lot sera un **amendement de cet ADR**, avec la mesure qui le motive et une version de
format s'il change les octets. Il n'est pas activé par défaut, il n'est pas derrière un drapeau, et
il n'existe pas dans le code de cette tranche : une option non mesurée qui traîne finit par être
allumée sans décision.

## Impacts sur les ADR antérieurs

Aucun ADR n'est réécrit ; chacun reçoit un **amendement daté d'une phrase**, qui renvoie ici.

| ADR      | Ce que v3 lui impose                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0007** | `MANIFEST_FORMAT_VERSION = 3` ; `volume.id` et `volume.algorithm` obligatoires à partir de v3 ; un runtime v2 refuse un v3 comme format futur.                                                        |
| **0008** | l'archive porte le fichier v3 **tel quel** (chiffré) ; l'empreinte porte sur le chiffré, donc deux exports d'un même contenu ne sont plus comparables par empreinte.                                  |
| **0011** | une étape v2 → v3 qui **rechiffre le volume entier** et l'agrandit de la région d'authentification, sous l'atomicité et la reprise déjà décidées.                                                     |
| **0014** | le CRC-32 de la racine remplacé par l'étiquette ; l'en-tête de racine de 60 à 136 octets dans le même secteur ; le format du journal de 1 à 2 ; l'enregistrement grossit de **34** octets, pas de 28. |
| **0015** | correction : l'enregistrement de journal **porte sa génération** (décision 2). Le surcoût annoncé de 28 octets devient 34.                                                                            |

## Limites

1. **La clé n'existe que sous harnais.** Le produit refuse un volume v3 sans clé, et rien ne lui en
   fournit une avant #21. `SEC-BLOCK-001` est donc exercé par le PRODUIT et éprouvé de bout en bout,
   mais sous une clé de test — ce qui prouve le format, pas la confidentialité en exploitation.
2. **L'en-tête v3 n'est pas authentifié.** Son altération produit un refus, jamais une lecture
   erronée, et c'est tout ce que cette tranche promet.
3. **Le retour arrière d'un secteur reste indétecté**, et le retour arrière complet aussi. L'ADR
   0015 les nomme ; v3 ne les traite pas et ne prétend pas le contraire.
4. **Un enregistrement de région chevauchant deux secteurs peut être déchiré**, et le secteur
   correspondant devient alors illisible. Le format promet un refus, pas une lecture.
5. **Le coût est mesuré sur une machine et un moteur.** Les mesures de cette tranche sont relevées
   dans `docs/quality-attributes.md` avec leur environnement ; elles ne remplacent pas un relevé de
   référence.
6. **Aucune borne mémoire nouvelle n'est promise.** Le rescellement d'un enregistrement travaille
   sur son clair entier ; le parcours de la charge garde la fenêtre glissante de #91, mais le rejeu
   tient un enregistrement à la fois, et un enregistrement peut être grand.

## Alternatives rejetées

- **Entrelacer le sceau avec chaque secteur (546 octets par secteur).** Déjà rejeté par l'ADR 0015 :
  casse l'alignement de `block-geometry.mjs` et la recopie alignée du point de contrôle.
- **Un quatrième fichier voisin `<volume>.auth`.** Déjà rejeté par l'ADR 0015 : une atomicité entre
  deux fichiers là où un handle et une barrière suffisent.
- **Authentifier l'en-tête v3 sous la clé de volume.** Rejeté : il faudrait connaître l'identifiant
  de volume pour vérifier l'en-tête qui le porte. Le manifeste tranche l'écart, et une altération ne
  produit qu'un refus.
- **Stocker la longueur PHYSIQUE de la charge dans la racine, à côté de la longueur logique.**
  Rejeté : deux grandeurs stockées peuvent diverger, une grandeur dérivée ne le peut pas.
- **Rendre le rang d'un secteur du volume égal à quelque chose.** Rejeté : le modèle l'épingle à
  zéro (`RANG_SECTEUR_DE_VOLUME`), et le stocker coûterait cinq octets par secteur pour une
  information constante.
- **Vider le journal à chaque validation** pour rendre vraie la phrase de l'ADR 0015 sur la
  génération d'un enregistrement. Rejeté : supprime le point de contrôle amorti de l'ADR 0014.
- **Fabriquer une clé de volume à la création, faute de #21.** Rejeté : une clé que le produit
  fabrique et persiste à côté du volume est un chiffrement sans secret. Le refus typé dit la vérité
  ; une clé de convenance mentirait.
- **Activer le lot par appel « puisque la mesure de l'ADR 0015 montre un facteur 32,5 ».** Rejeté :
  cette mesure porte sur le CPU d'un banc, pas sur la reprise du produit. Le seuil qui décide est
  celui de l'ADR 0005, et il n'a pas été franchi.
- **Comparer les volumes sur le chiffré dans l'oracle de #15.** Rejeté : le nonce étant tiré, deux
  écritures du même contenu diffèrent toujours. L'oracle mesurerait le nonce.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

1. `npm run test:rythme` montre que la reprise se dégrade au-delà du bruit face au budget de l'ADR
   0005, auquel cas le lot par appel est instruit avec sa mesure, sa granularité de refus et sa
   version de format ;
2. le surcoût d'espace de 6,64 % devient un problème mesuré de quota (`storage-budget.mjs`), auquel
   cas la question est celle de la taille du volume applicatif, pas celle du sceau ;
3. #21 livre une enveloppe dont la forme exige que la clé arrive autrement qu'en mémoire à
   l'ouverture ;
4. #19 établit qu'un contrôle de séquence exige un champ que la racine v3 ne porte pas, auquel cas
   la réserve du secteur de racine (376 octets libres) l'accueille sous une version de format ;
5. la revue externe (#20) tranche la question n° 2 (arbre de Merkle sur le volume) par
   l'affirmative, auquel cas la région d'authentification devient le support naturel de son état.
