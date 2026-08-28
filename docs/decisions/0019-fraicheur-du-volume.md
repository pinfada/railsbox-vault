# ADR 0019 — La racine date la région d'authentification, et un témoin voisin date la séquence : le retour arrière partiel devient visible, le retour arrière complet reste nommé

- Statut : accepté
- Date : 2026-08-28
- Issue : #19 · Invariant : `SEC-GEN-001` · Jalon 4

## Contexte

L'[ADR 0015](0015-proprietes-cryptographiques-du-format.md) a écrit cinq propriétés et les a
éprouvées sur un modèle de référence. L'[ADR 0016](0016-format-de-volume-v3-dispositions.md) les a
posées sur le disque. `SECURITY.md` disait pourtant, sans le masquer, que `SEC-GEN-001` restait
**non exercé par le produit**, et pour une raison précise :

> les contrôles de SÉQUENCE, eux, ne sont présentés par aucun chemin : `generationMinimale` et
> `sequenceMinimale` valent `null` partout.

Autrement dit, `ouvrirRacine` savait dire `VAULT_CRYPTO_REJEU` et personne ne le lui demandait
jamais. Les deux refus de rejeu de #18 étaient du **code mort**, et rien dans l'outillage ne le
signalait — un `null` en dur ne casse aucune épreuve.

L'ADR 0015 nommait par ailleurs trois formes de retour arrière et n'en détectait qu'une :

| Forme                                                         | Après #18 | Après #19               |
| ------------------------------------------------------------- | --------- | ----------------------- |
| Rejeu d'une racine ou d'un bloc **au sein d'une session**     | **non**   | **oui** — décision 1    |
| Retour arrière d'un **secteur** du volume, hors journal       | **non**   | **oui** — décision 2    |
| Retour arrière **complet** du support entre deux sessions     | **non**   | **non**, et c'est écrit |
| Retour arrière **partiel** : le volume recule, son voisin non | **non**   | **oui** — décision 3    |

La quatrième ligne n'existait pas dans l'ADR 0015. Elle est la contribution propre de cet ADR :
entre « la session tient son minimum en mémoire » et « le support entier a reculé, et rien ne le
voit », il y a un cas intermédiaire — le volume et son journal reculent, ce qui les entoure reste —
et c'est celui-là que #19 ferme.

## Décision 1 — Les planchers sont PRÉSENTÉS, et un plancher oublié est refusé

`parcourirCharge` exige désormais deux attentes, et `undefined` est refusé :

- **`sequenceMinimale`**, présentée à `ouvrirRacine`. À la reprise, elle vient du TÉMOIN
  (décision 3) ; ensuite, elle vaut la séquence que la session a elle-même validée. Une racine
  authentique mais antérieure est refusée par `VAULT_CRYPTO_REJEU` — sur un en-tête déjà
  authentifié, donc ÉTABLI et non deviné ;
- **`generationPlancher`**, présenté à `ouvrirBloc` pour chaque enregistrement. Dans une charge, la
  suite des générations est **croissante au sens large** — `deposer` scelle sous « génération
  validée + 1 », la génération validée ne recule pas dans une session, et les enregistrements sont
  ajoutés dans l'ordre. Le plancher d'un enregistrement est donc la plus grande génération vue avant
  lui. En session, le plancher de relecture vaut « génération de reprise + 1 », parce que toute
  récupération se termine par un vidage : le journal ne porte plus que ce que cette session y a mis.

**`null` reste admis, mais il doit s'écrire.** C'est la règle que le modèle de référence applique
déjà à ses attentes depuis l'ADR 0015 — « une valeur pour contrôler, ou `null` pour déclarer
qu'aucun contrôle n'est demandé, mais jamais un oubli » —, et cette tranche montre pourquoi elle
vaut aussi pour les dépendances : c'est un `null` par défaut, pas un `null` décidé, qui avait laissé
`SEC-GEN-001` inerte pendant toute la durée de #18.

