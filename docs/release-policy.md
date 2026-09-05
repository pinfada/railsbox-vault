# Versions, migrations et publications

## Trois identités indépendantes

Un coffre lie explicitement :

1. la version du **runtime Vault**, en SemVer ;
2. l'identité et la version de **l'application Rails** ;
3. la version entière du **format de volume**.

Le paquet npm reste en série `0.x` tant que le MVP et la revue de sécurité ne sont pas atteints. Une
rupture d'API runtime incrémente le mineur en `0.x`. Le format persistant ne dépend jamais
implicitement de la version npm.

## Compatibilité du volume

- lecture d'une version connue avant toute écriture ;
- migration sur une nouvelle génération copy-on-write ;
- export de sauvegarde obligatoire avant migration irréversible ;
- refus explicite d'un format futur ou d'un downgrade dangereux ;
- reprise déterministe après interruption de migration ;
- vecteurs de test conservés pour chaque version publiée.

Depuis #10, ces trois identités sont portées par un **manifeste versionné**
(`src/vm/volume-manifest.mjs`, [ADR 0007](decisions/0007-manifeste-de-volume.md)) : la lecture d'une
version connue avant écriture, le refus typé d'un format futur (`VAULT_MANIFEST_FORMAT_TOO_NEW`) et
d'un downgrade de runtime (`VAULT_MANIFEST_RUNTIME_DOWNGRADE`), et la distinction lecture seule
tolérée / écriture refusée y sont implémentés et prouvés en unitaire. La reprise de migration et les
vecteurs par version restent réservés à #13.

Depuis #11, l'**export de sauvegarde** est implémenté (`src/vm/volume-export.mjs`,
[ADR 0008](decisions/0008-format-d-archive-d-export.md)) : une archive versionnée
(`archiveFormatVersion`) lie le manifeste au contenu du volume et à son **empreinte SHA-256** — l'«
inventaire des artefacts et empreintes de contenu » exigé ci-dessous. `verifyArchive` recalcule
l'empreinte et valide le manifeste ; une archive tronquée ou altérée est refusée par une erreur
typée. L'archive v1 prouve l'intégrité mais n'est **ni chiffrée ni signée** (jalon 4) ; la
restauration inter-origine est #12.

Depuis #12, la **restauration** l'est aussi (`src/vm/volume-import.mjs`,
[ADR 0009](decisions/0009-restauration-inter-origine.md)) : « export/restauration de la version
précédente démontré », exigé ci-dessous pour toute publication, dispose désormais d'un chemin
automatisé et d'une preuve Bout en bout sur deux origines distinctes. Deux conséquences pour cette
politique. D'abord, la « lecture d'une version connue avant toute écriture » est enfin **exercée**,
et non plus seulement écrite : tout volume porte son **manifeste** dans un fichier voisin
(`<volume>.manifest`), inscrit en dernier geste par sa création comme par sa restauration, et le
**boot** l'exige : un volume identifié ne s'ouvre en écriture que par `openVolumeForWrite`, qui
refuse un volume sans manifeste par `VAULT_MANIFEST_UNIDENTIFIED` avant même de construire la VM. La
portée exacte de ce contrôle — et les appels directs à `openOpfsVolume` qui subsistent, relevant
d'une discipline de revue et non d'une contrainte du code — est détaillée dans
[l'ADR 0009](decisions/0009-restauration-inter-origine.md). Il n'y a **aucune période de
transition** : un volume sans manifeste est refusé, jamais complété par une identité devinée ; aucun
format n'ayant été publié dans la série `0.x`, aucun volume d'utilisateur n'est concerné. Ensuite,
la restauration ne **migre** rien : un volume d'un format antérieur est restaurable, mais son
écriture reste refusée par `VAULT_MANIFEST_MIGRATION_REQUIRED` jusqu'à #13. L'« export de sauvegarde
obligatoire avant migration irréversible » a donc désormais son pendant — la remise en place — mais
la migration elle-même, sa reprise après interruption et ses vecteurs par version restent à faire.

Depuis #13, la **migration** l'est aussi (`src/vm/volume-migration.mjs`,
[ADR 0011](decisions/0011-migration-de-format-et-reprise.md)), et le **format de volume passe à
v2**. Quatre des six exigences ci-dessus sont maintenant exercées par du code et des tests, et non
plus seulement énoncées :

