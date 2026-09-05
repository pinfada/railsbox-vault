# Registre des constats de la revue externe

Ce registre porte **chaque** constat reçu sur le format de volume v3, sa sévérité, sa disposition et
le commit ou l'ADR qui la porte. Il est la sortie de la moitié 2 de
[#20](https://github.com/pinfada/railsbox-vault/issues/20), et son état conditionne le gate «
données sensibles » de `docs/readiness-assessment.md` : celui-ci ne bouge que si le registre est
vide de CRITICAL et de HIGH **ouverts**.

**Ce qu'il porte, et ce qu'il ne dit pas.** La moitié 2 — la sollicitation d'un tiers — n'a pas eu
lieu. Les lignes ci-dessous viennent de la **pré-revue adverse interne** de la moitié 1, traitée
comme une revue externe : chaque constat porte son issue `revue-externe`, et le registre dit ce que
le dépôt en a fait.

**Ce que la garde vérifie, mot pour mot, et rien de plus.** Un registre pré-rempli d'exemples ferait
croire à une revue qui n'existe pas, et une garde qui promettrait plus qu'elle ne tient serait pire
qu'une garde absente. `tests/unit/dossier-de-revue.test.mjs` › « le registre porte ses quatre
colonnes, et chaque ligne est OPPOSABLE » exige de CHAQUE ligne, **hors ligne** :

- qu'elle cite une **issue de ce dépôt**, dont le numéro est repris par le § 9.6 de
  [`docs/format-de-volume-v3.md`](../format-de-volume-v3.md) ou par
  [`SECURITY.md`](../../SECURITY.md). Ce recoupement est **interne** : il établit que le registre et
  le dossier parlent des mêmes numéros, **pas** qu'un tiers a envoyé le constat ;
- une **sévérité** et une **disposition** du vocabulaire fermé décrit plus bas ;
- une **preuve opposable** : une disposition « corrigé » cite la **PR** qui corrige, dont le numéro
  est repris par le dossier ; chaque ADR cité est un fichier de `docs/decisions/` ; et une empreinte
  de commit, si elle est citée, doit exister (`git cat-file -e`) — elle s'ajoute à la PR, elle ne la
  remplace jamais. C'est le seul de ces contrôles que rien de rédactionnel ne peut satisfaire.

La garde est éprouvée **dans les deux sens** : « la garde du registre MORD : une ligne inventée est
refusée sur chacun de ses défauts » rejoue la ligne exacte qu'une revue a fait passer au vert
lorsque la garde ne contrôlait que la forme d'une URL. Ce qu'elle ne peut PAS établir est écrit plus
bas, sous « Ce que ce registre n'établit pas ».

Le dossier soumis à la revue est décrit par
[`docs/format-de-volume-v3.md`](../format-de-volume-v3.md) ; le format de réponse attendu est
[`gabarit-de-constat.md`](gabarit-de-constat.md).

## Constats

| Constat                                                                                                                                             | Sévérité | Disposition | Preuve                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| [#143](https://github.com/pinfada/railsbox-vault/issues/143) — l'identité logique ne sépare pas un enregistrement de journal d'un secteur de volume | HIGH     | corrigé     | [PR #146](https://github.com/pinfada/railsbox-vault/pull/146) ; ADR 0016 et ADR 0019 amendés le 5 septembre 2026 |

## Comment une ligne se remplit

- **Constat** — le titre du constat, et le numéro de l'issue `revue-externe` qui le porte.
- **Sévérité** — CRITICAL, HIGH, MEDIUM ou LOW, telle que le gabarit la définit. Si le dépôt révise
  la sévérité proposée par le relecteur, les deux figurent, et la raison est dans l'issue.
- **Disposition** — `corrigé`, `accepté` ou `réfuté`. `accepté` exige un amendement daté de l'ADR
  concerné ; `réfuté` exige une reproduction qui échoue, publiée dans l'issue. Rien n'est « fermé
  sans suite ».
- **Preuve** — la **PR** qui corrige, ou l'ADR et la date de l'amendement qui accepte. Une
  disposition sans preuve opposable n'est pas une disposition, et une disposition `corrigé` exige
  une PR. Une empreinte de commit peut s'ajouter, jamais remplacer : ce dépôt fusionne par « rebase
  and merge », et GitHub RÉÉCRIT alors les empreintes en les portant sur `main`, si bien qu'une
  preuve adossée à une empreinte se périme à la fusion — c'est arrivé une fois ici, à un simple
  rebasage. Un numéro de PR, lui, ne bouge pas. Si une empreinte est citée, elle doit exister.

## Ce que ce registre n'établit pas

Il ne dit pas que le format a été **audité**, ni qu'il est **sûr**. Il dit ce qui a été signalé et
ce que le dépôt en a fait.

Il n'établit pas non plus qu'un **tiers** a envoyé les constats qu'il porte : la garde recoupe le
registre avec le dossier du même dépôt, et une issue de ce dépôt peut être ouverte par ce dépôt.
C'est exactement le cas des lignes présentes, qui viennent d'une pré-revue **interne** traitée comme
externe, et le registre le dit plus haut plutôt que de le laisser deviner. Une empreinte citée,
elle, est vérifiable sans nous : `git cat-file -e` la trouve ou ne la trouve pas. Toute mention d'un
audit devra nommer qui, quand, et sur quelle version — l'empreinte du commit revu —, faute de quoi
elle ne serait pas vérifiable.
