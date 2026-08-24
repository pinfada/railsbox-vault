# ADR 0007 — Le manifeste versionné lie format, runtime, application et géométrie

- Statut : accepté
- Date : 2026-08-24
- Issue : #10 · Invariants : `VAULT-PORT-001`, `VAULT-COMPAT-001` · Jalon 2

## Contexte

`docs/release-policy.md` pose trois identités indépendantes qu'un coffre doit lier explicitement :
la version entière du **format de volume**, la version SemVer du **runtime Vault**, et l'identité
immuable plus la version de l'**application Rails**. Il exige aussi la « lecture d'une version
connue avant toute écriture » et le « refus explicite d'un format futur ou d'un downgrade dangereux
». `docs/architecture.md` en fait une règle d'ouverture (`SEC-UPDATE-001`, `VAULT-COMPAT-001`) : «
Runtime, application et format sont identifiés avant toute mutation ».

Jusqu'ici ces identités n'avaient aucune représentation. Le backend de blocs (#6) sait relire la
**géométrie** d'un volume à la réouverture (`src/vm/block-geometry.mjs`), mais rien ne dit quel
format, quel runtime ni quelle application ont écrit ces octets. Sans ce document, l'export (#11) et
la restauration inter-origine (#12) n'auraient aucune base pour vérifier qu'un volume est bien celui
qu'ils croient ouvrir, et une mise à jour de runtime pourrait écrire sur un volume qu'elle ne
comprend pas.

Le manifeste est un **format persistant**. Sa structure doit donc être figée par ADR, et sa règle de
compatibilité décidée avant qu'un octet ne soit écrit sur un vrai volume.

## Décision

**Un module pur (`src/vm/volume-manifest.mjs`) définit la structure v1 du manifeste, sa
sérialisation déterministe et sa règle de compatibilité. Un manifeste absent, malformé, d'un format
futur ou d'un downgrade dangereux produit une erreur TYPÉE (`src/vm/manifest-errors.mjs`), jamais un
objet à moitié valide ni une écriture sur un volume non identifié.** Le module ne touche ni OPFS, ni
le temps, ni le réseau : un contrat de format se prouve en unitaire.

### Structure v1 (figée)

```text
{
  magic:         "railsbox-vault/volume-manifest",   // marqueur, jamais modifié
  formatVersion: 1,                                   // entier ; jamais dérivé de la version npm
  runtime:  { version: "<SemVer>", artifact: <string|null> },
  app:      { id: "<immuable>", version: "<string>" },
  geometry: { volumeSize: <multiple de 512>, sectorSize: 512, blockSize: 256 },
  identity: { algorithm: "sha-256", digest: <string|null> }
}
```

- **`magic` et `formatVersion` sont le préambule figé pour toujours.** Ils sont validés en premier,
  pour qu'un manifeste d'un format futur soit RECONNU comme un manifeste et sa version lue — donc
  refusé explicitement — plutôt que pris pour du bruit.
- **`geometry` réutilise le contrat de #6**, sans le redéfinir : `assertBlockGeometry` valide
  `volumeSize`, et `sectorSize`/`blockSize` doivent valoir les constantes figées (512/256). Une
  géométrie qui en diffère est un manifeste malformé, jamais une nouvelle valeur adoptée en silence.
- **`identity` porte la STRUCTURE de l'empreinte, pas encore son calcul.** Le champ `digest` peut
  être `null` : calculer l'empreinte du **contenu** du volume et la vérifier est le travail de #11.
  Ce que fige cet ADR, c'est l'emplacement versionné de cette empreinte et la vérification de
  version/identité qui l'entoure.

### Sérialisation déterministe

`serializeManifest` encode en JSON aux **clés triées récursivement** : un même manifeste rend
toujours les mêmes octets, quel que soit l'ordre d'insertion des champs. C'est la condition d'une
empreinte reproductible. `parseManifest` accepte des octets, une chaîne ou un objet, valide le cœur
v1 et **tolère les champs surnuméraires inconnus** (compatibilité ascendante), puis rend un
manifeste gelé — ou lève `VAULT_MANIFEST_MALFORMED`.

### Règle de compatibilité

`evaluateCompatibility` rend un verdict pur `{ readable, writable, refusal, scope }` ;
`assertReadable` et `assertWritable` en dérivent des refus typés. Elle distingue **lecture seule
tolérée** et **écriture refusée** :

| Situation                                               | Lecture | Écriture | Code de refus                       |
| ------------------------------------------------------- | :-----: | :------: | ----------------------------------- |
| `formatVersion` > format courant du runtime             | refusée | refusée  | `VAULT_MANIFEST_FORMAT_TOO_NEW`     |
| `formatVersion` < plus ancien format lisible            | refusée | refusée  | `VAULT_MANIFEST_FORMAT_TOO_OLD`     |
| application (`app.id`) différente                       | refusée | refusée  | `VAULT_MANIFEST_IDENTITY_MISMATCH`  |
| format lisible mais antérieur au format courant         | tolérée | refusée  | `VAULT_MANIFEST_MIGRATION_REQUIRED` |
| runtime majeur du volume > runtime en cours (downgrade) | tolérée | refusée  | `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  |
| format courant, même application, runtime compatible    |   oui   |   oui    | —                                   |

Deux axes indépendants, conformes aux trois identités :

- **Le format futur est refusé en lecture ET en écriture.** Un format plus récent que ce que le
  runtime connaît a une disposition qu'il ne peut pas interpréter en confiance : le refuser en
  lecture aussi évite d'inventer un sens. C'est le refus explicite exigé par la release-policy.
- **Le downgrade dangereux est refusé en ÉCRITURE.** Un volume écrit par un runtime de version
  **majeure** supérieure a pu établir des invariants qu'un runtime plus ancien casserait en
  écrivant. La lecture reste tolérée (diagnostic, export via #11) ; l'écriture est refusée. La
  comparaison porte sur le **major** SemVer : un patch ou un mineur plus récent n'est pas un
  downgrade dangereux.
- **La version d'application n'entre pas dans le refus** : seule `app.id` doit correspondre. Les
  migrations métier de l'application sont distinctes des migrations du format Vault
  (`docs/architecture.md`).

### Vérification avant écriture (`SEC-UPDATE-001`)

`assertVolumeWritable({ manifestBytes, expectations })` est le chemin d'ouverture en écriture : un
volume dont les octets de manifeste sont **absents** est refusé par `VAULT_MANIFEST_UNIDENTIFIED` —
jamais d'écriture sur un support non identifié ; un manifeste malformé ou incompatible propage son
refus typé ; sinon la fonction rend le manifeste validé. L'identité et la version sont donc
**exigées et vérifiées avant** que l'écriture soit autorisée.

## Ce qui est explicitement réservé

- **L'empreinte du contenu du volume et l'export portable complet** → #11. Le champ
  `identity.digest` existe et est validé structurellement, mais n'est ni calculé ni confronté au
  contenu ici.
- **La restauration inter-origine** → #12. Le manifeste lui donne sa base de vérification
  d'identité, mais le parcours d'import n'est pas écrit.
- **Le détail des migrations et le copy-on-write** → #13. Cet ADR **refuse** l'écriture d'un format
  antérieur (`MIGRATION_REQUIRED`) et d'un downgrade de runtime ; il ne décrit pas comment migrer.
- **Le chiffrement et l'authentification du manifeste** restent hors périmètre : le manifeste v1
  n'est ni chiffré ni signé. Un manifeste authentifié est un travail ultérieur.

## Ce qui est explicitement refusé

- **Écrire sur un volume sans manifeste identifiable.** Refus `VAULT_MANIFEST_UNIDENTIFIED`.
- **Ouvrir un format futur inconnu**, même en lecture. Refus `VAULT_MANIFEST_FORMAT_TOO_NEW`.
- **Écrire avec un runtime majeur plus ancien que celui du volume.** Refus
  `VAULT_MANIFEST_RUNTIME_DOWNGRADE`.
- **Rendre un manifeste à moitié valide.** `parseManifest` valide tout le cœur v1 ou lève
  `VAULT_MANIFEST_MALFORMED` ; il n'existe pas d'état intermédiaire.
- **Dériver le format de la version npm.** `formatVersion` est un entier indépendant, comme l'exige
  `docs/release-policy.md`.

## Erreurs ajoutées

Le manifeste ajoute une famille d'erreurs typées **distincte** de celle du stockage (#4/#6) et du
bail d'écriture (#8) — le stockage décrit un état du support, le manifeste la compatibilité d'un
format ; les fondre effacerait des remèdes différents (libérer de la place, migrer, mettre à jour le
runtime). Elle reprend en revanche la même forme transportable (`code`, message français, contexte,
`toJSON`).

| Code                                | État                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `VAULT_MANIFEST_MALFORMED`          | l'entrée n'est pas structurellement un manifeste v1            |
| `VAULT_MANIFEST_FORMAT_TOO_NEW`     | format plus récent que ce runtime : refusé en lecture/écriture |
| `VAULT_MANIFEST_FORMAT_TOO_OLD`     | format sous le plancher lisible de ce runtime                  |
| `VAULT_MANIFEST_MIGRATION_REQUIRED` | format antérieur : écriture refusée jusqu'à migration (#13)    |
| `VAULT_MANIFEST_RUNTIME_DOWNGRADE`  | volume écrit par un runtime majeur plus récent : downgrade     |
| `VAULT_MANIFEST_IDENTITY_MISMATCH`  | l'application en cours ne possède pas ce volume                |
| `VAULT_MANIFEST_UNIDENTIFIED`       | ouverture en écriture d'un volume sans manifeste connu         |

## Preuves

- `tests/unit/vm-volume-manifest.test.mjs` (rattaché à `npm run check`) : création et gel d'un
  manifeste v1, refus des entrées invalides à la création, sérialisation déterministe (aller-retour
  stable octet à octet et indépendance à l'ordre des clés), parse strict d'entrées malformées vers
  une erreur typée, tolérance des champs futurs, compatibilité acceptée, **refus** d'un format futur
  (lecture et écriture), d'un format trop ancien, refus d'écriture d'un format antérieur, refus d'un
  **downgrade** de runtime, refus d'une application étrangère, et **refus d'écriture sans identité**
  via `assertVolumeWritable`.

La preuve rouge/verte figure dans la description de la pull request.

## Risques et conditions d'abandon

Risques résiduels :

1. **Le manifeste v1 n'est ni chiffré ni authentifié.** Un support hostile peut le forger. La
   vérification d'identité repose donc, pour l'instant, sur la confiance dans le support local (OPFS
   partitionné par origine, ADR 0002). Un manifeste signé sera nécessaire dès que l'export
   traversera un canal non fiable (#11/#12).
2. **Le downgrade est jugé sur le major SemVer seul.** C'est prudent tant qu'aucune rupture de
   format n'est portée par un mineur en série `0.x` ; la release-policy garde le format hors de la
   version npm, ce qui rend cette heuristique sûre. Elle devra être revue si une rupture de runtime
   devait être exprimée autrement qu'en major.
3. **`identity.digest` reste `null` jusqu'à #11.** Un manifeste v1 n'engage donc encore aucune
   vérification du contenu ; il n'affirme que la cohérence des identités et de la géométrie.

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- l'export (#11) exige un manifeste authentifié ou un digest de contenu obligatoire ;
- un deuxième format de volume est publié, éprouvant réellement la règle de migration (#13) ;
- une exigence impose d'exprimer une rupture de runtime hors du major SemVer.

## Alternatives rejetées

- **Étendre `StorageError` de #6 pour porter les codes de manifeste.** Rejeté : le stockage décrit
  un état du support, le manifeste la compatibilité d'un format. Le bail d'écriture (#8) a déjà
  tranché ce même choix en faveur d'une famille distincte.
- **Déduire le format de la version du paquet npm.** Rejeté par `docs/release-policy.md` : le format
  persistant ne dépend jamais implicitement de la version npm.
- **Refuser un format antérieur dès la lecture.** Rejeté : un format plus ancien mais lisible doit
  pouvoir être ouvert en lecture seule pour être exporté ou migré (#11/#13). Seule l'écriture est
  refusée.
- **Calculer le digest du contenu ici.** Rejeté : l'empreinte du contenu appartient à l'export
  (#11). Mélanger les deux étendrait le périmètre et couplerait un module pur à la lecture du volume
  entier.

```

```
