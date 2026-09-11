# ADR 0027 — L'archive emporte une enveloppe de RÉCUPÉRATION SEULE, et la feuille ancre la version

- Statut : accepté
- Date : 2026-09-06
- Issue : #149 (tranche 3 de #23) · Invariants : `SEC-RECOVERY-001`, `SEC-KEY-001`, `VAULT-PORT-001`
  · Jalon 5
- **Révise la décision 6 de l'[ADR 0020](0020-enveloppe-de-cle.md)**, dont la condition d'abandon 3
  est déclenchée. Rien de l'ADR 0020 n'est réécrit : sa décision 6 reçoit une note datée d'une ligne
  qui renvoie ici.

> **AMENDÉ le 2026-09-10 par l'[ADR 0034](0034-archive-authentifiee-et-racine-initiale.md) (#181,
> [PR #184](https://github.com/pinfada/railsbox-vault/pull/184)) :** la disposition de l'archive
> gagne un champ d'en-tête — `engagement` — et la version passe à 3. La section de récupération, ses
> offsets et son arithmétique `12 + H + N + R` ne bougent pas ; la version de l'enveloppe embarquée
> entre dans ce que l'engagement scelle.

> **Révision ANNONCÉE le 2026-09-10 par
> l'[ADR 0033](0033-hierarchie-de-cles-derivees-par-domaine.md) (#181, #182) :** la racine rescellée
> à l'export passera sous une clé du domaine `recuperation` à USAGE UNIQUE, et l'archive qui la
> porte gagnera un engagement authentifié ; rien n'est amendé ici tant que T1 et T2b n'ont pas
> livré.

## Contexte

L'ADR 0020, décision 6, tranchait : « l'archive n'emporte pas l'enveloppe ». Elle posait aussi, dans
la même page, la question qu'elle ne tranchait pas — « l'archive devrait-elle porter une enveloppe
de récupération ? » — et la renvoyait explicitement à #23, avec sa condition d'abandon 3 :

> #23 tranche que l'archive doit porter une enveloppe de récupération, auquel cas la décision 6 est
> amendée avec le format de cette enveloppe et ce qu'elle suppose des codes de secours.

Les deux premières tranches de #23 ont livré ce qui manquait.
L'[ADR 0025](0025-moyen-de-recuperation.md) (#147) pose le **code de récupération** : cent
vingt-huit bits tirés, rendus une fois, persistés nulle part, servant un emplacement de **type 4**.
L'[ADR 0026](0026-revocation-d-urgence-et-page-libre.md) (#148) pose la révocation d'urgence et
l'effacement de la page libre. Le « ce qu'elle suppose des codes de secours » existe donc.

**Le constat qui force la révision est celui de la Definition of Ready de #149**, et il tient en une
phrase : _restaurer ailleurs un volume chiffré donne aujourd'hui un volume que personne n'ouvre._
L'archive porte le fichier du volume octet pour octet (ADR 0016, décision 7) ; depuis #18 ce fichier
est chiffré sous une clé de volume que le produit ne fabrique ni ne conserve ; et depuis #21 cette
clé n'est récupérable que par le voisin `<volume>.cles`, que l'archive ne porte pas. Le geste que
l'utilisateur croit accomplir — « je sauvegarde mon coffre » — n'en sauvegarde que la moitié, et il
ne l'apprend qu'au moment où l'autre moitié aurait servi.

C'est exactement ce que la vision du produit refuse en ses points 4 et 7 : _les données de
l'utilisateur lui appartiennent et le suivent_, et _ce qui n'est pas couvert est dit avant, pas
découvert après_. Une sauvegarde qui ne restaure rien d'ouvrable ne fait pas suivre les données ;
elle les déplace.

## Décision 1 — La décision 6 de l'ADR 0020 est RÉVISÉE, et ce qu'elle protégeait est conservé

### Ce que la décision 6 disait

L'archive ne porte **ni le manifeste de clés, ni une DEK enveloppée, ni un octet du fichier
`.cles`**. Deux épreuves la tenaient : l'une exportait réellement et cherchait le marqueur
`VLTKEY01` et des octets d'emplacement dans l'archive ; l'autre relisait le chemin d'export et
d'import et exigeait qu'aucun de ses modules ne connaisse le voisin d'enveloppe.

Le motif était juste et il reste juste : **mettre dans le même fichier le coffre et sa clé** annule
le chiffrement au repos dès que ce fichier quitte l'appareil.

### Ce qui reste vrai, et qui est la seule raison pour laquelle la révision est possible

**Le CODE n'est jamais dans l'archive.** Ce que l'archive emporte est une page d'enveloppe portant
une DEK **enveloppée sous une KEK dérivée du code** — jamais le code, jamais la KEK, jamais la clé
de volume en clair. Le code vit sur une feuille de papier, chez l'utilisateur, et l'ADR 0025 a
mesuré qu'aucun chemin du produit ne le conserve, ne le journalise ni ne sait le régénérer.

Le coffre et sa clé ne voyagent donc **toujours pas** ensemble :

| Ce qu'un adversaire tient | Ce qu'il obtient                                          |
| ------------------------- | --------------------------------------------------------- |
| l'archive seule           | rien : 2^128 essais sur un code qu'aucun fichier ne porte |
| le code seul              | rien : il n'y a pas de données                            |
| l'archive **et** le code  | le volume — et c'est précisément le service rendu         |

### Ce que la révision fait perdre, dit plutôt que tu

Elle **change le profil du vol d'archive**. Avant, voler une archive ne donnait aucun chemin
d'attaque vers le clair, même en supposant l'adversaire patient : la DEK enveloppée n'était pas dans
le fichier. Après, elle y est, et un adversaire hors ligne peut essayer des codes contre elle sans
limite de tentatives et sans qu'aucun système ne compte ses essais.

Ce qui rend ce profil acceptable est **mesuré, pas espéré** : le code porte 128 bits TIRÉS (ADR
0025, décision 2), et la KEK en est dérivée par HKDF sans étirement — donc à coût de vérification
minimal pour l'adversaire, ce que l'ADR 0025 assume déjà. Cent vingt-huit bits d'entropie réelle ne
se parcourent pas ; c'est la même borne que celle qui protège n'importe quelle clé de ce format, et
elle ne dépend d'aucun secret que l'utilisateur choisirait.

C'est aussi pourquoi **une phrase secrète ne voyage jamais** : elle porte l'entropie qu'un humain a
bien voulu lui donner, et une attaque hors ligne sur une phrase est un exercice ordinaire. Voir la
décision 2.

## Décision 2 — L'archive emporte une enveloppe de RÉCUPÉRATION SEULE

### L'objet

Une **page d'enveloppe** au sens de l'ADR 0020 — 8 192 octets, disposition v1 **inchangée** — qui ne
porte QUE le ou les emplacements de **type 4** (`recuperation`), avec sa racine authentifiée sous la
DEK et **la version COURANTE de l'enveloppe**.

Trois propriétés en découlent, et chacune a une épreuve :

1. **jamais un emplacement `phrase` (type 1) ni `webauthn-prf` (type 2), ni le harnais (type 3).**
   Une phrase sortirait de l'appareil et deviendrait attaquable hors ligne ; une créance WebAuthn
   est liée à un appareil et n'ouvrirait rien ailleurs. Le filtrage est **structurel** — la
   construction filtre — et il est **relu à l'import** sur une page qui pourrait avoir été forgée ;
2. **la version portée est celle de l'enveloppe au moment de l'export**, jamais 1. C'est elle que
   l'ancre de la décision 3 confronte à la feuille de récupération. Une page qui repartirait de 1
   ferait de chaque restauration un retour arrière indétectable ;
3. **la racine est RESCELLÉE** sur la liste filtrée. Recopier la racine de la page complète
   authentifierait une liste qui n'est plus celle-là, et la page embarquée serait refusée par
   `VAULT_ENVELOPPE_MELANGE` au premier déverrouillage.

### Qui la construit, et pourquoi les modules d'archive restent aveugles

Filtrer change la liste ; la racine authentifie la suite ordonnée des emplacements sous la DEK. La
page doit donc être **rescellée**, ce qui exige la clé de volume, donc une enveloppe ouverte. Un
**seul module** du dépôt la construit — `src/vm/enveloppe-de-recuperation.mjs` —, et il reçoit une
KEK valable de son appelant : le Worker de confiance, qui tient déjà l'enveloppe ouverte.

`volume-export.mjs` ne nomme pas le voisin d'enveloppe et n'a rien à en savoir : il écrit une
section et déclare son empreinte. L'épreuve de la décision 6 le relit — transformée, voir plus bas.

### La GARDE DE FORME est un seul validateur, appelé aux trois portes

> **Corrigé le 6 septembre 2026, sur la revue de format de la PR #160.** La première rédaction ne
> gardait la forme qu'à l'IMPORT, au motif que le chemin d'archive devait rester aveugle. Le prix
> était trop élevé : `writeArchive` acceptait d'écrire n'importe quels octets sous l'étiquette «
> enveloppe de récupération », `verifyArchive` rendait un verdict VERT sur une section de cent
> octets de bourrage, et l'utilisateur n'apprenait le défaut qu'au moment de restaurer — au pire
> endroit et au pire moment.

`exigerEnveloppeDeRecuperationSeule` est appelée par `archive-recuperation.mjs`, **à l'écriture
comme à la lecture** : page lisible, taille exacte d'une page, emplacements de type 4 seulement, et
accord avec le descripteur de l'en-tête. Une archive fautive ne naît donc plus, et une archive
fautive reçue est refusée par la VÉRIFICATION, sans qu'aucun import soit tenté.

Ce que l'aveuglement conserve, et qui était le vrai enjeu : `volume-export.mjs` ne connaît ni le
voisin d'enveloppe, ni où il vit, ni comment il s'écrit ; et la CONSTRUCTION reste le fait du seul
module qui tient la clé de volume. La frontière s'est déplacée d'un cran — d'« aveugle au format » à
« aveugle au SUPPORT » — et c'est la bonne, parce que c'est celle que le vol d'une archive met à
l'épreuve.

L'IMPORT n'ajoute plus que ce qu'il est seul à pouvoir faire : confronter la page au MANIFESTE.

### Le format d'archive passe à la version 2

```text
  v1  [ RBVAULT1 8 o ][ longueur d'en-tête uint32 BE 4 o ][ en-tête JSON H o ][ contenu N o ]
  v2  … la même, suivie de                                                    [ récupération R o ]
```

- `offset du contenu = 12 + H` — **inchangé**, et c'est ce qui rend la lecture d'une v1 identique à
  ce qu'elle était ;
- `offset de la récupération = 12 + H + N` ;
- `taille de l'archive = 12 + H + N + R`, avec `R = 0` pour une v1 ou une v2 sans moyen.

L'en-tête JSON porte un champ de plus, dans cet ordre — `magic`, `archiveFormatVersion`, `content`,
`recovery`, `manifest` :

```json
"recovery": { "length": 8192, "digest": "<sha-256 hex>", "envelopeVersion": 2, "slots": 1 }
```

**La section est en QUEUE, et non intercalée.** L'export reste une écriture séquentielle en un seul
passage, et la restauration continue de lire le contenu à un offset qu'elle connaît dès l'en-tête.
Une section intercalée aurait décalé le contenu de tous les lecteurs, y compris ceux d'une v1, pour
ranger huit kio.

**`recovery: null` est ADMIS, et il est DIT.** Un volume sans moyen de récupération produit une
archive v2 dont le champ vaut `null`, et le compte rendu de l'export le porte tel quel : _cette
archive ne s'ouvrira nulle part ailleurs sans l'enveloppe_. Refuser d'exporter aurait exporté moins
que ce que l'utilisateur possède ; taire le fait aurait reproduit exactement le sinistre que cette
tranche referme.

**Une archive de version 1 reste LUE**, sans récupération et avec la conséquence qu'elle a toujours
eue. Elle n'est plus **écrite** : un écrivain d'aujourd'hui produit une v2, `recovery: null`
compris. Un en-tête v1 qui déclarerait une section de récupération est **malformé** — sa version dit
que la disposition n'en comporte pas, et laisser passer la contradiction ferait dépendre
l'arithmétique des sections d'un champ que le lecteur n'a pas encore regardé.

### Les refus, et pourquoi deux codes neufs

| Code                                 | Ce qu'il dit                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `VAULT_ARCHIVE_RECUPERATION_ALTEREE` | l'empreinte recalculée de la section diffère de celle inscrite.                       |
| `VAULT_ARCHIVE_RECUPERATION_REFUSEE` | la section n'est pas une enveloppe de récupération SEULE, ou l'en-tête ment sur elle. |

`RECUPERATION_ALTEREE` est distinct de `VAULT_ARCHIVE_DIGEST_MISMATCH` parce que **le remède l'est**
: un contenu altéré rend l'archive inutilisable ; une enveloppe altérée rend le volume restauré
inouvrable ailleurs alors que ses données sont intactes. Confondre les deux enverrait réexporter là
où il faut d'abord savoir lequel des deux on a perdu.

**L'en-tête est CONFRONTÉ à la page, jamais cru** : une archive qui déclarerait une version
d'enveloppe plus récente que celle qu'elle porte tromperait l'ancre de la décision 3, c'est-à-dire
ferait accepter sans consentement une sauvegarde antérieure à la feuille. **Un en-tête de version 2
déclare TOUJOURS le champ `recovery`** — objet, ou `null` explicite : un champ absent accepté comme
`null` suffisait à faire de huit kilo-octets d'enveloppe une queue que personne ne lit, et la
capacité d'ouvrir disparaissait en silence. **Rien ne suit une archive** : des octets au-delà de la
fin déclarée sont refusés, faute de quoi une section greffée derrière une archive `recovery: null`
passerait inaperçue.

**L'ENVELOPPE DÉCRIT LE MÊME VOLUME QUE LE MANIFESTE**, et c'est le correctif du constat commun aux
deux revues de la PR #160. La page authentifie un identifiant de volume dans les données associées
de sa racine ; il était décodé et jeté. Greffer dans l'archive du volume B la page d'enveloppe du
volume A — empreinte et descripteur recalculés — passait toute la vérification, et le geste 7 posait
le voisin d'enveloppe de B sous l'identité de A : le volume restauré devenait inouvrable, et
l'enveloppe qu'il portait avait été écrasée pour cela. Aucune perte de confidentialité — la page de
A n'ouvre rien de B —, mais **une destruction assortie d'un diagnostic que la restauration
fabriquait elle-même**. C'est le pendant, pour l'enveloppe, de ce que l'ADR 0009 referme pour le
manifeste : les deux contrôles accordent le manifeste à l'en-tête v3 du fichier d'un côté, à la
racine authentifiée de la page de l'autre. Une archive dont les trois sources s'accordent décrit un
seul volume. Une archive qui emporte une enveloppe **sans déclarer d'identifiant** — un format
antérieur à v3 — est refusée : un voisin se pose sous une identité, jamais sous « on verra bien ».

### À la restauration : l'ordre, et pourquoi il n'est pas négociable

L'ADR 0009 posait sept gestes. Il y en a huit :

1. VÉRIFIER l'archive entière — empreinte du contenu **et** empreinte de la section, page embarquée
   relue et ses types vérifiés — **sans écrire un octet** ;
2. REFUSER ce qui doit l'être avant la mutation : cible occupée, géométrie, espace — et, désormais,
   l'ANCRE de la décision 3 ;
3. OUVRIR la cible en exclusivité ;
4. RÉVOQUER le manifeste de la cible, puis écarter ses voisins de génération ;
5. RESTAURER le contenu en flux, puis franchir une barrière ;
6. RE-VÉRIFIER le volume restauré en le RELISANT depuis le support ;
7. **POSER l'enveloppe de récupération** — `<volume>.cles`, page 0 = la page embarquée, page 1 à
   ZÉRO — ou RETIRER celle que la cible portait ;
8. INSCRIRE le manifeste.

**Le rang 7 vient avant le rang 8, et c'est la décision.** Le manifeste est ce qui DÉCLARE le volume
complet et inscriptible (ADR 0007, ADR 0009) ; l'enveloppe est ce qui le rend OUVRABLE. Les inverser
laisserait, pendant l'intervalle d'une coupure, **un volume déclaré complet que personne n'ouvre** —
le sinistre même que cette tranche referme. Dans l'ordre retenu, une coupure entre 6 et 8 laisse un
volume NON IDENTIFIÉ, que `assertVolumeWritable` refuse par `VAULT_MANIFEST_UNIDENTIFIED` : le seul
état sûr des deux. C'est l'ordre de l'ADR 0009 prolongé d'un cran, pas une règle nouvelle.

**La page 1 est à zéro, et non une seconde copie.** L'alternance protège une MUTATION, et il n'y en
a pas eu ; surtout, la première mutation du volume restauré écrira sur la page 1, et lui laisser un
état antérieur valide offrirait un point de repli à ce qui doit précisément ne plus en avoir.

**L'enveloppe d'un volume ÉCRASÉ ne survit pas.** Elle décrit un volume qui n'existe plus : ses
emplacements enveloppent une DEK que le volume restauré n'emploie pas, et sa racine authentifie un
autre identifiant. La laisser ferait répondre `VAULT_ENVELOPPE_IDENTITE` à qui essaie sa clé — un
diagnostic exact pour une cause qu'on aurait fabriquée soi-même. Le volume restauré se retrouve
alors sans enveloppe, ce qui est l'état vrai : `VAULT_ENVELOPPE_ABSENTE` envoie en créer une.

Le volume restauré s'ouvre ensuite **par le code**, et l'utilisateur y recrée un emplacement
`phrase` — exactement le cycle de #147, joué sur l'appareil neuf.

### Ce qui NE change pas

La disposition d'enveloppe v1, les vecteurs `tests/vectors/enveloppe-v1.json`, le format de volume
v3, le format de manifeste, l'offset du contenu d'une archive. Aucun vecteur existant ne bouge.

## Décision 3 — L'ancre est la version notée sur la FEUILLE, et `versionMinimale` est enfin alimenté

### Ce que l'ADR 0020 avait laissé ouvert

Il avait posé `versionMinimale` et écrit sa limite : « un adversaire qui EFFACE la page courante
fait retomber le lecteur sur la précédente, donc ressuscite une clé révoquée ». Le paramètre
existait ; **aucun chemin de production ne le fournissait**, et `null` était passé partout. Un
paramètre que personne ne passe est un paramètre qui n'existe pas.

### La décision

**La feuille de récupération porte, à côté du code, la VERSION D'ENVELOPPE**, à re-noter à chaque
**RÉVOCATION** — pas à chaque ouverture, ni à chaque ajout. Les trois opérations qui RETIRENT une
clé (`revoquerEmplacement`, `revoquerToutSauf`, `remplacerEmplacement`) rendent déjà `version` :
c'est CE chiffre que l'interface de #24 fera noter.

> **NOTE DATÉE DU 11 SEPTEMBRE 2026** (#182, tranche T2b, revue de sécurité de la PR #187, constat
> 5). **La MIGRATION d'une page v1 en v2 avance le compteur d'une unité, et ce cran n'est le fait
> d'aucun geste de l'utilisateur.** Il n'a ni révoqué, ni remplacé, ni ajouté ; la première
> ouverture réussie d'une enveloppe écrite avant T2b rescelle sa racine sous une clé dérivée et
> publie la page v2 à la version N + 1.
>
> La conséquence porte exactement sur ce que cette décision promet. Le nombre noté AVANT la
> migration — N, la seule ancre qu'un porteur de page v1 puisse tenir, puisqu'elle a été notée avant
> que la migration n'existe — ne détecte plus l'effacement de la page v2 : un adversaire qui sait
> écrire dans l'OPFS la retire, le volume retombe sur sa page v1 à la version N, l'ancre ne bronche
> pas, et le produit remigre. Ce cran est précisément la marge dont l'adversaire a besoin. Ce n'est
> pas une perte de volume, aucun clair n'est rendu de travers, et le refus de rétrogradation MORD
> bien tant qu'une page v2 subsiste ; ce qui manquait était l'aveu.
>
> **La conduite est de RE-NOTER la version affichée après la première ouverture qui migre**, et la
> coquille le DIT désormais : la réponse de déverrouillage porte `enveloppeMigree`, et l'interface
> ajoute « RE-NOTEZ cette version — celle que vous aviez notée ne vaut plus » à la ligne d'état.
> C'est la seule occasion où le produit invite à re-noter en dehors d'une révocation, et elle est
> unique par volume : une enveloppe déjà en v2 ne migre plus.

Un utilisateur qui ne note rien n'est pas puni : sans feuille (`versionMinimale: null`), rien n'est
exigé — **et rien n'est promis**. L'aveu est écrit ici, et il est éprouvé à la ligne suivante de
l'épreuve qui prouve l'ancre : sans ancre tenue hors du fichier, une page antérieure réinstallée est
ACCEPTÉE, et la clé révoquée ouvre le volume.

Ici, pas d'interface : le **Worker de confiance** et les bancs acceptent `versionMinimale` de leur
appelant et le passent aux ouvreurs (`ouvrirVolumeParDerivateur`, `ouvrirVolumeParKek`,
`ouvrirEnveloppe`). C'est le chemin de production par lequel l'ancre est alimentée, et il n'y en a
pas d'autre tant que #24 n'existe pas.

**L'ancre est une SAISIE de l'utilisateur dans la coquille, jamais une valeur lue d'un stockage de
l'appareil.** La règle est écrite ici avant que quiconque ait à l'implémenter, parce qu'elle est le
seul point qui distingue une ancre d'une redondance : une version rangée à côté du fichier qu'elle
protège est ramenée en arrière par le même geste que lui, et une version fournie par l'origine
applicative rouvre le déni de service écarté ci-dessous. #24 la porte, et sa Definition of Ready la
reprend.

### Restauration et ancre : le consentement NOMMÉ

Une archive est **par nature ANTÉRIEURE**. Si la version de la feuille dépasse celle de l'enveloppe
embarquée, l'ouverture du volume restauré sous `versionMinimale` serait refusée — et l'utilisateur
découvrirait le problème après avoir écrasé sa cible.

**Règle** : la restauration d'une archive plus ancienne que la feuille exige un **CONSENTEMENT
NOMMÉ**, sur le modèle de l'[ADR 0011](0011-migration-de-format-et-reprise.md) : `acknowledgedBy`
non vide, `reason` facultative. Le refus, `VAULT_IMPORT_CONSENTEMENT_REQUIS`, dit à l'utilisateur ce
qu'il accepte :

> cette sauvegarde date d'avant votre dernière révocation : une clé révoquée depuis pourrait y être
> encore valable.

Il n'interdit rien — refuser rendrait inutilisable toute sauvegarde prise avant la dernière
révocation, c'est-à-dire à peu près toutes. Il exige qu'un exploitant identifié assume, et le
rapport le porte. **Après consentement, la version restaurée devient la nouvelle référence** : la
feuille est à re-noter, et le rapport de restauration publie ce chiffre sous `nouvelleReference`.

Une archive **sans** enveloppe échappe à la règle : elle ne rétablit aucune clé, donc elle ne
ressuscite rien.

### Les ancres écartées, par écrit

- **(b) l'origine applicative comme ancre** — ÉCARTÉE. Faire dépendre l'ouverture d'un volume sain
  d'un état tenu par du code que la topologie de
  l'[ADR 0002](0002-topologie-origine-de-confiance.md) suppose HOSTILE offre un déni de service : il
  suffit à ce code de faire avancer le compteur pour rendre le volume inouvrable. Une protection
  contre le rejeu qui se retourne en perte de données n'est pas une protection ;
- **(c) `signCount` WebAuthn** — déjà écartée par
  l'[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) ; renvoi, pas de nouvelle décision ;
- **(e) témoin distant** — hors jalon. La note de l'ADR 0025 reste la règle si le dépôt s'y résout
  un jour : **une ancre externe porterait les DEUX compteurs — celui du volume et celui de
  l'enveloppe — jamais deux ancres**, faute de quoi un adversaire choisirait le couple qui
  l'arrange. Renvoi au jalon 6.

La limite « le retour arrière COMPLET du support n'est pas détecté » reste dans `SECURITY.md` et
dans l'[ADR 0019](0019-fraicheur-du-volume.md), **telle quelle** : cette tranche ne la ferme pas.

## Décision 4 — Ce qui est couvert, ce qui ne l'est pas

`SECURITY.md` porte la liste, et `tests/unit/dossier-de-revue.test.mjs` la relit.

**Devient VRAI** : « appareil perdu, avec l'archive et le code ». L'entrée existait déjà, avec sa
réserve — « aujourd'hui l'archive n'emporte PAS `<volume>.cles` ». La réserve tombe, et c'est le
résultat de cette tranche.

**Entrée NOUVELLE** : « une archive porte l'enveloppe de récupération : qui détient l'archive ET le
code ouvre le volume ; l'archive seule n'ouvre rien ». Elle dit le service rendu et son prix dans la
même phrase.

**Inchangé, et non couvert** : tous les moyens perdus, code compris (aucun séquestre) ; archive
perdue ; copie du code prise avant révocation ; retour arrière complet du support.

## Les épreuves de la décision 6, TRANSFORMÉES

Une décision qu'aucune épreuve ne relit se défait toute seule. Les deux épreuves de l'ADR 0020
changent de NATURE plutôt que de disparaître :

| Épreuve de l'ADR 0020                                         | Ce qu'elle devient                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| « cherche `VLTKEY01` dans l'archive » — il ne doit pas y être | le marqueur est présent **exactement une fois**, à l'offset déclaré de la section, et la page décodée ne porte **que** des emplacements de type 4 |
| « aucun module d'export/import ne connaît `.cles` »           | les modules d'archive restent aveugles, et la construction vit dans **un seul module nommé**, que l'épreuve liste                                 |

S'y ajoutent : le code de récupération n'apparaît dans l'archive sous **aucune** de ses trois formes
(rendue, sans tirets, en minuscules) ; la clé de volume n'y apparaît pas non plus.

## La campagne de mutation

Chaque garde neuve a été RÉELLEMENT retirée du texte source par
`tools/muter-gardes-archive-recuperation.mjs`, l'épreuve relancée, puis le fichier restauré.
**Quinze mutations, quinze tuées** — dix à la première rédaction, cinq ajoutées par les revues de la
PR #160, et quatre de ces cinq ont d'abord SURVÉCU : les gardes qu'elles décrivent existaient, et
aucune épreuve ne les tenait.

| #   | Garde mutée                                                  | Verdict | Ce qui la tue                                             |
| --- | ------------------------------------------------------------ | ------- | --------------------------------------------------------- |
| 1   | le filtre de construction sur `typeKek === 4`                | TUÉ     | `vm-archive-recuperation`, `vm-archive-vecteurs`          |
| 2   | la relecture des types à l'import                            | TUÉ     | `vm-archive-recuperation`, `vm-restauration-recuperation` |
| 3   | la page 1 du voisin restauré est à ZÉRO                      | TUÉ     | `vm-restauration-recuperation`                            |
| 4   | l'empreinte de la section confrontée à l'en-tête             | TUÉ     | `vm-archive-recuperation`, `vm-restauration-recuperation` |
| 5   | une archive v1 reste LUE                                     | TUÉ     | `vm-archive-recuperation`                                 |
| 6   | l'en-tête est confronté à la page, jamais cru                | TUÉ     | `vm-restauration-recuperation`                            |
| 7   | l'ordre contenu → enveloppe → manifeste                      | TUÉ     | `vm-restauration-recuperation`, `vm-volume-import`        |
| 8   | le consentement exigé sous une feuille plus récente          | TUÉ     | `vm-restauration-recuperation`                            |
| 9   | `versionMinimale` transmis par `ouvrirVolumeParKek`          | TUÉ     | `vm-enveloppe-ancre-version`                              |
| 10  | `versionMinimale` transmis par `ouvrirVolumeParDerivateur`   | TUÉ     | `vm-enveloppe-ancre-version`                              |
| 11  | l'enveloppe embarquée décrit le MÊME volume que le manifeste | TUÉ     | `vm-restauration-recuperation`                            |
| 12  | une archive qui emporte une enveloppe DÉCLARE son volume     | TUÉ     | `vm-restauration-recuperation`                            |
| 13  | un en-tête v2 déclare toujours `recovery`, fût-ce à `null`   | TUÉ     | `vm-archive-recuperation`                                 |
| 14  | rien ne suit une archive : la queue est refusée              | TUÉ     | `vm-archive-recuperation`                                 |
| 15  | la FORME de la section est gardée À L'ÉCRITURE aussi         | TUÉ     | `vm-archive-recuperation`                                 |

Ce que la campagne ne peut PAS mesurer : que la page embarquée s'ouvre réellement sous le code une
fois restaurée sur un vrai support. C'est le scénario de bout en bout
`tests/e2e/archive-recuperation-inter-origine.spec.mjs` qui l'établit, et aucune mutation jouée sous
Node ne le remplace.

## Mesures

| Grandeur                                         | Valeur                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Section de récupération                          | **8 192 octets** — une page d'enveloppe                                       |
| En-tête JSON, surcoût du champ `recovery`        | **117 octets** (mesuré sur le vecteur figé)                                   |
| Surcoût total d'une archive v2 avec récupération | **8 309 octets**, quelle que soit la taille du volume                         |
| Surcoût d'une archive v2 sans récupération       | **17 octets** (`"recovery":null`)                                             |
| Empreintes recalculées à la vérification         | **deux** — contenu (en flux) et section (8 kio, d'un bloc)                    |
| Vecteur figé `tests/vectors/archive-v2.json`     | archive de **12 127 octets** : en-tête 851, contenu 3 072, récupération 8 192 |

Sur un volume applicatif de référence (plusieurs centaines de mébioctets), le surcoût est de l'ordre
de **2·10⁻⁵** de la taille de l'archive. La question du coût ne se pose pas ; celle de ce que ces
huit kio autorisent, si, et c'est la décision 1 qui y répond.

## Limites

1. **Une archive volée offre une cible hors ligne au code.** Voir la décision 1 : l'adversaire
   dispose d'un oracle de vérification à coût minimal (HKDF sans étirement, ADR 0025) contre 128
   bits tirés. C'est une borne d'entropie, pas une borne de coût, et elle ne dépend d'aucun choix de
   l'utilisateur. Elle serait FAUSSE pour une phrase secrète — d'où le filtrage.
2. **La page embarquée est un INSTANTANÉ.** Elle porte la version de l'enveloppe au moment de
   l'export, et rien de ce qui vient après : un moyen de récupération ajouté ou révoqué depuis n'y
   est pas. C'est ce qui rend la règle de consentement de la décision 3 nécessaire, et ce n'est pas
   un défaut à corriger — une sauvegarde décrit un passé.
3. **La garde de format sur la page embarquée ne vérifie AUCUNE cryptographie.** La racine n'est
   vérifiable que sous la clé de volume, qu'on n'a pas au moment d'écrire le voisin. Ce qui est tenu
   est le FORMAT — page lisible, somme de contrôle, types, concordance avec l'en-tête —, et le
   premier déverrouillage du volume restauré juge le reste.
4. **L'ancre n'est tenue par personne d'autre que l'utilisateur.** Une feuille perdue, non notée ou
   mal recopiée ne protège de rien, et le produit n'a aucun moyen de le savoir. C'est le prix d'une
   ancre hors du fichier sans témoin distant ; l'alternative est le jalon 6.

   Une version recopiée TROP HAUT refuse une enveloppe saine, et le refus doit dire quoi faire : le
   message de `VAULT_ENVELOPPE_REJEU` nomme le repli — relire la feuille, et à défaut ouvrir SANS
   plancher, ce qui n'est pas un contournement caché mais l'aveu de la décision 3, énoncé au moment
   où il se paie.

5. **Le retour arrière COMPLET du support n'est toujours pas détecté** — volume, enveloppe et
   voisins remis en place ensemble. `versionMinimale` ferme le retour arrière du SEUL fichier
   d'enveloppes sous une feuille tenue à jour ; il ne ferme rien d'autre, et l'ADR 0019 garde la
   phrase.
6. **`recovery: null` reste possible, et se voit mal.** Un volume sans moyen de récupération produit
   une archive qui ne s'ouvrira nulle part ailleurs. Le compte rendu de l'export ET celui de la
   vérification le portent ; c'est à l'interface de #24 de le DIRE, et rien ici ne l'y oblige.
7. **Chaque archive fait voyager une SECONDE page d'enveloppe authentique, à version ÉGALE** —
   constat de la revue de crypto de la PR #160, accepté comme limite. La page embarquée est signée
   sous la clé du volume et porte la version du jour de l'export. Un adversaire qui peut ÉCRIRE dans
   l'OPFS de l'origine de confiance — le même que celui de l'ADR 0019, qui détruit déjà le volume
   s'il le veut — peut l'installer à la place de l'enveloppe vivante : les phrases et les passkeys
   cessent d'ouvrir, sans qu'aucune révocation ait eu lieu.

   **L'effet est un DÉNI, pas une exposition** : rien n'est lu, rien n'est perdu, le code ouvre
   encore. **`versionMinimale` ne le voit pas, par construction** — les deux pages portent la même
   version, et une ancre qui compare des rangs ne distingue pas deux pages authentiques de même
   rang. Ce que cette tranche change n'est pas la capacité de l'adversaire mais la PROVENANCE de la
   page : elle ne réside plus seulement sur l'appareil, elle est dans chaque archive.

   Ce qui le fermerait est nommé et **non décidé** : une marque « page d'archive » dans les données
   associées de la racine, refusée comme page vivante. Elle n'empêcherait pas l'installation — elle
   n'achèterait qu'un diagnostic —, et elle invaliderait les vecteurs figés de l'ADR 0020. Le prix
   dépasse le gain tant qu'aucune mesure ne montre le contraire.

8. **Le plafond de lecture de la section est 64 kio, et ce n'est pas sa taille admissible.** Les
   deux étages sont distincts : `MAX_RECOVERY_BYTES` borne ce qu'un lecteur accepte d'ALLOUER sur la
   foi d'un nombre que l'archive a choisi, avant toute vérification ; la taille EXACTE d'une page
   est ensuite exigée par la garde de forme. Les confondre ferait dépendre une borne d'allocation du
   format d'enveloppe, c'est-à-dire la ferait bouger le jour où une page changerait de taille.

## Impacts sur les ADR antérieurs

Aucun ADR n'est réécrit ; chacun reçoit une note d'une ligne qui renvoie ici.

| ADR      | Ce que cette tranche lui impose                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| **0008** | le format d'archive passe à la **version 2** : une section de récupération facultative, en queue. La v1 reste lue.   |
| **0009** | l'ordre de restauration compte **huit** gestes : l'enveloppe est posée après le contenu relu et avant le manifeste.  |
| **0011** | son consentement nommé sert un second usage : restaurer une archive antérieure à la feuille de récupération.         |
| **0019** | inchangé. `versionMinimale` ferme le retour arrière du fichier d'enveloppes, jamais celui du support entier.         |
| **0020** | sa décision 6 est **révisée** (condition d'abandon 3 déclenchée) ; sa décision 2 et ses vecteurs sont **inchangés**. |
| **0025** | son § Limites reçoit ce que la tranche 3 ferme, et ce qu'elle ouvre.                                                 |

## Alternatives rejetées

- **Emporter l'enveloppe COMPLÈTE.** Rejeté : une phrase secrète sortirait de l'appareil et
  deviendrait attaquable hors ligne, sans limite de tentatives. C'est exactement ce que la décision
  6 de l'ADR 0020 refusait, et ce refus-là est conservé.
- **Un fichier d'enveloppes ENTIER (16 384 octets) dans l'archive.** Rejeté : la seconde page est
  soit un doublon, soit un état ANTÉRIEUR qui offrirait un point de repli au volume restauré. Une
  page, et la seconde à zéro.
- **Chiffrer la section de récupération sous une clé dérivée de l'archive.** Rejeté : cette clé
  devrait voyager avec l'archive ou être dérivée du code, et dans les deux cas elle n'ajouterait
  rien — dans le premier, elle est dans le fichier ; dans le second, elle protège ce que le code
  protège déjà.
- **Refuser d'exporter un volume sans moyen de récupération.** Rejeté : ce serait exporter moins que
  ce que l'utilisateur possède, et transformer une sauvegarde de données en sauvegarde
  conditionnelle. Le fait est DIT, pas empêché.
- **Placer la section entre l'en-tête et le contenu.** Rejeté : l'offset du contenu changerait pour
  tous les lecteurs, y compris ceux d'une v1, pour ranger huit kio.
- **Refuser une restauration antérieure à la feuille.** Rejeté : cela rendrait inutilisable toute
  sauvegarde prise avant la dernière révocation. Le consentement nommé de l'ADR 0011 est
  l'instrument exact de ce choix.
- **Ancrer la version dans l'origine applicative.** Rejeté : déni de service sur un volume sain par
  du code que la topologie suppose hostile. Voir la décision 3.
- **Un séquestre du code chez l'éditeur.** Rejeté, une fois de plus et pour la même raison qu'à
  l'ADR 0025 : ce serait une clé de plus, chez quelqu'un d'autre.

## Risques et conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

1. un dérivateur de type 4 cesse d'être « HKDF seul sur 128 bits tirés » — par exemple s'il devait
   accepter un secret choisi par l'utilisateur —, auquel cas l'argument d'entropie de la décision 1
   tombe et l'emport doit être re-tranché ;
2. le plafond de huit emplacements se met à peser sur la page embarquée, c'est-à-dire si un volume
   porte assez de moyens de récupération pour que la liste filtrée ne tienne plus dans une page ;
3. #24 mesure que l'ancre de la décision 3 est ingérable pour un utilisateur réel — une version à
   re-noter à chaque révocation est un geste, et un geste qu'on ne fait pas n'est pas une protection
   ;
4. le jalon 6 livre un témoin distant, auquel cas l'ancre de la décision 3 devient la moitié locale
   d'un dispositif à deux compteurs, et la note de l'ADR 0025 s'applique ;
5. une version du produit est publiée, auquel cas la lecture d'une archive v1 cesse d'être une
   commodité et devient une conduite de compatibilité à écrire.

## Note datée du 11 septembre 2026 — la page embarquée passe sous le domaine `recuperation`

La racine rescellée à l'export — décision 2 de cet ADR — n'est plus scellée sous la clé de volume :
elle l'est sous une clé à USAGE UNIQUE du domaine `recuperation`, dérivée par HKDF avec un sel tiré
et écrit en clair dans la page (tranche T2b de
[#182](https://github.com/pinfada/railsbox-vault/issues/182)).

**Ce que la séparation achète, et qui est propre à cette page :** une archive VOYAGE. La clé qui
scelle sa page ne scelle rien qui soit resté sur l'appareil — pas même la serrure locale, qui relève
du domaine `enveloppe`. Un adversaire qui obtiendrait la clé de la page embarquée n'obtiendrait pas
l'autorité sur `<volume>.cles`.

**Ce qui ne change pas :** la page ne porte toujours QUE des emplacements de type 4, elle porte
toujours la version COURANTE de l'enveloppe — c'est elle que l'ancre de la décision 3 compare à la
feuille de récupération —, et la restauration la pose toujours en page 0 avec une page 1 à zéro.

**Ce qui s'ajoute à la RESTAURATION :** la page posée déclare son domaine dans son en-tête, sans
quoi le premier déverrouillage du volume restauré dériverait la clé du mauvais domaine. La première
MUTATION de cette enveloppe écrira une page du domaine `enveloppe`, sans geste particulier.

**Compatibilité :** la version d'ARCHIVE reste **3**. Une archive écrite avant T2b emporte une page
v1 ; elle se restaure, s'ouvre par son code de récupération, et sa page est migrée en v2 à la
première ouverture réussie. C'est mesuré par `tests/unit/vm-archive-vecteurs.test.mjs` sur les
octets FIGÉS de `tests/vectors/archive-v3.json`, qui n'ont pas bougé.

Voir l'[ADR 0036](0036-page-d-enveloppe-v2-et-budgets-exhaustifs.md).