**Le seul `null` qui subsiste sur un chemin de production** est l'ouverture du témoin lui-même. Il
est nommé ici plutôt que remplacé par un plancher de zéro, qui ne refuserait aucun témoin
authentique et serait donc décoratif. Ce qui contrôle le témoin est la confrontation de sa SÉQUENCE
à celle de la racine, faite par `ouvrirRacine` sur un en-tête authentifié.

**Ce que la décision 1 ajoute, et ce qu'elle n'ajoute pas.** Le plancher de génération d'un
enregistrement recouvre partiellement l'empreinte des entrées, qui refuserait elle aussi une
substitution — mais en la classant `VAULT_CRYPTO_MELANGE`, et seulement après avoir relu la charge
entière. Le plancher refuse **plus tôt** et **nomme juste** : un enregistrement authentique d'une
génération antérieure est un rejeu, et le ranger dans « mélange » dirait vrai sur l'ensemble et faux
sur la cause.

## Décision 2 — La racine scelle une EMPREINTE de la région d'authentification

### Le défaut, tel que l'ADR 0015 le décrit

Un secteur du volume est ouvert sous une identité que le lecteur ne connaît pas d'avance : il lit sa
**génération** dans la région d'authentification, juste à côté du nonce et de l'étiquette du même
secteur. Le sceau et l'identité viennent donc du **même endroit**. Un adversaire qui remet en place
le quadruplet complet d'une version antérieure du même secteur — chiffré, nonce, étiquette,
génération — produit un ensemble cohérent, et le lecteur l'accepte. Le tirage du nonce n'y change
rien : il garantit l'unicité, pas la fraîcheur.

### La décision

**La racine de génération scelle une empreinte SHA-256 de la région d'authentification entière**, et
l'ouverture la confronte à la région relue **avant toute lecture de secteur**.

« Ailleurs » est le mot qui porte la décision : l'autorité vient du journal, pas du volume. Un
secteur ramené en arrière change son sceau, donc la région, donc l'empreinte.

- **Où elle vit** : dans la réserve du secteur de racine. L'ADR 0016 l'avait prévu et nommé — « la
  réserve du secteur de racine (376 octets libres) l'accueille sous une version de format ». La
  racine passe de 136 à **202 octets** dans le même secteur ; le format du journal passe de 2 à
  **3**.
- **Ce qu'elle porte** : le sceau de l'empreinte (nonce 12 + étiquette 16 + génération 6) puis son
  chiffré (32), soit 66 octets. C'est la même forme de sceau que partout ailleurs dans le format —
  deux encodages du même objet finissent toujours par diverger.
- **Elle est RESCELLÉE à chaque écriture de racine, sous la génération de cette racine.** Ce n'est
  pas une précaution de style : sans cela, une empreinte authentique mais scellée sous une
  génération antérieure pourrait être épissée dans une racine récente, et la région d'hier passerait
  pour celle d'aujourd'hui. La confrontation présente donc `generationMinimale = racine.generation`,
  et le refus est un `VAULT_CRYPTO_REJEU` établi.
- **Elle n'est REHACHÉE que si le volume a été écrit** depuis la dernière. Le seul geste qui écrit
  le volume est le point de contrôle — le rejeu d'une génération à l'ouverture en est un. Une
  session paie donc une lecture de région quand une racine fait autorité à l'ouverture, pour la
  confrontation, puis une par rangement ; sur un volume qui NAÎT, où aucune racine ne fait encore
  autorité, la première tombe à la première racine écrite. Les racines intermédiaires rescellent
  l'empreinte en cache — un chiffrement de 32 octets, pas un hachage de 34 Mio.

### Ce que la décision 2 couvre, et ce qu'elle ne couvre pas

**Couvert.** Le retour arrière d'un **secteur** du volume, hors journal : quadruplet complet remis
en place, à la bonne adresse, dans le bon volume. L'épreuve
`tests/unit/vm-generation-fraicheur.test.mjs` le rejoue et démontre les deux moitiés du fait : le
secteur remis en place **reste authentique** — le chemin non transactionnel le rend sans broncher —
et l'ouverture transactionnelle le refuse tout de même.

