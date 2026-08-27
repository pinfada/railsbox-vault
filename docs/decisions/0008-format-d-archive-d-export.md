# ADR 0008 — Le format d'archive lie manifeste, contenu et empreinte vérifiable

- Statut : accepté
- Date : 2026-08-24
- Issue : #11 · Invariant : `VAULT-PORT-001` · Jalon 2

> **Amendé le 2026-08-28 par l'[ADR 0016](0016-format-de-volume-v3-dispositions.md) (#18).**
> L'archive d'un volume v3 porte le fichier CHIFFRÉ tel quel, si bien que `content.length` et
> `identity.digest` décrivent des octets chiffrés : deux exports d'un même contenu logique ne sont
> plus comparables par empreinte, et une archive restaurée n'est ouvrable qu'avec sa clé.

## Contexte

Le manifeste versionné de #10 ([ADR 0007](0007-manifeste-de-volume.md)) lie format, runtime,
application et géométrie, mais laisse `identity.digest` à `null` : il n'engage encore aucune
vérification du **contenu** du volume. `docs/release-policy.md` exige pourtant « export de
sauvegarde obligatoire avant migration irréversible » et « inventaire des artefacts et empreintes de
contenu », et `docs/architecture.md` place un « export portable » vers une autre origine ou un autre
appareil au bout de la chaîne de stockage. La restauration inter-origine (#12) a besoin d'un
conteneur qu'elle puisse vérifier **avant** toute mutation.

Trois contraintes de `docs/quality-attributes.md` encadrent cet export :

- **archive ≤ 2× la taille logique** utilisée ;
- **surmémoire de streaming ≤ 64 Mio** : le volume ne peut pas être tenu entier en mémoire ;
- l'export capture un **point cohérent** (au minimum : pas d'écriture en vol).

Un obstacle technique précis : `crypto.subtle.digest` de WebCrypto est une opération à **un seul
coup** — elle exige tous les octets d'un bloc, donc tout le volume en RAM — et WebCrypto n'offre
aucun hachage incrémental. `node:crypto` n'existe pas dans le Worker navigateur qui porte OPFS et
v86 (ADR 0002). Empreinter un volume de plusieurs centaines de Mio à surmémoire bornée, des deux
côtés, n'est donc pas faisable avec les primitives du moteur seules.

## Décision

**Un module (`src/vm/volume-export.mjs`) définit un format d'archive v1 qui lie, en un conteneur
portable, le manifeste de #10 — avec `identity.digest` enfin RENSEIGNÉ — et le contenu intégral du
volume, plus l'empreinte SHA-256 de ce contenu. L'export lit et empreinte le volume EN FLUX, à
surmémoire bornée. `verifyArchive` recalcule l'empreinte et valide le manifeste ; une archive
tronquée, altérée ou d'un manifeste incompatible produit un ÉCHEC TYPÉ, jamais un succès
silencieux.**

### Disposition binaire (figée)

```text
[ marqueur 8 o ][ longueur d'en-tête uint32 BE 4 o ][ en-tête JSON H o ][ contenu N o ]
```

- Le **marqueur** `RBVAULT1` distingue une archive de bruit, avant toute interprétation.
- La **longueur d'en-tête** délimite l'en-tête sans le scanner (streamable).
- L'**en-tête JSON** porte le `magic` textuel `railsbox-vault/volume-archive`, la version entière
  `archiveFormatVersion`, un descripteur `content` (`algorithm`, `digest`, `length`, `consistency`)
  et le **manifeste v1** de #10 avec son `identity.digest` renseigné.
- Le **contenu** est le volume octet pour octet. `offset du contenu = 12 + H` ;
  `taille de l'archive = 12 + H + N`. Le surcoût se limite au préambule et à l'en-tête (quelques
  centaines d'octets) : l'archive tient donc très en deçà de 2× la taille logique.

L'empreinte est inscrite **deux fois et croisée** : dans `manifest.identity.digest` (l'emplacement
versionné de #10) et dans `content.digest` (le descripteur d'archive). Une divergence entre les deux
est une archive malformée.

