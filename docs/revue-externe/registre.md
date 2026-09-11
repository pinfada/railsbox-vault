# Registre des constats de la revue externe

Ce registre porte **chaque** constat reçu sur le format de volume v3, sa sévérité, sa disposition et
le commit ou l'ADR qui la porte. Il est la sortie de la moitié 2 de
[#20](https://github.com/pinfada/railsbox-vault/issues/20), et son état conditionne le gate «
données sensibles » de `docs/readiness-assessment.md` : celui-ci ne bouge que si le registre est
vide de CRITICAL et de HIGH **ouverts**.

**Ce qu'il porte, et ce qu'il ne dit pas.** Les quatre premières lignes viennent de la **pré-revue
adverse interne** de la moitié 1, traitée comme une revue externe. Les deux dernières viennent de la
**revue de la moitié 2, reçue le 10 septembre 2026** — le CRITICAL y est corrigé le jour même, le
HIGH reste dû — son texte intégral est versé au dépôt en
[`revue-2026-09-10.md`](revue-2026-09-10.md). Chaque constat porte son issue `revue-externe`, et le
registre dit ce que le dépôt en a fait.

## Qui a relu, quand, et sur quelle version

**Moitié 2, le 10 septembre 2026.** Revue adverse assistée par un **agent d'IA distinct des agents
du dépôt**, ni tiers humain ni cabinet indépendant ; identité tenue hors dépôt par le mainteneur, à
sa demande. Branche `main`, empreinte relue `aa6be826ad0e14162a9e06e5`.

**Le CRITICAL est corrigé le 10 septembre 2026**, par la
[PR #184](https://github.com/pinfada/railsbox-vault/pull/184) : l'archive passe en version 3 et
porte un engagement scellé sous une clé du domaine `archive` ; aucun volume légitime n'est sans
racine. La correction n'ouvre AUCUN gate : le HIGH
[#182](https://github.com/pinfada/railsbox-vault/issues/182) était alors ouvert — il est corrigé le
11 septembre 2026 —, et le gate « données sensibles » reste FERMÉ pour les autres raisons que
`SECURITY.md` énumère.

**Le HIGH est corrigé le 11 septembre 2026**, en DEUX tranches.

**T2a** a livré le format de volume v4 : la DEK devient une clé maîtresse que WebCrypto refuse de
passer à AES-GCM, et les domaines `volume`, `journal` et `instantane` scellent chacun sous la
sienne.

**T2b** livre les trois points qui restaient, et la ligne passe à « corrigé » :

- **les DEUX derniers domaines.** La page d'enveloppe passe en **version 2** : sa racine est scellée
  sous une clé à usage unique du domaine `enveloppe`, avec un sel de trente-deux octets tiré et
  écrit en clair ; la page qu'une archive emporte suit le même régime sous le domaine
  `recuperation`. Une page v1 est rescellée à la première ouverture réussie, sans qu'aucune coupure
  ne rende le volume inouvrable — quatre sinistres, quatre rangs, quatre clés de déverrouillage,
  toutes ouvrantes à chaque rang ;
- **le CLIQUET définitif.** Il lit les APPELS et nomme la matière de chaque import de clé brute.
  Trois endroits touchent encore une clé de volume, et aucun n'est un chemin de production du format
  v4 : le modèle de référence, le régime v3 (migration et export d'un v3), et la LECTURE d'une page
  v1 — qui importe la clé sans l'usage `encrypt`, donc ne PEUT pas sceller. Il MORD : douze mutants,
  douze tués ;
- **le TROISIÈME chemin hors transaction.** Le volume de coquille clôt désormais par une racine, par
  un geste public qui n'ouvre aucun second chemin de scellement. « CHEMIN 3 » mesure une ÉGALITÉ là
  où il mesurait un écart.

**Et le budget est MESURÉ, domaine par domaine, sur une session complète.** C'était la promesse que
le relecteur avait réfutée ; `tests/unit/vm-budget-par-domaine.test.mjs` étiquette chaque
`CryptoKey` par sa provenance et compte les invocations de `encrypt` par clé : **zéro sous la clé de
volume**, jamais deux sous une clé à usage unique, une clé par volume pour les deux domaines à
compteur.

**Un écart reste, et il est écrit partout de la même phrase** : ouvrir un volume **v3** — pour le
migrer, ou pour l'EXPORTER avant de le migrer — fait écrire au magasin une racine v3 et rescelle la
charge acquittée, c'est-à-dire deux scellements sous la clé de volume elle-même. C'est le régime que
la v4 remplace, c'est l'unique exception du cliquet, et ne pas ouvrir perdrait une écriture
acquittée. Voir la décision 4 de l'ADR 0036 et le § 7.4 de la spécification.

Cette ligne est écrite telle quelle plutôt que sous une formule d'audit, et il faut en tirer la
conséquence sans l'adoucir : **savoir si une revue adverse assistée par un agent d'IA satisfait la
condition « tiers » des gates de [`SECURITY.md`](../../SECURITY.md) est une décision du mainteneur,
et elle n'est pas prise.** Le gate « données sensibles » reste FERMÉ dans tous les cas, puisque la
revue laisse un HIGH ouvert.

**Une ligne `ouvert` est une dette nommée, pas une disposition.** Le vocabulaire d'origine —
`corrigé`, `accepté`, `réfuté` — n'avait pas de place pour un constat REÇU et NON traité, et les
trois auraient menti : « corrigé » et « réfuté » sont faux, « accepté » dirait que le dépôt garde le
défaut, ce qui est l'inverse du contrat de #20. Le mot a donc été ajouté au vocabulaire **et à la
garde** le 10 septembre 2026. La preuve opposable d'une ligne `ouvert` est **l'issue elle-même** :
elle porte le constat, sa reproduction et sa Definition of Ready. Une ligne `ouvert` ne se ferme que
par une PR ou un ADR, jamais par le temps.

**Ce que la garde vérifie, mot pour mot, et rien de plus.** Un registre pré-rempli d'exemples ferait
croire à une revue qui n'existe pas, et une garde qui promettrait plus qu'elle ne tient serait pire
qu'une garde absente. `tests/unit/dossier-de-revue.test.mjs` › « le registre porte ses quatre
colonnes, et chaque ligne est OPPOSABLE » exige de CHAQUE ligne, **hors ligne** :

- qu'elle cite une **issue de ce dépôt**, dont le numéro est repris par le § 9.6 de
  [`docs/format-de-volume-v3.md`](../format-de-volume-v3.md) ou par
  [`SECURITY.md`](../../SECURITY.md). Ce recoupement est **interne** : il établit que le registre et
  le dossier parlent des mêmes numéros, **pas** qu'un tiers a envoyé le constat ;
- une **sévérité** et une **disposition** du vocabulaire fermé décrit plus bas — `ouvert` compris
  depuis le 10 septembre 2026, dont la preuve exigée est l'issue et **ni un ADR ni une PR**. Une
  sévérité **révisée** s'écrit `PROPOSÉE → RETENUE`, et les deux termes appartiennent au même
  vocabulaire : la garde admet cette forme et **elle seule**, si bien qu'une révision ne peut pas
  glisser un mot hors vocabulaire d'un côté de la flèche ;
- une **preuve opposable** : une disposition « corrigé » cite la **PR** qui corrige, dont le numéro
  est repris par le dossier ; une disposition « accepté » cite l'**ADR** amendé ; chaque ADR cité
  est un fichier de `docs/decisions/` ; et une empreinte de commit, si elle est citée, doit exister
  (`git cat-file -e`) — elle s'ajoute, elle ne remplace jamais. C'est le seul de ces contrôles que
  rien de rédactionnel ne peut satisfaire.

La garde est éprouvée **dans les deux sens** : « la garde du registre MORD : une ligne inventée est
refusée sur chacun de ses défauts » rejoue la ligne exacte qu'une revue a fait passer au vert
lorsque la garde ne contrôlait que la forme d'une URL. Ce qu'elle ne peut PAS établir est écrit plus
bas, sous « Ce que ce registre n'établit pas ».

Le dossier soumis à la revue est décrit par
[`docs/format-de-volume-v3.md`](../format-de-volume-v3.md) ; le format de réponse attendu est
[`gabarit-de-constat.md`](gabarit-de-constat.md).

## Constats

| Constat                                                                                                                                                                                      | Sévérité      | Disposition | Preuve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#142](https://github.com/pinfada/railsbox-vault/issues/142) — un témoin authentique rejoué rend un volume sain irouvrable, et rejoué contre une racine abîmée fait reculer d'une génération | HIGH → MEDIUM | accepté     | ADR 0019 amendé le 5 septembre 2026 ; [PR #153](https://github.com/pinfada/railsbox-vault/pull/153)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [#143](https://github.com/pinfada/railsbox-vault/issues/143) — l'identité logique ne sépare pas un enregistrement de journal d'un secteur de volume                                          | HIGH          | corrigé     | [PR #146](https://github.com/pinfada/railsbox-vault/pull/146) ; ADR 0016 et ADR 0019 amendés le 5 septembre 2026                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [#144](https://github.com/pinfada/railsbox-vault/issues/144) — le recul d'une génération ne demande aucune copie antérieure, et une racine abîmée à côté d'une racine lisible est ignorée    | HIGH          | corrigé     | [PR #153](https://github.com/pinfada/railsbox-vault/pull/153) ; ADR 0019 amendé le 5 septembre 2026                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [#145](https://github.com/pinfada/railsbox-vault/issues/145) — « supprimer et recréer » ne retire aucun voisin, et le volume recréé est refusé                                               | MEDIUM        | corrigé     | [PR #157](https://github.com/pinfada/railsbox-vault/pull/157)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [#181](https://github.com/pinfada/railsbox-vault/issues/181) — une archive accepte un mélange de secteurs provenant de plusieurs états, et la première ouverture restaurée le rend en clair  | CRITICAL      | corrigé     | [PR #184](https://github.com/pinfada/railsbox-vault/pull/184) ; ADR 0034, et ADR 0008, 0009, 0011, 0014, 0015, 0019, 0027 amendés le 10 septembre 2026                                                                                                                                                                                                                                                                                                                                                                                  |
| [#182](https://github.com/pinfada/railsbox-vault/issues/182) — le budget AES-GCM n'est pas global à la clé : même DEK pour deux volumes, l'enveloppe et les exports, compteurs par instance  | HIGH          | corrigé     | [PR #186](https://github.com/pinfada/railsbox-vault/pull/186) (tranche **T2a** : format v4, domaines `volume`, `journal`, `instantane` ; ADR 0035) et [PR #187](https://github.com/pinfada/railsbox-vault/pull/187) (tranche **T2b** : page d'enveloppe v2, domaines `enveloppe` et `recuperation`, clôture du troisième chemin hors transaction, cliquet définitif, budget mesuré par clé ; ADR 0036, ADR 0020/0027/0033/0035 amendés). Reste ÉCRIT : ouvrir un v3 scelle deux fois sous la clé de volume — § 7.4, ADR 0036 décision 4 |

## Comment une ligne se remplit

- **Constat** — le titre du constat, et le numéro de l'issue `revue-externe` qui le porte.
- **Sévérité** — CRITICAL, HIGH, MEDIUM ou LOW, telle que le gabarit la définit. Si le dépôt révise
  la sévérité proposée par le relecteur, les deux figurent, et la raison est dans l'issue.
- **Disposition** — `corrigé`, `accepté`, `réfuté` ou `ouvert`. `accepté` exige un amendement daté
  de l'ADR concerné ; `réfuté` exige une reproduction qui échoue, publiée dans l'issue ; `ouvert`
  exige l'issue qui porte le constat, sa reproduction et sa Definition of Ready. Rien n'est « fermé
  sans suite ».
- **Preuve** — la **PR** qui corrige, l'ADR et la date de l'amendement qui accepte, ou **l'issue**
  d'une dette ouverte. Une disposition sans preuve opposable n'est pas une disposition, et une
  disposition `corrigé` exige une PR. Une empreinte de commit peut s'ajouter, jamais remplacer : ce
  dépôt fusionne par « rebase and merge », et GitHub RÉÉCRIT alors les empreintes en les portant sur
  `main`, si bien qu'une preuve adossée à une empreinte se périme à la fusion — c'est arrivé une
  fois ici, à un simple rebasage. Un numéro de PR, lui, ne bouge pas. Si une empreinte est citée,
  elle doit exister.

## Ce que ce registre n'établit pas

Il ne dit pas que le format a été **audité**, ni qu'il est **sûr**. Il dit ce qui a été signalé et
ce que le dépôt en a fait.

Il n'établit pas non plus qu'un **tiers** a envoyé les constats qu'il porte : la garde recoupe le
registre avec le dossier du même dépôt, et une issue de ce dépôt peut être ouverte par ce dépôt.
C'est le cas des quatre premières lignes, qui viennent d'une pré-revue **interne** traitée comme
externe ; c'est aussi le cas des deux dernières, versées au dépôt par le mainteneur à partir d'un
texte reçu hors dépôt, et dont la nature du relecteur est écrite plus haut sans être établie par la
garde. Le registre le dit plutôt que de le laisser deviner. Une empreinte citée, elle, est
vérifiable sans nous : `git cat-file -e` la trouve ou ne la trouve pas. Toute mention d'un audit
devra nommer qui, quand, et sur quelle version — l'empreinte du commit revu —, faute de quoi elle ne
serait pas vérifiable.
