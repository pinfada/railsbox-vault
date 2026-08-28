# ADR 0020 — L'enveloppe de clé vit hors du volume, en deux pages alternées, et une révocation retire l'emplacement

- Statut : accepté
- Date : 2026-08-28
- Issue : #21 · Invariants : `SEC-KEY-001`, `SEC-ORIGIN-001` · Jalon 5

## Contexte

Depuis #18 ([ADR 0016](0016-format-de-volume-v3-dispositions.md)), un volume est scellé sous une
**clé de volume** — une DEK de trente-deux octets tirés — que le produit reçoit en mémoire et ne
sait ni fabriquer ni conserver. Hors harnais, un volume v3 est refusé faute de clé
(`VAULT_STORAGE_CLE_REQUISE`). L'ADR 0016 le dit sans détour : « une clé que le produit fabriquerait
et rangerait à côté du volume serait un chiffrement sans secret ».

#21 pose l'**enveloppe** qui rend cette clé récupérable sans jamais la rendre lisible : une ou
plusieurs clés de déverrouillage (KEK) enveloppent la DEK, et ajouter, remplacer ou révoquer une KEK
ne touche pas un octet des blocs. Les moyens d'OBTENIR une KEK — phrase secrète étirée, PRF WebAuthn
— sont #22 ; la récupération et sa révocation d'urgence sont #23. Cet ADR livre le format, ses
opérations et ses refus, sous une KEK fournie par le harnais, exactement comme la DEK l'est depuis
#18.

Il ne prend **aucune décision cryptographique nouvelle** : primitive, nonce, longueur d'étiquette,
budget de clé, injectivité des encodages et ordre des vérifications restent ceux de
l'[ADR 0015](0015-proprietes-cryptographiques-du-format.md), et le modèle de référence reste la
spécification. Il décide **où les octets vivent**, **comment une mutation reste atomique**, et
**quels refus sont rendus**.

Deux de ses décisions ont été corrigées par l'exécution, et elles sont écrites ici comme telles : la
règle d'autorité entre les deux pages (§ « La règle de repli ») et la somme de contrôle de page (§ «
Pourquoi un CRC-32 revient »). Les deux défauts ont été trouvés par des épreuves écrites avant
l'implémentation, pas par relecture.

## Décision 1 — Le fichier `<volume>.cles`, dans l'origine de confiance

