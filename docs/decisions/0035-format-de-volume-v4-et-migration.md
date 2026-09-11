# ADR 0035 — Le format de volume v4 : deux compteurs dans la racine, et une migration qui rescelle

- **Statut** : accepté
- **Date** : 2026-09-11
- **Issue** : [#182](https://github.com/pinfada/railsbox-vault/issues/182) (HIGH, tranche **T2a**),
  [#20](https://github.com/pinfada/railsbox-vault/issues/20) moitié 2 · Invariants : `SEC-KEY-001`,
  `SEC-BLOCK-001`, `SEC-GEN-001`, `SEC-DURABLE-001`
- **Applique** : [ADR 0033](0033-hierarchie-de-cles-derivees-par-domaine.md), qui a DÉCIDÉ la
  hiérarchie de clés sans livrer de code. Cet ADR ne rejuge rien d'elle ; il écrit ce que la tranche
  T2a a trouvé en la livrant, et les trois points où le code a dû trancher ce que la décision
  laissait ouvert.
- **Révise** : [ADR 0015](0015-proprietes-cryptographiques-du-format.md) (le budget, la clé de
  volume), [ADR 0016](0016-format-de-volume-v3-dispositions.md) (les dispositions v4),
  [ADR 0019](0019-fraicheur-du-volume.md) (le témoin et l'empreinte de région passent sous la clé du
  domaine `volume`), [ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) (« rien d'autre ne
  descend d'elle »), [ADR 0024](0024-instantane-de-reprise.md) (l'instantané passe en v2),
  [ADR 0011](0011-migration-de-format-et-reprise.md) (la chaîne gagne un second pas destructif).
- **Ne traite pas** : les domaines `enveloppe` et `recuperation`, ni le cliquet anti-DEK — c'est la
  tranche **T2b**, et la ligne #182 du registre reste `ouvert` jusqu'à elle. Ni AES-GCM-SIV (spike
  T3), ni l'ancrage monotone, ni la rotation de la clé maîtresse.

## Ce que la tranche livre

La DEK devient une clé maîtresse importée en matériau HKDF ; les secteurs, empreintes de région,
témoins et racines scellent sous la clé du domaine `volume`, les enregistrements du journal sous
celle du domaine `journal`, l'instantané sous une clé à usage unique ; l'en-tête v4 porte deux
compteurs authentifiés ; toute session qui scelle clôt par une racine ; un volume v3 devient v4 par
une migration reprenable qui rescelle chaque secteur ; les vecteurs v4 sont rejoués sans le produit
et les vecteurs v3 deviennent des vecteurs de migration.

La spécification porte les octets ([`docs/format-de-volume-v3.md`](../format-de-volume-v3.md), §§
4.4, 4.5, 5.2, 6.2, 6.7, 7.1, 7.3, 7.4, 10.2). Ce qui suit est ce qu'elle ne peut pas porter : les
décisions que la livraison a exigées, et ce que la tranche a trouvé en chemin.

## Décision 1 — La racine à deux compteurs porte un NUMÉRO DE FORMAT DE JOURNAL de plus

**L'ADR 0033, décision 5, range « la disposition du journal `<volume>.gen` et son format 4 » parmi
ce qui ne change pas.** La disposition, en effet, ne bouge pas d'un octet : mêmes emplacements de
racine, même forme d'enregistrement, même sceau de 34 octets. Mais la RACINE gagne huit octets, et
`src/vm/generation-format.mjs` tient une règle plus ancienne que l'ADR : **un numéro de format dit
ce que porte la racine.**

Laisser les deux racines sous le numéro 4 aurait fait deux racines différentes sous un seul nom. Une
racine à deux compteurs relue comme une racine à un seul rendrait un compteur de journal nul sans
que rien ne le signale ; l'inverse lirait dans la réserve. Le journal passe donc au **format 5**, et
`GENERATION_FORMATS_LUS` en compte quatre.

**Ce que cela coûte, et qui est écrit** : un runtime d'avant #182 refuse une racine de format 5
comme un format inconnu. C'est le comportement voulu — il ouvrirait les enregistrements sous la
bonne étiquette, mais sous la MAUVAISE CLÉ, puisqu'il ne dérive rien.

## Décision 2 — Le nombre de champs des données associées suit la version du VOLUME, pas l'octet 8

La racine porte deux versions : celle du format de **volume**, champ 3 de ses données associées et
donc AUTHENTIFIÉE, et celle du format de **journal**, à l'octet 8 de son secteur et non
authentifiée. Le second compteur pouvait suivre l'une ou l'autre.

**Il suit la version du VOLUME**, et c'est ce qui le rend inviolable sans ajouter de garde : une
racine v4 relue comme une racine v3 présente dix champs à l'étiquette, qui refuse ; une racine v3
relue comme une v4 en présente onze, et l'étiquette refuse de même. Faire suivre le nombre de champs
à l'octet 8 aurait laissé un bit non authentifié décider de ce que l'étiquette couvre.

`Scellement#ouvrirRacine` POSE donc la présence du second compteur d'après sa propre version de
format, exactement comme il pose déjà le volume et la version : sur un volume v3 le champ est
RETIRÉ, quoi que le décodeur ait lu ; sur un volume v4 il est EXIGÉ, et une racine qui n'en porte
pas est refusée par `VAULT_STORAGE_GENERATION_CORRUPT` plutôt que complétée par zéro — un budget
complété par zéro est un budget qu'on croit neuf.

**Conséquence assumée, mesurée plutôt qu'affirmée** : un bit retourné dans l'octet 8 qui fait passer
4 pour 5 n'est plus refusé sans clé, parce que 5 est désormais un format connu. Il ne change rien
non plus : ni l'étiquette de domaine des enregistrements (`enregistrementsSousIdentiteDeBloc` rend
faux pour les deux), ni le nombre de champs scellés. Le retournement inverse, lui, est refusé par la
garde de cohérence — miroir de celle que #19 avait posée sur la fraîcheur. Épreuves :
`tests/unit/vm-generation-format.test.mjs`.

