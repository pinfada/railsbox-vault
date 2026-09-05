# Registre des constats de la revue externe

Ce registre porte **chaque** constat reçu sur le format de volume v3, sa sévérité, sa disposition et
le commit ou l'ADR qui la porte. Il est la sortie de la moitié 2 de
[#20](https://github.com/pinfada/railsbox-vault/issues/20), et son état conditionne le gate «
données sensibles » de `docs/readiness-assessment.md` : celui-ci ne bouge que si le registre est
vide de CRITICAL et de HIGH **ouverts**.

**Ce qu'il porte, et ce qu'il ne dit pas.** La moitié 2 — la sollicitation d'un tiers — n'a pas eu
lieu. Les lignes ci-dessous viennent de la **pré-revue adverse interne** de la moitié 1, traitée
comme une revue externe : chaque constat porte son issue `revue-externe`, et le registre dit ce que
le dépôt en a fait. Un registre pré-rempli d'exemples ferait croire à une revue qui n'existe pas ;
`tests/unit/dossier-de-revue.test.mjs` › « chaque ligne du registre cite une issue `revue-externe`
qui existe » exige donc que chaque ligne renvoie à une issue réelle et porte une disposition du
vocabulaire fermé, et rougira sur une ligne inventée.

Le dossier soumis à la revue est décrit par
[`docs/format-de-volume-v3.md`](../format-de-volume-v3.md) ; le format de réponse attendu est
[`gabarit-de-constat.md`](gabarit-de-constat.md).

## Constats

| Constat                                                                                                                                             | Sévérité | Disposition | Commit ou ADR                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------ |
| [#143](https://github.com/pinfada/railsbox-vault/issues/143) — l'identité logique ne sépare pas un enregistrement de journal d'un secteur de volume | HIGH     | corrigé     | `7f106fb` ; ADR 0016 et ADR 0019 amendés le 5 septembre 2026 |

## Comment une ligne se remplit

- **Constat** — le titre du constat, et le numéro de l'issue `revue-externe` qui le porte.
- **Sévérité** — CRITICAL, HIGH, MEDIUM ou LOW, telle que le gabarit la définit. Si le dépôt révise
  la sévérité proposée par le relecteur, les deux figurent, et la raison est dans l'issue.
- **Disposition** — `corrigé`, `accepté` ou `réfuté`. `accepté` exige un amendement daté de l'ADR
  concerné ; `réfuté` exige une reproduction qui échoue, publiée dans l'issue. Rien n'est « fermé
  sans suite ».
- **Commit ou ADR** — l'empreinte du commit qui corrige, ou l'ADR et la date de l'amendement qui
  accepte. Une disposition sans preuve opposable n'est pas une disposition.

## Ce que ce registre n'établit pas

Il ne dit pas que le format a été **audité**, ni qu'il est **sûr**. Il dit ce qui a été signalé et
ce que le dépôt en a fait. Toute mention d'un audit devra nommer qui, quand, et sur quelle version —
l'empreinte du commit revu —, faute de quoi elle ne serait pas vérifiable.
