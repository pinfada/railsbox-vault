# Registre des constats de la revue externe

Ce registre porte **chaque** constat reçu sur le format de volume v3, sa sévérité, sa disposition et
le commit ou l'ADR qui la porte. Il est la sortie de la moitié 2 de
[#20](https://github.com/pinfada/railsbox-vault/issues/20), et son état conditionne le gate «
données sensibles » de `docs/readiness-assessment.md` : celui-ci ne bouge que si le registre est
vide de CRITICAL et de HIGH **ouverts**.

**Il est VIDE, et cela veut dire quelque chose de précis : la moitié 2 n'a pas eu lieu.** Aucun
tiers n'a été sollicité, aucun constat n'a été reçu, aucun n'a été écarté. Un registre pré-rempli
d'exemples ferait croire à une revue qui n'existe pas ; `tests/unit/dossier-de-revue.test.mjs` › «
le registre porte ses quatre colonnes, et il est VIDE tant qu'aucun constat n'est reçu » exige donc
qu'il ne porte que sa ligne d'en-tête, et rougira à la première ligne ajoutée sans que l'épreuve
soit mise à jour avec elle.

Le dossier soumis à la revue est décrit par
[`docs/format-de-volume-v3.md`](../format-de-volume-v3.md) ; le format de réponse attendu est
[`gabarit-de-constat.md`](gabarit-de-constat.md).

## Constats

| Constat | Sévérité | Disposition | Commit ou ADR |
| ------- | -------- | ----------- | ------------- |

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