**Corollaire** : un volume v4 qui ne tiendrait aucune source de fraîcheur est REFUSÉ, et non dégradé
en format 2. Ses données associées comptent onze champs, et une racine de format 2 n'a pas de place
pour le second compteur ; la combinaison n'a aucun encodage possible, et l'écrire produirait une
racine que personne ne pourrait relire.

## Décision 3 — La migration v3 → v4 journalise une ÉCRITURE ANTICIPÉE

**C'est le point que l'ADR 0033 laissait ouvert, et il est plus dur qu'il n'y paraît.** La décision
5 écrit « rescellement de chaque secteur […] avancement au rang de secteur, reprise après coupure »,
sur le modèle de v2 → v3. Mais v2 → v3 avait une propriété que v3 → v4 n'a pas : l'un des deux états
d'un secteur — le clair — se rescellait à l'infini, si bien qu'une coupure pouvait laisser du clair
sous un sceau qui ne l'ouvrait pas, et la reprise avait raison de le rescéller.

Ici, les deux états sont des chiffrés sous deux clés différentes. **Le sceau et la charge doivent
donc changer ENSEMBLE**, et aucun ordre d'écriture ne suffit à lui seul :

- sceau v4 d'abord, puis charge : une coupure laisse une charge v3 sous un sceau v4, et le sceau v3
  — le nonce et l'étiquette sans lesquels rien ne s'ouvre — a été écrasé ;
- charge d'abord, puis sceau : une coupure laisse une charge v4 sous un sceau v3, et le sceau v4
  n'existe nulle part.

Dans les deux cas, jusqu'à 512 secteurs sont perdus par coupure, sans qu'aucune erreur ne soit
levée.

