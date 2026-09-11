# ADR 0034 — L'archive porte un engagement scellé, et aucun volume légitime n'est sans racine

- **Statut** : accepté
- **Date** : 2026-09-10
- **Issue** : [#181](https://github.com/pinfada/railsbox-vault/issues/181) (CRITICAL),
  [#20](https://github.com/pinfada/railsbox-vault/issues/20) moitié 2 ·
  [PR #184](https://github.com/pinfada/railsbox-vault/pull/184) · Invariants : `SEC-BLOCK-001`,
  `SEC-GEN-001`, `SEC-DURABLE-001`, `SEC-RECOVERY-001`
- **Révise** : [ADR 0008](0008-format-d-archive-d-export.md) (le format d'archive passe en v3 et
  porte un engagement), [ADR 0009](0009-restauration-inter-origine.md) (la restauration DÉPOSE un
  voisin de plus), [ADR 0011](0011-migration-de-format-et-reprise.md) (les archives v1 et v2 sont
  refusées ; la migration v2 → v3 écrit une racine), [ADR 0014](0014-generation-transactionnelle.md)
  (la création gagne un geste, et une ouverture peut écrire),
  [ADR 0015](0015-proprietes-cryptographiques-du-format.md) (le § 7.5 de la spécification :
  l'archive est authentifiée), [ADR 0019](0019-fraicheur-du-volume.md) (ce qu'une restauration
  laisse à l'ouverture suivante), [ADR 0027](0027-archive-et-ancre-de-version.md) (la disposition de
  l'archive gagne un champ).
- **Dépend de** : [ADR 0033](0033-hierarchie-de-cles-derivees-par-domaine.md), qui fixe la forme de
  la dérivation par domaine et la règle de la racine initiale (décision 5). Cet ADR l'ANTICIPE pour
  la v3, comme le § plan de l'ADR 0033 l'annonce.
- **Ne traite pas** : le format de volume v4 et les cinq autres domaines
  ([#182](https://github.com/pinfada/railsbox-vault/issues/182)) — la racine initiale posée ici
  reste une racine **v3**, à un seul compteur ; le retour arrière COMPLET du support (§ 9.1) ;
  l'ancrage monotone ([#23](https://github.com/pinfada/railsbox-vault/issues/23)) ; AES-GCM-SIV ; le
  chiffrement du manifeste, que le relecteur ne demande pas.

> **Note datée du 2026-09-11 ([ADR 0035](0035-format-de-volume-v4-et-migration.md), #182,
> [PR #186](https://github.com/pinfada/railsbox-vault/pull/186)).** La décision 4 — « aucun volume
> légitime n'est sans racine » — avait un TROU, et il a été trouvé par la revue de format de la PR
> #186 : la MIGRATION n'appliquait pas la décision 5. Elle n'interrogeait ni la racine ni
> l'engagement de sa source ; elle DATAIT d'une racine neuve un volume sans racine, c'est-à-dire
> l'état exact que `VAULT_STORAGE_VOLUME_SANS_RACINE` refuse. Comme la migration est le SEUL chemin
> qu'un produit v4 laisse à une archive v3 restaurée, la moitié « restauration » du CRITICAL que cet
> ADR referme redevenait franchissable par elle.
>
> La migration ouvre désormais sa source chiffrée par le magasin de générations, ce qui lui applique
> les trois cas de la décision 5 sans les dupliquer. Le motif admis y est `engagement` — jamais
> `migration` : ce motif-là dit « ces octets sont les miens, je viens de les écrire », ce qui est
> vrai du volume que la conversion PRODUIT et faux de celui qu'elle CONSOMME.

## Contexte : ce que la revue externe a montré

La revue externe du format v3, reçue le 10 septembre 2026
([texte intégral](../revue-externe/revue-2026-09-10.md)), rend un CRITICAL, et sa reproduction tient
en six étapes : produire trois états A, B, C d'un même volume ; partir du fichier C ; y remettre le
chiffré, le nonce, l'étiquette et la génération du secteur 0 provenant de A ; construire une archive
au format public, donc recalculer ses empreintes SHA-256 ; vérifier et rouvrir.

Le relecteur obtenait, sans un refus :

```json
{
  "archiveVerifiee": true,
  "fraicheur": "sans-racine",
  "secteur0Ancien": true,
  "secteur1Nouveau": true,
  "etatJamaisProduit": true
}
```

**Chaque secteur reste authentique isolément**, parce que son sceau et son identité viennent du même
endroit. Leur combinaison ne correspond à AUCUN état validé du volume. Ce n'est pas le retour
arrière COMPLET du support — la limite assumée du § 9.1 — c'est un état **jamais produit**, que le §
8 du format prétend refuser.

Trois faits l'ont rendu atteignable, et il faut les nommer tous les trois :

1. **l'archive n'était pas authentifiée.** Elle transportait le fichier chiffré avec un SHA-256
   PUBLIC et recalculable ; il atteste contre l'accident, pas contre un adversaire ;
2. **la restauration écarte le journal et le témoin**, et elle a raison de le faire : ils datent un
   volume qui n'existe plus (ADR 0009, ADR 0019) ;
3. **l'ouverture suivante traitait l'absence de racine comme une PREMIÈRE OUVERTURE.** Le remède «
   aucune » de `remedeSansRacine` acceptait le contenu tel quel.

Le troisième est le pivot. Sans lui, le mélange ne s'ouvrirait pas ; avec lui, il suffit de retirer
un fichier pour qu'un volume restauré redevienne indiscernable d'un volume neuf.

## Décision 1 — L'archive passe en version 3 et porte un ENGAGEMENT

Une archive v3 porte, dans son en-tête JSON, un scellement AES-256-GCM dont le clair est
`SHA-256(fichier chiffré ENTIER)`, 32 octets.

```text
donnéesAssociées = LP("railsbox-vault/archive/engagement/v1")   étiquette de domaine
                 ‖ LP("aes-256-gcm")                             nom d'algorithme
                 ‖ U32BE(versionDArchive)                        3
                 ‖ LP(identifiantVolume)                         32 hexadécimaux minuscules
                 ‖ U64BE(tailleSupport) ‖ U64BE(tailleLogique) ‖ U32BE(tailleDeSecteur)
                 ‖ U32BE(versionDeRecuperation)
                 ‖ U64BE(longueurDuContenu) ‖ U64BE(longueurDeLaRecuperation)
```

Chaque champ est de largeur FIXE ou préfixé de sa longueur, comme au § 5.1 : une concaténation non
préfixée n'est injective que par une propriété du contenu, et le dépôt refuse ce genre de sûreté
depuis #18.

**La longueur de l'EN-TÊTE n'y est pas, et c'est une nécessité d'encodage.** L'engagement vit DANS
cet en-tête ; y sceller sa longueur la rendrait fonction d'elle-même. Ce que l'en-tête déclare et
que l'engagement couvre — version, identité, géométrie, version de récupération, longueurs des
sections — est authentifié ; ce qu'il déclare d'autre ne l'est pas, et le § 7.5 le dit sans le
maquiller.

**AES-GCM, et pas HMAC-SHA-256.** Sous une clé à usage unique dérivée avec un sel tiré, GCM
authentifie exactement aussi bien et n'introduit AUCUNE primitive neuve. L'ADR 0015 n'admet qu'un
algorithme ; en ajouter un second coûterait une famille de vecteurs, un nom dans le manifeste et une
question d'agilité de plus.

### Une archive v3 d'un volume ANTÉRIEUR à v3 déclare son engagement NUL

_Ajouté le 11 septembre 2026 — revue de format de la PR #184, constat 2._

Un volume antérieur à v3 n'est pas chiffré, ne porte aucun identifiant de volume, et n'a donc ni clé
ni identité à engager. Son archive déclare `"engagement": null`, **explicitement** : un champ absent
est refusé, un champ non nul sur un manifeste antérieur à v3 aussi. C'est la règle de `recovery`,
mot pour mot.

**Pourquoi cette forme doit exister** : sans elle, la sauvegarde que l'ADR 0011 exige AVANT une
migration v2 → v3 — le seul pas destructif du dépôt — deviendrait impossible. On n'interdit pas de
sauvegarder ce qu'on s'apprête à réécrire.

**Sa LIMITE, écrite** : cette archive n'est **pas authentifiée**, et sa restauration ne dépose aucun
voisin d'engagement. Les secteurs d'un volume v2 ne sont authentifiés par rien — par construction ;
c'est ce que la v3 ajoute — et ils ne le deviennent qu'à la migration qui les rechiffre. Le volume
qu'une telle archive pose est refusé à l'ouverture : `VAULT_STORAGE_VOLUME_SANS_RACINE` sur le
chemin direct, `VAULT_MANIFEST_MIGRATION_REQUIRED` sur le chemin du produit, dont la garde de
manifeste vient en amont. Elle protège contre l'ACCIDENT, comme une archive v1 ou v2 le faisait, et
contre rien d'autre.

Cette forme est FIGÉE depuis le 11 septembre 2026 : `tests/vectors/archive-v3.json` ›
`archiveDeVolumeAnterieur`, vérifiée par `tools/verifier-vecteurs.mjs` depuis le seul texte du §
7.5. Elle ne l'était pas, si bien qu'un état que le produit ÉCRIT et EXIGE n'avait aucun contrat
d'octets.

## Décision 2 — La clé vient du domaine `archive`, à usage unique

`HKDF-SHA-256(IKM = DEK, sel = 32 octets TIRÉS et écrits en clair dans l'archive, info)`, avec
l'info de l'ADR 0033, décision 3, et `versionDeFormatDuDomaine = 3`. **Une archive, une clé, un
scellement, aucun compteur.**

**T1 introduit donc la dérivation pour ce SEUL domaine.** Le volume reste v3 et sa clé reste la DEK
jusqu'à #182 : c'est une entorse au régime de l'ADR 0033, décision 1, elle est assumée, et elle est
écrite là-bas comme ici. Ce qui la rend sans conséquence est que le domaine `archive` ne partage sa
clé avec rien : le sel tiré la rend neuve à chaque archive.

**Le sel en clair n'est pas authentifié, et il n'a pas à l'être.** Un adversaire qui le change
obtient une clé différente, donc une ouverture qui échoue : il se protège par sa conséquence, comme
le nonce.

## Décision 3 — Le versionnage passe par un CHAMP, jamais par le marqueur

`ARCHIVE_FORMAT_VERSION` vaut **3** ; le marqueur binaire `RBVAULT1` **ne bouge pas**. Le changer
ferait dire à un runtime ancien « ce n'est pas une archive » au lieu de « cette archive est trop
récente », et l'ADR 0011 veut un refus explicite d'un format futur, pas une méconnaissance.

**Les archives v1 et v2 sont REFUSÉES**, par `VAULT_ARCHIVE_VERSION_NON_LUE`, un code qui nomme la
raison. Ce n'est pas un dommage collatéral : elles ne portent aucun engagement, et c'est exactement
le défaut. Il n'y a aucune compatibilité à préserver — rien n'est publié, le gate « données
sensibles » est fermé, et le dépôt n'a produit d'archive que sous données synthétiques.

## Décision 4 — Aucun volume légitime n'est sans racine

C'est ce qui rend le refus de la décision 6 atteignable, et c'est la vraie correction. Deux gestes :

- **la création écrit une RACINE INITIALE avant `VLTSEAL1`** — séquence 0, génération 0, compteur =
  les scellements que la création vient de consommer, la racine comprise. Elle devient
  l'avant-dernier geste du § 7.1, et `VLTSEAL1` reste le dernier ;
- **la migration v2 → v3 en écrit une aussi**, avant que le manifeste migré ne soit inscrit — au
  même rang que l'enveloppe d'une restauration.

Bénéfice second, et il n'est pas mince : cela ferme **pour la v3 déjà** les 2^20 scellements qu'une
création de 512 Mio ne publiait nulle part (§ 4.5 ; ADR 0033, décision 4), sans attendre la v4.

### Le piège que cette règle lève, nommé pour ne pas être redécouvert

`remedeSansRacine` justifiait son remède « aucune » ainsi : « une ouverture qui écrirait ici ferait
échouer un export sur un support saturé — c'est-à-dire le geste même par lequel l'utilisateur libère
de la place ». **Cette objection ne vaut plus.** Sous cette décision, une ouverture n'écrit une
racine que si une AUTORISATION l'y invite, donc uniquement après une création ou une restauration —
deux gestes qui viennent d'écrire un fichier de volume entier, et qui ont donc déjà échoué si le
support était saturé.

### Le VERSEMENT hors transaction, et le geste qu'il doit poser

La coquille de produit (ADR 0030) et le banc de référence versent un disque applicatif de plusieurs
centaines de mébioctets **hors transaction** : ils écrivent le fichier entier sans passer par le
journal, ce qui change la RÉGION D'AUTHENTIFICATION et périme donc la racine initiale que la
naissance vient d'écrire. Ils appellent `daterLaCreation` une fois le fichier final, avant
d'inscrire le manifeste.

**Sans cet appel, le volume est REFUSÉ à son premier boot** par la garde de fraîcheur de l'ADR 0019
: un oubli coûte un refus, jamais un silence. C'est la direction sûre, et le geste refuse de dater
un journal qui porte autre chose que la racine initiale d'une création — dater un volume en service
écarterait une génération validée, ce que `SEC-DURABLE-001` interdit.

#### Ce que la DATATION bénit, et ce qui l'y autorise

_Ajouté le 11 septembre 2026 — revue de sécurité de la PR #184, constat 1 (CRITICAL)._

La décision 4 justifiait les motifs `creation` et `migration` par une phrase : « celui qui vient
d'écrire le fichier entier SAIT que ces octets sont les siens ». **Sur le chemin du versement, elle
était fausse**, et il faut dire exactement pourquoi : le versement FERME le fichier, la datation le
ROUVRE, et **l'intervalle n'appartient à personne**. Le geste qui date n'est pas le geste qui a
écrit, et rien ne les reliait. Un adversaire qui sait écrire dans l'OPFS (ADR 0019 § 6.9) y posait
le fichier d'un autre volume entre les deux ; l'installation se déclarait réussie, et l'ouverture
suivante rendait EN CLAIR un état que ce volume n'a jamais produit — le CRITICAL de #181, déplacé du
chemin de restauration vers le chemin de création.

**Ce qui referme la fenêtre est une EMPREINTE.** Le versement hors transaction rend le SHA-256 du
fichier qu'il vient d'écrire, pris **avant** de relâcher son exclusivité — ce n'est donc pas une
relecture qu'un tiers aurait pu influencer, c'est le constat de ce que ce geste-là a laissé, à un
instant où aucun autre détenteur n'existait. `daterLaCreation` reçoit cette empreinte et la
CONFRONTE à `backend.empreinteDuFichier()` sous une exclusivité NEUVE, **avant** d'écrire la racine.
Deux empreintes égales disent que l'intervalle n'a rien changé : c'est cela, et cela seulement, qui
rend vraie la phrase « ces octets sont les siens » — ce n'est pas le geste qui le sait, c'est
l'empreinte qui le relie.

Une empreinte **absente** refuse elle aussi. Traiter « rien à confronter » comme « donc autorisé »
rouvrirait la fenêtre pour quiconque oublie un paramètre ; la direction sûre est le refus. Code :
`VAULT_STORAGE_CREATION_NON_CONFIRMEE`, et **l'installation n'est PAS déclarée réussie**.

Les deux autres motifs n'ont pas de fenêtre à fermer, et il faut le dire pour ne pas croire la garde
oubliée : une NAISSANCE vient d'allouer et de sceller le fichier **sous l'exclusivité qu'elle tient
encore** ; une MIGRATION réécrit le fichier par un accès brut qu'elle ne relâche pas avant de dater.
Dans ces deux cas, le geste qui écrit et le geste qui date sont le même.

#### La datation EXIGE le journal d'une naissance

_Ajouté le 11 septembre 2026 — revue de sécurité, constat 2 ; revue de format, constat 1._

La garde refusait un journal portant une séquence, une génération, des entrées ou une charge, et
**acceptait un journal VIDE** — c'est-à-dire exactement l'état qu'une RESTAURATION laisse derrière
elle. `daterLaCreation` est exporté par la surface publique du module de volume : c'était un second
chemin vers la racine initiale, sous le motif `creation`, posable sur un volume restauré que
l'ouverture venait de refuser. Le mélange A/C de #181 se datait, puis se rouvrait en clair.

La racine de naissance est désormais **EXIGÉE** : présente, séquence 0, génération 0, aucune entrée.
Le discriminant est exact et gratuit — une création en écrit toujours une, une restauration n'en
écrit aucune. Aucun chemin du produit ne menait au défaut ; la garde est ce qui empêche la prochaine
tranche d'y mener sans le voir.

## Décision 5 — Qui vérifie, quand, et les trois cas de l'ouverture

**La restauration n'a pas la clé** (§ 7.5 : elle recopie sans clé, et c'est une propriété qu'on
garde). Elle vérifie ce qu'elle peut sans clé — présence, longueur, cohérence de l'en-tête, version
d'archive lue —, refuse une archive de version non lue, et **DÉPOSE l'engagement** dans un voisin
`<volume>.engagement` de 180 octets, entre l'enveloppe de récupération et le manifeste.

L'**ouverture** décide ensuite selon trois cas, et il n'y en a pas de quatrième :

| À l'ouverture                     | Conduite                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| une racine fait autorité          | chemin normal, inchangé — l'engagement n'est pas consulté                                                                                                                                                              |
| pas de racine, engagement présent | vérifier l'engagement **avant tout clair** ; s'il ouvre : écrire la **racine initiale**, la rendre durable, tronquer ce que le journal portait, puis **VIDER** le voisin ; sinon : `VAULT_STORAGE_ENGAGEMENT_INVALIDE` |
| pas de racine, engagement absent  | `VAULT_STORAGE_VOLUME_SANS_RACINE`, **avant tout clair**                                                                                                                                                               |

Le cas « au moins une racine abîmée » reste ce qu'il est : un refus, inchangé
(`VAULT_STORAGE_GENERATION_ROOT_CORRUPT`), et il tombe **avant** toute autorisation — vérifier un
engagement coûte l'empreinte de tout le fichier, et un journal dont on ne sait plus ce qu'il a
validé est refusé de toute façon.

**L'engagement est CONSOMMÉ une fois**, jamais « vérifié à chaque ouverture ». Une fois la racine
initiale écrite, c'est la fraîcheur de l'ADR 0019 qui prend le relais, et le voisin n'a plus de
rôle. Il est vidé **après** que la racine soit durable : l'ordre inverse laisserait, sur une
coupure, un volume sans racine et sans engagement, c'est-à-dire irrécupérable.

### CONSOMMÉ veut dire VIDÉ, pas supprimé

_Précisé le 11 septembre 2026 — revue de format de la PR #184, constat 4._

Ce document et le § 7.3 écrivaient « RETIRER ». Le code fait `truncate(0)` puis une barrière : **le
fichier survit, à zéro octet**. Le texte suit le code, et non l'inverse, pour deux raisons dont la
première suffit : un Worker dédié n'a pas de handle de répertoire, donc pas de suppression d'entrée
— `removeOpfsVolume` en a un, la consommation non ; et la troncature est de toute façon le geste sûr
sous coupure, là où une suppression suivie d'une coupure laisserait un état de moins. Un voisin de
zéro octet **est** absent pour tout ce qui le lit, `voisinsDunVolume` le connaît toujours, et le
balayage des orphelins de #145 ne réécrit pas un voisin déjà vide.

Conséquence à dire : une ouverture REFUSÉE par `VAULT_STORAGE_VOLUME_SANS_RACINE` laisse derrière
elle un `.engagement` de zéro octet que le volume ne portait pas, `openOpfsSyncAccess` ouvrant avec
`{ create: true }` — même conduite que pour `.gen` et `.temoin`, donc pas un défaut, mais à écrire.

### Un voisin REPOSÉ sur un volume qui a déjà une racine est VIDÉ, et l'ouverture le PUBLIE

_Ajouté le 11 septembre 2026 — revue de sécurité de la PR #184, constat 9._

Le premier cas du tableau dit que l'engagement n'est pas consulté quand une racine fait autorité. Un
adversaire qui repose le voisin après consommation n'obtient donc rien — mais le rapport d'ouverture
ne disait rien de lui, alors qu'il publie `racineInitiale` et `motifDeLaRacine` précisément « parce
qu'un contrôle qu'on ne publie pas finit par être supposé actif ». Un reliquat qu'on laisse sans le
dire finit, symétriquement, par être cru voulu. Il est donc **vidé** à cette occasion — le geste
exact de la consommation — et le rapport porte `voisinIgnore: true`.

### L'indistinction des causes porte sur le CODE, pas sur la DURÉE

_Ajouté le 11 septembre 2026 — revue de sécurité de la PR #184, constat 3._

`VAULT_STORAGE_ENGAGEMENT_INVALIDE` rend une seule cause et un seul message, et ce document
justifiait ce choix par « les distinguer donnerait à un adversaire un oracle sur ce qu'il a manqué
». **La durée du refus, elle, les distingue parfaitement.** Le descripteur du voisin est confronté
au volume AVANT que l'empreinte du fichier ne soit calculée : un refus « ce voisin parle d'un autre
volume » coûte 0,4 ms là où un refus « l'étiquette ne vérifie pas » coûte 20,4 ms sur 2 Mio — mesuré
— et plusieurs secondes sur 512 Mio. Un observateur qui chronomètre apprend si ce qui a été altéré
est l'identité ou la géométrie du volume, ou autre chose.

**L'ordre est CONSERVÉ**, et c'est un compromis assumé, pas un oubli : l'inverser ferait relire le
fichier entier à chaque voisin forgé, c'est-à-dire offrirait un déni de service à plusieurs secondes
par tentative, pour fermer un oracle qui n'apprend rien à qui a forgé le voisin lui-même. Ce que ce
document promet est donc : un CODE et un MESSAGE indistincts. Jamais une durée. C'est écrit au §
7.3, au § 9.4 et dans `SECURITY.md`.

**Le remède « aucune » quitte le produit.** `remedeSansRacine` garde sa branche `abimees > 0` et
gagne le refus ; la branche qui acceptait un journal vierge n'existe plus, dans le code comme dans
les épreuves. Elle ne survit donc nulle part — ni comme code mort, ni comme épreuve qui décrirait un
état que le produit ne produit plus. À ne pas confondre avec l'état de FRAÎCHEUR `sans-racine`, qui
décrit l'empreinte de région et ne disparaît pas.

## Décision 6 — Ce que ce refus prouve, et ce qu'il ne prouve PAS

Trois phrases, et aucune n'est masquée :

1. **il est tenu.** Un adversaire qui supprime le voisin obtient un REFUS, parce qu'un volume sans
   racine n'est plus un état légitime. C'est le but ;
2. **il ne couvre pas le rejeu d'une archive ENTIÈRE et cohérente.** Celui-là reste indétectable :
   c'est le retour arrière complet du § 9.1, inchangé, et l'ancrage monotone reste renvoyé à #23 ;
3. **un volume v3 créé AVANT cette tranche n'a pas de racine initiale** : il est refusé après elle,
   par `VAULT_STORAGE_VOLUME_SANS_RACINE`. Même motif que pour les archives v1 et v2 — rien n'est
   publié, données synthétiques seulement, aucune compatibilité à préserver. Ce qu'il fallait
   prévoir est MATÉRIEL : les volumes v3 pré-fabriqués des bancs et des scénarios sont régénérés, et
   la PR #184 dit lesquels.

**Et une quatrième, ajoutée le 11 septembre 2026** (revue de sécurité de la PR #184, constat 10) :
le **retour arrière vers la NAISSANCE** est un cas du point 2, et il ne demande AUCUNE archive.
Depuis cette tranche, chaque création fabrique elle-même un instantané cohérent à trois fichiers —
le fichier de volume scellé, son journal portant la racine initiale, son témoin. Un adversaire qui
les repose ENSEMBLE sur un volume vivant obtient une ouverture acceptée, `fraicheur: "verifiee"`,
rendant l'état de la naissance ; reposer le fichier SEUL est bien refusé. Rien de neuf sous le § 9.1
— les trois ensemble SONT un état que ce volume a réellement produit —, mais le prix de l'attaque a
baissé, et le dire coûte une phrase.

## Ce qui NE change pas

La géométrie (secteurs de 512 octets, région d'authentification, en-tête v3), la disposition du
journal `<volume>.gen` et son format 4, le témoin et son sceau, la marque `VLTSEAL1`, le tirage du
nonce, l'algorithme `aes-256-gcm`, les données associées d'un bloc et d'une racine, les 166 vecteurs
figés antérieurs — la tranche en AJOUTE, elle n'en change aucun —, l'ordre des vérifications du §
7.3, et la clé du volume, qui reste la DEK jusqu'à #182.

> **Note datée du 11 septembre 2026** : l'entorse est levée par
> l'[ADR 0035](0035-format-de-volume-v4-et-migration.md) (PR #186, format v4) — la clé du volume est
> dérivée sous le domaine `volume` ; un v3 n'est plus lu que par la migration et par l'export qui la
> précède, et ces lectures scellent encore sous la DEK, comptées dans la racine v3 (ADR 0036,
> décision 4).

## Comment on le sait

- **l'épreuve rouge du mélange A/C**, six étapes du relecteur reproduites à l'identique, sur le
  double : `tests/unit/vm-archive-melange-etats.test.mjs` › « ÉPREUVE ROUGE — le mélange A/C est
  REFUSÉ par un code typé, avant tout clair » ;
- **la seconde épreuve rouge**, « restauration, PUIS voisin retiré → REFUS », dans le même fichier.
  Sans elle, la correction serait contournable par une commande `rm` ;
- **le témoin positif** : l'archive intacte se restaure et s'ouvre, et rend l'état qu'elle porte.
  Sans lui, un refus universel passerait pour une correction ;
- **le témoin de consommation** : après la première ouverture, le voisin n'existe plus, et la
  seconde ouverture passe par le chemin normal ;
- **le témoin de la création** : `tests/unit/vm-generation-store.test.mjs` › « un journal vierge
  écrit la RACINE INITIALE et laisse le VOLUME intact », et son revers « un volume sans racine que
  RIEN n'autorise est REFUSÉ » ;
- **les vecteurs figés** : `tests/vectors/archive-v3.json` porte l'info HKDF octet par octet, les
  données associées, le scellement et les 180 octets du voisin ; `node tools/verifier-vecteurs.mjs`
  les rejoue **sans importer une ligne du produit**, redérive la clé du domaine et OUVRE l'étiquette
  ;
- **la mutation** : `tools/muter-gardes-archive-recuperation.mjs` retire pour de vrai les gardes
  neuves, et chacune fait rougir sa preuve. Six à la livraison de la PR #184 ; **sept de plus**
  après ses deux revues, qui avaient relevé la même chose de deux côtés — ce que la PR déclarait «
  le contrat, et il n'est pas négociable » n'était tenu par aucun mutant :

  | Garde retirée                                                 | Épreuve qui rougit, et ce qu'elle MESURE                                                                |
  | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | ce que l'engagement scelle (un champ des données associées)   | vecteurs figés : les octets ne concordent plus                                                          |
  | l'info HKDF lie le domaine                                    | vecteurs figés : la clé dérivée n'est plus la même                                                      |
  | la confrontation empreinte du fichier / empreinte scellée     | mélange A/C : le mélange s'ouvre                                                                        |
  | le refus d'un voisin ABSENT                                   | mélange A/C : le voisin retiré n'est plus un refus                                                      |
  | le refus d'un volume sans racine que rien n'autorise          | mélange A/C et magasin de générations                                                                   |
  | la racine initiale d'une CRÉATION                             | mélange A/C : le motif de naissance n'est plus celui d'une naissance                                    |
  | **la confrontation de l'empreinte que le VERSEMENT a rendue** | coquille : le fichier substitué entre versement et datation n'est plus refusé                           |
  | **l'exigence de la racine de naissance avant de dater**       | mélange A/C : le volume restauré se date de nouveau                                                     |
  | **l'ordre « racine lisible, puis autorisation »**             | mélange A/C : une racine abîmée coûte une relecture du fichier ENTIER — le journal des gestes le compte |
  | **l'ordre « racine initiale, puis consommation »**            | mélange A/C : le voisin est vidé avant que la racine ne soit écrite — l'ordre est relevé                |
  | **la consommation du voisin**                                 | mélange A/C : le voisin survit à la première ouverture                                                  |
  | **le TIRAGE du sel de domaine**                               | vecteurs : deux scellements du même contenu portent le même sel, la même clé, le même chiffré           |
  | **la racine initiale de la MIGRATION**                        | migration : le journal du volume migré ne porte plus de racine, et l'ouverture le refuse                |

  Les cinq premières lignes sont d'avant les revues ; les sept en gras leur répondent. Chacune de
  ces sept est tuée par une épreuve qui **mesure** — un ordre de gestes relevé, un compte de
  lectures, un sel relu sur un second scellement, une racine relue sur le support — jamais par une
  épreuve qui relit une intention.

- **la racine initiale de la MIGRATION, mesurée** :
  `tests/unit/vm-migration-racine-initiale.test.mjs` monte la VRAIE cible
  (`createOpfsMigrationTarget`) sur le double du support et joue une vraie migration v2 → v3. Elle
  relit la racine dans le journal — séquence 0, génération 0, aucune entrée, compteur = secteurs + 1
  —, vérifie qu'elle est posée AVANT le manifeste, que l'ouverture suivante est normale sans
  consulter d'engagement, et qu'une coupure entre les deux est reprenable. C'était la moitié non
  mesurée de la décision 4 (revue de format de la PR #184, constat 3) ; `poserLaRacineInitiale`
  entre au même moment dans le CONTRAT de la cible, comme `commitEngagement` y était entré pour la
  restauration — une cible qui ne sait pas dater est refusée **avant toute écriture**, au lieu de
  produire en silence un volume déclaré migré et inouvrable.
