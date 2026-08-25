# ADR 0011 — La migration va d'un format au suivant, exige une preuve avant de muter, et reprend depuis son journal

- Statut : accepté
- Date : 2026-08-25
- Issue : #13 · Invariant : `VAULT-COMPAT-001` · Jalon 2

## Contexte

`docs/release-policy.md` (§ « Compatibilité du volume ») exige six choses d'un volume versionné.
Quatre concernent la migration :

1. « lecture d'une version connue avant toute écriture » ;
2. « export de sauvegarde obligatoire avant migration irréversible » ;
3. « refus explicite d'un format futur ou d'un downgrade dangereux » ;
4. « reprise déterministe après interruption de migration ».

L'[ADR 0007](0007-manifeste-de-volume.md) a livré la première et la troisième — mais seulement comme
**refus**. Il refuse d'écrire sur un format antérieur (`VAULT_MANIFEST_MIGRATION_REQUIRED`) sans
dire comment en sortir, et il le reconnaissait lui-même : « le détail des migrations et le
copy-on-write → #13 ». Les deuxième et quatrième exigences n'avaient aucune existence dans le code.
Elles étaient des phrases.

Or l'ADR 0007 posait aussi, dans ses conditions de révision, le fait qui déclenche cette décision :
« un deuxième format de volume est publié, éprouvant réellement la règle de migration ». C'est ce
que fait cette PR. Elle en établit un second, qu'il signalait comme un risque assumé :

> **Le downgrade est jugé sur le major SemVer seul.** […] Elle devra être revue si une rupture de
> runtime devait être exprimée autrement qu'en major.

C'est déjà le cas, et depuis le début. `docs/release-policy.md` énonce qu'« une rupture d'API
runtime incrémente le mineur en `0.x` », et le paquet est en `0.1.0`. Les deux majeurs comparés
valent donc 0, la comparaison `volume.major > running.major` est **toujours fausse**, et le refus de
downgrade de v1 ne peut rien refuser tant que la série `0.x` dure. Ce n'était pas une règle prudente
: c'était une règle inerte.

## Décision

**Le format de volume passe à v2, qui fait DÉCLARER au volume le plus ancien runtime autorisé à
l'écrire. Un module pur (`src/vm/volume-migration.mjs`) migre un volume d'un format au SUIVANT, une
étape enregistrée à la fois, après avoir exigé une preuve de sauvegarde et journalisé de quoi
reprendre ; une migration interrompue laisse un volume NON IDENTIFIÉ, jamais un volume à moitié
migré présenté comme valide.**

### v2 : `runtime.minWriter`, déclaré et non deviné

Le format v2 ajoute **un seul** champ, obligatoire :

```text
runtime: { version: "<SemVer>", artifact: <string|null>, minWriter: "<SemVer>" }
```

`minWriter` est la version de runtime la plus ancienne autorisée à écrire ce volume, **déclarée par
le runtime qui l'écrit**. Le refus de downgrade cesse d'être une supposition sur le majeur SemVer
pour devenir une comparaison entre deux valeurs dont l'une a été écrite exprès :

```text
downgrade  ⟺  compareSemVer(runtime en cours, volume.runtime.minWriter) < 0
```

Trois conséquences tenues par le code :

- **Chaque format est jugé par SA règle.** Un manifeste v1 n'a pas ce champ ; il conserve la règle
  v1 (« majeur du volume > majeur en cours ») au lieu de recevoir d'office une valeur qu'il n'a
  jamais portée. Inventer un `minWriter` pour un volume v1 serait affirmer quelque chose que son
  auteur n'a pas dit ;
- **`minWriter` ne peut pas dépasser `version`.** Un volume qui s'interdirait à son propre auteur
  est un manifeste malformé, refusé à la création comme à la relecture ;