### Streaming à surmémoire bornée

`writeArchive` fait **deux passes** sur la source : la première empreinte le contenu (pour
renseigner `identity.digest` avant d'écrire l'en-tête), la seconde le recopie. La source doit donc
être relisible — c'est le cas d'un volume OPFS (#6). L'empreinte est calculée par un **hachage
SHA-256 incrémental portable** (`src/vm/sha256-stream.mjs`), faute d'incrémental dans WebCrypto : le
même code s'exécute sous Node et dans le Worker. Le coût mémoire au-delà du bloc courant est O(1) —
seuls un bloc de streaming (4 Mio par défaut) et l'état du hachage sont retenus.

### Point cohérent exigé, non pris

L'export **ne prend pas** le bail lui-même : il **exige** que l'appelant déclare la garantie sous
laquelle le point cohérent est tenu, et il l'inscrit dans l'archive. Trois garanties sont admises :

| Garantie               | Signification                                                               | Origine |
| ---------------------- | --------------------------------------------------------------------------- | ------- |
| `handle-exclusif`      | volume lu via le handle OPFS exclusif : aucun autre écrivain dans l'origine | #6      |
| `bail-ecrivain-unique` | l'appelant tient le bail : seul écrivain, il n'écrit pas pendant l'export   | #8      |
| `barriere-acquittee`   | une barrière de durabilité a été acquittée avant la lecture : rien en vol   | #14     |

Un export sans garantie déclarée est **refusé**. L'atomicité complète d'une génération — un
instantané copy-on-write d'un volume potentiellement muté en parallèle — reste réservée à **#16** ;
le format d'archive n'a pas à changer pour l'accueillir (une garantie supplémentaire suffira).

### Vérification à refus typés

`verifyArchive(bytes)` — et son cœur streaming `readArchive` — recalcule l'empreinte du contenu et
valide le manifeste par #10. Les échecs sont **typés**, jamais silencieux :

| Code                              | État                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| `VAULT_ARCHIVE_MALFORMED`         | marqueur/en-tête méconnaissable, digests internes divergents   |
| `VAULT_ARCHIVE_TRUNCATED`         | archive plus courte que ce que l'en-tête déclare               |
| `VAULT_ARCHIVE_DIGEST_MISMATCH`   | empreinte recalculée ≠ empreinte inscrite : contenu altéré     |
| `VAULT_ARCHIVE_GEOMETRY_MISMATCH` | longueur de contenu incohérente avec la géométrie du manifeste |

Un manifeste malformé ou incompatible reste signalé par la `ManifestError` de #10, **propagée telle
quelle** : l'archive ne reconditionne pas le refus de compatibilité, elle le laisse remonter.

## Ce qui est explicitement réservé

- **La restauration inter-origine** → #12. L'archive lui donne un conteneur vérifiable ; le parcours
  d'import (réhydrater un volume OPFS depuis une archive) n'est pas écrit ici. Il l'est depuis par
  l'[ADR 0009](0009-restauration-inter-origine.md), qui n'a exigé aucun changement de ce format.
- **Le chiffrement et la signature de l'archive** → jalon 4. L'archive v1 n'est ni chiffrée ni
  signée : un support hostile peut la forger. La vérification repose, pour l'instant, sur la
  confiance dans le support local (OPFS partitionné par origine, ADR 0002) et prouve l'INTÉGRITÉ
  (non-altération accidentelle, troncature), pas l'AUTHENTICITÉ.
- **L'atomicité d'une génération sous écriture concurrente** → #16.
- **La compression** de l'archive : hors périmètre ; le budget « ≤ 2× » est tenu sans elle.

## Ce qui est explicitement refusé

- **Exporter sans garantie de cohérence déclarée.** Refus (`TypeError`).
- **Tenir le volume entier en mémoire.** L'empreinte est incrémentale ; l'archive est écrite en
  flux.
- **Rendre un succès sur une archive altérée ou tronquée.** Échec typé systématique.
- **Reconditionner un refus de manifeste.** La `ManifestError` de #10 est propagée sans
  reétiquetage.
- **Dériver le format d'archive de la version npm.** `archiveFormatVersion` est un entier
  indépendant, comme le format de volume.

## Erreurs ajoutées

Le format d'archive ajoute une famille d'erreurs typées **distincte** de celle du stockage (#4/#6),
du bail (#8) et du manifeste (#10) — le stockage décrit un état du support, le manifeste la
compatibilité d'un format, l'archive l'intégrité d'un conteneur ; les fondre effacerait des remèdes
différents (libérer de la place, migrer, réexporter). Elle reprend la même forme transportable
(`code`, message français, contexte, `toJSON`), dans `src/vm/archive-errors.mjs`.

## Preuves

- `tests/unit/vm-sha256-stream.test.mjs` (rattaché à `npm run check`) : le hachage incrémental
  concorde avec `crypto.subtle.digest` sur toutes les tailles frontières du padding et tous les
  découpages en morceaux, y compris une entrée multi-mégaoctets découpée irrégulièrement — un
  instrument de mesure calibré contre la primitive du moteur.
- `tests/unit/vm-volume-export.test.mjs` (rattaché à `npm run check`) : aller-retour vérifiable,
  empreinte inscrite dans le manifeste, archive ≤ 2× la taille logique, streaming borné (aucune
  lecture ne dépasse le bloc), garantie de cohérence exigée, et refus typés — contenu altéré,
  troncature, marqueur/en-tête méconnaissable, incompatibilité de manifeste propagée.
- `tests/e2e/export-volume-verifiable.spec.mjs` (job CI non bloquant Reprise MVP) : sur le **vrai
  OPFS** et le disque de l'image #5 (invariant compris), export en flux vers une archive OPFS,
  vérification, puis refus typés sur une archive altérée et tronquée.

La preuve rouge/verte figure dans la description de la pull request.

## Risques et conditions d'abandon

Risques résiduels :

1. **L'archive n'est ni chiffrée ni authentifiée.** Elle prouve l'intégrité, pas l'authenticité : un
   support hostile peut forger un manifeste et un contenu cohérents entre eux. Une archive signée
   sera nécessaire dès que l'export traversera un canal non fiable (jalon 4).
2. **Le hachage SHA-256 est réimplémenté.** C'est la contrepartie de l'absence d'incrémental dans
   WebCrypto ; le risque est cerné par la calibration contre `crypto.subtle.digest`, qui échouerait
   au moindre écart, à toute frontière de bloc.
3. **La surmémoire est mesurée sur le tas JS, pas sur l'empreinte du processus.** La preuve
   déterministe est plutôt la **plus grande lecture** émise (bornée au bloc de streaming) : l'export
   ne demande jamais tout le volume d'un coup.

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- l'export doit traverser un canal non fiable et exige donc une archive signée/chiffrée ;
- un deuxième format d'archive est publié, éprouvant réellement `archiveFormatVersion` ;
- l'atomicité de génération (#16) impose une disposition d'archive différente de celle figée ici.

## Alternatives rejetées

- **Mettre l'empreinte dans un pied d'archive (trailer) pour un export en une seule passe.** Rejeté
  : le manifeste de #10 doit porter `identity.digest` renseigné DANS son en-tête ; une empreinte
  reléguée en fin d'archive laisserait le manifeste de tête à `null`, en contradiction avec la
  structure v1.
- **Réutiliser `crypto.subtle.digest` en tenant le volume en mémoire.** Rejeté par le budget de
  surmémoire (≤ 64 Mio) : un volume de 512 Mio ne tient pas.
- **Stocker l'archive dans un backend de blocs OPFS.** Rejeté : la géométrie de #6 impose un
  multiple de 512, alors qu'une archive porte un en-tête de taille variable. L'archive est un
  **fichier**, pas un volume ; elle s'écrit dans un handle OPFS brut.
- **Étendre `StorageError` ou `ManifestError` pour porter les codes d'archive.** Rejeté pour la même
  raison que #8 et #10 ont refusé de fusionner leurs familles : des remèdes distincts.
