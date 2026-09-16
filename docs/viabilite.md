# Passage du prototype à un produit viable

Objectif demandé le 17 septembre 2026 : rendre RailsBox Vault utilisable durablement, avec des
preuves de conservation des données, un parcours compréhensible et une publication maintenable. Ce
document suit cet objectif ; il ne remplace ni les exigences `VAULT-*`, ni les gates de
`SECURITY.md`, et ne déclare aucune qualification acquise.

## Critères de sortie et preuves attendues

| Priorité | Résultat requis                                                          | Preuve qui permettra de conclure                                                                                                                                                    | État au démarrage                                                                                 |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1        | Conserver les coffres lors d'une mise à jour                             | Un coffre historique contenant une note et une pièce jointe s'ouvre après migration ; chaque interruption reprend ou laisse une sauvegarde restaurable ; aucune suppression imposée | Migration v3 → v4 existante ; migration d'identité des coffres antérieurs au 13 septembre absente |
| 1        | Restaurer réellement les données                                         | Sous Chrome installé, restaurer sur une autre origine, démarrer Rails sans réinstallation et relire note et pièce jointe                                                            | Réussi sur Chrome installé le 17 septembre 2026 : note et pièce jointe relues après restauration  |
| 1        | Qualifier la sécurité avant les données réelles                          | Reprendre chaque réserve `SEC-*`, ses tests adverses et les conditions d'ouverture des gates ; vérifier la publication et son intégrité                                             | Gate données sensibles fermé ; il ne sera pas levé par un test fonctionnel                        |
| 2        | Fonctionner au quotidien et hors ligne                                   | Fermer le navigateur, rouvrir hors ligne, retrouver les données, travailler puis sauvegarder et verrouiller ; tester l'activité dans le cadre et la fin du parcours                 | Scénarios de persistance existants ; recette produit et parcours quotidien à auditer              |
| 2        | Rendre les délais acceptables et explicables                             | Distinguer installation, démarrage, première page et reprise ; publier p50/p95 sur la machine de référence et respecter les budgets existants                                       | Mesure Chrome locale : étape démarrage + note 149 s, parcours 185 s ; ce n'est pas une mesure p95 |
| 2        | Rendre déverrouillage et récupération fiables sur les appareils annoncés | Matrice des passkeys réelles et des moyens de secours, annulation comprise ; compatibilité annoncée conforme aux résultats                                                          | Parcours par phrase et code testé ; passkeys réelles non qualifiées dans cette campagne           |
| 3        | Publier une version installable et maintenable                           | Construction depuis un environnement propre, artefacts vérifiés, test sur hébergement statique, procédure de retour et de support, contrôles de publication complets                | Outillage existant ; qualification complète à réexécuter et contrôler                             |
| 3        | Valider la compréhension par des utilisateurs                            | Sessions avec des personnes non techniques, réussites et difficultés consignées, puis corrections vérifiées                                                                         | Relecture préparée ; aucune session constatée dans le dépôt                                       |

## Migration sans perte : deux opérations distinctes

La migration de format `migrateVolume` sait déjà convertir un v3 réel en v4, avec sauvegarde
vérifiée, journal et reprise (ADR 0011 amendé par ADR 0035). Elle conserve l'identité du volume. Les
tests `vm-migration-source-v3` et `vm-migration-v4` couvrent notamment les écritures acquittées, les
coupures et le refus d'un secteur déchiré.

`VAULT_COQUILLE_COFFRE_ANTERIEUR` indique une autre incompatibilité : avant l'ADR 0039, l'enveloppe
était liée au petit volume `coquille`, alors que le disque `application` avait une autre identité.
La fixture historique porte déjà `VLTVOL04`. Changer un numéro de version ou supprimer le refus ne
suffit pas : identités, clés dérivées et données associées doivent rester cohérentes.

L'implémentation à livrer doit donc :

1. reconnaître sans mutation le format, les deux identités et une éventuelle migration interrompue ;
2. déverrouiller avec le moyen existant dans le Worker de confiance, sans transmettre la clé au
   cadre ;
3. conserver et vérifier une sauvegarde complète des fichiers nécessaires à la récupération ;
4. convertir les données sous l'identité attendue, avec journal durable et reprise idempotente ;
5. vérifier les données et les moyens de déverrouillage avant de publier le nouvel état ;
6. invalider les instantanés incompatibles et traiter les copies résiduelles avant la révocation ;
7. appliquer v3 → v4 si nécessaire, puis prouver l'ouverture, la sauvegarde et la restauration par
   Rails.

