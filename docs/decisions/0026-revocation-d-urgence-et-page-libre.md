# ADR 0026 — La révocation d'urgence retire tout sauf l'emplacement qui ouvre, et la page libre est effacée

- Statut : accepté
- Date : 2026-09-06
- Issues : #148 (tranche 2 de #23), #156 · Invariants : `SEC-KEY-001`, `SEC-RECOVERY-001` · Jalon 5

## Contexte

L'[ADR 0020](0020-enveloppe-de-cle.md) livre cinq opérations sur `<volume>.cles`, dont
`revoquer(emplacement)` : elle retire UN emplacement et fait avancer le compteur d'une version.

Le geste que l'urgence demande n'est pas celui-là. « Une de mes clés est compromise, et je ne sais
pas laquelle » se traduit par **« retire tout sauf celle que je tiens »** — c'est-à-dire, avec les
cinq opérations, N−1 mutations, N−1 barrières et N−2 états intermédiaires. Chacun de ces états est
un rang où une coupure laisse une révocation PARTIELLE : la clé de l'adversaire a survécu au geste
qui devait la retirer, et rien ne dit à l'utilisateur que le geste n'est pas allé au bout.

Deuxième fait, apporté par la revue de crypto de la PR #155 et posé en #156 : **la page LIBRE
gardait les octets de l'emplacement retiré.** L'alternance de deux pages, qui donne l'atomicité,
conserve exprès l'état d'avant ; une révocation n'en réécrit qu'une, et l'autre portait
l'emplacement révoqué jusqu'au geste d'enveloppe suivant.
L'[ADR 0025](0025-moyen-de-recuperation.md) l'a accepté comme limite (§ Limites 2) en renvoyant la
décision ici.

Le constat a été **reproduit avant d'être corrigé**, et il s'est révélé plus large que ce que #156
énonçait. #156 nommait « paramètres publics, sel, identifiant » ; l'exécution montre que la **DEK
enveloppée** et l'**étiquette** du scellement subsistaient elles aussi, verbatim, dans les seize
mille trois cent quatre-vingt-quatre octets du fichier :

```text
identifiant    : SUBSISTE dans les 16 384 octets
parametres     : SUBSISTE dans les 16 384 octets
dekEnveloppee  : SUBSISTE dans les 16 384 octets
etiquette      : SUBSISTE dans les 16 384 octets
```

Ce qui manquait à #155 pour le voir tient en une phrase : son épreuve cherchait les seuls
PARAMÈTRES. Une fouille qui ne cherche qu'un champ mesure ce champ, pas la révocation.

## Décision 1 — Une sixième opération : `revoquerToutSauf`, et l'emplacement conservé est celui qui OUVRE

```js
revoquerToutSauf({ support, identifiantVolume, kek, aleas });
// → { version: n + 1, nombreEmplacements: 1 }
```

**Il n'y a PAS de paramètre `identifiantEmplacement`, et c'est la décision.** L'emplacement conservé
est celui que la KEK présentée ouvre. On ne garde pas un emplacement qu'on ne sait pas ouvrir : ce
serait la seule façon de sortir d'une urgence avec une enveloppe dont on a perdu la clé, et surtout
la seule façon de **conserver par mégarde l'emplacement de l'adversaire** — un identifiant se lit
dans l'inventaire public, il ne prouve rien de ce qu'on détient. « Tout sauf celui que je tiens »
est littéral, et la signature le rend indépassable.

`lireEtat` rendait déjà l'emplacement qui a ouvert (`identifiantEmplacement`, depuis #21) ; `muter`
le passe à `transformer`. Aucun champ nouveau, aucune lecture supplémentaire.

**Si DEUX emplacements partagent la même KEK, celui de plus bas rang est conservé.** C'est
déterministe — `developperDansLaPage` retient le premier qui ouvre, en parcourant la liste entière
sans court-circuit — et inatteignable en production, où l'info HKDF d'un dérivateur lie
l'identifiant d'emplacement (ADR 0021), si bien que deux emplacements ne partagent jamais une KEK.
C'est atteignable au HARNAIS, qui pose la KEK telle quelle : le comportement est donc écrit et
éprouvé plutôt que laissé à découvrir. _Constat de la revue de la PR #158._

