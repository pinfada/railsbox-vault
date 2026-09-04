# ADR 0024 — L'instantané de reprise est un voisin chiffré lié à une génération validée, et il n'est jamais une source de vérité

- Statut : accepté
- Date : 2026-09-04
- Issue : #65 · Invariants : `VAULT-PERSIST-001`, `SEC-DURABLE-001` · Jalon 3

## Contexte

L'[ADR 0005](0005-qualification-de-la-reprise.md) a décomposé le temps de reprise et tranché la voie
: le boot de Puma/Rails sur i386 émulé pèse **~79 %** du total, aucune accélération de boot à froid
ne suffit seule, et la seule voie sous 60 s est un **instantané mémoire lié à une génération
proprement arrêtée**. Le gate « reprise p95 ≤ 60 s » est resté fermé depuis le jalon 0, et
`docs/quality-attributes.md` le porte comme tel.

Ce que l'ADR 0005 ne pouvait pas écrire, faute des tranches qui l'ont suivi, c'est **à quoi** un
instantané se lie. Un instantané mémoire restauré sur un volume qui a bougé depuis la capture n'est
pas une accélération : c'est une corruption silencieuse — le guest croit tenir des tampons, des
verrous et des descripteurs de fichiers qui décrivent un disque qui n'existe plus. Il fallait donc
d'abord pouvoir nommer **un état exact du volume**. Trois tranches l'ont livré :

- l'[ADR 0014](0014-generation-transactionnelle.md) donne la **racine validée** et sa **séquence** ;
- l'[ADR 0016](0016-format-de-volume-v3-dispositions.md) donne l'**identifiant de volume** et la
  région d'authentification ;
- l'[ADR 0019](0019-fraicheur-du-volume.md) donne l'**empreinte de la région d'authentification**,
  c'est-à-dire une empreinte de tout ce que le volume porte de scellé.

Et deux autres donnent la clé sous laquelle sceller : l'[ADR 0020](0020-enveloppe-de-cle.md)
l'enveloppe qui rend la DEK, l'[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) la KEK qui
l'ouvre.

Cet ADR pose le format, la politique de capture, les règles de validité et le cycle de vie de
l'instantané. Il **n'ouvre pas** le gate : ouvrir le gate demande une mesure et une preuve
d'équivalence, qui sont publiées ailleurs (`docs/quality-attributes.md`) et dont la conclusion
figure au § « Ce que cette tranche ne prouve pas ».

## La phrase qui gouverne tout le reste

> **Le volume est la seule source de vérité. L'instantané est une accélération vérifiée, et un
> instantané dont la liaison ne concorde pas exactement avec l'état présent est ÉCARTÉ — jamais
> réparé, jamais accepté partiellement, jamais annoncé comme une reprise.**

Toutes les décisions ci-dessous en découlent. Aucune promesse de durabilité ne bouge :
`SEC-DURABLE-001` reste ce qu'il est, et il n'est tenu que par le journal de génération. Un
instantané perdu ne perd **aucune** donnée : il coûte un boot à froid.

## Décision 1 — Le fichier `<volume>.instantane`, cinquième voisin réservé