**La réponse retenue est une écriture ANTICIPÉE des sceaux v3 de la suite en vol**, inscrite dans
`<volume>.migration` avant le premier octet écrit dans le volume. Elle coûte trente-quatre octets
par secteur — 6,6 % de ce que la conversion réécrit —, et elle donne à la reprise les DEUX sceaux
possibles de chaque secteur. Quatre états, et le quatrième est un refus :

```text
ouvre sous (clé v4, sceau du support)      → converti, il n'y a rien à faire
ouvre sous (clé v3, sceau v3 journalisé)   → charge encore v3, sceau déjà v4 : rescéller
ouvre sous (clé v3, sceau du support)      → rien n'a encore été écrit : convertir
n'ouvre sous aucun des trois               → écriture DÉCHIRÉE : REFUS, la sauvegarde
```

**Deux alternatives ont été pesées et écartées.** Journaliser les octets v4 complets — sceaux ET
charges — aurait rendu la reprise triviale (réappliquer le tampon), au prix d'un DOUBLEMENT des
écritures du volume : 512 Mio de plus pour un volume de 512 Mio. Ouvrir un voisin binaire plutôt que
le journal JSON aurait évité l'hexadécimal, au prix d'un nom de plus, d'une entrée dans le balayage
des orphelins de #145 et d'une place dans l'archive — pour dix-sept kilo-octets.

**Ce que l'écriture anticipée ne cache pas** : ces octets ne sont pas un secret. Un sceau est un
nonce et une étiquette, et les deux vivent déjà en clair dans la région d'authentification du
volume. Ce qu'ils portent est la capacité de RELIRE un secteur v3 dont le sceau a été écrasé —
c'est-à-dire exactement ce qu'une reprise doit pouvoir faire, et rien de plus : sans la clé, ils
n'ouvrent rien. Le journal de migration reste ni chiffré ni authentifié (§ 9.2 de la spécification),
et sa limite résiduelle est inchangée.

**Le journal de migration passe en version 3.** Un journal de version 2 est refusé plutôt
qu'interprété : il décrit une migration d'un autre contrat de reprise.

**La condition d'abandon de la DoR est tenue et mesurée** : la reprise repart du rang journalisé et
ne rejoue que la suite en vol. Elle ne relit jamais le volume entier.
`tests/unit/vm-migration-v4.test.mjs` › « la reprise ne relit PAS le volume entier ».

## Ce que la tranche a TROUVÉ, et qui n'était pas dans la décision

### Un palier de format déjà franchi se refaisait

Le journal de reprise ne porte qu'UN avancement : celui du pas en vol. Tant que la chaîne n'avait
qu'un pas destructif, cela suffisait. Avec deux, une reprise pendant v3 → v4 redonnait « rien de
commencé » au pas v2 → v3 — qui **redéplaçait la charge d'un volume déjà converti par-dessus sa
propre région d'authentification**, détruisant le clair sans lever d'erreur.

Le discriminant est exact et gratuit : le `from` de l'avancement atteste que tous les paliers
jusque-là sont atteints. Un pas déjà franchi rend son manifeste cible sans toucher un octet, et
l'identifiant du volume converti vient alors de l'en-tête du fichier, où la conversion l'a posé.
`tests/unit/vm-volume-migration.test.mjs` › « une coupure PENDANT le pas v3 → v4 ne fait pas REFAIRE
le pas v2 → v3 ».

### La règle de clôture ne tient que DEUX des trois chemins, et le troisième l'a montré

La décision 4 de l'ADR 0033 donne deux conduites à une session qui ne peut pas publier ses compteurs
: clore par une racine, ou être en LECTURE SEULE. La tranche a d'abord appliqué la seconde à toute
ouverture hors transaction qui n'est pas une naissance — et le scénario de bout en bout
`reprise-coquille-boot-froid` l'a réfutée en une exécution : le volume de COQUILLE
(`public/runtime-worker.mjs`) s'ouvre ainsi et y ÉCRIT un secteur à chaque déverrouillage. Mis en
lecture seule, le coffre ne se rouvre plus.

