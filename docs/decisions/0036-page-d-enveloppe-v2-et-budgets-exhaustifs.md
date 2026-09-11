# ADR 0036 — La page d'enveloppe v2, la clôture du troisième chemin, et un budget enfin exhaustif

- **Statut** : accepté
- **Date** : 2026-09-11
- **Issue** : [#182](https://github.com/pinfada/railsbox-vault/issues/182) (HIGH, tranche T2b),
  [#20](https://github.com/pinfada/railsbox-vault/issues/20) moitié 2 · Invariants : `SEC-KEY-001`,
  `SEC-BLOCK-001`, `SEC-RECOVERY-001`
- **Applique** : [ADR 0033](0033-hierarchie-de-cles-derivees-par-domaine.md), décisions 2, 3, 4 et
  6, pour les deux domaines que la tranche T2a avait laissés.
- **Révise** : [ADR 0020](0020-enveloppe-de-cle.md) (décision 3 — la racine d'une page n'est plus
  scellée sous la clé de volume), [ADR 0027](0027-archive-et-ancre-de-version.md) (la racine
  rescellée à l'export passe sous le domaine `recuperation`),
  [ADR 0035](0035-format-de-volume-v4-et-migration.md) (le troisième chemin hors transaction, laissé
  ouvert et mesuré, est fermé ici).
- **Ne traite pas** : AES-GCM-SIV (question ouverte n° 1, spike T3) ; l'ancrage monotone (question
  n° 3) ; la rotation de la clé maîtresse ; l'emplacement du compteur, qui reste dans la racine et
  recule donc avec elle (question n° 4, § 9.1 de la spécification).

## Contexte

L'[ADR 0033](0033-hierarchie-de-cles-derivees-par-domaine.md) décide que la clé de volume devient
une clé MAÎTRESSE : plus rien n'est scellé sous elle directement. La tranche T2a l'a rendu vrai pour
quatre domaines sur six — `volume`, `journal`, `instantane`, `archive`. Les deux derniers,
`enveloppe` et `recuperation`, scellaient encore sous elle, et le § 12 de la spécification
l'écrivait comme un écart assumé plutôt que corrigé en silence.

Trois choses restaient donc à faire, et la Definition of Ready de #182 les nomme :

1. la **page d'enveloppe** passe en version 2, sa racine sous une clé à usage unique ;
2. le **troisième chemin hors transaction** — le volume de coquille — clôt par une racine ;
3. le **budget** devient exhaustif, et il est MESURÉ plutôt qu'affirmé.

Un quatrième point s'y est ajouté par décision du superviseur, trouvé en corrigeant la PR #186 :
**le runtime v4 ne savait pas EXPORTER un volume v3.** Un pas de migration destructif exige une
sauvegarde vérifiée ; l'export ouvrait le volume par l'ouvreur v4, qui refuse un en-tête v3 en
renvoyant à la migration. Les deux règles se refermaient l'une sur l'autre.

## Décision 1 — La page d'enveloppe passe en version 2 : sel tiré, domaine déclaré

La disposition est au § 6.11 de la spécification. Deux champs s'ajoutent, et **rien n'est déplacé**
: un **sel de trente-deux octets** à l'offset 104 — là où la v1 s'arrêtait —, et l'**octet 14**, qui
était du remplissage, porte le **domaine** de la racine. La somme de contrôle recule de 104 à 136,
l'en-tête de 108 à 140.

**Ce que le sel coûte à la page, mesuré.** Au pire tarif — huit emplacements de 584 octets —, la
page occupe 4 812 octets sur 8 192. Il reste de quoi en porter cinq de plus. Le risque que l'ADR
0033 inscrivait (« cela peut coûter un emplacement dans le pire cas ») ne se réalise pas, et ne se
réaliserait que si le plafond passait de huit à quatorze.

**Deux domaines, et pourquoi pas un seul.** `enveloppe` scelle la page de `<volume>.cles` ;
`recuperation` scelle la page qu'une ARCHIVE emporte (ADR 0027). Même version de format, même
volume, et pourtant deux clés — parce que l'info HKDF porte le nom du domaine. La séparation est
utile et il faut dire de quoi : **une archive voyage.** Elle quitte l'appareil, elle est copiée,
elle est conservée ; la clé qui scelle sa page ne scelle rien qui soit resté sur la machine. C'est
la même raison qui a valu au journal un domaine propre.

**La page DIT lequel des deux a scellé sa racine.** Ce n'est pas un ornement : la restauration pose
la page embarquée en page 0 de `<volume>.cles`, et le premier déverrouillage du volume restauré doit
l'ouvrir. Un lecteur qui supposerait `enveloppe` dériverait la mauvaise clé et refuserait une page
parfaitement valide ; un lecteur qui essaierait les deux ferait dépendre son verdict de l'ordre des
essais.

**Ni le sel ni l'octet de domaine ne sont authentifiés**, et l'ADR 0033, décision 3, dit pourquoi :
les changer fait dériver une autre clé, donc échouer l'étiquette. Ils se protègent par leur
conséquence, comme le nonce. Un octet de domaine qui ne désigne RIEN, lui, fait refuser la page au
décodage.

**La version de format d'un EMPLACEMENT ne suit pas celle de la page**, et c'est la décision qui
rend la migration possible. Elle vaut 1, et elle vaudra 1 : les octets d'un emplacement n'ont pas
changé, et la faire suivre obligerait une migration de page à réenvelopper la clé de volume sous
CHAQUE clé de déverrouillage — alors qu'on n'en détient qu'une. La migration perdrait des clés.

## Décision 2 — Une page v1 est rescellée à la première ouverture RÉUSSIE, et la v1 est conservée

**Où** : dans `ouvrirEnveloppe`, parce que c'est le seul moment où le produit tient la clé de volume
— elle ne s'obtient qu'en développant un emplacement sous une clé de déverrouillage valable.

**Comment** : deux écritures, et pas quatre. La page v2 est publiée sur la page LIBRE ; la page v1
n'est **pas** effacée. C'est la différence avec une révocation, et c'est ce qui rend le geste sûr :

| Rang                       | Ce que le fichier porte                                 | Ce qui s'ouvre |
| -------------------------- | ------------------------------------------------------- | -------------- |
| avant la barrière          | page v1 intacte et autoritaire ; brouillon sur la libre | **v1 @ N**     |
| après la barrière          | page v2 complète en version N + 1 ; page v1 conservée   | **v2 @ N + 1** |
| après la mutation suivante | deux pages v2 : la mutation écrit sur la page libre     | **v2**         |

La page v1 survivante disparaît d'elle-même à la mutation suivante. **Aucun geste n'est ajouté pour
l'effacer** : en ajouter un retirerait au rang 2 le repli qui fait toute la sûreté du geste.

**La migration n'est déclarée faite qu'une fois la page v2 RELUE** sous la même clé, à la version
attendue. Écrire et croire aurait suffi tant que rien ne va mal ; relire est ce qui distingue « la
page est là » de « la page s'ouvre ».

**Un échec d'écriture ne fait PAS échouer le déverrouillage.** Le volume s'ouvre sous sa page v1, et
la migration sera retentée. Refuser le déverrouillage parce qu'un changement de FORMAT n'a pas pu
s'écrire enfermerait l'utilisateur dehors pour une raison qui n'est pas la sienne. Le refus est
RENDU dans le compte rendu d'ouverture, jamais avalé : la distinction entre « ne pas lever » et «
taire ».

### Le refus de rétrogradation, et ce qu'il ne fait PAS

Une page v1 n'est candidate à l'autorité que si elle est **strictement plus ancienne** que la plus
récente des pages v2 valides. Sans cette règle, qui peut écrire dans l'origine de confiance
composerait une page v1 portant une version arbitrairement grande, en recalculerait la somme, et
l'ouverture se ferait sous une racine scellée directement sous la clé de volume — un format
rétrogradé par une écriture, sans décision et sans qu'aucun refus ne le dise.

La règle **n'écarte pas** la page v1 dès qu'une v2 existe, et c'est délibéré. Une page v2
structurellement valide dont la racine ne s'ouvrirait pas — un défaut de notre côté, ou une page
forgée — rendrait alors le volume INOUVRABLE, là où le repli sur la v1 le sauve. Entre « refuser un
peu moins » et « risquer de perdre le volume », l'ADR 0020 a déjà tranché une fois.

## Décision 3 — Le troisième chemin hors transaction clôt par une racine

L'ADR 0033, décision 4, donne deux conduites à une session qui scelle sous une clé à compteur :
clore par une racine, ou être en LECTURE SEULE. Le volume de COQUILLE ne pouvait être ni l'une ni
l'autre : il écrit un secteur à chaque déverrouillage — l'E2E `reprise-coquille-boot-froid` a réfuté
la lecture seule par exécution —, et écrire une racine sur un volume DÉJÀ DATÉ demandait un geste
que `GenerationStore` n'exposait pas.

**Le geste est `cloturerParRacine`, et il n'ouvre AUCUN second chemin de scellement** : il appelle
le vidage que la récupération et le point de contrôle appellent déjà.

**La session hors transaction TIENT son magasin sans l'INSTALLER**, et c'est là toute la conception.
L'installer détournerait les écritures vers le journal, ce que ce mode ne veut pas : la coquille
écrit son secteur de serrure directement. Le tenir apporte deux choses, et rien d'autre — les
compteurs de la racine qui fait autorité sont repris à l'ouverture, et la racine de clôture les
republie à la fermeture.

**La clôture n'écrit AUCUNE racine si la session n'a rien scellé.** Une clôture inconditionnelle
consommerait un scellement pour publier le compte de ce scellement : un compteur qui avancerait
d'une unité par ouverture, c'est-à-dire la dérive que la règle a précisément pour objet d'empêcher.

**La clôture suit le SECTEUR, et non la fermeture.** Une racine écrite au seul `close()` perdrait
tout ce qu'une session TUÉE a scellé, et une session de coquille est tuée à chaque onglet fermé —
`pagehide` termine le Worker sans que `close()` ne soit appelé. La revue de la PR #187 l'a mesuré
(constat 3 de la revue de sécurité) : 33 publiés pour 37 réels après UNE session tuée, et la perte
était définitive. La racine est donc écrite dans la même séquence d'écriture que le secteur qu'elle
publie, avant que la main ne revienne à l'appelant. Le geste est IDEMPOTENT — le repère avance avec
la racine qu'on vient d'écrire (constat 6 de la même revue) —, de sorte que le `close()` qui suit
n'écrive pas une seconde racine.

L'alternative examinée était de RÉSERVER le compte dans une racine écrite AVANT le secteur, comme la
v4 réserve la place du témoin. Elle est écartée : réserver suppose de savoir combien une écriture va
consommer avant de la faire, et une écriture directe scelle un secteur par tranche de la taille d'un
secteur — le nombre n'est connu qu'une fois l'écriture acceptée.

### Le QUATRIÈME chemin, et pourquoi il ne clôt PAS : `clotureParDatation`

L'INSTALLATION INITIALE écrit le fichier entier, le ferme, puis le fait DATER. Clore par une racine
à chaque secteur versé coûterait une racine par secteur, et la datation les périmerait toutes. Le
versement DÉCLARE donc, à l'ouverture, que sa clôture sera la datation : aucune clôture n'est
installée, la session rend son COMPTE à l'appelant, et `daterLaCreation` le REPORTE dans la racine
finale.

**Cet invariant est FAIT, mais non garanti** — le vocabulaire est celui de l'ADR 0021. Il est tenu
par l'APPELANT et par lui seul : rien ne confronte la déclaration, et un volume qui déclarerait la
datation sans être daté ne clôrait par rien et se rouvrirait tout de même, hors transaction comme en
transaction. La revue de la PR #187 l'a reproduit (constat 7 de la revue de sécurité), et elle
qualifie elle-même la situation : « c'est une garde qui n'en est pas une, pas un trou ».

Faire porter la promesse par le CODE était l'autre option — refuser à la réouverture un volume qui a
déclaré la datation sans avoir été daté. Elle est écartée pour un motif de proportion : le drapeau
est interne, `verserLeDisque` et le banc de budget sont les seuls à le poser, aucune surface exposée
ne l'atteint, et la garde coûterait un état durable de plus — précisément ce que la décision 2 de
l'ADR 0033 refuse aux domaines à usage unique. Ce qui est dû ici est l'AVEU, et il est écrit : au §
4.5 et au § 7.1 de la spécification, et ici.

### Deux conséquences, écrites plutôt que découvertes

1. **la fraîcheur est RÉTABLIE.** La racine de clôture rescelle l'empreinte de région sous sa propre
   génération (ADR 0019). Une écriture hors transaction ne périme donc plus la fraîcheur de la
   dernière racine, et le volume se rouvre transactionnellement — la seconde moitié de l'écart que
   la PR #186 avait mesurée ;
2. **la fraîcheur n'est PAS confrontée sur ce chemin**, et cette conséquence-ci a d'abord été écrite
   à l'envers. Elle a été vraie le temps d'un commit : le chemin hors transaction confrontait la
   fraîcheur comme tout autre, et le banc de navigateur l'a RÉFUTÉE par exécution — un Worker de
   confiance peut être tué sans avoir clos, c'est le cas ordinaire d'un onglet fermé, et la garde
   refusait alors le coffre à l'ouverture suivante pour un verrouillage parfaitement ordinaire. La
   garde a donc été retirée (`confronterLaFraicheur = false` hors transaction), et la revue de la PR
   #187 a relevé que cet ADR et le § 4.5 publiaient toujours l'inverse (constat 2 de la revue de
   sécurité, constat 2 de la revue de format).

   Ce qui est vrai est donc ceci, et c'est la même phrase au § 4.5 et dans `SECURITY.md` : la
   clôture par racine RÉTABLIT la fraîcheur pour l'ouvreur transactionnel qui suivra ; elle ne la
   CONFRONTE pas. Le volume de coquille ne gagne AUCUNE garde de l'ADR 0019 — il n'en a jamais
   porté. Un secteur ramené en arrière reste refusé, mais au SECTEUR par son sceau
   (`VAULT_STORAGE_SCEAU_REFUSE`, à la LECTURE) et non à l'ouverture
   (`VAULT_STORAGE_GENERATION_CORRUPT`). Aucun clair d'un secteur rejoué n'est rendu dans l'un ni
   dans l'autre régime, et `tests/unit/vm-cloture-par-racine.test.mjs` le MESURE.

   Ce que le retrait DÉPLACE, plutôt qu'il ne l'efface : une ouverture-fermeture hors transaction
   suffit désormais à faire tomber le refus de la BARRIÈRE au SECTEUR pour un ouvreur transactionnel
   ultérieur — la récupération réécrit le journal et le témoin même quand `cloturerParRacine()` rend
   `false`. Le relecteur l'a mesuré ; c'est un refus plus tardif, jamais un refus perdu.

## Décision 4 — Le runtime v4 exporte un volume v3, par le lecteur de la migration

Un pas destructif exige une sauvegarde VÉRIFIÉE (ADR 0011) ; l'export ouvrait tout volume de format
au moins 3 par l'ouvreur v4, qui refuse un en-tête v3. **Un v3 n'était migrable qu'à condition de
détenir déjà une archive faite par le runtime précédent.**

L'export d'un v3 emprunte désormais le SEUL lecteur de v3 du dépôt —
`migration-source-chiffree.mjs`, c'est-à-dire le vrai magasin de générations monté sur l'accès brut.
Rien n'est réécrit de ce lecteur, et c'est le point : un second chemin de lecture v3 serait un
second endroit où les trois cas de #181 pourraient diverger. La génération validée que le journal
porte encore est appliquée avant la copie ; les trois cas de l'ouverture s'appliquent avant tout
clair ; aucun chemin d'ÉCRITURE v3 ne s'ouvre à l'appelant.

**L'écart qui reste, et il n'est pas comblé.** Ouvrir un volume v3 n'est pas gratuit : le magasin
clôt sa récupération en écrivant une racine v3, et rejouer une charge rescelle des secteurs — **3 +
N scellements** sous la clé de volume elle-même.

Ce nombre a d'abord été ÉCRIT « deux », dans cet ADR et dans dix autres endroits du dépôt, et il
n'avait jamais été compté ; la revue de la PR #187 l'a réfuté par la mesure, et la mesure vit
désormais dans le dépôt. Le PLANCHER est de trois — l'empreinte de région que le magasin écrit en
montant, la racine de clôture de sa récupération, et le témoin qui la suit — et chaque secteur
rejoué de la charge acquittée en ajoute UN. N n'est donc pas borné par cet ADR : il l'est par le
contenu du journal validé, et un v3 abandonné au milieu d'une écriture longue en porte autant que
son journal en tenait. Ce que la mesure établit aussi, et qui vaut autant que le nombre : les 3 + N
passent TOUS par le budget, donc la racine v3 les publie — ce chemin ne scelle rien hors compteur,
et `tests/unit/vm-migration-source-v3.test.mjs` › « ce que l'export d'un v3 SCELLE est mesuré »
exige l'égalité entre les invocations relevées et le delta du compteur publié.

Ils sont le prix de l'application de la charge acquittée, ils passent par l'unique exception du
cliquet anti-DEK, et ils sont exactement ceux que la migration produit déjà sur le même fichier. Ne
pas ouvrir perdrait une écriture acquittée ; un lecteur v3 dédié qui n'écrirait rien ne saurait pas
appliquer la charge, donc perdrait la même chose sous un autre nom. La décision de T2b demandait «
aucun scellement sous une clé v3 hors l'engagement d'archive » : **ce chemin n'y parvient pas**, et
le § 7.4 de la spécification, `SECURITY.md` et cet ADR le portent dans les mêmes termes.

## Décision 5 — Le cliquet anti-DEK lit les APPELS, et nomme la matière de chaque clé

Le cliquet PROVISOIRE de T2a tenait l'inventaire des modules important encore la clé de volume en
clé AES-GCM : il relevait le nom de la porte jusque dans la prose et ne distinguait pas un appel
d'un réexport — huit inscriptions, dont cinq n'étaient que des mentions.

Le cliquet définitif lit les APPELS et relève TOUT import d'une clé AES-GCM, puis nomme sa
**matière** : `dek` (une clé de volume), `kek` (une clé de déverrouillage, qui est AES-GCM par
construction et ne descend pas de la clé maîtresse), `vecteur` (des octets publiés). La propriété
qu'il verrouille est celle-ci : **aucun chemin de production du format v4 ne touche une clé de
volume.** Trois endroits la touchent encore, et aucun n'en est un :

| Endroit                               | Rôle              | Peut CHIFFRER ? | Pourquoi il reste                                 |
| ------------------------------------- | ----------------- | --------------- | ------------------------------------------------- |
| `format-chiffre/modele-reference.mjs` | `modele`          | oui             | la spécification exécutable de l'ADR 0015         |
| `scellement.mjs`                      | `lecture-heritee` | oui             | le régime v3 : migration, et export d'un v3       |
| `enveloppe/page-v1-lecture.mjs`       | `lecture-heritee` | **non**         | la lecture d'une page v1, importée `decrypt` SEUL |

La dernière ligne est une décision à elle seule : la lecture d'une page v1 importe la clé **sans
l'usage `encrypt`**. Une `CryptoKey` dont les usages ne le portent pas fait rejeter
`crypto.subtle.encrypt` par la spécification WebCrypto. Au vocabulaire de la décision 7 de l'ADR
0021, c'est un **GARANTI** : ce module ne PEUT pas sceller, et ce n'est pas une discipline.

**Ce que le cliquet ne dit pas**, et qui est mesuré ailleurs : ce que WebCrypto refuse (trois
moteurs, `tests/browser/hierarchie-de-cles-frontiere.spec.mjs`) et ce qu'une session consomme
réellement (décision 6).

## Décision 6 — Le budget est MESURÉ par clé, sur une session complète

La revue externe n'a pas trouvé un bogue : elle a trouvé une PROMESSE que rien ne tenait. Une
tranche qui la remplace par d'autres promesses doit dire comment elle les tient.

`tests/unit/vm-budget-par-domaine.test.mjs` intercepte `deriveKey` et `importKey` pour ÉTIQUETER
chaque `CryptoKey` par sa provenance — l'info HKDF décodée, ou les octets présentés — puis compte
les invocations de `encrypt` PAR CLÉ sur une session complète : création, versement, datation,
ouverture transactionnelle, second volume sous la MÊME clé de volume, capture de reprise, enveloppe,
moyen de récupération, export avec archive, révocation.

Quatre propriétés, mesurées et non déclarées :

- **zéro invocation sous la clé de volume elle-même** ;
- **aucune clé de provenance inconnue n'a chiffré** — sans quoi la mesure serait creuse ;
- **les quatre domaines à usage unique n'ont jamais deux invocations sous la même clé** ; c'est la
  condition qui rend leur budget de 1 valable, et l'ADR 0033 demandait qu'elle soit relue ;
- **les deux domaines à compteur ont une clé par volume**, et deux volumes sous la même clé
  maîtresse n'en partagent aucune — le test minimal du relecteur.

## Modèle de menace : ce qui change, ce qui ne change pas

Au vocabulaire de la décision 7 de l'ADR 0021.

**GARANTI :**

- **aucun artefact du produit n'est scellé sous la clé de volume.** C'est mesuré par clé, pas par
  inspection d'appelants ;
- **la lecture d'une page v1 ne peut pas sceller** : la clé y est importée sans `encrypt`, et c'est
  WebCrypto qui le tient ;
- **deux pages d'enveloppe ne partagent jamais leur clé de racine** : le sel est tiré à chaque
  écriture ;
- **la page d'une archive ne partage pas sa clé avec la serrure restée sur l'appareil.**

**FAIT, mais non garanti :**

- **la migration d'une page v1 ne perd aucune clé de déverrouillage sous coupure.** C'est mesuré sur
  quatre sinistres et quatre rangs — six coupures réellement produites, énumérées et exigées à
  l'égalité — avec quatre clés, et sur sept altérations du fichier APRÈS la migration ; ce n'est pas
  une preuve formelle ;
- **les deux compteurs restent exacts tant que le support n'a pas reculé.** Inchangé depuis
  l'ADR 0033.

**IMPOSSIBLE :**

- **détecter le retour arrière COMPLET du support.** Rien ici ne le change ;
- **empêcher un adversaire qui écrit dans l'origine de confiance d'effacer la page v2 pour faire
  retomber le lecteur sur la page v1.** L'alternance conserve exprès l'état d'avant ; l'ancrage
  monotone est la question n° 3, et `versionMinimale` en est le point de branchement.

## La campagne de MUTATION de cette tranche

`node tools/muter-gardes-enveloppe-v2.mjs` retire RÉELLEMENT chaque garde de son fichier source,
relance l'épreuve qui devrait la couvrir, et vérifie qu'elle rougit. **Dix-sept gardes, dix-sept
mutants tués**, sur neuf endroits. La table vit ici comme celle de l'ADR 0035 vit dans l'ADR 0035 :
`docs/testing.md` compte, l'ADR dit QUOI.

| Fichier muté                              | Gardes retirées                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enveloppe-de-cle.mjs`                    | le TIRAGE du sel de page, l'avance de la version à chaque mutation                                                                                        |
| `enveloppe/etat-de-lenveloppe.mjs`        | le refus de RÉTROGRADATION d'une page v1 au-dessus d'une v2, la migration à la première ouverture réussie                                                 |
| `enveloppe/fichier-enveloppe.mjs`         | le refus d'un DOMAINE inconnu, l'effacement de la page v1 par la migration, le refus d'une page déjà en v2                                                |
| `export-du-fichier.mjs`                   | le contrôle de l'en-tête v3 avant l'export                                                                                                                |
| `generation-racine.mjs`                   | la RÉSERVATION du témoin dans le compte que la racine publie                                                                                              |
| `generation-store.mjs`                    | la clôture par racine, la marque de région sale, l'idempotence du repère                                                                                  |
| `opfs-block-backend.mjs`                  | la publication de la racine APRÈS le secteur, hors transaction                                                                                            |
| `opfs-volume-ouverture.mjs`               | le fait de TENIR le magasin sans l'installer sur le chemin hors transaction                                                                               |
| `tests/unit/vm-cliquet-anti-dek.test.mjs` | les QUATRE motifs du cliquet, séparément : les alias jusqu'au point fixe, le réexport EN BLOC, le réexport comme porte, la référence opaque à `importKey` |

Deux choses méritent d'être dites, parce qu'elles sont le résultat de la campagne et non son décor.
**La campagne a TROUVÉ deux défauts** qu'aucune épreuve verte ne montrait : un second tirage de sel
qui n'était jamais atteint — retiré —, et une mutation qui portait sur un texte présent deux fois,
donc ambiguë. Et le **CLIQUET est lui-même muté**, motif par motif : c'est la seule « source » de
cette table qui soit une épreuve, et la revue de la PR #186 avait trouvé un cliquet dont un seul des
deux mutants était vu. Chaque motif retiré doit suffire à faire rougir « le cliquet MORD ».

## Ce que cet ADR ne prétend PAS résoudre

L'emplacement du compteur — il reste dans la racine, donc il recule. La rotation de la clé
maîtresse, qui n'existe toujours pas. AES-GCM-SIV, dont le périmètre de spike est écrit dans
l'ADR 0033. Et l'écart de la décision 4 : ouvrir un volume v3 scelle 3 + N fois sous la clé de
volume — N secteurs rejoués, tous comptés dans la racine v3 —, et aucune des deux options envisagées
ne l'évite sans perdre une écriture acquittée.

## Conséquences

- Le format que ce runtime ÉCRIT est : volume **v4**, journal **format 5**, manifeste **format 4**,
  instantané **format 2**, archive **v3**, page d'enveloppe **v2**.
- Les vecteurs `tests/vectors/enveloppe-v1.json` et `tests/vectors/archive-v3.json` ne bougent pas
  d'un octet et changent de RÔLE : ils deviennent des vecteurs de MIGRATION et de COMPATIBILITÉ. Les
  vecteurs v2 vivent dans `tests/vectors/enveloppe-v2.json`, et `node tools/verifier-vecteurs.mjs`
  en refait la chaîne entière depuis le seul texte — 244 vérifications vertes, contre 222 avant
  cette tranche. Les quatre dernières viennent de la revue de la PR #187 (constat 8 de la revue de
  format) : l'ASSIETTE de la somme de contrôle, désormais publiée au § 6.11, est refaite sur les
  octets FIGÉS de chaque page, avec son témoin négatif — un bit changé dans le sel change la somme.
  Les fichiers de vecteurs, eux, n'ont pas bougé d'un octet.
- Les ADR 0020, 0027, 0033 et 0035 reçoivent leur note datée du 11 septembre 2026.
- La ligne #182 du [registre](../revue-externe/registre.md) passe à `corrigé`, en citant les DEUX
  PR.
- **Ce qui n'est PAS fait, et qui est écrit ici comme dans `docs/testing.md`** : le palier v3 de
  l'E2E de migration — arrêter la chaîne à v3, l'ouvrir, y écrire, la refermer, la sauvegarder par
  le runtime v4, puis migrer — n'est pas revenu. Le chemin qui le bloquait est ouvert, et le cycle
  entier est éprouvé en unitaire sur un v3 produit par le produit
  (`tests/unit/vm-migration-source-v3.test.mjs`) ; mais le banc de cette tranche n'avait pas d'image
  de référence, et écrire un palier d'E2E qu'on n'a pas exécuté serait écrire une supposition.