- « **lecture d'une version connue avant toute écriture** » — inchangée depuis #12, et la migration
  s'y soumet : les refus de #10 tombent avant qu'aucun handle ne soit pris ;
- « **export de sauvegarde obligatoire avant migration irréversible** » — c'est désormais un
  **contrôle**. L'archive présentée est relue par #11 et son empreinte confrontée à celle du volume
  relu depuis le support, dans son état courant ; l'application et la taille sont comparées. À
  défaut d'archive, un **consentement nommé**, inscrit dans le journal de reprise **tant que la
  migration n'a pas abouti** — le dernier geste retire ce journal, et aucune trace du consentement
  ne subsiste après le succès : il sert la reprise, pas la reddition de comptes (ADR 0011). Sans
  l'un ni l'autre, `VAULT_MIGRATION_BACKUP_REQUIRED` est levé et la cible n'est **même pas ouverte**
  ;
- « **refus explicite d'un format futur ou d'un downgrade dangereux** » — le refus de downgrade
  cesse d'être une supposition. Le format **v2** ajoute `runtime.minWriter`, la version de runtime
  la plus ancienne autorisée à écrire ce volume, **déclarée** par le runtime qui l'écrit. La règle
  v1, qui comparait les majeurs SemVer, ne pouvait **rien** refuser dans cette politique : elle
  exprime une rupture d'API runtime par un incrément du **mineur** en `0.x`, si bien que les deux
  majeurs valent 0 et que la comparaison est toujours fausse. C'était le risque n°2 de l'ADR 0007,
  et il était déjà réalisé. Un manifeste v1 garde SA règle plutôt que de recevoir une valeur qu'il
  n'a jamais portée ;
- « **reprise déterministe après interruption de migration** » — une migration interrompue laisse un
  volume **non identifié**, que le boot refuse (`VAULT_MANIFEST_UNIDENTIFIED`), et un journal voisin
  `<volume>.migration` portant le manifeste source, la chaîne visée et la preuve retenue. La reprise
  repart de là **sans redemander la sauvegarde** : l'exiger de nouveau ferait d'une interruption une
  impasse, sur un volume que le boot n'ouvre déjà plus. Elle est **déterministe** parce qu'elle
  recommence la chaîne depuis le manifeste source au lieu de deviner un point d'arrêt, et
  **idempotente** : un journal resté derrière un manifeste déjà migré est simplement retiré.

Deux exigences restent ouvertes. La « **migration sur une nouvelle génération copy-on-write** »
n'est **toujours pas faite** : la migration mute en place, et entre la révocation et l'inscription
du manifeste l'état est sûr — non identifié, donc non inscriptible — mais **pas révocable en un
geste**. #16 n'a pas fermé cette exigence-là, et il faut le dire précisément : il a livré la
génération transactionnelle du chemin d'écriture du GUEST
([ADR 0014](decisions/0014-generation-transactionnelle.md)), pas la migration copy-on-write. Ce que
#16 change ici est réel mais étroit — la cible de migration ouvre le volume par le chemin
transactionnel, si bien qu'une génération validée en attente est rejouée avant toute mutation au
lieu d'être perdue — et le **format du volume n'a pas changé**, précisément pour que l'export, la
restauration et la migration continuent de lire le fichier tel quel.

Une précision de compatibilité, puisque cette page l'exige : #16 **n'incrémente aucune version de
format**. Le manifeste reste en v2, le volume garde sa disposition, aucun volume existant n'est
refusé ni migré. Le journal de génération `<volume>.gen` porte sa propre version de format,
indépendante — une racine d'un format inconnu n'est pas une racine, et la génération qu'elle
scellerait est écartée. Les « **vecteurs de test conservés pour chaque version publiée** » non plus,
et pour une raison de fond : aucune version n'a encore été publiée. Le témoin de refus par une
ancienne version simule donc celle-ci par ses **attentes déclarées** (`supportedFormat`), non par un
binaire antérieur — la limite est écrite dans l'ADR 0011 et dans `docs/testing.md`. Un volume v1
reste par ailleurs **lisible**, donc exportable, restaurable et migrable : le passage à v2
n'orpheline aucun volume.

### Le format de volume passe à v3, et il est CHIFFRÉ (#18)