**Ce que la réfutation a mis au jour est un fait, pas un défaut introduit** : ce volume scelle sans
être compté depuis toujours, et sa session suivante repart de zéro. La règle a donc fait exactement
son travail — elle refuse au lieu de compter à moitié —, et c'est le CHEMIN qui n'a pas de conduite
disponible.

**Pourquoi l'autre conduite n'est pas livrée ici.** Écrire une racine de clôture sur un volume qui
en a déjà une demande un geste PUBLIC que `GenerationStore` n'expose pas : `valider()` n'écrit rien
sur une charge vide, et le vidage qui écrit une racine ne part qu'à la récupération. Ajouter ce
geste est une décision sur la machine à états TRANSACTIONNELLE, prise pour un appelant qui ne l'est
pas, sur le chemin de la serrure. Elle revient au mainteneur et elle est portée à **T2b**.

**Ce que la tranche livre à la place** : le mécanisme du refus, éprouvé et sans appelant
(`Scellement#interdireDeSceller`, `VAULT_STORAGE_LECTURE_SEULE`), et une épreuve qui MESURE l'écart
au lieu de garder une règle — `tests/unit/vm-cloture-par-racine.test.mjs` › « CHEMIN 3 ». Elle
constate deux choses : la racine ne bouge pas, et l'écriture hors transaction PÉRIME la fraîcheur de
la dernière racine. La seconde dit ce que la racine de clôture apporterait : elle rescellerait la
région du même geste qu'elle publierait les compteurs. Le jour où T2b livre ce geste, cette épreuve
rougit — et c'est voulu.

### Dater une création perdait le budget de la création

`daterLaCreation` écarte le journal de la naissance — donc la racine qui publiait les scellements
que la création venait de consommer — puis en écrit une neuve. Elle repartait de ZÉRO.

Pour un volume de 512 Mio, c'est un deux-millième du plafond de la clé perdu en un geste, par le
geste même qui prétendait fermer la sous-estimation du § 4.5. Les compteurs de la racine écartée
sont désormais REPORTÉS sur celle qui la remplace. `tests/unit/vm-cloture-par-racine.test.mjs` › «
CHEMIN 2 ».

### Les vecteurs de l'instantané v1 ne sont pas conservés

Le dépôt garde ses vecteurs pour toujours, et les vecteurs du volume v3 restent à l'octet près. Ceux
de l'instantané v1, non : un instantané est un état de REPRISE, écarté dès qu'il est consommé ou
périmé (ADR 0024), et **rien ne le migre**. Aucun runtime ne le lit plus, aucune migration ne le
traverse, et le format v2 change sa clé, pas seulement ses octets — les rejouer n'aurait mesuré que
la patience de qui les a écrits. Ils restent dans l'historique git ;
`tests/vectors/instantane-v2.json` les remplace, et il publie en plus l'INFO HKDF de la clé à usage
unique de chaque capture.

## Ce que les DEUX REVUES de la PR #186 ont trouvé, et ce que la tranche en a fait

Deux revues par exécution — format et sécurité — ont été rendues le 11 septembre 2026 sur la tête
`8479ddd` : **1 CRITICAL, 5 HIGH, 8 MEDIUM, 2 LOW**. Tout est accepté, rien n'est refusé. Ce qui
suit ne résume pas les revues ; il dit ce que le dépôt en a fait, et ce qu'elles ont appris sur la
façon dont cette tranche avait été éprouvée.

### Le CRITICAL : un volume v3 réel n'était NI ouvrable NI migrable

`reporterLeJournalDeGeneration` appliquait le lecteur du journal de FORMAT 1 — celui d'un v2 en
clair, validé par un CRC-32 — au voisin `.gen` de la source, quelle que soit sa version. Le marqueur
`VLTGEN01` étant partagé par les formats 1 à 5, un journal de format 4 franchissait le contrôle de
marqueur puis échouait au CRC que ce format a justement remplacé par une étiquette.

