# Le format de volume de RailsBox Vault — spécification pour la revue externe

- Version du document : 2 · 11 septembre 2026 · Issues
  [#20](https://github.com/pinfada/railsbox-vault/issues/20) moitié 1,
  [#182](https://github.com/pinfada/railsbox-vault/issues/182) (tranche T2a)
- Format ÉCRIT par ce runtime : **volume v4**, journal de génération **format 5**, manifeste
  **format 4**, fichier d'instantané **format 2**
- Format encore LU, et par la seule migration : **volume v3**, journal **formats 2 à 4**
- Décisions dont il découle : [ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md)
  (propriétés), [ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md) (disposition),
  [ADR 0019](decisions/0019-fraicheur-du-volume.md) (fraîcheur),
  [ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) (la hiérarchie de clés),
  [ADR 0035](decisions/0035-format-de-volume-v4-et-migration.md) (ce que la v4 change)

> **Le NOM de ce fichier dit encore « v3 », et il ne changera pas.** Cinquante-deux renvois pointent
> ici, dont une douzaine depuis des ADR acceptés et un depuis un fichier de vecteurs FIGÉ. Renommer
> le fichier ferait réécrire des documents qu'on ne réécrit pas. La version est DANS le document,
> pas dans son nom : ce qui suit décrit le format v4 que le produit écrit, et nomme explicitement ce
> qui reste vrai de la v3 — que la migration est désormais le seul lecteur admis.

## 1. Ce que ce document est, et ce qu'il n'est pas

**Il est autonome.** Un relecteur doit pouvoir le lire d'un bout à l'autre, reconstruire chaque
octet du disque et vérifier les vecteurs figés **sans ouvrir une ligne de code**. Là où un ADR
argumente une décision, ce document décrit un état de fait : les octets, leurs longueurs, leur
boutisme, les refus et ce qu'un exploitant doit en faire.

**Il ne remplace pas les ADR.** Les ADR portent le POURQUOI — les alternatives pesées, les
réfutations par exécution, les coûts mesurés. Ce document les cite plutôt que de les recopier ; là
où un choix a une raison, elle est nommée en une phrase et le renvoi est donné.

**Il n'établit aucune revue.** Le format de volume v3 de RailsBox Vault n'a été revu par aucun
tiers. Ce document existe pour rendre cette revue possible ; il ne dit ni « audité », ni « revu »,
ni « sûr ». Le dépôt est expérimental et ne doit contenir aucune donnée réelle : c'est le premier
gate de [`SECURITY.md`](../SECURITY.md), et il est fermé.

**Le CODE tranche.** Là où un ADR et le code divergent, ce document écrit ce que le code fait, dit
ce que l'ADR dit, et date l'écart. La § 12 les rassemble ; ils ne sont ni lissés ni corrigés en
silence.

## 2. Vérifier ce document en une commande

```sh
node tools/verifier-vecteurs.mjs
```

Node seul, aucune dépendance, aucun navigateur. Ce script **réimplémente** les encodages décrits ici
à partir de `node:crypto`, sans importer une ligne de `src/`, et les confronte aux octets figés de
`tests/vectors/format-chiffre-v1.json` (le modèle : blocs et racines en mémoire) et de
`tests/vectors/disposition-v3.json` (le disque : en-tête, enregistrement de journal, région
d'authentification, racine, témoin). Son indépendance est gardée par inspection de source :
`tests/unit/dossier-de-revue.test.mjs` › « le vérificateur de vecteurs n'importe RIEN de src/ : son
verdict est indépendant », et son verdict vert est exécuté par
`tests/unit/dossier-de-revue.test.mjs` › « le vérificateur de vecteurs tourne VERT en une commande,
sans le produit ».

Un vérificateur qui appellerait le modèle de référence emprunterait les encodages qu'il prétend
contrôler. Celui-ci mesure autre chose : que **la spécification écrite suffit** à reproduire les
octets.

Le reste du dossier s'exécute par `npm run test:unit` (les épreuves citées ci-dessous) et
`npm run check` (lint, format, épreuves, compatibilité, chaîne de publication).

## 3. Vue d'ensemble

Un volume est **un fichier** et **quatre voisins**, dans le système de fichiers privé de l'origine
(OPFS). Le partitionnement par origine du navigateur est la seule frontière extérieure du modèle
([ADR 0002](decisions/0002-topologie-origine-de-confiance.md)).

| Objet                 | Fichier               | Chiffré ? | Authentifié ?          | Dans le périmètre de cette revue   |
| --------------------- | --------------------- | --------- | ---------------------- | ---------------------------------- |
| Volume                | `<volume>`            | oui       | oui, secteur à secteur | **oui**                            |
| Journal de génération | `<volume>.gen`        | oui       | oui, par racine        | **oui**                            |
| Témoin de séquence    | `<volume>.temoin`     | oui       | oui                    | **oui**                            |
| Manifeste             | `<volume>.manifest`   | non       | **non**                | **oui** (ce qu'il déclare)         |
| Enveloppe de clé      | `<volume>.cles`       | oui       | oui                    | non — § 11                         |
| Instantané de reprise | `<volume>.instantane` | oui       | oui                    | non — § 11                         |
| Journal de migration  | `<volume>.migration`  | non       | **non**                | non — § 11, mais sa limite est ici |

Le format sépare trois choses qu'il ne faut pas confondre :

- **la version du FORMAT DE VOLUME** — 3 — qui décide la disposition du fichier ;
- **la version du FORMAT DU JOURNAL** — 3 — qui décide la disposition d'une racine ;
- **la version de la SPÉCIFICATION cryptographique** — 1 — qui décide les données associées et n'a
  jamais bougé. Elle est l'étiquette de domaine `railsbox-vault/format-chiffre/v1/…`.

Les trois avancent indépendamment, et c'est délibéré : l'ADR 0019 a pu ajouter un champ à la racine
(journal 2 → 3) sans toucher un octet des données associées, donc sans invalider les vecteurs de
l'ADR 0015.

## 4. Les primitives

### 4.1 Chiffrement authentifié : AES-256-GCM

| Paramètre             | Valeur                                                         |
| --------------------- | -------------------------------------------------------------- |
| Algorithme            | `AES-GCM` de la recommandation W3C _Web Cryptography API_      |
| Nom épinglé du format | `aes-256-gcm` — le SEUL admis                                  |
| Clé                   | 256 bits (32 octets)                                           |
| Nonce                 | 96 bits (12 octets), **tiré au hasard**                        |
| Étiquette             | 128 bits (16 octets) — le maximum de NIST SP 800-38D § 5.2.1.2 |

**Pourquoi celui-là** : c'est le seul AEAD que WebCrypto rende disponible dans un Worker (ADR 0015,
§ « AEAD »). AES-GCM-SIV, ChaCha20-Poly1305 et XChaCha20-Poly1305 en sont absents ; les employer
demanderait une dépendance tierce et son audit. C'est la **question n° 1** de la § 13.

**Borne de forgerie, calculée et non qualifiée.** SP 800-38D § 5.2.1.2 et son annexe B majorent la
probabilité qu'une tentative de forgerie aboutisse par `(n + 1) / 2^t`, où `t` est la longueur
d'étiquette en bits et `n` le nombre de blocs de 128 bits de l'entrée. Pour un secteur de 512 octets
(32 blocs) et des données associées de 118 octets — soit 8 blocs, la fin étant complétée —,
`n = 40`, d'où **≈ 2^-122,6** par tentative — le PLUS PETIT objet du format. **Ce n'est pas la borne
la plus large que le format admette** : un enregistrement de journal porte le clair de l'écriture du
guest, jusqu'au plafond de charge de 16 Mio (§ 6.6), pas 512 octets ; à ce plafond, `n ≈ 2^20` et la
borne vaut **≈ 2^-107** — quinze bits de moins, sans conséquence pratique, mais c'est le pire cas
qui majore réellement une forgerie sur ce format, pas le meilleur. Le mot « jamais » n'apparaît donc
nulle part dans les propriétés de la § 8. _(L'ADR 0015 écrit « 122 octets » pour la même grandeur ;
le compte exact des champs de la § 5.1 en donne 118, et `n` ne change pas — 118 comme 122 tiennent
en huit blocs de 128 bits.)_

**Le nom de l'algorithme entre dans les données associées.** Sous une future version, un chiffré
produit par un algorithme ne pourra pas être réinterprété par un autre. Un nom autre que
`aes-256-gcm` est refusé par `VAULT_CRYPTO_ALGORITHME_INCONNU` ; l'agilité passe par une version de
format et un ADR, jamais par une négociation à l'exécution — qui serait un mécanisme de
rétrogradation dès qu'un adversaire peut écrire le champ qui la porte.

### 4.2 Le nonce : douze octets TIRÉS, conservés avec chaque objet scellé

Chaque scellement tire douze octets de `crypto.getRandomValues` (construction du § 8.2.2 de SP
800-38D) et les **stocke** à côté de l'objet scellé. Rien ne le dérive, et rien ne le reconstruit.

**Ce n'est pas un choix de confort, c'est une correction.** La première version de l'ADR 0015
dérivait le nonce de `(génération, rang)`. Une revue l'a **réfutée par exécution** : la génération
n'avance qu'à la validation, la récupération la remet à celle de la racine qui fait autorité, et le
vidage conserve la génération en incrémentant la séquence. Une génération déposée puis écartée
**rend son numéro** à la tentative suivante, si bien qu'une **fermeture propre** d'un onglet avec un
dépôt non validé suffisait à réémettre un nonce — sans qu'aucune panne soit nécessaire. Sous GCM,
deux chiffrés sous le même nonce livrent `C1 ⊕ C2 = P1 ⊕ P2` et la clé d'authentification `H`.
Épreuve : `tests/unit/vm-format-chiffre-reprise.test.mjs` › « FERMETURE PROPRE d'un dépôt non validé
: la reprise ne réémet aucun nonce ».

**La leçon est plus générale que le défaut** : dans un système conçu pour survivre aux coupures et
exposé au retour arrière du support, **tout nonce déterministe dérivé d'un état DURABLE** —
génération, séquence, époque, compteur — est réémis dès que cet état recule. L'aléa est la seule
construction dont l'unicité ne dépend d'aucun état.

**Conséquences à écrire.**

- Le nonce ne **décrit** plus rien. Un nonce altéré ne se distingue pas d'un chiffré altéré : les
  deux tombent dans le même refus. Épreuve : `tests/unit/vm-format-chiffre-identite.test.mjs` › « le
  nonce fait douze octets et ne dérive de RIEN ».
- Le format **ne sait pas détecter** une réutilisation de nonce. Il est sans état ; l'unicité vient
  du tirage, pas d'un contrôle. Le dire vaut mieux qu'un contrôle qui rassurerait sans rien
  vérifier.
- Le tirage coûte **douze octets stockés** par secteur et par enregistrement, et ≈ 4 µs par
  scellement (ADR 0015, § « Calcul, mesuré »).
- La source de nonces du produit **n'est remplaçable que sous jeton du harnais**, et aucun chemin de
  production n'en fournit : `tests/unit/harnais-portes.test.mjs` › « aucun module hors des épreuves
  ne remplace la source de nonces ». Ce que la garde protège est exécuté :
  `tests/unit/vm-source-de-nonce.test.mjs` › « ce que la garde protège : un nonce constant rend le
  clair récupérable ».

**Bornes de collision.** Sur 96 bits, `N` tirages entrent en collision avec une probabilité majorée
par `N² / 2^97` : **2^-35** au budget retenu de 2^31, 2^-33 au plafond NIST de 2^32. Vérifié sur un
espace représentatif par `tests/unit/vm-format-chiffre-identite.test.mjs` › « aucune collision de
nonce sur un espace représentatif de tirages ».

### 4.3 Empreintes : SHA-256

Deux emplois, tous deux SHA-256 sur 32 octets :

1. **l'empreinte de la suite ordonnée des entrées** d'une génération, qui est le CLAIR que la racine
   scelle (§ 5.3) ;
2. **l'empreinte de la région d'authentification** du volume, scellée dans la racine (§ 6.8) : les
   `R × 512` octets de la région TELLE QU'ALIGNÉE (§ 6.1), **rembourrage compris** — pas les seuls
   octets utiles (`N × 34`) qu'elle porte avant alignement.

La seconde est calculée **en flux**, par tranches de 1 Mio, si bien que la surmémoire vaut une
tranche et non la taille de la région (34 Mio pour un volume de 512 Mio). L'implémentation
incrémentale est calibrée contre `crypto.subtle.digest` par `tests/unit/vm-sha256-stream.test.mjs` ›
« concorde avec WebCrypto quel que soit le DÉCOUPAGE en morceaux » — un instrument non calibré
invaliderait ce qu'il mesure.

### 4.4 La clé de volume : DÉRIVÉE d'une clé maîtresse reçue

> **Récrit par la v4** ([#182](https://github.com/pinfada/railsbox-vault/issues/182),
> [ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md)). Ce que le produit reçoit
> reste une clé de 32 octets développée par l'enveloppe — la DEK —, et il n'en fabrique toujours
> aucune. Ce qui change est ce qu'il en FAIT : elle n'est plus la clé AEAD du volume, elle est une
> clé MAÎTRESSE dont descend une clé par domaine, par volume et par version de format.
>
> ```text
> cleDeDomaine = HKDF-SHA-256(IKM = DEK, sel, info) → CryptoKey AES-256-GCM non extractible
>
> info = LP("railsbox-vault/derivation-de-domaine/v1")   étiquette du SCHÉMA de dérivation
>      ‖ LP(domaine)                                      « volume », « journal », « instantane », …
>      ‖ LP(identifiantVolume)                            32 hexadécimaux MINUSCULES
>      ‖ U32BE(versionDeFormatDuDomaine)                  la version du format que ce domaine scelle
>      ‖ LP("aes-256-gcm")                                l'algorithme, comme dans les données associées
>
> LP(s)    = longueur UTF-8 de s sur 2 octets gros-boutistes, puis les octets UTF-8 de s
> U32BE(n) = n sur 4 octets gros-boutistes
> ```
>
> **LES SIX DOMAINES sont dérivés, et la liste est CLOSE.** Elle l'est depuis la tranche T2b du 11
> septembre 2026 : ce § en annonçait quatre, et disait que `enveloppe` et `recuperation` « restent
> scellés sous la DEK ». Ce n'est plus vrai, et le § 12 ne porte plus l'écart.
>
> | Domaine        | Ce qu'il scelle                                       | Régime       | Sel                       |
> | -------------- | ----------------------------------------------------- | ------------ | ------------------------- |
> | `volume`       | secteurs, empreinte de région, témoin, racines        | compteur     | chaîne VIDE               |
> | `journal`      | enregistrements de `<volume>.gen`                     | compteur     | chaîne VIDE               |
> | `instantane`   | l'instantané de reprise, réécrit entier               | usage unique | 32 octets tirés, en clair |
> | `archive`      | l'engagement d'une archive d'export                   | usage unique | 32 octets tirés, en clair |
> | `enveloppe`    | la racine d'une page de `<volume>.cles` (page **v2**) | usage unique | 32 octets tirés, en clair |
> | `recuperation` | la racine de la page qu'une archive emporte           | usage unique | 32 octets tirés, en clair |
>
> Les deux régimes ne sont pas une commodité, ils suivent l'usage. Une clé à COMPTEUR est réemployée
> entre deux gestes, donc son **sel est la chaîne VIDE** (RFC 5869 § 2.2 — l'extraction reste
> correcte parce que l'IKM est déjà uniformément aléatoire sur 256 bits), et c'est son compteur qui
> la borne. Une clé à USAGE UNIQUE scelle un artefact réécrit ENTIER à chaque geste et ne porte donc
> qu'UN scellement : son **sel est tiré sur 32 octets et écrit EN CLAIR dans l'artefact**, ce qui
> rend chaque clé neuve et dispense de compter.
>
> **Plus AUCUN chemin d'écriture du format v4 ne scelle sous la DEK.** L'unique exception est la
> LECTURE d'un volume **v3** — pour le migrer, ou pour l'exporter avant de le migrer —, et elle est
> nommée : `Scellement.#sousLaCleMaitresse`. Un CLIQUET d'inspection de source
> (`tests/unit/vm-cliquet-anti-dek.test.mjs`) refuse qu'un chemin de production du format v4
> construise une clé AES-GCM depuis une clé de volume, en suivant les réexports et les alias.
>
> **Le sel en clair n'est pas authentifié, et il n'a pas à l'être.** Un adversaire qui le change
> obtient une clé différente, donc une ouverture qui échoue : il se protège par sa conséquence,
> exactement comme le nonce. Pour la page d'enveloppe, il est en outre COUVERT par la somme de
> contrôle de la page (§ 6.11), ce qui le rend accidentellement indestructible sans le rendre
> authentique.
>
> **La DEK ne peut plus chiffrer, et ce n'est pas une discipline.** Elle est importée en matériau
> HKDF — `importKey("raw", dek, "HKDF", false, ["deriveKey"])` —, si bien que
> `crypto.subtle.encrypt` la REJETTE par la spécification WebCrypto elle-même. Un appelant distrait
> obtient une exception, pas un chiffré. Épreuve : `tests/unit/vm-hierarchie-de-cles.test.mjs` › «
> la DEK importée en matériau HKDF : WebCrypto REFUSE de chiffrer avec elle ».
>
> Ce qui suit décrivait la v3, et reste vrai d'elle : la clé était REÇUE telle quelle.

Trente-deux octets aléatoires, importés dans WebCrypto en clé **non extractible**. Le format ne la
dérive pas, ne l'écrit pas, ne l'efface pas et ne la renouvelle pas : c'est l'objet de
l'[ADR 0020](decisions/0020-enveloppe-de-cle.md) et de
l'[ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md), hors périmètre de cette revue
(§ 11).

Ce que le format SUPPOSE de cette clé, et qu'il ne vérifie pas :

1. qu'elle est **aléatoire et propre à CE volume**. Deux volumes qui partageraient une clé ne
   seraient séparés que par leur identifiant dans les données associées ;
2. qu'elle est remise au **Worker de confiance** de l'ADR 0002 et n'existe nulle part ailleurs ;
3. que sa **durée de vie** est celle de la session déverrouillée ;
4. qu'un **changement de clé** est possible — ce qui, en l'état, signifie rechiffrer le volume
   entier.

L'importation non extractible ne protège pas contre du code hostile déjà présent dans le Worker :
celui-ci s'en sert sans la lire. Elle réduit la surface d'exfiltration accidentelle, et elle est
gratuite.

**Un volume v3 présenté sans clé est REFUSÉ avant toute lecture**, par `VAULT_STORAGE_CLE_REQUISE` :
`tests/unit/vm-volume-chiffre.test.mjs` › « REFUS 7 — un volume v3 SANS CLÉ est refusé par un code
typé, jamais lu en clair ».

### 4.5 Le budget de clé, et la conduite au plafond

> **Le constat de la revue externe du 10 septembre 2026 est CORRIGÉ, et il l'est pour les SIX
> domaines** ([#182](https://github.com/pinfada/railsbox-vault/issues/182), HIGH — § 9.7). Ce que ce
> paragraphe décrivait — un compteur PAR INSTANCE de scellement, présenté comme un compteur PAR CLÉ
> — n'existe plus. Depuis la v4, chaque domaine de chaque volume a SA clé ; depuis la page
> d'enveloppe v2 (§ 6.11), les deux derniers domaines à scellement direct sont passés eux aussi. La
> phrase « toutes les invocations sous une clé » est donc redevenue vraie, et elle est MESURÉE :
> `tests/unit/vm-budget-par-domaine.test.mjs` étiquette chaque `CryptoKey` par sa provenance et
> compte les invocations de `crypto.subtle.encrypt` par clé sur une session complète du produit.
>
> **Le budget, domaine par domaine, exhaustif :**
>
> | Domaine        | Clé par            | Compteur ? | Ce qui porte l'unicité                         | Ce qui est compté sous elle                                          | Au plafond                                              |
> | -------------- | ------------------ | ---------- | ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
> | `volume`       | volume             | oui        | aucun sel — la clé est RÉEMPLOYÉE              | secteurs, secteurs rescellés, empreintes de région, témoins, racines | `VAULT_CRYPTO_BUDGET_DE_CLE` avant de produire un octet |
> | `journal`      | volume             | oui        | aucun sel — la clé est RÉEMPLOYÉE              | enregistrements de `<volume>.gen`, et rien d'autre                   | idem                                                    |
> | `instantane`   | **capture**        | **non**    | sel de 32 octets TIRÉ, en clair dans l'en-tête | l'unique scellement d'une capture                                    | inatteignable : 1 devant 2^31                           |
> | `enveloppe`    | **page écrite**    | **non**    | sel de 32 octets TIRÉ, en clair dans la page   | la racine d'une page de `<volume>.cles`                              | inatteignable                                           |
> | `archive`      | **archive**        | **non**    | sel de 32 octets TIRÉ, en clair dans le voisin | l'engagement d'une archive                                           | inatteignable                                           |
> | `recuperation` | **page embarquée** | **non**    | sel de 32 octets TIRÉ, en clair dans la page   | la racine de la page qu'une archive emporte                          | inatteignable                                           |
>
> **La MESURE, sur une session complète.** Création d'un volume, versement, datation, ouverture
> transactionnelle, écriture, **cycle déverrouiller/verrouiller hors transaction**, second volume
> sous la MÊME clé de volume, capture de reprise, enveloppe de clé, moyen de récupération, export
> avec archive, révocation, **migration d'une page d'enveloppe v1**. Le relevé, par clé :
>
> | Clé                        | Invocations de `encrypt` |
> | -------------------------- | -----------------------: |
> | `volume` du volume A       |                       35 |
> | `volume` du volume B       |                       18 |
> | `journal` du volume A      |                        1 |
> | `journal` du volume B      |                        1 |
> | `instantane` (une capture) |                        1 |
> | `enveloppe` (quatre pages) |             1, 1, 1 et 1 |
> | `recuperation` (une page)  |                        1 |
> | `archive` (une archive)    |                        1 |
> | la clé de volume elle-même |                    **0** |
>
> Les chiffres des deux premières lignes dépendent du banc ; les autres ne dépendent de rien, et
> c'est la propriété : **un domaine à usage unique n'a JAMAIS deux invocations sous la même clé.**
> C'est la condition qui rend leur budget de 1 valable, et l'épreuve la mesure au lieu de
> l'affirmer.
>
> **La liste des gestes a été corrigée le 11 septembre 2026** (revue de sécurité de la PR #187,
> constat 8). Elle omettait quatre chemins — le cycle de la coquille, la migration d'une page v1,
> l'export d'un v3, la restauration d'une archive — c'est-à-dire ceux que la tranche AJOUTE ou
> MODIFIE, et trois de ceux que ce § déclare clos. Une sonde exhaustive jouée sur une session
> partielle ne prouve l'exhaustivité que de cette session ; les trois premiers sont désormais joués,
> et la restauration reste hors de ce banc parce qu'elle ne scelle rien (§ 7.5).
>
> **L'EXPORT D'UN v3 est mesuré à part, et il n'est pas à zéro.** Il n'est pas un chemin du format
> v4 : un volume v3 n'a pas de clé maîtresse, et l'ouvrir scelle sous la clé de volume ELLE-MÊME —
> trois fois au plancher, plus une par secteur rejoué. Le mesurer dans la même colonne que les
> chemins v4 ferait disparaître l'assertion qui compte : sur les chemins v4, le compte est ZÉRO,
> sans exception et sans nuance.
>
> | Clé                                 | Invocations de `encrypt` |
> | ----------------------------------- | -----------------------: |
> | la clé de volume v3, à l'export     |                    **3** |
> | toute autre clé, sur ce même chemin |                        0 |
>
> **Pourquoi quatre domaines n'ont PAS de compteur, et pourquoi c'est plus sûr.** Compter suppose un
> état durable, atomique et partagé ; ces domaines n'en ont aucun — c'est exactement le reproche du
> relecteur, « certaines [limites] ne sont pas persistées et d'autres n'existent pas ». Un sel tiré
> ne suppose rien : il ne recule pas avec le support, il ne se perd pas à la fermeture d'un onglet,
> il ne dépend d'aucune transaction. **Le budget d'une clé à usage unique est de 1, et aucune mesure
> ne peut le rendre faux.**
>
> **La règle de CLÔTURE, et ce que la v4 en tient — les TROIS chemins.** La règle est celle-ci :
> _toute session qui scelle sous une clé à compteur clôt par une RACINE qui publie les deux
> compteurs ; une ouverture qui ne peut pas écrire de racine n'a pas le droit de sceller — elle est
> en LECTURE SEULE, et un scellement demandé sous ce régime est refusé par
> `VAULT_STORAGE_LECTURE_SEULE` (§ 10.2)._
>
> Les trois chemins hors transaction closent désormais par une racine, et les trois sont mesurés à
> l'ÉGALITÉ — par le nombre d'invocations réelles de `crypto.subtle.encrypt`, jamais par une
> inégalité :
>
> 1. la **CRÉATION** écrit sa racine avant `VLTSEAL1` (§ 7.1) ;
> 2. l'**INSTALLATION INITIALE** du volume applicatif la réécrit une fois le disque versé, en
>    REPORTANT le compte que le versement lui rend — sans quoi elle perdrait les 2^20 scellements de
>    la création ;
> 3. la **RÉOUVERTURE HORS TRANSACTION** — le volume de COQUILLE — tient son magasin de générations
>    SANS l'installer, et le referme par une racine de clôture. C'est la décision de T2b, et son
>    point est là : installer le magasin détournerait les écritures vers le journal, ce que ce mode
>    ne veut pas ; le tenir sans l'installer reprend les compteurs à l'ouverture et les republie à
>    la fermeture. La clôture n'écrit AUCUNE racine si la session n'a rien scellé — une clôture
>    inconditionnelle consommerait un scellement pour publier le compte de ce scellement.
>
> **La clôture suit le SECTEUR, et non la fermeture.** Une racine écrite au seul `close()` perdrait
> tout ce qu'une session TUÉE a scellé — et une session de coquille est tuée à chaque onglet fermé,
> par `pagehide`, sans que `close()` ne soit jamais appelé. La racine est donc écrite dans la même
> séquence d'écriture que le secteur qu'elle publie, avant que la main ne revienne à l'appelant : à
> tout instant, ce que la racine publie vaut ce que la session a scellé. Le geste est IDEMPOTENT —
> le repère avance avec la racine qu'on vient d'écrire —, de sorte que le `close()` qui suit
> n'écrive pas une seconde racine.
>
> **Le QUATRIÈME cas, et c'est une déclaration : `clotureParDatation`.** L'INSTALLATION INITIALE est
> une naissance hors transaction qui écrit le fichier entier, puis le ferme, puis le fait DATER. Si
> elle closait par une racine à chaque secteur versé, elle paierait une racine par secteur, et la
> datation les périmerait toutes. Le versement DÉCLARE donc, à l'ouverture, que sa clôture sera la
> datation (`clotureParDatation: true`) : aucune clôture n'est installée, la session rend son COMPTE
> à l'appelant (`scellementsCumules`), et `daterLaCreation` écrit la racine finale en REPORTANT ce
> compte.
>
> Cet invariant est **FAIT, mais non garanti**, au sens de
> l'[ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md) : il est tenu par l'APPELANT
> et par lui seul. Un appelant qui déclarerait `clotureParDatation` et ne daterait jamais laisserait
> un volume qui ne clôt par rien — et ce volume se rouvre sans refus, des deux côtés. Le drapeau est
> interne : seuls `verserLeDisque` et le banc de budget le posent, aucun adversaire ne l'atteint, et
> rien n'expose ce chemin. Le dire vaut mieux que de le laisser croire vérifié (revue de sécurité de
> la PR #187, constat 7).
>
> **Ce que la racine de clôture apporte en plus des compteurs.** Elle RESCELLE l'empreinte de région
> sous sa propre génération (§ 6.8). Une écriture hors transaction périmait donc la fraîcheur de la
> dernière racine, si bien qu'un ouvreur transactionnel refusait ensuite le volume par
> `VAULT_STORAGE_GENERATION_CORRUPT` ; clore par une racine referme cela du même geste.
>
> **Ce qu'elle n'apporte PAS, et ce § l'a affirmé à tort.** Hors transaction, la fraîcheur n'est PAS
> confrontée à l'ouverture : `confronterLaFraicheur` est posé à `false` sur ce chemin. La clôture
> RÉTABLIT la fraîcheur pour l'ouvreur transactionnel qui suivra ; elle ne la CONFRONTE pas, et le
> volume de coquille ne gagne donc AUCUNE garde de l'ADR 0019 — il n'en a jamais porté. Ce que la
> confrontation aurait refusé à l'OUVERTURE reste refusé, mais ailleurs et autrement : un secteur
> ramené en arrière est refusé au SECTEUR par son SCEAU — `VAULT_STORAGE_SCEAU_REFUSE` à la LECTURE
> — et non `VAULT_STORAGE_GENERATION_CORRUPT` à l'ouverture. Aucun clair d'un secteur rejoué n'est
> rendu dans l'un ni dans l'autre régime.
>
> **Pourquoi la garde n'est pas là.** Elle y a été, le temps d'un commit, et le banc de navigateur
> l'a réfutée par exécution : un Worker de confiance peut être TUÉ sans avoir clos — c'est le cas
> ordinaire d'un onglet fermé —, et la garde refusait alors le coffre à l'ouverture suivante pour un
> verrouillage parfaitement ordinaire. Entre « refuser un volume sain après un verrouillage » et «
> refuser un secteur rejoué à la lecture plutôt qu'à l'ouverture », la seconde conduite est celle
> qui ne coûte pas le coffre. `tests/unit/vm-cloture-par-racine.test.mjs` › « la fraîcheur n'est PAS
> confrontée hors transaction » MESURE les deux refus plutôt que de les affirmer.
>
> **Ce qui reste vrai, et qui n'est pas corrigé par la séparation des clés** : les deux compteurs
> vivent toujours dans la racine, donc ils RECULENT avec elle (§ 9.1, constat #144). L'écart entre
> le compteur et le nombre réel d'invocations reste non borné, et la moitié du plafond NIST — 2^31
> devant 2^32 — reste la marge choisie devant cet écart. La séparation des clés ne referme pas la
> question n° 4 : elle en retire la moitié qui n'était pas une question de recul, la PORTÉE.
>
> Ce qui suit décrit le mécanisme commun aux deux versions, et reste vrai.

| Grandeur                                                |            Valeur |
| ------------------------------------------------------- | ----------------: |
| Plafond d'invocations par clé, NIST SP 800-38D § 8.3    |              2^32 |
| **Budget retenu par ce format**                         |          **2^31** |
| Probabilité de collision de nonce au budget retenu      | `N²/2^97` ≈ 2^-35 |
| Octets de charge correspondants (secteurs de 512 o)     |             1 Tio |
| Réécritures complètes d'un volume applicatif de 512 Mio |             2 048 |

**Ce que chaque compteur compte.** Le § 8.3 compte « all instances of the authenticated encryption
function ». Depuis la v4, la comptée est répartie sur DEUX clés, et la répartition est le sujet :
`scellementsCumulesVolume` compte les secteurs de la charge, les secteurs rescellés au point de
contrôle, les empreintes de région, les témoins **et les racines** ; `scellementsCumulesJournal`
compte les enregistrements déposés dans `<volume>.gen`, et rien d'autre. Une barrière du guest qui
valide un enregistrement consomme donc **trois** du budget du volume (racine, empreinte de région,
témoin) et **un** de celui du journal, au lieu de quatre d'un compteur unique qui les moyennait. À
2^31 par clé, le nombre de barrières admissibles est borné par la première des deux à atteindre son
plafond — ~716 millions du côté du volume. Épreuves : `tests/unit/vm-generation-chiffre.test.mjs` ›
« le compteur de scellements de la racine COMPTE les racines et les enregistrements » et
`tests/unit/vm-hierarchie-de-cles.test.mjs` › « les deux compteurs d'un volume sont DISTINCTS ».

**Où ils vivent.** Dans l'en-tête AUTHENTIFIÉ de la racine : `scellementsCumulesVolume` à l'offset
68, `scellementsCumulesJournal` à l'offset 202 (§ 6.7). Ils traversent donc les sessions — et ils
**reculent** avec un retour arrière du support. Le nombre réel d'invocations sous la clé peut alors
dépasser le nombre compté, d'un écart qu'aucune mesure ne borne aujourd'hui. La moitié du plafond
NIST est la marge choisie devant cet écart ; c'est la **question n° 4** de la § 13.

**Le compteur n'est plus sous-estimé sur les chemins que la v4 ferme.** Ce paragraphe avouait,
jusqu'à la v3, qu'un volume ouvert sans journal n'écrivait aucune racine et que ses scellements
n'étaient donc comptés que le temps de la session. L'aveu est retiré **pour la création et pour
l'installation initiale** : la première clôt par une racine, la seconde en réécrit une qui REPORTE
le compte que le versement lui rend. Les deux sont mesurées à l'ÉGALITÉ — par le nombre
d'invocations réelles de `crypto.subtle.encrypt`, et non par une inégalité —, et le chemin
transactionnel ordinaire l'est aussi, sur cinq ouvertures successives
(`tests/unit/vm-cloture-par-racine.test.mjs`).

**UNE sous-estimation subsiste, et elle a une BORNE.** L'écrire ici plutôt que de la laisser à un §
lointain est le prix d'un paragraphe normatif qui ne se contredit pas :

- **une MIGRATION v3 → v4 reprise après coupure peut avoir rescellé certains secteurs deux fois.**
  L'écart vaut au plus une suite de conversion — 512 secteurs — par coupure, parce que la reprise ne
  rejoue que la suite qui était en vol (§ 7.4).

La seconde, qui a vécu du 11 septembre au matin au 11 septembre au soir, est CLOSE : le volume de
COQUILLE scellait un secteur par déverrouillage sans clôture, et cet écart n'avait aucune borne — il
croissait d'un scellement par déverrouillage. La racine de clôture du troisième chemin le referme,
et « CHEMIN 3 » de `tests/unit/vm-cloture-par-racine.test.mjs` mesure désormais une ÉGALITÉ là où
elle mesurait un écart.

**Un dernier écart, hors de ce paragraphe mais de la même famille, reste ouvert et il est écrit
partout de la même phrase** : ouvrir un volume **v3** — pour le migrer, ou pour l'EXPORTER avant de
le migrer (§ 7.4) — fait écrire au magasin une racine v3 et rescelle la charge acquittée, c'est-à-
dire **3 + N scellements** sous la clé de volume ELLE-MÊME : l'empreinte de région, la racine de
clôture et le témoin, PLUS un par secteur rejoué de la charge acquittée. Le compte n'est donc pas
une constante, et rien dans ce § ne le borne : c'est le contenu du journal validé qui le fixe. Les
3 + N passent tous par le budget, donc la racine v3 les PUBLIE, et
`tests/unit/vm-migration-source-v3.test.mjs` › « ce que l'export d'un v3 SCELLE est mesuré » compte
les deux grandeurs par sonde sur `encrypt` plutôt que de les affirmer. Un volume v3 n'a pas de clé
maîtresse : c'est le régime que la v4 remplace, et c'est l'unique exception du cliquet anti-DEK
(`tests/unit/vm-cliquet-anti-dek.test.mjs`).

Une troisième a existé entre le 11 septembre et la revue de la PR #186, et il vaut mieux l'écrire
que de laisser croire que ce § a toujours dit vrai : l'INSTALLATION INITIALE publiait 18 scellements
pour 38 réels — la datation ne reportait que les compteurs de la racine de NAISSANCE, et tout le
versement disparaissait. Pour un disque de 512 Mio, c'était la moitié du budget de la clé perdue à
l'installation, sur le chemin même que ce paragraphe déclarait clos. Le versement rend désormais son
compte comme il rend déjà son empreinte.

**Le compteur est REPRIS de la racine qui fait autorité, sans contrôle de croissance.** À
l'ouverture, la session reprend le compteur à `scellementsCumules + 1` de cette racine, sans le
comparer au témoin, à la racine voisine ni à quoi que ce soit d'autre : il ne peut que **suivre**
les reculs de cette racine, jamais les corriger. Ce n'est pas seulement la conséquence d'un retour
arrière du support (question n° 4) : il suffit qu'une racine plus ancienne fasse autorité pour une
autre raison — voir § 9.6, constat [#144](https://github.com/pinfada/railsbox-vault/issues/144) —
pour que le compteur recule avec elle, sans qu'aucun refus ne le signale.

**Le budget est celui de la racine qui fait AUTORITÉ, et un recul d'une génération le rend d'autant.
Ce n'est PAS une réutilisation de nonce.** Les nonces sont **tirés**, jamais dérivés d'un compteur
(§ 4.2) : reculer le compteur ne fait donc réémettre aucun nonce déjà employé, et la probabilité de
collision reste celle du § 4.2 pour le nombre **réel** d'invocations. Ce que le recul dégrade est la
**fidélité de la mesure** — le compteur sous-estime alors ce qui a été consommé sous la clé, et le
plafond de 2^31 est atteint plus tard qu'il ne devrait l'être. C'est un compteur de **conduite**,
pas un contrôle cryptographique, et c'est pour cet écart-là que la moitié du plafond NIST est prise
comme marge. Aucun contrôle n'est ajouté ici : le refus que #144 apporte porte sur la racine, pas
sur le compteur.

**Conduite au plafond.** À 2^31, tout scellement est refusé **avant de produire le moindre octet**,
par `VAULT_CRYPTO_BUDGET_DE_CLE`, traduit en `VAULT_STORAGE_BUDGET_DE_CLE`. Le refus n'est pas
franchissable : le remède est une **clé de volume neuve**, donc le rechiffrement du volume entier,
et ce geste n'existe pas encore dans le produit (§ 11). Épreuves :
`tests/unit/vm-volume-chiffre.test.mjs` › « le budget de clé refuse le scellement AVANT de produire
le moindre octet » et `tests/unit/vm-format-chiffre-identite.test.mjs` › « le budget de scellements
par clé est PLUS SERRÉ que le plafond de NIST, et dit pourquoi ».

## 5. L'identité logique et les données associées

Ce que GCM authentifie sans le chiffrer, ce sont les **données associées**. C'est là que vit
l'identité logique : le format y met tout ce qui pourrait servir à faire passer un objet authentique
pour un autre.

**Deux conventions de boutisme coexistent, et les confondre est l'erreur la plus facile de tout ce
document :**

- **les données associées sont GROS-BOUTISTES** (§ 5.1 à 5.3) ;
- **les en-têtes sur disque sont PETIT-BOUTISTES** (§ 6), par la convention de `DataView` qu'emploie
  le reste du dépôt.

### 5.1 Données associées d'un bloc du volume

Un « bloc » est un objet du magasin **VOLUME** : un **secteur** de la charge, l'**empreinte de la
région** d'authentification, ou le **témoin** de séquence. Un **enregistrement du journal** n'en est
pas un — il a sa propre étiquette de domaine depuis le format de journal 4 (§ 5.1 bis), et le § 5.4
dit pourquoi le rang ne suffisait pas à les séparer.

| Ordre | Champ                       | Longueur      | Encodage                                                                               |
| ----- | --------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| 1     | Étiquette de domaine        | 2 + 37 octets | longueur gros-boutiste sur 2 o, puis UTF-8 : `railsbox-vault/format-chiffre/v1/bloc`   |
| 2     | Nom de l'algorithme         | 2 + 11 octets | idem : `aes-256-gcm`                                                                   |
| 3     | Version du format de volume | 4 octets      | entier gros-boutiste — **4** (3 sur un volume antérieur)                               |
| 4     | Identifiant de volume       | 2 + n octets  | idem : chaîne quelconque ; **32 caractères hexadécimaux minuscules** pour un volume v3 |
| 5     | Génération                  | 8 octets      | entier gros-boutiste                                                                   |
| 6     | Rang de l'entrée            | 8 octets      | entier gros-boutiste                                                                   |
| 7     | Adresse logique             | 8 octets      | entier gros-boutiste                                                                   |
| 8     | Longueur du clair           | 4 octets      | entier gros-boutiste                                                                   |

Total pour un volume v3, dont l'identifiant fait trente-deux caractères : **118 octets** (39 + 13 +
4 + 34 + 8 + 8 + 8 + 4).

**Où la forme 32-hex est réellement imposée, et où elle ne l'est pas.** L'encodage lui-même
(`encoderIdentiteBloc`) accepte une chaîne de longueur QUELCONQUE pour le champ 4 — 118 octets n'est
donc le total que **pour un identifiant de trente-deux caractères**. La forme 32-hex minuscule est
imposée un étage plus haut : par `identifiantVolumeEnOctets` (§ 6.2, l'en-tête v3) et par le
manifeste (§ 6.10), pas par l'encodage d'identité. `tests/vectors/format-chiffre-v1.json` en tire
parti pour son propre confort de lecture : son identifiant de vecteur, `volume-de-vecteur` (dix-sept
caractères), donne des données associées de **103 octets** (39 + 13 + 4 + 19 + 8 + 8 + 8 + 4) et non
118 — un relecteur qui recalcule ce vecteur à la lettre de ce tableau échoue avant d'avoir rien
attaqué s'il suppose 118 octets partout.

**Chaque champ est de largeur fixe ou préfixé de sa longueur, et ce n'est pas une élégance.** Une
concaténation non préfixée permettrait de déplacer un caractère d'un champ à l'autre sans changer
les octets — donc de déplacer un bloc sans que l'étiquette bronche. La propriété est éprouvée **par
mutation** plutôt qu'affirmée : `tests/unit/vm-format-chiffre-identite.test.mjs` › « le PRÉFIXE DE
LONGUEUR est ce qui rend l'encodage injectif : sans lui, deux identités collisionnent ».

**La conversion de l'identifiant de volume est FIXÉE.** Le disque porte **seize octets bruts**
(en-tête v3, racine) ; les données associées portent une **chaîne** de trente-deux caractères
hexadécimaux **minuscules**, sans séparateur. Deux conventions donneraient deux étiquettes
différentes pour le même volume. Épreuve : `tests/unit/vm-format-chiffre-identite.test.mjs` › « la
conversion de l'identifiant de volume est FIXÉE : seize octets vers trente-deux caractères ».

**Bornes des champs, refusées et non rebouclées :** génération ≤ 2^48 − 1 (la largeur du champ sur
le disque, § 6.4), rang ≤ 2^40 − 1, version de format ≤ 2^32 − 1, longueur ≤ 2^32 − 1, adresse ≤
2^53 − 1. Une valeur hors bornes est refusée par `VAULT_CRYPTO_MALFORME` :
`tests/unit/vm-format-chiffre-identite.test.mjs` › « les bornes des champs d'identité sont refusées
avant de reboucler en silence ».

### 5.1 bis Données associées d'un enregistrement du journal

**Même forme, autre étiquette de domaine.** Les huit champs, leurs largeurs, leur ordre et leurs
préfixes sont ceux du § 5.1 ; seul le champ 1 change :

| Ordre | Champ                | Longueur      | Encodage                                                                                       |
| ----- | -------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| 1     | Étiquette de domaine | 2 + 47 octets | longueur gros-boutiste sur 2 o, puis UTF-8 : `railsbox-vault/format-chiffre/v1/enregistrement` |

Total pour un volume v3, dont l'identifiant fait trente-deux caractères : **128 octets** (49 + 13 +
4 + 34 + 8 + 8 + 8 + 4), soit dix de plus que les 118 d'un bloc — la longueur de l'étiquette, et
rien d'autre. Les bornes des champs 3 à 8 sont celles du § 5.1, refusées de la même façon.

**Le rang y est la POSITION de l'enregistrement dans sa charge**, en base zéro. Il ordonne ; il ne
sépare plus rien (§ 5.4).

Cette étiquette est apparue avec le **format de journal 4** (§ 6.7). Un journal de format 2 ou 3
porte des enregistrements scellés sous l'étiquette d'un **bloc** : le § 6.6 dit ce que ce runtime en
fait. Épreuves : `tests/unit/vm-identite-magasin.test.mjs` › « les données associées d'un
enregistrement de journal ne sont JAMAIS celles du secteur homologue » et
`tests/unit/vm-identite-magasin.test.mjs` › « un ENREGISTREMENT de journal épissé dans la région et
la charge du volume est REFUSÉ ».

### 5.2 Données associées d'une racine

| Ordre | Champ                                    | Longueur      | Encodage                                                         |
| ----- | ---------------------------------------- | ------------- | ---------------------------------------------------------------- |
| 1     | Étiquette de domaine                     | 2 + 39 octets | `railsbox-vault/format-chiffre/v1/racine`                        |
| 2     | Nom de l'algorithme                      | 2 + 11 octets | `aes-256-gcm`                                                    |
| 3     | Version du format de volume              | 4 octets      | gros-boutiste — **4** (3 sur un volume antérieur)                |
| 4     | Identifiant de volume                    | 2 + n octets  | chaîne quelconque ; 32 hexadécimaux minuscules pour un volume v3 |
| 5     | Séquence                                 | 8 octets      | gros-boutiste                                                    |
| 6     | Génération                               | 8 octets      | gros-boutiste                                                    |
| 7     | Taille LOGIQUE du volume                 | 8 octets      | gros-boutiste                                                    |
| 8     | Nombre d'entrées                         | 4 octets      | gros-boutiste — **dérivé**, jamais reçu                          |
| 9     | Longueur de charge                       | 8 octets      | gros-boutiste — somme des CLAIRS, **dérivée**                    |
| 10    | Scellements cumulés du domaine `volume`  | 8 octets      | gros-boutiste                                                    |
| 11    | Scellements cumulés du domaine `journal` | 8 octets      | gros-boutiste — **v4 seulement**                                 |

Total : **144 octets** pour un volume v4 dont l'identifiant fait trente-deux caractères (41 + 13 + 4

- 34 + 8 + 8 + 8 + 4 + 8 + 8 + 8), et **136** pour un volume v3, qui n'a pas le champ 11. Voir § 5.1
  pour ce que devient ce total sous un identifiant d'une autre longueur, ce que
  `encoderEnteteRacine` accepte tout autant. À ne pas confondre avec les 136 octets qu'une racine de
  format 2 occupait dans son secteur (§ 6.7) : les deux nombres sont égaux par coïncidence et ne
  mesurent pas la même chose.

**Le NOMBRE de champs suit la version de format, et la version est le champ 3 — donc AUTHENTIFIÉE.**
C'est ce qui rend le second compteur inviolable sans l'ajouter à une garde : une racine v4 relue
comme une racine v3 présente dix champs à l'étiquette, qui refuse ; une racine v3 relue comme une v4
en présente onze, et l'étiquette refuse de même. Le champ de format du JOURNAL, à l'octet 8 de la
racine sur disque, n'est PAS authentifié et ne décide de rien ici : c'est la version du VOLUME que
la session tient qui décide, et elle est scellée. Épreuves : `tools/verifier-vecteurs.mjs` › « la
même racine relue à DIX champs ne vérifie pas » et `tests/unit/vm-generation-format.test.mjs` › «
une racine à UN seul compteur est refusée par un volume v4 ».

**Pourquoi les racines relèvent du domaine `volume` et non du domaine `journal`**, alors qu'elles
authentifient la suite des entrées du journal : une racine vit dans le fichier de VOLUME, à
l'emplacement `séquence mod 2` (§ 6.6), et c'est elle qui porte les compteurs des deux domaines. La
faire dépendre de la clé du journal ferait dépendre le compteur du volume d'une clé que le journal
peut vider. La racine est l'autorité du volume ; elle est scellée sous la clé du volume.

**Les données associées ne gagnent PAS de champ « domaine » de dérivation**, et c'est une décision
(ADR 0033, décision 5) : le domaine sépare désormais les CLÉS, et le répéter ici suggérerait que ce
sont les données associées qui font ce travail — la confusion que #182 vient précisément de
corriger. L'étiquette de domaine du champ 1 reste ce qu'elle a toujours été : ce qui empêche un
objet d'être relu comme un autre **sous la même clé**, et il n'y en a plus qu'un par clé.

**Le CLAIR que la racine scelle est l'empreinte SHA-256 de la suite ordonnée de ses entrées** (§
5.3), 32 octets — et rien d'autre.

**L'ordre entre en-tête et clair décide de ce que le format a le droit d'AFFIRMER.** En vérifiant
d'abord l'étiquette sur l'en-tête, le lecteur obtient un en-tête **authentique** ; il peut alors
comparer ce qu'il a trouvé à ce que la racine déclare et nommer une **troncature établie**. Dans
l'autre sens, « troncature » serait un diagnostic posé sur un en-tête que rien ne garantit,
c'est-à-dire une devinette.

**Le compte et la longueur sont DÉRIVÉS des entrées au moment de sceller.** Une racine qui
annoncerait un compte différent de ce qu'elle scelle serait une troncature signée par son propre
producteur. C'est la même règle que celle qui interdit de stocker la longueur physique de la charge
(§ 6.7).

**L'en-tête de racine est en CLAIR sur le support, et il faut dire ce qu'il révèle** : le nombre
d'écritures d'une génération, la longueur de sa charge, le rang de la génération, la taille du
volume et le compteur cumulé de scellements. C'est un canal auxiliaire sur le **volume d'activité**.
Il est assumé, pas découvert : le chiffrer exigerait de choisir la racine qui fait autorité sans
lire son en-tête, ce que l'alternance de la § 6.6 rend impossible. C'est la **question n° 8** de la
§ 13.

### 5.3 Encodage canonique de la suite des entrées

```text
  2 + 40 octets   étiquette de domaine « railsbox-vault/format-chiffre/v1/entrees », préfixée
  4 octets        nombre d'entrées, gros-boutiste
  puis, POUR CHAQUE ENTRÉE, dans l'ordre de la suite :
      8 octets    adresse logique, gros-boutiste
      4 octets    longueur du clair, gros-boutiste
      8 octets    rang, gros-boutiste
     16 octets    ÉTIQUETTE du bloc scellé
```

Soit **36 octets par entrée**. L'empreinte SHA-256 de cette suite est le clair de la racine.

**Pourquoi l'étiquette du bloc et non son chiffré.** Sous une même clé, un même nonce et une même
identité, deux chiffrés distincts partageant une étiquette constitueraient une forgerie GCM, bornée
par 2^-122,6. La racine dit donc **quels** blocs composent la génération ; chaque bloc dit qu'il est
**intact**. Aucune des deux vérifications ne remplace l'autre, et un lecteur doit faire les deux.

**Pourquoi le nonce n'y figure pas.** Il est conservé avec l'enregistrement, et l'étiquette le
couvre déjà : une étiquette ne vérifie que sous le nonce qui l'a produite.

**L'ordre est significatif.** La racine scelle une **suite**, pas un sac : deux permutations des
mêmes entrées sont deux générations différentes. Les rangs doivent croître **strictement** —
`tests/unit/vm-format-chiffre-identite.test.mjs` › « les rangs d'une génération doivent croître
STRICTEMENT : l'ordre est une propriété » —, faute de quoi le scellement est refusé par
`VAULT_CRYPTO_ORDRE_INVALIDE` avant de produire un octet.

**Une borne mémoire, trouvée par exécution.** L'assemblage de cette suite doit se faire sans étaler
ses morceaux sur la pile d'appel : au plafond de charge du journal, le nombre de morceaux dépasse la
pile de tous les moteurs mesurés (« Maximum call stack size exceeded » au milieu d'une
récupération). La rupture tombait à **31 170 entrées**, soit 15,22 Mio — **sous** le plafond de 16
Mio, donc atteignable par une génération que le produit accepte. Les octets produits sont inchangés.
Épreuve : `tests/unit/vm-format-chiffre-identite.test.mjs` › « l'encodage des entrées tient une
génération AU PLAFOND, sans déborder la pile d'appel ».

### 5.4 Les rangs, et les trois rangs réservés

**Le rang ne sépare PAS les deux magasins, et c'est une correction.** Ce document a affirmé le
contraire — « le rang sépare des identités qui partageraient tout le reste » — au-dessus d'une table
qui épingle le rang 0 pour un secteur du volume. La pré-revue adverse de #20 l'a réfutée sur les
vecteurs livrés ([#143](https://github.com/pinfada/railsbox-vault/issues/143)) : le rang d'un
enregistrement est sa **position dans la charge**, donc le premier enregistrement de chaque charge
porte lui aussi le rang 0, et une écriture du guest alignée sur un secteur — le cas nominal du § 7.2
— donnait deux objets de magasins différents sous des données associées identiques octet pour octet.

**Ce qui sépare les magasins est l'ÉTIQUETTE DE DOMAINE** (§ 5.1 et § 5.1 bis), et elle les sépare à
**tout rang**. Le rang, lui, sépare des identités **à l'intérieur d'un magasin** : trois valeurs
sont **épinglées par le format** pour le magasin du volume, et le rang d'un enregistrement ordonne
la charge du journal.

| Rang       | Valeur              | Ce qu'il identifie                                          |
| ---------- | ------------------- | ----------------------------------------------------------- |
| 0          | `0`                 | un **secteur du volume** — une seule version par génération |
| `2^40 − 2` | `1 099 511 627 774` | le **témoin** de dernière séquence vue                      |
| `2^40 − 1` | `1 099 511 627 775` | l'**empreinte de la région** d'authentification             |

Les rangs qu'un volume emploie réellement partent de zéro et la charge est plafonnée à 16 Mio, soit
au plus quelques dizaines de milliers d'entrées : prendre les deux plus grands rangs représentables
met ces identités hors d'atteinte de toute collision **sans coûter un octet de format**.

Un enregistrement de journal, lui, porte sa **position dans la charge**, en base zéro — et il vit
dans l'autre espace d'identités, celui du § 5.1 bis. Un rang décalé aurait fermé le cas observé sans
fermer la classe : deux magasins seraient restés dans le même espace, séparés par une convention que
rien n'aurait relue.

## 6. La disposition sur disque

### 6.1 Le fichier de volume

```text
  offset 0                      en-tête v3                 1 secteur   (512 o)
  offset 512                    région d'authentification  R secteurs
  offset 512 + R × 512          charge chiffrée            N secteurs
```

avec `N = tailleLogique / 512` et `R × 512 = alignerHaut(N × 34, 512)`.

Un secteur logique d'adresse `a` vit à l'offset support `512 + R × 512 + a`, et son sceau à
`512 + (a / 512) × 34`.

**La taille LOGIQUE reste celle que l'émulateur voit.** Le mappage est confiné à une seule pièce, ce
qui permet à la géométrie de blocs, au contrat de tampon de v86 et à l'oracle de résilience de
n'avoir pas bougé.

Pour le volume applicatif de 512 Mio :

| Grandeur                |        Valeur |
| ----------------------- | ------------: |
| Taille logique          | 536 870 912 o |
| Secteurs logiques `N`   |     1 048 576 |
| Région `N × 34`         |  35 651 584 o |
| Région, en secteurs `R` |        69 632 |
| Taille du fichier       | 572 523 008 o |
| **Surcoût**             |  **+6,641 %** |

La région tombe juste à cette taille, sans rembourrage. Elle est alignée **vers le haut** dans le
cas général : la tronquer priverait les derniers secteurs de leur sceau, c'est-à-dire les rendrait
illisibles. Épreuves : `tests/unit/vm-volume-chiffre-format.test.mjs` › « la disposition d'un volume
de 512 Mio tombe juste sur 69 632 secteurs de région » et
`tests/unit/vm-volume-chiffre-format.test.mjs` › « une région qui ne tombe pas juste est alignée
VERS LE HAUT, jamais tronquée ».

**Pourquoi une région dédiée plutôt qu'un entrelacement.** Entrelacer (546 octets par secteur
logique) casserait l'alignement sur 512 et sur la page hôte de 4 096 octets, donc la géométrie que
le backend impose et que le point de contrôle exploite pour recopier des secteurs alignés.
**Pourquoi dans le fichier du volume et non dans un voisin** `<volume>.auth` : un voisin ajouterait
un problème d'atomicité entre deux fichiers là où il n'y en a pas — un handle, une barrière, un
fichier.

**Ce que la région coûte en lecture.** Lire un secteur exige ses 34 octets de métadonnées, donc une
lecture de plus. Une page hôte de 4 096 octets de région porte les métadonnées de **120 secteurs
consécutifs** (60 Kio de charge) : le surcoût est d'une lecture par ~120 secteurs en accès
séquentiel, et d'une lecture par secteur en accès aléatoire.

### 6.2 L'en-tête, champ par champ

Un secteur, **petit-boutiste**. La disposition est celle de la v3, à l'octet près : seuls le
marqueur et le champ de version bougent en v4.

| Offset | Largeur | Champ                                                  |
| ------ | ------: | ------------------------------------------------------ |
| 0      |       8 | marqueur `VLTVOL04` (ASCII) — `VLTVOL03` sur un v3     |
| 8      |       4 | version du format de volume — **4**                    |
| 12     |       4 | taille de secteur — **512**                            |
| 16     |       8 | taille LOGIQUE du volume                               |
| 24     |       8 | offset de la région d'authentification — **512**       |
| 32     |       8 | longueur de la région d'authentification               |
| 40     |       8 | offset de la charge chiffrée                           |
| 48     |      16 | identifiant de volume, **seize octets bruts**          |
| 64     |       8 | **marque de scellement complet** — `VLTSEAL1` ou zéros |
| 72     |     440 | réserve, à zéro                                        |

Les 512 octets de l'en-tête v4 sont figés dans `tests/vectors/volume-v4.json`, champ `enTete.hex` ;
ceux de l'en-tête v3 restent dans `tests/vectors/disposition-v3.json`, où ils ne bougent pas. Le
vérificateur de la § 2 reconstruit les deux, champ par champ.

**Le MARQUEUR bouge, alors que le champ de version aurait suffi à distinguer les deux formats.** La
raison est d'exploitation, pas de sûreté : une commande qui cherche `VLTVOL03` dans un fichier ne
doit pas trouver un volume v4 et le croire lisible par un runtime d'avant #182. Le premier
discriminant d'un format persistant est celui qu'on lit à l'œil.

**Les trois offsets déclarés (24, 32, 40) sont REDONDANTS avec la taille logique**, et le décodeur
les traite comme tels : il recalcule la disposition depuis la taille logique et **refuse** l'en-tête
dont les offsets déclarés ne concordent pas. Un en-tête qui mentirait sur l'endroit où la charge
commence ferait lire des sceaux comme des données.

**Cet en-tête n'est PAS une autorité, et il ne prétend pas l'être.** Il n'est ni chiffré ni
authentifié : il **localise**. Ce qui le rend inoffensif est ailleurs — l'identifiant de volume et
la version de format entrent dans les données associées de **chaque** secteur, si bien qu'un en-tête
falsifié fait échouer la première lecture par un sceau refusé au lieu de rendre du clair. Le seul
dommage qu'une altération produise est donc un **refus**, jamais une lecture erronée. L'authentifier
exigerait de pouvoir le lire sans connaître l'identifiant qu'il porte, ce qui est circulaire.

**Ce que le décodeur refuse sans clé** : marqueur absent ou d'une autre version que celle qu'on lui
demande, version de format qui ne concorde pas avec ce marqueur, taille de secteur autre que 512,
taille logique inadmissible, et **disposition incohérente** — l'en-tête qui placerait la région ou
la charge ailleurs que là où la taille logique l'impose.

**Un en-tête v3 présenté à l'ouverture d'un produit v4 est REFUSÉ, et il est NOMMÉ.** Le refus dit
que ce fichier est un volume v3 et que le remède est la MIGRATION, jamais une sauvegarde : un volume
v3 n'est plus lu que par elle (ADR 0033, décision 5, point 2 ; § 7.3 et § 7.4). Le fichier n'est pas
lu pour autant — on nomme, on refuse, et c'est la migration qui ouvre. Épreuves :
`tests/unit/vm-volume-chiffre-format.test.mjs` › « l'en-tête v3 fait un secteur, porte son marqueur
et rend ce qu'il a reçu » et `tests/unit/vm-volume-chiffre-format.test.mjs` › « un en-tête dont la
disposition ne se déduit pas de sa taille logique est refusé ».

**L'ouverture confronte l'identifiant de l'en-tête à celui que le MANIFESTE déclare** et refuse
l'écart par `VAULT_STORAGE_IDENTITE_VOLUME` avant toute lecture de charge : deux sources qui
divergent ne se départagent pas, elles se refusent.

### 6.3 La marque de scellement complet

Huit octets `VLTSEAL1` à l'offset 64 de l'en-tête. **Elle est le DERNIER geste d'une création ou
d'une conversion**, posé après le dernier secteur scellé, puis matérialisé par une barrière.

**Le problème qu'elle ferme.** L'en-tête est écrit et flushé AVANT que le volume ne soit scellé — il
faut connaître la disposition pour savoir où écrire les sceaux. Entre les deux s'ouvre une fenêtre
qui dure le temps de sceller tout le volume (**87,6 s mesurées pour 512 Mio**), et une coupure qui y
tombe laisse un fichier ayant l'exacte apparence d'un volume. Sans la marque, ce fichier se
présenterait comme ouvrable et rendrait un refus de sceau au premier secteur lu — envoyant
l'exploitant restaurer la sauvegarde d'un volume qui n'a jamais servi.

**Huit octets d'un motif, et non un bit.** Un bit, ou un octet non nul, serait posé par accident :
une page jamais écrite que le support rend en `0xff`, un octet retourné, un reliquat d'un autre
format suffiraient à faire passer un volume inachevé pour un volume complet — et c'est exactement
l'état qu'on veut interdire. Épreuve : `tests/unit/vm-volume-neuf-incomplet.test.mjs` › « la marque
est un MOTIF, pas un bit : des octets quelconques ne la fabriquent pas ».

**Elle n'est pas authentifiée**, comme le reste de l'en-tête. Ce qu'elle protège est une erreur
d'exploitation, pas un adversaire.

**Un volume v3 sans cette marque est refusé** par `VAULT_STORAGE_VOLUME_INCOMPLET`, dont le message
nomme le seul remède vrai : supprimer et recréer. Épreuves :
`tests/unit/vm-volume-neuf-incomplet.test.mjs` › « un volume dont le scellement initial n'a pas
abouti est REFUSÉ à la réouverture » et `tests/unit/vm-volume-neuf-incomplet.test.mjs` › « la marque
de scellement complet n'est posée qu'APRÈS le dernier secteur ».

**« Supprimer et recréer », outillé.** `removeOpfsVolume(name)` (`src/vm/opfs-sync-access.mjs`)
retire le volume ET ses voisins — journal de génération (`.gen`), témoin de séquence (`.temoin`),
enveloppe de clé (`.cles`), instantané de reprise (`.instantane`) — pour que le nom redevienne
disponible sans rien laisser derrière lui. La NAISSANCE d'un volume du même nom retire elle-même ces
orphelins, à l'exception de l'enveloppe de clé (§ 6.9), pour l'exploitant qui a retiré le seul
fichier de volume à la main : voir § 6.9 et § 9.6, constat
[#145](https://github.com/pinfada/railsbox-vault/issues/145).

**Pourquoi un tel volume n'est PAS rescellé automatiquement**, alors que ce serait sans perte : la
marque vit dans l'en-tête, qui n'est pas authentifié. Un rescellement automatique donnerait à
quiconque peut effacer huit octets le moyen de faire écraser tout le volume par des zéros scellés —
c'est-à-dire de le détruire par un geste que rien ne distingue d'une réparation. Le refus, lui, ne
laisse à cet adversaire qu'un déni de service qu'il avait déjà.

### 6.4 Le sceau de 34 octets

```text
  nonce 12 o  ‖  étiquette 16 o  ‖  génération 6 o, PETIT-BOUTISTE   =  34 octets
```

**Une seule forme pour deux endroits** : la région d'authentification du volume **et** le sceau d'un
enregistrement de journal. Une seule fonction d'encodage, une seule de décodage, un seul jeu
d'épreuves — deux encodages du même objet finissent toujours par diverger. Épreuve :
`tests/unit/vm-volume-chiffre-format.test.mjs` › « un sceau fait 34 octets : nonce 12, étiquette 16,
génération 6 ».

**Pourquoi la génération est stockée.** Un secteur du volume est lu **isolément** : le lecteur
connaît son adresse et rien d'autre. Comme les données associées portent la génération, il faut la
lui donner — six octets, la largeur du champ. Le **rang**, lui, est épinglé à zéro par le format :
un secteur ne porte qu'une version par génération, le rang n'y ajoute rien, et le fixer évite cinq
octets de plus.

**Un sceau entièrement à zéro se décode comme n'importe quel autre, et c'est délibéré.** Le
distinguer rendrait un secteur zéroté « vierge » plutôt que « refusé » — précisément l'attaque que
la § 6.5 ferme. C'est l'étiquette qui refuse, jamais le décodeur. Épreuve :
`tests/unit/vm-volume-chiffre-format.test.mjs` › « un sceau ENTIÈREMENT À ZÉRO se décode, et c'est
délibéré ».

**Un enregistrement de région peut CHEVAUCHER deux secteurs du support** : 34 ne divise pas 512. Une
déchirure sur la frontière abîme le sceau, et le secteur correspondant est **refusé** à la lecture
suivante. Ce n'est pas un affaiblissement : le secteur de charge et son sceau sont de toute façon
deux écritures distinctes qu'aucune atomicité ne lie. Ce que le format promet ici est un **refus**,
pas une lecture. Épreuve : `tests/unit/vm-volume-chiffre.test.mjs` › « un sceau À CHEVAL sur deux
secteurs du support, à moitié écrit, est refusé ».

### 6.5 La charge chiffrée, et l'absence de secteur vierge

La charge porte, pour chaque secteur logique, les 512 octets de son chiffré — sans étiquette, qui
vit dans la région. Le chiffré d'AES-GCM a exactement la longueur du clair.

**Un secteur « jamais écrit » ne peut pas exister en v3.** Si la région était à zéro pour un secteur
vierge, un adversaire n'aurait qu'à zéroter ces 34 octets pour faire lire un secteur comme blanc. La
**création** d'un volume et la **migration** scellent donc TOUS les secteurs, y compris ceux qui ne
portent que des zéros. Épreuves : `tests/unit/vm-volume-chiffre.test.mjs` › « REFUS 5 — un secteur
EN CLAIR, jamais scellé, est refusé : pas de secteur vierge en v3 » et
`tests/unit/vm-volume-chiffre.test.mjs` › « sceller un volume ENTIER ne laisse aucun secteur sans
sceau ».

**L'ordre des deux écritures d'un secteur, et pourquoi il ne change rien.** Écrire un secteur, c'est
écrire deux choses : sa charge et son sceau. Aucune atomicité ne les lie, et le format n'en suppose
aucune. La charge est écrite en premier, si bien qu'une coupure entre les deux laisse « charge
neuve, sceau ancien » — refusé. L'ordre inverse laisserait « sceau neuf, charge ancienne » — refusé
aussi. La protection contre la **perte** est ailleurs : dans le journal (§ 6.6), dont le point de
contrôle — et le rejeu de reprise (§ 6.8, § 7.3) — sont les deux gestes qui écrivent le volume, et
dont l'échec ne valide rien. Épreuve sur support réel : `tests/vm/resilience-arrets.spec.mjs` › «
sur OPFS réel, une écriture déchirée n'entame plus le volume ».

**Une lecture ne rend jamais de zéros.** Un sceau qui ne vérifie pas est un refus typé, et le
secteur n'est pas rendu du tout — ni partiellement, ni complété. Le pilote du guest interpréterait
des octets manquants comme des données valides.

### 6.6 Le journal de génération `<volume>.gen`

Une **génération** est l'ensemble des écritures comprises entre deux barrières acquittées. Elle est
déposée dans ce voisin, puis **validée** par l'écriture d'une racine.

```text
  offset 0        racine 0        1 secteur, dans une page hôte de 4 096 o
  offset 4096     racine 1        1 secteur, dans la page hôte suivante
  offset 8192     charge : les enregistrements, à la suite
```

**Les racines ALTERNENT** : la racine de séquence `s` occupe l'emplacement `s mod 2`. Une validation
interrompue ne peut donc pas détruire la racine qui fait autorité — ce qui serait la perte d'une
écriture acquittée. « Ne peut pas », et non « ne peut jamais » : la propriété repose sur une
hypothèse écrite — **deux pages hôtes distinctes ne sont pas abîmées ensemble** —, et c'est pourquoi
les deux emplacements sont séparés par une page de 4 096 octets et non par un secteur. Épreuves :
`tests/unit/vm-generation-format.test.mjs` › « les deux racines alternent, et une validation
n'écrase jamais celle qui fait autorité » et `tests/unit/vm-generation-store.test.mjs` › « la racine
alterne : une validation déchirée ne détruit pas la génération qu'elle remplace ».

**La racine qui fait autorité est celle de séquence la plus haute** parmi celles qui sont lisibles.

**L'alternance fait DEUX choses, et la seconde a longtemps été tue.** Elle protège une validation
déchirée — c'est ce qui précède — **et** elle conserve, sur le support, un **point de recul d'une
génération** : l'emplacement `(s − 1) mod 2` porte encore la racine `s − 1`, authentique et lisible.
Ce point de recul est donc à portée d'un adversaire qui n'a **rien archivé** : abîmer les 512 octets
de l'emplacement `s mod 2` suffit à faire de `s − 1` l'autorité, et les écritures acquittées de la
génération `s` disparaissent ([#144](https://github.com/pinfada/railsbox-vault/issues/144)). Les
deux faces sont vraies ensemble, et la seconde est ce qui rend le témoin décisif : c'est lui, et lui
seul, qui distingue une racine `s` déchirée par une coupure d'une racine `s` détruite pour reculer.
La règle est écrite au § 6.9, avec ses trois cas et le refus qu'elle ajoute.

#### La disposition d'un enregistrement

```text
  en-tête 16 o   ‖   sceau 34 o   ‖   chiffré L o
```

En-tête, **petit-boutiste** :

| Offset | Largeur | Champ                        |
| ------ | ------: | ---------------------------- |
| 0      |       8 | offset LOGIQUE de l'écriture |
| 8      |       4 | longueur `L` du clair        |
| 12     |       4 | réserve, à zéro              |

Le surcoût est donc **FIXE : 50 octets** par enregistrement (16 + 34), ce qui permet de dériver la
longueur physique d'une charge de ce que la racine authentifie (§ 6.7). Épreuve :
`tests/unit/vm-generation-format.test.mjs` › « le surcoût d'un enregistrement est FIXE, et la
longueur physique s'en déduit ».

L'en-tête n'est **pas authentifié** ; les mêmes champs le sont dans les données associées du sceau,
si bien qu'un en-tête falsifié conduit à un refus de sceau, jamais à un clair. Sa plausibilité
(`offset + longueur ≤ tailleVolume`) reste le premier filtre d'un parcours.

**L'identité logique d'un enregistrement est celle du § 5.1 bis**, sous l'étiquette de domaine du
JOURNAL : depuis le format 4, un enregistrement et le secteur du volume qui porte la même adresse
sous la même génération ne vivent plus dans le même espace d'identités. Le § 5.4 dit pourquoi le
rang n'y suffisait pas.

**Un journal de format 2 ou 3 est REJOUÉ une fois, sous l'ancienne étiquette.** Une charge validée
vit dans le journal jusqu'à ce qu'une ouverture la reporte dans le volume : la refuser perdrait une
écriture **acquittée**, et la lire sous la nouvelle étiquette la refuserait par « sceau refusé »,
donc par `VAULT_STORAGE_GENERATION_CORRUPT` — « restaurer une sauvegarde » — pour un volume intact.
C'est le défaut que la revue de #110 avait relevé sur le format 1
(`src/vm/generation-v1-rejeu.mjs`). Le vidage qui termine **toute** récupération écrit ensuite une
racine de format 4 : la fenêtre dure exactement une ouverture, et le rapport d'ouverture la publie
sous `journalFormatAnnonce`. Épreuves : `tests/unit/vm-journal-format-4.test.mjs` › « un journal de
format 3 portant une génération VALIDÉE est rejoué sans perte » et
`tests/unit/vm-journal-format-4.test.mjs` › « après le rejeu, l'ouverture suivante trouve un journal
de format 4 et ne rejoue rien ».

Le chemin de compatibilité n'est pas une porte : un enregistrement de format 3 dont le chiffré a
changé d'un octet reste refusé, sous le même code qu'un journal de format courant —
`tests/unit/vm-journal-format-4.test.mjs` › « un journal de format 3 ABÎMÉ rend le même refus
qu'avant, jamais un clair ».

#### Un enregistrement porte SA génération, et c'est une correction

Une charge de journal **n'appartient pas à une seule génération** : la validation incrémente la
génération et scelle une racine **sans vider le journal**, qui n'est vidé qu'au point de contrôle.
Entre deux points de contrôle, plusieurs validations se succèdent donc sur la même charge cumulée,
et la racine la plus récente scelle des enregistrements déposés sous des générations **antérieures à
la sienne**. Un lecteur qui reconstruirait les données associées à partir de la génération de la
racine échouerait sur tous les enregistrements des générations précédentes — c'est-à-dire sur le
chemin de reprise le plus courant. Épreuve : `tests/unit/vm-generation-chiffre.test.mjs` › « DEUX
validations sans point de contrôle se rejouent : l'enregistrement porte SA génération ».

C'est ce constat qui porte le surcoût d'un enregistrement de 28 à **34 octets** (§ 12, écart 1 du
tableau des coûts).

#### Les plafonds du journal

| Grandeur                                                         | Valeur | Ce qu'elle décide                                 |
| ---------------------------------------------------------------- | -----: | ------------------------------------------------- |
| Point de contrôle amorti au-delà de                              |  8 Mio | quand le journal est rangé dans le volume et vidé |
| Plafond de la charge déposée depuis le dernier point de contrôle | 16 Mio | au-delà, l'écriture est REFUSÉE, jamais acquittée |

**Ce que ce plafond borne, précisément.** `deposer` refuse quand la charge **déposée depuis le
dernier point de contrôle** dépasse ce plafond — et non la charge d'« une génération » : entre deux
points de contrôle, plusieurs validations (donc plusieurs générations) se succèdent sur la même
charge cumulée (voir plus bas), si bien que la grandeur bornée est plus grande que ce qu'une seule
génération a pu déposer. Un boot mesuré le 2026-08-27 a compté 68 écritures OPFS pour une seule
barrière. Le § 5.3 nomme correctement cette grandeur (« plafond de charge du **journal** ») ; c'est
la seule des trois occurrences du chiffre à le faire.

Un guest qui écrirait plus de 16 Mio sans franchir de barrière reçoit
`VAULT_STORAGE_GENERATION_OVERFLOW`, qui devient une erreur d'E/S ATA : un refus bruyant et typé,
jamais une promesse non tenue. Le plafond est calibré sur le budget de récupération de
`docs/quality-attributes.md` : `tests/vm/recuperation-generation.spec.mjs` › « une génération portée
au plafond est retrouvée dans le budget, sur OPFS réel ».

### 6.7 La racine, champ par champ

Un secteur, **petit-boutiste**. **210 octets** utilisés sur 512 en format 5 — 202 en format 4 ; le
reste est à zéro.

| Offset | Largeur | Champ                                     | Dans les données associées ?     |
| ------ | ------: | ----------------------------------------- | -------------------------------- |
| 0      |       8 | marqueur `VLTGEN01` (ASCII)               | non — il localise                |
| 8      |       4 | format du journal — **5** (4 sur un v3)   | non — il localise                |
| 12     |       4 | taille de secteur — **512**               | non — il localise                |
| 16     |       8 | séquence                                  | **oui**                          |
| 24     |       8 | génération                                | **oui**                          |
| 32     |       8 | taille LOGIQUE du volume                  | **oui**                          |
| 40     |       4 | nombre d'entrées                          | **oui**                          |
| 44     |       8 | longueur de charge (somme des CLAIRS)     | **oui**                          |
| 52     |      16 | identifiant de volume, seize octets bruts | voir ci-dessous                  |
| 68     |       8 | scellements cumulés du domaine `volume`   | **oui**                          |
| 76     |      12 | nonce                                     | —                                |
| 88     |      32 | chiffré : l'empreinte scellée des entrées | —                                |
| 120    |      16 | étiquette                                 | —                                |
| 136    |      66 | **fraîcheur de région** (§ 6.8)           | — (non authentifiée en PRÉSENCE) |
| 202    |       8 | scellements cumulés du domaine `journal`  | **oui** — format 5 seulement     |
| 210    |     302 | réserve, à zéro                           | —                                |

**Les 202 premiers octets sont ceux du format 4, INCHANGÉS.** Ce qui est déjà sur un support se
relit à la même place ; le second compteur s'ajoute dans la réserve que l'ADR 0016 avait nommée pour
cela. Épreuve : `tests/unit/vm-generation-format.test.mjs` › « une racine de format 5 publie DEUX
compteurs, et se relit pour ce qu'elle est ».

**Pourquoi un NUMÉRO de format de plus, alors que l'ADR 0033 range « le format 4 du journal » parmi
ce qui ne change pas.** Ce que l'ADR y range est la DISPOSITION du journal — l'emplacement des
racines, la forme d'un enregistrement, son sceau — et elle ne bouge pas d'un octet. Ce qui bouge est
la RACINE, et ce module tient une règle plus ancienne que l'ADR : **un numéro de format dit ce que
porte la racine.** Une racine à deux compteurs relue comme une racine à un seul rendrait un compteur
de journal nul sans que rien ne le signale. Laisser les deux sous le numéro 4 aurait fait deux
racines différentes sous un seul nom. L'ADR 0033 reçoit sa note datée sur ce point, et l'ADR 0035
l'écrit.

**Ce champ reste NON AUTHENTIFIÉ, et deux choses l'empêchent de mentir en silence.** D'abord la
COHÉRENCE, miroir de la garde que #19 avait posée sur la fraîcheur : une racine qui se dit à un seul
compteur au-dessus d'octets non nuls à l'offset 202 est refusée — c'est exactement ce que produit un
bit retourné qui fait passer 5 pour 4. Ensuite, et surtout, les DONNÉES ASSOCIÉES : leur nombre de
champs suit la version du VOLUME, qui est authentifiée (§ 5.2). Le retournement inverse — 4 vers 5 —
n'est refusé par aucune garde, et il n'a pas à l'être : il ne déplace ni l'étiquette de domaine des
enregistrements ni le nombre de champs scellés, donc il ne change RIEN de ce que le lecteur fait.
C'est mesuré plutôt qu'affirmé : `tests/unit/vm-generation-format.test.mjs` › « un format RETOURNÉ
vers un format connu ne change RIEN de ce que le lecteur fait » et › « une racine de format 4 dont
la place du second compteur n'est pas nulle est refusée ».

**Le CRC-32 de l'ancien format a disparu**, remplacé par l'étiquette : elle refuse ce qu'un CRC
détectait (déchirure, octet retourné) **plus** ce contre quoi il ne prétendait rien — un altérateur
volontaire, qui recalculait un CRC sans difficulté. Épreuves :
`tests/unit/vm-generation-chiffre.test.mjs` › « le format du journal passe à 4, et sa racine occupe
toujours 202 octets » et `tests/unit/vm-generation-chiffre.test.mjs` › « la racine v3 ne porte plus
de CRC-32 : l'étiquette a pris sa place ».

**L'identifiant de volume de la racine est le seul champ dont la colonne se lit de travers.**
L'identité qui entre RÉELLEMENT dans les données associées est celle que le **manifeste** déclare et
que l'ouvreur porte, pas celle qu'on lit sur le disque : retourner la copie sur disque ne change
donc pas l'étiquette. Elle n'est pas crue pour autant — elle est **confrontée** à l'identité de
l'ouvreur, et l'écart est refusé par `VAULT_STORAGE_IDENTITE_VOLUME` avant tout parcours. Cela
distingue « ce journal appartient à un autre volume » de « ce journal est abîmé », deux états dont
les remèdes n'ont rien de commun. La copie sur disque est un **localisateur, pas une autorité**.
Épreuves : `tests/unit/vm-generation-format.test.mjs` › « un octet retourné dans un champ de
LOCALISATION est refusé SANS clé » et `tests/unit/vm-generation-format.test.mjs` › « un octet
retourné dans un champ AUTHENTIFIÉ se décode encore, et c'est l'étiquette qui refuse ».

**La longueur PHYSIQUE de la charge n'est pas stockée**, elle se déduit :

```text
  longueurPhysique = longueurCharge + nombreEntrees × 50
```

Deux grandeurs stockées peuvent diverger ; une grandeur dérivée ne le peut pas.

**Le format du journal fait barrière de version.** Ce runtime **lit** les formats 2, 3, 4 et 5.

**Ce qu'il ÉCRIT dépend de DEUX conditions, et les deux doivent être dites** : la version du VOLUME,
et la source de fraîcheur que la session tient. Un volume v4 écrit le format **5** — sa racine
publie les deux compteurs. Un volume v3 qui tient une source de fraîcheur écrit le format **4** ;
sans source, il écrit le format **2**, c'est-à-dire le journal de #18, et scelle donc ses
enregistrements sous l'étiquette de domaine d'un **bloc du volume**. Une phrase antérieure de ce
document disait « n'écrit que le 4 » sans réserve ; une revue l'a réfutée en une commande, et la
borne réelle n'est pas temporelle mais **conditionnelle**.

**Un volume v4 SANS source de fraîcheur est REFUSÉ, et non dégradé en format 2** : ses données
associées comptent onze champs, et une racine de format 2 n'a pas de place pour le second compteur.
La combinaison n'a aucun encodage possible, et l'écrire produirait une racine que personne ne
pourrait relire. Épreuve : `tests/unit/vm-generation-format.test.mjs` › « un volume v4 sans source
de fraîcheur ne peut pas écrire de racine, et le dit ».

**Aucun chemin du produit n'ouvre sans source.** `openOpfsVolume` en fournit toujours une ; les
seuls appelants qui déclarent l'absence sont deux **bancs de mesure**, qui chronomètrent une
récupération et ne rouvrent jamais ce qu'ils écrivent. Cela ne se lit pas, cela se mesure :
`tests/unit/harnais-portes.test.mjs` › « aucun OUVREUR SANS FRAÎCHEUR n'est un module de src/ »
tient la liste des franchissements et refuse tout module du chemin de production, et
`tests/unit/vm-journal-format-4.test.mjs` › « l'OUVREUR DU PRODUIT écrit un journal de format 4, et
ses enregistrements ne sont pas des blocs » épingle le résultat par le chemin d'ouverture réel.

Un runtime plus ancien refuse une racine de format 4 : il ouvrirait les enregistrements sous
l'étiquette de domaine du VOLUME (§ 5.4), et un runtime d'avant le format 3 ne confronterait pas non
plus la région. **Ce qu'il refuse EXACTEMENT n'est pas ce que ce document a longtemps annoncé**, et
il vaut mieux décrire ce qu'un exploitant lit que ce qu'un module lève : le refus « Format de
journal de génération inconnu : 4 » est produit par le décodeur, mais il est **agrégé** avant
d'atteindre la surface — la racine illisible est comptée parmi les racines abîmées, et l'exploitant
reçoit `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` (« ce qui a été validé est INCONNU… restaurer une
sauvegarde »), ou `VAULT_STORAGE_GENERATION_CORRUPT` par le témoin lorsqu'il y en a un. **Le refus
est typé, il précède toute écriture, et aucune génération validée n'est écartée en silence** — c'est
la propriété qui compte, et elle tient. Mais le diagnostic est faux dans ce cas précis : le volume
est intact, et le remède exact — mettre à jour le runtime — n'est nommé nulle part. C'est écrit ici
plutôt que corrigé dans le code : distinguer « racine illisible » de « racine d'un format plus
récent » touche `remedeSansRacine`, donc la conduite d'une récupération, et cela ne se décide pas
dans une correction d'identité logique. Épreuve : `tests/unit/vm-generation-format.test.mjs` › « le
format du journal vaut 4 : un runtime antérieur refuse cette racine sans la comprendre ».

**Un numéro de format dit DEUX choses ensemble** : ce que porte la racine, et sous quelle étiquette
de domaine les enregistrements de sa charge sont scellés. **2** = pas d'empreinte de région,
enregistrements sous l'identité d'un bloc (ce qu'écrivait #18, et ce qu'écrit une session sans
source) ; **3** = empreinte de région, enregistrements sous l'identité d'un bloc (#19) ; **4** =
empreinte de région, enregistrements sous leur propre identité (#143). Les découpler aurait demandé
un champ de plus dans la racine pour un état qu'aucun volume de production n'atteint.

**Les formats 3 et 4 ont EXACTEMENT la même disposition**, et il faut dire ce que cela laisse : le
champ de format n'est pas authentifié, et aucune garde de cohérence ne peut les distinguer comme
celle qui distingue 2 de 3 (§ 6.8). Le retourner fait ouvrir les enregistrements sous l'autre
étiquette, qui ne vérifie pas : le résultat est un **refus**, jamais un clair, et sur une racine
VIDE — l'état d'un journal au repos — il ne change rien, puisque aucun enregistrement n'est ouvert.
Ce qui interdit de rejouer un vrai journal de format 3 à côté d'un volume plus récent reste ce qui
l'interdisait déjà : le plancher de séquence du témoin (§ 6.9) et l'empreinte de région que sa
racine scelle (§ 6.8). Épreuve : `tests/unit/vm-journal-format-4.test.mjs` › « un journal de format
3 dont le NUMÉRO est retourné en 4 est refusé, jamais ouvert de travers ».

**Une racine VIDE est authentifiée comme les autres, et c'est ce qui la rend sûre.** Elle n'a aucune
charge à confronter, et **elle fixe à elle seule la génération et la séquence** de la session à
venir — c'est l'état que laisse tout point de contrôle, donc l'état le plus fréquent d'un journal au
repos. Un journal dont la racine vide serait forgée avec une séquence plus haute ferait autorité, et
la génération réellement validée serait écartée comme « dépassée » : une écriture acquittée perdue
sans qu'aucun code ne mente. Le parcours est donc exécuté même pour une charge de zéro entrée.
Épreuve : `tests/unit/vm-generation-chiffre.test.mjs` › « une racine VIDE est authentifiée elle
aussi : c'est elle qui fixe la génération ».

### 6.8 La fraîcheur : la racine date la région d'authentification

**Le défaut que cela ferme.** Un secteur du volume est ouvert sous une identité que le lecteur ne
connaît pas d'avance : il lit sa **génération** dans la région, juste à côté du nonce et de
l'étiquette du même secteur. Le sceau et l'identité viennent donc **du même endroit**. Un adversaire
qui remet en place le **quadruplet complet** d'une version antérieure du même secteur — chiffré,
nonce, étiquette, génération — produit un ensemble cohérent, et un lecteur qui ne regarderait que ce
secteur l'accepterait. Le tirage du nonce n'y change rien : il garantit l'unicité, pas la fraîcheur
; un sceau authentique d'hier reste authentique aujourd'hui.

**La parade : sceller AILLEURS une empreinte de la région entière.** « Ailleurs » veut dire : dans
la racine de génération, dont l'autorité vient du journal et pas du volume. **Entière** veut dire :
l'empreinte SHA-256 des `R × 512` octets de la région alignée (§ 6.1), **rembourrage compris** — le
rembourrage entre bien dans l'empreinte, ce que la seule lecture du § 4.3 et du présent paragraphe
ne tranchait pas.

Les 66 octets à l'offset 136 de la racine :

```text
  sceau 34 o  (nonce 12 ‖ étiquette 16 ‖ génération 6, petit-boutiste)
  chiffré 32 o  — l'empreinte SHA-256 de la région, scellée
```

L'identité logique de cet objet est le **rang réservé `2^40 − 1`**, adresse 0, longueur 32, sous
l'identifiant de volume et la version de format de la session.

**Elle est RESCELLÉE à chaque écriture de racine, sous la génération de CETTE racine.** Sans cela,
une empreinte authentique mais scellée sous une génération antérieure pourrait être épissée dans une
racine récente, et la région d'hier passerait pour celle d'aujourd'hui. La confrontation présente
donc `generationMinimale = generation de la racine porteuse`, et le refus est un rejeu **établi**.

**Elle n'est REHACHÉE que si le volume a été écrit** depuis la dernière. **Deux gestes écrivent le
volume : le rejeu de reprise et le point de contrôle** ; les deux marquent la région salie
(`marquerRegionSale`). Les racines intermédiaires — celles où aucun des deux gestes n'a eu lieu
depuis la dernière — rescellent l'empreinte tenue en cache — un chiffrement de 32 octets, pas un
hachage de 34 Mio. La marque « région salie » est levée **avant** l'attente du hachage et jamais
après : un point de contrôle peut écrire pendant le hachage, et lever la marque après aurait scellé
l'état d'avant. Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « une région salie PENDANT
le hachage n'est pas oubliée ».

**À l'ouverture, la région relue est confrontée à cette empreinte AVANT toute lecture de secteur.**
Un volume dont la région ne concorde plus ne rend aucun clair, fût-il authentique. Épreuve :
`tests/unit/vm-generation-fraicheur.test.mjs` › « un SECTEUR ramené en arrière hors journal est
refusé, alors que ce secteur reste authentique » — l'épreuve démontre les **deux moitiés** du fait :
le secteur remis en place reste authentique, et l'ouverture transactionnelle le refuse tout de même.
Voir aussi `tests/unit/vm-generation-fraicheur.test.mjs` › « une RÉGION qui change sous une racine
inchangée est refusée, empreinte à l'appui ».

**Ce que la présence de l'empreinte n'établit pas, et qui est le prix payé.** L'empreinte n'est pas
dans les DONNÉES ASSOCIÉES de la racine : y ajouter un champ aurait imposé une version de
spécification cryptographique et invalidé les vecteurs figés de l'ADR 0015. Seule sa **valeur** est
authentique ; sa **présence** ne l'est pas. Ce qui RÉDUIT ce reste — il n'est pas fermé, seulement
réduit — est le témoin (§ 6.9) et une garde de cohérence : une racine qui se déclare de format 2
au-dessus d'octets de fraîcheur non nuls est refusée — un des deux ment. **Le cas symétrique est
couvert aussi, et sans ambiguïté** : une racine de format 3 porte TOUJOURS une fraîcheur ; le
décodeur ne rend `fraicheur = null` que pour un format 2, jamais pour un format 3, si bien que des
octets de fraîcheur nuls sous un format 3 ne se lisent jamais comme une absence — ce sont un sceau
qui ne vérifie pas, donc un refus à la confrontation (`ouvrirBloc` refuse un sceau de zéros), jamais
un repli sur « aucune empreinte scellée ». C'est une garde, pas une authentification, et la nuance
est écrite plutôt que gommée.

**Coût mesuré.** Empreinte d'une région de 34 Mio sur OPFS réel : p50 de **344,8 et 354,1 ms**, p95
de 350,2 et 383,3 ms sur deux exécutions de trois relevés, soit **0,58 % et 0,64 %** du budget de
reprise de 60 s. Le seuil épinglé par l'épreuve est **un pour cent** de ce budget, et c'est un
**engagement**, pas une observation : `tests/vm/fraicheur-region-cout.spec.mjs` › « l'empreinte de
région d'un volume de 512 Mio reste sous le pour-cent du budget de reprise ». Ce que la mesure ne
borne pas : la **fréquence**. Une session paie une empreinte à l'ouverture et une par point de
contrôle ; rien n'interdit qu'une application en paie beaucoup, et personne ne l'a mesuré.

**Compatibilité : lire deux formats, n'écrire que le plus récent.** Un volume scellé avant l'ADR
0019 porte une racine de format 2, sans empreinte. Ce runtime la décode, la rend explicitement comme
« aucune empreinte scellée » — jamais comme une empreinte de zéros, qui serait une empreinte comme
une autre — et ne prétend **aucune** fraîcheur pour cette ouverture-là ; le rapport d'ouverture
publie l'état `migree`. La fenêtre dure **exactement une ouverture** : toute récupération se termine
par un vidage, qui écrit une racine neuve, donc de format 3. Épreuve :
`tests/unit/vm-generation-fraicheur.test.mjs` › « un volume scellé par #18 reste OUVRABLE, et migre
à la première racine écrite ». Pendant cette unique ouverture, un secteur ramené en arrière n'est
pas détecté ; l'état est celui d'avant l'ADR 0019, ni meilleur ni pire, et il ne se reproduit pas.

Les quatre états que le rapport d'ouverture publie — un contrôle qu'on ne publie pas finit par être
supposé actif :

| État          | Ce qu'il dit                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `non-fournie` | le magasin n'a reçu aucune source de région : aucune fraîcheur n'est prétendue  |
| `sans-racine` | aucune racine ne faisait autorité : il n'y avait rien à confronter              |
| `migree`      | la racine trouvée est d'avant l'ADR 0019 ; la prochaine portera l'empreinte     |
| `verifiee`    | la région relue concorde avec l'empreinte que la dernière racine validée scelle |

Le rapport publie aussi `journalFormatAnnonce` : le format que la racine trouvée **déclare** à
l'ouverture, avant que le vidage n'écrive une racine neuve, ou `null` si aucune racine ne faisait
autorité.

**Son nom porte sa réserve, et c'est une correction.** Ce champ s'appelait `journalFormat` et ce
document lui donnait un sens d'exploitation — « il dit d'un volume s'il a franchi le format 4 ». Il
est lu à l'offset 8 de la racine, qui **n'est pas authentifié** (§ 6.7) : un adversaire le choisit,
dans les deux sens. Une revue l'a montré sur un journal AU REPOS, entièrement migré, dont le champ
retourné 4 → 3 fait publier « format 3 » à une ouverture dont la fraîcheur est par ailleurs
`verifiee`. La doctrine de ce dépôt étant qu'« un contrôle qu'on ne publie pas finit par être
supposé actif », un contrôle publié dont la valeur est choisie par l'adversaire mérite la même
franchise : le champ vaut comme état de migration **sur un journal que rien n'a touché**, et pas
au-delà.

Ce qui est ÉTABLI, en revanche, est ce que la récupération a fait : une charge non vide rejouée sous
l'ancienne étiquette de domaine ne s'ouvre que si ses enregistrements y étaient réellement scellés
(§ 6.6). Le retournement du champ sur une charge non vide est donc un **refus**, jamais un clair —
dans les deux sens, et les deux sont éprouvés : `tests/unit/vm-journal-format-4.test.mjs` › « un
journal de format 3 dont le NUMÉRO est retourné en 4 est refusé, jamais ouvert de travers » et
`tests/unit/vm-journal-format-4.test.mjs` › « un journal de format 4 dont le NUMÉRO est retourné en
3 est refusé : c'est le sens qu'un volume de production rencontre ». Sur une racine VIDE, aucun
enregistrement n'est ouvert et le retournement ne change que ce que le rapport annonce :
`tests/unit/vm-journal-format-4.test.mjs` › « sur une racine VIDE, le format retourné ne change que
ce qui est ANNONCÉ ».

### 6.9 Le témoin `<volume>.temoin`

Soixante octets, **petit-boutiste**.

| Offset | Largeur | Champ                               |
| ------ | ------: | ----------------------------------- |
| 0      |       8 | marqueur `VLTTEM01` (ASCII)         |
| 8      |       4 | version du format de témoin — **1** |
| 12     |       4 | réserve, à zéro                     |
| 16     |      12 | nonce                               |
| 28     |      16 | étiquette                           |
| 44     |      16 | chiffré                             |

Le **clair** de seize octets, scellé sous le rang réservé `2^40 − 2`, génération 0, adresse 0 :

| Offset | Largeur | Champ                                                 |
| ------ | ------: | ----------------------------------------------------- |
| 0      |       8 | dernière séquence vue                                 |
| 8      |       6 | génération de cette séquence                          |
| 14     |       1 | la racine correspondante portait-elle une empreinte ? |
| 15     |       1 | réserve, à zéro                                       |

**Le champ « génération » n'oppose aucun plancher : il est écrit pour le DIAGNOSTIC, pas comme
contrôle.** Contrairement à la séquence, dont l'ouvreur retient la valeur pour la présenter comme
plancher à chaque vérification de racine (§ 7.3), aucun chemin de production ne relit ce champ. Un
relecteur qui le suppose symétrique de la séquence — un plancher de génération — bâtirait sur une
propriété que le format n'offre pas ; le champ existe déjà, et lui faire opposer un plancher serait
un durcissement réel, pas un ajout de format.

**Il est écrit APRÈS la racine et sa barrière, jamais avant. L'ordre est le contrat.** Une coupure
entre les deux laisse un témoin **en retard** : un plancher en retard sous-détecte, il ne refuse
jamais à tort. L'ordre inverse laisserait un témoin **en avance**, c'est-à-dire un volume intact
refusé. Épreuve sur support réel, coupant dans cette fenêtre exacte :
`tests/vm/resilience-fraicheur.spec.mjs` › « une coupure ENTRE la racine et le témoin laisse un
témoin en retard, jamais un refus ».

**Il est retiré avec le volume**, et aussi par tout geste qui RÉÉCRIT le volume entier : la
restauration et la migration. Un témoin survivant attesterait, pour un volume réécrit depuis une
archive, une séquence que celui-ci n'a jamais atteinte : la prochaine ouverture refuserait un volume
sain, et le message désignerait un retour arrière qui n'a pas eu lieu. La règle est donc écrite
plutôt que laissée à la vigilance — **un témoin ne date que le volume qu'il accompagne**.

**Deux cas distincts, et un seul de retrait outillé côté naissance (#145).** Un témoin survivant à
côté d'un fichier de volume ABSENT n'est pas un cas de recul : **un témoin sans volume ne date
rien**, puisque le volume qu'il décrivait n'existe plus. C'est le cas de l'exploitant qui a supprimé
le seul fichier de volume, à la main, sans passer par `removeOpfsVolume` (§ 6.3, § 10.2) : la
NAISSANCE du volume homonyme qui suit retire elle-même ce témoin orphelin, avant même que la
récupération de sa génération ne le lise, et ce retrait ne désarme rien — la détection du recul
porte sur un volume PRÉSENT, pas sur un volume qui vient de naître. Un témoin survivant à côté d'un
fichier de volume PRÉSENT, en revanche, reste un écart de séquence réel : c'est ce volume-là qui a
reculé, et retirer le témoin effacerait la seule trace qui en reste — voir « le geste qui en sort »
plus bas.

**Absent = première ouverture, jamais une preuve.** C'est le point où la nuance se perd le plus
facilement.

**Ce que le scellement du témoin achète, exactement — et ce qu'il n'achète pas.** Le sceau refuse un
témoin dont la séquence n'a **jamais été atteinte par ce volume sous cette clé** : c'est la
**forgerie**, et elle est fermée. Il ne rend pas le témoin **monotone**, et il ne le rend pas non
plus **unique** : la séquence vit dans le clair et les données associées sont **constantes pour un
volume donné** (rang `2^40 − 2`, génération 0, adresse 0, longueur 16), si bien que deux témoins
successifs du même volume sont **aussi authentiques l'un que l'autre**. Un témoin qui a été
légitimement écrit peut donc être **REJOUÉ**, et il fabrique alors un **refus permanent d'un volume
sain**. La formulation antérieure — « cela évite seulement qu'un tiers sans clé fabrique un refus
permanent » — confondait forgerie et rejeu ;
[#142](https://github.com/pinfada/railsbox-vault/issues/142) l'a relevé, et la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153) la corrige ici.

Le chemin est celui qu'une **restauration d'archive** ouvre : `discardGeneration` retire le journal
**et** le témoin, et l'archive porte le fichier v3 tel quel — donc le même identifiant de volume et
la même clé (§ 7.5). Qui peut écrire dans l'OPFS de l'origine n'a qu'à conserver une copie du témoin
et la **remettre** après la restauration : l'ouverture suivante ne trouve aucune racine sous un
témoin présent, et refuse (`VAULT_STORAGE_GENERATION_CORRUPT`, cause `VAULT_TEMOIN_SEQUENCE`).

**Le geste qui en sort, et sa CONDITION — les deux, jamais l'un sans l'autre.** Après une
restauration d'archive **délibérée**, un témoin présent ne peut être qu'une copie réinstallée : le
**retirer** rouvre le volume en première ouverture, sans perdre un octet. **Sans restauration, ne
pas le retirer** : c'est le volume qui a reculé, et retirer le témoin effacerait la seule trace qui
en reste. Un message qui enseignerait « retirer le témoin » sans sa condition désarmerait la
détection du recul réel ; celui de ce refus porte les deux lectures et la condition. Épreuve :
`tests/unit/vm-recul-generation.test.mjs` › « un témoin REJOUÉ après une restauration nomme les DEUX
lectures et le geste CONDITIONNEL ».

Ce que le rejeu **n'obtient pas** reste vrai : aucun clair, aucune forgerie, aucun octet perdu sur
le volume. Et la capacité qu'il exige — écrire dans l'OPFS de l'origine — permet déjà de détruire le
volume lui-même : le témoin n'a jamais défendu contre cet adversaire, et ce même paragraphe dit plus
bas que le neutraliser est gratuit. Ce qui **fermerait** le rejeu est une **ancre monotone hors du
support** (§ 9.1, § 13 question n° 3) ; elle n'existe pas, et rien ici ne la remplace.

**Deux refus que le témoin ajoute, et qui n'existaient pas :**

- un journal **sans aucune racine** sous un témoin présent. Le témoin ne s'écrit qu'après une racine
  et sa barrière : son existence prouve qu'une racine a été durable, et son absence du journal est
  un recul, pas un volume neuf. Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « un
  journal SANS racine sous un témoin présent est refusé : c'est un recul, pas un volume neuf » ;
- une racine **sans empreinte** sous un témoin qui en atteste une. Une propriété acquise ne se
  reperd pas ; cet état décrit un retour à une racine d'avant la fraîcheur. Épreuve :
  `tests/unit/vm-generation-fraicheur.test.mjs` › « une fois la fraîcheur acquise, un retour à une
  racine SANS empreinte est refusé ».

**Sa limite, sans détour, et l'effort n'est PAS symétrique.** Reculer le volume d'**une** génération
ne suppose **aucune copie antérieure** : l'alternance des racines (§ 6.6) garde `s − 1` lisible sur
le support, et le point de recul est donc dans le fichier par construction. Abîmer les 512 octets de
l'emplacement `s mod 2` suffit à le ramener là. Reculer **au-delà d'une génération** suppose, lui,
une copie antérieure de volume et de journal, cohérente : la racine `s − 2` a été écrasée par `s`.
La formulation antérieure — « reculer le volume suppose d'en détenir une copie antérieure » —
promettait donc à l'adversaire un coût qu'il n'a pas à payer ;
[#144](https://github.com/pinfada/railsbox-vault/issues/144) l'a relevé, et la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153) la corrige ici comme au § 9.1.

**Ce qui décide devant un recul d'une génération est le TÉMOIN**, et l'ordre d'écriture ci-dessus
est ce qui le permet — le témoin vient **après** la racine et sa barrière :

- **témoin concordant** avec la racine retenue (à sa séquence, ou en retard sur elle) : c'est une
  coupure pendant l'écriture de `s`, le cas normal que l'alternance existe pour absorber. Le volume
  **ouvre**, et les octets déposés au-delà de ce que la racine retenue authentifie sont écartés sous
  `VAULT_STORAGE_GENERATION_DISCARDED` (§ 10.2). Refuser ici enverrait « restaurer une sauvegarde »
  à chaque coupure au mauvais instant ;
- **témoin en avance** sur la racine retenue : c'est le recul que ce témoin ferme déjà, et le
  plancher de séquence refuse sans qu'aucune règle nouvelle soit nécessaire ;
- **témoin absent** : pour que `s − 1` soit acceptée sous un témoin à `s`, l'adversaire doit d'abord
  neutraliser le témoin — ce qui, comme dit plus bas, ne lui coûte rien. Une coupure a pu l'emporter
  aussi. **Rien ne distingue les deux**, et l'état est **REFUSÉ** :
  `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`, dont le message porte les deux lectures.

**Neutraliser le témoin ne suppose rien : le supprimer, ou simplement le tronquer, suffit — et sans
la clé.** Un fichier absent, vide ou trop court n'est pas un témoin ; l'ouverture repart sur «
première ouverture », donc sans plancher, et la fenêtre du retour arrière complet est **réarmée**
pour qui détient déjà une copie antérieure de volume + journal. Ce comportement est délibéré et ne
doit pas changer : refuser tout volume sans témoin rendrait irouvrable un volume neuf, un volume
restauré depuis une archive, ou un volume dont le témoin a été perdu par un incident de support — on
échangerait une détection qu'on n'a pas contre une perte de données qu'on aurait.

**Le refus que #144 ajoute ne contredit pas la phrase précédente, et il faut dire exactement
pourquoi.** Il ne porte que sur la **conjonction** « aucun témoin **ET** une racine abîmée **ET**
une racine retenue **portant une empreinte de région** ». **Quatre** états ne la produisent pas :

- un volume **neuf** n'a aucune racine abîmée ;
- un volume **restauré** n'a pas de `.gen` du tout, `discardGeneration` le retirant avec le témoin ;
- un **premier point de contrôle** écrit une racine et laisse l'autre emplacement vierge — et un
  secteur vierge n'est pas une racine abîmée (§ 6.6) ;
- un volume scellé **avant #19**, dont la racine ne porte aucune empreinte de région (§ 6.8). Un
  magasin d'alors n'écrivait aucun témoin : son absence ne prétend rien, elle n'a **jamais pu** être
  autrement. Exiger un témoin ici rendrait irouvrable **pour toujours** un volume que la migration
  devait ouvrir — le refus tombant avant toute écriture, le vidage ne réparerait jamais
  l'emplacement déchiré. La fenêtre dure **exactement une ouverture**, et la porte qu'elle pourrait
  laisser reste gardée par un contrôle qui ne bouge pas : une racine sans empreinte **sous un témoin
  qui en atteste une** est refusée. Ce quatrième état a été relevé en revue. Épreuve :
  `tests/unit/vm-recul-generation.test.mjs` › « un volume scellé par #18, dont une racine est
  déchirée, reste OUVRABLE : il n'a jamais pu avoir de témoin ».

Un volume dont le témoin a été perdu par un incident de support rouvre donc comme avant, **sauf** si
une racine est abîmée en même temps — et dans ce cas précis, ce qui a été validé est réellement
inconnu.

**Ce que ce refus SUR-DÉTECTE, et pourquoi rien ne le corrige.** Le compte des racines abîmées
**compte**, il ne **situe** pas : une racine illisible n'a plus de séquence lisible, et prétendre la
situer reviendrait à croire un en-tête que rien n'authentifie. Abîmer la racine la plus **ancienne**
— celle qui ne fait pas autorité, dont la perte ne coûte rien — produit donc le même refus, alors
que rien n'a reculé. Le message nomme les **deux** lectures que cela laisse — la racine abîmée
portait la séquence d'avant celle retenue (une avarie sans conséquence, typiquement une coupure
pendant sa propre écriture), ou celle d'après (et le volume a reculé) — plutôt que d'en inventer une
troisième. C'est le prix de la règle, relevé en revue, et il est éprouvé :
`tests/unit/vm-recul-generation.test.mjs` › « la racine ABÎMÉE n'est pas située : abîmer l'ancienne
refuse comme abîmer la récente, et c'est le prix ».

**Ce que ce refus NE ferme PAS, et c'est la limite de la règle.** Il tient contre l'adversaire qui
**neutralise** le témoin — celui-là obtient un refus, pas un recul. Il ne tient **pas** contre celui
qui le **rejoue**, c'est-à-dire l'adversaire de #142, accepté dans la même correction : archiver le
témoin à `s − 1` (62 octets), abîmer la racine `s`, puis **remettre** la copie fait concorder le
témoin avec la racine retenue. L'ouverture conclut « coupure », le volume ouvre sur `s − 1`, et une
génération **acquittée** disparaît sous un rapport qui déclare la fraîcheur `verifiee` — le seul
signal étant `VAULT_STORAGE_GENERATION_DISCARDED`, qui dit « coupure normale ». Ce n'est **pas** une
course : le témoin n'est pas perdu au bon instant, il est archivé à l'avance. Épreuve :
`tests/unit/vm-recul-generation.test.mjs` › « #142 COMPOSÉ à #144 : un témoin ARCHIVÉ puis rejoué
fait perdre une génération acquittée sous « verifiee » ». Épreuves du refus lui-même :
`tests/unit/vm-recul-generation.test.mjs` › « une racine abîmée à côté d'une racine lisible, SANS
témoin, est REFUSÉE : rien ne la distingue d'un recul », « une coupure qui déchire la racine `s`
laisse le témoin à `s − 1` : le volume ROUVRE, et la mise au rebut est PUBLIÉE » et « une racine
abîmée sous un témoin EN AVANCE reste un recul : le plancher de séquence refuse ».

Ce qui manque n'est pas une garde de plus : c'est une **ancre monotone hors du support** (§ 9, § 13
question n° 3).

En revanche, un fichier qui **ressemble** à un témoin mais dont le sceau ne vérifie pas est REFUSÉ,
jamais ignoré : l'ignorer offrirait à quiconque peut écrire dans l'origine le moyen de désarmer le
contrôle en abîmant huit octets.

### 6.9 bis Le voisin `<volume>.engagement`

Ajouté le 10 septembre 2026 (#181,
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)). **Cent quatre-vingts octets,
GROS-boutistes**, et un fichier qui n'existe qu'entre une restauration et l'ouverture qui la valide
: il est CONSOMMÉ à cette ouverture, jamais relu ensuite.

| Offset | Largeur | Champ                                                      |
| ------ | ------: | ---------------------------------------------------------- |
| 0      |       8 | marqueur `VLTENG01` (ASCII)                                |
| 8      |       4 | version du fichier d'engagement — **1**                    |
| 12     |       4 | version d'ARCHIVE — **3**                                  |
| 16     |      32 | identifiant de volume, 32 hexadécimaux minuscules (ASCII)  |
| 48     |       8 | taille support                                             |
| 56     |       8 | taille logique                                             |
| 64     |       4 | taille de secteur — **512**                                |
| 68     |       4 | version de l'enveloppe embarquée — **0** s'il n'y en a pas |
| 72     |       8 | longueur du contenu                                        |
| 80     |       8 | longueur de la section de récupération                     |
| 88     |      32 | sel du domaine `archive`, TIRÉ, en clair                   |
| 120    |      12 | nonce                                                      |
| 132    |      32 | chiffré — l'empreinte du fichier, scellée                  |
| 164    |      16 | étiquette                                                  |

**Tout ce qui précède le sel est exactement ce que les données associées encodent** (§ 7.5) : le
fichier est SELF-DESCRIPTIF, et l'ouverture y reconstruit les données associées sans rien supposer.
Ses déclarations sont authentifiées par l'étiquette GCM — les modifier fait échouer l'ouverture,
jamais dériver le verdict. Le SEL, lui, n'est pas authentifié et n'a pas à l'être : un adversaire
qui le change obtient une clé différente, donc un refus.

**Il fait exactement onze caractères de suffixe, comme `.instantane`** : il ne rétrécit donc aucun
nom de volume déjà admissible. Il figure dans la liste de `removeOpfsVolume` **et** dans le balayage
d'orphelins d'une naissance, par acquit, même s'il est consommé à la première ouverture — c'est le
défaut de #145, et on ne le rouvre pas.

**Sa taille est EXACTE : cent quatre-vingts octets, ni plus, ni moins.** Un voisin d'une autre
taille est REFUSÉ par `VAULT_STORAGE_ENGAGEMENT_INVALIDE` — il est présent et illisible, ce qui
n'est pas la même chose qu'absent. C'est la règle que `assertRienEnQueue` tient déjà pour l'archive
: rien ne suit un objet de format fixe. Seul **zéro octet** vaut « absent ».

**CONSOMMÉ veut dire VIDÉ, pas supprimé** (amendé le 11 septembre 2026, revue de format de la PR
#184) : la consommation fait `truncate(0)` puis une barrière, et le fichier SURVIT à zéro octet.
Deux raisons, et la première suffit : un Worker dédié n'a pas de handle de répertoire, donc pas de
suppression d'entrée — `removeOpfsVolume` en a un, la consommation non ; et la troncature est de
toute façon le geste sûr sous coupure. Un voisin de zéro octet **est** absent pour tout ce qui le
lit, `voisinsDunVolume` le connaît toujours (donc `removeOpfsVolume` l'emporte), et le balayage des
orphelins d'une naissance ne réécrit pas un voisin déjà vide. Conséquence à dire : une ouverture
REFUSÉE par `VAULT_STORAGE_VOLUME_SANS_RACINE` laisse derrière elle un `.engagement` de zéro octet
que le volume ne portait pas — `openOpfsSyncAccess` ouvre avec `{ create: true }`, exactement comme
pour `.gen` et `.temoin`.

**Un voisin REPOSÉ alors qu'une racine fait déjà autorité est VIDÉ à cette occasion**, et
l'ouverture le PUBLIE (`voisinIgnore: true` dans le rapport). Il n'est jamais consulté sur ce chemin
— la décision 5 de l'ADR 0034 le dit — mais un reliquat qu'on laisse sans le dire finit par être cru
voulu, et un contrôle qu'on ne publie pas finit par être supposé actif.

Vecteur figé : `tests/vectors/archive-v3.json` › `engagement.voisin`.

### 6.10 Le manifeste v3

Le manifeste est un voisin **JSON, ni chiffré ni authentifié**. Ce que la v3 y ajoute et rend
obligatoire :

| Champ              | Valeur                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `formatVersion`    | **3**                                                                                                            |
| `volume.id`        | l'identifiant **opaque, aléatoire, immuable**, inscrit à la création — **exactement 32 hexadécimaux minuscules** |
| `volume.algorithm` | `aes-256-gcm`, **seul admis**                                                                                    |

Une forme approchante de `volume.id` donnerait une autre chaîne dans les données associées, donc un
autre volume : elle est refusée, jamais normalisée. Un `volume.algorithm` autre est refusé par
`VAULT_MANIFEST_MALFORMED`.

**Les bornes de version, et ce qu'elles couvrent EXACTEMENT** : `MIN_READABLE_FORMAT_VERSION` vaut 1
et porte sur le **manifeste**, c'est tout ce qu'il a jamais porté. **Le manifeste d'un v1 ou d'un v2
se lit ; leur FICHIER ne s'ouvre pas** — il n'a ni région d'authentification ni nonce, si bien qu'un
runtime v3 n'a nulle part où écrire le sceau d'un secteur. Ce n'est pas un refus de politesse, c'est
une absence de place. Un runtime plus ancien qui rencontre `formatVersion: 3` le refuse par
`VAULT_MANIFEST_FORMAT_TOO_NEW`, ce qui empêche un runtime v2 d'écrire en clair dans un volume
chiffré. Épreuve : `tests/unit/vm-volume-manifest.test.mjs` › « un format FUTUR inconnu est refusé
en lecture comme en écriture ».

**Le manifeste est ce qui rend l'identité OPPOSABLE.** L'ouvreur le lit, confronte son `volume.id` à
celui de l'en-tête du fichier, et refuse l'écart avant toute lecture. Un volume sans manifeste
identifiable n'est jamais ouvert en écriture : `tests/unit/vm-opfs-volume-open.test.mjs` › « un
volume sans manifeste voisin n'est JAMAIS ouvert en écriture ».

**Portée exacte du contrôle, et ce qui n'est pas garanti par le code.** L'ouvreur unique est une
**discipline de revue**, pas une contrainte de l'outillage : l'ouverture de bas niveau reste
appelable directement, et plusieurs sites de production le font. Rien n'empêche un nouveau chemin
d'en ajouter un sans passer par l'ouvreur. C'est écrit ici parce qu'un relecteur le découvrirait
sinon en lisant le code.

### 6.11 La page d'enveloppe `<volume>.cles`, version 2

Le fichier d'enveloppes est spécifié par l'[ADR 0020](decisions/0020-enveloppe-de-cle.md) : deux
pages de 8 192 octets, alternées, dont la plus récente valide fait autorité. **La version 2 de la
PAGE** ([#182](https://github.com/pinfada/railsbox-vault/issues/182), ADR 0036) ne change ni le
fichier, ni l'alternance, ni la liste des emplacements. Elle change une seule chose : **sous quelle
clé la racine de la page est scellée.**

|        Offset | Largeur | Champ                                                      | v1                 | v2             |
| ------------: | ------: | ---------------------------------------------------------- | ------------------ | -------------- |
|             0 |       8 | marqueur `VLTKEY01`                                        | identique          | identique      |
|             8 |       4 | version de format de la PAGE                               | 1                  | **2**          |
|            12 |       2 | nombre d'emplacements                                      | identique          | identique      |
|        **14** |   **1** | **domaine de la racine** — 1 `enveloppe`, 2 `recuperation` | remplissage à zéro | **champ**      |
|            16 |       8 | compteur de version de l'enveloppe                         | identique          | identique      |
|            24 |      16 | identifiant de volume                                      | identique          | identique      |
|            40 |       4 | longueur de la liste                                       | identique          | identique      |
|            44 |      12 | nonce de la racine                                         | identique          | identique      |
|            56 |      32 | chiffré de la racine                                       | identique          | identique      |
|            88 |      16 | étiquette de la racine                                     | identique          | identique      |
|       **104** |  **32** | **sel de la clé de racine**, en clair                      | absent             | **champ**      |
| 104 / **136** |       4 | somme de contrôle CRC-32                                   | offset 104         | **offset 136** |
| 108 / **140** |       — | début de la liste des emplacements                         | offset 108         | **offset 140** |

**Rien n'est DÉPLACÉ.** Le sel s'ajoute là où la v1 s'arrêtait, et la somme de contrôle recule
derrière lui ; tous les offsets antérieurs sont les mêmes à l'octet près. C'est ce qui permet au
même décodeur de relire les deux versions, et aux vecteurs figés de la v1 de ne pas bouger.

**Ce que le sel coûte à la page — MESURÉ, pas supposé.** L'ADR 0033 rangeait dans ses risques « le
sel en clair élargit quatre artefacts de 32 octets ; pour la page d'enveloppe, cela peut coûter un
emplacement dans le pire cas ». Le calcul dit non :

```text
pire cas de liste = 8 emplacements × (72 octets fixes + 512 de paramètres) = 4 672 octets
en-tête v2 + pire cas                                     = 140 + 4 672  = 4 812 octets
page                                                                      = 8 192 octets
reste                                                                     = 3 380 octets
```

Il reste de quoi porter **cinq emplacements de plus au pire tarif**. Le sel ne coûte aucun
emplacement, et il n'en coûterait un que si le plafond passait de huit à quatorze.

**L'ASSIETTE de la somme de contrôle, publiée.** Elle ne l'avait jamais été : la table donne
l'offset du champ, jamais ce qu'il couvre, et le relecteur de la PR #187 a dû la retrouver par
essais (constat 8 de la revue de format). Un vérificateur indépendant qui transcrit une règle non
publiée ne la vérifie pas — il l'invente en même temps que le produit. La voici, et elle vaut pour
les deux versions de page :

```text
somme = CRC-32( en-tête[0 … E[ , avec ses QUATRE octets de somme mis à ZÉRO
              ‖ liste des emplacements[E … E + longueurListe[ )

E = 108 en v1, 140 en v2 ; le champ de somme est à l'offset 104 en v1, 136 en v2
CRC-32 = polynôme réfléchi 0xEDB88320, registre initial 0xFFFFFFFF, complément final,
         écrit sur 4 octets PETIT-BOUTISTES comme tout entier de cette page
```

Deux choses que l'assiette n'inclut PAS, et chacune pour une raison :

- **le champ de somme lui-même**, mis à zéro pendant son propre calcul — sans quoi la valeur
  dépendrait d'elle-même ;
- **le REMPLISSAGE** qui suit la liste jusqu'aux 8 192 octets. Il est à zéro par construction (§
  6.11, « une page réécrite laisserait sinon voir la queue de la précédente »), et l'y inclure
  ferait dépendre la somme de huit kilo-octets pour rien. Le corollaire est écrit plutôt que laissé
  à trouver : **la somme ne couvre pas le remplissage**, donc un adversaire qui y écrirait sans
  toucher au reste ne serait pas détecté par elle — il le serait par la RACINE, qui authentifie la
  liste et son compte.

Ce que l'assiette couvre, en revanche, mérite d'être dit puisque le § 4.4 précise que ces champs ne
sont pas authentifiés : **le SEL et l'octet de DOMAINE entrent dans la somme**, puisqu'ils sont dans
l'en-tête. Un bit changé sur l'un ou l'autre rend donc la page structurellement invalide AVANT que
l'étiquette de la racine n'échoue. Cela ne les rend pas authentiques — qui écrit dans l'origine de
confiance recalcule une somme sans effort —, cela les rend insensibles à l'accident, comme le reste
de la page.

`node tools/verifier-vecteurs.mjs` REFAIT cette somme depuis le seul texte ci-dessus, sans importer
une ligne du produit.

**La clé de la racine.** En v1, c'était la clé de volume elle-même. En v2, c'est une clé à USAGE
UNIQUE dérivée par HKDF-SHA-256 pour un domaine, un volume et la version 2 de la page (§ 4.4) :

- **`enveloppe`** — la page de `<volume>.cles`, celle qui reste sur l'appareil ;
- **`recuperation`** — la page qu'une ARCHIVE emporte, rescellée à l'export sur la liste filtrée
  ([ADR 0027](decisions/0027-archive-et-ancre-de-version.md)).

Deux domaines, deux infos, deux clés — **pour le même volume et la même version de format**. La
séparation est utile et il faut dire de quoi : une archive VOYAGE. La clé qui scelle sa page ne
scelle rien qui soit resté sur la machine.

**La page DIT lequel des deux a scellé sa racine**, dans l'octet 14, et c'est une nécessité de
lecture : la restauration pose la page embarquée en page 0 de `<volume>.cles`, et le premier
déverrouillage du volume restauré doit l'ouvrir. Un lecteur qui supposerait `enveloppe` dériverait
la mauvaise clé et refuserait une page parfaitement valide.

**Ni le sel ni l'octet de domaine ne sont AUTHENTIFIÉS, et ils n'ont pas à l'être.** Les changer
fait dériver une autre clé, donc échouer l'étiquette de la racine : ils se protègent par leur
conséquence, exactement comme le nonce. Un octet de domaine qui ne désigne RIEN, lui, fait refuser
la page au décodage — une page dont on ne sait pas sous quelle clé sa racine est scellée n'est pas
une page qu'on lira « au mieux ».

**La version de format d'un EMPLACEMENT ne suit PAS celle de la page** : elle vaut 1, et elle
vaudra 1. Les octets d'un emplacement n'ont pas changé, et surtout — c'est la raison qui décide — la
faire suivre obligerait une migration de page à réenvelopper la clé de volume sous CHAQUE clé de
déverrouillage, alors qu'on n'en détient qu'une. La migration perdrait des clés, ce qui est la seule
chose qu'elle n'a pas le droit de faire.

#### La MIGRATION d'une page v1 en v2

Une page v1 est RESCELLÉE à la **première ouverture réussie**, sous le bail exclusif. C'est le seul
moment où le produit tient la clé de volume : elle ne s'obtient qu'en développant un emplacement
sous une clé de déverrouillage valable.

Le geste porte **deux écritures**, et pas quatre : la page v2 est publiée sur la page LIBRE, et la
page v1 n'est **pas** effacée. C'est la différence avec une révocation, et elle est voulue.

| Rang                       | Ce que le fichier porte                                 | Ce qui s'ouvre |
| -------------------------- | ------------------------------------------------------- | -------------- |
| avant la barrière          | page v1 intacte et autoritaire ; brouillon sur la libre | **v1 @ N**     |
| après la barrière          | page v2 complète en version N + 1 ; page v1 conservée   | **v2 @ N + 1** |
| après la mutation suivante | deux pages v2 : la mutation écrit sur la page libre     | **v2**         |

À tout instant, **une page ouvrable existe**, et la liste des emplacements est recopiée TELLE QUELLE
— aucune clé de déverrouillage n'est demandée, aucune n'est perdue. La migration n'est déclarée
faite qu'une fois la page v2 RELUE sous la même clé, à la version attendue.

**Un échec d'écriture ne fait PAS échouer le déverrouillage.** Le quota est plein, le handle a
disparu : le volume s'ouvre quand même, sous sa page v1, et la migration sera retentée. Refuser le
déverrouillage parce qu'un changement de FORMAT n'a pas pu s'écrire enfermerait l'utilisateur dehors
pour une raison qui n'est pas la sienne. Rien n'est avalé pour autant : le refus est RENDU dans le
compte rendu d'ouverture.

**Le refus de RÉTROGRADATION.** Une page v1 n'est candidate à l'autorité que si elle est STRICTEMENT
PLUS ANCIENNE que la plus récente des pages v2 valides. Sans cette règle, qui peut écrire dans
l'origine de confiance composerait une page v1 portant une version arbitrairement grande et en
recalculerait la somme : elle passerait devant la v2, et l'ouverture se ferait sous une racine
scellée directement sous la clé de volume — un format rétrogradé par une écriture, sans décision et
sans qu'aucun refus ne le dise. La règle n'écarte PAS la page v1 dès qu'une v2 existe : c'est elle
qui rend la migration sûre sous coupure, et entre « refuser un peu moins » et « risquer de perdre le
volume », l'ADR 0020 a déjà tranché une fois.

**Épreuves.** `tests/unit/vm-enveloppe-migration-page.test.mjs` rejoue la matrice de coupures de
l'ADR 0020 — quatre sinistres, quatre rangs, **six coupures réellement produites** sur les seize
cellules, puisque le geste ne porte que deux écritures de support — sur une enveloppe à quatre clés,
et exige à CHAQUE rang que les quatre ouvrent, que l'état soit v1 @ N ou v2 @ N + 1, et que la liste
soit identique identifiant par identifiant. Les six coupures sont ÉNUMÉRÉES et l'assertion est une
égalité : une couverture qui baisserait ferait rougir l'épreuve au lieu de rester sous un plancher.
Le fichier MIGRÉ est ensuite éprouvé sous sept altérations — page v1 effacée, v1 forgée à une
version supérieure puis ÉGALE, étiquette de racine, sel, octet de domaine porté à `recuperation`
puis à une valeur qui ne désigne rien — et sous chacune, il reste une page ouvrable par les quatre
clés. `tests/unit/vm-enveloppe-vecteurs.test.mjs` migre en outre les QUATRE pages v1 FIGÉES du
contrat de l'ADR 0020, qui ne doivent rien à ce banc.

**Vecteurs.** `tests/vectors/enveloppe-v2.json` fige les deux pages — `enveloppe` et `recuperation`
—, leurs sels, leurs infos HKDF et les trente-deux octets de leurs clés dérivées.
`node tools/verifier-vecteurs.mjs` refait la chaîne entière depuis le seul texte des ADR, sans
importer une ligne du produit, et ajoute son témoin négatif : la clé d'un domaine n'ouvre pas la
racine de l'autre. Les vecteurs v1 (`tests/vectors/enveloppe-v1.json`) ne bougent pas d'un octet et
changent de RÔLE : ils deviennent des vecteurs de MIGRATION.

## 7. Les gestes, dans l'ordre

### 7.1 Créer un volume

1. saisir le handle exclusif ; **exiger la clé MAÎTRESSE** — sans elle, rien n'est alloué, et les
   clés de domaine ne sont pas dérivées ;
2. allouer le fichier à sa taille support, écrire l'en-tête v4 **sans** la marque de scellement
   complet, barrière ;
3. sceller **tous** les secteurs sous la clé du domaine `volume`, par tours bornés en mémoire, en
   écrivant charge puis sceau ;
4. **écrire la RACINE INITIALE** — séquence 0, génération 0, `scellementsCumulesVolume` = les
   scellements que la création vient de consommer, la racine comprise, `scellementsCumulesJournal` =
   **0**, puisqu'une création ne dépose aucun enregistrement —, barrière, puis le témoin ;
5. poser la marque `VLTSEAL1`, barrière. **C'est le dernier geste.**

Une coupure avant l'étape 5 laisse un volume refusé par `VAULT_STORAGE_VOLUME_INCOMPLET` (§ 6.3).

> **L'étape 4 est ajoutée le 10 septembre 2026** (#181,
> [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)). Elle est ce qui rend vraie
> la règle « **aucun volume légitime n'est sans racine** », et donc ce qui rend REFUSABLE un volume
> restauré dont on a retiré l'engagement (§ 7.3, § 7.5).
>
> **Depuis le 11 septembre 2026, elle n'est plus un bénéfice second mais une OBLIGATION** (#182, ADR
> 0033, décision 4) : la création est la session qui scelle le plus — 2^20 secteurs pour un volume
> de 512 Mio, un deux-millième du budget en un geste — et elle s'ouvre hors transaction. La règle de
> clôture du § 4.5 lui impose donc d'écrire cette racine, faute de quoi elle n'aurait PAS le droit
> de sceller. C'est ce qui referme la sous-estimation que le § 4.5 avouait.
>
> **Un volume v3 créé AVANT cette date n'a pas de racine initiale : il est refusé** par
> `VAULT_STORAGE_VOLUME_SANS_RACINE`. Rien n'est publié et le gate « données sensibles » est fermé ;
> les volumes pré-fabriqués des bancs et des scénarios ont été régénérés.
>
> **Le versement d'un disque applicatif hors transaction DATE sa création.** La coquille de produit
> (ADR 0030) et le banc de référence écrivent le fichier entier sans passer par le journal, ce qui
> change la région d'authentification et périme donc la racine de l'étape 4. Ils appellent
> `daterLaCreation` une fois le fichier final, avant d'inscrire le manifeste. Sans cet appel, le
> volume est refusé au premier boot par la garde de fraîcheur (§ 6.8) : un oubli coûte un refus,
> jamais un silence. Épreuve : `tests/unit/coquille-application.test.mjs`, sur l'ordre des gestes de
> l'installation.
>
> **Le versement DÉCLARE que sa clôture sera la datation** (`clotureParDatation: true`, 11 septembre
> 2026, ADR 0036). C'est le seul des quatre chemins hors transaction à ne pas clore par une racine,
> et il ne le fait pas par exception mais parce que sa clôture vient APRÈS lui : une racine écrite à
> chaque secteur versé coûterait une racine par secteur, et la datation les périmerait toutes. La
> session rend donc son COMPTE à l'appelant (`scellementsCumules`), exactement comme elle lui rend
> son empreinte, et `daterLaCreation` REPORTE ce compte dans la racine finale — sans quoi les 2^20
> scellements de la création disparaîtraient du budget de la clé.
>
> L'invariant « le versement DATE » est **FAIT, mais non garanti** (vocabulaire de l'ADR 0021) : il
> est tenu par l'appelant, et rien ne le confronte. Un volume qui déclarerait la datation sans être
> daté se rouvrirait sans refus. Le drapeau est interne — `verserLeDisque` et le banc de budget sont
> les seuls à le poser —, aucun adversaire ne l'atteint, et le dire vaut mieux que de laisser croire
> à une garde (revue de sécurité de la PR #187, constat 7).
>
> **AMENDÉ le 11 septembre 2026** (revue de sécurité de la PR #184, constat 1). Le versement FERME
> le fichier, la datation le ROUVRE, et **l'intervalle n'appartient à personne** : un adversaire qui
> sait écrire dans l'OPFS (§ 9.1, ADR 0019 § 6.9) peut y poser le fichier d'un autre volume, et la
> datation bénissait alors un état que ce produit n'a jamais produit — sous le motif `creation`,
> qui, lui, ne prouve rien.
>
> **Le versement hors transaction rend donc l'EMPREINTE SHA-256 du fichier qu'il a écrit, et la
> datation la CONFRONTE** à ce qu'elle trouve (`empreinteDuFichier`, § 7.5) **avant** d'écrire la
> racine. L'empreinte est prise pendant que le versement tient encore le fichier en exclusivité : ce
> n'est pas une relecture qu'un tiers aurait pu influencer, c'est le constat de ce que ce geste-là a
> laissé. Deux empreintes égales disent que l'intervalle n'a rien changé.
>
> Une empreinte **absente** — un appelant qui n'en rend pas — ou **discordante** REFUSE par
> `VAULT_STORAGE_CREATION_NON_CONFIRMEE` (§ 10.2), aucune racine n'est écrite, et l'installation
> n'est PAS déclarée réussie. C'est ce qui rend vraie, sur ce chemin-là, la phrase « celui qui vient
> d'écrire le fichier entier SAIT que ces octets sont les siens » : ce n'est pas le geste qui le
> sait, c'est l'empreinte qui le relie. Épreuves : `tests/unit/coquille-application.test.mjs` › «
> ÉPREUVE ROUGE — le fichier SUBSTITUÉ entre le versement et la datation est REFUSÉ » et « un
> versement qui n'ATTESTE rien ne fait pas dater ».
>
> **La datation exige aussi le journal d'une NAISSANCE** : la racine de l'étape 4 PRÉSENTE, séquence
> zéro, génération zéro, aucune entrée. Un journal VIDE est refusé comme les autres — c'est l'état
> qu'une RESTAURATION laisse, jamais celui d'une création (constat 2 de la revue de sécurité,
> constat 1 de la revue de format). Épreuve, dans `tests/unit/vm-archive-melange-etats.test.mjs` : «
> ÉPREUVE ROUGE — le mélange A/C RESTAURÉ ne peut pas être DATÉ ».

### 7.2 Écrire, valider, ranger

1. **Déposer** — l'écriture du guest est alignée sur des secteurs entiers par relecture au besoin,
   scellée sous « génération validée + 1 », et ajoutée à la charge du journal. Une écriture, une
   seule. Épreuve : `tests/unit/vm-generation-store.test.mjs` › « une écriture non alignée sur le
   secteur est complétée par relecture, pas refusée en silence ».
2. **Valider** — à la barrière du guest : la génération est incrémentée, une racine est scellée sur
   la suite ordonnée des entrées, l'empreinte de région y est rescellée, la racine est écrite à
   l'emplacement `séquence mod 2`, barrière ; **puis** le témoin est écrit. L'acquittement au guest
   suit un flush réel du support : `tests/unit/vm-durability-barrier.test.mjs` › « aucune barrière
   n'est acquittée au guest avant que le flush OPFS ait rendu la main ».
3. **Ranger** (point de contrôle, amorti au-delà de 8 Mio de charge validée) — la charge validée est
   relue, chaque enregistrement ouvert, **rescellé secteur par secteur sous un nonce NEUF**, écrit
   dans le volume ; puis le journal est vidé par une racine vide.

**Le rescellement, et ses trois conséquences assumées.** Le journal scelle des **enregistrements**,
dont la longueur est celle de l'écriture du guest et peut couvrir plusieurs secteurs ; le volume est
adressé **au secteur** et doit pouvoir être relu secteur par secteur. Une étiquette par
enregistrement obligerait, pour vérifier un seul secteur, à relire tout l'enregistrement dont il
vient — et d'abord à le RETROUVER, ce que le volume ne sait pas faire. D'où :

1. **le clair transite en mémoire** entre l'ouverture de l'enregistrement et le scellement des
   secteurs ;
2. **les octets rangés sont scellés deux fois** — une fois au dépôt, une fois au rangement ;
3. **un enregistrement non aligné est REFUSÉ**, jamais complété : le compléter exigerait de LIRE le
   volume, ce qui n'est pas le travail de la couche qui rescelle. Épreuves :
   `tests/unit/vm-format-chiffre-modele.test.mjs` › « POINT DE CONTRÔLE — un enregistrement non
   aligné est REFUSÉ, jamais complété en silence » et `tests/unit/vm-volume-chiffre.test.mjs` › « le
   RESCELLEMENT du point de contrôle reproduit le vecteur d'un secteur de volume ».

C'est la **question n° 9** de la § 13.

### 7.3 Rouvrir : l'ordre des vérifications

L'ordre suivant n'est pas une commodité ; changer un seul de ses pas rendrait un verdict deviné.

0. **Les CLÉS DE DOMAINE sont dérivées** de la clé maîtresse (§ 4.4), avant qu'aucun octet du
   fichier ne soit ouvert. Une clé maîtresse absente est refusée par `VAULT_STORAGE_CLE_REQUISE`, et
   un identifiant de volume malformé fait refuser la dérivation avant qu'aucun matériau ne soit
   importé.
1. **En-tête v4** relu et décodé. Marque de scellement complet exigée. **Un en-tête v3 est refusé et
   NOMMÉ** : le remède est la migration, jamais une sauvegarde (§ 6.2, § 7.4).
2. **Identifiant** de l'en-tête confronté à celui du manifeste.
3. **Témoin** lu et ouvert. Il fixe le **plancher de séquence** de la session. Absent = première
   ouverture.
4. **Racines** relues, décodées sans clé (marqueur, format, taille de secteur, taille de volume) ;
   la plus haute séquence lisible fait autorité. **Si AUCUNE ne fait autorité, voir le pas 4 bis :
   l'ouverture ne continue pas sans une autorisation.** 4 bis. **AUCUNE racine ne fait autorité —
   les trois cas, et il n'y en a pas de quatrième** (#181,
   [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)) :

   | À l'ouverture                     | Conduite                                                                                                                                                                                                                |
   | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | une racine fait autorité          | chemin normal — les pas 5 à 9 ci-dessous ; l'engagement n'est pas consulté. Un voisin qui traîne là est VIDÉ et l'ouverture le publie (`voisinIgnore`, § 6.9 bis)                                                       |
   | pas de racine, engagement présent | vérifier l'engagement **avant tout clair** ; s'il ouvre : écrire la **racine initiale**, la rendre durable, puis tronquer ce que le journal portait, puis VIDER le voisin ; sinon : `VAULT_STORAGE_ENGAGEMENT_INVALIDE` |
   | pas de racine, engagement absent  | `VAULT_STORAGE_VOLUME_SANS_RACINE`, **avant tout clair**                                                                                                                                                                |

   **Ces trois cas valent aussi pour la MIGRATION, depuis #182**, et il a fallu le dire : elle est
   une OUVERTURE de sa source, pas un chemin privilégié. Elle ne les appliquait pas — elle DATAIT
   d'une racine neuve un volume sans racine —, si bien que la moitié « restauration » du CRITICAL de
   #181 redevenait franchissable par le seul chemin qu'un produit v4 laisse à une archive v3. Le §
   7.4 dit comment, et sous quelle clé un journal v3 se lit.

   Le cas « au moins une racine ABÎMÉE » reste ce qu'il est :
   `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`, inchangé, et il tombe **avant** toute autorisation —
   vérifier un engagement coûte l'empreinte de tout le fichier, et un journal dont on ne sait plus
   ce qu'il a validé est refusé de toute façon.

   **L'ORDRE DES DEUX GESTES DU MILIEU est délibéré, et il est l'inverse de l'ordre naïf** (précisé
   le 11 septembre 2026, revue de format de la PR #184, constat 7) : la racine initiale est écrite
   et rendue DURABLE **avant** que le journal ne soit tronqué. Tronquer d'abord retirerait du
   fichier les octets qu'une racine encore autoritaire déclare toujours, et une coupure entre les
   deux laisserait une racine annonçant `L` octets au-dessus d'un fichier qui n'en porte plus aucun
   — c'est-à-dire un volume REFUSÉ par `VAULT_STORAGE_GENERATION_CORRUPT` alors que ses octets sont
   intacts. Dans l'ordre retenu, les deux interruptions possibles sont sûres.

   **Une ouverture HORS TRANSACTION qui n'est pas une naissance n'écrit aucune racine**, et la
   tranche T2a ne le corrige pas : le § 4.5 dit lequel des trois chemins reste ouvert, pourquoi, et
   quelle épreuve en MESURE l'écart. Le mécanisme du refus existe et mord
   (`VAULT_STORAGE_LECTURE_SEULE`, § 10.2) ; ce qui manque est le geste qui permettrait de ne pas
   l'employer sur ce chemin-là.

   **L'engagement est CONSOMMÉ une fois**, jamais vérifié à chaque ouverture : une fois la racine
   initiale écrite, c'est la fraîcheur du § 6.8 qui prend le relais. Le voisin est VIDÉ — zéro
   octet, § 6.9 bis — **après** que la racine soit durable ; l'ordre inverse laisserait, sur une
   coupure, un volume sans racine et sans engagement, c'est-à-dire irrécupérable. Ces deux ordres
   sont tenus par des mutants, chacun tué par une épreuve qui MESURE l'ordre des gestes, dans
   `tests/unit/vm-archive-melange-etats.test.mjs` : « ORDRE — une racine ABÎMÉE refuse AVANT
   l'autorisation, et ne coûte pas l'empreinte du fichier » et « ORDRE — la racine initiale est
   ÉCRITE avant que l'engagement ne soit consommé ».

   **CE QUE L'INDISTINCTION DES CAUSES COUVRE, ET CE QU'ELLE NE COUVRE PAS** (ajouté le 11 septembre
   2026, revue de sécurité de la PR #184, constat 3). Un engagement refusé rend TOUJOURS le même
   CODE et le même MESSAGE, quelle qu'en soit la cause — étiquette forgée, sel modifié, descripteur
   contredit, empreinte discordante —, et c'est délibéré : les distinguer donnerait un oracle sur ce
   qui a été manqué. **L'indistinction ne porte PAS sur la DURÉE.** Le descripteur est confronté
   AVANT que l'empreinte du fichier ne soit calculée, si bien qu'un refus « ce voisin parle d'un
   autre volume » coûte une fraction de milliseconde là où un refus « l'étiquette ne vérifie pas »
   coûte une relecture complète du fichier — 0,4 ms contre ~20 ms sur 2 Mio, mesuré ; 0,4 ms contre
   plusieurs secondes sur 512 Mio. Un observateur qui chronomètre apprend donc si ce qu'il a altéré
   est l'identité ou la géométrie du volume, ou autre chose. **C'est le compromis retenu**, et il
   est opérationnel : l'ordre inverse ferait relire un demi-gibioctet à chaque voisin forgé,
   c'est-à-dire offrirait un déni de service à plusieurs secondes par tentative, contre un oracle
   qui n'apprend rien que l'adversaire ne sache déjà — il a forgé le voisin, il sait ce qu'il y a
   mis. Voir § 9.4.

   **Une ouverture qui ÉCRIT est un geste nouveau sur ce chemin, et il est PUBLIÉ** : le rapport
   d'ouverture porte `racineInitiale: true` et le motif — `creation`, `migration` ou `engagement`.
   Jamais en silence.

5. **Parcours de la charge**, enregistrement par enregistrement, en **fenêtre glissante** : lire
   l'en-tête, lire le sceau, sauter le chiffré, collecter l'entrée
   `(adresse, longueur, rang, étiquette)`. Aucun déchiffrement, aucune allocation qui suive la
   taille de la charge.
6. **Ouvrir la racine** : l'étiquette de l'en-tête est vérifiée, **puis** le rejeu, la troncature et
   le mélange sont **établis** sur un en-tête authentique.
7. **Confronter la région** à l'empreinte que la racine scelle — **avant toute lecture de secteur**.
8. **Rejouer** : seconde passe, chaque enregistrement ouvert sous l'identité reconstruite (volume,
   format 3, génération **du sceau**, rang, adresse, longueur), puis rescellé vers le volume.
   **Cette étape écrit le volume et salit donc la région d'authentification (§ 6.8), au même titre
   que le point de contrôle** — c'est ce qui empêche l'étape 9 de sceller l'empreinte d'avant le
   rejeu.
9. **Vider** le journal par une racine neuve, et écrire le témoin.

**Chaque enregistrement est ouvert à CHAQUE passe, y compris celle qui n'émet rien.** N'ouvrir qu'à
l'émission laisserait les premiers enregistrements dans le volume au moment où le dernier serait
refusé — le rejeu à moitié que la transaction interdit. Le prix est un déchiffrement de plus par
enregistrement, et il tombe sur le geste amorti.

**Les planchers sont PRÉSENTÉS, et un plancher oublié est refusé.** La valeur `null` reste admise
mais doit **s'écrire** : c'est un `null` par défaut, et non un `null` décidé, qui avait laissé les
refus de rejeu inertes — du code mort qu'aucune épreuve ne signalait. Le plancher de génération d'un
enregistrement est la plus grande génération vue avant lui dans la charge ; en session, il vaut «
génération de reprise + 1 ». Épreuves : `tests/unit/vm-generation-sequence.test.mjs` › « une racine
AUTHENTIQUE mais antérieure au plancher de séquence est refusée en session » et
`tests/unit/vm-generation-sequence.test.mjs` › « un ENREGISTREMENT authentique d'une génération
antérieure est refusé dans une charge plus récente ».

Le **seul `null` qui subsiste** sur un chemin de production est l'ouverture du témoin lui-même : à
ce moment rien n'est encore connu qui puisse minorer sa génération, et un plancher de zéro ne
refuserait aucun témoin authentique. Un contrôle décoratif se lit comme une garantie ; le `null`
assumé, non.

### 7.4 Migrer un volume antérieur

La chaîne va d'un format au SUIVANT, un pas à la fois : `v1 → v2 → v3 → v4`. Il n'existe aucun
chemin direct, et c'est ce qui rend la chaîne vérifiable au lieu d'être crue. Deux de ses pas sont
DESTRUCTIFS — ils réécrivent le volume — et exigent donc une sauvegarde VÉRIFIÉE, jamais un simple
consentement nommé.

> **Un pas DÉJÀ FRANCHI ne se refait pas, et il a fallu l'écrire** (#182). Le journal de reprise ne
> porte qu'UN avancement : celui du pas EN VOL. Avec un second pas destructif dans la chaîne, une
> reprise redonnait « rien de commencé » au pas v2 → v3 — qui redéplaçait alors la charge d'un
> volume déjà converti par-dessus sa propre région d'authentification, sans lever d'erreur. Le
> discriminant est le `from` de l'avancement : il atteste que tous les paliers jusque-là sont
> atteints. Épreuve : `tests/unit/vm-volume-migration.test.mjs` › « une coupure PENDANT le pas v3 →
> v4 ne fait pas REFAIRE le pas v2 → v3 ».

> **La migration est une OUVERTURE de sa source, et pas un chemin privilégié** (#182, revue de la PR
> #186, constats 1 et 4). Quand la source est déjà CHIFFRÉE — un v3 —, son voisin `.gen` n'est pas
> un fichier à recopier : c'est un journal, et il s'OUVRE par le magasin de générations, sous un
> scellement de la version SOURCE. En v3 cela veut dire **sous la DEK importée directement en clé
> AES-GCM**, le régime que la v4 remplace, et c'est l'unique appelant qui en reste dans le produit.
>
> Ce geste rend trois choses d'un coup, et c'est la raison de ne pas écrire un lecteur de plus :
>
> 1. la CHARGE ACQUITTÉE que le journal porte est appliquée au volume AVANT le rescellement. Le
>    lecteur du format 1 y était appliqué quelle que soit la version de la source, et il échouait au
>    CRC-32 que le format 4 a remplacé par une étiquette : **tout v3 légitime — donc tout v3, depuis
>    que l'ADR 0034 leur donne une racine — était refusé à la migration**, alors même que le refus
>    d'ouverture du § 6.2 nomme la migration comme seul remède ;
> 2. les TROIS cas du pas 4 bis du § 7.3 s'appliquent à la SOURCE : racine → normal ; pas de racine
>    mais un engagement d'archive → vérifié sous la clé, sur l'empreinte du fichier ENTIER, avant
>    tout clair, puis consommé ; ni l'un ni l'autre → `VAULT_STORAGE_VOLUME_SANS_RACINE`, zéro
>    écriture. Sans cela la migration DATAIT d'une racine neuve un volume que l'ouverture refuse,
>    par le seul chemin qu'un produit v4 laisse à une archive v3 ;
> 3. la FRAÎCHEUR de région est confrontée, comme à toute ouverture.
>
> Le solde a lieu **avant** que le journal de reprise ne soit inscrit, donc avant tout geste
> destructif : un refus laisse le volume intact ET son manifeste en place. Une reprise ne le rejoue
> pas — le fichier n'est plus la source, il est un entre-deux dont certaines suites sont déjà v4.

> **LA BOUCLE DE LA SAUVEGARDE, ouverte par #181 et refermée par T2b** (#182). Un pas destructif
> exige une SAUVEGARDE VÉRIFIÉE, et un consentement nommé ne peut pas en tenir lieu (ADR 0011, et la
> revue de #110 qui l'a resserré). Or `ouvrirPourExport` ouvrait tout volume de format au moins 3
> par `openOpfsVolume`, qui refuse un en-tête v3 en renvoyant à la migration : **un v3 n'était
> migrable qu'à condition de détenir déjà une archive faite par le runtime précédent**, et qui ne
> l'avait pas n'avait aucun chemin. La tranche T2a a MESURÉ cet écart plutôt que de le maquiller ;
> T2b le comble.
>
> **L'export d'un v3 emprunte le SOLDE ci-dessus**, et rien d'autre : le même magasin, le même
> ordre, les mêmes trois cas avant tout clair. Il rend ensuite un accès BRUT en lecture, dont
> l'archive est composée. L'archive produite est celle que l'ADR 0034 définit pour un volume v3 —
> manifeste déclarant la version 3, engagement scellé sous la clé du domaine `archive` (version 3 du
> domaine) dérivée de la DEK. Aucun chemin d'ÉCRITURE v3 ne s'ouvre à l'appelant.
>
> **L'écart qui reste, et il est écrit ici parce qu'il n'est pas comblé.** Ouvrir un volume v3 n'est
> pas gratuit : le magasin clôt sa récupération en écrivant une racine v3, et rejouer une charge
> rescelle des secteurs — **3 + N scellements** sous la clé v3, c'est-à-dire sous la DEK :
> l'empreinte de région, la racine de clôture et le témoin, PLUS un par secteur rejoué. Le nombre
> est MESURÉ, et non affirmé : la sonde de `tests/unit/vm-migration-source-v3.test.mjs` compte 3
> quand le journal n'a rien à rejouer, 4 quand il porte une écriture acquittée, et vérifie dans les
> deux cas que la racine v3 publie EXACTEMENT ce compte. Ils sont le prix de l'application de la
> charge acquittée, ils passent par l'unique exception du cliquet anti-DEK
> (`src/vm/scellement.mjs`), et ils sont EXACTEMENT ceux que la migration produit déjà sur le même
> fichier. Ne pas ouvrir perdrait une écriture acquittée ; un lecteur v3 dédié qui n'écrirait rien
> ne saurait pas appliquer la charge, donc perdrait la même chose sous un autre nom. La décision de
> T2b demandait « aucun scellement sous une clé v3 hors l'engagement d'archive » : ce chemin n'y
> parvient pas, et `SECURITY.md` comme l'ADR 0036 le portent dans les mêmes termes.
>
> Le chemin entier est MESURÉ par `tests/unit/vm-migration-source-v3.test.mjs` › « l'archive d'un v3
> se RESTAURE et se migre » : un v3 en service, une écriture acquittée restée dans son journal, un
> export par CE runtime, l'état qu'une restauration laisse, puis la migration — et la charge
> acquittée se retrouve dans le clair v4.

#### v3 → v4 : rescéller chaque secteur

**C'est le geste le plus lourd que ce dépôt ait tenté** : chaque secteur est RESCELLÉ, parce
qu'aucune clé ne traverse une version de format (§ 4.4, champ 4 de l'info). Pour 512 Mio, cela fait
2^20 ouvertures sous la clé v3 et 2^20 scellements sous la clé du domaine `volume` de la v4. C'est
aussi le SEUL geste du produit qui tienne les deux clés à la fois.

**La géométrie ne bouge pas d'un octet** : même en-tête d'un secteur, même région de 34 octets par
secteur, même charge à la même place. Il n'y a donc rien à déplacer, et la moitié du code de v2 → v3
n'a pas d'équivalent ici. Deux gestes seulement : RESCELLER toute la charge, puis POSER L'EN-TÊTE v4
avec sa marque de scellement complet, **en dernier**.

**Le problème que v2 → v3 n'avait pas.** En v2 → v3, l'un des deux états d'un secteur — le clair —
se rescellait à l'infini. Ici, les deux états sont des chiffrés sous deux clés différentes, et **le
sceau et la charge doivent changer ENSEMBLE**. Aucun ordre d'écriture ne suffit à lui seul :

- sceau v4 d'abord, puis charge : une coupure entre les deux laisse une charge v3 sous un sceau v4.
  La charge s'ouvrirait encore sous la clé v3 — mais son sceau v3 a été écrasé, et il est le nonce
  et l'étiquette sans lesquels rien ne s'ouvre ;
- charge d'abord, puis sceau : une coupure laisse une charge v4 sous un sceau v3, et le sceau v4
  n'existe nulle part. Le secteur est perdu.

**La réponse est une ÉCRITURE ANTICIPÉE, et elle coûte 6,6 %** : avant de toucher la suite de
secteurs en vol, la conversion inscrit dans `<volume>.migration` les SCEAUX v3 de cette suite —
trente-quatre octets par secteur. Elle écrit ensuite les sceaux v4, puis les charges v4. Une reprise
dispose alors, pour chaque secteur de la suite en vol, des DEUX sceaux possibles, et peut trancher :

```text
ouvre sous (clé v4, sceau du support)      → converti, il n'y a rien à faire
ouvre sous (clé v3, sceau v3 journalisé)   → charge encore v3, sceau déjà v4 : rescéller
ouvre sous (clé v3, sceau du support)      → rien n'a encore été écrit : convertir
n'ouvre sous aucun des trois               → écriture DÉCHIRÉE : REFUS, la sauvegarde
```

Le dernier cas est le fail-closed de v2 → v3, à l'identique. **La reprise ne relit JAMAIS le volume
entier** : elle repart du rang journalisé et ne rejoue que la suite en vol — c'est la condition
d'abandon que la DoR de #182 posait, et elle est mesurée. Le JOURNAL passe en **version 3** pour
porter cette écriture anticipée ; un journal de version 2 est refusé plutôt qu'interprété.

**La GÉNÉRATION de chaque secteur SURVIT** : la conversion change la clé, pas l'histoire.

**Les octets rendus sont EXACTEMENT ceux du v3**, et c'est la seule vérification qui compte : les
épreuves coupent à CHACUNE des écritures du volume et à CHACUNE des inscriptions du journal, une par
une, et exigent à chaque fois que le volume converti rende, secteur par secteur, le clair que le v3
portait. `tests/unit/vm-migration-v4.test.mjs`.

**Le manifeste passe en v4, et il le faut.** Aucun champ n'y change ; ce qui change est ce que le
volume EST. Un manifeste resté en v3 au-dessus d'un fichier v4 ferait tenter l'ouverture sous la
DEK, c'est-à-dire produirait « sceau refusé » — « restaurez une sauvegarde » — pour un volume intact
qui demandait une migration.

#### v2 → v3 : déplacer puis sceller

En place, sous la chaîne de l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) —
sauvegarde vérifiée exigée, manifeste révoqué avant la première mutation, journal de reprise inscrit
avant la révocation, manifeste cible inscrit **en dernier** et relu depuis le support. Une migration
interrompue laisse un volume **non identifié**, que le boot refuse. Épreuve :
`tests/unit/vm-volume-migration.test.mjs` › « la migration inscrit le manifeste cible EN DERNIER,
après le journal et la révocation ».

**En place et non par un fichier voisin** : un voisin exigerait le **double du quota** au moment
précis où l'on migre un volume de 512 Mio, c'est-à-dire là où la place manque le plus souvent. Le
surcoût de la conversion en place est celui du format : 6,64 %.

**Deux gestes, et leur ordre est indispensable.**

1. **DÉPLACER** la charge de `a` vers `chargeOffset + a`, **du dernier secteur au premier**.
2. **SCELLER** chaque secteur à sa nouvelle place.

L'ordre n'est pas seulement souhaitable : la région vit dans `[512, chargeOffset)`, c'est-à-dire
**dans la zone d'où le déplacement lit**. Sceller avant d'avoir fini de déplacer détruirait la
source du déplacement.

**Le déplacement n'est PAS rejouable depuis le début**, et une première conception le croyait : la
zone d'arrivée `[chargeOffset, chargeOffset + L)` **recouvre** la zone de départ `[0, L)` dès que
`chargeOffset < L`, donc pour tout volume plus grand que sa propre région. La **position atteinte**
est donc journalisée après chaque tour ; elle n'a pas besoin d'être exacte, seulement conservatrice.
Le contre-exemple est **conservé comme épreuve** : `tests/unit/vm-migration-v3.test.mjs` › «
REPRENDRE le déplacement depuis le DÉBUT corrompt le volume — le contre-exemple est gardé ».

**Le scellement, lui, est reprenable sans compteur** : un secteur déjà converti s'ouvre, un secteur
encore en clair ne s'ouvre pas, et la région est à zéro avant conversion. La probabilité qu'un
secteur en clair passe pour scellé est celle d'une forgerie GCM. Une reprise applique un
**fail-closed** : sous la position journalisée, tout secteur DOIT s'ouvrir ; qu'il ne s'ouvre pas
admet deux lectures que rien ne distingue — « il reste du clair », et le rescéller est juste ; « il
porte du chiffré qu'on ne sait plus ouvrir », et le rescéller le détruit. On refuse. Épreuves :
`tests/unit/vm-migration-v3.test.mjs` › « un secteur SOUS la position déjà scellée qui ne s'ouvre
pas fait REFUSER la reprise » et `tests/unit/vm-migration-v3.test.mjs` › « un volume v2 converti en
v3 rend EXACTEMENT le même clair, par le chemin de production ».

**L'identifiant est TIRÉ à la migration**, puisqu'un volume antérieur n'en a pas, et il est immuable
ensuite. Trois gardes ferment le chemin par lequel une reprise sous un mauvais identifiant
détruirait le clair en silence : l'empreinte du journal de migration, l'en-tête v3 posé dès la fin
du déplacement, et le fail-closed ci-dessus. **La limite résiduelle est nommée** : un support
capable d'écrire de façon COHÉRENTE le journal ET l'en-tête ferait reprendre la conversion sous une
identité de son choix, et les trois gardes passeraient. Ni le journal ni l'en-tête ne sont
authentifiés — seuls les secteurs le sont —, et les authentifier suppose une clé disponible avant
d'ouvrir le volume. Ce qu'un tel support obtient reste une **destruction, jamais une lecture**.

### 7.5 Exporter et restaurer

> **L'ARCHIVE EST AUTHENTIFIÉE depuis le 10 septembre 2026**
> ([#181](https://github.com/pinfada/railsbox-vault/issues/181), CRITICAL corrigé — § 9.7,
> [PR #184](https://github.com/pinfada/railsbox-vault/pull/184),
> [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)).
>
> **Ce que la revue avait montré, et qui n'est plus vrai.** Le SHA-256 décrit plus bas est
> **recalculable** par quiconque tient le fichier : il atteste contre l'accident, pas contre un
> adversaire. Comme la restauration retire journal et témoin et que l'ouverture suivante acceptait
> l'absence de racine, un mélange de secteurs authentiques venus de deux états du même volume se
> restaurait, s'ouvrait et se lisait en clair, sans refus.
>
> **Ce qui le referme, en trois traits.** Une archive v3 porte un ENGAGEMENT — le SHA-256 du fichier
> chiffré ENTIER, scellé sous une clé du domaine `archive` dérivée de la DEK ; la restauration le
> dépose à côté du volume ; la première ouverture le vérifie AVANT tout clair, écrit la racine
> initiale, puis retire le voisin. Et, pour que ce refus soit atteignable, **aucun volume légitime
> n'est sans racine** (§ 7.1). Les archives v1 et v2 sont REFUSÉES — **parce que leur CONTENEUR est
> d'une version que ce runtime ne lit plus** (`ARCHIVE_FORMAT_VERSIONS_LUES = [3]`, refus
> `VAULT_ARCHIVE_VERSION_NON_LUE`). La formulation antérieure disait « parce qu'elles ne portent
> aucun engagement » : c'est faux, et de deux façons — ce n'est pas la cause du refus, et « pas
> d'engagement » n'implique pas « refus », comme l'archive de volume antérieur ci-dessous le montre
> (corrigé le 11 septembre 2026, revue de format de la PR #184, constat 2).

**L'archive porte le fichier v3 TEL QUEL — chiffré — et son manifeste v3.** L'intégrité est prouvée
par l'empreinte SHA-256 du fichier ; la restauration recopie les octets **sans clé** ; la clé n'est
nécessaire qu'à l'**ouverture** du volume restauré. Épreuves :
`tests/unit/vm-archive-volume-chiffre.test.mjs` › « une archive de volume v3 se restaure SANS CLÉ,
octet pour octet » et `tests/unit/vm-opfs-volume-brut.test.mjs` › « il rend les octets CHIFFRÉS d'un
volume v3, et n'en ouvre aucun secteur ».

Deux conséquences à écrire :

1. **l'empreinte porte sur le chiffré.** Deux exports d'un même contenu logique ne sont plus
   comparables par empreinte — les nonces diffèrent, donc les octets. C'est voulu : l'empreinte
   atteste qu'une archive n'a pas été abîmée, pas que deux volumes portent le même état ;
2. **une archive restaurée sans sa clé est INERTE.** Elle se vérifie, se recopie, s'identifie ; elle
   ne s'ouvre pas. La sauvegarde d'un volume chiffré est la sauvegarde de **deux** choses, dont ce
   dépôt n'en gérait qu'une (§ 11). Perdre la clé, c'était perdre l'archive.

> **AMENDÉ le 6 septembre 2026 (#149, [ADR 0027](decisions/0027-archive-et-ancre-de-version.md)) :
> le format d'archive passe à la VERSION 2, et la seconde chose peut voyager.**
>
> ```text
> [ RBVAULT1 8 o ][ longueur d'en-tête 4 o ][ en-tête JSON H o ][ contenu N o ][ récupération R o ]
> ```
>
> L'en-tête déclare `recovery: { length, digest, envelopeVersion, slots } | null` ;
> `offset du contenu = 12 + H` (INCHANGÉ) ; `taille de l'archive = 12 + H + N + R`. La section,
> quand elle existe, est **une page d'enveloppe de 8 192 octets ne portant que des emplacements de
> type 4** — un moyen de récupération, jamais une phrase ni une passkey, et **jamais le code**, qui
> reste sur une feuille chez l'utilisateur. À la restauration, `<volume>.cles` est écrit à partir de
> cette page (page 0 = la page embarquée, page 1 à zéro), **après** le contenu relu et **avant** le
> manifeste.
>
> Une archive v2 dont `recovery` vaut `null` décrit un volume sans moyen de récupération, et le
> compte rendu de l'export le DIT : elle ne s'ouvrira nulle part ailleurs.

> **AMENDÉ le 10 septembre 2026 (#181,
> [ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)) : le format d'archive passe
> à la VERSION 3, et l'en-tête gagne un champ.**
>
> ```text
> [ RBVAULT1 8 o ][ longueur d'en-tête 4 o ][ en-tête JSON H o ][ contenu N o ][ récupération R o ]
> ```
>
> La DISPOSITION ne bouge pas : `offset du contenu = 12 + H`, `taille = 12 + H + N + R`, et le
> marqueur `RBVAULT1` est inchangé — le changer ferait dire à un runtime ancien « ce n'est pas une
> archive » au lieu de « cette archive est trop récente », et l'ADR 0011 veut un refus explicite
> d'un format futur. L'en-tête déclare, entre `recovery` et `manifest` :
>
> ```json
> "engagement": { "algorithm": "aes-256-gcm", "salt": "<64 hex>", "nonce": "<24 hex>",
>                 "ciphertext": "<64 hex>", "tag": "<32 hex>" }
> ```
>
> **Ce que l'engagement scelle.** Clair = `SHA-256(fichier chiffré ENTIER)`, 32 octets. Données
> associées, champs de largeur fixe ou préfixés de leur longueur, comme au § 5.1 :
>
> ```text
> donnéesAssociées = LP("railsbox-vault/archive/engagement/v1") ‖ LP("aes-256-gcm")
>                  ‖ U32BE(versionDArchive) ‖ LP(identifiantVolume)
>                  ‖ U64BE(tailleSupport) ‖ U64BE(tailleLogique) ‖ U32BE(tailleDeSecteur)
>                  ‖ U32BE(versionDeRecuperation)
>                  ‖ U64BE(longueurDuContenu) ‖ U64BE(longueurDeLaRecuperation)
> ```
>
> **La longueur de l'EN-TÊTE n'y est PAS, et c'est une nécessité d'encodage, pas un oubli** :
> l'engagement vit dans cet en-tête, et y sceller sa longueur la rendrait fonction d'elle-même. Ce
> que l'en-tête déclare d'AUTRE — la garantie de cohérence, le nom de l'application — n'est donc pas
> authentifié, et cette phrase est là pour ne pas le laisser croire.
>
> **La clé.**
> `HKDF-SHA-256(IKM = DEK, sel = 32 octets TIRÉS et écrits en clair dans l'archive, info)`, info de
> l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) décision 3 avec
> `domaine = "archive"` et `versionDeFormatDuDomaine = 3`. **Une archive, une clé, un scellement,
> aucun compteur** : le domaine `archive` est à usage unique, et le budget du § 4.5 n'a rien à y
> compter. La clé du VOLUME, elle, restait la DEK jusqu'à #182 — entorse assumée, écrite dans l'ADR
> 0033, et LEVÉE le 11 septembre 2026 par la
> [PR #186](https://github.com/pinfada/railsbox-vault/pull/186)
> ([ADR 0035](decisions/0035-format-de-volume-v4-et-migration.md)) : en v4 la clé du volume est
> dérivée sous le domaine `volume` (§ 4.4), et seule la lecture d'un v3 par la migration ou par
> l'export scelle encore sous la DEK (§ 7.4).
>
> **Qui vérifie, et quand.** La restauration **n'a pas la clé**, et c'est une propriété qu'on garde
> : elle vérifie ce qu'elle peut sans clé — présence, longueur, cohérence de l'en-tête, version lue
> —, refuse une archive de version non lue, et DÉPOSE l'engagement dans le voisin
> `<volume>.engagement` (§ 6.9 bis), entre l'enveloppe de récupération et le manifeste. C'est
> l'OUVERTURE qui le confronte, selon les trois cas du § 7.3.
>
> **`tailleSupport` et `longueurDuContenu` COÏNCIDENT dans le format actuel**, et il faut le dire :
> la section de contenu EST le fichier entier, si bien que les deux champs des données associées
> portent toujours la même valeur. Ils restent DISTINCTS pour qu'une archive future dont la section
> de contenu ne serait pas le fichier entier — une archive partielle, un conteneur à plusieurs
> sections de volume — n'ait pas à changer les données associées, donc à changer la clé de tout ce
> qui existe. Un relecteur qui dérive l'encodage de ce paragraphe ne pouvait pas le deviner (précisé
> le 11 septembre 2026, revue de format de la PR #184, constat 6).
>
> **UNE ARCHIVE v3 D'UN VOLUME ANTÉRIEUR À v3 DÉCLARE `"engagement": null`, EXPLICITEMENT.** C'est
> une forme du format persistant, contractuelle dans les deux sens : le produit l'écrit, et la
> restauration l'EXIGE — un champ absent est refusé (`VAULT_ARCHIVE_ENGAGEMENT_ABSENT`), un champ
> non nul sur un manifeste antérieur à v3 aussi. C'est la règle de `recovery`, mot pour mot : un
> champ absent laisserait croire à un en-tête d'une autre version, un champ nul dit « ce volume n'a
> rien à engager ».
>
> ```json
> {
>   "magic": "railsbox-vault/volume-archive",
>   "archiveFormatVersion": 3,
>   "content": { "algorithm": "sha-256", "digest": "<64 hex>", "length": 1024, "consistency": {} },
>   "recovery": null,
>   "engagement": null,
>   "manifest": { "formatVersion": 2, "geometry": { "volumeSize": 1024 } }
> }
> ```
>
> **Pourquoi cette forme existe** : un volume antérieur à v3 n'est pas chiffré, ne porte aucun
> identifiant de volume, et n'a donc ni clé ni identité à engager. L'interdire rendrait impossible
> la sauvegarde que l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) exige **avant**
> une migration v2 → v3, c'est-à-dire avant le seul pas destructif du dépôt.
>
> **Elle n'est PAS authentifiée, et sa restauration ne l'est pas non plus.** La restauration ne
> dépose AUCUN voisin d'engagement ; le volume qu'elle pose est refusé à l'ouverture par
> `VAULT_STORAGE_VOLUME_SANS_RACINE` sur le chemin direct, et par
> `VAULT_MANIFEST_MIGRATION_REQUIRED` sur le chemin du produit, dont la garde de manifeste vient en
> amont. Les secteurs d'un volume v2 ne sont authentifiés par rien — par construction, c'est ce que
> la v3 ajoute —, et ils ne le deviennent qu'à la migration qui les rechiffre. Une archive de ce
> type protège donc contre l'ACCIDENT, comme une archive v1 ou v2 le faisait, et contre rien
> d'autre.
>
> Vecteur figé : `tests/vectors/archive-v3.json` › `archiveDeVolumeAnterieur`, vérifié par
> `node tools/verifier-vecteurs.mjs` depuis le seul texte de ce paragraphe.

> **Ce que ce refus prouve, et ce qu'il ne prouve pas.** Il est tenu contre le mélange et contre le
> retrait du voisin. Il ne couvre PAS le rejeu d'une archive **entière et cohérente** : c'est le
> retour arrière complet du § 9.1, inchangé. Un volume v3 créé avant cette date est refusé, comme
> les archives v1 et v2.
>
> Vecteurs figés : `tests/vectors/archive-v3.json`, vérifiés par `node tools/verifier-vecteurs.mjs`
> depuis le seul texte des ADR — l'info HKDF octet par octet, les données associées, le scellement
> qui S'OUVRE, et les 180 octets du voisin.

**L'export passe par un accès BRUT au fichier**, sans clé et sans géométrie logique : par la voie
autorisée, qui déchiffre, il aurait produit une archive **en clair** d'un volume chiffré — le
chiffrement au repos annulé dès que le fichier quitte l'appareil, par omission et sans message. Une
épreuve le montre au lieu de l'affirmer : `tests/unit/vm-archive-volume-chiffre.test.mjs` › « le
CLAIR d'un secteur connu n'apparaît nulle part dans l'archive exportée ».

**Et pourtant l'export DEMANDE la clé.** Le fichier ne porte pas tout l'état du volume : une
génération **validée** vit dans le journal jusqu'à ce qu'une ouverture transactionnelle la rejoue.
Copier le fichier tel quel dans cet intervalle produirait une archive à laquelle il manque une
écriture acquittée, dont l'empreinte vérifie, dont la restauration réussit, et dont personne
n'apprendrait jamais qu'elle est incomplète. L'export **ouvre donc transactionnellement pour
récupérer, referme, puis ouvre en brut pour copier** — et si la récupération REFUSE, le fichier
n'est pas même ouvert.

**Le bail exclusif est rompu entre les deux ouvertures**, et le dire vaut mieux que le taire : il
n'existe pas de passation d'un handle exclusif. Ce qui est fait à la place est de **re-constater**,
après la reprise du bail, que le fichier est bien celui qu'on vient de récupérer — sa taille et
l'identifiant de son en-tête — et de refuser sinon. Ce contrôle n'est pas une preuve d'exclusivité :
il attrape le remplacement et le retaillage, pas une écriture au milieu du fichier.

## 8. Ce que le format protège

Chaque propriété est doublée d'un **témoin positif** : sans lui, un format qui refuserait tout
passerait pour sûr.

### P1 — Modification

Un sceau ne rend un clair que si l'étiquette AES-256-GCM vérifie sur `(chiffré, données associées)`
sous la clé et le nonce. Toute altération d'un bit du chiffré, de l'étiquette ou du nonce est
refusée.

- **Garantit** qu'une altération non détectée exige une forgerie GCM, majorée par ≈ 2^-122,6 pour un
  secteur de 512 octets et par ≈ 2^-107 pour le plus grand enregistrement de journal que le plafond
  de charge admette (16 Mio, § 4.1) — le pire cas, pas le meilleur. C'est une intégrité
  **authentifiée**, non une somme de contrôle : le recalcul exige la clé.
- **Ne garantit pas** : rien contre un détenteur de la clé ; rien sur la **disponibilité** — effacer
  reste possible et n'est pas une modification détectable, c'est une perte ; rien sur les **canaux
  auxiliaires** ; rien sur la correction de l'implémentation WebCrypto du moteur, que ce dépôt ne
  peut pas auditer.
- **Hypothèses** : AES-256-GCM est un AEAD sûr pour l'étiquette choisie ; la clé est inconnue de
  l'adversaire ; l'implémentation du moteur est conforme.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « P1 positif — un bloc scellé puis
  ouvert rend EXACTEMENT le clair d'origine » et `tests/unit/vm-format-chiffre-modele.test.mjs` › «
  MODIFICATION — un seul octet retourné, où qu'il soit, refuse le sceau ».

### P2 — Déplacement

Les données associées portent l'identité logique **complète**, **magasin compris** : un bloc valide
relu à une autre adresse, dans un autre volume, sous une autre version de format, une autre
génération — ou **dans l'autre magasin** — est refusé.

Le « magasin compris » est une correction, pas une reformulation. Jusqu'au format de journal 4, un
enregistrement du journal et un secteur du volume partageaient leur étiquette de domaine, et cette
propriété était **fausse** dans le cas nominal du § 5.4 : les deux se déplaçaient l'un vers l'autre
sans qu'aucune étiquette bronche. Le constat est
[#143](https://github.com/pinfada/railsbox-vault/issues/143) ; la § 9.6 dit ce qui reste ouvert pour
les volumes déjà écrits.

- **Garantit** que le déplacement exige la même forgerie que P1, l'encodage étant injectif.
- **Ne garantit pas** de dire **de quoi** le refus vient : modification et déplacement sont
  **cryptographiquement indiscernables**, et un seul code les couvre. Ne garantit pas non plus
  l'unicité de l'identifiant de volume, qui est tiré localement et que rien n'authentifie contre un
  registre.
- **Hypothèses** : l'identifiant de volume est unique et immuable ; les clés de deux volumes sont
  distinctes.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « P2 positif — le même chiffré s'ouvre
  sous SON identité logique, et sous elle seule », `tests/unit/vm-volume-chiffre.test.mjs` › « REFUS
  2 — un secteur valide DÉPLACÉ à une autre adresse est refusé » et, pour la séparation des
  magasins, `tests/unit/vm-identite-magasin.test.mjs` › « un ENREGISTREMENT de journal épissé dans
  la région et la charge du volume est REFUSÉ ».

### P3 — Rejeu

La séquence et la génération sont authentifiées dans l'en-tête de la racine. Une racine dont la
séquence est inférieure au plancher présenté est refusée ; un bloc dont la génération est inférieure
au plancher présenté aussi. Les deux refus sont posés **après** la vérification de l'étiquette.

- **Garantit** qu'une racine ou un bloc d'une génération antérieure, réintroduits intacts, sont
  refusés **dès lors que le plancher présenté est juste**. En session, ce plancher est la dernière
  séquence validée ; à l'ouverture, il vient du témoin.
- **Ne garantit pas** le retour arrière **complet** du support entre deux sessions (§ 9).
- **Hypothèse** : la source du plancher est au moins aussi fiable que ce qu'on lui demande de
  protéger.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « REJEU — une racine et un bloc d'une
  génération antérieure, intacts, sont refusés » et `tests/unit/vm-generation-sequence.test.mjs` › «
  une racine AUTHENTIQUE mais antérieure au plancher de séquence est refusée en session ».

### P4 — Troncature

L'en-tête authentifié porte le nombre d'entrées et la longueur de charge. Une génération à laquelle
il manque des entrées — ou à laquelle il en a été ajouté — est refusée, sur un en-tête authentique.

- **Garantit** qu'une génération incomplète n'est jamais prise pour une génération plus courte.
- **Ne garantit pas** la suppression de la génération ENTIÈRE avec sa racine, qui est un retour
  arrière et non une troncature ; ni la troncature du VOLUME hors journal.
- **Hypothèse** : la liste des entrées présentée est celle qui a réellement été trouvée sur le
  support, non une liste reconstruite depuis l'en-tête.
- Épreuves : `tests/unit/vm-format-chiffre-modele.test.mjs` › « TRONCATURE — une génération à
  laquelle il manque une entrée est refusée » et `tests/unit/vm-generation-sequence.test.mjs` › «
  une génération AUGMENTÉE d'une entrée est refusée, et le refus traverse en VAULT_STORAGE_* ».

### P5 — Mélange

L'empreinte SHA-256 de la **suite ordonnée** des entrées est le clair scellé par la racine. Un
assemblage de blocs individuellement valides mais issus de générations différentes est refusé — de
même qu'un simple réordonnancement.

- **Garantit** que la génération est un TOUT.
- **Ne garantit rien sur le VOLUME au-delà du journal** : après un point de contrôle, le volume
  porte légitimement des secteurs de générations différentes ; c'est son état normal, pas un
  mélange.
- **Hypothèses** : SHA-256 résiste à la seconde préimage ; deux étiquettes GCM distinctes ne
  collisionnent pas sous la borne écrite en § 4.1.
- Épreuve : `tests/unit/vm-format-chiffre-modele.test.mjs` › « MÉLANGE — des blocs individuellement
  valides mais d'une autre génération sont refusés ».

### P6 — Fraîcheur de la région (au-delà des cinq propriétés d'origine)

La racine scelle l'empreinte de la région d'authentification, rescellée sous sa propre génération,
et l'ouverture la confronte avant toute lecture de secteur (§ 6.8).

- **Garantit** le refus d'un **secteur du volume ramené en arrière** hors journal — quadruplet
  complet remis en place, à la bonne adresse, dans le bon volume.
- **Ne garantit pas** : le contenu du volume **entre deux points de contrôle** (la région ne bouge
  pas tant que rien n'est rangé) ; le retour arrière qui emporte AUSSI le journal et le témoin ; la
  **présence** de l'empreinte, dont seule la valeur est authentifiée.
- Épreuve : `tests/unit/vm-generation-fraicheur.test.mjs` › « un SECTEUR ramené en arrière hors
  journal est refusé, alors que ce secteur reste authentique ».

### Le contrat de vecteurs

Les octets sont un **contrat**, pas une commodité. Les régénérer après avoir modifié le format ne
corrige rien : c'est un changement de format persistant, qui exige une version et un ADR. Épreuves :
`tests/unit/vm-format-chiffre-vecteurs.test.mjs` › « le modèle reproduit OCTET POUR OCTET les blocs
scellés figés », `tests/unit/vm-volume-chiffre.test.mjs` › « le scellement du produit reproduit
OCTET POUR OCTET les cinq blocs figés », `tests/unit/vm-format-chiffre-vecteurs.test.mjs` › « aucun
nonce n'apparaît DEUX FOIS dans les vecteurs » et `tests/unit/vm-format-chiffre-vecteurs.test.mjs` ›
« les compteurs de scellements des vecteurs croissent et COMPTENT les racines ».

## 9. Ce que le format NE protège PAS

Cette section est du **même rang** que la précédente. Rien de ce qui suit n'est un trou découvert
après coup : ce sont les limites du périmètre, écrites.

### 9.1 Le retour arrière COMPLET du support

Volume, journal, racine, témoin et manifeste ramenés ensemble à un état antérieur cohérent **ne sont
pas détectables**. L'état antérieur est cohérent et authentique ; rien ne le distingue d'un support
qui n'a jamais avancé.

Le remède exige une **ancre monotone hors de portée de l'adversaire** : un compteur matériel, un
témoin distant, un service tiers de fraîcheur. Ni OPFS, ni IndexedDB, ni le stockage clé-valeur ne
promettent la monotonie face à un adversaire qui contrôle le profil. Le seul compteur monotone
qu'une API de navigateur expose est `authenticatorData.signCount` de WebAuthn, et il ne suffit pas
pour trois raisons cumulées : CTAP2 le rend **facultatif**, la plupart des authentificateurs de
plateforme rendent **zéro**, et son emploi supposerait une décision sur le déverrouillage. Le
déverrouillage livré **ne le lit pas**.

D'ici là, la seule barrière est le **partitionnement OPFS par origine**. Et la limite n'est pas
seulement écrite, elle est **exécutée** : `tests/unit/vm-generation-fraicheur.test.mjs` › « un
volume ramené SOUS le témoin est refusé ; ramené AVEC lui, il ne l'est pas » — le volume rouvre, et
la seconde écriture a disparu sans que personne puisse le voir. Une limite qu'aucune épreuve ne
montre finit par être oubliée.

**L'effort n'est pas symétrique** (§ 6.9) : neutraliser le témoin coûte huit octets effacés, sans la
clé.

**Ce paragraphe ne décrit QUE le retour arrière complet, et un recul d'UNE génération n'en est pas
un.** Il ne demande ni copie antérieure ni journal : l'alternance des racines (§ 6.6) garde `s − 1`
lisible sur le support, et abîmer les 512 octets de `s` suffit. **Le témoin tranche ce recul-là,
SAUF contre un adversaire qui en détient une copie antérieure** — celui de
[#142](https://github.com/pinfada/railsbox-vault/issues/142) :

- contre qui **neutralise** le témoin, le recul est refusé (§ 6.9,
  `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`) ;
- contre qui le **rejoue** — un témoin de `s − 1` archivé, la racine `s` abîmée, la copie remise —,
  il ne l'est pas : le témoin **concorde** avec la racine retenue, l'ouverture conclut « coupure »,
  et une génération **acquittée** disparaît sous un rapport qui déclare la fraîcheur `verifiee`.
  C'est le retour arrière décrit ci-dessus, **obtenu à moindre coût** — 62 octets archivés à
  l'avance au lieu d'une copie cohérente du volume et du journal. Il reste **indétectable**, et
  cette phrase le dit plutôt que de laisser croire que le témoin ferme ce recul en toutes
  circonstances. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « #142 COMPOSÉ à #144 ».

[#144](https://github.com/pinfada/railsbox-vault/issues/144) avait relevé que ce paragraphe et le §
6.9 promettaient tous deux « une copie antérieure » pour un recul d'une génération ; la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153) corrige les deux, et une revue de
cette PR a corrigé la correction — la première rédaction affirmait que « le témoin le tranche »,
sans sa réserve.

**Le RETOUR ARRIÈRE VERS LA NAISSANCE est un cas de ce paragraphe, et il ne demande AUCUNE archive**
(ajouté le 11 septembre 2026, revue de sécurité de la PR #184, constat 10). Depuis #181, chaque
création fabrique elle-même un instantané cohérent à trois fichiers — le fichier de volume scellé,
son journal portant la racine initiale, son témoin — et un adversaire qui les repose ENSEMBLE sur un
volume vivant obtient une ouverture ACCEPTÉE, `fraicheur: "verifiee"`, rendant l'état de la
naissance. Reposer le **fichier seul** est bien refusé (`VAULT_STORAGE_GENERATION_CORRUPT`, cause
`VAULT_FRAICHEUR_REGION`) ; les trois ensemble ne le sont pas, parce que les trois ensemble SONT un
état que ce volume a réellement produit. C'est la limite ci-dessus, sans rien de neuf — mais le prix
de l'attaque a baissé, et le dire coûte une phrase.

### 9.2 Le journal de migration n'est ni chiffré ni authentifié

`<volume>.migration` porte le manifeste source, la preuve de sauvegarde retenue, l'étape franchie et
la position atteinte. Il porte une **empreinte SHA-256 de son corps**, vérifiée avant l'analyse de
ses champs — elle détecte l'**altération**, pas la **forgerie** : elle n'est ni signée ni chiffrée,
et un journal réécrit d'un bloc serait cohérent avec lui-même.

Un support hostile pourrait donc faire reprendre une migration depuis une identité forgée. La
confiance repose ici encore sur le partitionnement d'origine. Ce qu'un tel support obtient est une
**destruction**, jamais une lecture (§ 7.4).

**Cette destruction est désormais DITE, et elle ne l'était pas** (revue de sécurité de la PR #186,
constat 6). Le journal décide, à partir de champs que rien n'authentifie, quels secteurs ne seront
plus jamais regardés : un journal substitué qui déclare la conversion arrivée à son dernier geste
faisait poser l'en-tête v4 sur un fichier dont aucun secteur n'avait été rescellé, et la conversion
rendait alors un compte rendu de **succès** sur un volume qui ne se relit plus. La promesse tenait —
aucun clair ne sortait, aucun octet chiffré n'était effacé — mais rien ne l'annonçait.

Avant de poser l'en-tête v4, la conversion SONDE donc un secteur sous la clé d'arrivée, et refuse
par `VAULT_MIGRATION_CONVERSION_INCOHERENTE` si elle échoue — sans qu'un octet de plus soit écrit.
Le prix est UNE ouverture GCM par conversion, soit une sur 2^20 pour un volume de 512 Mio. Elle
n'attrape pas tout, et il faut le dire : un journal forgé qui ferait sauter une suite du MILIEU
laisse le premier secteur convertible. Ce qu'elle ferme est le cas où la conversion n'a rien
converti du tout, et la plupart des reprises en avance.

### 9.3 L'écriture déchirée intra-secteur

Le format ne suppose **aucune atomicité** : ni sectorielle, ni entre la charge et son sceau, ni
entre les 34 octets d'un enregistrement de région à cheval sur deux secteurs du support. Ce qu'il
promet partout est un **refus**, pas une lecture. Ce qui protège contre la **perte** est la
transaction : le point de contrôle et le rejeu de reprise sont les deux gestes qui écrivent le
volume (§ 6.8), leur échec ne valide rien, et la génération reste dans le journal pour être rejouée.
Épreuves : `tests/unit/vm-generation-format.test.mjs` › « une racine dont l'en-tête est tronqué par
une déchirure n'est jamais une racine » et `tests/unit/vm-generation-store.test.mjs` › « une
génération validée est REJOUÉE à la réouverture même si le point de contrôle a manqué ».

Reste hors de tout ce document la perte d'un cache d'écriture **volatil** — mort du processus du
navigateur, coupure de courant : aucun des supports éprouvés ne la produit, et rien ici ne la
mesure.

### 9.4 Les canaux auxiliaires

Sont **observables** d'un support hostile, sans la clé :

- la **taille** du volume et celle de la région ;
- le **nombre de secteurs écrits** et leurs **adresses** — un secteur écrit deux fois est visible
  comme tel ;
- le **motif d'accès** ;
- tout ce que l'en-tête de racine publie en clair : nombre d'entrées d'une génération, longueur de
  sa charge, rang de la génération, taille du volume, **compteur cumulé de scellements**. Sur un
  volume de base de données, cela dit quelque chose du **rythme d'activité** (§ 13, question n° 8) ;
- l'existence et la taille de chaque voisin.

Rien n'est fait contre eux, et rien ne prétend le contraire. Le **temps** n'est pas modélisé non
plus : le format n'emploie une comparaison à temps constant que pour les empreintes qu'il compare
lui-même, et laisse au moteur la responsabilité de sa propre vérification d'étiquette.

**Un cas MESURÉ, et nommé plutôt que laissé à découvrir** (ajouté le 11 septembre 2026, revue de
sécurité de la PR #184, constat 3) : `VAULT_STORAGE_ENGAGEMENT_INVALIDE` rend une seule cause, mais
sa DURÉE en distingue deux. Le descripteur du voisin est confronté au volume AVANT que l'empreinte
du fichier ne soit calculée ; un refus « ce voisin parle d'un autre volume » coûte donc 0,4 ms là où
un refus « l'étiquette ne vérifie pas » coûte 20,4 ms sur un volume de 2 Mio, et plusieurs secondes
sur 512 Mio. Un observateur qui chronomètre apprend si ce qu'il a altéré est l'identité ou la
géométrie, ou autre chose. **L'ordre est conservé délibérément** : l'inverser ferait relire le
fichier entier à chaque voisin forgé — un déni de service à plusieurs secondes par tentative — pour
fermer un oracle qui n'apprend rien à qui a forgé le voisin lui-même. L'indistinction promise porte
sur le CODE et le MESSAGE, jamais sur la durée.

### 9.5 Ce qui est hors du format par construction

- **Un adversaire qui détient la clé** forge à volonté.
- **Du code hostile déjà présent dans le Worker de confiance** : la clé non extractible ne l'empêche
  pas de s'en servir.
- **La disponibilité** : effacer un fichier reste possible et n'est pas une modification détectable.
- **L'implémentation WebCrypto du moteur** n'est pas auditée par ce dépôt.
- **La confidentialité en exploitation** : la clé de volume n'est distribuée que par le harnais (§
  11), et le format prouve donc le FORMAT, sous une clé de test publique.
- **Le manifeste**, ni chiffré ni authentifié.

### 9.6 Constats de la pré-revue interne, 5 septembre 2026

Quatre constats de la pré-revue adverse interne (#20, moitié 1, point 5) décrivent un défaut RÉEL du
format ou de sa mise en œuvre — pas un défaut de ce document. Chacun contredit une phrase que ce
document écrivait ailleurs. **Trois sont corrigés** (#143, #144, #145) : leurs phrases d'origine ont
été récrites là où elles vivaient. **Un est accepté** (#142) : sa limite est écrite, l'ADR 0019 est
amendé, et sa sévérité est révisée. Les dispositions sont inscrites au registre de la revue externe.

**[#142](https://github.com/pinfada/railsbox-vault/issues/142) — Un témoin authentique rejoué rend
un volume sain définitivement irouvrable. ACCEPTÉ, sévérité révisée HIGH → MEDIUM, ADR 0019 amendé
le 5 septembre 2026 ; documenté et le message corrigé par la
[PR #153](https://github.com/pinfada/railsbox-vault/pull/153).** Le § 6.9 affirmait, à tort, que le
scellement du témoin « évite seulement qu'un tiers sans clé fabrique un refus permanent en y
inscrivant une séquence démesurée » — cette phrase confondait forgerie et rejeu. État réel : le
scellement empêche la **forgerie** d'une séquence inventée ; il n'empêche PAS le **rejeu** d'une
copie antérieure et authentique du témoin, qui est **fongible** pour un volume donné. Une
restauration d'archive retire le témoin et le journal sans en reposer tant qu'aucun point de
contrôle n'a eu lieu ; réinstaller ensuite la copie d'un témoin antérieur fait échouer la
confrontation de fraîcheur (`journalSousLeTemoin`) et rend un volume par ailleurs sain irouvrable.

**Pourquoi ACCEPTÉ, et non corrigé.** Rendre le rejeu détectable demanderait une **ancre monotone
hors du support** (§ 13, question n° 3), et elle n'existe pas. Faire entrer la séquence dans les
données associées du témoin — la seconde proposition de l'issue — ne la fabriquerait pas : un témoin
rejoué resterait **authentique** sous cette identité aussi, et le coût serait une version du format
de témoin et l'invalidation d'un vecteur figé, pour une propriété qui ne serait pas acquise.

**Pourquoi la sévérité est révisée en MEDIUM — et ce que ce motif ne dit PAS.** L'adversaire requis
écrit dans l'OPFS de l'origine de confiance, ce contre quoi le témoin n'a **jamais** défendu : le §
6.9 écrit depuis #19 que le neutraliser est gratuit sous cette même capacité. Ce que le rejeu
obtient **seul** est un refus permanent d'un volume sain — un déni de service, sans perte d'octet ni
clair. Ce qu'il obtient **en composition avec #144** est davantage, et il faut l'écrire plutôt que
de l'omettre : un retour arrière d'**une génération** sous un rapport `verifiee`, c'est-à-dire le
retour arrière complet du § 9.1, **déjà accepté comme indétectable**, obtenu à moindre coût — 62
octets archivés au lieu d'une copie cohérente du volume et du journal. La sévérité reste révisée
parce que ni la capacité ni la propriété perdue ne sont neuves ; ce qui l'est, ce sont deux défauts
de **conduite** — une phrase fausse, et un message qui envoyait l'exploitant dans une boucle sans
issue nommée (« restaurer une sauvegarde », geste qui retire le témoin que l'adversaire n'a qu'à
remettre). Une revue de la PR a fait retirer de ce motif l'argument « aucune perte d'octets », qui
était faux en composition. Les deux sévérités figurent au registre, et le motif est dans l'issue.

**Ce que la disposition change.** Le § 6.9 dit désormais ce que le sceau achète (la non-forgerie) et
ce qu'il n'achète pas (la non-fongibilité, donc pas la résistance au rejeu), et il nomme le **geste
de sortie avec sa CONDITION** : après une restauration d'archive **délibérée**, retirer le témoin ;
sans restauration, ne pas le retirer, car il est alors la seule trace du recul. Le message du refus
porte les deux lectures et la même condition — l'enseigner sans elle désarmerait la détection du
recul réel. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « un témoin REJOUÉ après une
restauration nomme les DEUX lectures et le geste CONDITIONNEL ».

**Ce que la disposition NE change pas, et c'est le résidu.** Le rejeu reste **possible** : un
adversaire qui peut écrire dans l'OPFS peut toujours refabriquer ce refus après chaque restauration.
Aucun octet de format ne bouge, aucun vecteur ne change, et l'ancre monotone n'est pas décidée
(#23).

**[#143](https://github.com/pinfada/railsbox-vault/issues/143) — L'identité logique ne sépare pas un
enregistrement de journal d'un secteur de volume. CORRIGÉ par la
[PR #146](https://github.com/pinfada/railsbox-vault/pull/146).** Le § 5.4 affirmait, à tort, que «
le rang sépare des identités qui partageraient tout le reste » et présentait le rang 0 comme
identifiant sans ambiguïté « un secteur du volume » : le premier enregistrement déposé dans une
charge de journal porte lui aussi le rang 0, sous une identité par ailleurs identique dans le cas
nominal d'une écriture alignée sur 512 octets. Ce n'était donc pas le rang qui séparait les deux
magasins, mais l'empreinte de région (§ 6.8) — absente des trois états `non-fournie`, `sans-racine`
et `migree`, qui restaient exposés à la substitution du contenu d'un secteur par celui, différent,
que le journal détient pour la même adresse et la même génération.

**Ce que la correction ferme** : les enregistrements du journal portent désormais leur propre
étiquette de domaine (§ 5.1 bis), et le format du journal passe de 3 à 4 (§ 6.7). Aucun octet du
volume ne change ; `tests/vectors/format-chiffre-v1.json` reste valide. Les trois états exposés
refusent maintenant un enregistrement épissé — `tests/unit/vm-identite-magasin.test.mjs` › « un
ENREGISTREMENT de journal épissé dans la région et la charge du volume est REFUSÉ ».

**Ce que la correction NE ferme pas, et ce résidu est nommé plutôt que tu.** Des octets
d'enregistrement scellés sous l'étiquette d'un **bloc** restent épissables dans la région et la
charge du volume correspondant, dans les trois mêmes états. Aucune clé ne permet de les resceller,
et fermer ce reste aurait exigé de changer aussi l'étiquette des SECTEURS — c'est-à-dire d'invalider
les vecteurs de l'ADR 0015 et d'imposer un rescellement complet de chaque volume existant.

**Deux façons d'obtenir de tels octets, et la seconde n'est pas temporelle** — une revue a corrigé
ce document sur ce point :

- un journal écrit **avant** le format 4. La migration a lieu à la première réouverture, et le
  vidage qui la termine tronque la charge : après elle, l'OPFS n'en porte plus. Il faut donc en
  détenir une copie prise avant ;
- un journal écrit **aujourd'hui par une session sans source de fraîcheur** (§ 6.7), qui écrit le
  format 2. La borne est donc **conditionnelle**, pas seulement temporelle. Aucun chemin du produit
  n'ouvre ainsi — seuls deux bancs de mesure le font, et `tests/unit/harnais-portes.test.mjs` › «
  aucun OUVREUR SANS FRAÎCHEUR n'est un module de src/ » le tient par inspection de source plutôt
  que par cette phrase.

Ce qui est fermé, et c'est l'essentiel du modèle de menace, est l'attaque **continue** sur un volume
du produit : un adversaire qui lit l'OPFS n'y trouve plus d'enregistrement épissable.

**[#144](https://github.com/pinfada/railsbox-vault/issues/144) — Le retour arrière d'une génération
ne demande aucune copie antérieure, et une racine abîmée à côté d'une racine lisible est ignorée.
CORRIGÉ par la [PR #153](https://github.com/pinfada/railsbox-vault/pull/153).** Le § 6.9 et le § 9.1
affirmaient, à tort, que « reculer le volume suppose d'en détenir une copie antérieure, cohérente
avec son journal ». État réel : l'alternance des racines (§ 6.6) conserve sur le support la racine
`s − 1`, authentique et lisible, à l'emplacement `(s − 1) mod 2` — il n'y a donc rien à détenir pour
revenir d'une génération. Écrire des octets quelconques sur l'emplacement de la racine `s`, tant
qu'aucun point de contrôle n'a eu lieu depuis `s − 1`, suffit à rendre `s − 1` de nouveau autorité ;
aucun refus n'était posé pour la racine `s` abîmée à côté d'elle, et les enregistrements de la
génération `s` déjà écrits dans le journal étaient écartés en silence, sous un rapport d'ouverture
qui déclare la fraîcheur `verifiee`.

**Ce que la correction ferme.** Le **témoin décide**, et l'ordre d'écriture du § 6.9 le permet — il
vient après la racine et sa barrière. Un témoin **concordant** avec la racine retenue est une
coupure, et le volume ouvre. Un témoin **absent** devant une racine abîmée à côté d'une racine
retenue est un état **ambigu que rien ne distingue d'un recul**, et il est désormais **REFUSÉ** sous
`VAULT_STORAGE_GENERATION_ROOT_CORRUPT` (§ 10.2), avec un message qui porte les deux lectures. Le
refus ne porte que sur cette **conjonction** : ni un volume neuf, ni un volume restauré, ni un
premier point de contrôle ne la produisent, si bien que le « refuser tout volume sans témoin ne doit
pas changer » du § 6.9 reste vrai. Et la mise au rebut des octets de la génération `s` porte
maintenant son code — `VAULT_STORAGE_GENERATION_DISCARDED` est publié **dès qu'un octet est
écarté**, y compris dans le chemin `rejouee` où il ne l'était pas, ce qui rend vraie la promesse du
§ 10.2. Épreuves : `tests/unit/vm-recul-generation.test.mjs`.

**La proposition n° 1 de l'issue est REFUSÉE, et il faut dire pourquoi.** Refuser dès qu'une racine
abîmée côtoie une racine lisible, sans regarder le témoin, refuserait le cas **normal** que
l'alternance existe pour absorber : une racine déchirée par une coupure pendant sa propre écriture.
Le coût serait « restaurer une sauvegarde » à chaque coupure au mauvais instant — c'est-à-dire une
perte de données réelle échangée contre une détection que le témoin donne déjà.

**Ce que la correction NE ferme pas, et une revue de la PR l'a établi par reproduction.** La règle
fait décider le témoin : elle tient contre l'adversaire qui le **neutralise**, et **pas** contre
celui qui le **rejoue** — c'est-à-dire contre #142, accepté dans la même correction. La composition
des deux constats se reproduit ainsi, sans la clé :

1. archiver `<volume>.temoin` à la séquence `s − 1` : **62 octets**, pris longtemps à l'avance ;
2. laisser la génération `s` être validée et **acquittée** au guest ;
3. écrire 512 octets quelconques sur l'emplacement `s mod 2`, puis **remettre** l'archive.

Le témoin **concorde** alors avec la racine retenue, l'ouverture conclut « coupure », le rapport
publie `etat: rejouee`, `fraicheurRegion: verifiee`, `code: VAULT_STORAGE_GENERATION_DISCARDED`, et
les écritures acquittées de la génération `s` **ont disparu du volume** après le rangement — sans
qu'aucun refus ne soit levé. **Ce n'est pas une course** : le témoin n'est pas perdu au bon instant,
il est archivé à l'avance. C'est le **retour arrière complet du § 9.1**, déjà accepté comme
indétectable, obtenu à moindre coût — 62 octets au lieu d'une copie cohérente du volume et du
journal. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « #142 COMPOSÉ à #144 : un témoin
ARCHIVÉ puis rejoué fait perdre une génération acquittée sous « verifiee » ».

Le refus **sur-détecte** par ailleurs : abîmer la racine la plus ancienne, celle qui ne fait pas
autorité, produit le même refus, parce qu'une racine illisible n'a plus de séquence lisible (§ 6.9).

Le compteur de scellements cumulés (§ 4.5) recule toujours avec la racine retenue ; ce n'est pas une
réutilisation de nonce — les nonces sont tirés (§ 4.2) —, et le § 4.5 le dit désormais plutôt que de
le laisser deviner.

Enfin, la phrase de l'issue « l'état publié est `verifiee` » est **exacte**, et la première
rédaction de cette correction la restreignait à tort au chemin « sans témoin » : `verifiee` est
publié aussi **avec** un témoin à `s − 1`, dans la reproduction ci-dessus. Ce qui est vrai est plus
étroit — avec un témoin resté à `s`, le plancher de séquence refuse et rien n'est publié. La
correction est portée dans l'issue.

**[#145](https://github.com/pinfada/railsbox-vault/issues/145) — « Supprimer et recréer » ne retire
aucun voisin, et le volume recréé est refusé. CORRIGÉ par la
[PR #157](https://github.com/pinfada/railsbox-vault/pull/157).** Le § 6.3 et le § 10.2 affirmaient,
à tort, que le message de `VAULT_STORAGE_VOLUME_INCOMPLET` nomme « le seul remède vrai : supprimer
et recréer » sans que ce geste existe dans `src/` ni que ce document dise ce qu'il faut supprimer.
Le point 1 du constat était PÉRIMÉ : `removeOpfsVolume(name)` (`src/vm/opfs-sync-access.mjs`) existe
en production et retire déjà les voisins d'un volume explicitement supprimé — `.gen`, `.temoin`,
`.cles`, `.instantane`. Ce qui restait vrai, et qui est corrigé ici : un exploitant qui supprime
seulement le fichier `<volume>` à la main, sans passer par `removeOpfsVolume`, puis en recrée un du
même nom, laissait `<volume>.temoin` en place ; le volume neuf était scellé sous un identifiant
neuf, et sa première ouverture échouait sur le sceau du témoin, qui porte l'ancien identifiant
(`VAULT_STORAGE_SCEAU_REFUSE`).

**Ce que la correction ferme.** La NAISSANCE d'un volume (`naissance === true`,
`src/vm/opfs-volume-ouverture.mjs`) retire elle-même ses voisins orphelins — `.gen`, `.temoin`,
`.instantane`, `.migration` — AVANT que la récupération de sa génération ne les lise, en EXCLUANT
l'enveloppe de clé `.cles` (§ 6.9, § 11, ADR 0020 : une naissance qui la retirerait détruirait
l'enveloppe qu'un chemin de création chiffrée vient de poser pour ce même volume). Le retrait est
publié dans `describe().voisinsRetires`, jamais en silence. Épreuves :
`tests/unit/vm-naissance-voisins-orphelins.test.mjs` › « la naissance retire les voisins orphelins
.gen, .temoin et .instantane, et rouvre sans refus » et « la naissance NE retire PAS l'enveloppe de
clé, écrite avant elle (ADR 0020) ». Le cas « volume neuf homonyme » du constat disparaît (§ 6.9) ;
le § 11 ne compte plus « supprimer et recréer » parmi les remèdes non outillés.

`docs/revue-externe/registre.md` porte ces **quatre lignes** : #143, #144 et #145 disposés « corrigé
», #142 disposé « accepté » avec sa sévérité révisée. Ces quatre constats viennent d'une pré-revue
INTERNE traitée comme externe ; la moitié 2 de #20 a eu lieu depuis, et ses deux constats sont au §
9.7.

### 9.7 Constats de la revue externe, 10 septembre 2026

La moitié 2 de [#20](https://github.com/pinfada/railsbox-vault/issues/20) a eu lieu le 10 septembre
2026, sur `main` à l'empreinte `aa6be826ad0e14162a9e06e5`. Son texte intégral est versé au dépôt en
[`docs/revue-externe/revue-2026-09-10.md`](revue-externe/revue-2026-09-10.md), et sa nature est
écrite au registre sans formule d'audit : **une revue adverse assistée par un agent d'IA distinct
des agents du dépôt, ni tiers humain ni cabinet indépendant.** Le mainteneur décide le 12 septembre
2026 que son indépendance factuelle satisfait la condition « tiers » de #20 ; cette décision ne la
transforme pas en audit humain ou de cabinet et ne lève aucun gate à elle seule.

**Verdict du relecteur : le gate « données sensibles » ne doit pas être ouvert.** Deux constats. Le
CRITICAL est **CORRIGÉ** depuis le 10 septembre 2026
([PR #184](https://github.com/pinfada/railsbox-vault/pull/184),
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)) ; le HIGH est **CORRIGÉ**
depuis le 11 septembre 2026, en DEUX tranches.

**Ce que chaque tranche a livré.** La tranche T2a
([ADR 0035](decisions/0035-format-de-volume-v4-et-migration.md)) livre le format v4 : la DEK est
importée en matériau HKDF — WebCrypto refuse alors de chiffrer avec, et les trois moteurs le
mesurent —, et les domaines `volume`, `journal` et `instantane` scellent chacun sous sa propre clé,
à côté du domaine `archive` que T1 avait posé. Le compteur d'une clé compte enfin toutes les
invocations sous elle, et une session qui ne peut pas le publier dans une racine n'a plus le droit
de sceller. Restaient alors sous la DEK la racine d'une page de `<volume>.cles` et la section de
récupération d'une archive.

La tranche **T2b** ([ADR 0036](decisions/0036-page-d-enveloppe-v2-et-budgets-exhaustifs.md)) les
livre : la page d'enveloppe passe en **v2** — sel de 32 octets tiré, octet de domaine —, les
domaines `enveloppe` et `recuperation` complètent la liste, qui est CLOSE à six, et une page v1 est
rescellée à la première ouverture réussie. Le troisième chemin hors transaction clôt par une racine,
et le CLIQUET d'inspection de source refuse désormais qu'un chemin de production du format v4
construise une clé AES-GCM depuis une clé de volume. La phrase « la DEK n'est plus jamais passée à
AES-GCM » est donc vraie de tout ce que ce runtime ÉCRIT ; ce qui reste est nommé au § 12 et n'est
pas un chemin v4 : ouvrir un volume **v3**, pour le migrer ou pour l'exporter avant de le migrer.

**[#181](https://github.com/pinfada/railsbox-vault/issues/181) — Une archive accepte un mélange de
secteurs provenant de plusieurs états, et la première ouverture restaurée le rend en clair.
CRITICAL, CORRIGÉ.** La restauration retire le journal et le témoin avant de recopier le volume (§
7.5) ; l'ouverture suivante traite l'absence de racine comme une première ouverture ; et l'archive
n'est authentifiée par rien d'autre qu'un SHA-256 **recalculable** (§ 7.5, § 13 question n° 6). Le
relecteur a exécuté le mélange : trois états A, B, C du même volume, puis le secteur 0 de A remis
dans le fichier de C, puis une archive reconstruite avec le format public. Le résultat est
`{ "archiveVerifiee": true, "fraicheur": "sans-racine", "etatJamaisProduit": true }` : chaque
secteur reste authentique isolément, leur combinaison ne correspond à **aucun état validé**, aucun
refus n'est produit, et le clair est rendu.

**Ce que ce constat contredit dans ce document.** Le § 8, propriété P5, écrit que le format refuse «
jamais un mélange » ; la § 9.1 assume le retour arrière COMPLET du support, pas un état **jamais
produit**. Un adversaire qui détient deux archives ou deux captures chiffrées du même volume revient
sélectivement sur des pages de base de données **sans connaître la clé**. La § 7.5 dit que
l'empreinte « atteste qu'une archive n'a pas été abîmée » : c'est vrai, et c'est précisément
insuffisant.

**Ce que le dépôt a FAIT, et où c'est écrit.** L'archive passe en **version 3** et porte un
**engagement authentifié** sur le fichier chiffré entier, son identité, sa géométrie et sa version
de récupération, scellé sous une clé du domaine `archive` dérivée de la DEK ; la restauration le
dépose à côté du volume, la première ouverture le **vérifie avant tout clair**, écrit la racine
initiale et retire le voisin. Les archives v1 et v2 sont **refusées** : rien n'est publié, il n'y a
aucune compatibilité à préserver. Et, pour que le refus d'un engagement ABSENT soit atteignable,
**aucun volume légitime n'est sans racine** — la création en écrit une avant `VLTSEAL1` (§ 7.1), la
migration v2 → v3 aussi. Le détail est au § 7.5 et à
l'[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md) ; la hiérarchie de clés qui
lui donne son domaine est l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md).

**Ce qu'elle NE corrige pas, et qui reste écrit ici.** Le rejeu d'une archive **entière et
cohérente** reste indétectable : c'est le retour arrière complet du § 9.1, inchangé, et l'ancrage
monotone reste renvoyé à [#23](https://github.com/pinfada/railsbox-vault/issues/23). Les épreuves
sont dans `tests/unit/vm-archive-melange-etats.test.mjs` — le mélange A/C du relecteur, six étapes,
et son revers « restauration puis voisin retiré ».

**[#182](https://github.com/pinfada/railsbox-vault/issues/182) — Le budget AES-GCM n'est pas global
à la clé. HIGH, OUVERT.** Le § 4.5 affirme compter « toutes les invocations sous une clé », et c'est
l'exigence du § 8.3 de NIST SP 800-38D. Le produit compte par **instance de scellement** : les
volumes de coquille et d'application emploient la même DEK, chaque instance repart de zéro, la
coquille et l'installation initiale s'ouvrent hors transaction, et les deux rescellements de racine
d'enveloppe — mutation de `<volume>.cles`, export avec récupération — se font directement sous la
DEK, hors compteur. Le test minimal du relecteur rend
`{ "memeCle": true, "compteurVolumeA": 1, "compteurVolumeB": 1, "sommeReelle": 2 }`.

**Ce que ce constat contredit dans ce document.** La phrase « ce que le compteur compte » du § 4.5,
et la probabilité de collision de 2^-35 qu'il publie : elle est calculée pour 2^31 invocations sous
UNE clé, et rien dans le mécanisme implémenté ne borne le nombre réel d'invocations sous la DEK.
**Ce n'est pas une réutilisation de nonce observée** — les nonces sont tirés (§ 4.2) —, c'est une
borne annoncée que le mécanisme ne tient pas. La sous-estimation hors transaction que le § 4.5 avoue
déjà en est un cas particulier, pas l'ensemble du défaut.

**Ce que le dépôt fera, et où c'est écrit.**
L'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) fait de la DEK une clé
**maîtresse** qui ne chiffre plus rien : chaque domaine — `volume`, `journal`, `instantane`,
`enveloppe`, `archive`, `recuperation` — scelle sous une clé AEAD dérivée par HKDF-SHA-256, liée au
domaine, au volume et à la version de format. Deux domaines gardent un compteur, désormais exhaustif
parce qu'une clé n'a plus qu'un consommateur ; les quatre autres prennent une clé à **usage unique**
avec un sel tiré, et n'ont plus besoin de compter. C'est une **version de format v4** avec migration
reprenable, sur le modèle de la v2 → v3 (§ 7.4).

**Ce que ces deux constats font au reste du dossier.** La question n° 1 (AES-GCM-SIV) est
**rouverte** par le relecteur ; la question n° 4 (le budget) reçoit une réponse en deux moitiés — la
PORTÉE est tranchée par l'ADR 0033, l'EMPLACEMENT reste ouvert ; la question n° 6 est tranchée
contre la position du dépôt. Les neuf réponses sont reprises une par une au § 13, et la § 14 porte
les deux constats parmi ce que ce dossier ne prouve pas.

## 10. Les codes de refus, et la conduite

Un refus porte un **code stable**, un message en français, un **contexte** sérialisable, et il
survit au passage d'un `postMessage`.

### 10.1 La famille du format chiffré

Elle décrit une propriété de **sécurité**.

| Code                                | Ce qu'il constate                                                                               | Conduite                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `VAULT_CRYPTO_SCEAU_REFUSE`         | l'étiquette ne vérifie pas. **Modification et déplacement, indiscernables.** Aucun clair rendu. | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_IDENTITE_INCOHERENTE` | l'en-tête AUTHENTIQUE d'une racine décrit un autre volume, format ou taille                     | ouvrir le bon volume, ou la bonne clé        |
| `VAULT_CRYPTO_REJEU`                | séquence ou génération authentifiée, mais ANTÉRIEURE au plancher exigé                          | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_TRONCATURE`           | le compte ou la longueur trouvés diffèrent de ce que la racine authentifie                      | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_MELANGE`              | le compte est juste, l'empreinte ne l'est pas : une entrée vient d'ailleurs                     | restaurer une sauvegarde                     |
| `VAULT_CRYPTO_ORDRE_INVALIDE`       | rangs non strictement croissants, ou séquence de racine qui ne dépasse pas la précédente        | corriger l'appelant — aucun octet produit    |
| `VAULT_CRYPTO_BUDGET_DE_CLE`        | le budget de 2^31 scellements de cette clé est atteint                                          | **changer de clé de volume** (§ 11)          |
| `VAULT_CRYPTO_MALFORME`             | entrée structurellement inadmissible : largeur, type, longueur, attente oubliée                 | corriger l'appelant — faute de programmation |
| `VAULT_CRYPTO_ALGORITHME_INCONNU`   | un nom d'algorithme autre que `aes-256-gcm`                                                     | le manifeste ment sur son algorithme         |

**Les trois derniers ne nomment aucune menace, et c'est délibéré** : ils répondent d'une violation
de contrat par l'appelant, en amont de toute menace. Confondre les deux ferait croire qu'un
adversaire est à l'œuvre là où c'est une faute de programmation, et l'inverse.

**Un code RETIRÉ, nommé ici pour qu'un relecteur ne le cherche pas :**
`VAULT_CRYPTO_NONCE_REUTILISE` **n'existe plus**. Il a été renommé `VAULT_CRYPTO_ORDRE_INVALIDE` le
jour où le nonce a cessé d'être dérivé : un rang répété ne réémet plus de nonce, et garder l'ancien
nom aurait fait affirmer au format une conséquence qu'il ne produit plus. Le seul endroit du dépôt
où la chaîne subsiste est le commentaire qui documente ce renommage.

### 10.2 La famille du stockage

Elle décrit un état du **support**. Les refus du format y sont traduits, et la cause d'origine est
**conservée dans le contexte** : un refus de sécurité qui perdrait sa cause en changeant de couche
ne serait plus qu'une panne.

| Code du format                      | Code de stockage                   |
| ----------------------------------- | ---------------------------------- |
| `VAULT_CRYPTO_SCEAU_REFUSE`         | `VAULT_STORAGE_SCEAU_REFUSE`       |
| `VAULT_CRYPTO_IDENTITE_INCOHERENTE` | `VAULT_STORAGE_IDENTITE_VOLUME`    |
| `VAULT_CRYPTO_REJEU`                | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_TRONCATURE`           | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_MELANGE`              | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_ORDRE_INVALIDE`       | `VAULT_STORAGE_GENERATION_CORRUPT` |
| `VAULT_CRYPTO_BUDGET_DE_CLE`        | `VAULT_STORAGE_BUDGET_DE_CLE`      |

`VAULT_CRYPTO_MALFORME` et `VAULT_CRYPTO_ALGORITHME_INCONNU` ne sont **pas** traduits : les habiller
en erreur de stockage ferait croire à un support abîmé là où c'est un bogue.

**`VAULT_STORAGE_LECTURE_SEULE` n'est la traduction de rien** (#182, ADR 0033, décision 4) : il ne
décrit ni un support abîmé ni une propriété du format violée, mais un RÉGIME de session. Une
ouverture qui ne peut écrire aucune racine ne publierait ses scellements dans aucun compteur ; elle
n'a donc pas le droit de sceller, et le refus tombe avant que le modèle ne produise un octet. Le
remède n'est pas de réessayer : il est d'ouvrir le volume par un chemin qui sait dater, ou de se
contenter de lire.

**AUCUN chemin du produit ne le lève aujourd'hui**, et il vaut mieux l'écrire que le laisser
découvrir : le seul candidat est l'ouverture du volume de coquille, qui ÉCRIT (§ 4.5). Ce code est
donc ÉPROUVÉ et inemployé — l'inverse d'une garde décorative, qui serait employée et ne mordrait
pas. Il attend son appelant, et T2b le lui donnera.

**`VAULT_STORAGE_DOMAINE_ABSENT_DU_FORMAT` dit ce que `LECTURE_SEULE` disait de trop** (revue de
sécurité de la PR #186, constat 3 ; revue de format, constat 5). Un volume antérieur à la v4 n'a pas
de clé maîtresse, donc pas de domaine `instantane` : lui demander une capture est refusé. Ce refus
était rendu sous `LECTURE_SEULE`, et c'était faux deux fois — cette session-là a le droit de
sceller, et elle scelle tout le reste ; et le refus tombe aussi sur une OUVERTURE d'instantané, qui
ne scelle rien. Le remède, surtout, n'est pas celui que `LECTURE_SEULE` annonce : ici il faut
**migrer**, pas rouvrir autrement. Ce qui manque n'est pas un droit de la session, c'est une
propriété du FORMAT, et c'est ce que le code nomme désormais.

**`VAULT_STORAGE_BUDGET_DE_CLE` couvre désormais DEUX budgets** — celui du domaine `volume` et celui
du domaine `journal` — et le code reste UN : le remède est le même des deux côtés, et c'est le
CONTEXTE qui dit quel domaine a atteint son plafond. Deux codes auraient nommé deux situations là où
il n'y a qu'une règle.

**Quatre causes tombent sur un seul code, et c'est une décision** : la conduite dépend du
**remède**, pas du diagnostic, et six causes qui appellent toutes « restaurer une sauvegarde » ne
justifient pas six conduites. Deux causes supplémentaires, portées dans le contexte et non par un
code — **ce ne sont PAS des codes**, malgré la forme : ce sont les valeurs des constantes
`CAUSE_FRAICHEUR_REGION` et `CAUSE_TEMOIN` — : `VAULT_FRAICHEUR_REGION` (région relue ≠ empreinte
scellée ; racine sans empreinte sous un témoin actif) et `VAULT_TEMOIN_SEQUENCE` (journal sans
racine sous un témoin ; témoin de format inconnu).

Le reste de la famille, avec sa conduite :

| Code                                    | Ce qu'il constate                                                                                                                                                  | Conduite                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `VAULT_STORAGE_SCEAU_REFUSE`            | un sceau de secteur, d'enregistrement ou de racine ne vérifie pas                                                                                                  | restaurer une sauvegarde                         |
| `VAULT_STORAGE_IDENTITE_VOLUME`         | l'identité présentée ne correspond pas à celle qui est authentifiée                                                                                                | ouvrir le bon volume, ou la bonne clé            |
| `VAULT_STORAGE_BUDGET_DE_CLE`           | budget de scellements de la clé atteint                                                                                                                            | changer de clé de volume                         |
| `VAULT_STORAGE_CLE_REQUISE`             | volume v3 présenté SANS clé, ou clé de longueur inadmissible                                                                                                       | fournir la clé — le produit n'en fabrique aucune |
| `VAULT_STORAGE_VOLUME_INCOMPLET`        | création ou conversion interrompue : la marque de scellement manque                                                                                                | **supprimer et recréer**, pas restaurer          |
| `VAULT_STORAGE_VOLUME_SANS_RACINE`      | aucune racine ne fait autorité, et rien n'autorise à en écrire une (#181)                                                                                          | restaurer depuis l'archive                       |
| `VAULT_STORAGE_ENGAGEMENT_INVALIDE`     | un engagement d'archive est présent et n'autorise pas cette ouverture (#181)                                                                                       | restaurer de nouveau depuis l'archive            |
| `VAULT_STORAGE_CREATION_NON_CONFIRMEE`  | la datation d'une création ne peut pas confirmer ce que le versement a écrit : empreinte absente, ou fichier trouvé différent (#181, § 7.1)                        | recommencer l'installation                       |
| `VAULT_STORAGE_GENERATION_CORRUPT`      | une génération VALIDÉE ne concorde plus (rejeu, troncature, mélange, fraîcheur)                                                                                    | restaurer une sauvegarde                         |
| `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` | une racine abîmée dont rien ne dit ce qu'elle validait : soit aucune n'est lisible, soit une racine est retenue mais AUCUN témoin ne dit laquelle faisait autorité | restaurer une sauvegarde                         |
| `VAULT_STORAGE_GENERATION_DISCARDED`    | des octets déposés au-delà de ce que la racine retenue authentifie ont été écartés. **Ce n'est pas une panne** : c'est le résultat normal d'une coupure            | rien — publié, jamais tu                         |
| `VAULT_STORAGE_GENERATION_OVERFLOW`     | la charge déposée depuis le dernier point de contrôle dépasse le plafond de 16 Mio                                                                                 | le guest doit franchir une barrière              |
| `VAULT_STORAGE_GENERATION_PENDING`      | un geste exigeant une génération validée a été demandé sur une génération en cours                                                                                 | franchir la barrière d'abord                     |
| `VAULT_STORAGE_GEOMETRY_MISMATCH`       | la géométrie du support diffère de celle de la session                                                                                                             | exporter puis migrer — jamais retailler          |
| `VAULT_STORAGE_QUOTA_EXCEEDED`          | le quota de stockage de l'origine est épuisé                                                                                                                       | libérer de la place, puis réessayer              |
| `VAULT_STORAGE_QUIESCE`                 | l'adaptateur est quiescé : une capture d'instantané est en cours                                                                                                   | réessayer après la capture                       |
| `VAULT_STORAGE_OUT_OF_RANGE`            | lecture ou écriture hors de la géométrie déclarée                                                                                                                  | corriger l'appelant                              |
| `VAULT_STORAGE_SHORT_READ`              | le support a rendu moins d'octets que demandé                                                                                                                      | réessayer, puis diagnostiquer le support         |
| `VAULT_STORAGE_PARTIAL_WRITE`           | le support a accepté moins d'octets que demandé                                                                                                                    | réessayer, puis diagnostiquer le support         |
| `VAULT_STORAGE_FLUSH_FAILED`            | la barrière de durabilité n'a pas abouti — **rien n'est acquitté**                                                                                                 | réessayer ; ne rien annoncer durable             |
| `VAULT_STORAGE_HANDLE_LOST`             | le handle exclusif a disparu sous le volume ouvert                                                                                                                 | rouvrir le volume                                |
| `VAULT_STORAGE_CLOSED`                  | opération demandée après fermeture du volume                                                                                                                       | corriger l'appelant                              |
| `VAULT_STORAGE_BUSY`                    | un autre détenteur possède déjà l'exclusivité                                                                                                                      | fermer l'autre onglet ou attendre                |
| `VAULT_STORAGE_UNSUPPORTED`             | capacité absente du moteur — **jamais remplacée par un repli silencieux**                                                                                          | changer de moteur                                |
| `VAULT_STORAGE_SUPPORT_FAILURE`         | échec du support non classable ci-dessus — nommé, jamais deviné                                                                                                    | diagnostiquer le support                         |

**Deux codes que #144 a précisés, et ce qui a changé.** `VAULT_STORAGE_GENERATION_ROOT_CORRUPT`
couvrait le seul état « aucune racine lisible ». Il en couvre un second, de même nature — une racine
abîmée dont on ne sait pas ce qu'elle validait —, et c'est le refus que le § 6.9 décrit : sans
témoin, une racine abîmée à côté d'une racine retenue ne se distingue pas d'un recul d'une
génération. Le code n'est pas dédoublé parce que la conduite est la même, et le § 10.2 le dit ici
plutôt que de le laisser deviner. `VAULT_STORAGE_GENERATION_DISCARDED` était promis « publié, jamais
tu » et ne l'était que dans l'état `ecartee` : l'état `rejouee` écarte aussi les octets déposés
au-delà de ce que la racine retenue authentifie, et il les écartait **sans un mot**. Le rapport
d'ouverture porte désormais ce code **dès qu'un octet est écarté**, quel que soit l'état. Aucun code
n'est retiré, et aucun n'est ajouté. Épreuve : `tests/unit/vm-recul-generation.test.mjs` › « une
coupure qui déchire la racine `s` laisse le témoin à `s − 1` : le volume ROUVRE, et la mise au rebut
est PUBLIÉE ».

**« Supprimer et recréer », le remède de `VAULT_STORAGE_VOLUME_INCOMPLET`, est OUTILLÉ (#145) : voir
§ 6.3.** `removeOpfsVolume(name)` retire le volume et ses voisins ; une naissance sur un nom dont
seul le fichier de volume a été supprimé à la main retire elle-même ces mêmes orphelins, hors
enveloppe de clé — § 6.9 en donne la distinction avec un écart de séquence réel.

**Deux refus retirés le 6 septembre 2026 (#139)** : `VAULT_ARCHIVE_VOLUME_CHIFFRE` et
`VAULT_IMPORT_VOLUME_CHIFFRE` n'existent plus. Voir § 12, écart 2.

**Deux codes AJOUTÉS le 10 septembre 2026 (#181,
[PR #184](https://github.com/pinfada/railsbox-vault/pull/184),
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md)), et ce qui les sépare.**
`VAULT_STORAGE_VOLUME_SANS_RACINE` dit qu'il n'y avait RIEN à présenter : ni racine, ni engagement.
`VAULT_STORAGE_ENGAGEMENT_INVALIDE` dit que ce qui a été présenté ne tient pas. Les remèdes ne sont
pas les mêmes — dans le premier cas le volume est antérieur à la règle, ou son voisin a disparu ;
dans le second, l'archive ou le volume restauré a été altéré. Le second ne rend **qu'une seule
cause**, et c'est délibéré : étiquette forgée, sel modifié, descripteur contredit, empreinte qui ne
concorde pas — les distinguer donnerait à un adversaire un oracle sur ce qu'il a manqué. Le CONTEXTE
porte le détail pour l'exploitant ; le CODE est le même. **L'indistinction porte sur le code et le
message, PAS sur la durée** : voir le § 7.3 et le § 9.4, où la mesure et le compromis sont écrits.

**Un TROISIÈME code ajouté le 11 septembre 2026** (revue de sécurité de la PR #184, constat 1) :
`VAULT_STORAGE_CREATION_NON_CONFIRMEE`. Il ne parle d'aucune archive, et c'est ce qui le sépare des
deux précédents — il tombe sur le chemin de la CRÉATION, quand un versement hors transaction a
relâché le fichier et que la datation qui le rouvre ne retrouve pas ce qui y avait été écrit (§
7.1). Son remède n'est pas de restaurer mais de **recommencer l'installation** : rien n'est déclaré
installé, et l'archive n'est pour rien dans cette affaire.

**Les trois ont une CONDUITE écrite pour la personne qui les lira**
(`src/coquille/interface-de-deverrouillage.mjs`). Le message de cette table est celui de
l'exploitant — il cite un numéro d'issue et le nom d'un fichier voisin ; ce que l'utilisateur voit
dit un geste, et rien d'autre. Le contexte structuré du refus (`{ voisin, champ, taille }`) reste
dans la coquille et ne franchit jamais le port : l'ADR 0028 n'est pas touché. Épreuve :
`tests/unit/coquille-deverrouillage.test.mjs` › « la conduite d'un refus de #181 dit un GESTE, et
jamais ce que l'exploitant lit ».

### 10.3 Les refus des voisins hors périmètre

Ces deux familles ne relèvent pas de cette revue (§ 11). Elles sont listées **exhaustivement** pour
qu'un relecteur qui les rencontre sache qu'elles existent et qu'elles ne sont pas de son ressort.

**Enveloppe de clé** — `<volume>.cles` : `VAULT_ENVELOPPE_ABSENTE` (aucune enveloppe, ce qui n'est
pas « clé invalide »), `VAULT_ENVELOPPE_CLE_REFUSEE` (clé de déverrouillage inconnue ou révoquée —
le même refus pour les deux, indiscernable, et **le même nombre d'appels AEAD** :
`tests/unit/vm-enveloppe-operations.test.mjs` › « clé RÉVOQUÉE et clé INCONNUE rendent le même
refus, indiscernable »), `VAULT_ENVELOPPE_DERNIER_EMPLACEMENT` (révoquer le dernier emplacement est
refusé — un volume sans issue n'est pas un état acceptable ; il ne s'applique PAS à la révocation
d'urgence de l'[ADR 0026](decisions/0026-revocation-d-urgence-et-page-libre.md), qui laisse toujours
exactement un emplacement et n'a donc aucun refus propre), `VAULT_ENVELOPPE_EMPLACEMENT_INCONNU`,
`VAULT_ENVELOPPE_IDENTITE`, `VAULT_ENVELOPPE_ILLISIBLE`, `VAULT_ENVELOPPE_MALFORME`,
`VAULT_ENVELOPPE_MELANGE`, `VAULT_ENVELOPPE_PLEINE`, `VAULT_ENVELOPPE_PRESENTE` (#159 : créer une
enveloppe sur un fichier `.cles` déjà présent est refusé, quelle que soit la version de ses pages —
le seul chemin vers une création sur un emplacement occupé est le retrait explicite de la
[Décision 1](decisions/0020-enveloppe-de-cle.md#décision-1--le-fichier-volumecles-dans-lorigine-de-confiance)),
`VAULT_ENVELOPPE_RACINE_REFUSEE`, `VAULT_ENVELOPPE_REJEU`, `VAULT_ENVELOPPE_TRONCATURE`.

**Dérivation des clés de déverrouillage** : `VAULT_DERIVATION_ANNULEE`,
`VAULT_DERIVATION_ARGON2_INDISPONIBLE`, `VAULT_DERIVATION_CODE_DEJA_RENDU` (un code de récupération
n'est rendu qu'une fois, et le produit ne le conserve nulle part — ADR 0025),
`VAULT_DERIVATION_CODE_MAL_RECOPIE` (la saisie n'est pas un code de ce produit : longueur, symbole
étranger, somme de contrôle, bourrage — un refus qui ne dépend QUE de la saisie, jamais du volume ni
de l'enveloppe, et qui n'est donc pas un oracle), `VAULT_DERIVATION_PARAMETRES_REFUSES` (plancher de
coût Argon2id vérifié à l'écriture ET à la lecture), `VAULT_DERIVATION_PHRASE_REFUSEE`,
`VAULT_DERIVATION_PRF_IGNOREE`, `VAULT_DERIVATION_PRF_INDISPONIBLE`,
`VAULT_DERIVATION_TYPE_INCONNU`.

Un code de récupération ÉTRANGER — bien formé, somme de contrôle juste — ne relève d'aucun de ces
refus : il dérive une autre clé, et c'est `VAULT_ENVELOPPE_CLE_REFUSEE` qui tombe, indiscernable
d'une clé révoquée.

Aucun repli automatique entre ces refus, et aucun compteur d'échec persisté.

### 10.4 Les refus de la migration, de l'export/restauration et du manifeste

Ces trois gestes sont, contrairement aux deux familles du § 10.3, **dans le périmètre** de cette
revue (§ 3, § 6.10, § 7.4, § 7.5) : ils n'ont pas leur place au § 10.3, et le § 10 ne peut pas les
laisser sans code sans se contredire lui-même.

**La migration (§ 7.4).** Famille `VAULT_MIGRATION_*`, distincte du stockage : le remède dépend de
ce qui a échoué, pas d'un état générique du support.

| Code                                     | Ce qu'il constate                                                                                                                                   | Conduite                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `VAULT_MIGRATION_NO_PATH`                | aucune étape enregistrée ne relie le format du volume au format demandé                                                                             | migrer vers un format intermédiaire connu      |
| `VAULT_MIGRATION_DOWNGRADE_REFUSED`      | le format demandé est ANTÉRIEUR à celui du volume                                                                                                   | une migration ne descend jamais                |
| `VAULT_MIGRATION_BACKUP_REQUIRED`        | ni sauvegarde vérifiée, ni consentement nommé                                                                                                       | fournir une sauvegarde vérifiée                |
| `VAULT_MIGRATION_BACKUP_MISMATCH`        | l'archive présentée comme sauvegarde ne décrit pas ce volume dans son état courant                                                                  | fournir la bonne sauvegarde                    |
| `VAULT_MIGRATION_JOURNAL_MALFORMED`      | le journal de reprise existe mais ne fait pas autorité (illisible, ou incohérent avec le manifeste, ou visant un format que le volume ne porte pas) | ne pas deviner : restaurer une sauvegarde      |
| `VAULT_MIGRATION_GEOMETRY_MISMATCH`      | le manifeste dont part la migration ne décrit pas la géométrie réelle du support                                                                    | corriger la cible ou repartir d'une sauvegarde |
| `VAULT_MIGRATION_VERIFICATION_FAILED`    | le manifeste relu depuis le support ne rend pas les octets inscrits                                                                                 | restaurer une sauvegarde                       |
| `VAULT_MIGRATION_STEP_UNAVAILABLE`       | l'étape existe dans la chaîne, mais son exécution n'est pas fournie par cette version du runtime                                                    | mettre à jour le runtime                       |
| `VAULT_MIGRATION_CONVERSION_INCOHERENTE` | le support contredit ce que le journal de reprise déclare                                                                                           | ne pas deviner : restaurer une sauvegarde      |

Les refus de compatibilité du manifeste (`VAULT_MANIFEST_FORMAT_TOO_NEW`, `_IDENTITY_MISMATCH`,
`_UNIDENTIFIED`) ne sont **pas** reconditionnés dans cette famille : ils remontent tels quels.

**L'export et la restauration (§ 7.5).** Deux familles distinctes, l'une pour l'INTÉGRITÉ d'une
archive, l'autre pour l'écriture de sa cible.

| Code                                 | Ce qu'il constate                                                                                                                                                                                                                                                             | Conduite                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `VAULT_ARCHIVE_MALFORMED`            | l'entrée n'est pas structurellement une archive : marqueur absent, en-tête illisible, version non prise en charge, champ `recovery` absent d'une v2 ou déclaré par une v1, octets au-delà de la fin déclarée                                                                  | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_TRUNCATED`            | l'archive est plus courte que ce que son en-tête déclare                                                                                                                                                                                                                      | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_DIGEST_MISMATCH`      | l'empreinte recalculée du CONTENU diffère de celle inscrite                                                                                                                                                                                                                   | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_GEOMETRY_MISMATCH`    | la longueur du contenu contredit la géométrie du manifeste ou de l'en-tête                                                                                                                                                                                                    | l'archive est inexploitable                                |
| `VAULT_ARCHIVE_RECUPERATION_ALTEREE` | l'empreinte recalculée de la SECTION DE RÉCUPÉRATION diffère de celle inscrite (#149)                                                                                                                                                                                         | réexporter : les données, elles, sont peut-être intactes   |
| `VAULT_ARCHIVE_RECUPERATION_REFUSEE` | la section n'est pas une enveloppe de récupération SEULE — illisible, mauvaise taille, emplacement d'un autre type que 4, descripteur ou identité de volume qui ne s'accordent pas avec la page (#149)                                                                        | ne pas restaurer : la provenance de l'archive est en cause |
| `VAULT_ARCHIVE_VERSION_NON_LUE`      | l'archive porte une version que ce runtime ne lit pas — v1, v2, ou une version future (#181). Distinct de `MALFORMED` : le conteneur est reconnu, et c'est sa VERSION qui est refusée                                                                                         | réexporter depuis le volume                                |
| `VAULT_ARCHIVE_ENGAGEMENT_ABSENT`    | une archive v3 ne déclare aucun engagement (champ ABSENT), en déclare un illisible, en déclare un **là où le volume est antérieur à v3**, ou décrit un volume v3 sans identifiant (#181). La forme LÉGITIME d'un volume antérieur est `"engagement": null`, explicite — § 7.5 | ne pas restaurer : l'archive n'atteste rien                |
| `VAULT_IMPORT_TARGET_NOT_EMPTY`      | la cible porte déjà un volume, jamais écrasée sans consentement explicite                                                                                                                                                                                                     | choisir une autre cible ou consentir                       |
| `VAULT_IMPORT_SPACE_INSUFFICIENT`    | l'espace estimé est inférieur au volume à restaurer, refusé AVANT toute mutation                                                                                                                                                                                              | libérer de la place                                        |
| `VAULT_IMPORT_GEOMETRY_MISMATCH`     | la cible ouverte n'a pas la taille du volume de l'archive                                                                                                                                                                                                                     | choisir une cible de la bonne taille                       |
| `VAULT_IMPORT_VERIFICATION_FAILED`   | la relecture du volume restauré ne rend pas l'empreinte de l'archive                                                                                                                                                                                                          | réexporter la source                                       |
| `VAULT_IMPORT_CONSENTEMENT_REQUIS`   | l'archive est ANTÉRIEURE à la version d'enveloppe notée sur la feuille de récupération (#149)                                                                                                                                                                                 | relire la feuille ; à défaut, consentir NOMMÉMENT          |

`VAULT_ARCHIVE_VOLUME_CHIFFRE` et `VAULT_IMPORT_VOLUME_CHIFFRE` ont existé et sont **retirés depuis
le 6 septembre 2026** (#139) — voir § 10.2 et § 12, écart 2 — et n'apparaissent donc pas dans ces
deux tables.

**Une PRÉCÉDENCE, et elle se lit dans la table.** Sur une archive v2 dont la section de récupération
est abîmée, `VAULT_ARCHIVE_DIGEST_MISMATCH` tombe AVANT `VAULT_ARCHIVE_RECUPERATION_ALTEREE` quand
le contenu est abîmé lui aussi : la vérification empreinte le contenu d'abord. C'est voulu — le
contenu est ce que l'archive existe pour porter, et une archive dont le contenu est perdu n'a pas de
récupération à discuter. Et sur la section seule, `ALTEREE` précède `REFUSEE` : une section abîmée
en transport et une section FORGÉE n'appellent pas le même remède — réexporter dans un cas, se
méfier de la provenance dans l'autre.

**Le manifeste (§ 6.10).** Famille `VAULT_MANIFEST_*`, une propriété de compatibilité de format,
distincte du stockage.

| Code                                | Ce qu'il constate                                                                    | Conduite                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `VAULT_MANIFEST_MALFORMED`          | le manifeste lu n'est pas structurellement un manifeste v1                           | corriger ou recréer le manifeste            |
| `VAULT_MANIFEST_FORMAT_TOO_NEW`     | version de format supérieure à ce que ce runtime connaît                             | mettre à jour le runtime                    |
| `VAULT_MANIFEST_FORMAT_TOO_OLD`     | version de format sous le plancher lisible de ce runtime                             | migrer le volume, ou un runtime plus ancien |
| `VAULT_MANIFEST_MIGRATION_REQUIRED` | format lisible mais antérieur au format courant : écriture refusée jusqu'à migration | migrer le volume (§ 7.4)                    |
| `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  | volume écrit par un runtime majeur plus récent : écriture refusée                    | mettre à jour le runtime                    |
| `VAULT_MANIFEST_IDENTITY_MISMATCH`  | l'application en cours ne correspond pas à celle qui possède le volume               | ouvrir depuis la bonne application          |
| `VAULT_MANIFEST_UNIDENTIFIED`       | ouverture en écriture d'un volume sans manifeste connu                               | jamais autorisée (`SEC-UPDATE-001`)         |

### 10.5 La famille de la COQUILLE, et ce qu'elle refuse au document applicatif

Elle décrit une propriété de **frontière**, et non de support : ces refus ne parlent ni d'octets, ni
de volume, ni de clé. Ils disent ce que la coquille de produit refuse au document applicatif servi
par l'origine applicative (#161, [ADR 0028](decisions/0028-coquille-de-produit-et-frontiere.md),
`SEC-ORIGIN-001`). Un relecteur externe les rencontrera dès qu'il ouvrira la coquille : ils sont
donc listés **exhaustivement**, et `tests/unit/dossier-de-revue.test.mjs` échoue sur un code que le
produit rendrait sans que cette table le nomme.

Deux traits gouvernent toute la famille :

- **un refus est TYPÉ, jamais un silence.** C'est l'exigence de l'issue #24, et c'est ce qui permet
  à l'épreuve de l'application malveillante de distinguer « la coquille refuse ce geste-là » de « la
  coquille n'a pas compris le message ». Un relevé tout vert obtenu par incompréhension ne
  prouverait rien ;
- **le code ne dépend QUE du type reçu.** Il est calculé avant que la coquille ait consulté un état
  — volume, enveloppe, présence d'une clé —, et deux appareils dans des états différents rendent le
  même code pour le même type. Ce n'est donc pas un oracle : un adversaire qui lit
  `VAULT_COQUILLE_KEK_REFUSEE` apprend qu'il a demandé une KEK, ce qu'il savait en l'écrivant.

**L'encodage du contrat** (`src/coquille/contrat-de-messages.mjs`) :

| Code                              | Ce qu'il constate                                                       | Conduite                                  |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `VAULT_COQUILLE_MESSAGE_MALFORME` | le message n'est pas un objet, ou ne porte pas de type : rien à décoder | corriger l'appel                          |
| `VAULT_COQUILLE_CONTRAT_REFUSE`   | identifiant ou version du contrat étrangers à cette coquille            | parler la version publiée par la coquille |
| `VAULT_COQUILLE_TYPE_INCONNU`     | type bien formé, ni admis ni nommé par la liste de refus                | s'en tenir à la liste d'admission         |

**Les dix gestes de la liste de refus** (issue #24, décision 2 ;
`src/coquille/admission-applicative.mjs`). La liste n'est pas dérivée et ne se négocie pas : chacun
de ces gestes appartient à l'utilisateur, jamais à l'application.

| Code                                    | Geste tenté                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `VAULT_COQUILLE_KEK_REFUSEE`            | obtenir une clé de déverrouillage (KEK)                                              |
| `VAULT_COQUILLE_DEK_REFUSEE`            | obtenir la clé de volume (DEK)                                                       |
| `VAULT_COQUILLE_EXPORT_REFUSE`          | exporter le volume                                                                   |
| `VAULT_COQUILLE_REVOCATION_REFUSEE`     | `revoquerEmplacement`, `revoquerToutSauf`, `remplacerEmplacement`                    |
| `VAULT_COQUILLE_EMPLACEMENT_REFUSE`     | ajouter un emplacement de déverrouillage                                             |
| `VAULT_COQUILLE_RECUPERATION_REFUSEE`   | créer un moyen de récupération                                                       |
| `VAULT_COQUILLE_VOLUME_REFUSE`          | changer d'emplacement de volume                                                      |
| `VAULT_COQUILLE_ENVELOPPE_REFUSEE`      | lire `<volume>.cles` ou son inventaire                                               |
| `VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE` | obtenir le port privilégié coquille ↔ Worker, ou y poster un type qui lui appartient |
| `VAULT_COQUILLE_HANDLE_REFUSE`          | obtenir un handle de fichier                                                         |

**L'annonce reçue sur `window`, et l'ordre du cycle de vie.** Cinq conditions, contrôlées dans cet
ordre, chacune nécessaire :

| Code                             | Ce qu'il constate                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_CANAL_ABSENT`    | le canal privilégié n'est pas établi : aucun port n'est octroyé avant lui              |
| `VAULT_COQUILLE_ANNONCE_TYPE`    | type inattendu — il ne prouve rien seul, tout document le connaît                      |
| `VAULT_COQUILLE_ANNONCE_ORIGINE` | origine inattendue                                                                     |
| `VAULT_COQUILLE_ANNONCE_FENETRE` | fenêtre émettrice inattendue : une iframe imbriquée porte la MÊME origine que le cadre |
| `VAULT_COQUILLE_ANNONCE_UNIQUE`  | le port restreint a déjà été transféré ; il ne l'est qu'une fois                       |

**La CORRÉLATION, et ce qu'elle ferme.** Une requête admise porte un identifiant qui lui revient tel
quel : c'est lui qui apparie N réponses à N requêtes. Sans lui, deux requêtes en vol se disputaient
une seule réponse et l'une des deux restait **muette** — sur le seul geste que la coquille admette,
et alors que « jamais un silence » est écrit quatre fois dans ce dossier. C'est le constat 2 de la
revue de sécurité de la [PR #166](https://github.com/pinfada/railsbox-vault/pull/166).

| Code                                   | Ce qu'il constate                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_CORRELATION_ABSENTE`   | pas d'identifiant admissible : une chaîne de 1 à 64 caractères `[A-Za-z0-9_-]`               |
| `VAULT_COQUILLE_CORRELATION_DUPLIQUEE` | cet identifiant est déjà en vol ; le réemployer rendrait la réponse ambiguë                  |
| `VAULT_COQUILLE_TROP_DE_REQUETES`      | plus de requêtes en vol que la borne nommée. La coquille refuse ; elle ne met pas en réserve |

**Le canal PRIVILÉGIÉ, et l'ordre des gestes qu'il porte** (#162,
[ADR 0029](decisions/0029-deverrouillage-dans-la-coquille.md)). Un seul code, et il ne parvient
jamais au document applicatif — qui reçoit `VAULT_COQUILLE_RECUPERATION_REFUSEE` bien avant, sur le
type du message et sans qu'aucun état ne soit consulté.

| Code                               | Ce qu'il constate                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_VOLUME_VERROUILLE` | un geste qui exige un volume OUVERT a été demandé sur un volume qui ne l'est pas — créer un moyen de récupération exige de détenir déjà une clé qui ouvre |

Le dire par un code plutôt que par un bouton grisé a une raison : un bouton grisé n'apprend rien à
qui l'atteint autrement, et l'épreuve n'a rien à mesurer.

**Le CYCLE DE VIE assemblé, et ce qu'il refuse** (#163,
[ADR 0030](decisions/0030-cycle-de-vie-assemble-dans-la-coquille.md) ; #169,
[ADR 0031](decisions/0031-verrouiller-le-worker-meurt-l-instantane-survit.md)). Aucun ne parvient au
document applicatif : ils vivent entre la coquille, son Worker de confiance et son propre document.

| Code                                              | Ce qu'il constate                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_COQUILLE_WORKER_MORT`                      | le Worker de confiance ne répond plus : il a jeté, il a été terminé, ou il s'est tu au-delà de `DELAI_WORKER_MORT_MS`. La coquille refuse alors **tout service jusqu'à un geste explicite**                                                                                                                                                                                                                          |
| `VAULT_COQUILLE_ETAPE_HORS_ORDRE`                 | une étape du cycle de vie a été demandée avant celle dont elle dépend — un boot avant l'ouverture du backend, un cadre avant que l'étape 3 ait conclu, **un verrouillage pendant qu'un démarrage est en vol** (#169)                                                                                                                                                                                                 |
| `VAULT_COQUILLE_GESTE_ROMPU`                      | le Worker de confiance a **jeté en servant une requête ADMISE**, sans code de refus à donner. Le geste était admis, il n'a pas abouti, et ce qui a jeté ne se dit pas — une exception peut nommer un chemin de fichier, un refus rendu n'a rien à en dire                                                                                                                                                            |
| `VAULT_COQUILLE_APPLICATION_ABSENTE`              | aucune application n'est servie par cette origine : il n'y a rien à démarrer. Ce n'est pas un échec du geste, c'est l'absence de son objet — comme `indisponible` est l'absence d'un moteur capable                                                                                                                                                                                                                  |
| `VAULT_COQUILLE_CAPACITE_MANQUANTE`               | une capacité EXIGÉE manque au moteur, mesurée dans le document de la coquille et **sous la CSP servie** — sans l'exemption dont jouit la sonde `public/compat.html` (#2), qui mesurerait notre politique                                                                                                                                                                                                             |
| `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE` | un fichier de volume applicatif existe, mais aucun manifeste ne l'identifie (absent, ou présent et ILLISIBLE — une coupure pendant l'écriture du manifeste laisse un sidecar tronqué). La coquille **refuse**, et ne réinstalle pas : un volume anonyme est soit une installation interrompue, soit autre chose, et verser le disque par-dessus écraserait sans un geste et sans un mot ce que le guest y aurait mis |

`VAULT_COQUILLE_GESTE_ROMPU` est neuf (#169) et ferme un défaut de la même famille que celui qui a
fait naître `VAULT_COQUILLE_WORKER_MORT` : le repli du Worker de confiance renvoyait
`VAULT_COQUILLE_TYPE_INCONNU` pour un geste qui était, lui, parfaitement admis — et il le renvoyait
**là où le message compte le plus**, sur l'inattendu, c'est-à-dire ce dont personne n'a écrit le
refus. Il ne remplace aucun code TYPÉ : une `VAULT_STORAGE_*` garde le sien, une `VAULT_ENVELOPPE_*`
le sien ; le repli ne mord que sur ce qui n'en a pas.

`VAULT_COQUILLE_WORKER_MORT` est neuf, et son absence était un défaut : la borne de mort rejetait
sous `VAULT_COQUILLE_TYPE_INCONNU`, dont le message dit « Requête hors de la liste d'admission de la
coquille » — c'est-à-dire tout autre chose que ce qui s'était produit. Ce que ce code **ne dit pas**
est aussi important : ni ce que « verrouillé » veut dire, ni sous quel délai, ni sur quel
déclencheur. L'état et la règle appartiennent à #25 ; la coquille les cite (ADR 0030, décision 3).

**Ce que « jusqu'à un geste explicite » désigne, nommément** : le bouton « Rouvrir le coffre », que
la mort révèle dans l'interface remontée et qui **recharge** la coquille. Il ne ressuscite rien — un
Worker recréé en place hériterait d'un cadre applicatif dont le port est mort — et il n'est jamais
automatique. La borne qui mène à ce refus mesure l'absence de **signe de vie** et non l'absence de
réponse : le Worker de confiance émet un **battement** (`vault.coquille.battement-prive`) pendant
tout geste long, et un boot de deux minutes ne déclare donc plus mort un Worker vivant.

**Ce qui ne franchit le port dans aucun sens** : `VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE` sert des
deux côtés. Vers l'application, il est levé par la coquille **contre elle-même** — une réponse
allait transporter autre chose que des données (un port, un tampon, une `CryptoKey`, un handle, une
fonction) —, et ne parvient donc jamais au document applicatif. Vers la coquille, il refuse un
message du document applicatif qui **transfère** un port ou un tampon : rien n'en était retenu, mais
rien n'était refusé non plus, et un canal qu'on n'a pas décidé d'ouvrir doit être fermé nommément
(constat 7 de la même revue).

`tests/unit/coquille-contrat.test.mjs` › « `sansCapacite` laisse passer des données et REFUSE tout
ce qui est une capacité » mesure la première moitié, `tests/browser/coquille-frontiere.spec.mjs` la
seconde, et `tools/muter-gardes-coquille.mjs` montre que les gardes savent rougir.

**Deux bornes nommées, et pourquoi elles sont dans le décodeur.** Un `type` au-delà de 128
caractères n'est pas un type : c'est une charge utile déguisée, et le refuser au décodage est ce qui
l'empêche d'être recopiée plus loin. Un type refusé revient à son émetteur **tronqué** à 64
caractères. Le motif est le constat 3 de la revue : quarante messages dont le seul champ `type`
faisait 200 000 caractères faisaient passer le relevé de la coquille de 606 à 8 003 678 caractères.
Le relevé ne recopie plus rien du guest — il COMPTE, par code, et l'ensemble des codes est clos.

Épreuves : `tests/unit/coquille-admission.test.mjs`, `tests/unit/coquille-contrat.test.mjs` et
`tests/browser/coquille-frontiere.spec.mjs` (trois moteurs, application malveillante, témoin positif
en même origine).

## 11. Les voisins hors périmètre de la revue

Un relecteur en voit la **place**, pas l'implémentation. Ils sont nommés ici avec leur statut pour
qu'aucune absence ne se lise comme un oubli.

| Voisin                | Décision                                                                                                         | Statut au 6 septembre 2026                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<volume>.cles`       | [ADR 0020](decisions/0020-enveloppe-de-cle.md), [ADR 0026](decisions/0026-revocation-d-urgence-et-page-libre.md) | **livré.** Chiffré et authentifié. Il est le seul chemin vers le volume : sa perte vaut la perte des données. **L'archive ne l'emporte pas.** **SIX** opérations depuis le 6 septembre 2026 : la révocation d'urgence retire tous les emplacements sauf celui que la clé présentée OUVRE, en une version et une barrière, et toute mutation qui RETIRE une clé efface ensuite la page libérée (8192 zéros, seconde barrière). |
| Dérivation            | [ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md)                                              | **livré.** Argon2id (RFC 9106) au plancher de la RFC, ou WebAuthn PRF. Le compteur `signCount` **n'est pas lu**.                                                                                                                                                                                                                                                                                                              |
| `<volume>.instantane` | [ADR 0024](decisions/0024-instantane-de-reprise.md)                                                              | **livré.** Il part avec le témoin et le journal à tout geste qui réécrit le volume, pour la raison de la § 6.9. L'empreinte de région de la § 6.8 lui sert de **liaison** : elle rend un instantané périmé détectable dès qu'un secteur a été rescellé (`VAULT_INSTANTANE_ECART_REGION`).                                                                                                                                     |
| `<volume>.migration`  | [ADR 0011](decisions/0011-migration-de-format-et-reprise.md)                                                     | **livré, ni chiffré ni authentifié.** Sa limite est dans le périmètre : § 9.2.                                                                                                                                                                                                                                                                                                                                                |

**Et une chose qui n'existe pas.** Le **changement de clé de volume** : le refus au budget (§ 4.5)
et la révocation d'un emplacement d'enveloppe nomment tous deux ce remède ; aucun chemin du produit
ne rechiffre un volume sous une clé neuve. C'est la limite que l'ADR 0026 écrit sans l'arrondir :
**révoquer ne rechiffre pas.** Qui détient `<volume>` et une page ANTÉRIEURE de `<volume>.cles`
développe toujours la même clé de volume ; une révocation protège le fichier À VENIR, jamais la
copie déjà prise, et l'effacement de la page libre ne change rien à cela — il ferme la fenêtre du
fichier, pas celle du support. **« Supprimer et recréer »** (§ 6.3, § 10.2), la conduite nommée par
`VAULT_STORAGE_VOLUME_INCOMPLET`, N'EN FAIT PLUS PARTIE depuis le 6 septembre 2026 :
`removeOpfsVolume` l'outille, et la naissance retire elle-même les orphelins d'un volume supprimé à
la main — voir § 9.6, constat [#145](https://github.com/pinfada/railsbox-vault/issues/145).

**La clé de volume, en exploitation.** Le produit ne fabrique ni ne persiste aucune clé de volume
par lui-même en dehors de l'enveloppe ; les bancs et les épreuves reçoivent une **clé de TEST
publique** (les octets `0x00` à `0x1f`), sous jeton du harnais, et cette clé est publiée dans les
vecteurs. Le format est donc prouvé de bout en bout **sous une clé publique**, ce qui prouve le
format et non la confidentialité en exploitation.

## 12. Écarts entre les ADR et le code, au 5 septembre 2026

Relevés en écrivant ce document. **Le code tranche** ; l'écart est écrit, jamais corrigé en silence.

**Écart 0 — la DEK scellait encore l'enveloppe et la récupération. CLOS le 11 septembre 2026 par la
tranche T2b (#182).** La décision 1 de
l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) écrit « la DEK n'est plus
jamais passée à AES-GCM », et la tranche T2a ne la rendait vraie qu'à moitié : la racine d'une page
de `<volume>.cles` (ADR 0020, décision 3) et la section de récupération d'une archive (ADR 0027)
étaient encore scellées sous elle. Ce n'était pas un oubli, c'était le découpage.

**Ce qui l'a fermé** : la page d'enveloppe passe en **version 2** (§ 6.11), sa racine est scellée
sous une clé à usage unique du domaine `enveloppe` — ou `recuperation` pour la page qu'une archive
emporte —, et une page v1 est rescellée à la première ouverture réussie. Le cliquet PROVISOIRE
`vm-dek-sous-aes.test.mjs`, qui tenait l'inventaire des modules important encore la DEK en clé
AES-GCM, est REMPLACÉ par `tests/unit/vm-cliquet-anti-dek.test.mjs`, qui lit les APPELS et non le
texte, nomme la MATIÈRE de chaque import de clé brute, et exige qu'aucun chemin de production du
format v4 ne touche une clé de volume. Trois endroits la touchent encore, et aucun n'est un chemin
v4 : le modèle de référence de l'ADR 0015, le régime v3 de `scellement.mjs` (migration et export
d'un v3), et la LECTURE d'une page d'enveloppe v1 — qui importe la clé sans l'usage `encrypt`, donc
ne peut pas sceller.

**Ce qui n'est pas fermé et qui est écrit ailleurs de la même phrase** : ouvrir un volume **v3** —
pour le migrer ou pour l'exporter — fait écrire au magasin une racine v3 et rescelle la charge
acquittée, c'est-à-dire **3 + N scellements** sous la DEK, N étant le nombre de secteurs rejoués de
la charge acquittée. Voir le § 7.4 et `SECURITY.md`.

**Écart 1 — la marque de scellement complet n'est décidée par aucun ADR.** L'ADR 0016 (décision 1,
28 août 2026) donne l'en-tête v3 avec « offset 64, largeur 448, réserve, à zéro ». Le code y écrit
huit octets `VLTSEAL1` (§ 6.3), et la réserve réelle commence à 72 pour 440 octets. L'ADR 0016 y
renvoie une fois, en parlant d'un « fichier v3 sans cette marque refusé par l'ouvreur
(`VAULT_STORAGE_VOLUME_INCOMPLET`, décision 2) » — or sa décision 2 traite de la génération d'un
enregistrement de journal et ne mentionne ni la marque ni ce code. **La marque existe dans le code
et dans les épreuves, sans décision numérotée nulle part.** Ce document est le premier à la
spécifier. **Statut au 6 septembre 2026 : corrigé, PR #157** — décision 10 de l'amendement du même
jour à l'[ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md).

**Écart 2 — deux refus déclarés « retirés » existent encore.** L'ADR 0016 (décision 9) écrit que
`VAULT_ARCHIVE_VOLUME_CHIFFRE` et `VAULT_IMPORT_VOLUME_CHIFFRE` « n'existent plus » : « un refus qui
survit à sa cause devient un piège pour l'exploitant ». Ils sont toujours **déclarés** dans le code
et ne sont **plus levés nulle part**. C'est du code mort et non un piège actif — aucun exploitant ne
les rencontre —, mais l'ADR affirme une suppression qui n'a pas eu lieu. **Statut au 6 septembre
2026 : corrigé, PR #157** — les deux entrées sont retirées de `src/vm/archive-errors.mjs` et
`src/vm/import-errors.mjs`.

**Écart 3 — la version du journal annoncée par l'ADR 0016 est périmée.** Sa décision 3 donne «
format du journal (**2** en v3) ». Le code écrit **4** depuis le constat #143 — 3 depuis l'ADR 0019,
qui le disait explicitement. La table de l'ADR 0016 n'a pas reçu d'amendement sur ce champ ; ses
amendements datés et celui de l'ADR 0019 donnent la version courante, la table seule ne la donne
pas. **Statut au 6 septembre 2026 : corrigé, PR #157** — la chaîne 2 → 3 → 4 est écrite dans
l'amendement du même jour à l'ADR 0016, avec ses deux renvois.

**Écart 4 — le coût du scellement initial : 18,7 s annoncés, 87,6 s mesurés.** L'ADR 0015 chiffre la
création d'un volume de 512 Mio à **18,7 s** par extrapolation, et sa section « Risques » cite «
14,4 s » pour le même geste — deux chiffres pour une même grandeur à l'intérieur d'un même document.
La mesure réelle sur OPFS, publiée dans `docs/quality-attributes.md`, donne **87,6 s** (83,5 µs par
secteur), soit un facteur 4,7 sur l'extrapolation. Le chiffre de ce document est le chiffre
**mesuré**. La fenêtre que la marque de scellement complet ferme (§ 6.3) est donc quatre fois plus
longue que l'ADR ne le laissait croire. **Statut au 6 septembre 2026 : corrigé, PR #157** — l'ADR
0015 est amendé le même jour : la mesure fait foi, et les trois chiffres restent lisibles avec leur
statut.

**Écart 5 — un commentaire du code décrit un mécanisme qui n'existe plus.** La déclaration de
`VAULT_CRYPTO_IDENTITE_INCOHERENTE` porte encore, dans son commentaire, la description de l'époque
du nonce dérivé : « le nonce conservé avec le sceau n'encode pas la génération et le rang de
l'identité présentée. Établi AVANT tout calcul cryptographique : le nonce se décrit lui-même. » Le
constructeur situé quinze lignes plus bas dit exactement le contraire, et il est juste : le nonce ne
décrit plus rien, et ce refus ne sert plus qu'à la racine, après vérification de l'étiquette. C'est
un défaut de documentation dans le code, sans effet sur les octets. **Statut au 6 septembre 2026 :
corrigé, PR #157** — le commentaire dit désormais ce que le constructeur fait.

Aucun de ces cinq écarts ne change un octet du format. Les quatre premiers sont des documents en
retard sur le code ; le cinquième est un commentaire en retard sur son propre fichier.

## 13. Questions au relecteur

> **RÉPONDUES le 10 septembre 2026.** La revue externe de la moitié 2 de #20 (§ 9.7,
> [texte intégral](revue-externe/revue-2026-09-10.md)) a répondu aux neuf. Chaque question porte
> désormais trois choses : la position d'origine du dépôt, **la réponse du relecteur citée**, et la
> **position révisée**. Aucune position d'origine n'est effacée : ce qui a changé doit se lire.
>
> Le compte, pour qui ne lit que celui-là : **une rouverte** (n° 1), **une réfutée** (n° 4, sur sa
> portée), **une tranchée contre le dépôt** (n° 6), **six confirmées ou nuancées** (n° 2, 3, 5, 7,
> 8, 9).

Neuf questions de l'[ADR 0015](decisions/0015-proprietes-cryptographiques-du-format.md), reprises
ici avec ce que les [ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md) et
[ADR 0019](decisions/0019-fraicheur-du-volume.md) y ont ajouté ou en ont refermé. **Aucune question
n'est inventée ici**, et deux ont reçu depuis une réponse partielle qui est écrite avec elles. Les
questions qui touchent au déverrouillage renvoient aux
[ADR 0020](decisions/0020-enveloppe-de-cle.md) et
[ADR 0021](decisions/0021-derivation-des-cles-de-deverrouillage.md), livrés depuis, mais hors
périmètre (§ 11).

### Question n° 1 — AES-GCM-SIV vaut-il sa dépendance, en défense en profondeur ?

**Position du dépôt.** Non, pas aujourd'hui. Le tirage du nonce est la condition de correction, et
GCM-SIV n'en est plus une. Il rendrait cependant une collision improbable **non catastrophique**, là
où GCM la rend fatale. Le coût est une implémentation JS ou WebAssembly tierce et son audit, ce que
la règle de dépendances du dépôt n'accorde pas sans justification écrite.

**Ce qui la ferait changer.** Un argument montrant que la probabilité de collision de 2^-35 au
budget retenu est mal bornée — par exemple parce que le compteur de scellements recule (question
n° 4) et que le budget réel dépasse 2^31 d'un facteur inconnu. Ou l'arrivée d'un AEAD résistant à la
réutilisation de nonce **dans WebCrypto**, qui retirerait à la question son coût de dépendance.

**Réponse du relecteur, 10 septembre 2026 : ROUVERTE.** « AES-GCM-SIV : position à rouvrir, compte
tenu du budget non global. Une dépendance auditée peut être justifiée. » Et, dans le corps du
constat #182 : « Le RFC le recommande précisément lorsque plusieurs chiffreurs partagent une clé ou
que l'état garantissant l'unicité ne peut être assuré (RFC 8452). Cela ne dispense toutefois pas de
séparer les clés par domaine. »

**Position RÉVISÉE du dépôt : rouverte, et exactement par ce qui la ferait changer.** Le levier
écrit ci-dessus s'est réalisé — le constat #182 est précisément que le budget réel n'est pas borné —
et la position « non, pas aujourd'hui » ne tient plus. Elle n'est pas retournée pour autant : le
relecteur écrit lui-même que SIV ne dispense pas de séparer les clés, et la séparation vient
d'abord. La question devient un **spike**, T3, dont
l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) fixe le périmètre :
disponibilité par moteur, coût par secteur devant les ≈ 17,3 µs mesurés, et ce que SIV apporte **une
fois les clés séparées** — c'est-à-dire quand une collision ne coûte plus que la confidentialité de
deux clairs d'un domaine d'un volume. Aucun code, aucune version de format : une mesure et un
verdict.

### Question n° 2 — Faut-il un arbre de Merkle sur le volume ?

**Position du dépôt, et elle a changé depuis l'ADR 0015.** L'ADR 0019 a fermé le cas concret que
cette question visait — le retour arrière d'un **secteur** — par une **empreinte plate** de la
région entière, scellée dans la racine (§ 6.8), pour un hachage par rangement au lieu de 20 hachages
par écriture et 64 Mio d'état. Ce que l'empreinte plate ne donne pas est **quel** secteur a reculé —
et le remède ne change pas avec la réponse.

**Ce qui la ferait changer.** Une mesure montrant que l'empreinte de région dépasse le pour-cent du
budget de reprise à une taille de volume réaliste (aujourd'hui : 0,58 % à 0,64 %), ou un usage qui
exigerait de vérifier un secteur **sans** relire la région. L'ADR 0019 écrit d'avance les deux
leviers d'amortissement, dans l'ordre : empreinte à un seul coup d'abord — elle ne change aucun
octet de format —, empreintes par suites de secteurs ensuite, qui exigeraient une version de format.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE pour le volume, NUANCÉE pour l'archive.** «
Arbre de Merkle : pas nécessaire pour le volume courant. L'archive a besoin d'un engagement
authentifié global, qui peut rester plat. »

**Position RÉVISÉE du dépôt : confirmée, et la nuance devient #181.** L'empreinte plate reste le bon
outil pour le volume. Ce que la réponse ajoute est que l'archive, elle, n'a **aucun** engagement
global — et c'est le constat CRITICAL. « Qui peut rester plat » est repris tel quel par la
Definition of Ready de #181 : l'engagement est une empreinte du fichier chiffré entier, scellée, pas
un arbre.

### Question n° 3 — Existe-t-il un ancrage monotone acceptable dans un navigateur ?

**Position du dépôt.** Non. Le retour arrière **complet** est assumé (§ 9.1). Le témoin de la § 6.9
ferme le retour arrière **partiel** — le volume recule, son voisin non — et rien de plus ; il vit
dans la même origine que le volume, et le neutraliser ne coûte rien. `authenticatorData.signCount`
est instruit et écarté pour trois raisons cumulées, et le déverrouillage livré **ne le lit pas**.

**Ce qui la ferait changer.** Une ancre monotone hors du support qui ne déplacerait pas simplement
la confiance : un compteur matériel accessible depuis un navigateur, ou un témoin distant dont le
compromis serait strictement moins grave que celui de l'origine. La question est renvoyée nommément
à la récupération.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE.** « Ancrage monotone navigateur : aucun
ancrage purement local ne résiste au recul complet du profil. Il faut un témoin externe ou accepter
explicitement cette limite. »

**Position RÉVISÉE du dépôt : inchangée, et l'alternative est nommée.** La limite est acceptée
explicitement (§ 9.1), et elle l'était déjà. Ce que la réponse ajoute est que la seule autre voie
est un **témoin externe** — hors appareil, donc hors du modèle « tout tient dans le navigateur ». Ce
choix appartient à [#23](https://github.com/pinfada/railsbox-vault/issues/23) et n'est pas fait ici.
L'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) ne change rien à ce point :
la séparation des clés ne fabrique aucune ancre.

### Question n° 4 — Le budget de scellements est-il au bon endroit, et 2^31 est-il la bonne valeur ?

**Position du dépôt.** Le compteur est authentifié **dans la racine**, donc protégé contre la
falsification mais soumis au retour arrière : un support qui recule fait re-parcourir des
scellements déjà comptés, et le nombre réel d'invocations sous la clé dépasse alors le nombre compté
d'un écart qu'aucune mesure ne borne. La moitié du plafond NIST est une marge **choisie**, pas
calculée. Le témoin borne désormais ce recul pour tout ce qui n'est pas un retour arrière complet —
l'écart est réduit, pas annulé. S'y ajoute la sous-estimation hors transaction de la § 4.5, et le
fait que le compteur est **repris tel quel** de la racine qui fait autorité, sans aucun contrôle de
croissance (§ 4.5) : il suit passivement les reculs de cette racine, y compris ceux du constat
[#144](https://github.com/pinfada/railsbox-vault/issues/144), qui ne demandent pas un retour arrière
du SUPPORT. La même question vaut pour la stricte croissance de la **séquence**, que le format ne
peut vérifier que si l'appelant lui présente la valeur précédente.

**Ce qui la ferait changer.** Une mesure ou un argument bornant l'écart entre le compteur et le
nombre réel d'invocations, ce qui permettrait de fixer le budget **par le calcul** plutôt que par
une marge. Ou la démonstration que 2^31 est déjà trop haut sous le modèle de recul.

**Réponse du relecteur, 10 septembre 2026 : RÉFUTÉE, sur les deux moitiés.** « Budget : ni son
emplacement ni sa portée actuelle ne conviennent. » C'est le constat HIGH #182, et il ne porte pas
sur le recul : il porte sur le fait que le compteur ne compte **pas ce qu'il dit compter**.

**Position RÉVISÉE du dépôt : la PORTÉE est corrigée, l'EMPLACEMENT reste la question.** La position
d'origine ne parlait que du recul, et elle passait à côté : la moitié du plafond NIST était une
marge devant un écart de mesure, alors que le vrai problème était qu'il n'y avait pas **une** mesure
mais une collection de mesures locales, dont certaines n'existaient pas. La correction est
l'[ADR 0033](decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) : la DEK cesse de chiffrer,
chaque domaine de chaque volume a sa clé, **deux** domaines gardent un compteur — le volume et le
journal, tous deux dans l'en-tête authentifié de la racine v4 — et les quatre autres prennent une
clé à usage unique, dont le budget est 1 et qu'aucune mesure ne peut rendre faux. Les ouvertures
hors transaction, que le § 4.5 avoue aujourd'hui sous-estimer, doivent alors **clore par une
racine** ; une session qui ne peut pas en écrire n'a plus le droit de sceller.

**Ce qui reste ouvert après cette correction, et il faut le dire :** l'emplacement. Les deux
compteurs vivent toujours dans la racine, donc reculent toujours avec elle (§ 9.1,
[#144](https://github.com/pinfada/railsbox-vault/issues/144)), et 2^31 reste une marge **choisie**
devant un écart non borné. Le navigateur n'offre pas de meilleur endroit : c'est la question n° 3,
et elle est ouverte elle aussi.

### Question n° 5 — Le lot par appel est-il le bon découpage ?

**Position du dépôt : instruite, laissée fermée.** Sceller 512 octets à la fois coûte **32,5 fois**
plus cher que sceller 4 Mio d'un coup — le coût est celui de l'APPEL, pas d'AES : ≈ 17,3 µs par
appel contre ≈ 0,5 µs de calcul pour 512 octets. Pour le VOLUME, un lot détruirait l'accès aléatoire
et ferait perdre tout un groupe sur une erreur d'un bit. Le découpage candidat est **nommé
d'avance** — la page hôte de 4 096 octets, soit 8 secteurs, qui divise le volume applicatif sans
reste — avec son coût écrit : granularité de refus de 512 à 4 096 octets, et huit fois trop lu et
déchiffré pour un secteur isolé. Il **n'est activé par aucun chemin**, il n'est pas derrière un
drapeau, et il n'existe pas dans le code : une option non mesurée qui traîne finit par être allumée
sans décision. Pour le JOURNAL — rejoué d'un seul tenant — un scellement par génération resterait
défendable.

**Ce qui la ferait changer.** Une mesure montrant que la reprise se dégrade au-delà du bruit face au
budget de reprise, avec la granularité de refus qu'on accepte en échange.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE, et priorisée.** « Lot par appel : 512 octets
reste défendable pour l'accès aléatoire. Une mesure comparative à 4 Kio est pertinente, mais
secondaire par rapport à la séparation des clés. »

**Position RÉVISÉE du dépôt : inchangée, et la mesure reste non faite.** Le découpage candidat de 4
096 octets est nommé d'avance, il n'est activé par aucun chemin, et il le reste. « Secondaire » est
repris tel quel : la mesure ne passe ni avant #181 ni avant #182, et elle n'a pas de tranche.

### Question n° 6 — Le manifeste et l'archive doivent-ils être chiffrés ?

**Position du dépôt, tranchée pour l'archive seulement.** L'archive porte le fichier v3 **tel
quel**, chiffré, et son manifeste (§ 7.5) ; elle n'est ni chiffrée davantage ni signée. Le
**manifeste reste en clair** et n'est pas authentifié : il porte une identité, pas des données. Deux
conséquences déjà écrites : l'empreinte porte sur le chiffré, et une archive restaurée sans sa clé
est inerte.

**Ce qui la ferait changer.** Une attaque sur le manifeste en clair qui ne se réduise pas à un refus
— aujourd'hui, un manifeste falsifié produit un écart d'identité refusé avant toute lecture. Ou une
exigence de sauvegarde qui rendrait inacceptable qu'une archive et sa clé voyagent séparément.

**Réponse du relecteur, 10 septembre 2026 : TRANCHÉE CONTRE la position du dépôt.** « Manifeste et
archive : ils n'ont pas nécessairement besoin d'être secrets, mais l'archive doit être authentifiée
cryptographiquement. Le SHA-256 auto-déclaré est insuffisant. »

**Position RÉVISÉE du dépôt : l'archive doit être authentifiée, et elle l'EST depuis le 10
septembre 2026.** La question posait « faut-il les CHIFFRER ? » et la réponse dit que ce n'était pas
la bonne question : le secret n'est pas en cause, **l'authentification** l'est. Le SHA-256
recalculable atteste contre l'accident, jamais contre un adversaire. Une archive v3 porte donc un
**engagement** scellé sous une clé du domaine `archive`, vérifié avant tout clair, et une archive
sans engagement est **refusée** (§ 7.5,
[ADR 0034](decisions/0034-archive-authentifiee-et-racine-initiale.md),
[PR #184](https://github.com/pinfada/railsbox-vault/pull/184)). **Le manifeste, lui, reste en clair
et non authentifié** : sur ce point la position d'origine tient, et le relecteur ne la conteste pas.

**Et ce que l'engagement ne couvre pas, dit ici plutôt qu'au détour d'un module.** Il scelle
l'empreinte du fichier, l'identité et la géométrie du volume, la version de récupération et les
longueurs des sections. Il ne scelle **pas** le reste de l'en-tête JSON — la garantie de cohérence
déclarée par l'export, le nom de l'application du manifeste — ni la longueur de l'en-tête lui-même,
qui serait fonction d'elle-même puisque l'engagement y vit. Ces champs restent ce que le manifeste
est : une déclaration, pas une preuve.

### Question n° 7 — Un lecteur peut-il distinguer un secteur jamais écrit d'un secteur effacé ?

**Position du dépôt.** Il n'y a **pas** de secteur jamais écrit en v3 : la création et la migration
scellent tous les secteurs, zéros compris (§ 6.5). Le prix est de **87,6 s** de scellement à la
création d'un volume de 512 Mio (§ 12, écart 4), et la fenêtre que cela ouvre est refermée par la
marque de scellement complet.

**Ce qui la ferait changer.** Un marquage **authentifié** des plages non initialisées qui coûterait
moins que le scellement complet sans rouvrir la porte du secteur zéroté lu comme blanc.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE.** « Jamais écrit / effacé : la réponse
actuelle est cohérente puisque tous les secteurs sont initialement scellés. »

**Position RÉVISÉE du dépôt : inchangée.** Elle le reste en v4 : la création scelle tous les
secteurs, et la migration v3 → v4 les rescelle tous. Ce qui change en v4 est qu'une création doit
désormais clore par une racine qui publie ce qu'elle a consommé (question n° 4) — le scellement
complet cesse d'être invisible au budget.

### Question n° 8 — L'en-tête de racine en clair est-il acceptable ?

**Position du dépôt.** Il est assumé et nommé (§ 5.2, § 9.4). Il publie le nombre d'écritures d'une
génération, la longueur de sa charge et le compteur cumulé de scellements ; sur un volume de base de
données, cela dit quelque chose du rythme d'activité. Le chiffrer exigerait de choisir la racine qui
fait autorité **sans lire son en-tête**, ce que l'alternance rend impossible.

**Ce qui la ferait changer.** Une construction qui permettrait de départager deux racines sans lire
leurs en-têtes en clair, ou une mesure montrant que ce canal apprend, sur un usage réel, davantage
que « le volume a été écrit ».

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE sous condition.** « En-tête de racine en clair
: acceptable si la fuite du rythme d'activité est assumée. »

**Position RÉVISÉE du dépôt : inchangée, et la condition est tenue** — le § 5.2 et le § 9.4 écrivent
la fuite, ils ne la découvrent pas. **La v4 l'élargit d'un champ**, et il faut le dire : le second
compteur, `scellementsCumulesJournal`, publie en clair ce que le journal a consommé, séparément du
volume. Un observateur du support apprend donc désormais la part des dépôts dans l'activité, et non
plus seulement son total. C'est un élargissement assumé, écrit avec la décision qui l'apporte.

### Question n° 9 — Le rescellement du point de contrôle est-il au bon endroit ?

**Position du dépôt.** Oui, faute de mieux (§ 7.2). Passer du journal au volume exige de rescéller
chaque secteur sous un nonce neuf, donc de **déchiffrer puis rechiffrer** la charge validée : le
clair transite en mémoire, et le coût double pour les octets rangés. L'alternative — sceller au
format du volume dès le dépôt — obligerait le journal à n'accepter que des écritures alignées et
casserait « déposer = une écriture, une seule ».

**Ce qui la ferait changer.** Une construction qui éviterait le double scellement sans imposer
l'alignement au dépôt, ou une démonstration que le clair en mémoire pendant le rangement est une
exposition qualitativement pire que celle de la recopie qui existait déjà.

**Réponse du relecteur, 10 septembre 2026 : CONFIRMÉE, avec une exigence en plus.** « Rescellement
au point de contrôle : position raisonnable. L'état authentifié résultant doit cependant survivre à
l'export. »

**Position RÉVISÉE du dépôt : confirmée, et la phrase en plus est le CRITICAL.** « L'état
authentifié résultant doit survivre à l'export » est exactement ce que #181 montre qu'il ne fait pas
: la restauration retire journal et témoin, et l'ouverture suivante accepte l'absence de racine. Le
rescellement est au bon endroit ; ce qu'il produit ne traverse pas l'archive. C'est l'engagement de
#181 qui le fera traverser.

## 14. Ce que ce dossier ne prouve pas

- **LE DERNIER CONSTAT OUVERT DE LA REVUE EXTERNE EST FERMÉ** (§ 9.7).
  [#182](https://github.com/pinfada/railsbox-vault/issues/182), HIGH : le budget de clé du § 4.5
  n'était pas global à la clé. La tranche T2a l'a corrigé pour les domaines du VOLUME, la tranche
  T2b pour les deux derniers — chaque domaine de chaque volume a sa clé, la liste des six est CLOSE,
  et le compteur d'une clé compte toutes les invocations sous elle sur les chemins que la v4 ferme :
  la création, l'installation initiale, la réouverture hors transaction et les sessions
  transactionnelles, mesurés à l'ÉGALITÉ par le nombre d'invocations réelles. **Ce qui reste, et qui
  n'est pas un chemin v4** : ouvrir un volume **v3** — pour le migrer, ou pour l'exporter avant de
  le migrer — scelle 3 + N fois sous la clé de volume elle-même, N secteurs rejoués, tous comptés
  dans la racine v3. C'est le régime que la v4 remplace, c'est l'unique exception du cliquet, et
  c'est écrit au § 12.
- **DEUX budgets restent sous-estimés après T2a, et une seule des deux a une borne** (§ 4.5). Le
  volume de COQUILLE scelle un secteur par déverrouillage hors clôture, non compté, jusqu'à T2b :
  cet écart-là croît avec le nombre de déverrouillages, et rien ne le borne. Une conversion v3 → v4
  reprise après coupure peut avoir rescellé une suite deux fois : l'écart vaut au plus 512 secteurs
  par coupure, parce que la reprise ne rejoue que la suite en vol (§ 7.4), et celle-là est BORNÉE —
  ce que l'aveu du § 4.5 n'était pas.
- **Le CRITICAL est corrigé, et ce qu'il corrige a une borne.**
  [#181](https://github.com/pinfada/railsbox-vault/issues/181) est fermé par la
  [PR #184](https://github.com/pinfada/railsbox-vault/pull/184) : une archive porte un engagement
  scellé, et aucun volume légitime n'est sans racine. **Ce n'est pas la fermeture du § 9.1** : le
  rejeu d'une archive ENTIÈRE et cohérente reste indétectable, et l'ancrage monotone reste renvoyé à
  [#23](https://github.com/pinfada/railsbox-vault/issues/23). La propriété P5 du § 8 tient de
  nouveau pour un volume restauré ; elle ne tient toujours pas contre un support ramené en arrière
  tout entier.
- **Il ne prouve pas que le format est sûr.** Il décrit ce qu'il fait, ce qu'il ne fait pas, et sous
  quelles hypothèses. Un agent d'IA distinct des agents du dépôt l'a revu en mode adverse le 10
  septembre 2026 ; le mainteneur reconnaît cette indépendance factuelle comme tierce pour #20 depuis
  le 12 septembre. **Ce n'est ni un audit humain ni un audit de cabinet**, et le dépôt ne le
  présente jamais ainsi.
- **Il ne prouve pas la confidentialité en exploitation.** Le format est éprouvé de bout en bout
  sous une **clé de test publique** (§ 11).
- **Il ne prouve rien sur l'implémentation WebCrypto** des moteurs, que ce dépôt ne peut pas
  auditer, ni sur l'émulateur, ni sur l'application invitée.
- **Il ne prouve rien sur les moteurs non mesurés.** Les coûts publiés ici sont relevés sur
  Chromium, sur une machine de développement qui n'est pas l'environnement de référence. Firefox et
  WebKit exécutent les épreuves fonctionnelles, pas les bancs de coût.
- **Il ne prouve pas que l'ouvreur unique est incontournable.** C'est une discipline de revue, pas
  une contrainte de l'outillage (§ 6.10).
- **Le vérificateur de vecteurs n'établit qu'un fait étroit** : les octets figés sont ceux que ce
  document décrit. Il ne cherche aucune faiblesse.
- **Le registre de la revue externe porte SIX lignes, dont UNE OUVERTE.** Quatre viennent d'une
  pré-revue interne traitée comme externe ; deux viennent de la revue du 10 septembre 2026, dont
  l'une est corrigée le jour même et l'autre est due. Voir
  [`docs/revue-externe/registre.md`](revue-externe/registre.md), le texte de la revue
  [`revue-2026-09-10.md`](revue-externe/revue-2026-09-10.md) et le
  [gabarit de constat](revue-externe/gabarit-de-constat.md).
- **Le gate « données sensibles » reste FERMÉ.** RailsBox Vault est expérimental et ne doit contenir
  aucune donnée réelle.