C'est la première version de format qui change la **disposition du fichier**, et non seulement le
document qui l'accompagne. Un volume v3 porte un en-tête d'un secteur, une région d'authentification
de 34 octets par secteur logique, puis une charge chiffrée : le fichier fait 6,64 % de plus que la
taille logique, et son contenu n'est plus lisible sans clé. La décision est
l'[ADR 0016](decisions/0016-format-de-volume-v3-dispositions.md).

Ce que la matrice de compatibilité doit en retenir :

- **le manifeste passe en v3** et gagne un bloc `volume` obligatoire — identifiant OPAQUE de
  trente-deux hexadécimaux minuscules, immuable, inscrit à la création, et algorithme épinglé sur
  `aes-256-gcm`. Un runtime qui ne connaît que v2 refuse un v3 par `VAULT_MANIFEST_FORMAT_TOO_NEW`,
  ce qui est exactement le comportement voulu : il n'a pas la clé, et il écrirait en clair dans un
  volume chiffré ;
- **le format du journal de génération passe de 1 à 2**, indépendamment, et pour la même raison —
  puis à **3** avec l'ADR 0019 et à **4** avec le constat #143, chaque fois parce que les octets
  d'un journal changent et jamais parce que le volume change ;
- **le MANIFESTE d'un v1 ou d'un v2 reste lisible ; leur FICHIER ne s'ouvre pas.** La distinction a
  été écrite de travers jusqu'à la revue de #102, qui a relevé que « v1 et v2 restent LISIBLES, donc
  exportables et migrables » promettait trois remèdes dont aucun n'existait alors : `MIN_READABLE`
  porte sur le manifeste, tandis que l'export et l'inspection passent tous deux par
  `openOpfsVolume`, qui refuse un fichier sans en-tête v3. Un volume d'avant v3 n'a ni région
  d'authentification ni nonce, si bien que le sceau d'un secteur n'aurait nulle part où aller. Ce
  qu'il a désormais, c'est un **chemin vers v3** — le point suivant —, et c'est par là qu'il
  redevient lisible ;
- **la migration v2 → v3 est FOURNIE depuis #101**, et c'est la première du dépôt qui touche les
  octets. Elle passe par la chaîne de l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md)
  sans exception : sauvegarde exigée avant, manifeste révoqué avant la première mutation, journal de
  reprise inscrit avant la révocation, manifeste v3 inscrit en dernier et relu depuis le support.
  Elle convertit **EN PLACE** — un fichier voisin aurait exigé le double du quota au moment précis
  où l'utilisateur migre 512 Mio —, en deux gestes dont l'ordre est un contrat : déplacer la charge,
  puis sceller. Le **journal de migration passe en version 2** pour porter l'avancement
  (`{ etape, position }`) ; un journal v1 est refusé plutôt qu'interprété, puisqu'il décrit une
  migration qui n'écrivait rien. L'**identifiant de volume est tiré à la migration**, un v2 n'en
  ayant pas. La conversion scelle, donc elle exige une clé : migrer sans clé est refusé par
  `VAULT_STORAGE_CLE_REQUISE` et laisse le volume **non identifié**, que le boot refuse — jamais à
  moitié converti ;
- **l'archive porte le fichier v3 tel quel**, donc chiffré. `content.length` décrit la taille du
  FICHIER — en-tête et région comprises, soit 6,64 % de plus que la taille logique — et
  `identity.digest` l'empreinte du chiffré. Trois conséquences pour cette politique. Deux exports
  d'un même contenu logique ne sont **plus comparables par empreinte** : les nonces sont tirés. La
  **restauration** ne demande **aucune clé** — l'archive est copiée telle quelle —, si bien que la
  restauration inter-origine de l'ADR 0009 fonctionne inchangée sur un volume chiffré. L'**export**,
  lui, en demande une, et pas pour lire : il doit d'abord RÉCUPÉRER, c'est-à-dire rejouer dans le
  volume une génération validée qui attend encore dans le journal voisin (ADR 0014). Copier le
  fichier sans cette étape produirait une archive à laquelle il manque une écriture acquittée. Et la
  sauvegarde d'un volume chiffré est la sauvegarde de **DEUX choses**, dont ce dépôt n'en gère
  qu'une avant #21 : une archive sans sa clé est un fichier que personne n'ouvrira, et «
  export/restauration de la version précédente démontré » ne vaudra pour un volume chiffré que
  lorsque la clé aura, elle aussi, un chemin de sauvegarde ;