**Un seul `muter` : une page écrite, une barrière.** L'atomicité est celle de l'ADR 0020, sans rien
de neuf. L'état après est : version + 1, un seul emplacement, page réécrite entière avec son
remplissage à zéro.

**Un seul emplacement déjà présent est ADMIS**, et le geste écrit tout de même. Il n'y a rien à
retirer, mais l'effacement de la décision 2 a lieu, et c'est précisément ce qu'une urgence veut.
Refuser ici ferait dépendre l'issue du geste d'un état que l'appelant d'urgence n'a pas à connaître.
`VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` ne s'applique pas : ce geste ne peut pas vider l'enveloppe, il
en laisse toujours exactement un.

**Aucun code de refus nouveau.** Une KEK qui n'ouvre pas rend `VAULT_ENVELOPPE_CLE_REFUSEE`, comme
toute autre mutation, et le refus reste indiscernable de celui d'une clé inconnue.

## Décision 2 — #156 tranché : la page libre est EFFACÉE, après la barrière

Pour `revoquerEmplacement`, `revoquerToutSauf` **et** `remplacerEmplacement` — toute mutation qui
RETIRE une clé —, l'ordre est :

```text
  1. écrire la page neuve, sur la page qui ne fait pas autorité
  2. barrière            ← elle publie ; l'état neuf est durable
  3. écrire 8192 zéros sur la page qui vient de perdre l'autorité
  4. barrière
```

**Ce qu'une coupure laisse, à chaque rang, et pourquoi l'ordre est celui-là :**

| coupure         | ce qui reste                                                      | conséquence                               |
| --------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| avant le rang 1 | page ancienne intacte et autoritaire                              | tous les emplacements ; rien n'est retiré |
| pendant 1       | page neuve déchirée, écartée par CRC ou racine ; ancienne intacte | tous les emplacements                     |
| au rang 2       | page neuve complète, publiée                                      | le seul emplacement retenu                |
| pendant 3       | page ancienne déchirée, écartée ; page neuve intacte              | le seul emplacement retenu                |
| au rang 4       | page ancienne à zéro, page neuve seule valide                     | le seul emplacement retenu                |

**Avant la première barrière**, l'ancien état est intact et autoritaire : rien ne change à la
matrice de coupures de l'ADR 0020 — l'enveloppe porte tous les emplacements, ou le seul retenu,
jamais un sous-ensemble. **Après la première barrière**, la page neuve est complète et durable : la
page ancienne n'est plus un point de reprise, et l'effacer ne retire donc aucune protection. Une
coupure pendant l'effacement laisse une page déchirée que `lireEtat` écarte déjà par sa somme de
contrôle et sa racine, au profit de la neuve.

**Les mutations qui ne retirent RIEN n'effacent pas.** `creer` et `ajouter` paieraient une écriture
et une barrière pour rien, et retireraient au geste SUIVANT le point de reprise que l'alternance lui
offre. `remplacer`, lui, retire bien une clé — laisser l'ancien scellement dans la page libre ferait
de la rotation d'une clé compromise un geste qui ne retire rien pendant une mutation entière.

**« Créer ne retire rien » se lit dans son cas nominal, et pas au-delà.** `creerEnveloppe` sur un
fichier `.cles` DÉJÀ présent laisse la seconde page intacte : `allouer` est un `truncate`, sans
effet à taille égale. L'enveloppe d'un volume précédent y survit donc, avec ses DEK enveloppées. Le
fait précède #148 et n'est pas corrigé ici — aucun chemin du produit ne crée une enveloppe
par-dessus une autre, puisqu'un volume est retiré avec ses voisins (ADR 0020, décision 1) — mais il
est nommé pour que la règle ne se relise pas plus large qu'elle n'est. _Constat de la revue de la PR
#158 ; l'inventaire qui ne confronte pas l'identifiant de volume est suivi dans l'issue #159._

