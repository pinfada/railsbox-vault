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
n'est pas faite : la migration mute en place, et entre la révocation et l'inscription du manifeste
l'état est sûr — non identifié, donc non inscriptible — mais **pas révocable en un geste** (#16).
Les « **vecteurs de test conservés pour chaque version publiée** » non plus, et pour une raison de
fond : aucune version n'a encore été publiée. Le témoin de refus par une ancienne version simule
donc celle-ci par ses **attentes déclarées** (`supportedFormat`), non par un binaire antérieur — la
limite est écrite dans l'ADR 0011 et dans `docs/testing.md`. Un volume v1 reste par ailleurs
**lisible**, donc exportable, restaurable et migrable : le passage à v2 n'orpheline aucun volume.

## Publication

Une version publiable exige :

- changelog et ADR des ruptures ;
- CI obligatoire verte et recettes lourdes requises par le risque ;
- inventaire des artefacts et empreintes de contenu ;
- SBOM du runtime et des images ;
- signature des artefacts dès que la chaîne de publication existe ;
- matrice runtime/application/format mise à jour ;
- procédure de rollback testée ;
- export/restauration de la version précédente démontré.

## Support et retrait

Avant `1.0`, chaque release annonce les versions de volume qu'elle lit, migre et refuse. Après
`1.0`, une politique de durée de support sera décidée par ADR à partir d'usages réels.

Une version vulnérable peut être retirée de la publication, mais ses artefacts, la procédure de
récupération et la raison du retrait restent documentés afin de ne pas transformer une mise à jour
de sécurité en perte de souveraineté.
