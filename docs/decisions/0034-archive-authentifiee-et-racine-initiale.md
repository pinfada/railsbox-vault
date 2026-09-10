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

## Décision 5 — Qui vérifie, quand, et les trois cas de l'ouverture

**La restauration n'a pas la clé** (§ 7.5 : elle recopie sans clé, et c'est une propriété qu'on
garde). Elle vérifie ce qu'elle peut sans clé — présence, longueur, cohérence de l'en-tête, version
d'archive lue —, refuse une archive de version non lue, et **DÉPOSE l'engagement** dans un voisin
`<volume>.engagement` de 180 octets, entre l'enveloppe de récupération et le manifeste.

L'**ouverture** décide ensuite selon trois cas, et il n'y en a pas de quatrième :

| À l'ouverture                     | Conduite                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| une racine fait autorité          | chemin normal, inchangé — l'engagement n'est pas consulté                                                                                                                                                             |
| pas de racine, engagement présent | vérifier l'engagement **avant tout clair** ; s'il ouvre : écarter la charge trouvée s'il y en a une, écrire aussitôt la **racine initiale**, puis **RETIRER** le voisin ; sinon : `VAULT_STORAGE_ENGAGEMENT_INVALIDE` |
| pas de racine, engagement absent  | `VAULT_STORAGE_VOLUME_SANS_RACINE`, **avant tout clair**                                                                                                                                                              |

Le cas « au moins une racine abîmée » reste ce qu'il est : un refus, inchangé
(`VAULT_STORAGE_GENERATION_ROOT_CORRUPT`), et il tombe **avant** toute autorisation — vérifier un
engagement coûte l'empreinte de tout le fichier, et un journal dont on ne sait plus ce qu'il a
validé est refusé de toute façon.

**L'engagement est CONSOMMÉ une fois**, jamais « vérifié à chaque ouverture ». Une fois la racine
initiale écrite, c'est la fraîcheur de l'ADR 0019 qui prend le relais, et le voisin n'a plus de
rôle. Il est retiré **après** que la racine soit durable : l'ordre inverse laisserait, sur une
coupure, un volume sans racine et sans engagement, c'est-à-dire irrécupérable.

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

## Ce qui NE change pas

La géométrie (secteurs de 512 octets, région d'authentification, en-tête v3), la disposition du
journal `<volume>.gen` et son format 4, le témoin et son sceau, la marque `VLTSEAL1`, le tirage du
nonce, l'algorithme `aes-256-gcm`, les données associées d'un bloc et d'une racine, les 166 vecteurs
figés antérieurs — la tranche en AJOUTE, elle n'en change aucun —, l'ordre des vérifications du §
7.3, et la clé du volume, qui reste la DEK jusqu'à #182.

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
- **la mutation** : `tools/muter-gardes-archive-recuperation.mjs` retire pour de vrai les six gardes
  neuves — ce que l'engagement scelle, l'info du domaine, la confrontation des empreintes, le refus
  d'un voisin absent, le refus d'un volume sans racine, et la racine initiale d'une création — et
  chacune fait rougir sa preuve.