### Ce qu'une coupure ENTRE les deux barrières laisse, et qu'aucune réparation ne rejoue

L'effacement n'est **pas atomique avec la publication**, et il n'a pas à l'être : la page ancienne
n'est plus un point de reprise. Mais si la session s'arrête entre la barrière qui publie et
l'écriture des zéros, **rien ne rejoue l'effacement**.

La promesse exacte est donc celle-ci, et non « entre les deux barrières » : **la page libre est
effacée après chaque retrait ; si une coupure survient entre la barrière qui publie et la seconde,
la page ancienne reste lisible JUSQU'À LA MUTATION SUIVANTE, qui la réécrit ; aucune réparation
n'est jouée à l'ouverture.**

**Pourquoi aucune réparation à l'ouverture.** Ouvrir une enveloppe est une LECTURE. Y ajouter une
écriture ferait écrire tout ouvreur, y compris celui qui n'a qu'à lire — et **déplacerait la fenêtre
sans la fermer**, puisque la réparation elle-même peut être coupée. Une réparation au début de
`muter` ne servirait à rien non plus : `publier` réécrit déjà la page libre ENTIÈRE, remplissage
compris, et c'est précisément ce qui referme la fenêtre.

Ce que la coupure ne touche PAS, et c'est mesuré : la **serrure**. Aucune clé retirée n'ouvre — la
page neuve fait autorité, et `lireEtat` ne replie pas sur la précédente quand la clé y est refusée.
Ce qui subsiste est de la matière pour le retour arrière de support de la limite 5, pas une clé qui
fonctionne. L'épreuve `vm-enveloppe-revocation-urgence.test.mjs` › « LIMITE : une coupure ENTRE les
deux barrières… » fixe les trois faits dans cet ordre : la serrure tient, les octets restent, la
mutation suivante les emporte.

_Constat de la revue de la PR #158, le 6 septembre 2026._

### Ce que l'effacement ne promet PAS : « fait, non garanti »

La promesse porte sur le **FICHIER tel que le produit le relit**, pas sur le support. Un système de
fichiers à copie sur écriture, un SSD qui remappe ses blocs, un instantané de volume pris entre les
deux barrières peuvent conserver les anciens octets sans que rien ici ne puisse l'empêcher ni même
l'observer. C'est un « fait, non garanti », dans les termes de la décision 7 de
l'[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md), et `SECURITY.md` le porte sous cette
forme dans sa liste « non couvert » — l'entrée 11 (9 jusqu'à #149) est RÉÉCRITE, pas retirée : la
fenêtre est celle de la section précédente, plus ce que le support conserve.

## Décision 3 — Révoquer ne RECHIFFRE pas, et c'est écrit là où on le lira

Une révocation retire une KEK. Elle **ne change pas la clé de volume**. Qui détient une copie de
`<volume>` et une page ANTÉRIEURE de `<volume>.cles` développe toujours la même DEK, et lit toujours
le volume tel qu'il était.

**La révocation protège le fichier à venir, pas la copie déjà prise.** La seule parade est la
rotation de la clé de volume : elle est hors périmètre,
l'[ADR 0015](0015-proprietes-cryptographiques-du-format.md) et
l'[ADR 0016](0016-format-de-volume-v3-dispositions.md) en donnent le coût — 87,6 s pour rechiffrer
512 Mio — et aucun chemin du produit ne l'offre. Cette limite est écrite ici, dans `SECURITY.md`
(entrées 7, 8 et 9 de la liste « non couvert ») et au § 11 de `docs/format-de-volume-v3.md`.

## La matrice de coupures, étendue

`tests/unit/vm-enveloppe-coupures.test.mjs` balaie quatre sinistres — coupure avant l'effet, coupure
après l'effet, déchirure DANS l'en-tête, déchirure à mi-page — à chaque rang de chaque opération.
Deux entrées s'y ajoutent :