L'instantané vit dans l'origine de confiance, à côté du volume, sous un **suffixe réservé**
`.instantane` — comme le manifeste (`.manifest`, #10), le journal de migration (`.migration`, #13),
le journal de génération (`.gen`, #16), le témoin de séquence (`.temoin`, #19) et l'enveloppe de clé
(`.cles`, #21). Il est ajouté à `RESERVED_SIDECAR_SUFFIXES` : aucun volume ne peut porter ce nom,
sans quoi supprimer « donnees » détruirait un volume légitime nommé « donnees.instantane ».

**Ce suffixe est le plus long du dépôt (11 caractères)** et il rétrécit donc `MAX_VOLUME_NAME` de 54
à 53 caractères. C'est un changement de frontière de nommage, et il est écrit ici plutôt que subi :
la règle du dépôt est qu'un volume créable doit toujours rester restaurable, migrable et — désormais
— capturable. Un volume de 54 caractères créé par un runtime antérieur reste ouvrable ; il ne
pourrait simplement pas recevoir d'instantané. Aucun volume de ce dépôt, aucune fixture et aucun
banc n'approche cette longueur.

**Il ne vit pas dans le fichier de volume**, pour la raison qui a déjà exilé les cinq autres : les
octets du volume sont servis tels quels à v86, et y réserver une aire décalerait le système de
fichiers du guest.

**Il n'entre jamais dans une archive d'export.** L'archive de
l'[ADR 0008](0008-format-d-archive-d-export.md) reste sans clé et sans état mémoire ; l'enveloppe en
est déjà exclue par l'ADR 0020, décision 6, et l'instantané l'est pour une raison plus forte encore
: il contient la **RAM invitée**, c'est-à-dire du clair applicatif et, éventuellement, du matériel
de session.

## Décision 2 — La disposition : un en-tête de 152 octets, un corps chiffré, une marque de complétude

```
[ en-tête, 152 octets ][ corps chiffré, N octets ][ marque de complétude, 8 octets ]
```

| Offset | Taille | Champ                                                |
| -----: | -----: | ---------------------------------------------------- |
|      0 |      8 | marqueur `VLTSNP01`                                  |
|      8 |      4 | version du format d'instantané (u32, petit-boutiste) |
|     12 |      4 | version du format de VOLUME que l'instantané suppose |
|     16 |     16 | identifiant de volume (les seize octets bruts)       |
|     32 |      8 | séquence de la racine validée                        |
|     40 |      8 | génération de la racine validée                      |
|     48 |      8 | longueur du CLAIR de l'état v86                      |
|     56 |     32 | empreinte SHA-256 de la région d'authentification    |
|     88 |     32 | empreinte SHA-256 de l'image de référence            |
|    120 |     12 | nonce                                                |
|    132 |     16 | étiquette AES-GCM                                    |
|    148 |      4 | réserve (zéros)                                      |
|    152 |      N | corps : l'état v86 CHIFFRÉ                           |
|  152+N |      8 | marque de complétude `VLTSNPF1`                      |

Les entiers de l'EN-TÊTE sont petit-boutistes, comme ceux du témoin de l'ADR 0019 et de l'en-tête v3
de l'ADR 0016 ; ceux des **données associées** sont gros-boutistes, comme partout dans l'ADR 0015.
Ce n'est pas une incohérence : ce sont deux encodages de rôles différents, et c'est déjà la
convention du dépôt.

### La marque de complétude, et pourquoi elle est à la FIN

Elle est écrite **après** le corps et **après** une barrière, exactement comme `VLTSEAL1` de l'ADR
0016 est écrite après le scellement du volume. Sa position à la fin du fichier n'est pas un détail :
un fichier tronqué par une coupure n'a pas de marque, et le refuser coûte un faux refus sans perte —
contre un faux succès qui, ici, coûterait un état mémoire incohérent restauré sur un volume sain.

Elle n'est **pas authentifiée**, et le paragraphe correspondant de l'ADR 0016 vaut mot pour mot :
c'est un localisateur, pas une preuve. Ce qu'elle ferme est une coupure, pas un adversaire — un
adversaire capable d'écrire dans l'origine peut poser la marque, et il tombera alors sur
l'étiquette.

## Décision 3 — UN scellement par capture, dont les données associées SONT l'en-tête

**Un seul appel à la fonction de chiffrement authentifié par capture** : AES-256-GCM sous la DEK,
clair = l'état v86 entier, **données associées = la LIAISON**, nonce tiré de
`crypto.getRandomValues` comme partout ailleurs (ADR 0015).

La liaison est encodée canoniquement — champs de largeur fixe ou préfixés de leur longueur, comme
`encoderIdentiteBloc` — et porte :

```
étiquette de domaine "railsbox-vault/instantane-de-reprise/v1/liaison"
nom d'algorithme     "aes-256-gcm"
version du format d'instantané   (4 octets)
version du format de volume      (4 octets)
identifiant de volume            (chaîne préfixée, 32 hexadécimaux minuscules)
séquence de la racine validée    (8 octets)
génération de la racine validée  (8 octets)
empreinte de la région           (32 octets)
empreinte de l'image de référence (32 octets)
longueur du clair de l'état      (8 octets)
```

**C'est ce que « en-tête scellé » veut dire ici, et il faut le dire exactement** : l'en-tête n'est
pas chiffré — il est en clair sur le disque, parce qu'il faut pouvoir le lire pour décider s'il vaut
la peine de traverser 250 Mio — mais il est **authentifié** : le moindre octet modifié dans l'un de
ces champs fait échouer l'étiquette, et aucun clair n'est rendu.

**Un seul scellement, et c'est une contrainte, pas un raccourci.** Le budget de clé de l'ADR 0015
est de 2^31 scellements ; en ajouter deux par capture plutôt qu'un doublerait la part de
l'instantané dans ce budget. Le prix payé est écrit au § « Limites » : le sceau ne se vérifie
qu'après avoir traversé le corps entier, si bien que les écarts de liaison bon marché (volume,
séquence, génération, empreintes) sont constatés **avant**, comme diagnostics, exactement comme
`#exigerIdentiteDeVolume` le fait déjà pour la racine.

### Ce que le chiffrement du corps achète

Le corps est l'état v86 : il contient la **RAM invitée**, donc du clair applicatif — des lignes de
la base SQLite en cache de page, des tampons de Puma, potentiellement du matériel de session. Le
laisser en clair à côté d'un volume chiffré serait un contournement complet du jalon 4 : il
suffirait de lire l'instantané pour lire le volume. Il est donc chiffré sous **la même DEK** que le
volume, celle que l'enveloppe de l'ADR 0020 développe.

## Décision 4 — Sept gardes, un seul remède

À l'ouverture, l'instantané n'est utilisé que si sa liaison correspond **exactement** à l'état
présent. Sept états le refusent, chacun **typé et nommé** :

| Refus                               | Ce qu'il constate                                                         | Témoin positif de l'épreuve            |
| ----------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `VAULT_INSTANTANE_MALFORME`         | marqueur absent, version inconnue, fichier plus court que son en-tête     | le même fichier intact s'ouvre         |
| `VAULT_INSTANTANE_INCOMPLET`        | marque de complétude absente ou corps plus court que la longueur déclarée | le même fichier, marque posée, s'ouvre |
| `VAULT_INSTANTANE_ECART_VOLUME`     | l'identifiant de volume diffère                                           | l'identifiant attendu ouvre            |
| `VAULT_INSTANTANE_ECART_SEQUENCE`   | la séquence a RECULÉ depuis la capture (ci-dessous)                       | une séquence égale ou supérieure ouvre |
| `VAULT_INSTANTANE_ECART_GENERATION` | la génération validée diffère                                             | la génération de la capture ouvre      |
| `VAULT_INSTANTANE_ECART_REGION`     | l'empreinte de la région d'authentification diffère                       | l'empreinte de la capture ouvre        |
| `VAULT_INSTANTANE_ECART_IMAGE`      | l'empreinte de l'image de référence diffère                               | l'empreinte de la capture ouvre        |
| `VAULT_INSTANTANE_SCEAU_REFUSE`     | l'étiquette ne vérifie pas — octet altéré, en-tête forgé, autre clé       | le fichier intact s'ouvre              |

Le tableau compte huit lignes pour « sept gardes » parce que `MALFORME` et `INCOMPLET` répondent
d'un même geste — reconnaître un fichier — et de deux causes distinctes dont les remèdes se lisent
différemment dans un compte rendu.

### La SÉQUENCE se compare par un RECUL, et c'est une CORRECTION du raffinement de #65

Le raffinement de l'issue demandait qu'« une écriture validée après la capture (séquence supérieure)
l'invalide », et la première version de cette garde exigeait donc l'égalité stricte. **L'exécution
l'a réfutée.** La séquence compte les écritures de RACINE, et l'ADR 0014 en écrit une que personne
ne remarque tant qu'on ne s'y lie pas : **le vidage qui clôt toute récupération écrit une racine
neuve**, donc la séquence avance d'un cran à CHAQUE OUVERTURE, avant même que le guest ait battu.

Un instantané lié à l'égalité de séquence est donc périmé à sa première réouverture — c'est-à-dire
qu'il n'aurait **jamais servi une seule fois**. Le défaut est tombé sur le scénario de bout en bout
de cette tranche, pas en revue : capture, fermeture, réouverture, et l'instantané écarté au motif
`ECART_SEQUENCE` par un volume que rien n'avait touché.

**Ce que l'intention du raffinement demandait est tenu, et par deux champs plutôt qu'un** :

- la **GÉNÉRATION VALIDÉE** n'avance qu'à une barrière ACQUITTÉE du guest, c'est-à-dire exactement à
  une « écriture validée ». Elle est comparée par ÉGALITÉ, et c'est elle qui porte la garde que le
  raffinement décrit ;
- l'**EMPREINTE DE RÉGION** change dès qu'un secteur est rescellé — donc dès qu'un point de contrôle
  a rangé quoi que ce soit. Elle est comparée par ÉGALITÉ elle aussi, et elle attrape ce qu'une
  génération inchangée laisserait passer.

La séquence garde alors la seule propriété qu'elle est seule à porter : **elle ne recule pas**. Une
séquence présente inférieure à celle que l'instantané déclare décrit un journal ramené en arrière —
le cas que l'ADR 0019 nomme —, et l'instantané est écarté. C'est une garde de moins que l'égalité,
et une garde de plus que rien.

Les deux épreuves vivent côte à côte dans `tests/unit/vm-instantane-conduite.test.mjs` : « une
séquence qui AVANCE n'écarte rien » et « une séquence qui RECULE écarte l'instantané ». La première
est le témoin qui manquait ; sans elle, la garde d'égalité serait revenue au premier remaniement.

**Le remède est UN, et c'est le point de la décision :** l'instantané est **retiré du support**, et
le **boot à froid** s'exécute. Aucun message ne laisse croire à une reprise ; le compte rendu publie
`instantane: { utilise: false, motif: <code> }`, et le motif n'est jamais tu — un contrôle qu'on ne
publie pas finit par être supposé actif (ADR 0019).

**Pourquoi RETIRER et pas seulement ignorer** : un instantané périmé qu'on laisse en place est relu
à chaque ouverture, et son coût — lire 152 octets — est négligeable, mais son existence ne l'est pas
: il continue de porter en clair chiffré la RAM d'une session révolue, et il occupe 250 Mio d'un
quota que le volume partage. Le retirer est le seul geste qui rende l'état du support égal à ce
qu'il affirme.

**Ordre des contrôles.** Reconnaissance du fichier, complétude, puis les cinq écarts de liaison —
tous **avant** le sceau, tous comme **diagnostics** sur des champs non authentifiés, et le sceau en
dernier sur le corps entier. C'est l'inverse de l'ordre de l'ADR 0015 (« authentifier d'abord,
classer ensuite ») et la différence doit être écrite : ici le classement ne prétend pas être établi.
Un `ECART_GENERATION` dit « l'en-tête DÉCLARE une autre génération », pas « un adversaire a reculé
le volume ». Comme tous les écarts mènent au même remède — écarter — la nuance ne coûte aucune
sûreté, et elle épargne de déchiffrer 250 Mio pour apprendre ce que douze octets disaient déjà.

## Décision 5 — La QUIESCENCE : un nouvel état de l'adaptateur (ADR 0003 amendé)

L'[ADR 0003](0003-backend-de-blocs-v86.md) écrit que l'adaptateur refuse explicitement les
instantanés mémoire — « `get_state`, `set_state`, `get_buffer` lèvent `VAULT_STORAGE_UNSUPPORTED` »
— et il donne sa raison : « hors périmètre tant qu'ils ne sont pas liés à une génération du volume
». Cette condition est désormais remplie, et l'ADR 0003 est amendé d'autant, **et seulement
d'autant** : `get_buffer` reste refusé.

L'adaptateur gagne un état **quiescé** :

- `quiescer()` **refuse** s'il reste une E/S en vol (`inFlight > 0`) ou si l'adaptateur est déjà en
  panne. Une capture sur un tampon dont une écriture est en vol capturerait un état mémoire qui
  décrit une écriture que le support n'a pas encore reçue ;
- pendant la quiescence, `get`, `set` et `flush` sont **refusés** — `VAULT_STORAGE_QUIESCE` —, la
  faute est journalisée, `onFatal` est prévenu, et **le backend n'est pas touché**. Le rappel
  d'acquittement de v86 n'est pas appelé : un acquittement pendant une capture serait exactement le
  mensonge que `SEC-DURABLE-001` interdit ;
- `reprendre()` rend le nombre de violations observées et remet l'adaptateur en service ;
- **la capture échoue proprement si une violation est survenue** : elle ne produit aucun fichier. Il
  n'y a pas de capture partielle, il n'y a pas de capture « probablement bonne ».

`get_state()` ne rend **jamais les octets du disque** : il rend la **liaison** — identifiant de
volume, séquence et génération validées. C'est ce qui garantit que l'instantané ne duplique pas le
volume et ne peut pas le contredire. Il n'est disponible **que** pendant la quiescence : hors
quiescence, il refuse. `set_state(liaison)` confronte la liaison reçue au volume réellement ouvert
et refuse tout écart, avant que le guest n'ait battu une seule fois.

### Ce que la quiescence garantit, et ce qu'elle ne garantit pas

Elle garantit qu'**aucune E/S de l'adaptateur n'est en vol ni acceptée pendant la capture**. Elle ne
garantit pas que le guest soit _logiquement_ au repos : le guest est arrêté (`emulator.stop()`)
avant la capture, et c'est l'arrêt qui fait le repos ; la quiescence est le **filet** qui rend
visible un arrêt qui n'aurait pas eu lieu. La distinction importe, parce qu'un lecteur pressé lirait
« quiescé » comme « le guest est au repos », ce qui serait une garantie que l'adaptateur ne peut pas
donner : il ne voit que les E/S qui lui arrivent.

## Décision 6 — Quand capturer : au point de contrôle, jamais pendant une génération ouverte

La capture a lieu **au point de contrôle**, après quiescence, et à ces conditions cumulatives :

1. la dernière génération est **validée** — racine écrite, barrière franchie, témoin écrit ;
2. le journal a été **vidé** par un point de contrôle : rien n'attend d'être rangé ;
3. l'adaptateur ne porte **aucune E/S en vol** ni aucune faute ;
4. l'émulateur est **arrêté**.

En pratique, deux moments les réunissent : la **fermeture propre** de la session, et une
**inactivité mesurée** au-delà d'un seuil. Cette tranche n'implante que la première ; la seconde est
nommée ici pour que le format ne la ferme pas, et elle attend une interface (#24) qui puisse la
justifier à l'utilisateur.

**Jamais pendant une génération ouverte.** Une charge déposée non validée sera écartée à la
prochaine ouverture ; un instantané capturé au-dessus d'elle décrirait une mémoire qui a vu des
écritures que le volume n'aura pas. La capture le refuse — c'est la condition 2 — plutôt que de
capturer un état qu'il faudrait ensuite refuser à la restauration.

### Coût sur le budget de clé

Un scellement par capture. Le budget de l'ADR 0015 est de **2^31 = 2 147 483 648** scellements sous
une clé de volume, et il compte déjà : un par secteur rescellé, un par enregistrement déposé, un par
racine, un par empreinte de région, un par témoin. Une capture par fermeture, à raison de dix
fermetures par jour, consomme **3 650 scellements par an** — soit 1,7 × 10⁻⁶ du budget. La capture
n'est pas un poste de ce budget ; elle y est comptée parce que le § 8.3 de NIST SP 800-38D compte «
all instances of the authenticated encryption function », et l'omettre aurait fait un compteur faux
plutôt qu'un budget économisé.

## Décision 7 — Pas de compression, et voici les chiffres qui le décident

La question était ouverte et devait être tranchée **sur mesure**. Relevé du **2026-09-04**, harnais
Node de `tools/vm/boot-reference.mjs`, image de référence, 512 Mio de RAM invitée. **Ce n'est pas
l'environnement de référence** de `docs/quality-attributes.md` (4 cœurs, 16 Gio) : c'est un
i7-14700HX, 28 cœurs logiques, 31,7 Gio, Node 24.14.0, win32 x64. Les ordres de grandeur portent la
décision, pas les millisecondes.

| Grandeur                                   | Mesure                                 |
| ------------------------------------------ | -------------------------------------- |
| `save_state` brut                          | **262 501 556 o (250,3 Mio)**          |
| coût de `save_state`                       | 386 ms                                 |
| scellement AES-256-GCM du corps (un appel) | 215 / 228 / 219 ms                     |
| ouverture AES-256-GCM du corps (un appel)  | 278 / 304 / 293 ms                     |
| gzip niveau 1                              | 2 633 ms → **90 938 633 o (86,7 Mio)** |
| gunzip                                     | 795 ms                                 |

La compression divise la taille par **2,89**. Elle coûte **2,6 s à la capture** et **0,8 s à la
restauration**.

**Décision : pas de compression en v1.** Trois raisons, dans l'ordre où elles pèsent :

1. **2,6 s à la capture se paient à la fermeture**, c'est-à-dire pendant que l'utilisateur attend
   que sa fenêtre se ferme. C'est le seul moment de ce système où une seconde est visible ;
2. **0,8 s à la restauration se paient sur le chemin même que le gate borne.** Ce n'est que 1,3 % de
   60 s, mais on ne dépense pas sur le budget qu'on cherche à tenir pour économiser un quota qui
   n'est pas encore contraignant ;
3. la compression ajouterait un **passage supplémentaire** entre le clair et le sceau, avec l'ordre
   à écrire et à défendre (comprimer PUIS chiffrer, jamais l'inverse), et un format à versionner.

**Ce que cette décision coûte, et il faut le dire** : l'empreinte OPFS d'un volume applicatif passe
de 547 Mio (512 de charge + 34 de région + 1 secteur d'en-tête) à **~798 Mio**. C'est +46 %. Le
quota OPFS de Chromium est proportionné à l'espace disque libre, donc généralement large, mais la
marge n'est plus la même. **La compression est le premier levier à tirer si le quota devient
contraignant, et les chiffres pour la décider sont ci-dessus** — c'est explicitement une condition
d'abandon de cette décision-ci, pas de l'ADR entier.

## Décision 8 — Le cycle de vie : ce qui retire l'instantané

L'instantané **part avec le volume**, et il part aussi avec tout geste qui **réécrit** le volume ou
change qui l'écrit. La règle est celle de l'ADR 0019 pour le témoin, étendue :

| Geste                                 | Retire l'instantané | Pourquoi                                                              |
| ------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| suppression du volume                 | **oui**             | un instantané survivant décrirait un volume qui n'existe plus         |
| restauration depuis une archive (#12) | **oui**             | le volume est réécrit entièrement ; la liaison ne décrit plus rien    |
| migration de format (#13)             | **oui**             | idem — et la version de format de la liaison serait fausse            |
| changement de bail d'écriture (#79)   | **oui**             | un autre détenteur va écrire ; l'instantané ne date plus que le passé |
| verrouillage (#25)                    | **oui**             | position par défaut, ci-dessous                                       |
| ouverture qui écarte l'instantané     | **oui**             | décision 4                                                            |
| point de contrôle sans capture        | non                 | la séquence avance ; l'écart sera constaté à la prochaine ouverture   |

La dernière ligne mérite son explication : un instantané qu'une écriture validée rend périmé n'est
**pas** retiré au moment où il le devient. Le retirer exigerait de tenir un handle sur le voisin
pendant toute la session — un handle exclusif de plus sur le chemin critique de chaque barrière —
pour un fichier qui sera de toute façon refusé et retiré à la prochaine ouverture. Le prix est un
fichier périmé qui occupe le quota entre deux sessions ; le bénéfice est un chemin d'écriture qui ne
gagne aucun voisin. **Ce que ce choix laisse ouvert est écrit au § « Limites ».**

### Le verrouillage (#25) : oui, l'instantané ne survit pas

La question est posée à #25 et cet ADR écrit la position par défaut : **oui, un verrouillage retire
l'instantané.** Verrouiller veut dire « la DEK n'est plus en mémoire, et le clair n'est plus
accessible ». Un instantané qui survivrait au verrouillage laisserait sur le support 250 Mio de RAM
invitée chiffrée sous une clé que l'utilisateur vient précisément de mettre hors d'atteinte — ce qui
n'est pas une fuite, mais qui n'est pas non plus ce que « verrouiller » promet. Le coût du retrait
est un boot à froid au déverrouillage suivant. Il est assumé, et #25 peut le rouvrir avec un
argument, pas par omission.

## Ce que cette tranche ne prouve PAS

C'est la section qui doit être lue avant toute autre.

1. **Le gate « reprise p95 ≤ 60 s » n'est pas ouvert par cet ADR.** Il ne s'ouvre que si le p95
   mesuré sur ≥ 4 essais est ≤ 60 s **ET** que la preuve d'équivalence byte-à-byte est verte. Le
   relevé et le verdict vivent dans `docs/quality-attributes.md`, pas ici.
2. **L'équivalence n'est prouvée que pour l'image de référence.** Elle compare l'invariant SQLite
   (ADR 0004) et le clair du volume obtenus par restauration d'instantané et par boot à froid. Elle
   ne dit rien d'une autre application, d'un autre noyau ni d'une autre version de v86.
3. **Rien ici ne borne la dérive d'horloge du guest.** Un instantané restauré rend au guest une
   horloge arrêtée au moment de la capture ; v86 la rattrape depuis le CMOS de l'hôte, et ce que
   cela fait aux minuteries de Puma n'est pas mesuré par cette tranche.
4. **La quiescence n'est éprouvée que sur l'adaptateur**, pas sur le contrôleur IDE de v86. Une E/S
   que `ide.js` retiendrait dans ses propres tampons sans jamais atteindre l'adaptateur ne serait
   pas vue. Le spike #4 a mesuré que le chemin PIO acquitte en interne ; c'est un résidu connu, il
   est nommé, il n'est pas fermé.
5. **Aucune frontière d'origine ne bouge**, et `SEC-DURABLE-001` est inchangé.

## Impacts sur les ADR antérieurs

- **ADR 0003** est amendé : `get_state` et `set_state` de l'adaptateur ne lèvent plus
  `VAULT_STORAGE_UNSUPPORTED` — ils portent la liaison, et seulement pendant la quiescence.
  `get_buffer` reste refusé, et pour la raison inchangée : un volume Vault ne se recopie pas en un
  `ArrayBuffer` unique.
- **ADR 0005** voit sa voie construite. Ses conditions d'abandon sont vérifiées à la décision 7 et
  dans `docs/quality-attributes.md` ; le gate reste géré par la mesure, pas par cet ADR.
- **ADR 0008** est confirmé sans changement : l'archive n'emporte pas l'instantané.
- **ADR 0019** voit sa règle « un témoin ne date que le volume qu'il accompagne » étendue à
  l'instantané, à la décision 8.

## Limites

1. **Un instantané périmé survit entre deux sessions.** Décision 8, dernière ligne. Il occupe le
   quota jusqu'à la prochaine ouverture, qui l'écarte et le retire.
2. **Le sceau ne se vérifie qu'après avoir traversé le corps entier.** AES-GCM ne rend son verdict
   qu'à la fin. Un instantané forgé de 250 Mio coûte donc 250 Mio de déchiffrement pour être refusé.
   Ce n'est pas un déni de service nouveau : quiconque peut écrire ce fichier peut aussi bien
   effacer le volume.
3. **L'en-tête n'est pas confidentiel.** Il révèle l'identifiant de volume, la séquence, la
   génération, l'empreinte de la région et celle de l'image. C'est exactement le canal auxiliaire
   que l'ADR 0015 assume déjà pour la racine, à l'échelle près : ici la séquence est celle d'une
   fermeture, ce qui date la dernière session. Assumé et nommé.
4. **Un retour arrière COMPLET du support n'est pas plus détecté qu'avant.** Un adversaire qui
   ramène ensemble le volume, son journal, son témoin et son instantané reste hors de portée, comme
   l'ADR 0019 l'écrit. L'instantané n'ajoute ni ne retire rien à cette limite : sa liaison est
   dérivée du même support.
5. **La taille de l'instantané dépend de la RAM invitée**, pas du volume. Une image de référence
   configurée avec plus de 512 Mio produirait un instantané proportionnellement plus grand, et la
   décision 7 devrait être reprise.

## Alternatives rejetées

- **Mettre l'instantané dans l'archive d'export.** Refusé : l'archive est portable et sans clé ; y
  mettre de la RAM invitée chiffrée en ferait un objet qui n'est ni l'un ni l'autre. Et un
  instantané n'est utile que sur la machine qui l'a produit — sa liaison nomme un volume précis.
- **Sceller l'en-tête à part du corps, en deux scellements.** Refusé : deux scellements par capture
  pour économiser 250 Mio de déchiffrement sur un chemin qui n'existe que quand quelque chose est
  déjà cassé. Les écarts bon marché sont constatés avant le sceau, ce qui donne le même bénéfice
  sans le second scellement.
- **Dériver une clé propre à l'instantané depuis la DEK.** Refusé pour cette tranche : cela
  ajouterait une dérivation, donc une décision de l'ADR 0021, pour une séparation de domaines que
  l'étiquette de domaine des données associées assure déjà. À rouvrir si l'instantané devait un jour
  survivre au verrouillage — ce que la décision 8 refuse.
- **Restaurer l'instantané puis rejouer le journal par-dessus.** Refusé net : c'est exactement la
  reprise partielle que l'ADR 0014 interdit. Un état mémoire ne se « rattrape » pas ; soit il décrit
  l'état présent du volume, soit il est écarté.
- **Garder un handle sur l'instantané pendant la session pour le retirer dès qu'il périme.** Refusé
  : un handle exclusif de plus, sur le chemin critique de chaque barrière, pour un fichier que la
  prochaine ouverture retirera de toute façon. Voir décision 8.
- **Rendre les octets du disque dans `get_state`.** Refusé : ce serait une seconde copie du volume,
  contredisant la phrase qui gouverne cet ADR, et 512 Mio de plus dans l'instantané.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- **le coût de capture + restauration approche le boot à froid évité** — c'est la condition
  d'abandon écrite par l'ADR 0005, et elle est mesurée dans `docs/quality-attributes.md` ;
- **la taille de l'instantané rogne le gain** : si le quota OPFS refuse le couple volume +
  instantané sur un poste de la matrice de compatibilité, la décision 7 est reprise en premier, et
  l'ADR entier ensuite si la compression ne suffit pas ;
- **l'équivalence byte-à-byte échoue** sur un scénario de la matrice : la voie est alors refusée, et
  le gate reste fermé — un instantané qui ne rend pas exactement l'état du boot à froid n'est pas
  une accélération, c'est une corruption ;
- **une montée de v86 change le format de `save_state`** de façon telle qu'un instantané ancien soit
  restauré sans erreur mais dans un état faux. Le format d'instantané ne porte pas la version de v86
  : elle est couverte par l'**empreinte de l'image de référence**, qui inclut le runtime (ADR 0007).
  Si cette empreinte cessait de couvrir v86, cette garde tomberait et l'ADR devrait être repris ;
- **un moteur obligatoire de la matrice #2 ne tient pas 250 Mio en mémoire** le temps d'une capture
  ou d'une restauration.
