# ADR 0042 — Le déphasage de versions : la version et le schéma décident avant le boot

- **Statut** : accepté
- **Date** : 2026-09-19
- **Issue** : [#236](https://github.com/pinfada/railsbox-vault/issues/236), tranche T2 (résultats 4
  et 5 de la DoR amendée) ; #241 (graine servie trop lourde)
- **Amende, sans changer leur format** : l'[ADR 0007](0007-manifeste-de-volume.md) et
  l'[ADR 0035](0035-format-de-volume-v4-et-migration.md) (deux champs facultatifs du bloc `app` du
  manifeste de volume), l'[ADR 0041](0041-le-paquet-applicatif-partition-2-d-un-hda-compose.md) (le
  descripteur v2 gagne la rétention 1 et des morceaux compressés),
  l'[ADR 0040](0040-le-parcours-est-un-ordre-pas-une-decision.md) (un bloc de l'accueil),
  l'[ADR 0039](0039-sauvegarder-restaurer-revoquer-depuis-la-coquille.md) (la sauvegarde proposée
  avant la mise à jour est le geste existant).
- **Ne rouvre pas** : le format de volume v4 et la hiérarchie de clés (ADR 0033–0036), le contrat de
  messages (ADR 0028, un type privilégié de plus), « un coffre = une identité » (ADR 0039), la
  durabilité par le commit (#209), le cache par empreinte (ADR 0023), la chaîne de publication
  (#45).

## Contexte

T1 a séparé le code des données : le paquet est la partition 2 d'un `hda` composé, les données
vivent sur `hdb`, et le descripteur v2 désigne chaque morceau par son empreinte. Rien ne disait
encore ce qui se passe quand l'origine sert une AUTRE version que celle qui a écrit les données d'un
coffre : du code plus récent qui doit migrer, du code plus ancien qui lirait mal, le code d'une
autre application. Le manifeste de volume ne portait que `app.id` et `app.version` ; le guest ne
comparait rien ; et une migration jouée au boot ne l'était jamais (la graine naît migrée).

Rails commite ses migrations UNE PAR UNE : chaque migration est une transaction SQLite, et la ligne
de `schema_migrations` est écrite dans la même. SQLite rend le DDL transactionnel —
`ALTER TABLE … ADD COLUMN`, `CREATE INDEX` s'annulent avec la transaction
([lang_altertable](https://www.sqlite.org/lang_altertable.html),
[foreignkeys](https://www.sqlite.org/foreignkeys.html), § 5 pour les contraintes différées). Une
coupure PENDANT une migration laisse donc la base à l'état d'avant cette migration ; une coupure
ENTRE deux migrations la laisse à un schéma INTERMÉDIAIRE, cohérent pour Rails, que l'ancien code ne
sait pas lire. C'est ce que `tests/vm/migration-coupee.test.mjs` mesure sur l'image réelle : arrêt
net de la machine après la première des deux migrations de 1.1.0 ; le paquet 1.0.0 est ensuite
REFUSÉ ; le paquet 1.1.0 reprend et joue la seconde (38,5 s), schéma final N, invariant intact.

## Décision

### 1. Le manifeste de volume porte le schéma CONSTATÉ, et l'INTENTION d'une migration

Deux champs facultatifs du bloc `app`, en chiffres (`SCHEMA_APPLICATIF`), **sans changement de
format** (le format reste 4) :

- `app.schema` : le schéma des données de ce volume, tel que le guest l'a constaté ;
- `app.migration` : l'intention d'une mise à jour commencée — le schéma VISÉ —, inscrite AVANT le
  boot qui migre, effacée quand le manifeste a suivi.

Absents, ils ne sont pas réécrits : un manifeste de T1 se relit et se resérialise à l'octet
(`vm-manifeste-schema.test.mjs`, relecture ascendante). Un runtime de T1 qui relirait un manifeste
de T2 laisserait tomber les deux champs à la réécriture — aucun runtime de T1 n'est déployé.

**Règle pour un manifeste qui ne porte pas `schema`** (volumes installés par T1) : le schéma est
INCONNU et il n'est pas deviné ; il vaut celui du paquet servi — courant ou précédent — dont la
VERSION est exactement celle du coffre (c'est ce paquet qui l'a installé, sa graine portait ce
schéma). Aucun paquet servi de cette version, ou une version du coffre qui n'est pas un SemVer :
refus `VAULT_COQUILLE_SCHEMA_DU_COFFRE_INCONNU`. Le premier boot qui constate le schéma l'inscrit.

### 2. La décision, avant le boot, après le déverrouillage (`src/coquille/dephasage.mjs`)

Le Worker de confiance lit le manifeste — jamais le cadre — et le confronte au descripteur servi.
Avant la table, l'identité : aucun descripteur → `APPLICATION_NON_SERVIE` ; un autre `app.id` →
`APPLICATION_ETRANGERE`. Puis la **version, par la précédence SemVer 2.0.0**, et le **schéma, en
entiers** :

| version servie ↔ coffre | schéma servi <   | schéma servi =              | schéma servi >             |
| ----------------------- | ---------------- | --------------------------- | -------------------------- |
| inférieure              | refus ANTÉRIEURE | refus ANTÉRIEURE (rollback) | refus ANTÉRIEURE           |
| égale                   | refus DIVERGENT  | ouvrir, rien à proposer     | refus DIVERGENT            |
| supérieure              | refus ANTÉRIEURE | mise à jour SANS migration  | mise à jour AVEC migration |

Une version inférieure est refusée **même à schéma égal** : c'est l'attaque par retour arrière de
[The Update Framework](https://theupdateframework.github.io/specification/latest/), et une origine
qui la sert — par erreur ou non — n'obtient pas de la personne un clic « Mettre à jour » vers du
code plus ancien. Une intention présente (`app.migration`) ne laisse que la REPRISE, par un paquet
de schéma au moins égal à la cible.

Dans TOUS les refus : ni boot, ni migration, ni suppression proposée ; aucun octet du volume n'est
écrit. Le démarrage REDÉCIDE de lui-même : la page n'est pas crue.

**Les noms des refus.** La DoR parlait de `VAULT_APPLICATION_ANTERIEURE` et
`VAULT_APPLICATION_ABSENTE` ; les codes portent le préfixe de leur famille, `VAULT_COQUILLE_`, que
le cliquet du § 10.5 de `docs/format-de-volume-v3.md` exige. `APPLICATION_ABSENTE` existait déjà
pour « rien à installer dans un coffre neuf » ; le cas de la DoR — des données existent, l'origine
ne sert pas leur application — est un autre événement, donc un autre code :
`VAULT_COQUILLE_APPLICATION_NON_SERVIE`. S'y ajoutent `_ETRANGERE`, `_ANTERIEURE`,
`SCHEMA_DU_COFFRE_INCONNU`, `SCHEMA_DIVERGENT` (le guest constate que ses marqueurs contredisent le
manifeste) et `MIGRATION_ECHOUEE`. Chacun a sa conduite humaine
(`src/coquille/conduites-du-dephasage.mjs`), qui dit que les données sont intactes et qu'une
sauvegarde se fait sans démarrer l'application.

### 3. Le geste : un bloc de l'accueil, jamais une étape

Après le déverrouillage, la page demande au Worker le constat
(`vault.coquille.constater-le-dephasage`, une LECTURE). Une mise à jour proposée montre, dans le
bloc `application` de l'accueil et de l'étape 4, le bloc « Mettre à jour l'application » : ce qui va
se passer, la sauvegarde proposée AVANT (« Sauvegarder d'abord » emprunte le geste de l'ADR 0039), «
Mettre à jour l'application », et « Plus tard » quand l'origine sert encore la version du coffre. «
Plus tard » referme le bloc ; « Démarrer l'application » ouvre alors le coffre sur sa version, par
le paquet précédent. Un refus s'affiche par la ligne d'état du cycle, avec sa conduite. La visite en
neuf étapes ne change pas.

### 4. La rétention 1

Le descripteur v2 porte, facultatif, `precedent : { application { version, schema }, paquet { … } }`
: le paquet PRÉCÉDENT sous son empreinte. Il ne peut être ni de la même version ni plus récent que
le courant. `npm run image:build` le refabrique depuis la révision git que `sources.json` épingle
(`paquetPrecedent.ref`), par l'outillage COURANT — le même chemin qu'une application extérieure — ;
`app:paquet --precedent` écrit `paquet-precedent.json`, et une fabrication ne retire jamais les
images d'une autre version. Sa graine est gardée : elle fait naître un coffre de cette version pour
les épreuves.

### 5. Le guest compare, migre, et le dit (`schema-du-volume.sh`)

Avant Rails, de façon synchrone, le guest compare le marqueur des données (`/app/var/.vault-schema`,
V), celui du paquet (`/app/db/.vault-schema`, P), le schéma que le manifeste attend (`vault.schema=`
sur la ligne de commande, E, posé par le Worker après le contrôle du descripteur) et l'intention
(`/app/var/.vault-migration`, I). V > P ou P < I : refus « antérieur » ; E connu, V ≠ E et V ≠ P :
refus « divergent » ; P > V : I := P et `sync`, `db:migrate` (chaque ligne de Rails redite sur la
série), V := P, I retiré, `sync` ; sinon rien — aucun second chargement de Rails. Un refus arrête le
boot tout de suite (le Worker guette la série) au lieu d'attendre cinq minutes une santé qui ne
viendra pas.

**Le manifeste suit, et jamais avant.** Le guest n'imprime « migration jouée » qu'après le `sync`
qui a validé la génération portant la base migrée et le marqueur ; le Worker n'écrit le manifeste
(version, schéma, intention effacée) qu'après un boot réussi, et seulement si le schéma constaté est
celui du paquet booté. Une coupure entre les deux laisse un manifeste en retard sur des données à N
: V = P, le guest l'accepte, le boot suivant rattrape le manifeste.

### 6. Les morceaux voyagent en gzip (#241 ; amendement du superviseur du 19/09)

Rootfs, paquet et graine sont PRÉCOMPRESSÉS en gzip standard (RFC 1952), de façon déterministe
(niveau 9, en-tête sans nom ni date, octet OS « inconnu » : un même disque compressé sous Windows et
sous Linux a une seule empreinte, #212). Le descripteur porte par morceau `compression: "gzip"` et
`transfertOctets` ; `octets` et `sha256` restent ceux de l'image DÉCOMPRESSÉE. La coquille
décompresse par `DecompressionStream("gzip")` (capacité exigée), exige la taille transférée à
l'octet, et borne la décompression à la taille de l'image (anti-bombe). Les fichiers sont servis en
`application/octet-stream`, **sans** `Content-Encoding`. Premier démarrage : **1 034 → 177 Mio**
transférés (rootfs 385 → 128,4 ; paquet 137 → 48,5 ; graine 512 → 0,5).

### 7. La garde « volume neuf » (constat 8 de la revue de la PR #237)

Sauter les blocs nuls au versement exige désormais que le backend se déclare NÉ de cette ouverture
(`backend.naissance`, posé par `openOpfsVolume`) : un versement creux sur un volume habité est
refusé avant la première écriture. La mise à jour, elle, ne verse jamais dans le volume de données.

## Ce qui est écarté, et pourquoi

- **Un format d'extents maison pour la graine** (`extents-v1`, première rédaction de cette tranche)
  : il réinventait l'image creuse d'Android (`simg`), pour ne traiter que la graine ; gzip couvre
  les trois morceaux avec un décodeur livré par les trois moteurs. Brotli (non livré par Chrome dans
  `DecompressionStream`) et zstd (absent) sont écartés pour la même raison.
- **Servir les artefacts `immutable`** : les caches HTTP des moteurs refusent ou bornent des entrées
  de cette taille (Firefox 50 Mo, Chromium un huitième du cache) ; un magasin d'artefacts OPFS
  adressé par empreinte est le chantier qui les remplacera (issue ouverte par le superviseur). Le
  mode de cache ne change pas.
- **Migrer d'office à l'ouverture** : « jamais automatiquement » ; la sauvegarde d'abord est
  proposée, pas imposée.
- **Un champ `expires` dans le descripteur** : sans signature, une date d'expiration ne protège de
  rien.

## Ce qui reste hors périmètre

- **La signature de l'auteur du paquet** (jalon 6, #26–#28) : elle suivra **TUF 1.0.x** — version
  monotone, `expires`, rôles séparés. Le descripteur v2 tient déjà la place du rôle « snapshot » (il
  désigne chaque morceau par son empreinte) ; la version monotone est déjà exigée côté coffre par la
  précédence SemVer ci-dessus.
- **Le redimensionnement du disque de données** : il rouvrirait l'ADR 0035.
- **Plus d'un paquet précédent** : la rétention est 1.

## Limites, mesurées ou dites

- Le manifeste est un fichier voisin réécrit par troncature puis écriture : une coupure pendant
  cette écriture le laisserait illisible, donc le coffre refusé sous
  `VOLUME_APPLICATIF_SANS_MANIFESTE` (conduite existante), sans perte de données. L'intention (§ 1)
  est écrite AVANT le boot, hors de toute fenêtre où le guest écrit.
- Un boot qui migre charge Rails deux fois : son délai est doublé (`FACTEUR_DU_DELAI_DE_MIGRATION`).
  Durées publiées dans `docs/quality-attributes.md`.
- Le scénario de bout en bout tourne sous Chromium seul, comme tous ceux de `tests/e2e/` ; le bloc
  et les refus sont mesurés sur les trois moteurs par `tests/browser/coquille-mise-a-jour.spec.mjs`.

## Note du 19/09/2026 — ce que la revue de sécurité de la PR #249 a fait durcir

Sept constats, tous reproduits par exécution ; les gardes qui en découlent, et ce qu'elles couvrent
:

- **La reprise est jugée par la VERSION aussi** (constat 1, CRITICAL). L'intention `app.migration`
  porte désormais la CIBLE entière, `{ version, schema }`. Une mise à jour interrompue ne reprend
  que par une version servie STRICTEMENT plus récente que celle du coffre et d'un schéma au moins
  égal à celui de la cible ; tout autre cas est `VAULT_COQUILLE_MISE_A_JOUR_INTERROMPUE`, sans boot.
  Avant cette garde, un 0.9.0 servi sur un coffre 1.0.0 en cours de mise à jour obtenait le clic.
- **L'espace `vault.*` appartient au Worker** (constat 2, HIGH). Le descripteur servi qui en porte
  un est refusé à sa forme ; le guest refuse un paramètre `vault.*` présent deux fois
  (`VAULT_COQUILLE_PARAMETRE_DU_GUEST_REFUSE`). La valeur servie ne peut plus l'emporter sur celle
  du Worker.
- **Chaque marqueur est VALIDÉ avant toute comparaison** (constat 3, HIGH) : un entier de quatorze
  chiffres au plus, sans zéro de tête, dans le guest (`case` portable de `dash`), au manifeste
  (`SCHEMA_APPLICATIF`), à la fabrication et dans le Dockerfile. Un marqueur invalide est un refus
  du guest (`VAULT_COQUILLE_MARQUEUR_DE_SCHEMA_INVALIDE`) : rien n'est migré ni réécrit. `dash`
  rendait « Illegal number », évalué faux, et la migration était jouée puis le marqueur réécrit vers
  le bas.
- **Le guest ne migre que sous l'autorisation du Worker** (constat 4) : `vault.migrer=1`, posé
  seulement sous le geste « Mettre à jour l'application » ; sans lui, un paquet qui dépasse les
  données est refusé (`VAULT_COQUILLE_MIGRATION_NON_AUTORISEE`). Une migration ne se joue plus sur
  la foi d'un schéma DÉCLARÉ qui ment.
- **Un coffre de T1 reprend sans le paquet précédent** (constat 5) : l'intention est lue avant la
  déduction du schéma, et elle inscrit le schéma déduit au manifeste.
- **Épreuves** (constat 6) : chaque refus navigateur compare l'état du volume `application` avant et
  après (aucun octet écrit) ; les deux coupures que l'épreuve VM ne place pas — entre l'intention et
  `db:migrate`, entre le marqueur et le retrait de l'intention — sont jouées par
  `tests/vm/schema-du-volume.test.mjs`, sous le vrai `dash` de l'image du guest, avec dix-sept cas.
  La campagne `dephasage` passe à vingt mutants.

**Ce qui reste au jalon 6** (signature de l'auteur, TUF 1.0.x) : ces gardes tiennent contre une
origine qui se TROMPE ou qui publie mal, et contre des données altérées dans le volume ; elles ne
tiennent pas contre une origine qui MENT de façon cohérente — un paquet ancien republié sous un
numéro plus grand et un schéma déclaré conforme, ou des morceaux de deux publications réunis sous un
même descripteur. Seule une signature de l'auteur, avec une version monotone et une expiration
signées, les distinguera.