Deux règles se refermaient alors l'une sur l'autre : depuis #181 **tout v3 légitime porte une
racine**, donc un `.gen` ; et depuis cette tranche un en-tête v3 est refusé à l'ouverture **en
nommant la migration comme seul remède**. Le remède que le message de refus indiquait ne
fonctionnait pas.

**Pourquoi aucun banc ne le voyait** : les trois niveaux partaient d'un v1 ou d'un v2, jamais d'un
v3 RÉEL. L'E2E traverse `v1 → v2 → v3 → v4` en une session, si bien que son palier v3 y est
intermédiaire et n'a jamais de voisin. Le seul chemin qu'un utilisateur emprunte était le seul qui
ne fût pas couvert — et c'est la leçon, plus que le correctif : une chaîne éprouvée de bout en bout
ne prouve rien de chacun de ses paliers pris comme point de DÉPART.

La migration OUVRE désormais sa source chiffrée par le VRAI magasin de générations
(`migration-source-chiffree.mjs`), sous un scellement de la version source — en v3, la DEK importée
directement en clé AES-GCM, le régime que la v4 remplace, et l'unique appelant qui en reste dans le
produit.

### Le HIGH qui allait avec : la migration ne vérifiait AUCUN engagement

Seule la migration peut ouvrir un v3, et elle ne consultait jamais le voisin `.engagement` qu'une
restauration dépose : elle DATAIT d'une racine neuve un volume sans racine — l'état exact que
`VAULT_STORAGE_VOLUME_SANS_RACINE` refuse. La moitié « restauration » du CRITICAL de #181 redevenait
donc franchissable, par le seul chemin que le produit v4 laisse à une archive v3.

Ouvrir la source par le magasin referme les deux d'un seul geste, et c'était la bonne raison de ne
pas écrire un lecteur de journal de plus : les trois cas de #181 — racine, engagement vérifié sous
la clé avant tout clair, refus — s'appliquent à la SOURCE comme à toute autre ouverture. Le motif
admis y est `engagement`, jamais `migration` : la conversion ne TIENT pas le fichier qu'elle
consomme, elle le TROUVE.

### Les compteurs sous-comptaient sur DEUX chemins, dont le chemin ordinaire

- **le témoin de fraîcheur n'était publié nulle part.** Il est scellé sous la clé du volume APRÈS la
  racine — un ordre que l'ADR 0019 impose —, si bien que le témoin de la dernière racine d'une
  session n'entrait dans aucun compteur, et n'était jamais rattrapé. L'écart croissait d'exactement
  UN par ouverture, sans borne, **sur le chemin transactionnel nominal**. La racine le RÉSERVE
  désormais : réserver plutôt que publier après coup fait qu'une coupure entre la racine et le
  témoin SUR-compte d'une unité, jamais l'inverse ;
- **l'installation initiale perdait tout le versement** : 18 scellements publiés pour 38 réels, soit
  la moitié du budget de la clé à l'installation d'un disque de 512 Mio. Le versement rend
  maintenant son COMPTE comme il rend déjà son empreinte.

**Ce qui ne pouvait pas les voir : des inégalités.** `>=` et `>` ne peuvent voir ni un décompte faux
d'une unité, ni vingt sur trente-huit. Les deux sont passées à l'ÉGALITÉ MESURÉE — une sonde qui
compte les invocations réelles de `crypto.subtle.encrypt` sous la clé d'un domaine, la clé étant
reconnue par l'info que l'encodeur DU PRODUIT construit —, et deux épreuves de non-dérive sur N
ouvertures successives ont été ajoutées. C'est la méthode du relecteur, adoptée telle quelle.

### Trois gardes disaient plus que ce qu'elles faisaient

- **le cliquet anti-DEK ne balayait qu'un NOM** et son titre annonçait une universelle : un module
  qui importait la DEK en AES-GCM en toutes lettres passait la CI sans un mot. Il balaie désormais
  deux GESTES, sur `src/` ET `public/`, et les deux mutants du relecteur le font rougir ;