- **aucun volume d'utilisateur n'est concerné** : la série est `0.x` et aucun format n'a été publié.
  Les « vecteurs de test conservés pour chaque version publiée » restent sans objet pour la même
  raison, et les vecteurs cryptographiques de #17 tiennent ce rôle pour le format lui-même.

## Publication

Une version publiable exige :

- changelog et ADR des ruptures ;
- CI obligatoire verte et recettes lourdes requises par le risque ;
- inventaire des artefacts et empreintes de contenu ;
- SBOM du runtime et des images ;
- signature des artefacts dès que la chaîne de publication existe ;
- matrice runtime/application/format mise à jour ;
- procédure de rollback testée ;
- export/restauration de la version précédente démontré ;
- surfaces de mesure exclues de l'artefact publié — `public/csp/`, `public/spike/` et
  `public/compat/` sont des bancs de mesure servis depuis la racine du serveur de développement, pas
  le produit ; la liste des chemins publiés est une décision de publication, tranchée par #45.

## La chaîne de publication (#45, ADR 0017)

Depuis #45, quatre de ces exigences ont un outil et une preuve, et non plus seulement une phrase. La
décision est dans l'[ADR 0017](decisions/0017-chaine-de-publication.md), les mesures dans
[`docs/spikes/0045-chaine-de-publication.md`](spikes/0045-chaine-de-publication.md).

```sh
node tools/publier.mjs --commit <ref>                 construit les deux arborescences
node tools/publier.mjs --verifier <arborescence>      recalcule les empreintes et compare
npm run publier:check                                 construction, vérification et témoin d'en-têtes
```

### Deux arborescences, une par origine

L'[ADR 0002](decisions/0002-topologie-origine-de-confiance.md) impose deux origines ; la chaîne
produit donc deux arbres, jamais un. L'arbre de la **coquille** porte le document de confiance, son
Worker runtime, les modules de `src/vm/` et les artefacts v86 épinglés. L'arbre du **territoire
applicatif** ne porte **aucun artefact du dépôt** — le HTML applicatif vient du guest — mais il
porte sa configuration d'en-têtes et une place tenante déclarée comme telle.

### Inventaire et empreintes

Chaque arbre porte un `inventaire.json` : l'empreinte SHA-256 et la taille de chaque fichier, une
**empreinte de racine** calculée sur la liste canonique et **accompagnée** du commit publié — elle
est adressée par contenu, deux versions dont aucun octet publié ne diffère la partagent —, les
en-têtes déclarés, les exclusions et leurs motifs, et le verdict d'**épinglage v86** — chaque
artefact de l'émulateur est confronté, dans l'arbre publié, à l'empreinte que
`vendor/v86/MANIFEST.json` lui attribue. C'est la moitié « runtime identifié et vérifié » de
`SEC-UPDATE-001` portée jusqu'aux octets qui partent chez l'hébergeur.

`--verifier` distingue trois natures d'écart, parce qu'elles ne se diagnostiquent pas de la même
façon : **altéré**, **ajouté** — la surface que personne n'a décidée —, **manquant**. Un renommage
change l'empreinte de racine, qu'une somme des empreintes ne verrait pas.

L'inventaire n'est **pas une signature**. Un adversaire qui réécrit un fichier réécrit l'inventaire
qui l'accompagne ; l'empreinte de racine n'a de valeur que **comparée hors bande** à celle publiée
par la construction, et c'est pourquoi `.github/workflows/publication.yml` la dépose en artefact
séparé et l'imprime dans son résumé. La signature reste exigible, et reste à faire.

### En-têtes servis

`tools/serve-headers.mjs` est la **source de vérité** : la production sert ce que
`securityHeaders()` rend, dérivé et non recopié, pour que les épreuves de frontière du dépôt
mesurent bien ce qui est publié. La publication ajoute **exactement deux** en-têtes, un par origine,
tous deux décidés par l'ADR 0017 — l'ADR 0022 n'en a pas ajouté de troisième, il a servi les siens
depuis la source de vérité :

| Origine     | En-tête ajouté                                                | Pourquoi                                                                                      |
| ----------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| coquille    | `Cross-Origin-Opener-Policy: same-origin`                     | recommandation différée de l'[ADR 0010](decisions/0010-isolation-multi-origine.md)            |
| application | `Content-Security-Policy: frame-ancestors <origine coquille>` | sans lui, le document qui porte les cookies de session est encadrable par n'importe quel site |