- **`minReadable` reste 1.** Un volume v1 demeure **lisible** — donc exportable (#11), restaurable
  (#12) et migrable — et seule son **écriture** est refusée, par
  `VAULT_MANIFEST_MIGRATION_REQUIRED`, exactement comme depuis #10. Le format v2 n'orpheline aucun
  volume.

### La chaîne va d'un format au SUIVANT, une étape à la fois

`STEPS` est une table d'étapes **enregistrées**, chacune d'un format `n` vers `n + 1`. Un contrôle
au chargement du module refuse une étape non contiguë : la table ne peut pas contenir de raccourci.

`planMigration(from, to)` compose la chaîne pas à pas. Il n'existe **aucun** chemin direct d'un
format vers un format lointain : migrer 1 → 3 exige que 1 → 2 et 2 → 3 existent tous les deux, et
produit un manifeste valide à chaque palier. Deux refus typés bornent la fonction :

| Situation                                 | Code de refus                       |
| ----------------------------------------- | ----------------------------------- |
| une étape manque à la chaîne              | `VAULT_MIGRATION_NO_PATH`           |
| le format demandé précède celui du volume | `VAULT_MIGRATION_DOWNGRADE_REFUSED` |

Le second applique la règle de l'ADR 0007 au geste de migration lui-même : **une migration ne
descend jamais.** Revenir à un format antérieur suppose de restaurer une sauvegarde (#12), pas de «
démigrer ». C'est délibéré : une étape descendante devrait défaire ce que l'étape montante a établi,
et rien ne garantit qu'elle le puisse sans perte.

L'étape 1 → 2 enregistrée ici **n'écrit aucun octet dans le volume**. Elle traduit la règle v1 en
une valeur explicite : le plus ancien écrivain que la règle v1 admettait était le plancher du majeur
du runtime ayant écrit le volume (« 2.7.3 » → « 2.0.0 »). `identity` est reconduite telle quelle,
puisque aucun octet ne bouge : ce que le digest attestait (l'état au moment de son inscription,
[ADR 0009](0009-restauration-inter-origine.md)) reste exactement aussi vrai — ni plus, ni moins.

### L'ordre des dix gestes est le contrat

`migrateVolume` exécute dix gestes, et leur ordre porte toutes les garanties :

| #   | Geste                   | Ce que sa position garantit                                                        |
| --- | ----------------------- | ---------------------------------------------------------------------------------- |
| 1   | LIRE                    | les refus de #10 tombent avant qu'aucun handle ne soit pris                        |
| 2   | PLANIFIER               | un saut ou une descente est refusé avant toute mutation                            |
| 3   | EXIGER UNE PREUVE       | sans preuve, **la cible n'est même pas ouverte**                                   |
| 4   | OUVRIR                  | une ouverture ratée ne rend pas inutilisable un volume intact                      |
| 5   | VÉRIFIER LA SAUVEGARDE  | l'archive est confrontée au volume **avant** le premier octet écrit                |
| 6   | JOURNALISER             | la reprise a un point de départ **avant** que le manifeste ne disparaisse          |
| 7   | RÉVOQUER                | à partir d'ici, le boot refuse le volume : une migration en cours n'est pas valide |
| 8   | APPLIQUER puis BARRIÈRE | les octets sont durables avant qu'on prétende les avoir migrés                     |
| 9   | INSCRIRE puis RELIRE    | écrire n'est pas persister : un manifeste non relu n'est pas déclaré valide        |
| 10  | RETIRER LE JOURNAL      | dernier geste : sa présence signale **toujours** une migration inachevée           |

Le geste 4 avant le geste 7 reprend la correction de
l'[ADR 0009](0009-restauration-inter-origine.md) (point B4 de sa revue) : révoquer avant d'avoir le
handle rendrait inutilisable un volume que l'on n'a finalement pas touché.

### « Sauvegarde obligatoire » est un CONTRÔLE, pas une phrase

C'est le point où une migration peut mentir le plus facilement. Voici exactement ce que le code
exige, et ce qu'il vérifie.

**Deux preuves sont admises, et il n'y en a pas de troisième** ni d'implicite :

1. **une archive de sauvegarde VÉRIFIÉE** (`sauvegarde-verifiee`). L'archive n'est pas _annoncée_ :
   elle est **relue** par `readArchive` de #11 — structure, en-tête, empreinte SHA-256 du contenu
   recalculée en flux — puis confrontée au volume **tel qu'il est à cet instant** :

   - l'archive décrit-elle la même application (`app.id`) ?
   - porte-t-elle exactement autant d'octets que le volume ?
   - le volume, **relu depuis le support** et empreinté indépendamment, rend-il la même empreinte
     que celle recalculée depuis l'archive ?

   Une seule divergence lève `VAULT_MIGRATION_BACKUP_MISMATCH` avant toute mutation. Une lecture
   courte pendant cette vérification lève une `TypeError` plutôt qu'un verdict conforme : un
   contrôle qui se contente de ce qu'on lui rend n'en est pas un ;

2. **un consentement NOMMÉ** (`consentement-nomme`). Un exploitant identifié assume la migration
   sans sauvegarde. `acknowledgedBy` doit être une chaîne non vide — un consentement anonyme n'en
   est pas un — et il est **inscrit dans le journal**, donc opposable après coup.

Sans l'une ni l'autre, `VAULT_MIGRATION_BACKUP_REQUIRED` est levé au geste 3 : **la cible n'est pas
ouverte**, le manifeste n'est pas touché, aucun journal n'est écrit.

Ce que ce contrôle **n'atteste pas** : l'**authenticité** de l'archive — elle n'est ni signée ni
chiffrée (jalon 4) —, ni qu'elle sera encore là demain. Il atteste que l'archive présentée
**permettrait**, à cet instant, de revenir à l'état actuel du volume.

### La reprise repart du journal, et ne redemande rien

Le journal de reprise est un fichier **voisin** du volume, `<volume>.migration`, du même genre que
le manifeste voisin de l'[ADR 0009](0009-restauration-inter-origine.md) et pour la même raison : les
octets du volume sont servis tels quels à v86, et y intercaler quoi que ce soit décalerait le
système de fichiers du guest.

**Pourquoi un journal séparé plutôt qu'un drapeau dans le manifeste** : la migration **révoque** le
manifeste au geste 7. Une fois révoqué, plus rien ne dirait de quel format le volume vient. Le
journal porte donc les trois choses sans lesquelles une reprise serait une devinette :

- le **manifeste SOURCE** intégral — l'identité que le volume avait avant qu'on y touche ;
- la **chaîne visée** (`from`, `to`) ;
- la **preuve retenue**, telle qu'elle a été acceptée au geste 5.

D'où la stratégie de reprise, et sa justification :

- **la reprise ne redemande PAS la sauvegarde.** L'exiger de nouveau ferait d'une interruption une
  impasse : l'utilisateur qui a fermé son onglet au mauvais moment devrait re-exporter un demi-
  gigaoctet — sur un volume que le boot refuse désormais d'ouvrir. La preuve a été vérifiée une
  fois, contre l'état du volume à cet instant, et le volume n'a pas bougé depuis : aucune étape
  enregistrée n'écrit dans le volume, et si une future étape le faisait, la reprise recommencerait
  sa chaîne depuis le manifeste source, pas depuis un état intermédiaire ;
- **la reprise recommence la chaîne**, elle ne devine pas un point d'arrêt. C'est possible parce que
  l'application d'une étape est une **fonction du manifeste source**, pas une accumulation d'effets
  ;
- **un journal illisible fait REFUSER** (`VAULT_MIGRATION_JOURNAL_MALFORMED`). Il n'est ni supprimé,
  ni deviné : il signale une migration inachevée dont on ignore l'état de départ, et passer outre
  reviendrait à réinventer une identité pour le volume. L'écarter est un geste explicite
  d'exploitant. Un journal **démesuré** n'est pas lu du tout — poser une question ne doit pas coûter
  un gigaoctet ;
- **un journal resté derrière un manifeste DÉJÀ au format visé** signale une interruption survenue
  entre les gestes 9 et 10 : la migration a abouti. Il est simplement retiré, et `migrateVolume`
  rend `migrated: false`. C'est ce qui la rend **idempotente**.

Entre le geste 7 et le geste 9, le volume est **non identifié**. `openVolumeForWrite` (ADR 0009) le
refuse alors par `VAULT_MANIFEST_UNIDENTIFIED`, avant même que v86 ne soit construit. C'est la
propriété centrale : **une migration interrompue ne peut pas se faire passer pour un volume
valide.**

### Le nommage réserve le suffixe, et borne le nom des volumes

`.migration` rejoint `.manifest` dans `RESERVED_SIDECAR_SUFFIXES` : aucun volume ne peut porter l'un
de ces suffixes, sans quoi migrer « donnees » détruirait un volume légitime nommé «
donnees.migration ». La longueur maximale d'un nom de volume se règle désormais sur le **plus long**
des voisins réservés, et non sur le seul manifeste — un volume créable reste ainsi toujours un
volume migrable, au lieu de découvrir trop tard qu'il manque de place pour son journal.

## Erreurs ajoutées

Famille **distincte** de celles du stockage (#4/#6), du bail (#8), du manifeste (#10), de l'archive
(#11) et de la restauration (#12), pour la raison qui les sépare déjà entre elles : des remèdes
différents. « Aucune étape enregistrée vers ce format » n'appelle pas la même conduite que « votre
sauvegarde ne décrit pas ce volume ». Même forme transportable (`code`, message français, contexte,
`toJSON`) pour traverser `postMessage`.

| Code                                  | État                                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| `VAULT_MIGRATION_NO_PATH`             | aucune étape enregistrée ne relie le format du volume au demandé  |
| `VAULT_MIGRATION_DOWNGRADE_REFUSED`   | le format demandé est antérieur : une migration ne descend jamais |
| `VAULT_MIGRATION_BACKUP_REQUIRED`     | ni sauvegarde vérifiée, ni consentement nommé : rien n'est ouvert |
| `VAULT_MIGRATION_BACKUP_MISMATCH`     | l'archive ne décrit pas ce volume dans son état courant           |
| `VAULT_MIGRATION_JOURNAL_MALFORMED`   | journal présent mais illisible : jamais deviné, jamais supprimé   |
| `VAULT_MIGRATION_VERIFICATION_FAILED` | le manifeste relu diverge de l'inscrit : volume non identifié     |

Les refus de #10 (`VAULT_MANIFEST_FORMAT_TOO_NEW`, `..._IDENTITY_MISMATCH`, `..._UNIDENTIFIED`) **ne
sont pas reconditionnés** : ils remontent tels quels.

## Preuves

| Niveau       | Fichier                                         | Support               | Rattachement      |
| ------------ | ----------------------------------------------- | --------------------- | ----------------- |
| unitaire     | `tests/unit/vm-volume-migration.test.mjs`       | doubles déterministes | `npm run check`   |
| unitaire     | `tests/unit/vm-volume-manifest.test.mjs`        | aucun                 | `npm run check`   |
| Bout en bout | `tests/e2e/migration-volume-versionne.spec.mjs` | OPFS + image #5 + v86 | job `Reprise MVP` |

Le niveau unitaire éprouve l'**ordre des gestes**, qui est le contrat : une cible en mémoire compte
chaque geste, ce qui permet d'affirmer non pas « la migration a échoué » mais « la cible n'a même
pas été ouverte ». Une panne est injectée à **chacun des cinq points de rupture** — ouverture,
inscription du journal, révocation, barrière, inscription du manifeste — et la suite exige à chaque
fois que le volume reste non identifié plutôt que présenté comme valide à moitié, et que le handle
ait été rendu.

Le niveau Bout en bout enchaîne, sur un vrai volume OPFS et une vraie application Rails : volume v1
refusé au boot → migration sans sauvegarde refusée → export de sauvegarde (#11) → migration
**interrompue** après la révocation → boot refusé (`VAULT_MANIFEST_UNIDENTIFIED`) → **reprise** sans
redemander l'archive → **boot à froid hors ligne** retrouvant l'invariant Rails à l'octet près →
refus par un runtime qui ne connaît que le format 1. Le détail figure dans `docs/testing.md`.

La preuve rouge/verte figure dans la description de la pull request.

## Limites

Ces limites sont **connues et assumées**. Aucune n'est corrigée par cette décision.

1. **Le runtime « ancien » est SIMULÉ par ses attentes.** Le témoin de refus de downgrade Bout en
   bout n'exécute pas un binaire antérieur : il exécute le runtime courant à qui l'on **déclare**
   une plage de formats plus étroite (`supportedFormat: { current: 1, minReadable: 1 }`). Le test
   prouve que **la règle de compatibilité refuse** ; il ne prouve pas le comportement d'une version
   publiée antérieurement — aucune release n'en a encore produit. Cette limite disparaîtra le jour
   où le dépôt conservera des **vecteurs de test par version publiée**, ce que
   `docs/release-policy.md` exige et qui reste à faire ;
2. **`minWriter` n'est pas prouvé sur un vrai downgrade non plus.** Le refus
   `VAULT_MANIFEST_RUNTIME_DOWNGRADE` fondé sur `minWriter` est éprouvé en unitaire, en fabriquant
   les deux versions. La série `0.x` n'ayant publié qu'une version, aucun scénario ne confronte deux
   runtimes réellement distincts ;
3. **Aucune étape enregistrée n'écrit dans le volume aujourd'hui.** L'étape 1 → 2 ne touche que le
   manifeste. L'ordre des gestes est conçu pour qu'une étape future qui écrirait n'ait pas à
   réinventer sa sûreté, mais cette sûreté-là n'est **pas encore exercée** par une étape réelle ;
4. **Le manifeste et le journal ne sont ni chiffrés ni authentifiés** (jalon 4). Un support hostile
   peut forger un journal et faire reprendre une migration depuis un manifeste source inventé. La
   confiance repose sur le partitionnement OPFS par origine
   ([ADR 0002](0002-topologie-origine-de-confiance.md)) ;
5. **Pas d'atomicité de génération.** La migration n'est pas une transaction copy-on-write : entre
   les gestes 7 et 9 le volume est dans un état intermédiaire **sûr** (non identifié, donc non
   inscriptible) mais **pas révocable en un geste**. La génération copy-on-write que
   `docs/release-policy.md` évoque (« migration sur une nouvelle génération copy-on-write ») reste
   **#16** ;
6. **Le journal peut être séparé de son volume.** L'échec est alors sûr — le volume reste non
   identifié, donc non inscriptible — mais c'est une perte d'usage : sans journal ni manifeste, la
   reprise est impossible et il faut restaurer la sauvegarde ;
7. **Une seule chaîne à un seul pas est éprouvée en vrai.** `planMigration` compose des chaînes plus
   longues et ses refus sont couverts en unitaire, mais aucune migration 1 → 3 n'a jamais tourné sur
   un vrai volume : le deuxième pas n'existe pas encore.

## Ce qui est explicitement réservé

- **La génération copy-on-write et l'atomicité transactionnelle** → #16 ;
- **Le chiffrement et l'authentification du manifeste et du journal** → jalon 4 ;
- **Les vecteurs de test conservés par version publiée** (`docs/release-policy.md`) : ils exigent
  qu'une version soit publiée ;
- **Les migrations métier de l'application Rails**, distinctes des migrations du format Vault
  (`docs/architecture.md`) ; la version d'application n'entre dans aucun refus.

## Ce qui est explicitement refusé

- **Migrer sans preuve.** `VAULT_MIGRATION_BACKUP_REQUIRED` ; la cible n'est pas ouverte ;
- **Accepter une sauvegarde sur parole.** L'archive est relue et son empreinte confrontée à celle du
  volume relu depuis le support ;
- **Sauter un format.** `VAULT_MIGRATION_NO_PATH` : la chaîne n'est jamais devinée ;
- **Descendre d'un format.** `VAULT_MIGRATION_DOWNGRADE_REFUSED` : restaurer une sauvegarde est le
  seul retour en arrière ;
- **Déclarer un manifeste valide sans l'avoir relu depuis le support.** Une relecture divergente le
  retire et laisse le volume non identifié ;
- **Supprimer ou deviner un journal illisible.** L'écarter est un geste explicite ;
- **Inventer un `minWriter` pour un manifeste v1.** Chaque format est jugé par sa propre règle.

## Risques et conditions d'abandon

Risques résiduels, au-delà des limites ci-dessus :

1. **Un volume v1 qui perdrait son manifeste avant migration est irrécupérable sans sauvegarde.**
   C'est le prix de l'exigence d'identité de l'ADR 0009, et il est assumé : l'alternative serait de
   deviner une identité ;
2. **La vérification de sauvegarde relit le volume entier**, en plus de l'archive entière. Une
   migration coûte donc au moins deux passes de lecture complètes avant de muter. Assumé : c'est ce
   qui distingue un contrôle d'une déclaration ;
3. **`createOpfsMigrationTarget` fait 75 lignes** (plafond du dépôt : 50), l'essentiel étant un
   objet littéral de méthodes d'une ligne et leurs commentaires. Elle n'est pas fendue ici : la
   découper pour la métrique nuirait à sa lisibilité. Trois fonctions **antérieures** à #13 restent
   également au-dessus — `phaseExportVolume` (61), `createBootTimeline` (58), `bootEtVerifier` (93)
   —. La PR #70 avait **proposé** une issue de suivi pour les découper sans jamais la créer ; c'est
   désormais l'**issue #77**, qui couvre les quatre fonctions.

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- une étape de migration doit **écrire dans le volume**, et donc éprouver réellement l'ordre des
  gestes 7 à 9 ;
- une génération copy-on-write (#16) rend la migration révocable en un geste, ce qui change la
  nature du journal ;
- une version publiée impose des vecteurs de test par version, rendant caduque la simulation du
  runtime ancien par ses attentes ;
- le manifeste devient authentifié, ce qui change ce qu'un journal voisin peut affirmer.

## Alternatives rejetées

- **Un drapeau « migration en cours » dans le manifeste**, plutôt qu'un journal voisin. Rejeté : le
  manifeste est **révoqué** pendant la migration ; un drapeau qu'il porterait disparaîtrait avec
  lui, et la reprise n'aurait plus de point de départ ;
- **Redemander la sauvegarde à la reprise.** Rejeté : cela transformerait une interruption en
  impasse, sur un volume que le boot refuse déjà d'ouvrir. La preuve inscrite au journal a été
  vérifiée contre l'état du volume, et cet état n'a pas bougé ;
- **Un chemin de migration direct d'un format lointain vers le courant.** Rejeté : chaque palier
  intermédiaire doit produire un manifeste valide, sans quoi la chaîne est crue au lieu d'être
  vérifiable ;
- **Donner d'office un `minWriter` aux manifestes v1** lors de leur relecture. Rejeté : ce serait
  affirmer une contrainte que l'auteur du volume n'a jamais déclarée. Un format ancien garde sa
  règle ;
- **Rendre la sauvegarde facultative par défaut.** Rejeté : `docs/release-policy.md` la dit
  obligatoire. Le consentement nommé est l'échappatoire explicite, tracée dans le journal, et non un
  défaut silencieux ;
- **Migrer pendant le boot, à la volée.** Rejeté : une migration est un geste irréversible du point
  de vue du produit ; elle exige une preuve et une décision d'exploitant, pas un effet de bord d'un
  démarrage.