- **`deriverCleDeDomaine` ne recoupait pas le `domaine` avec l'`info`**, alors que son en-tête écrit
  « le régime est une propriété du DOMAINE, et il est vérifié ici ». La conséquence qui compte est
  la symétrique de celle qu'on voit d'abord : `domaine: "volume"` admet un sel VIDE, donc un
  appelant pouvait dériver la clé d'un domaine à USAGE UNIQUE **sans sel** — une clé constante pour
  tous les artefacts d'un volume, exactement le régime que la décision 4 de l'ADR 0033 refuse ;
- **`VAULT_STORAGE_LECTURE_SEULE` rendait DEUX causes**, dont une qui n'est pas un régime de session
  et dont le remède est de MIGRER. `VAULT_STORAGE_DOMAINE_ABSENT_DU_FORMAT` la nomme.

### Deux refus tombaient du mauvais côté

- **un octet retourné dans un champ de 64 bits de la racine rendait « le support OPFS a refusé
  l'opération »** : l'exploitant lisait une panne de disque là où la spécification veut « restaurez
  une sauvegarde », et un adversaire y gagnait un oracle sur le champ qu'il avait touché. Le défaut
  était ANCIEN — `sequence` et `scellementsCumulesVolume` s'y comportaient déjà ainsi — et cette
  tranche lui ajoutait deux octets. Le décodeur refuse maintenant un champ hors bornes comme une
  racine ABÎMÉE, sur TOUS les champs : le refermer pour deux octets aurait laissé les cinq autres ;
- **une migration reprise sur un journal FORGÉ se terminait VERTE sur un volume inouvrable.** Le §
  9.2 promet une destruction, jamais une lecture, et la promesse tient ; ce qui manquait est qu'elle
  soit DITE. Une sonde d'un secteur sous la clé d'arrivée, avant le dernier geste, transforme la
  destruction muette en refus typé — pour une ouverture GCM par conversion, soit une sur 2^20 pour
  512 Mio, et le compte est éprouvé plutôt qu'affirmé.

### La campagne de mutation, et sa table

La campagne de #182 n'avait aucune trace durable : ni table ici, ni ligne dans `docs/testing.md`,
alors que le dépôt publie celles de #169 et #170 avec leur compte. Le « 20/20 » du corps de la PR
serait parti avec la PR. Elle est inscrite ci-dessous, et elle compte désormais **28 mutants sur
onze modules** — les huit neufs viennent des constats de ces revues.

| Module                                | Ce que les mutants retirent                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `derivation/cle-de-domaine.mjs`       | les préfixes de longueur, chacun des quatre champs de l'info, le recoupement du domaine, le régime de sel, l'import en matériau HKDF |
| `derivation/hierarchie-de-volume.mjs` | la séparation des domaines `volume` et `journal`, le sel d'une capture                                                               |
| `format-chiffre/identite-logique.mjs` | le onzième champ des données associées, la borne du budget                                                                           |
| `format-chiffre/modele-reference.mjs` | la version de format dans les données associées d'une racine                                                                         |
| `generation-format.mjs`               | la cohérence du format de racine, la place du second compteur, **les bornes des champs**                                             |
| `migration-v4.mjs`                    | l'écriture anticipée, le fail-closed d'un secteur déchiré, le recoupement de l'identifiant, **la sonde avant l'en-tête**             |
| `migration-source-chiffree.mjs`       | **la borne du lecteur v1, l'ouverture de la source, le motif de son autorisation**                                                   |
| `volume-migration.mjs`                | le discriminant `dejaFranchi`                                                                                                        |
| `opfs-racine-initiale.mjs`            | le report des compteurs d'une racine écartée                                                                                         |
| `opfs-datation-de-creation.mjs`       | **le report du compte que le versement rend**                                                                                        |
| `scellement.mjs`                      | les deux budgets, le refus de sceller, **la réservation du témoin**                                                                  |

