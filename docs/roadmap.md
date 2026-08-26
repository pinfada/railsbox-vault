# Feuille de route

La feuille de route détaillée vit dans les jalons et issues GitHub.
L'[issue d'index #31](https://github.com/pinfada/railsbox-vault/issues/31) rassemble toutes les
tranches et leur avancement. Ce document fixe l'ordre des preuves et les critères de sortie de
chaque étape.

## 0 — Fondation vérifiable

Le projet possède un harnais automatisé, une matrice de navigateurs explicite et des contrats de
composants suffisamment petits pour commencer les changements en TDD.

Ordre critique : #3 → (#2, #35) → #4 → #5. Le jalon se ferme avec les contrats opérationnels #34 et
les ADR produits par les spikes.

**Clos le 23 août 2026** — ADR 0001 à 0004. Le spike #41, rattaché à ce jalon, a été tranché le 25
août par l'[ADR 0010](decisions/0010-isolation-multi-origine.md) : la distribution n'impose pas
l'isolation multi-origine ; COOP `same-origin` seul reste recommandé sur la coquille, à poser par la
chaîne de publication #45. Reste ouvert : #40 (Safari réel).

## 1 — Persistance locale

Une vraie application Rails modifie son disque applicatif dans le navigateur, le navigateur est
entièrement fermé, puis un boot à froid retrouve ces données. Aucun chiffrement ni snapshot mémoire
ne masque encore les problèmes de cohérence.

Dépendances : #4 et #5. Ordre : #6 → #14 → #7, tandis que #8 et #9 doivent être fermées avant de
qualifier la persistance.

**Clos le 24 août 2026** — la reprise à froid hors ligne est prouvée de bout en bout (#7), l'accès
concurrent (#8) et le budget de stockage (#9) sont fermés. Deux décisions encadrent ce qui n'est pas
encore atteint : l'[ADR 0005](decisions/0005-qualification-de-la-reprise.md) maintient le gate de
reprise (60 s) fermé — p95 mesuré 162 s, voie retenue #65 — et
l'[ADR 0006](decisions/0006-conduite-refus-persistance.md) fixe la conduite quand `persist()` est
refusé (#42).

## 2 — Portabilité

L'utilisateur exporte un volume complet, vérifiable et versionné, puis le restaure sur une autre
origine avec la bonne version de l'application et du runtime.

Ordre : #10 → #11 → #12 → #13. La restauration inter-origine applique la topologie arrêtée par
l'[ADR 0002](decisions/0002-topologie-origine-de-confiance.md) : aucun canal implicite ne relie deux
origines, un export traverse la frontière comme un fichier choisi par l'utilisateur, et un
changement d'origine de la coquille est une migration qui exige un export préalable.

**Clos le 25 août 2026** — quatre décisions gelées :
[ADR 0007](decisions/0007-manifeste-de-volume.md) (manifeste versionné),
[ADR 0008](decisions/0008-format-d-archive-d-export.md) (archive vérifiable),
[ADR 0009](decisions/0009-restauration-inter-origine.md) (restauration : vérifier avant d'écrire,
identifier après relecture, ouvreur unique en écriture) et
[ADR 0011](decisions/0011-migration-de-format-et-reprise.md) (migration d'un format au suivant,
preuve exigée avant de muter, reprise depuis un journal). Les quatre scénarios de bout en bout
s'exécutent depuis le 26 août sur un OPFS adossé au disque
([ADR 0012](decisions/0012-support-des-scenarios-de-bout-en-bout.md), #73). Reste ouvert : #45
(chaîne de publication des deux origines), qui n'est pas requis pour ouvrir le jalon 3.

## 3 — Résilience transactionnelle

Les barrières du système invité atteignent le stockage. Les écritures partielles, arrêts brutaux et
corruptions injectées produisent soit l'état validé précédent, soit le nouvel état validé, jamais un
succès silencieux incohérent.

Ordre : #14 → #15 → #16. Le jalon 4 ne fige aucun format chiffré avant #16.

#14 est fermé depuis le jalon 1. Avant d'ouvrir #15, la tranche #52 (servir v86 dans la coquille :
CSP `wasm-unsafe-eval` et Worker `blob:`), débloquée par l'ADR 0010, est prise en premier : elle
conditionne le passage du banc de référence à la coquille de production.

## 4 — Volume chiffré

Le format assure confidentialité, authenticité des blocs et intégrité globale des générations. Il
détecte déplacement, rejeu, troncature et mélange de générations. Aucune promesse de production
n'est faite avant revue externe.

Ordre : #17 → #18 → #19 → #20. La revue externe publie constats, sévérité et disposition ; elle ne
simule pas une preuve TDD.

## 5 — Déverrouillage et origine de confiance

Une clé de volume aléatoire est enveloppée par une ou plusieurs clés de déverrouillage. Perte,
rotation, révocation et récupération sont testées. La coquille de confiance est isolée du code
applicatif.

La décision #35 est prise (ADR 0002 : origine distincte pour le document applicatif) et précède les
interfaces persistantes ; #24 en réalise la version complète avant toute levée du gate « données
sensibles ». Ordre des clés : #21 → #22 → #23, avec #25 avant qualification produit.

#52 est tranchée par l'[ADR 0013](decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md) : la CSP de
la coquille n'est **pas** élargie — `worker-src` reste `'self'` — parce que la mesure a montré
qu'une boucle d'ordonnancement fournie par Vault couvre les trois moteurs sans elle. La CSP possède
désormais des épreuves de frontière dans les deux sens, sur les trois moteurs et dans
`npm run check`, et un contexte qui ne peut pas exécuter le runtime rend un code `VAULT_RUNTIME_*`
au lieu de se taire. La boucle elle-même appartient à **#74**, à qui cette mesure apporte la cause
du blocage Firefox.

## 6 — Échanges chiffrés optionnels

Deux utilisateurs peuvent échanger des paquets confidentiels, authentifiés et résistants au rejeu
sans confier leurs données au relais. RailsBox Vault fournit les primitives ; chaque application
conserve ses règles de fusion métier.

## Règle de passage

Un jalon n'est terminé que lorsque son scénario de sortie est automatisé au niveau approprié et que
ses limites restantes sont écrites. Une démonstration manuelle seule ne ferme pas un jalon.
