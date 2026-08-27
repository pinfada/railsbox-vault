# ADR 0009 — La restauration vérifie avant d'écrire, et n'identifie le volume qu'après l'avoir relu

- Statut : accepté
- Date : 2026-08-25
- Issue : #12 · Invariant : `VAULT-PORT-001` · Jalon 2

## Contexte

L'[ADR 0008](0008-format-d-archive-d-export.md) a donné à Vault une archive **vérifiable** : elle
lie le manifeste versionné de #10 au contenu intégral du volume et à son empreinte SHA-256, et
`verifyArchive` refuse de façon typée toute archive tronquée, altérée ou incompatible. Elle s'est
explicitement arrêtée là : « la restauration inter-origine → #12 ».

Le chemin inverse n'est pas symétrique de l'export, et c'est ce qui exige une décision.

- **L'export lit ; la restauration écrit.** Elle écrit sur un support qui appartient à quelqu'un,
  dans une origine qui ne connaît pas la source. Un export raté ne coûte qu'un fichier à jeter ; une
  restauration ratée peut laisser un volume à moitié écrasé.
- **Le changement d'origine est le cœur du résultat, et il est réel.** OPFS est cloisonné **par
  origine** (ADR 0002) : l'origine de restauration ne peut rien lire du stockage de l'origine
  d'export. Rien ne traverse, sinon l'archive elle-même — et rien dans le produit ne la fait
  traverser : la CSP de la coquille (`default-src 'none'`, `connect-src 'self'`) n'ouvre aucun canal
  inter-origines. Le transport est un geste de l'utilisateur.
- **Un volume Vault n'a, jusqu'ici, aucune marque de validité.** #10 a écrit
  `assertVolumeWritable({ manifestBytes })` — « jamais d'écriture sur un support non identifié »,
  `SEC-UPDATE-001` — mais rien, dans le dépôt, n'écrivait encore ce manifeste à côté d'un volume.
  Une restauration interrompue produirait donc un volume d'apparence normale, au contenu incomplet.
- **Le volume de référence pèse 512 Mio.** Il ne tient pas en mémoire (`docs/quality-attributes.md`
  : surmémoire de streaming ≤ 64 Mio), ni à la vérification, ni à la recopie, ni à la relecture.

## Décision

**La restauration (`src/vm/volume-import.mjs`) exécute sept gestes, dans cet ordre, et cet ordre
fait partie du contrat :**

| #   | Geste           | Ce qu'il garantit                                                                         |
| --- | --------------- | ----------------------------------------------------------------------------------------- |
| 1   | **Vérifier**    | l'archive entière est validée (empreinte recalculée + manifeste #10) sans écrire un octet |
| 2   | **Refuser**     | cible occupée, géométrie inconciliable, espace insuffisant — avant toute mutation         |
| 3   | **Ouvrir**      | le handle exclusif est pris ; une ouverture ratée ne doit rien avoir détruit              |
| 4   | **Révoquer**    | le manifeste de la cible est retiré : le volume cesse d'être présenté comme valide        |
| 5   | **Restaurer**   | le contenu est recopié octet pour octet, en flux, puis une barrière est franchie          |
| 6   | **Re-vérifier** | le volume est **relu depuis le support** et son empreinte confrontée à celle de l'archive |
| 7   | **Inscrire**    | le manifeste est écrit : seul ce dernier geste rend le volume présentable comme valide    |

Il n'existe donc **pas de restauration partielle silencieuse** : soit le volume est complet, relu et
identifié, soit l'échec est typé et le volume reste **non identifié**.

**Pourquoi ouvrir AVANT de révoquer.** Ouvrir un volume de géométrie inchangée ne mute rien, mais
l'ouverture peut échouer pour des raisons étrangères à la restauration : un autre onglet détient
l'exclusivité (#8), le support a perdu le handle, le quota refuse l'allocation. Révoquer d'abord
rendrait alors inutilisable un volume **parfaitement intact**, par la seule faute du produit. Après
l'ouverture, en revanche, la révocation précède impérativement le premier octet écrit. La règle
n'est pas « révoquer tôt » mais « ne jamais laisser des octets partiels derrière un manifeste valide
».