## Modèle de menace : ce qui change, au vocabulaire de la décision 7 de l'ADR 0021

**GARANTI, et qui ne l'était pas avant cette tranche :**

- **deux domaines, deux volumes ou deux versions de format ne partagent JAMAIS une clé AEAD.**
  Mesuré par exécution sur les quatre domaines dérivés, et rejoué sans le produit par
  `tools/verifier-vecteurs.mjs` ;
- **la DEK ne peut pas chiffrer.** Elle est importée en matériau HKDF, et `crypto.subtle.encrypt` la
  rejette par la spécification WebCrypto ;
- **le budget d'une clé à compteur est celui de CETTE clé**, et plus une somme de compteurs locaux ;
- **une session qui ne peut pas publier ses compteurs ne scelle pas** — partout où le mécanisme est
  employé, c'est-à-dire nulle part dans le produit à ce jour : voir ci-dessus.

**FAIT, mais non garanti :**

- **les deux compteurs sont exacts tant que le support n'a pas reculé.** Ils vivent dans la racine
  et reculent avec elle (§ 9.1, #144). C'est inchangé ;
- **une migration reprise après coupure peut avoir rescellé une suite deux fois.** L'écart vaut au
  plus 512 secteurs par coupure, et il a donc une BORNE — ce que l'aveu du § 4.5 n'avait pas ;
- **le volume de COQUILLE scelle encore sans être compté.** Un secteur par déverrouillage, et la
  session suivante repart du compteur de la racine. C'est le dernier morceau de l'aveu du § 4.5, et
  il est MESURÉ (« CHEMIN 3 ») plutôt qu'annoncé fermé.

**PAS ENCORE, et c'est T2b :**

- **le geste qui écrit une racine de CLÔTURE sur un volume déjà daté**, sans lequel le volume de
  coquille ne peut tenir aucune des deux conduites de la décision 4 ;
- **la page d'enveloppe et la section de récupération sont encore scellées sous la DEK.** La phrase
  « la DEK n'est plus jamais passée à AES-GCM » est donc VRAIE des domaines du volume et FAUSSE du
  reste. Elle est écrite ainsi partout, et le cliquet qui la rendra exacte est celui de T2b.

**IMPOSSIBLE, inchangé** : détecter le retour arrière COMPLET du support ; effacer la clé maîtresse
de la mémoire du processus.

## Conséquences

- Le format que ce runtime ÉCRIT est : volume **v4**, journal **format 5**, manifeste **format 4**,
  instantané **format 2**, archive **v3** (#181), page d'enveloppe **v2** (T2b, ADR 0036).
- Un volume v3 n'est plus lu que par la migration. Toute autre ouverture le refuse en le NOMMANT :
  le remède est de migrer, jamais de restaurer.
- Les ADR 0015, 0016, 0019, 0021, 0024 et 0033 reçoivent leur note datée du 11 septembre 2026.
- La ligne #182 du [registre](../revue-externe/registre.md) est passée à `corrigé` par T2b.

## Note datée du 11 septembre 2026 — le TROISIÈME chemin hors transaction est fermé

Cet ADR laissait ouvert, et MESURÉ, le chemin du volume de coquille : ouvert hors transaction, il
scellait un secteur à chaque déverrouillage sans clore par une racine. La tranche T2b
([ADR 0036](0036-page-d-enveloppe-v2-et-budgets-exhaustifs.md), décision 3) le ferme par un geste
public, `cloturerParRacine`, qui n'ouvre aucun second chemin de scellement.

**« CHEMIN 3 » de `tests/unit/vm-cloture-par-racine.test.mjs` mesure désormais une ÉGALITÉ** là où
il mesurait un écart : ce que la racine de clôture publie est exactement le nombre d'invocations
réelles de `encrypt` sous la clé du domaine `volume` depuis la réouverture.

**La ligne des conséquences est corrigée** : le format que ce runtime ÉCRIT porte désormais une page
d'enveloppe **v2**, et non plus v1.