La conservation des anciens coffres fait partie de l'objectif, même si les données sensibles restent
interdites aujourd'hui. En attendant cette migration, les messages de refus demandent de conserver
les données et les moyens de déverrouillage, sans prescrire l'effacement du site.

### Préparation livrée le 17 septembre 2026 — pas encore branchée à l'ouverture

`src/vm/copie-de-migration.mjs` fournit `copierPourMigration` : copie du clair authentifié vers un
backend ouvert sous la nouvelle identité, flush avant chaque avancement du journal, reprise du
dernier bloc non acquitté, puis comparaison intégrale. La source n'est jamais écrite ni supprimée.
Le journal est strictement borné et lié aux deux volumes ; son avancement n'est pas une preuve. La
relecture finale appelle `backend.relire`, qui réauthentifie aussi le journal de génération depuis
le support, sans son cache de clair. Un journal de copie falsifié ne dispense pas de cette
vérification. Les deux tampons de comparaison sont effacés après usage.

L'appelant doit tenir les deux backends exclusifs, figer la source et fournir un journal dont
`ecrire` acquitte réellement la persistance. Ce composant n'implémente pas encore l'adaptateur de
journal durable de la coquille ni la publication atomique des fichiers. Il ne remplace PAS
`migrateVolume` pour les formats anciens, ne retire aucun refus et ne déclare pas le coffre migré.

Les tests `vm-copie-de-migration` couvrent les 20 frontières avant/après écriture, flush et
journalisation sur trois blocs, les écritures partielles, les journaux tronqués ou falsifiés, la
géométrie, la relecture du préfixe, la réouverture sous la nouvelle identité et un journal chiffré
corrompu malgré un cache intact. `coquille-copie-historique` ouvre la fixture existante par sa
phrase historique, copie son volume et retrouve le même clair après réouverture, sans modifier ses
fichiers sources. Cette fixture ne contient que le petit volume `coquille` : elle ne prouve PAS
encore la migration d'un disque Rails historique contenant des notes et pièces jointes.

Cette épreuve a révélé une référence mutable dans `generation-relecture.mjs` : le cache empruntait
le tampon de l'appelant après `write`. Son effacement pouvait fausser une lecture puis une écriture
partielle. Le cache en garde désormais une copie indépendante. Les deux régressions ont d'abord
échoué, puis réussi après correction ; un scénario OPFS réel vérifie aussi la réutilisation du
tampon, l'écriture partielle et la réouverture. Cette correction ne qualifie pas à elle seule la
migration automatique ni le gate des données sensibles.

Vérification de cette étape : suite unitaire complète réussie et 21 contrôles OPFS navigateur
réussis sur Chrome installé, Firefox et WebKit. Pour WebKit, le succès signifie le refus typé
attendu lorsque l'accès OPFS manque, et non la preuve qu'un coffre y fonctionne.

## Recette Chrome reproductible

Préparer les dépendances, les artefacts v86 et l'image Rails selon `development.md`. Chrome doit
être installé. Libérer les ports 4177 à 4182 avant de lancer :

```sh
npm run test:viabilite
```

Cette commande joue le parcours guidé et la restauration avec relecture de la note et de sa pièce
jointe. Le profil persistant appartient au test, jamais au profil personnel. Le canal `chrome` est
transmis au lancement réel ; `navigateur.json` atteste la version exécutée. Un préalable absent fait
échouer la recette au lieu d'ignorer les scénarios. Le rapport est
`reports/viabilite/resultats.json`, les profils et traces sont sous `test-results/viabilite/`.

Cette recette constitue une preuve de deux parcours. Elle ne couvre pas seule les migrations, les
passkeys physiques, toutes les coupures, le hors-ligne ou la sécurité d'une publication.

Le 17 septembre 2026, les deux scénarios ont réussi sous Google Chrome installé 152.0.7977.83, en
9,5 minutes au total, via la variante locale qui réutilise les serveurs de développement déjà
ouverts. Le scénario de restauration a relu la note ET la pièce jointe sur l'autre origine. Ces
durées, mesurées sous charge locale, ne constituent pas un budget p95.

## Ordre de travail

La conservation des données et la preuve de restauration précèdent les migrations automatiques.
Viennent ensuite le parcours quotidien et le hors-ligne, la mesure des performances, la
qualification de sécurité et de publication, puis les sessions utilisateurs. Un défaut découvert
dans un de ces chemins reste dans le périmètre de l'objectif ; un rapport vert ailleurs ne le clôt
pas.