### Le manifeste est un fichier VOISIN, et il porte la validité

Le manifeste d'un volume restauré est écrit dans un fichier du même répertoire OPFS, nommé
`<volume>.manifest`, soumis à la même validation de frontière que le volume lui-même.

Il n'est **pas** placé en tête du volume : la géométrie de #6 est une suite de secteurs de 512
octets servie **telle quelle** à v86, que le guest monte comme un disque. Y intercaler un en-tête
décalerait le système de fichiers du guest de la taille du manifeste.

Le suffixe `.manifest` est donc **réservé** par la frontière de nommage (`opfs-sync-access.mjs`) :
aucun volume ne peut le porter, sans quoi restaurer « donnees » détruirait un volume légitime nommé
« donnees.manifest ». La longueur maximale d'un nom de volume est réduite d'autant, pour qu'un
volume créable soit toujours un volume **restaurable** — une impasse fermée à la création plutôt que
découverte à la restauration. En défense en profondeur, un voisin présent mais **non analysable**
comme manifeste fait refuser la restauration ; il n'est jamais supprimé.

### Le manifeste voisin CONDITIONNE l'ouverture en écriture

Ce voisin porte la **validité** du volume, et cela n'a de sens que si quelqu'un le lit. C'est le
rôle de `openVolumeForWrite` (`src/vm/opfs-volume-open.mjs`) : il lit le voisin, le soumet à
`assertVolumeWritable` (#10) et n'ouvre le volume qu'ensuite. La règle exacte, telle que le code la
tient, tient en trois lignes :

- un volume **identifié** ne s'ouvre en écriture que par `openVolumeForWrite` — le boot y passe, et
  un volume sans manifeste y est refusé par `VAULT_MANIFEST_UNIDENTIFIED` **avant** que v86 ne soit
  construit ;
- un volume **anonyme** n'est ouvrable que par le chemin qui va précisément l'identifier —
  préparation depuis l'image de référence, restauration — et il reste refusé au boot tant que son
  manifeste n'est pas inscrit ;
- les bancs #4/#6/#14 et les phases de mesure n'ouvrent **aucun volume applicatif** : ils éprouvent
  ou lisent la couche blocs.

Ce qu'il ne faut **pas** en conclure : que plus personne n'appelle `openOpfsVolume`. **Treize appels
directs subsistent** dans le code de production, et rien dans l'outillage n'empêche un nouveau
chemin d'en ajouter un sans passer par l'ouvreur. C'est une **discipline de revue, pas une
contrainte du code** ; une contrainte réelle supposerait de fermer `openOpfsVolume` derrière un
module privé, ce qui est du travail découvert et non le périmètre de #12.

| Appel direct                                  | Raison                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `src/vm/opfs-import-target.mjs:63`            | la restauration elle-même : c'est elle qui va identifier le volume |
| `public/vm/reference-worker.mjs:203`          | `phasePrepare` : création depuis l'image, manifeste inscrit après  |
| `public/vm/reference-worker.mjs:388`          | `phasePrepareEmpty` : création du témoin, manifeste inscrit après  |
| `public/vm/reference-worker.mjs:437`          | `phaseExportVolume` : **lecture seule**                            |
| `public/vm/reference-worker.mjs:592`          | `phaseDigestVolume` : **lecture seule** (mesure)                   |
| `public/vm/opfs-runtime-worker.mjs` (5 sites) | banc du backend de blocs #6 : aucun volume applicatif              |
| `public/vm/runtime-worker.mjs` (3 sites)      | bancs de barrière #4/#14 : aucun volume applicatif                 |

Renvoi : #93 a scindé `public/vm/reference-worker.mjs`, arrivé au plafond de 800 lignes du dépôt ;
`phasePrepare` et `phasePrepareEmpty` vivent désormais dans `reference-worker-phases-volume.mjs`,
`phaseExportVolume` dans `reference-worker-phases-archive.mjs` et `phaseDigestVolume` dans
`reference-worker-phases-volume.mjs`. Les appels eux-mêmes sont inchangés.

C'est ce qui donne leur portée aux gestes 4 et 7. Une restauration interrompue — onglet fermé, quota
atteint, support perdu — laisse une cible sans voisin ; le boot suivant est refusé par
`VAULT_MANIFEST_UNIDENTIFIED` **avant** que v86 ne démarre et que Rails ne monte un système de
fichiers tronqué. `SEC-UPDATE-001` cesse d'être une règle sans appelant : elle avait un énoncé
depuis #10, il lui manquait un lecteur sur le chemin de boot et le code qui **écrit** le manifeste.

En corollaire, toute création de volume l'inscrit : la préparation d'un volume à partir de l'image
de référence écrit son manifeste **après** avoir écrit et flushé le disque. Un volume à moitié
préparé est donc, lui aussi, non identifié.

**Politique de transition, explicite : il n'y en a pas.** Un volume sans manifeste est refusé en
écriture, sans période de tolérance et sans manifeste fabriqué à la volée — inventer une identité
pour un volume qu'on ne connaît pas serait précisément l'écriture non identifiée que l'invariant
refuse. Aucun format n'ayant été publié (série `0.x`, `docs/release-policy.md`), aucun volume
d'utilisateur n'est concerné ; les volumes que le dépôt fabrique lui-même reçoivent leur manifeste à
la création. Si un volume antérieur devait être récupéré, le chemin est l'export puis la
restauration, non l'assouplissement de la règle.

### Écraser exige un consentement ; retailler est toujours refusé

Une cible non vide est **refusée par défaut** (`VAULT_IMPORT_TARGET_NOT_EMPTY`). L'appelant peut
consentir explicitement (`overwrite`), et le consentement est inscrit dans le compte rendu.

**Reprendre une restauration interrompue exige donc un consentement**, et c'est voulu. Une cible
interrompue est pleine d'octets partiels et dépourvue de manifeste : la restauration la voit occupée
(`identified: false` dans le contexte du refus) et s'arrête. Elle ne déduit pas qu'un volume occupé
mais non identifié est un rebut — cette déduction serait une licence d'écraser, et c'est justement
ce que l'exigence de consentement retire au produit. Le refus **nomme** l'état, il ne le cache pas :
`identified: false` dit à l'exploitant que la cible n'est plus valide et que la reprise est sûre.
C'est le cas de reprise le plus probable, et il est éprouvé en unitaire.

Un volume existant n'est en revanche **jamais retaillé**, consentement ou non
(`VAULT_IMPORT_GEOMETRY_MISMATCH`) : #6 tient la géométrie pour immuable — « un volume existant
n'est jamais retaillé en silence ; exporter puis migrer ». La restauration refuse et laisse
l'exploitant retirer la cible ; elle ne supprime jamais de données de sa propre initiative, comme #9
l'exige déjà de ses procédures de récupération.

### L'espace est réservé avant la mutation, et l'inconnu n'est pas zéro

La restauration branche la couche budget de #9 : la réservation est demandée **avant** le premier
octet écrit, et porte sur le besoin **net** — écraser sur place un volume de même géométrie ne
consomme pas un octet de plus, et réclamer la taille totale ferait refuser, pour espace insuffisant,
une restauration qui n'en demande aucun. Un refus faux est aussi grave qu'une acceptation fausse.

Un espace estimé insuffisant est un refus typé (`VAULT_IMPORT_SPACE_INSUFFICIENT`) qui porte le
`BudgetDiagnostic` de #9 — donc son remède, « libérer de la place », et non un remède inventé. Une
**estimation indisponible** reste l'état `unknown` de #9 : la restauration se poursuit et rend le
diagnostic. Traiter l'inconnu comme une capacité nulle bloquerait à tort un support parfaitement
sain.

### La compatibilité et l'algorithme sont contrôlés d'office, jamais sur demande

La vérification de l'archive (geste 1) applique `assertReadable` de #10 **par défaut**, avec ou sans
attentes fournies : sans attente, la plage de formats de ce runtime s'applique déjà. Un contrôle qui
ne s'exécute que si l'appelant pense à le demander n'est pas un contrôle. La dérogation existe pour
un outil de **diagnostic** — lire un conteneur qu'on ne saurait pas ouvrir en écriture — mais elle
doit être demandée nommément (`enforceCompatibility: false`).

De même, l'algorithme d'empreinte est **épinglé** à `sha-256`, à la création du manifeste comme à la
relecture d'une archive. Le dépôt ne sait calculer que celui-là ; accepter une autre étiquette la
rendrait persistante sans qu'aucun code ne l'honore — un manifeste affirmerait « sha-1 » pendant que
la vérification comparerait un SHA-256. Un second algorithme exigera une version de format.

### Re-vérifier, c'est RELIRE le support

Le geste 6 ne rejoue pas l'empreinte des octets qu'on vient d'écrire : il les **relit depuis le
support**, bloc par bloc, et recalcule. Écrire n'est pas persister ; c'est exactement la distinction
que `SEC-DURABLE-001` et la barrière de #14 posent déjà. Une relecture divergente est
`VAULT_IMPORT_VERIFICATION_FAILED`, et le manifeste n'est jamais inscrit.

Le coût est une lecture complète du volume de plus. Il est assumé : la restauration est un geste
rare, et une restauration muette qui rend un volume corrompu coûterait la donnée de l'utilisateur.

### Le transport de l'archive n'est pas une capacité du produit

L'archive quitte l'origine d'export par un **téléchargement** vers le système de fichiers de
l'utilisateur, et entre dans l'origine de restauration par un **champ de fichier**. Ce sont les deux
gestes utilisateur réels. Aucun canal inter-origines n'est ouvert, aucun serveur relais n'est
ajouté, aucune directive de CSP n'est assouplie. Le `File` remis par OPFS est adossé au support : il
est lu par tranches et diffusé par le navigateur sans que la page ne tienne l'archive en mémoire.

Cela crée **une exception étroite** à la règle « la coquille ne reçoit que du JSON » (ADR 0002) :
pour déclencher un téléchargement, il faut un objet que la page puisse remettre au navigateur.
L'exception est bornée et assumée — le Worker remet un `File` en **lecture seule**, portant
l'**archive** et non le volume, et le handle exclusif ne quitte jamais le Worker. Elle est inscrite
dans `SECURITY.md` sous `SEC-ORIGIN-001`. L'alternative — que la page ouvre elle-même OPFS — serait,
elle, une véritable brèche.

Et « l'archive, jamais le volume » est **contraint par le code**, non par une convention de nom : le
Worker lit les huit premiers octets du fichier demandé et exige le marqueur `RBVAULT1` de l'ADR 0008
avant de remettre quoi que ce soit. Un nom peut mentir ; un marqueur de contenu, non. Demander le
fichier d'un volume est refusé par `VAULT_ARCHIVE_MALFORMED`.

## Ce que le manifeste inscrit atteste — et ce qu'il n'atteste pas

Le manifeste écrit au geste 7 porte, dans `identity.digest`, l'empreinte du contenu **tel qu'il
vient d'être restauré**. Dès la première écriture du guest — le boot suivant, la première requête
Rails — cette empreinte cesse de décrire le volume courant, et **rien ne l'invalide**. Ce n'est pas
un oubli : c'est la sémantique retenue, et elle doit être dite plutôt que découverte.

- `identity.digest` atteste l'**état restauré**, c'est-à-dire la provenance : « ce volume vient de
  cette archive-là ». Il n'atteste pas l'état courant.
- `assertVolumeWritable` (#10) ne le compare à rien : il juge le format, le runtime et l'identité de
  l'application, jamais le contenu. Un volume mutable dont l'empreinte serait vérifiée à chaque
  ouverture ne pourrait jamais être écrit.
- Toute évolution qui le comparerait au contenu — vérification d'intégrité au montage, détection de
  corruption — serait un **changement de contrat**, à décider par un nouvel ADR, et supposerait
  d'abord un moyen de le mettre à jour à chaque barrière. C'est le terrain de #16 (générations) et
  du jalon 4 (blocs authentifiés), pas celui de la restauration.

## Ce qui est explicitement réservé

- **Les migrations de format** → #13. Un manifeste d'un format antérieur est **lisible** (donc
  restaurable), mais #10 refuse ensuite son ouverture en écriture par
  `VAULT_MANIFEST_MIGRATION_REQUIRED` : la restauration ne migre rien et ne prétend pas le faire.
- **Le déchiffrement et l'authentification de l'archive** → jalon 4. L'archive v1 n'est ni chiffrée
  ni signée : la restauration prouve l'**intégrité** de ce qu'elle écrit, pas l'**authenticité** de
  ce qu'elle a reçu. Un support hostile peut forger une archive cohérente avec elle-même.
- **L'atomicité d'une génération** → #16. La restauration écrit dans la cible, elle ne construit pas
  une génération copy-on-write basculée à la fin.
- **Une interface utilisateur de restauration.** Le champ de fichier de la coquille est un banc de
  preuve, pas un parcours produit.

## Ce qui est explicitement refusé

- **Écrire avant d'avoir vérifié l'archive entière.** La vérification précède toute mutation, sans
  exception.
- **Écraser une cible non vide sans consentement explicite.** Refus typé.
- **Retailler un volume existant.** Refus typé, avec ou sans consentement.
- **Déclarer valide un volume qu'on n'a pas relu.** Le manifeste n'est inscrit qu'après relecture.
- **Supprimer des données de sa propre initiative** pour faire de la place ou pour « réparer » une
  cible.
- **Reconditionner les refus de #10 et #11.** `ManifestError` et `ArchiveError` remontent telles
  quelles ; la restauration n'ajoute que ce qui lui est propre.
- **Ouvrir un canal inter-origines** pour transporter l'archive, ou assouplir la CSP de la coquille.

## Erreurs ajoutées

Une famille **distincte** de celles du stockage (#4/#6), du bail (#8), du manifeste (#10) et de
l'archive (#11), pour la raison qui les sépare déjà entre elles : des remèdes différents. Même forme
transportable (`code`, message français, contexte, `toJSON`), dans `src/vm/import-errors.mjs`.

| Code                               | État                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| `VAULT_IMPORT_TARGET_NOT_EMPTY`    | la cible porte déjà un volume : consentement explicite exigé        |
| `VAULT_IMPORT_SPACE_INSUFFICIENT`  | espace estimé inférieur au volume : refusé avant toute mutation     |
| `VAULT_IMPORT_GEOMETRY_MISMATCH`   | la cible n'a pas la géométrie de l'archive : jamais retaillée       |
| `VAULT_IMPORT_VERIFICATION_FAILED` | le volume relu ne rend pas l'empreinte de l'archive : non identifié |

## Preuves

- `tests/unit/vm-volume-import.test.mjs` (rattaché à `npm run check`) : l'ordre des sept gestes,
  l'absence totale de mutation sur archive altérée ou tronquée, le refus de cible non vide, le
  diagnostic de #9 sur espace insuffisant, la réservation **nette** sur écrasement, l'estimation
  inconnue qui ne bloque pas, la géométrie refusée, la relecture divergente qui laisse le volume non
  identifié, la `ManifestError` de #10 propagée telle quelle, le streaming borné, l'idempotence, le
  suffixe réservé, le voisin illisible refusé sans être supprimé, la compatibilité contrôlée par
  défaut — et surtout la **défaillance en cours de restauration**, injectée aux quatre points de
  rupture (ouverture, écriture du troisième bloc via le `FaultPlan` du dépôt, barrière, inscription
  du manifeste) : à chaque fois, le handle est rendu, le manifeste reste absent, rien n'est déclaré
  valide.
- `tests/unit/vm-opfs-volume-open.test.mjs` (rattaché à `npm run check`) : l'ouverture en écriture
  refuse un volume sans manifeste, d'une autre application, au voisin illisible ou démesuré — et le
  refus **précède** l'ouverture, ce que le double mesure en comptant les ouvertures réellement
  tentées.
- `tests/e2e/restauration-inter-origine.spec.mjs` (job CI non bloquant `Reprise MVP`) : sur **deux
  origines réellement distinctes**, une mutation Rails sur A, un export, un transfert par le système
  de fichiers de l'hôte, un import sur B, un **boot à froid hors ligne** sur B et la vérification
  Rails de l'invariant — plus la preuve préalable que l'OPFS de B ignorait tout du volume de A, et
  quatre témoins négatifs : archive altérée refusée sans rien écrire, cible non vide refusée sans
  toucher au volume valide, **manifeste voisin retiré → boot refusé** par
  `VAULT_MANIFEST_UNIDENTIFIED`, et **extraction du `File` d'un volume refusée** par
  `VAULT_ARCHIVE_MALFORMED`.

La preuve rouge/verte figure dans la description de la pull request.

## Risques et conditions d'abandon

1. **Le manifeste voisin peut être séparé de son volume.** Rien n'empêche un tiers ayant accès à
   l'origine de supprimer le voisin seul : le volume devient alors non identifié, donc non
   inscriptible. C'est un échec **sûr** (refus), jamais une écriture sur un volume inconnu, mais
   c'est une perte d'usage. Un manifeste authentifié et lié au volume relève du jalon 4.
2. **La restauration reste vulnérable à une archive forgée.** L'intégrité est prouvée,
   l'authenticité non : la confiance repose sur l'origine du fichier, c'est-à-dire sur
   l'utilisateur.
3. **La re-vérification double le temps de lecture.** Sur un volume de 512 Mio, elle ajoute une
   passe complète. Si un volume de plusieurs Gio rendait ce coût inacceptable, la re-vérification
   devrait être échantillonnée ou déplacée — ce serait un nouvel ADR, pas un réglage.
4. **Deux origines servies par le harnais de test ne sont pas deux appareils.** Elles prouvent le
   cloisonnement OPFS, qui est la propriété en jeu ; elles ne prouvent ni le transport réseau, ni la
   portabilité entre systèmes d'exploitation.

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- le manifeste doit être authentifié ou lié cryptographiquement au volume (jalon 4) ;
- la restauration doit migrer un format antérieur au lieu de le refuser en écriture (#13) ;
- l'atomicité de génération (#16) impose de restaurer dans une génération plutôt que dans la cible ;
- le coût de la re-vérification devient prohibitif sur les tailles de volume réellement rencontrées.

## Alternatives rejetées

- **Restaurer d'abord, vérifier ensuite.** Rejeté : une archive altérée aurait alors déjà écrasé la
  cible. La vérification complète en amont coûte une passe de lecture ; elle achète la certitude
  qu'un refus ne détruit rien.
- **Écrire le manifeste en tête du volume.** Rejeté : les octets du volume sont servis tels quels à
  v86 ; un en-tête décalerait le système de fichiers du guest. Le manifeste vit à côté.
- **Marquer un volume incomplet par un drapeau « invalide ».** Rejeté : cela ajouterait un état à
  inventer et à interpréter, alors que **l'absence** du manifeste est déjà un état que #10 sait
  refuser. Ne rien inventer vaut mieux qu'un second mécanisme parallèle.
- **Effacer la cible quand la re-vérification échoue.** Rejeté : #9 pose qu'aucune procédure de
  récupération ne supprime de données. Le volume reste, non identifié, et l'exploitant décide.
- **Faire transiter l'archive par un canal inter-origines (relais HTTP, `postMessage`, canal
  partagé).** Rejeté : il faudrait assouplir `connect-src 'self'` ou ajouter un service au produit
  pour un transport que l'utilisateur fait déjà avec son système de fichiers.
- **Réutiliser une seule origine et deux répertoires OPFS.** Rejeté : ce ne serait pas une
  restauration inter-origine. Le cloisonnement OPFS par origine est précisément ce qui rend le
  scénario significatif, et le test le prouve avant d'importer.