| Épreuve                                         | Ce qu'elle classe à chaque rang                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **RÉVOQUER TOUT SAUF**, sur quatre emplacements | la clé conservée ouvre ; les trois autres ouvrent TOUTES ou AUCUNE — jamais un sous-ensemble          |
| **EFFACEMENT**, aux rangs 3 et 4                | la clé conservée ouvre à la version NEUVE, et la révoquée est refusée : l'effacement ne recule jamais |

L'épreuve d'effacement **mesure le nombre de gestes** au lieu de le supposer : une révocation en
porte exactement quatre. Sans ce relevé, les rangs de l'effacement seraient une convention que le
premier remaniement démentirait en silence — et c'est aussi ce qui tue la mutation « la seconde
barrière est franchie » (voir ci-dessous).

## La campagne de mutation

`node tools/muter-gardes-revocation-urgence.mjs`. Huit gardes, huit tuées — **mais pas du premier
passage, et c'est le n° 5 qui l'a appris.**

| #   | Garde mutée                                   | Verdict | Ce qui la tue                                                        |
| --- | --------------------------------------------- | ------- | -------------------------------------------------------------------- |
| 1   | l'emplacement conservé est celui qui a OUVERT | tuée    | « l'emplacement conservé est celui que la KEK a OUVERT »             |
| 2   | l'effacement vient APRÈS la barrière          | tuée    | la matrice de coupures : l'ancien état est détruit avant le neuf     |
| 3   | l'effacement porte sur la page ENTIÈRE        | tuée    | « la page libérée est mise à ZÉRO en ENTIER » et la fouille d'octets |
| 4   | la SECONDE barrière est franchie              | tuée    | le COMPTE DES GESTES de la matrice — voir ci-dessous                 |
| 5   | un SEUL emplacement est ADMIS, jamais refusé  | tuée    | « un SEUL emplacement présent est ADMIS »                            |
| 6   | une RÉVOCATION efface la page libérée         | tuée    | 2 épreuves, dont celle du type 4 de l'ADR 0025                       |
| 7   | un REMPLACEMENT efface la page libérée        | tuée    | « l'ancien emplacement RETIRÉ ne laisse pas ses octets »             |
| 8   | un AJOUT n'efface RIEN                        | tuée    | « AJOUTER n'efface RIEN : il ne retire aucune clé »                  |

**La n° 5 était comptée tuée sans mesurer sa garde.** Son remplacement ouvrait une accolade sans la
fermer : le fichier muté ne se LISAIT plus, et le moteur — qui compte tout code de sortie non nul
pour une mise à mort — le déclarait mort quelle que soit l'épreuve rejouée, y compris une qui
n'approche pas la garde. Le score annoncé au premier passage, « 8/8 », valait **7/8**. La revue de
la PR #158 l'a démonté par un `node --check` sur chaque fichier muté ; le mutant réécrit meurt
réellement, sur `VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` levé depuis `muter`.

C'est la leçon de la mutation n° 8 de l'ADR 0020, dans l'autre sens : là-bas, une mutation qui
SURVIT devait d'abord être soupçonnée elle-même ; ici, une mutation qui TUE trop vite. Les deux
moitiés se rejoignent — **un verdict de mutation ne dit quelque chose de la garde que si la mutation
décrit encore un programme.** `tools/moteur-de-mutation.mjs` porte désormais cette troisième garde à
côté des deux qu'il avait déjà (« l'épreuve passait-elle AVANT ? », « l'enfant a-t-il rendu un
verdict ? ») : un mutant qui ne se lit plus est NON APPLICABLE, jamais tué, et une épreuve du moteur
le prouve sur un mutant volontairement cassé. Les deux campagnes antérieures ont été rejouées sous
le moteur corrigé sans perdre un mutant : récupération 16/16, instantané 13/13.