**Non couvert.**

- Le contenu du volume **entre deux points de contrôle** : la région ne bouge pas tant que rien
  n'est rangé, et l'empreinte non plus. Ce que le journal couvre pendant ce temps, c'est la racine
  qui le dit ; ce que le volume porte est l'état du dernier rangement, et il est daté.
- Un adversaire qui **recule le volume, son journal et son témoin ensemble** : voir la décision 3.
- L'**en-tête v3**, toujours non authentifié (ADR 0016, limite 2). Il localise, il n'autorise pas.
- Le champ de **version du journal** n'est pas dans les données associées de la racine : un octet
  retourné y fait passer une racine de format 3 pour une racine de format 2. Le décodeur refuse
  désormais ce cas — une racine qui se dit sans fraîcheur au-dessus d'octets de fraîcheur non nuls
  ment quelque part — et le témoin ferme le reste (décision 3). C'est une garde de cohérence, pas
  une authentification, et la nuance est écrite plutôt que gommée.

### Compatibilité : un volume v3 scellé par #18 reste ouvrable, et migre à sa première racine

**Décision : lire les deux formats, n'écrire que le plus récent.**

Un volume scellé par #18 porte une racine de format 2, sans empreinte. Ce runtime la décode, la rend
avec `fraicheur: null` — jamais une empreinte de zéros, qui serait une empreinte comme une autre —,
et ne prétend **aucune** fraîcheur pour cette ouverture-là : le rapport d'ouverture publie
`fraicheurRegion: "migree"`.

**La migration n'est pas un geste d'exploitation, et elle ne demande pas la chaîne de l'ADR 0011.**
Toute récupération se termine par un **vidage**, qui écrit une racine neuve — donc de format 3, donc
porteuse de l'empreinte. La fenêtre sans fraîcheur dure exactement **une ouverture**, celle qui
migre. C'est la raison pour laquelle l'option « refuser un volume de format 2 » a été écartée : elle
aurait exigé une migration explicite pour une propriété que la simple réouverture acquiert, et rendu
irouvrable un volume parfaitement sain.

**Ce que cette fenêtre laisse ouvert**, et il faut le dire : pendant cette unique ouverture, un
secteur ramené en arrière n'est pas détecté. C'est exactement l'état de #18, ni meilleur ni pire, et
il ne se reproduit pas — le témoin refuse ensuite toute racine qui reperdrait son empreinte
(`fraicheurDesarmee`).

Ce runtime **n'écrit jamais** de racine de format 2. Un magasin ouvert sans source de région — un
banc, un outil de mesure — doit le DÉCLARER (`fraicheur: null`), et son rapport le publie ; le
constructeur refuse l'oubli.

## Décision 3 — Un TÉMOIN de dernière séquence vue, voisin du volume

