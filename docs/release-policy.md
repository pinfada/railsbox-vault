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
politique. D'abord, un volume restauré porte enfin son **manifeste** dans un fichier voisin
(`<volume>.manifest`) : la « lecture d'une version connue avant toute écriture » cesse d'être une
règle sans support, puisqu'un volume non identifié est refusé par `VAULT_MANIFEST_UNIDENTIFIED`.
Ensuite, la restauration ne **migre** rien : un volume d'un format antérieur est restaurable, mais
son écriture reste refusée par `VAULT_MANIFEST_MIGRATION_REQUIRED` jusqu'à #13. L'« export de
sauvegarde obligatoire avant migration irréversible » a donc désormais son pendant — la remise en
place — mais la migration elle-même, sa reprise après interruption et ses vecteurs par version
restent à faire.

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