L'enveloppe est un **quatrième voisin** du volume, à côté du manifeste (#10), du journal de
migration (#13) et du journal de génération (#16) :

```text
  vault-volumes/<volume>            le volume chiffré (ADR 0016)
  vault-volumes/<volume>.manifest   le manifeste (ADR 0007)
  vault-volumes/<volume>.gen        le journal de génération (ADR 0014)
  vault-volumes/<volume>.cles       l'enveloppe de clé (cet ADR)
```

Il vit sur l'**origine de confiance**, jamais sur l'origine applicative : c'est la topologie de
l'[ADR 0002](0002-topologie-origine-de-confiance.md), et le stockage OPFS y est partitionné par
origine. Le document applicatif ne peut donc pas le lire, et il ne reçoit rien de son contenu par le
port restreint — c'est l'extension de `SEC-ORIGIN-001` que cette tranche mesure.

Le suffixe `.cles` fait cinq caractères, moins que `.migration` : `MAX_VOLUME_NAME` se déduit du
plus long suffixe réservé, et l'ajouter **ne rétrécit aucun nom de volume déjà admissible**. Comme
les trois autres, il est refusé comme nom de volume, et il est **retiré avec le volume** : une
enveloppe qui survivrait à son volume ne protégerait plus rien, et un volume neuf du même nom y
trouverait un fichier de clés nommant un autre identifiant — refusé, mais après avoir laissé croire
qu'une clé existait.

**Pourquoi pas dans le fichier de volume.** Un volume est servi octet pour octet à v86 ; y
intercaler quoi que ce soit décalerait le système de fichiers du guest. C'est la raison qui a déjà
exilé le manifeste et les deux journaux, et elle vaut ici sans changement.

**Pourquoi pas dans le manifeste.** Le manifeste est lu par des chemins qui n'ont aucune affaire
avec les clés — compatibilité, migration, vérification d'archive — et il est reporté TEL QUEL dans
l'archive d'export. Y loger des DEK enveloppées les ferait sortir de l'appareil par le premier
export venu, sans qu'aucune décision ne soit prise.

## Décision 2 — La disposition : deux pages de 8192 octets, taille fixe

```text
  offset 0      page A   8192 octets
  offset 8192   page B   8192 octets
```

Une page :

| offset | largeur | champ                                           |
| ------ | ------: | ----------------------------------------------- |
| 0      |       8 | marqueur `VLTKEY01`                             |
| 8      |       4 | version du format d'enveloppe (1)               |
| 12     |       2 | nombre d'emplacements — **authentifié**         |
| 14     |       2 | réserve, à zéro                                 |
| 16     |       8 | compteur de version, monotone — **authentifié** |
| 24     |      16 | identifiant de volume — **authentifié**         |
| 40     |       4 | longueur de la liste, en octets                 |
| 44     |      12 | nonce de la racine                              |
| 56     |      32 | empreinte scellée des emplacements              |
| 88     |      16 | étiquette de la racine                          |
| 104    |       4 | CRC-32 de la page                               |
| 108    |     ... | liste ordonnée des emplacements, puis des zéros |

Un emplacement :

| offset | largeur | champ                                     |
| ------ | ------: | ----------------------------------------- |
| 0      |       8 | identifiant d'emplacement                 |
| 8      |       1 | type de clé de déverrouillage             |
| 9      |       1 | réserve, à zéro                           |
| 10     |       2 | longueur des paramètres publics           |
| 12     |      12 | nonce                                     |
| 24     |      32 | **DEK enveloppée**                        |
| 56     |      16 | étiquette                                 |
| 72     |     ... | paramètres publics du dérivateur, opaques |

Les entiers du CONTENEUR sont petit-boutistes, comme l'en-tête v3 et le reste des en-têtes sur
disque du dépôt ; ceux des données ASSOCIÉES sont gros-boutistes, comme tous les encodages
canoniques de l'ADR 0015. C'est le même partage qu'en v3, et il n'est pas rejugé ici.

**Le fichier ne change jamais de taille.** Il est alloué en une fois à la création. Un fichier qui
grandirait ou rétrécirait pendant une écriture offrirait un troisième état — ni l'ancien, ni le
nouveau — que rien ne relirait.

**Le plafond est de HUIT emplacements**, et chaque emplacement porte au plus 512 octets de
paramètres publics. Le pire cas tient donc en 4776 octets, très en deçà de la page. Huit couvre
l'usage visé — une phrase secrète, deux ou trois passkeys, un ou deux moyens de récupération (#23),
et de la place pour une rotation — et borne le COÛT DU REFUS : l'ouverture essaie tous les
emplacements sans court-circuit (décision 4), et ce travail est payé à chaque tentative. Le franchir
demandera une version de format, pas une tolérance.

## Décision 3 — Ce que le scellement lie : AES-256-GCM, jamais AES-KW

Chaque emplacement enveloppe la DEK par **AES-256-GCM sous la KEK**, avec en données associées :

```text
  étiquette de domaine « railsbox-vault/enveloppe/v1/emplacement »
  nom de l'algorithme
  version de format
  identifiant de VOLUME
  identifiant d'EMPLACEMENT
  type de clé de déverrouillage
  paramètres publics du dérivateur (longueur préfixée)
```

Chaque champ est de largeur fixe ou préfixé de sa longueur : deux identités distinctes ne peuvent
pas rendre la même chaîne d'octets. C'est la condition posée par l'ADR 0015, et
`vm-enveloppe-modele.test.mjs` l'éprouve champ par champ.

**AES-KW est refusé.** C'est pourtant l'algorithme d'enveloppement de clé de WebCrypto, et il est
tentant. Il n'authentifie **aucune** donnée associée : une DEK enveloppée sous AES-KW serait
déplaçable d'un emplacement à l'autre et d'un volume à l'autre sans que rien ne bronche. C'est
exactement la propriété que cette tranche doit tenir. L'ADR 0015 l'écartait en une ligne ; ici la
ligne décide, et une épreuve d'architecture relit la décision
(`AUCUN module de l'enveloppe n'emploie AES-KW`).

**Le type et les paramètres publics entrent dans les données associées**, au-delà de ce que le
contrat de #21 exigeait. La raison est propre à #22 : les paramètres d'une dérivation par phrase
secrète — sel, coût mémoire, coût temps — vivront en clair dans l'emplacement. Non authentifiés, un
adversaire ayant accès au fichier pourrait les ramener à un coût dérisoire, garder une copie du
fichier et le casser à bas prix ; l'utilisateur, lui, ne verrait qu'un échec d'ouverture. Les lier
coûte zéro octet et ferme la question avant qu'elle ne se pose.

### La racine, et pourquoi le COMPTE est authentifié mais pas la LONGUEUR

Le fichier entier porte une **racine authentifiée sous la DEK** : l'empreinte SHA-256 de la suite
canonique ORDONNÉE des emplacements est le CLAIR, et l'en-tête — identifiant de volume, version de
format, compteur de version, nombre d'emplacements — est les DONNÉES ASSOCIÉES. C'est l'ordre de
l'ADR 0015, transposé : **vérifier d'abord, classer ensuite.** Un verdict de troncature, de mélange
ou d'autre volume posé sur un en-tête que rien ne garantit serait une devinette.

La longueur de la liste, elle, vit dans l'en-tête sur disque **hors** des données associées, et cet
écart est le mécanisme du refus de troncature : un adversaire qui retire un emplacement peut
rectifier la longueur, pas le compte. L'étiquette vérifie donc, et c'est APRÈS qu'on constate que
deux emplacements étaient authentifiés là où un seul est présent. Le verdict est établi.

L'encodage canonique porte, par emplacement, son identifiant, son type, ses paramètres, son nonce et
son **étiquette** — jamais la DEK enveloppée. La raison est celle de l'encodage des entrées de l'ADR
0015 : sous une même clé, un même nonce et une même identité, deux chiffrés distincts partageant une
étiquette constituent une forgerie GCM. La racine dit QUELS emplacements composent l'enveloppe et
dans quel ordre ; chaque emplacement dit qu'il est intact. Aucune des deux vérifications ne remplace
l'autre.

## Décision 4 — Les cinq opérations, et leur atomicité

`creer(dek, kek0)`, `ouvrir(kek) → dek`, `ajouter(kekNouvelle)`,
`remplacer(emplacement, kekNouvelle)`, `revoquer(emplacement)`.

**Les quatre mutations exigent d'avoir OUVERT l'enveloppe.** Une enveloppe n'est pas un trousseau
ouvert en écriture : c'est un état signé par la clé qu'elle protège, et sans la DEK on ne peut pas
sceller une racine.

**L'atomicité vient de l'alternance des deux pages**, et non d'un fichier temporaire renommé ni d'un
journal. Un écrivain écrit TOUJOURS la page qui ne fait pas autorité, puis franchit la barrière ;
c'est la barrière qui publie. Une coupure ne peut donc abîmer que la page qui ne faisait pas
autorité.

| Construction                       | Pourquoi elle est écartée                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fichier temporaire + renommage** | suppose un renommage atomique ET disponible. `FileSystemFileHandle.move` n'est pas servi par les trois moteurs de la matrice #2, et l'ADR 0016 refuse déjà une atomicité entre DEUX fichiers là où un handle et une barrière suffisent. |
| **Journal d'intention**            | un cinquième fichier voisin, ses règles de reprise et son propre format, pour un état qui tient en quatre kilo-octets.                                                                                                                  |
| **Deux pages alternées** (retenue) | exactement ce que l'ADR 0014 fait déjà pour la racine de génération. Un seul fichier, un seul handle, une seule barrière.                                                                                                               |

**L'ordre à la création d'un volume est décidé, pas laissé au hasard : l'enveloppe est écrite et sa
barrière franchie AVANT que le volume n'existe.** Une coupure laisse alors au pire une enveloppe
orpheline — seize kilo-octets qui ne protègent rien. L'ordre inverse aurait laissé un volume
qu'aucune clé n'ouvre, c'est-à-dire le sinistre même que #21 doit empêcher.

**Révoquer le DERNIER emplacement est refusé** (`VAULT_ENVELOPPE_DERNIER_EMPLACEMENT`). Un volume
dont toutes les clés sont révoquées est un volume perdu, et perdre des données ne doit jamais être
le résultat d'un seul geste réussi. La sortie de cet état est la récupération, qui est #23.

**Une révocation RETIRE l'emplacement et réécrit la page entière, remplissage à zéro compris.** Une
révocation qui laisserait ses octets derrière elle — la DEK enveloppée d'une clé retirée, encore
lisible dans la queue de la page — ne serait pas une révocation.

## Décision 5 — Le déverrouillage est une COUCHE au-dessus de l'ouvreur unique

`src/vm/ouverture-par-enveloppe.mjs` lit le manifeste, en retient l'identifiant de volume, ouvre
l'enveloppe sous cet identifiant, puis appelle `openVolumeForWrite` INCHANGÉ avec la clé développée.
**Aucune ligne de `opfs-volume-ouverture.mjs` ni de `opfs-volume-open.mjs` n'est modifiée par #21.**
C'est délibéré : la tranche #19 travaille en parallèle sur la génération et l'ouverture, et une
tranche de clés qui déplacerait leurs gestes rendrait les deux irrelisables.

L'identifiant attendu vient du **manifeste**, jamais de l'enveloppe : sans deux sources réellement
distinctes, confronter l'enveloppe à elle-même ne prouverait rien. Le manifeste est la source,
l'en-tête v3 en porte une copie que l'ouvreur confronte déjà, l'enveloppe en porte une troisième que
cette couche confronte ici.

La clé développée est **effacée** dès que l'ouverture est rendue. Ce n'est pas une garantie — un
moteur peut avoir copié le tampon — c'est une fenêtre refermée, et elle est gratuite. Ce qui est
garanti est ailleurs : aucune fonction de cette couche ne RETOURNE la clé de volume, aucune ne la
journalise, et aucune ne la met dans un message vers l'origine applicative.

**Compatibilité.** Un volume v3 sans fichier d'enveloppes reste ouvrable par le harnais, sous jeton,
comme avant. Dans le produit il est refusé par `VAULT_ENVELOPPE_ABSENTE` — un code DISTINCT de
`VAULT_ENVELOPPE_CLE_REFUSEE`. Dire « clé invalide » à qui n'a jamais eu d'enveloppe envoie chercher
une clé qui n'existe pas au lieu d'en créer une.

## Décision 6 — L'archive n'emporte pas l'enveloppe

L'archive d'export (#12, ADR 0008/0016) porte le fichier de VOLUME tel quel. Elle ne porte **ni le
manifeste de clés, ni une DEK enveloppée, ni un octet du fichier `.cles`**. Deux épreuves le
tiennent : l'une exporte réellement et cherche le marqueur `VLTKEY01` et des octets d'emplacement
dans l'archive ; l'autre relit le chemin d'export et d'import et exige qu'aucun de ses modules ne
connaisse le voisin d'enveloppe.

**La conséquence doit être dite à l'utilisateur, pas découverte par lui** : la sauvegarde d'un
volume chiffré est la sauvegarde de DEUX choses, et ce dépôt n'en emporte qu'une. Perdre
l'enveloppe, c'est perdre l'archive. `SECURITY.md` le porte déjà pour la clé de #18 ; #21 ne fait
que déplacer l'objet de la phrase. La question « l'archive devrait-elle porter une enveloppe de
récupération ? » est POSÉE à #23, pas tranchée ici : y répondre par l'affirmative sans les codes de
secours reviendrait à mettre dans le même fichier le coffre et sa clé.

## Les deux corrections trouvées par exécution

### La règle de repli — une révocation ne révoquait rien

La première écriture retenait, parmi les deux pages, celle de plus grande version **qui s'ouvrait
sous la clé présentée**. `vm-enveloppe-operations.test.mjs` l'a réfutée en trois lignes : après une
révocation, la page PRÉCÉDENTE porte toujours l'emplacement révoqué, elle est parfaitement valide,
et la clé révoquée l'ouvrait. L'alternance, qui donne l'atomicité, conserve exprès l'état d'avant —
et un déverrouillage qui accepte l'état d'avant annule toute mutation de sécurité.

La règle correcte distingue deux natures de refus sur la page la plus récente :

- **`VAULT_ENVELOPPE_CLE_REFUSEE`** — la page est cohérente et signée, la clé n'y a pas
  d'emplacement. C'est l'ÉTAT COURANT, et il dit non. **Aucun repli** : refuser ici est le sens même
  d'une révocation ;
- **tout autre refus** — racine qui ne vérifie pas, liste tronquée, réordonnée, autre volume. La
  page n'est pas un état auquel on puisse se fier ; c'est ce qu'une coupure laisse derrière elle, et
  l'on retombe sur la page précédente. C'est là, et là seulement, que l'alternance opère.

### Pourquoi un CRC-32 revient, alors que l'ADR 0016 l'a justement retiré

L'ADR 0016 retire le CRC de la racine de génération : là, une étiquette AES-GCM est vérifiable au
même moment, et elle est strictement meilleure. Ici elle ne l'est pas — vérifier l'étiquette d'une
racine d'enveloppe exige la DEK, qu'on ne peut obtenir qu'en développant un emplacement de la page,
c'est-à-dire APRÈS avoir décidé que cette page est celle qu'il faut lire.

Sans somme de contrôle, le lecteur ne distingue donc pas une page COMPLÈTE d'une page DÉCHIRÉE. Le
défaut n'est pas théorique : `vm-enveloppe-coupures.test.mjs` l'a produit en coupant une écriture à
quarante octets. La page portait alors l'en-tête NEUF au-dessus de la liste ANCIENNE, elle se
décodait sans broncher, elle paraissait être l'état courant, et une clé parfaitement légitime s'y
voyait refusée sans repli — **une coupure faisait perdre une clé.** Le CRC-32 rend cette page
structurellement invalide, donc écartée, donc suivie du repli qui la couvre.

Ce qu'il ne fait pas est écrit aussi : **il ne protège contre aucun adversaire.** Qui peut écrire
dans l'origine de confiance le recalcule sans effort. Il sépare l'accident de l'écriture complète,
exactement comme dans l'ADR 0014, et rien de plus.

La même mesure a réfuté une déchirure « à mi-page » comme instrument : la liste d'une enveloppe
ordinaire tient dans les premières centaines d'octets, si bien que couper à 4096 écrit la page neuve
ENTIÈRE et que le sinistre devient un synonyme de « coupure après ». La matrice porte donc deux
points de déchirure, dont un DANS l'en-tête.

## Refus typés

| Code                                  | Ce qu'il dit                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `VAULT_ENVELOPPE_ABSENTE`             | il n'y a pas d'enveloppe. Le remède est d'en créer une, jamais d'essayer une autre clé.  |
| `VAULT_ENVELOPPE_ILLISIBLE`           | un fichier existe, aucune page n'est exploitable. Le remède est une sauvegarde.          |
| `VAULT_ENVELOPPE_CLE_REFUSEE`         | aucun emplacement ne s'ouvre sous cette clé. Couvre clé inconnue ET emplacement révoqué. |
| `VAULT_ENVELOPPE_RACINE_REFUSEE`      | l'étiquette de la racine ne vérifie pas. Modification et déplacement, indiscernables.    |
| `VAULT_ENVELOPPE_IDENTITE`            | la racine authentifiée décrit un AUTRE volume. Constat établi.                           |
| `VAULT_ENVELOPPE_TRONCATURE`          | le nombre d'emplacements trouvés diffère du nombre authentifié.                          |
| `VAULT_ENVELOPPE_MELANGE`             | le compte est juste, l'empreinte de la suite ordonnée ne l'est pas.                      |
| `VAULT_ENVELOPPE_REJEU`               | version authentique mais antérieure au minimum exigé.                                    |
| `VAULT_ENVELOPPE_MALFORME`            | structure inadmissible. Jamais complétée ni arrondie.                                    |
| `VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` | révoquer la dernière clé laisserait un volume sans issue.                                |
| `VAULT_ENVELOPPE_PLEINE`              | le plafond d'emplacements est atteint.                                                   |
| `VAULT_ENVELOPPE_EMPLACEMENT_INCONNU` | l'emplacement visé n'existe pas ; il a peut-être déjà été révoqué.                       |

### Le refus de clé est UN, et le nom de l'issue n'est pas retenu

Le contrat de #21 nommait ce refus `VAULT_CLE_EMPLACEMENT_REVOQUE` tout en exigeant qu'une clé
INCONNUE rende un refus indiscernable de celui d'une clé RÉVOQUÉE. Les deux exigences ne tiennent
pas ensemble : un code qui affirme « révoqué » à qui présente une clé qui n'a jamais eu
d'emplacement énonce une cause que le format ne peut pas établir. C'est précisément le mensonge de
diagnostic que l'ADR 0015 refuse (« la cause n'est pas établie »), et ce dépôt ne l'écrit nulle part
ailleurs.

Le code retenu est donc `VAULT_ENVELOPPE_CLE_REFUSEE`, **unique pour les deux situations**, et son
champ `situations` les NOMME toutes les deux sans les départager. L'exigence de fond —
l'indiscernabilité — est tenue, et elle est mesurée ; c'est le nom qui change.

Publier deux codes obligerait d'ailleurs à conserver une trace des clés révoquées, c'est-à-dire à
répondre « oui, cette clé a existé » à qui la présente : un oracle offert à quiconque essaie des
clés. Une révocation RETIRE l'emplacement, et il ne reste rien qui puisse dire « celle-ci fut
valable ».

### Ce qui est mesuré de l'indiscernabilité, et ce qui ne l'est pas

**Mesuré** : le nombre d'invocations de `SubtleCrypto.decrypt`. L'ouverture essaie TOUS les
emplacements sans court-circuit, si bien qu'une clé révoquée et une clé inconnue font exactement le
même nombre d'appels sur le même fichier. `vm-enveloppe-operations.test.mjs` les compte, et
l'égalité est l'assertion.

**Non mesuré, et non promis** : le temps d'horloge. Ce dépôt ne maîtrise ni l'implémentation de
WebCrypto, ni les effets de cache, ni l'ordonnancement du moteur. La mesure ci-dessous montre
d'ailleurs qu'un SUCCÈS et un REFUS ne prennent pas le même temps — le succès ajoute la vérification
de la racine —, et cela n'a pas à être caché : réussir ou échouer est déjà connu de celui qui
présente la clé. Ce qui doit rester indiscernable, ce sont les deux ÉCHECS entre eux.

## Mesures

`node tools/mesurer-enveloppe.mjs`, Node v24.14.0, win32 x64, 200 tours, support en mémoire — la
mesure porte sur la cryptographie, pas sur le disque. Pire cas mesuré exprès : enveloppe PLEINE, clé
au DERNIER emplacement.

| Geste                                   | médiane |     p95 |     max |
| --------------------------------------- | ------: | ------: | ------: |
| ouvrir — un seul emplacement            | 0,23 ms | 0,52 ms | 0,95 ms |
| ouvrir — 8 emplacements, clé au dernier | 1,06 ms | 1,75 ms | 2,86 ms |
| refus — 8 emplacements, clé inconnue    | 0,58 ms | 1,10 ms | 1,68 ms |
| créer                                   | 0,27 ms | 0,59 ms | 0,93 ms |
| ajouter puis révoquer (deux mutations)  | 2,39 ms | 3,20 ms | 4,73 ms |

**Négligeable, et le mot est justifié plutôt qu'affirmé** : le boot à froid de l'application de
référence se compte en dizaines de secondes (ADR 0005, p95 mesuré à 162 s), et le scellement d'un
volume neuf de 512 Mio en 87,6 s (ADR 0016). Une milliseconde de déverrouillage est quatre à cinq
ordres de grandeur en dessous.

**Ce que ces chiffres ne disent pas** : le coût de #22. Dériver une KEK d'une phrase secrète par
Argon2id est DÉLIBÉRÉMENT coûteux, et dominera de plusieurs ordres de grandeur tout ce qui est
mesuré ici. La mesure de #21 porte sur l'enveloppe seule, une KEK étant déjà en main.

## Limites

1. **Le retour arrière complet du fichier n'est pas détecté.** Qui peut écrire dans l'origine de
   confiance peut remettre une version antérieure des DEUX pages, et ressusciter ainsi une clé
   révoquée. `ouvrir` accepte une attente `versionMinimale` — c'est le point où un ancrage monotone
   se branchera —, mais **aucun ancrage hors du fichier n'existe avant #23**, et rien ne le fournit
   aujourd'hui. C'est la même limite que l'ADR 0015 nomme pour le volume, appliquée aux clés.
2. **Effacer la page courante fait retomber sur la précédente.** C'est le prix de l'alternance, il
   est le même que celui de la racine de l'ADR 0014, et il se confond avec la reprise après coupure.
   Un adversaire qui peut écrire dans l'origine peut donc dégrader l'enveloppe d'une version.
3. **Le fichier révèle, en clair, le nombre de clés d'un volume et leur nature.** C'est un canal
   auxiliaire assumé : un dérivateur doit pouvoir lire ses paramètres avant de dériver quoi que ce
   soit. Il ne révèle ni la DEK, ni une KEK, ni rien qui permette de les deviner.
4. **La KEK n'existe que sous harnais.** Comme la DEK depuis #18, et pour la même raison : les
   dérivateurs sont #22. `SEC-KEY-001` est donc EXERCÉ par le produit — l'enveloppe est réelle, ses
   opérations et ses refus le sont —, sous des clés de TEST. Ce qui manque n'est pas le mécanisme,
   c'est la façon dont un humain obtient sa clé.
5. **Le modèle et le chemin de production partagent les encodeurs canoniques.** Les vecteurs figés
   prouvent que les opérations assemblent les bons objets et que la DISPOSITION est juste — l'outil
   qui les fige pose les octets lui-même, sans appeler `encoderPage` —, mais ils ne prouvent pas que
   deux transcriptions indépendantes des DONNÉES ASSOCIÉES s'accordent. C'est la même limite qu'aux
   ADR 0015 et 0016, nommée ici plutôt que reconduite en silence.
6. **La mesure porte sur un moteur et une machine.** Node sur une machine de développement. Les
   trois moteurs de navigateur ne sont pas chronométrés ; l'épreuve de frontière, elle, y tourne.
7. **Le CRC-32 ne protège contre aucun adversaire.** Voir plus haut. Il sépare l'accident de
   l'écriture complète.

## Impacts sur les ADR antérieurs

Aucun ADR n'est réécrit ; chacun reçoit un amendement d'une phrase, qui renvoie ici.

| ADR      | Ce que l'enveloppe lui impose                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0002** | un quatrième voisin de volume vit sur l'origine de CONFIANCE, et n'est jamais atteignable depuis l'origine applicative.                                  |
| **0008** | l'archive ne porte PAS l'enveloppe (décision 6) ; restaurer une archive ne restaure pas la capacité de l'ouvrir.                                         |
| **0014** | l'alternance de deux pages validée par une barrière est reprise telle quelle, pour un autre objet que la racine de génération.                           |
| **0015** | l'enveloppe emploie les mêmes primitives et le même ordre de vérification ; `AES-KW`, écarté en une ligne, l'est ici pour une raison qui décide.         |
| **0016** | la clé de volume cesse d'être uniquement « reçue en mémoire » : elle est désormais RÉCUPÉRABLE par une KEK, sans que le produit ne la persiste en clair. |

## Alternatives rejetées

- **Loger l'enveloppe dans le manifeste.** Rejeté : le manifeste part dans l'archive, et les clés
  seraient sorties de l'appareil sans décision.
- **Loger l'enveloppe dans la réserve de l'en-tête v3.** Rejeté : 448 octets, quand un seul
  emplacement en fait 72 et que le plafond en demande 4776. Et l'en-tête n'est pas authentifié.
- **`AES-KW` pour l'enveloppement de clé.** Rejeté : aucune donnée associée authentifiée. Voir
  décision 3.
- **Un fichier temporaire renommé.** Rejeté : `move` n'est pas servi par les trois moteurs, et l'ADR
  0016 refuse déjà une atomicité entre deux fichiers.
- **Conserver un emplacement révoqué avec une marque « révoqué ».** Rejeté deux fois : ce serait un
  oracle pour qui essaie des clés, et les octets de la DEK enveloppée survivraient à la révocation.
- **Court-circuiter la boucle d'essai dès qu'un emplacement s'ouvre.** Rejeté : le nombre de
  tentatives dirait alors quel emplacement a répondu, et distinguerait les deux échecs.
- **Rendre l'identifiant d'emplacement STABLE à travers un remplacement.** Rejeté : un nom stable
  pour deux secrets successifs empêcherait les données associées de distinguer l'ancienne enveloppe
  de la nouvelle.
- **Faire remonter la DEK jusqu'à l'appelant de la couche de déverrouillage.** Rejeté : la couche
  rend un backend, jamais une clé. Une épreuve le vérifie sur la valeur rendue.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

1. #22 démontre qu'un dérivateur exige plus de 512 octets de paramètres publics, ou qu'un type de
   KEK demande un champ que l'emplacement ne porte pas ;
2. #23 livre un ancrage monotone hors du fichier, auquel cas `versionMinimale` cesse d'être une
   attente facultative et devient une exigence ;
3. #23 tranche que l'archive doit porter une enveloppe de récupération, auquel cas la décision 6 est
   amendée avec le format de cette enveloppe et ce qu'elle suppose des codes de secours ;
4. un moteur de la matrice #2 sert un renommage atomique sur OPFS, auquel cas l'alternance de pages
   peut être réexaminée — sans urgence, puisqu'elle fonctionne ;
5. le plafond de huit emplacements devient une gêne mesurée, auquel cas il monte sous une version de
   format et la borne du coût de refus est recalculée.