`<volume>.temoin` est un quatrième fichier voisin, à côté du manifeste (#10), du journal de
migration (#13) et du journal de génération (#16). Il porte la dernière séquence vue, **scellée sous
la clé du volume**, et il est :

- **écrit APRÈS la racine et sa barrière**, jamais avant. L'ordre est le contrat. Une coupure entre
  les deux laisse un témoin **en retard** : un plancher en retard sous-détecte, il ne refuse jamais
  à tort. L'ordre inverse laisserait un témoin **en avance**, c'est-à-dire un volume intact refusé.
  `tests/vm/resilience-fraicheur.spec.mjs` coupe dans cette fenêtre exacte, sur OPFS réel, et le
  verdict est écrit d'avance ;
- **retiré avec le volume**, comme le journal de génération — et retiré aussi par tout geste qui
  RÉÉCRIT le volume entier : la restauration (#12) et la migration (#13). Un témoin survivant
  attesterait, pour un volume homonyme créé ensuite ou pour un volume réécrit depuis une archive,
  une séquence que celui-ci n'a jamais atteinte : la prochaine ouverture refuserait un volume sain,
  et le message désignerait un retour arrière qui n'a pas eu lieu. Le défaut a été trouvé en revue
  de cette tranche, sur des chemins que rien n'obligeait à y penser ; la règle est donc écrite ici
  plutôt que laissée à la vigilance — **un témoin ne date que le volume qu'il accompagne** ;
- **absent = première ouverture, jamais une preuve.** C'est le point où la nuance se perd le plus
  facilement, et il est écrit dans le code au même endroit que la valeur de retour.

**Ce que le scellement du témoin achète, exactement** : un témoin forgé — une séquence inventée par
qui n'a pas la clé — est refusé au lieu d'être cru. Cela ne rend pas le témoin monotone ; cela évite
seulement qu'un tiers sans clé fabrique un refus permanent en y inscrivant une séquence démesurée.

**Deux refus de plus, qui n'existaient pas :**

- un journal **sans aucune racine** sous un témoin présent. Le témoin ne s'écrit qu'après une racine
  et sa barrière : son existence prouve qu'une racine a été durable, et son absence du journal est
  un recul, pas un volume neuf ;
- une racine **sans empreinte** sous un témoin qui en atteste une. Une propriété acquise ne se
  reperd pas ; cet état décrit un retour à une racine d'avant #19.

### La limite, écrite sans détour

**Un retour arrière qui emporte AUSSI le témoin n'est pas détectable.** Le témoin vit dans la même
origine que le volume. Il ne renforce pas la frontière de
l'[ADR 0002](0002-topologie-origine-de-confiance.md) ; il rend visibles les reculs **partiels**.

**Et l'effort n'est PAS symétrique**, ce qu'une formule du genre « qui peut reculer l'un peut
reculer l'autre » laisserait croire à tort. Reculer le volume suppose d'en détenir une copie
antérieure — volume et journal cohérents entre eux. Neutraliser le témoin ne suppose rien de tel :
**le supprimer, ou simplement le tronquer, suffit — et sans la clé.** `ouvrirTemoin` ne juge un
fichier témoin que sur son marqueur et sa longueur ; un fichier absent, vide ou trop court n'est pas
un témoin, et l'ouverture repart alors sur « première ouverture », c'est-à-dire sans plancher de
séquence. Un adversaire qui détient une copie antérieure de volume + journal n'a donc pas à forger
quoi que ce soit : il lui suffit d'effacer huit octets pour **réarmer la fenêtre du retour arrière
complet**.

**Ce comportement n'est pas changé, et il ne doit pas l'être** : « témoin absent = première
ouverture, jamais une preuve » reste la bonne règle. L'inverse — refuser tout volume sans témoin —
rendrait irouvrable tout volume neuf, tout volume restauré depuis une archive et tout volume dont le
témoin a été perdu par un incident de support, c'est-à-dire échangerait une détection qu'on n'a pas
contre une perte de données qu'on aurait. Ce qui manque n'est pas une garde de plus sur le témoin :
c'est l'**ancre monotone hors du support**, sans laquelle aucun état local n'a d'autorité sur sa
propre fraîcheur. **La question de l'ancrage est renvoyée nommément à #23.**

La détection du retour arrière complet exige une **ancre monotone hors du support** — un compteur
matériel, un témoin distant, un service tiers de fraîcheur. L'ADR 0015 a instruit le seul candidat
sérieux du navigateur (`authenticatorData.signCount` de WebAuthn) et l'a écarté pour trois raisons
cumulées : CTAP2 le rend facultatif, la plupart des authentificateurs de plateforme rendent zéro, et
l'employer supposerait une décision de #21 sur le déverrouillage. **La question est renvoyée
nommément à #21 et #23**, et d'ici là le retour arrière complet reste couvert par le seul
partitionnement d'origine de l'ADR 0002.

Cette limite n'est pas seulement écrite : elle est **exécutée**. La dernière assertion de
`tests/unit/vm-generation-fraicheur.test.mjs` ramène le volume, son journal ET son témoin à un état
antérieur, rouvre, et constate que le volume s'ouvre — et que la seconde écriture a disparu sans que
personne puisse le voir. Une limite qu'aucune épreuve ne montre finit par être oubliée.

## Décision 4 — Les refus, leur propagation et leur conduite

Le tableau de l'ADR 0016 (décision 9) est étendu, et sa règle est conservée : trois façons pour une
génération de ne plus concorder retombent sur un seul code de stockage, parce que le remède est le
même, et la CAUSE les distingue dans le contexte.

| refus                                      | code de stockage                   | `cause`                   | conduite (ADR 0006)                      |
| ------------------------------------------ | ---------------------------------- | ------------------------- | ---------------------------------------- |
| racine ou bloc antérieur au plancher       | `VAULT_STORAGE_GENERATION_CORRUPT` | `VAULT_CRYPTO_REJEU`      | restaurer une sauvegarde                 |
| génération incomplète ou augmentée         | `VAULT_STORAGE_GENERATION_CORRUPT` | `VAULT_CRYPTO_TRONCATURE` | restaurer une sauvegarde                 |
| entrée d'une autre génération              | `VAULT_STORAGE_GENERATION_CORRUPT` | `VAULT_CRYPTO_MELANGE`    | restaurer une sauvegarde                 |
| région relue ≠ empreinte scellée           | `VAULT_STORAGE_GENERATION_CORRUPT` | `VAULT_FRAICHEUR_REGION`  | restaurer une sauvegarde                 |
| racine sans empreinte sous un témoin actif | `VAULT_STORAGE_GENERATION_CORRUPT` | `VAULT_FRAICHEUR_REGION`  | restaurer une sauvegarde                 |
| journal sans racine sous un témoin         | `VAULT_STORAGE_GENERATION_CORRUPT` | `VAULT_TEMOIN_SEQUENCE`   | restaurer une sauvegarde                 |
| région illisible pendant le hachage        | `VAULT_STORAGE_SHORT_READ`         | —                         | réessayer, puis diagnostiquer le support |

**Aucun code de stockage nouveau n'est créé, et c'est délibéré.** L'ADR 0006 fait dépendre la
conduite du REMÈDE, pas du diagnostic ; six causes qui appellent toutes « restaurer une sauvegarde »
ne justifient pas six conduites. La cause est conservée dans le contexte — un refus de sécurité qui
perdrait sa cause en changeant de couche ne serait plus qu'une panne.

**L'oracle de #15/#16 n'est pas modifié.** Ces refus surviennent à l'OUVERTURE, avant toute lecture
de secteur : le volume n'est pas ouvert, aucun bloc n'est rendu, et l'oracle ne classe donc jamais
un tel volume `ancien`. `tests/vm/resilience-fraicheur.spec.mjs` l'établit sur OPFS réel — une
coupure pendant l'empreinte laisse le volume `ancien` **et intact**, pas un état à moitié publié.

## Décision 5 — Le budget de clé reste 2^31, et sa consommation est dite

Le budget de l'ADR 0015 est **inchangé** : `BUDGET_SCELLEMENTS_PAR_CLE = 2^31`, la moitié du plafond
du § 8.3 de NIST SP 800-38D. Le compteur reste authentifié dans la racine.

Ce qui change est la CONSOMMATION, et il faut l'écrire : chaque racine consomme désormais **deux
scellements de plus** — l'empreinte de région rescellée, et le témoin. Une barrière du guest qui
validait un enregistrement en coûtait 2 (l'enregistrement, la racine) ; elle en coûte 4. À 2^31,
cela ramène le nombre de barrières admissibles sous une même clé de ~1,07 milliard à ~537 millions.
Aucun usage envisagé n'en approche, et le dire vaut mieux que de laisser découvrir le facteur deux.

L'ADR 0019 note en outre ce que le témoin fait au budget dans l'autre sens : le compteur cumulé vit
dans la racine et **recule** avec un retour arrière du support (question n° 4 de l'ADR 0015). Le
témoin borne désormais ce recul pour tout ce qui n'est pas un retour arrière complet — l'écart entre
le compteur et le nombre réel d'invocations est réduit, sans être annulé.

## Coût, mesuré

### Ce que la région pèse réellement

L'issue #19 annonçait « ≈ 2,3 Mio pour 512 Mio ». **Le chiffre est faux, et l'ADR le corrige plutôt
que de le reprendre** : la région d'authentification d'un volume de 512 Mio fait
`1 048 576 × 34 = 35 651 584` octets, soit **34 Mio exactement** (ADR 0016, décision 1). C'est
quinze fois l'estimation de l'issue, et c'est cette grandeur-là qu'il fallait mesurer.

### Le hachage, en flux, tranche par tranche

`empreinteDeRegion` lit la région par tranches de 1 Mio et les absorbe dans le SHA-256 incrémental
de `sha256-stream.mjs`. La surmémoire vaut une tranche, jamais la taille de la région : c'est le
même régime que celui que `docs/quality-attributes.md` impose déjà à l'export et à la restauration.

Les relevés sont dans `docs/quality-attributes.md`, avec leur environnement et leur dispersion. Deux
bancs les produisent, et ils ne mesurent pas la même chose :

- **`npm run test:vm` (`tests/vm/fraicheur-region-cout.spec.mjs`)** — sur **OPFS réel**, Chromium,
  région de 34 Mio, trois répétitions par exécution. C'est la mesure qui fait foi, lectures du
  support comprises. Deux exécutions du 2026-08-28, `win32 x64` :

  | exécution | relevés (ms)          | p50   | p95   | étendue relative | part du budget de 60 s |
  | --------- | --------------------- | ----- | ----- | ---------------- | ---------------------- |
  | 1         | 386,5 · 354,1 · 353,3 | 354,1 | 383,3 | 9,1 %            | **0,64 %**             |
  | 2         | 350,8 · 344,8 · 339,4 | 344,8 | 350,2 | 3,3 %            | **0,58 %**             |

  Six échantillons de 339,4 à 386,5 ms, soit une étendue de 47 ms — 13 % de la médiane. Le coût est
  du même ordre à chaque exécution, et il tient **deux ordres de grandeur sous le budget** ;

- un banc Node de contrôle isole la part de CPU pur du même chemin : **281,9 / 282,2 / 282,9 / 283,4
  / 288,5 ms** sur cinq exécutions, médiane 282,9 ms, étendue 6,6 ms (2,3 %). L'écart avec le
  support réel — une soixantaine de millisecondes — est le prix des 34 lectures OPFS. Il sert à
  savoir, le jour où un relevé dérive, si c'est le disque ou le hachage qui a bougé.

### Confronté au budget de l'ADR 0005

Ce coût est **mesuré par un banc dédié sur le support réel, `test:rythme` mesurant le rythme de
l'émulateur et non ce coût**. La substitution est explicite et acceptée : le banc de rythme boote
dix fois l'image de référence pour comparer la boucle d'ordonnancement de Vault à celle du moteur,
ce qui ne dit rien du temps qu'un hachage de région prend. `tests/vm/fraicheur-region-cout.spec.mjs`
le dit, à la bonne taille et sur le bon support.

L'[ADR 0005](0005-qualification-de-la-reprise.md) borne la reprise à 60 s. L'épreuve de coût épingle
un seuil d'**un pour cent** de ce budget — 600 ms —, et ce chiffre est un **engagement**, pas une
observation : au-delà, la fraîcheur cesserait d'être un coût qu'on peut ignorer dans le budget de
reprise. Les deux exécutions relevées tiennent à **0,58 %** et **0,64 %** — sous le seuil, et sans
que la marge tienne à une exécution chanceuse.

**Ce que la mesure ne borne pas**, et qu'il faut lire avec elle : la FRÉQUENCE. Une session paie une
empreinte à l'ouverture, et une par point de contrôle. Le seuil de rangement de l'ADR 0014 — 8 Mio
de charge validée — rend improbable qu'une application en paie beaucoup par boot, mais rien ne
l'interdit, et personne ne l'a mesuré.

### Si le seuil est franchi un jour : comment amortir, écrit d'avance

L'ordre est celui de l'ADR 0016 sur le lot par appel — la mesure décide, pas l'intuition — et les
deux leviers sont nommés maintenant pour ne pas être improvisés le jour venu :

1. **Empreinte à un seul coup.** `crypto.subtle.digest` sur la région entière est plusieurs fois
   plus rapide qu'un hachage JavaScript incrémental, au prix de 34 Mio de surmémoire — sous le
   budget de 64 Mio de `docs/quality-attributes.md`, mais il consomme la moitié d'un régime que le
   dépôt tient à deux ordres de grandeur près. À prendre en premier : il ne change aucun octet du
   format.
2. **Empreinte incrémentale par SUITES.** Découper la région en suites de secteurs, sceller
   l'empreinte de chaque suite, et ne rehacher que les suites qu'un rangement a touchées. Le coût
   par point de contrôle devient proportionnel à ce qui a bougé, pas à la taille du volume. Il
   **change le format** — la racine porterait N empreintes au lieu d'une — et exigerait donc une
   version de format et un amendement de cet ADR.

Aucun des deux n'est activé, aucun n'est derrière un drapeau, et aucun n'existe dans le code de
cette tranche : une option non mesurée qui traîne finit par être allumée sans décision.

## Niveau de preuve

- **Unitaire** — `tests/unit/vm-generation-sequence.test.mjs` et
  `tests/unit/vm-generation-fraicheur.test.mjs` : cinq épreuves négatives, chacune avec son témoin
  positif dans le même test. Chaque garde a été **neutralisée une à une** et son épreuve a rougi ;
  le relevé est dans la pull request de #19.
- **Résilience** — `tests/vm/resilience-arrets.spec.mjs` est rejoué **inchangé** : la matrice de #15
  n'a pas bougé d'un point, parce que le plan de fautes des voisins de fraîcheur est SÉPARÉ de celui
  du guest. Les mêler aurait décalé chaque occurrence et rendu les relevés de #15, #16 et #19
  incomparables. `tests/vm/resilience-fraicheur.spec.mjs` ajoute les deux plans de panne de cette
  tranche, avec leurs verdicts écrits d'avance.
- **Coût** — `tests/vm/fraicheur-region-cout.spec.mjs`, sur OPFS réel, avec dispersion publiée.

## Limites

1. **Le retour arrière complet du support n'est pas détecté**, et aucune formulation de ce dépôt ne
   doit laisser croire le contraire. Il exige une ancre hors du support : #21/#23.
2. **Le témoin est dans la même origine, et le neutraliser ne coûte pas ce que coûte reculer le
   volume.** Il ne renforce pas la frontière de l'ADR 0002. Le supprimer ou le tronquer suffit à
   réarmer la fenêtre du retour arrière complet, sans la clé, pour qui détient déjà une copie
   antérieure de volume + journal. Le comportement est délibéré ; l'ancrage est renvoyé à #23.
3. **La fenêtre de migration** d'un volume de #18 dure une ouverture, pendant laquelle aucune
   fraîcheur n'est prétendue — et le rapport le publie plutôt que de le taire.
4. **Le champ de version du journal n'est pas authentifié.** Une garde de cohérence et le témoin le
   couvrent ; ce n'est pas la même chose qu'une étiquette.
5. **La fraîcheur est datée au point de contrôle**, pas en continu. Entre deux rangements, ce que le
   volume porte est l'état daté du dernier ; ce qui a bougé depuis est dans le journal, couvert par
   sa racine.
6. **Le coût est mesuré sur une machine et un moteur.** Le relevé porte son environnement ; il ne
   remplace pas une mesure de référence.

## Alternatives rejetées

- **Un arbre de Merkle sur les 2^20 secteurs du volume** (question n° 2 de l'ADR 0015 pour #20).
  Rejeté pour cette tranche : 20 hachages par écriture et un état de 64 Mio à tenir ou à relire,
  pour une granularité de refus dont personne n'a établi le besoin. L'empreinte plate coûte un
  hachage par rangement et détecte le même retour arrière de secteur ; ce qu'elle ne donne pas,
  c'est **quel** secteur a reculé — et le remède ne change pas avec la réponse.
- **Authentifier l'empreinte dans les DONNÉES ASSOCIÉES de la racine.** Rejeté :
  `encoderEnteteRacine` est la spécification de l'ADR 0015, ses vecteurs sont figés
  (`tests/vectors/format-chiffre-v1.json`) et #18 les reproduit octet pour octet. Y ajouter un champ
  aurait imposé une version de spécification cryptographique pour une propriété que le scellement
  d'un bloc rend tout aussi authentique. Le prix payé à la place est nommé : la PRÉSENCE de
  l'empreinte n'est pas authentifiée, seule sa valeur l'est.
- **Refuser un volume de format 2.** Rejeté : voir la compatibilité — la réouverture acquiert la
  propriété d'elle-même, et refuser aurait rendu irouvrable un volume sain.
- **Un champ optionnel sans version de format.** Rejeté : « présent ou absent » sans version rend le
  format ambigu pour tout lecteur futur, et l'ADR 0016 avait déjà tranché le chemin — la réserve du
  secteur de racine, sous une version.
- **Écrire le témoin AVANT la racine.** Rejeté par ce qu'il produit : un témoin en avance refuse un
  volume que rien n'a fait reculer. Un témoin en retard, lui, sous-détecte — et sous-détecter est le
  seul sens dans lequel une erreur est tolérable ici.
- **Ne pas sceller le témoin.** Rejeté : un témoin en clair se forge sans clé, et une séquence
  démesurée y ferait un déni de service permanent sur un volume intact.
- **Écrire le témoin à chaque validation ET recalculer l'empreinte à chaque racine.** Le premier est
  RETENU (une petite écriture par barrière) ; le second est rejeté — la région ne change qu'au
  rangement, et rehacher 34 Mio par barrière du guest aurait mis un coût de reprise sur le chemin
  d'un acquittement.
- **Un plancher de génération de zéro pour le témoin, « pour ne pas écrire `null` ».** Rejeté : il
  ne refuserait aucun témoin authentique. Un contrôle décoratif est pire qu'un `null` assumé, parce
  qu'il se lit comme une garantie.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

1. `tests/vm/fraicheur-region-cout.spec.mjs` dépasse le pour-cent du budget de l'ADR 0005 — auquel
   cas l'amortissement est instruit dans l'ordre écrit plus haut, en commençant par celui qui ne
   change aucun octet de format ;
2. la revue externe (#20) tranche la question n° 2 par l'affirmative — auquel cas l'arbre de Merkle
   remplace l'empreinte plate, et la région d'authentification devient le support naturel de son
   état ;
3. #21 ou #23 livre une ancre de fraîcheur externe — auquel cas le témoin cesse d'être la seule
   défense contre le recul partiel, et la limite de la décision 3 se referme ;
4. un volume de #18 est découvert en exploitation qu'une seule ouverture ne suffit pas à migrer —
   auquel cas la migration passe par la chaîne de l'ADR 0011, avec sa preuve et son journal ;
5. la mesure montre que l'écriture du témoin à chaque barrière pèse sur `SEC-DURABLE-001` — auquel
   cas le témoin est amorti au point de contrôle, avec la perte de sensibilité que cela coûte,
   chiffrée.