La seconde ne rouvre pas ce que l'ADR 0002 s'interdit : `frame-ancestors` ne gouverne pas ce que le
document **charge**, seulement qui a le droit de l'**encadrer**. Elle doit rester **seule** dans la
politique applicative, et le témoin d'en-têtes échoue si une autre directive l'accompagne. Une
épreuve unitaire échoue si un **troisième** en-tête apparaît dans la publication. COEP reste absent.

L'hébergement doit donc savoir servir des en-têtes de réponse, **des deux côtés** : GitHub Pages est
écarté partout. Pour la coquille, `frame-ancestors` est ignoré dans un `<meta http-equiv>` sur les
trois moteurs et COOP n'y est pas exprimable ; pour l'application, le relevé du spike montre que
Pages ne sert ni CORP, ni `nosniff`, ni `frame-ancestors`, et impose `max-age=600` là où le serveur
de test sert `no-store`.

Depuis l'[ADR 0022](decisions/0022-entetes-de-durcissement.md), la source de vérité sert en outre
**deux en-têtes de durcissement générique aux documents de la COQUILLE**, et à eux seuls :
`Referrer-Policy: no-referrer` et `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
Ils ne sont pas des ajouts de la publication — ils viennent de `tools/serve-headers.mjs`, donc ils
sont servis en développement et mesurés là — et ils ne sont pas posés sur l'origine applicative :
ils gouvernent ce que le document émet et ce qu'il peut, c'est-à-dire le contenu rendu par le guest,
que l'ADR 0002 s'interdit de contraindre. Le témoin d'en-têtes relève leur présence sur la coquille
et leur **absence** sur l'origine applicative.

### Politique de cache, par nature d'artefact (ADR 0023)

Depuis l'[ADR 0023](decisions/0023-politique-de-cache-par-nature-d-artefact.md) (#103),
`Cache-Control` est le SEUL en-tête dont la valeur dépend du chemin, et le fichier `_headers` porte
donc plusieurs blocs — chacun **complet**, pour ne dépendre d'aucune sémantique de fusion que le
format ne spécifie pas.

| Arbre       | Motif `_headers`          | Nature d'artefact                    | `Cache-Control`                       |
| ----------- | ------------------------- | ------------------------------------ | ------------------------------------- |
| coquille    | `/*`                      | coquille, ses modules, manifeste v86 | `no-cache`                            |
| coquille    | `/vendor/v86/artefacts/*` | artefacts v86 adressés par empreinte | `public, max-age=31536000, immutable` |
| application | `/*`                      | territoire applicatif                | `no-store`                            |

`immutable` est **servi** depuis #123, et ce qui l'autorise est l'adresse : chaque artefact v86 est
publié sous `<base>-<sha256 tronqué>.<ext>`, si bien qu'un ré-épinglage le DÉPLACE et qu'un artefact
périmé n'est plus jamais demandé. `node tools/publier.mjs` le mesure avant que l'arbre ne parte —
chaque adresse dérivée est servie, chaque octet servi est déclaré, chaque empreinte est recalculée —
et refuse en code 5 sinon. Le MANIFESTE, lui, reste `no-cache` : il est l'indirection par laquelle
un chargeur apprend les adresses, et une copie périmée en désignerait qui ne sont plus servies.

**Obligation d'exploitant.** L'hébergeur retenu doit servir ces valeurs telles quelles. Un hébergeur
qui réécrit `Cache-Control` — GitHub Pages impose `max-age=600`, mesuré par le spike #45 — rend la
décision inopérante sans qu'aucun cliquet de la chaîne puisse le voir avant la mise en service.

### HSTS est une obligation d'EXPLOITANT, pas un en-tête de la chaîne

`Strict-Transport-Security` n'est servi par aucun outil de ce dépôt, et une épreuve garde cette
absence sur les deux arbres. Le motif est écrit dans l'ADR 0022 : tout ce que ce dépôt sait servir
est en `http:`, où RFC 6797 § 7.2 exige du navigateur qu'il **ignore** l'en-tête ; et HSTS engage un
**domaine** pour des mois, quand la chaîne de publication ne produit que des arborescences.

**Ce que l'exploitant doit donc faire, à la mise en service et à chaque changement d'hébergeur** :

- vérifier que **les deux** origines servent `Strict-Transport-Security` en HTTPS, et le relever —
  ce n'est pas parce qu'un hébergeur le sert par défaut sur son propre domaine qu'il le sert sur un
  domaine propre ; le relevé du spike #45 porte sur des sites tiers et prouve le choix de leur
  propriétaire, pas la capacité de l'hébergeur ;
- valeur recommandée : `max-age=63072000` (deux ans), après une période d'observation à `max-age`
  court ;
- **`includeSubDomains` engage aussi le sous-domaine applicatif** sur un déploiement à domaine
  propre, où les deux origines sont le même site (ADR 0017, fait 2). Ne le poser qu'après s'être
  assuré que toute l'arborescence de noms est servie en HTTPS ;
- **`preload` est irréversible en pratique** : le retirer demande une désinscription auprès des
  navigateurs, et sa propagation se compte en versions. Il n'est pas recommandé avant qu'une origine
  réelle soit stabilisée.

Rien dans la chaîne ne peut vérifier cette obligation : elle porte sur un domaine que le dépôt ne
connaît pas. C'est le risque résiduel n°3 de l'ADR 0022.

Le fichier `_headers` porte en outre `# origine: <url>` en tête. C'est un commentaire pour
l'hébergeur, et un **octet compté par l'empreinte** : sans lui, deux origines de coquille
différentes rendaient la même empreinte de racine, et une bascule d'origine — donc une migration —
passait pour un redéploiement.

### Retour arrière

```sh
# 1. RAMENER LE DISQUE SUR L'ÉPINGLAGE DE CETTE VERSION-LÀ.
#    `vendor/v86/artefacts/` n'est pas versionné : il vient TOUJOURS de l'arbre de travail, y
#    compris sous --commit. Le manifeste, lui, est lu au commit demandé. Sauter cette étape depuis
#    un poste à jour donne un code 5 — artefacts déclarés absents, artefacts d'aujourd'hui non
#    déclarés — et l'outil imprime alors ces deux commandes.
git checkout <version-precedente> -- vendor/v86/MANIFEST.json
npm run vm:fetch     # récupère les adresses de cette version, élague celles d'aujourd'hui

# 2. RECONSTRUIRE, VÉRIFIER, CONFRONTER.
node tools/publier.mjs --commit <version-precedente> --sortie artifacts/rollback
node tools/publier.mjs --verifier artifacts/rollback/coquille
node tools/publier-empreinte.mjs artifacts/rollback/coquille
# confronter le résultat à l'empreinte inscrite lors de la sortie de cette version

# 3. REVENIR AU PRÉSENT, une fois l'arbre déposé — sans quoi le poste reste sur l'épinglage d'hier.
git checkout HEAD -- vendor/v86/MANIFEST.json && npm run vm:fetch
```

`--commit` lit les octets par `git show` : deux reconstructions du même commit rendent la même
empreinte de racine, au bit près. Republier consiste à redéposer cet arbre.

**Pourquoi l'étape 1 est nécessaire, et pourquoi c'est une bonne nouvelle.** Depuis #123 les
artefacts v86 sont déposés à des adresses qui NOMMENT leur empreinte. Un disque resté sur
l'épinglage d'aujourd'hui ne peut donc plus produire, en silence, un arbre étiqueté d'hier portant
les octets du jour : les adresses ne correspondent pas, et la publication refuse en code 5. Le refus
remplace un risque par une étape — c'est le sens de l'amendement de
l'[ADR 0017](decisions/0017-chaine-de-publication.md) du 2026-09-05.

**Le dépôt de l'arbre doit être ATOMIQUE**, ou déposer les artefacts AVANT le manifeste qui les
nomme. Sous `/vendor/v86/artefacts/*` la production annonce `immutable` pour un CHEMIN, et un
hébergeur qui applique cette règle avant de constater une absence renverrait un 404 marqué frais
pour un an. L'ordre inverse — manifeste d'abord — ouvre précisément cette fenêtre. Voir l'amendement
de l'[ADR 0023](decisions/0023-politique-de-cache-par-nature-d-artefact.md) ; aucune origine réelle
n'a été mesurée (#124).

**Chaque sortie doit conserver son empreinte de racine hors bande.** C'est la condition qui rend le
retour arrière _vérifiable_ et non seulement _reproductible_ : sans elle, on prouve que l'outil est
déterministe, pas qu'on republie bien cette version-là. `publication.yml` l'imprime dans son résumé
et la dépose en artefact séparé, et son entrée `empreinte-attendue` la confronte à la
reconstruction.

Un retour arrière **ne migre rien à l'envers** : un volume écrit par la version retirée reste écrit
par elle, et c'est le refus de downgrade de
l'[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) (`runtime.minWriter`) qui protège
l'utilisateur.

### Changer l'origine de la coquille est une MIGRATION

Ce n'est jamais un redéploiement. OPFS est cloisonné par origine : l'ancienne devient inatteignable.
L'ordre imposé par l'ADR 0017 est : annoncer, **exporter** depuis l'ancienne origine encore servie
([ADR 0008](decisions/0008-format-d-archive-d-export.md)), publier la nouvelle, **restaurer**
([ADR 0009](decisions/0009-restauration-inter-origine.md)), et maintenir l'ancienne en service tant
qu'un utilisateur peut n'avoir pas exporté.

### Ce que l'outil refuse, et ce dont il se contente d'avertir (#106)

Trois entrées sont refusées en **usage invalide** (code 3), et elles le sont **avant** que quoi que
ce soit ne soit effacé — une faute de frappe ne doit pas emporter la publication précédente :

- une `--commit <ref>` que `git rev-parse` ne résout pas. Elle est nommée dans le refus, au lieu de
  remonter sous la forme d'un échec de `git ls-tree` ;
- une `--sortie` qui n'est pas **strictement sous la racine du dépôt**. La construction efface
  `<sortie>/coquille` et `<sortie>/application` avant de les réécrire, et ne le fait que là où git
  rend le dommage visible. Déposer l'arbre ailleurs est une **copie**, faite après coup ;
- une `--sortie` qui contient autre chose que ces deux arbres. Le répertoire visé doit être absent,
  vide, ou celui d'une publication précédente.

Une source obligatoire absente reste un code 4, mais l'outil dit désormais **laquelle des deux
absences** il constate : absente de l'arbre de travail — un fichier à replacer —, ou absente **au
commit** demandé, c'est-à-dire jamais présente à cet endroit de l'histoire. Le second cas ne se
répare pas sur le disque : c'est cette version-là qui n'est pas constructible par les sources
décidées aujourd'hui.

`--verifier` **avertit** enfin quand l'inventaire déclare un arbre de travail sale à la
construction, ou qu'il ne porte aucune empreinte de commit. Le code de sortie **reste 0** : les
empreintes sont exactes, l'arbre est bien ce que son inventaire décrit, et ce qui manque est une
_provenance_, pas une _intégrité_. Rendre 1 confondrait « altéré après publication » avec «
construit depuis un disque non versionné ». L'avertissement vaut aussi sous `--commit`, parce que
les sources hors git et les outils qui rendent `_headers` viennent toujours du disque.

`tools/publier-sonde-hebergement.mjs` conserve `GET` là où `HEAD` suffirait à lire des en-têtes :
elle mesure ce que le **public** reçoit, et un hébergeur qui dégrade `HEAD` lui ferait enregistrer «
en-tête absent » là où l'en-tête est servi — un faux négatif sur un en-tête de sécurité. Le motif
est écrit dans le module et fixé par une épreuve.

### Ce que la chaîne ne fait pas encore

Aucun déploiement réel, aucune signature, aucun SBOM, aucun Service Worker hors ligne. La politique
de cache, en revanche, n'est plus héritée :
l'[ADR 0023](decisions/0023-politique-de-cache-par-nature-d-artefact.md) la décide par nature
d'artefact (voir ci-dessus). Ce qui reste ouvert de ce côté est l'**effet** — aucune épreuve de ce
dépôt ne mesure qu'un moteur garde effectivement l'épinglage v86 vingt-quatre heures, ni qu'un
hébergeur réel ne réécrit pas `Cache-Control` comme GitHub Pages le fait.

## Support et retrait

Avant `1.0`, chaque release annonce les versions de volume qu'elle lit, migre et refuse. Après
`1.0`, une politique de durée de support sera décidée par ADR à partir d'usages réels.

Une version vulnérable peut être retirée de la publication, mais ses artefacts, la procédure de
récupération et la raison du retrait restent documentés afin de ne pas transformer une mise à jour
de sécurité en perte de souveraineté.
