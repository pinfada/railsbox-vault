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

**La restauration (`src/vm/volume-import.mjs`) exécute six gestes, dans cet ordre, et cet ordre fait
partie du contrat :**

| #   | Geste           | Ce qu'il garantit                                                                         |
| --- | --------------- | ----------------------------------------------------------------------------------------- |
| 1   | **Vérifier**    | l'archive entière est validée (empreinte recalculée + manifeste #10) sans écrire un octet |
| 2   | **Refuser**     | cible occupée, géométrie inconciliable, espace insuffisant — avant toute mutation         |
| 3   | **Révoquer**    | le manifeste de la cible est retiré : le volume cesse d'être présenté comme valide        |
| 4   | **Restaurer**   | le contenu est recopié octet pour octet, en flux, puis une barrière est franchie          |
| 5   | **Re-vérifier** | le volume est **relu depuis le support** et son empreinte confrontée à celle de l'archive |
| 6   | **Inscrire**    | le manifeste est écrit : seul ce dernier geste rend le volume présentable comme valide    |

Il n'existe donc **pas de restauration partielle silencieuse** : soit le volume est complet, relu et
identifié, soit l'échec est typé et le volume reste **non identifié**.

### Le manifeste est un fichier VOISIN, et il porte la validité

Le manifeste d'un volume restauré est écrit dans un fichier du même répertoire OPFS, nommé
`<volume>.manifest`, soumis à la même validation de frontière que le volume lui-même.

Il n'est **pas** placé en tête du volume : la géométrie de #6 est une suite de secteurs de 512
octets servie **telle quelle** à v86, que le guest monte comme un disque. Y intercaler un en-tête
décalerait le système de fichiers du guest de la taille du manifeste.

Ce voisin porte la **validité** du volume, et c'est ce qui donne son sens aux gestes 3 et 6. Un
volume sans son voisin est un volume non identifié, que `assertVolumeWritable` (#10) refuse par
`VAULT_MANIFEST_UNIDENTIFIED`. Une restauration interrompue — onglet fermé, quota atteint, support
perdu — laisse donc une cible que le runtime refuse d'ouvrir en écriture, sans qu'aucun code de
détection ait à être écrit : le refus de #10 existait déjà, il lui manquait ce que ce module écrit.

### Écraser exige un consentement ; retailler est toujours refusé

Une cible non vide est **refusée par défaut** (`VAULT_IMPORT_TARGET_NOT_EMPTY`). L'appelant peut
consentir explicitement (`overwrite`), et le consentement est inscrit dans le compte rendu.

Un volume existant n'est en revanche **jamais retaillé**, consentement ou non
(`VAULT_IMPORT_GEOMETRY_MISMATCH`) : #6 tient la géométrie pour immuable — « un volume existant
n'est jamais retaillé en silence ; exporter puis migrer ». La restauration refuse et laisse
l'exploitant retirer la cible ; elle ne supprime jamais de données de sa propre initiative, comme #9
l'exige déjà de ses procédures de récupération.

### L'espace est réservé avant la mutation, et l'inconnu n'est pas zéro

La restauration branche la couche budget de #9 : `reserve(volumeSize)` est appelée **avant** le
premier octet écrit. Un espace estimé insuffisant est un refus typé
(`VAULT_IMPORT_SPACE_INSUFFICIENT`) qui porte le `BudgetDiagnostic` de #9 — donc son remède, «
libérer de la place », et non un remède inventé. Une **estimation indisponible** reste l'état
`unknown` de #9 : la restauration se poursuit et rend le diagnostic. Traiter l'inconnu comme une
capacité nulle bloquerait à tort un support parfaitement sain.

### Re-vérifier, c'est RELIRE le support

Le geste 5 ne rejoue pas l'empreinte des octets qu'on vient d'écrire : il les **relit depuis le
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

- `tests/unit/vm-volume-import.test.mjs` (rattaché à `npm run check`) : l'ordre des six gestes,
  l'absence totale de mutation sur archive altérée ou tronquée, le refus de cible non vide, le
  diagnostic de #9 sur espace insuffisant, l'estimation inconnue qui ne bloque pas, la géométrie
  refusée, la relecture divergente qui laisse le volume non identifié, la `ManifestError` de #10
  propagée telle quelle, le streaming borné et l'idempotence.
- `tests/e2e/restauration-inter-origine.spec.mjs` (job CI non bloquant `Reprise MVP`) : sur **deux
  origines réellement distinctes**, une mutation Rails sur A, un export, un transfert par le système
  de fichiers de l'hôte, un import sur B, un **boot à froid hors ligne** sur B et la vérification
  Rails de l'invariant — plus la preuve préalable que l'OPFS de B ignorait tout du volume de A, et
  deux témoins négatifs (archive altérée, cible non vide).

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