**La n° 4 a demandé une épreuve qu'aucune assertion d'état ne pouvait porter.** Le double de support
modélise la VISIBILITÉ des écritures, pas leur DURABILITÉ : sa barrière est un geste sans effet, et
retirer `await support.barriere()` ne change pas un octet du fichier. Toute épreuve écrite sur
l'état d'après aurait laissé ce mutant vivant. Ce qui le tue est le compte des gestes. C'est le
second service d'une campagne de mutation : elle ne dit pas seulement « il manque une épreuve »,
elle dit parfois « la seule épreuve possible n'est pas celle que vous alliez écrire ».

Le moteur de campagne est extrait dans `tools/moteur-de-mutation.mjs` : la table de #148 en aurait
été la troisième copie. `tools/muter-gardes-instantane.mjs` (#65) garde la sienne — la déplacer sans
que sa tranche y touche ferait porter à #148 un remaniement qu'aucune de ses épreuves ne couvre.

## Mesures

Le surcoût de la décision 2 est **une écriture de 8192 octets et une barrière par révocation**. Il
est chronométré sur l'**OPFS RÉEL**, dans le Worker du banc d'enveloppe
(`tests/browser/enveloppe-frontiere.spec.mjs` › « le coût de l'effacement… est MESURÉ »), 30 tours,
deux exécutions. Rien d'autre n'est dans la boucle : ni cryptographie, ni scellement de racine.

| Moteur   | exécution |     p50 |     p95 |     max |
| -------- | --------- | ------: | ------: | ------: |
| Chromium | 1         | 2,50 ms | 3,40 ms | 3,50 ms |
| Chromium | 2         | 2,40 ms | 3,60 ms | 20,0 ms |
| Firefox  | 1         | 32,0 ms | 37,0 ms | 37,0 ms |
| Firefox  | 2         | 33,0 ms | 46,0 ms | 48,0 ms |

**Firefox paie treize fois plus cher que Chromium**, et le chiffre est publié tel quel plutôt
qu'arrondi vers le confortable. Il reste néanmoins deux ordres de grandeur sous le scellement d'un
volume de 512 Mio (87,6 s, ADR 0016) et trois sous le boot à froid de l'application de référence
(162 s au p95, ADR 0005) : une révocation d'urgence n'est pas un geste de boucle chaude.

**Ce que ces chiffres ne disent pas.** La résolution de `performance.now()` est bridée par les deux
moteurs pour des raisons de confidentialité — d'où les millisecondes entières de Firefox. L'écart
est très au-dessus de ce bridage, la précision des chiffres eux-mêmes ne l'est pas. Et aucun seuil
n'est GARDÉ : l'épreuve publie le chiffre sans le plafonner ; un plafond relevé sur la machine d'un
contributeur ferait rougir la CI d'un autre sans rien dire du produit.

## Limites

1. **Révoquer ne rechiffre pas.** Voir la décision 3. C'est la limite principale de cette tranche,
   et elle est structurelle : aucune révocation d'enveloppe ne peut atteindre une copie déjà prise ;
2. **L'effacement est « fait, non garanti ».** Voir la décision 2. Le support peut conserver les
   anciens blocs, et le produit ne l'observe pas ;
3. **Une coupure entre les deux barrières laisse la page ancienne lisible jusqu'à la mutation
   suivante.** Voir la décision 2. Aucune réparation n'est jouée à l'ouverture, et c'est délibéré :
   une ouverture est une lecture. La limite 2 de l'ADR 0025 est donc **RÉDUITE**, pas levée — le
   chemin nominal ne laisse plus rien, le chemin coupé laisse la page jusqu'au geste suivant ;
4. **La durabilité de la seconde barrière n'est pas éprouvée.** Aucune épreuve de ce dépôt ne coupe
   le courant. Ce que le produit tient est ce que le moteur promet de
   `FileSystemSyncAccessHandle.flush` ; les épreuves mesurent l'ORDRE des gestes, pas leur effet sur
   un disque débranché ;
5. **Le retour arrière COMPLET du support n'est pas détecté** — limite 1 de l'ADR 0020, inchangée.
   L'effacement de la page libre rend le retour arrière PARTIEL impossible ; il ne fait rien contre
   qui remet en place une copie entière et cohérente du fichier. `versionMinimale` reste le point où
   un ancrage monotone se branchera ;
6. **Aucune interface n'offre ce geste.** Comme les cinq autres opérations : le seul appelant hors
   épreuves est le banc. C'est #24 ;
7. **La mesure porte sur deux moteurs et une machine.** WebKit ne sert pas OPFS synchrone dans un
   Worker (`docs/compatibility.md`), et l'épreuve y exige un refus typé au lieu d'un chiffre.

## Impacts sur les ADR antérieurs

Aucun ADR n'est réécrit ; chacun reçoit une note datée qui renvoie ici.

| ADR      | Ce que cette tranche lui impose                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0020** | la décision 4 compte désormais **six** opérations, pas cinq ; et la règle de remplissage (« une révocation réécrit la page entière ») s'étend à la page LIBÉRÉE, pas seulement à la publiée. |
| **0021** | rien de nouveau : la formule « fait, non garanti » de sa décision 7 est reprise telle quelle pour l'effacement.                                                                              |
| **0025** | sa limite 2 (« la page LIBRE garde la version précédente ») est RÉDUITE au seul chemin coupé, pas levée ; sa limite 6 (« le geste composé n'existe pas ») est LEVÉE.                         |

## Alternatives rejetées

- **Exiger une SECONDE mutation avant d'annoncer la révocation achevée** (option 2 de #156). Rejeté
  : rien à écrire de neuf, mais une promesse en deux temps. « Votre clé est révoquée, faites encore
  un geste quelconque pour que ce soit vrai » n'est pas une promesse qu'un produit peut tenir devant
  un utilisateur en urgence — et l'oubli du second geste est le cas NORMAL, pas l'exception.
- **N−1 révocations en boucle, dans une fonction de commodité.** Rejeté : c'est exactement l'état
  que #148 doit supprimer. Une boucle ne change rien aux N−2 états intermédiaires ; elle les cache.
- **Un paramètre `identifiantEmplacement` pour désigner ce qu'on garde.** Rejeté : voir la
  décision 1. Un identifiant se lit dans l'inventaire public et ne prouve rien de ce qu'on détient.
- **Un journal d'intention pour rendre l'effacement atomique avec la publication.** Rejeté pour la
  raison de l'ADR 0020 : un fichier voisin de plus, ses règles de reprise et son format, pour un
  effacement qui n'a besoin d'aucune atomicité — la page effacée n'est plus un état auquel on se
  fie.
- **Effacer la page libre à CHAQUE mutation.** Rejeté : `creer` et `ajouter` ne retirent rien. Ils
  paieraient une écriture et une barrière pour rien, et priveraient le geste suivant du point de
  reprise que l'alternance lui offre.
- **Écraser la page libre avec des octets ALÉATOIRES plutôt qu'avec des zéros.** Rejeté : sur un
  support à copie sur écriture, l'un ne vaut pas mieux que l'autre, et des zéros sont vérifiables
  par une épreuve en une somme. Promettre davantage par la forme du remplissage serait un ornement.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

1. la seconde écriture et sa barrière deviennent un coût MESURÉ qui gêne un usage réel — auquel cas
   l'effacement devient différé ou optionnel, et la promesse de `SECURITY.md` est réécrite avec lui
   ;
2. un ancrage monotone hors du fichier apparaît (limite 1 de l'ADR 0020), auquel cas le retour
   arrière complet cesse d'être hors de portée et la valeur relative de l'effacement change ;
3. une rotation de clé de volume devient praticable, auquel cas la décision 3 cesse d'être une
   limite et « révoquer » peut enfin promettre quelque chose sur les copies déjà prises ;
4. un moteur de la matrice #2 offre une primitive d'effacement sûr (`truncate` + réallocation
   garantie sans réutilisation de blocs), auquel cas la limite 2 peut être resserrée sur ce moteur.
